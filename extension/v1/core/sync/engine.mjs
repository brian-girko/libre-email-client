'use strict';

// engine.mjs — SyncEngine: the single owner of IMAP connections.
//
// The service worker keeps one IMAP session per account (the wasm MailApi)
// and keeps the local OPFS maildir (core/sync/store.mjs) in sync with the
// remote server. The client UI never opens its own session — it reads the
// maildir files and applies its own changes as FILE OPERATIONS:
//
// flag truth lives in the longname (maildir info part), a local delete is a
// rename with the T flag, a local move is a cross-folder rename keeping the
// foreign FMD5. The engine journals the lastseen remote state in its
// PRIVATE IndexedDB (core/sync/state.mjs — the client has no access) and
// diff-drives every server effect from {filename flags, lastseen, listing}:
//
//   sync        folder-by-folder pull (LIST diff, thread summaries, new
//               messages, body prefetch) + three-way flag merge below.
//               Once per badge alarm tick, on client open, after outbox
//               replays and after every queued operation…
//   local ops   flags / trash / moves are pure local file edits by the client;
//               THIS pass reads the disk and pushes the diffs to the server:
//               · item flags != lastseen  → STORE ±flags
//               · item flags T, row gone → STORE \Deleted + EXPUNGE, then the
//                 file finally deletes once the listing confirms
//               · foreign FMD5          → UID MOVE src→dst (source folder is
//                 the one whose lastseen journal still knows the uid)
//                        both sides changed → local wins
//   queued op   flags and folder-tree ops: outbox entry + immediate replay
//               (server-first, resync after).
//   direct op   mirrorApi() writes: execute on the server immediately and
//               bring the affected folders into the mirror through the
//               following resync.
//
// Body prefetch never re-fetches a message whose longname already exists in
// the folder's cur/ (checked per uid before every fetch).
//
// Updates flow back out as a broadcast ('mirror-changed') whenever index
// data moves, plus an activity stream (source 'sync') for the logger.

import {createMailApi, decodeMimeWords} from '../rust-imap-client/api.mjs';
import {request as bridgeRequest, release as bridgeRelease} from '../ws-to-tls/manager.js';
import {resolvePassword, needsMasterPassword} from '../creds.mjs';
import {
  openMirror,
  dropMirror,
  emptyIndex,
  threadSummaries,
  encodeDirName,
  decodeDirName,
  upsertMessage,
} from './store.mjs';
import {searchMirror} from './search.mjs';
import {
  getSyncState,
  putSyncState,
  updateSyncState,
  clearSyncState,
  clearAccount as clearSyncAccountState,
  findSourceFolder,
} from './state.mjs';
import {folderDigest} from './maildir-name.mjs';

const fieldKey = (name, id) => name + '.' + id;
const msg = e => e?.message || String(e);

// Error signature of a dead transport — rebuild the session instead of
// retrying in place (mirrors the old client-page wrapper's match).
const CONN_ERROR = /peer closed|close_notify|unexpected[ _-]?eof|transport[ _-]?clos|transport[ _-]?error|not connected|connection lost|ws connect failed|ws error|bridge:|io: /i;

// Error signature of an operation that can never succeed against the current
// server state (folder gone, message gone): drop the outbox entry instead of
// retrying forever and let a folder resync bring the UI to server truth.
const PERMANENT_ERROR = /no such mailbox|mailbox.{0,20}not.{0,20}(found|exist)|nonexistent|does ?not exist|invalid (uid|messages)|uid.{0,10}invalid|(out of range)|empty mailbox list/i;

const MAX_ATTEMPTS = 5;

// Error signature of a message whose listing entry has no server body left —
// expunge-pending mail from another client (or a MOVE/COPY fallback residue):
// the mirror keeps the row but fetches keep failing with "no body returned".
const NO_BODY_ERROR = /no body returned/i;

// ---- account config -------------------------------------------------------

// IMAP connection data from chrome.storage.local; null when the account is
// gone or incomplete.
async function loadImapCfg(accountId) {
  const res = await chrome.storage.local.get([
    fieldKey('imap.host', accountId),
    fieldKey('imap.port', accountId),
    fieldKey('imap.secure', accountId),
    fieldKey('imap.allowSelfSigned', accountId),
    fieldKey('user.name', accountId),
  ]);
  const host = res[fieldKey('imap.host', accountId)];
  const port = Number(res[fieldKey('imap.port', accountId)]);
  const user = res[fieldKey('user.name', accountId)];
  if (!host || !port || !user) {
    return null;
  }
  return {
    host,
    port,
    secure: res[fieldKey('imap.secure', accountId)] !== false,
    allowSelfSigned: !!res[fieldKey('imap.allowSelfSigned', accountId)],
    user,
  };
}

async function loadDebugConfig() {
  const {'mail.debug': debug} = await chrome.storage.local.get({'mail.debug': false});
  return !!debug;
}

// ---- per-account session ---------------------------------------------------

// The engine speaks raw wasm op names; the facade (createMailApi) exposes
// the same commands under its own contract names. MAP accordingly — the
// facade methods carry the correct FIFO/decode/retry semantics.
const FACADE_ALIAS = {
  list_mailboxes: 'listDirs',
  fetch_threads: 'listThreads',
  fetch_message: 'readFile',
  store_flags: 'setFlags',
  move_messages: 'moveTo',
  create_mailbox: 'createDir',
  delete_mailbox: 'deleteDir',
  expunge_messages: 'deleteMessages',
};

class Session {
  constructor(accountId, cfg, pass, debug) {
    this.accountId = accountId;
    this.cfg = cfg;
    this.pass = pass;
    this.debug = debug;
    this.api = null;
    this.bridge = null; // held refcount unit (one per account session)
    this.selected = null; // mailbox the wasm core currently has selected
    // the wasm MailClient is single-owned: run every call through this FIFO
    this.tail = Promise.resolve();
  }

  async ensure() {
    if (this.api) {
      return this.api;
    }
    const pass = this.pass ?? await resolvePassword(this.accountId);
    if (!pass) {
      const needs = await needsMasterPassword(this.accountId);
      const err = new Error(needs
        ? 'needs master password'
        : 'no password available — sign in once from the client');
      err.code = 'credential';
      throw err;
    }
    this.pass = pass;
    if (!this.bridge) {
      const url = await bridgeRequest();
      if (!url) {
        const err = new Error('IMAP bridge unavailable');
        err.code = 'bridge';
        throw err;
      }
      this.bridge = url;
    }
    const api = await createMailApi({
      bridgeUrl: this.bridge,
      wasmUrl: chrome.runtime.getURL('core/rust-imap-client/mail_core_bg.wasm'),
      ...this.cfg,
      pass,
      accountId: this.accountId,
      debug: this.debug,
    });
    try {
      await api.connect();
    }
    catch (e) {
      this.releaseBridge();
      try {
        await api.close();
      }
      catch {}
      throw e;
    }
    this.api = api;
    this.selected = null;
    return api;
  }

  releaseBridge() {
    if (this.bridge) {
      const was = this.bridge;
      this.bridge = null;
      bridgeRelease().catch(() => {});
    }
  }

  call(name, args = []) {
    const run = this.tail.then(async () => {
      try {
        const api = await this.ensure();
        const fn = FACADE_ALIAS[name] ?? name;
        if (typeof api[fn] !== 'function') {
          throw new Error('mail core build lacks ' + fn);
        }
        return await api[fn](...args);
      }
      catch (e) {
        if (CONN_ERROR.test(msg(e))) {
          this.drop();
        }
        throw e;
      }
    });
    this.tail = run.then(() => {}, () => {});
    return run;
  }

  // SELECT the mailbox that subsequent FETCH/STORE commands operate on; a
  // stable session skips the repeated SELECT.
  async useDir(name) {
    if (this.selected !== name) {
      await this.call('openDir', [name]);
      this.selected = name;
    }
  }

  drop() {
    if (this.api) {
      const api = this.api;
      this.api = null;
      try {
        api.close().catch(() => {});
      }
      catch {}
    }
    this.releaseBridge();
    this.selected = null;
  }
}

const sessions = new Map(); // accountId -> Session

async function sessionFor(accountId) {
  const cfg = await loadImapCfg(accountId);
  if (!cfg) {
    const err = new Error('account not configured');
    err.code = 'config';
    throw err;
  }
  const pass = await resolvePassword(accountId); // null until the user signs in
  let session = sessions.get(accountId);
  if (!session) {
    session = new Session(accountId, cfg, pass, await loadDebugConfig());
    sessions.set(accountId, session);
  }
  else {
    session.cfg = cfg;
    session.pass = pass;
  }
  return session;
}

function dropSession(accountId) {
  const session = sessions.get(accountId);
  if (session) {
    session.drop();
    sessions.delete(accountId);
  }
}

// ---- cross-module hooks ------------------------------------------------------

// setSyncDone(fn): called after every completed server→mirror sync, whatever
// its trigger (badge alarm, client open, user request, filter pass, outbox
// replay, post-op dir resync). badge.mjs registers the periodic alarm here so
// the next periodic tick falls `interval` minutes after the LAST sync —
// manual or periodic alike. Registered by the badge module; the hook lives in
// the engine because the engine alone knows when a sync really landed, and
// the worker cannot hear its own runtime messages.
// setFilterPrePass(fn): filters.mjs registers runFilters here. It runs before
// any sync copies server mail into the mirror, so the local copy only ever
// receives post-filter placement.
let syncDone = null;
let filterPrePass = null;

export function setSyncDone(fn) {
  syncDone = typeof fn === 'function' ? fn : null;
}

export function setFilterPrePass(fn) {
  filterPrePass = typeof fn === 'function' ? fn : null;
}

function fireSyncDone() {
  if (typeof syncDone === 'function') {
    try {
      syncDone();
    }
    catch {
      /* a listener must never break the sync path */
    }
  }
}

// ---- broadcasts ---------------------------------------------------------------

function broadcastMirrorChanged(accountId, dirNames = []) {
  try {
    chrome.runtime.sendMessage({
      type: 'mirror-changed',
      accountId,
      dirs: dirNames,
      syncedAt: engine.lastSynced.get(accountId) ?? null,
    }).catch(() => {});
  }
  catch {
    /* no listener */
  }
}

function emitActivity(entry) {
  try {
    chrome.runtime.sendMessage({type: 'activity', source: 'sync', ...entry}).catch(() => {});
  }
  catch {
    /* no listener */
  }
}

// ---- body prefetch policy -------------------------------------------------------

// 'mail.syncPrefetch': 'all' (default, every body) or a positive integer =
// newest N bodies per folder. A per-folder override (picked in the big-folder
// prompt, stored in the mirror meta) wins over the global option.
// Returns the ordered uid list whose bodies should exist after a folder sync
// (already-local bodies are skipped by the caller).
const BODY_SPECS = ['all', 200, 50, 20];

async function loadGlobalSpec() {
  try {
    const {'mail.syncPrefetch': spec} = await chrome.storage.local.get({'mail.syncPrefetch': 'all'});
    return spec === 'all' || BODY_SPECS.includes(Number(spec)) ? spec : 'all';
  }
  catch {
    return 'all';
  }
}

async function wantedBodyUids(messages, spec) {
  let limit = Infinity;
  if (spec !== 'all') {
    const n = Number(spec);
    if (Number.isFinite(n) && n > 0) {
      limit = n;
    }
  }
  const uids = [...new Set(messages.map(m => Number(m.uid)))].sort((a, b) => b - a);
  return uids.slice(0, limit);
}

// ---- folder sync --------------------------------------------------------------
//
// One folder = {local longname items from disk} + {lastseen journal in the
// engine's private state store} + {remote listing}. The merge diffs those
// three inputs — no tombstone/staged bookkeeping exists anymore: a foreign
// FMD5 IS the staged (locally moved) item, the T info flag IS the delete.

// Replay local flag/trash edits for one folder onto the server: the client
// renamed the files; each filename-vs-lastseen divergence becomes a server
// op. Returns 'down' when the transport died (pending edits keep waiting),
// otherwise 'ok'.
async function replayFolderFlags(session, mirror, accountId, dirName, st) {
  for (const item of await mirror.listItems(dirName)) {
    const journal = st.lastseen[item.uid];
    if (!journal) {
      continue; // never journaled (freshly downloaded): nothing to replay
    }
    const now = new Set(item.info ?? []);
    const was = new Set(journal.flags ?? []);
    const delta = now.has('\\Deleted') && !was.has('\\Deleted')
      ? 'trash'
      : (now.size === was.size && [...now].every(f => was.has(f)))
        ? null
        : {add: [...now].filter(f => !was.has(f)), remove: [...was].filter(f => !now.has(f))};
    if (!delta) {
      continue;
    }
    try {
      await execOp(session, delta === 'trash'
        ? {kind: 'delete', dir: dirName, uids: [item.uid]}
        : {kind: 'flags', dir: dirName, uids: [item.uid], add: delta.add, remove: delta.remove});
      if (delta === 'trash') {
        // purge replayed: journal the row metadata for a definitive-rejection
        // restore; the listing pass below decides the final delete
        const index = await mirror.getIndex(dirName);
        journal.row = (index?.messages ?? []).find(m => Number(m.uid) === item.uid) ?? null;
        journal.deleted = true;
      }
      else {
        journal.flags = [...now];
        journal.deleted = false;
      }
    }
    catch (e) {
      const text = msg(e);
      if (CONN_ERROR.test(text)) {
        return 'down'; // transport down: nothing further can replay this pass
      }
      if (PERMANENT_ERROR.test(text)) {
        // definitive rejection: the local edit reverts — server truth wins
        if (delta === 'trash') {
          await mirror.renameItem(dirName, item.uid, {info: journal.row?.flags ?? journal.flags ?? []});
          if (journal.row) {
            const row = {...journal.row};
            await mirror.updateIndex(dirName, index => {
              upsertMessage(index, row);
              index.threads = (index.threads ?? []).concat([[Number(row.uid)]]);
              return index;
            });
          }
          emitActivity({accountId, phase: 'error', folder: dirName, error: 'purge rejected — restored locally: ' + text});
        }
        else {
          emitActivity({accountId, phase: 'error', folder: dirName, error: 'flags rejected: ' + text});
          journal.flags = [...now];
        }
        continue;
      }
      // transient: logged; the local edit stands and retries at the next pass
      emitActivity({accountId, phase: 'error', folder: dirName, error: (delta === 'trash' ? 'purge' : 'flags') + ' pending: ' + text});
    }
  }
  return 'ok';
}

// encoded names of every selectable folder (move-in source lookups, counts)
async function selectableEncs(mirror) {
  const meta = await mirror.getMeta();
  return (Array.isArray(meta.dirs) ? meta.dirs : [])
    .filter(d => selectableFilters(d.attrs))
    .map(d => encodeDirName(d.name));
}

// Replay a foreign-FMD5 item: the client moved the file into this folder and
// the server has not caught up yet. The engine's journals still know which
// folder owned the uid — execute that move for real. Returns true when the
// move replayed; on failure the file keeps standing where it is.
async function replayFolderMoveIn(session, mirror, accountId, dirName, enc, item) {
  const encs = (await selectableEncs(mirror)).filter(e => e !== enc);
  const srcEnc = await findSourceFolder(accountId, item.uid, encs);
  if (!srcEnc) {
    // foreign digest but no journal knows the uid (stale/foreign origin):
    // leave it; the index pull below keeps it visible and a later migration/
    // cleanup pass can pair it once its source listing is known
    return false;
  }
  const srcName = decodeDirName(srcEnc);
  try {
    await execOp(session, {kind: 'move', dir: srcName, uids: [item.uid], target: dirName});
    // source journal records the leaving uid
    await updateSyncState(accountId, srcEnc, s => {
      if (s.lastseen[item.uid]) {
        s.lastseen[item.uid].movedOut = enc;
      }
      return s;
    });
    await pairMovedInUid(session, mirror, accountId, dirName, enc, item);
    emitActivity({accountId, phase: 'move', dir: dirName, from: srcName, moved: [item.uid]});
    return true;
  }
  catch (e) {
    const text = msg(e);
    if (!CONN_ERROR.test(text) && !PERMANENT_ERROR.test(text)) {
      // transient: logged; the local move stands and retries next pass
      emitActivity({accountId, phase: 'error', folder: dirName, error: 'move pending: ' + text});
    }
    if (!CONN_ERROR.test(text) && PERMANENT_ERROR.test(text)) {
      // definitive rejection: undo the local move — the item returns home
      try {
        await mirror.moveLocal(dirName, srcName, [item.uid]);
      }
      catch {}
      emitActivity({accountId, phase: 'error', folder: dirName, error: 'move rejected — restored locally: ' + text});
    }
    return false;
  }
}

// Pair a confirmed move with its server identity: servers with UID MOVE keep
// the uid, the fallback COPY+EXPUNGE issues a new one. Any uid in the fresh
// target listing that no journal row knows yet IS the moved-in mail — rename
// the local longname to that uid + own FMD5 so the item is never orphaned
// (an OfflineIMAP-style UID pairing). Best effort: on any failure the next
// pass retries through the foreign-FMD5 item path.
async function pairMovedInUid(session, mirror, accountId, dirName, enc, item) {
  try {
    await session.useDir(dirName);
    const rows = await session.call('fetch_threads', []);
    const uids = [];
    for (const row of Array.isArray(rows) ? rows : []) {
      for (const raw of Array.isArray(row.messages) ? row.messages : []) {
        uids.push(Number(raw.uid));
      }
    }
    const st = await getSyncState(accountId, enc);
    const unknown = uids.filter(uid => !(uid in st.lastseen));
    if (unknown.length !== 1) {
      return; // ambiguous (raced another client) — the listing pass resolves
    }
    const [newUid] = unknown;
    if (newUid === item.uid) {
      return; // uid-preserved move: normalization happens in the pull below
    }
    const ownDigest = await folderDigest(enc);
    await mirror.renameItem(dirName, item.uid, {uid: newUid, md5: ownDigest});
  }
  catch {
    /* retry through the foreign-FMD5 path on the next pass */
  }
}

// uids migrating out of a folder locally: foreign-FMD5 items in every other
// folder whose source journal still knows the uid. The SOURCE folder's pull
// must keep those rows hidden (they are locally moved) until the server move
// lands — without this the source pull resurrects them into the index on
// every pass before the target folder replays the move.
async function computePendingMoveOuts(mirror, accountId) {
  const encs = await selectableEncs(mirror);
  const out = new Map(); // srcEnc -> Set(uid)
  const digests = new Map();
  for (const enc of encs) {
    digests.set(enc, await folderDigest(enc));
  }
  for (const enc of encs) {
    for (const item of await mirror.listItems(decodeDirName(enc))) {
      if (!item.md5 || item.md5 === digests.get(enc)) {
        continue; // normal local item, not a foreign guest
      }
      const srcEnc = await findSourceFolder(accountId, item.uid, [...encs].filter(e => e !== enc));
      if (!srcEnc) {
        continue;
      }
      let set = out.get(srcEnc);
      if (!set) {
        set = new Set();
        out.set(srcEnc, set);
      }
      set.add(item.uid);
    }
  }
  return out;
}

// Flag/trash/move-in edits the disk shows that have not replayed yet. Pure
// local scan (one OPFS read + one state read) — used to skip the whole
// server round-trip of a light pass.
async function hasPendingLocalEdits(mirror, accountId, dirName, enc, fenceMatches) {
  if (!fenceMatches) {
    return true; // unforced full pass: the pull decides everything anyway
  }
  const [items, st] = await Promise.all([
    mirror.listItems(dirName),
    getSyncState(accountId, enc),
  ]);
  if (st.uidvalidity && st.uidvalidity !== Number(fenceMatches.uidvalidity)) {
    return true; // stale uid fence — a uidvalidity rebuild is owed
  }
  const ownDigest = await folderDigest(enc);
  return items.some(item => {
    if (item.md5 !== ownDigest) {
      return true; // foreign FMD5: pending local move
    }
    const journal = st.lastseen[item.uid];
    if (!journal) {
      return false; // never journaled: nothing local to replay yet
    }
    const now = new Set(item.info ?? []);
    const was = new Set(journal.flags ?? []);
    if (now.has('\\Deleted') && !was.has('\\Deleted')) {
      return true; // local trash pending
    }
    if (now.size !== was.size || [...now].some(f => !was.has(f))) {
      return true; // flag edits pending
    }
    return false;
  });
}

// Pull one folder from the server into the mirror.
//   mode 'light': SELECT and trust the uidnext/exists fence — one round trip
//     when nothing moved (the common case for the periodic alarm).
//   mode 'full': always re-read the folder's thread summaries and diff them
//     into the index (first sync, account open, user refresh, op replay).
// Returns {changed}.
async function syncFolder(session, mirror, accountId, dirName, {mode = 'light'} = {}) {
  if (typeof dirName !== 'string' || !dirName) {
    throw new Error('syncFolder: dirName must be a folder name string');
  }
  // uids currently migrating out of OTHER folders with local copies sitting in
  // THIS folder as foreign-FMD5 items — the source pull must keep hiding them
  // until their server move lands (the old tombstone circle's job)
  const pendingMoveOuts = await computePendingMoveOuts(mirror, accountId);
  const status = await session.call('openDir', [dirName]);
  const fence = {
    uidvalidity: Number(status?.uidvalidity) || 0,
    uidnext: Number(status?.uidnext) || 0,
    exists: Number(status?.exists) || 0,
  };
  session.selected = dirName;

  const enc = encodeDirName(dirName);
  const prevIndex = (await mirror.getIndex(dirName)) ?? emptyIndex(dirName);
  let st = await getSyncState(accountId, enc);

  const hits =
    prevIndex &&
    Number(prevIndex.uidvalidity || 0) === fence.uidvalidity &&
    Number(prevIndex.uidnext) === fence.uidnext &&
    Number(prevIndex.exists) === fence.exists;

  if (mode === 'light' && hits &&
      !(await hasPendingLocalEdits(mirror, accountId, dirName, enc, fence))) {
    // nothing to pull and no pending local edit: one SELECT round trip only.
    // The folder's "last synced" clock updates; pending local edits (if any
    // rose between the local scan and this SELECT, say a racing client
    // rename) replay through the next full pass — the fences have not moved
    // yet because the server truth of a local edit always shows up in a
    // listing first.
    await mirror.updateSummary(dirName, s => ({...s, lastSync: Date.now()}));
    return {changed: false, fence};
  }

  // uidvalidity reset — the folder was rebuilt server-side: uids and flag
  // state carry nothing across that line. Local items and the journal reset;
  // the pull below refills everything. Only ONCE per reset pass thanks to
  // the st write below — idempotent on rerun (everything already zeroed).
  if (st.uidvalidity && st.uidvalidity !== fence.uidvalidity) {
    for (const item of await mirror.listItems(dirName)) {
      await mirror.delBody(dirName, item.uid);
    }
    await putSyncState(accountId, enc, {uidvalidity: fence.uidvalidity, lastseen: {}});
    st = await getSyncState(accountId, enc);
  }

  // ---- phase A: local flag/trash diffs (the client's file edits) replay
  if (await replayFolderFlags(session, mirror, accountId, dirName, st) === 'down') {
    return {changed: false, fence};
  }

  // ---- phase B: foreign-FMD5 items — local moves whose server effect pends
  const ownDigest = await folderDigest(enc);
  for (const item of await mirror.listItems(dirName)) {
    if (item.md5 !== ownDigest) {
      await replayFolderMoveIn(session, mirror, accountId, dirName, enc, item);
    }
  }

  // ---- phase C: server truth — pull rows and reconcile the disk
  const rawRows = await session.call('fetch_threads', [dirName]);
  const remoteByUid = new Map();
  const rawThreadGroups = [];
  for (const row of Array.isArray(rawRows) ? rawRows : []) {
    const uids = [];
    for (const raw of Array.isArray(row.messages) ? row.messages : []) {
      const uid = Number(raw.uid);
      if (!remoteByUid.has(uid)) {
        remoteByUid.set(uid, {
          uid,
          flags: Array.isArray(raw.flags) ? raw.flags.map(String) : [],
          subject: decodeMimeWords(raw.subject ?? null),
          from: decodeMimeWords(raw.from ?? null),
          date: raw.date ?? null,
          size: raw.size ?? null,
        });
      }
      uids.push(uid);
    }
    if (uids.length) {
      rawThreadGroups.push(uids);
    }
  }

  // disk reconcile — an OWN item the listing no longer carries has been
  // purged (or moved away) server-side: the file deletes for real and its
  // journal row goes with it. A T-flagged item's expunge (phase A) lands
  // HERE. A foreign item of the same name is the client's pending local
  // move — untouched until its own listing lands.
  for (const item of await mirror.listItems(dirName)) {
    if (item.md5 !== ownDigest) {
      continue;
    }
    if (!remoteByUid.has(item.uid)) {
      await mirror.delBody(dirName, item.uid);
      const journal = st.lastseen[item.uid];
      if (journal?.movedOut) {
        delete st.lastseen[item.uid]; // move-out confirmed — journal clears
      }
    }
  }

  // longname reconcile — a foreign item whose uid IS in this folder's
  // listing was confirmed server-side (the move landed, uid kept): rename
  // to own digest + server flags, so the next pass treats it as normal
  const items = await mirror.listItems(dirName);
  for (const item of items) {
    const rem = remoteByUid.get(item.uid);
    if (item.md5 !== ownDigest && rem) {
      await mirror.renameItem(dirName, item.uid, {info: rem.flags, md5: ownDigest});
    }
  }

  // a fresh disk snapshot (the renames above replaced items in the cache)
  const ownFlags = new Map((await mirror.listItems(dirName)).map(it => [it.uid, it.info ?? []]));

  // index rows — the pull's listing truth; unseen-thread tracking masks
  // expunge-pending rows (either side's \\Deleted) exactly as before.
  const prevRows = new Map((Array.isArray(prevIndex?.messages) ? prevIndex.messages : [])
    .map(m => [Number(m.uid), m]));
  // Uids a local move took OUT of this folder (pending-move-outs) stay
  // hidden: the remote listing has not dropped them yet, but the mail is
  // already gone from this folder on disk and shows in its new home.
  const hideOut = pendingMoveOuts.get(enc) ?? new Set();
  const liveRows = [...remoteByUid.values()]
    .filter(rem => !rem.flags.includes('\\Deleted') && !hideOut.has(rem.uid))
    .map(rem => ({
      uid: rem.uid,
      flags: rem.flags,
      subject: rem.subject,
      from: rem.from,
      date: rem.date,
      size: rem.size ?? prevRows.get(rem.uid)?.size ?? null,
    }));
  // foreign items pending their server side (moved in, not yet listed) keep
  // their metadata rows visible — the local move stays in every view
  const movedInRows = [];
  for (const item of items) {
    if (item.md5 !== ownDigest && !remoteByUid.has(item.uid) &&
        !(item.info ?? []).includes('\\Deleted')) {
      const prev = prevRows.get(item.uid);
      if (prev) {
        movedInRows.push({...prev, uid: item.uid});
      }
    }
  }

  const index = {
    ...emptyIndex(dirName),
    uidvalidity: fence.uidvalidity,
    uidnext: fence.uidnext,
    exists: fence.exists,
    lastSync: Date.now(),
    messages: [...liveRows, ...movedInRows].sort((a, b) => Number(a.uid) - Number(b.uid)),
    threads: [...rawThreadGroups
      .map(uids => uids.filter(uid =>
        remoteByUid.has(uid) && !remoteByUid.get(uid).flags.includes('\\Deleted') &&
        !ownFlags.get(uid)?.includes('\\Deleted') && !hideOut.has(uid)))
      .filter(uids => uids.length),
    // moved-in rows are not in the listing yet — they keep their own group
    // thread until the server merge lands them under this folder's listing
      ...movedInRows.map(row => [Number(row.uid)])],
  };

  // journal: every listed uid's server flag state becomes the next merge's
  // baseline — the next pass knows exactly WHICH side moved a flag
  const lastseen = {};
  for (const [uid, rem] of remoteByUid) {
    const journal = st.lastseen[uid];
    lastseen[uid] = {
      uid,
      flags: [...rem.flags],
      deleted: !!(journal?.deleted && rem.flags.includes('\\Deleted')),
      movedOut: journal?.movedOut === enc ? journal.movedOut : (journal?.movedOut ?? false),
      row: journal?.row ?? null,
    };
  }
  await putSyncState(accountId, enc, {uidvalidity: fence.uidvalidity, lastseen});

  const changed = !hits || JSON.stringify(index.messages) !==
    JSON.stringify(prevIndex?.messages?.slice?.() ?? []);

  await mirror.putIndex(dirName, index);

  // file sweep: bodies whose uid reached neither the listing nor the view —
  // trash markers (":2,T") survive: the expunge pass retires them together
  // with the journal rows
  const wanted = new Set(index.messages.map(m => m.uid));
  for (const [uid, info] of ownFlags) {
    if (!wanted.has(uid) && !info.includes('\\Deleted')) {
      await mirror.delBody(dirName, uid);
    }
  }

  return {changed, fence};
}

// Body prefetch for one folder: fetch the .eml files the policy wants that
// are not stored yet (each already-on-disk body is skipped — the longname
// lookup answers per uid, so flag state and presence both ride the filename).
async function prefetchBodies(session, mirror, dirName, messages, spec = 'all', progress = null) {
  const plan = await wantedBodyUids(messages, spec);
  const missing = [];
  for (const uid of plan) {
    if (!(await mirror.getBody(dirName, uid))) {
      missing.push(uid);
    }
  }
  if (!missing.length) {
    return 0;
  }
  const rowFlags = new Map((Array.isArray(messages) ? messages : []).map(m => [Number(m.uid), m.flags ?? []]));
  await session.useDir(dirName);
  let done = 0;
  for (const uid of missing) {
    try {
      const raw = await session.call('fetch_message', [Number(uid)]);
      const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
      await mirror.putBody(dirName, uid, bytes, {flags: rowFlags.get(Number(uid)) ?? []});
    }
    catch (e) {
      const text = msg(e);
      if (NO_BODY_ERROR.test(text)) {
        // the listing still shows the uid, but the server no longer yields
        // its body (expunge pending): drop the row so the folder stops
        // re-fetching it each pass, and to stop any view from showing it
        try {
          await mirror.dropUids(dirName, [uid]);
        }
        catch {}
        emitActivity({accountId: session.accountId, phase: 'error', folder: dirName, error: 'body ' + uid + ': ' + text + ' — row dropped'});
      }
      else {
        // one unreadable email never stops the rest of the prefetched set
        emitActivity({accountId: session.accountId, phase: 'error', error: 'body ' + uid + ': ' + text});
      }
    }
    done++;
    if (typeof progress === 'function' && (done % 20 === 0 || done === missing.length)) {
      progress(missing.length, done);
    }
  }
  return missing.length;
}

// ---- account-wide sync ---------------------------------------------------

const selectableFilters = attrs => !(Array.isArray(attrs) ? attrs : [])
  .some(a => /\\noselect|\\nonexistent/i.test(String(a)));

// Sync reasons surface the "why" of a pass in the client's logger:
//   user_request — refresh button, toolbar/context "Check now"
//   client_open  — the client page (re)opened and wants fresh data
//   periodic     — the badge alarm / idle wake tick
//   filters      — a filter pass pulled INBOX to act on the server first
//   replay       — outbox operations were replayed to the server
//   unlock       — the master password landed, parked syncs resume
const SYNC_REASONS = new Set(['user_request', 'client_open', 'periodic', 'filters', 'replay', 'unlock', 'config']);

// A folder larger than this asks the client once for a body limit
// (choices mirror the options page: all / 200 / 50 / 20).
const ASK_BODY_THRESHOLD = 200;

function reasonOf(value, fallback = 'user_request') {
  return SYNC_REASONS.has(value) ? value : fallback;
}

// Sync every selectable folder (or a single one when dirName is given).
// Single flight per account: concurrent callers (alarm + refresh) share one
// run. Returns the synced-at timestamp.
// A failed pass always closes its activity line (the client's "Syncing…"
// entry would otherwise hang forever) and, when the blocker is a locked
// master password, broadcasts 'sync-locked' — the open client page prompts
// for the master, which unblocks every following attempt through session
// storage (the worker cannot prompt for itself).
async function syncAccount(accountId, {dir = null, mode = 'full', reason = 'user_request', skipFilterPrePass = false} = {}) {
  const existing = engine.inFlight.get(accountId);
  if (existing) {
    return existing;
  }
  const why = reasonOf(reason);
  // Filters run ONCE per sync, before any folder is pulled into the mirror:
  // the pre-pass acts on the server, so the pass below copies post-filter
  // truth. The filter pass's own syncs (reason 'filters') and badge-driven
  // syncs (which already applied filters under the shared mutex,
  // skipFilterPrePass) are excluded. The pre-pass runs BEFORE the
  // single-flight claim below: the filter pass performs engine syncs of its
  // own, which would otherwise be served by this very in-flight promise and
  // deadlock on it.
  if (filterPrePass && !skipFilterPrePass && why !== 'filters') {
    try {
      await filterPrePass(accountId);
    }
    catch {
      // a failed pre-pass must not block the sync; the next trigger retries
    }
  }
  // the pre-pass may have let another trigger start a sync: re-check
  const raced = engine.inFlight.get(accountId);
  if (raced) {
    return raced;
  }
  const run = (async () => {
    emitActivity({accountId, phase: 'start', reason: why});
    try {
      return await syncAccountRun(accountId, {dir, mode, reason: why});
    }
    catch (e) {
      emitActivity({accountId, phase: 'end', folders: 0, error: msg(e), reason: why});
      if (e?.code === 'credential') {
        emitActivity({accountId, phase: 'locked', error: msg(e), reason: why});
        try {
          chrome.runtime.sendMessage({type: 'sync-locked', accountId, error: msg(e)}).catch(() => {});
        }
        catch {}
      }
      throw e;
    }
  })();
  engine.inFlight.set(accountId, run);
  try {
    return await run;
  }
  finally {
    engine.inFlight.delete(accountId);
  }
}

async function syncAccountRun(accountId, {dir, mode, reason}) {
  const session = await sessionFor(accountId);
  const mirror = await openMirror(accountId);
  const rows = await session.call('list_mailboxes');
  const dirs = (Array.isArray(rows) ? rows : []).map(d => ({
    name: String(d.name),
    delimiter: d.delimiter ?? null,
    attrs: Array.isArray(d.attrs) ? d.attrs.map(String) : [],
  }));
  await mirror.saveDirs(dirs);
  const summaries = await mirror.summarized();

  // prune local folders that no longer exist server-side (their journal rows
  // go with them — the private state store follows the mirror)
  const known = new Set(dirs.map(d => d.name));
  for (const name of summaries.keys()) {
    if (!known.has(name)) {
      await mirror.removeFolder(name);
      await clearSyncState(accountId, encodeDirName(name));
      broadcastMirrorChanged(accountId, [name]);
    }
  }

  // Target order: the folder the user has open first (the persisted client
  // selection, falling back to INBOX), then the smallest folders first —
  // never-synced folders lead the tail — so the useful parts of the mirror
  // fill quickly and huge mailboxes wait until last.
  let priority = null;
  if (dir == null) {
    try {
      priority = (await chrome.storage.local.get('dir.' + accountId))['dir.' + accountId] || null;
    }
    catch {}
    if (!priority || !dirs.some(d => d.name === priority)) {
      priority = 'INBOX';
    }
  }
  const targets = dirs.filter(d => selectableFilters(d.attrs) && (dir == null || d.name === dir));
  targets.sort((a, b) => {
    const rank = folder => (dir == null && folder.name === priority ? 0 : 1);
    const sizeOf = d => Number(summaries.get(d.name)?.total ?? -1); // never-synced first
    return (rank(a) - rank(b)) || (sizeOf(a) - sizeOf(b)); // stable sort keeps list order
  });
  const total = targets.length;
  let done = 0;
  const changedDirs = [];
  let bodies = 0;
  for (const d of targets) {
    done++;
    try {
      const res = await syncFolder(session, mirror, accountId, d.name, {mode});
      emitActivity({accountId, phase: 'folder', folder: d.name, done, total, reason});
      if (res.changed) {
        changedDirs.push(d.name);
        broadcastMirrorChanged(accountId, [d.name]);
      }
      const idx = await mirror.getIndex(d.name);
      const messages = idx?.messages ?? [];
      const serverCount = res.fence?.exists ?? messages.length;
      // body policy: per-folder override wins; a new big folder gets asked
      // for a cap once via the client (summaries still land immediately)
      let spec = await mirror.getPrefetch(d.name);
      if (spec == null) {
        if (mode === 'full' && serverCount > ASK_BODY_THRESHOLD) {
          emitActivity({accountId, phase: 'ask-prefetch', folder: d.name, total: serverCount, reason});
          try {
            chrome.runtime.sendMessage({type: 'sync-ask-prefetch', accountId, dir: d.name, total: serverCount}).catch(() => {});
          }
          catch {}
        }
        else {
          spec = await loadGlobalSpec();
        }
      }
      if (spec != null) {
        const before = bodies;
        bodies += await prefetchBodies(session, mirror, d.name, messages, spec);
        if (bodies > before) {
          broadcastMirrorChanged(accountId, [d.name]);
        }
      }
    }
    catch (e) {
      emitActivity({accountId, phase: 'error', folder: d.name, error: msg(e), reason});
      // keep syncing the remaining folders
    }
  }
  const lastSynced = await mirror.lastSynced();
  engine.lastSynced.set(accountId, lastSynced);
  try {
    const all = {...(await chrome.storage.local.get('mirror.lastSynced'))['mirror.lastSynced'] ?? {}};
    all[accountId] = lastSynced;
    await chrome.storage.local.set({'mirror.lastSynced': all});
  }
  catch {}
  emitActivity({accountId, phase: 'end', folders: changedDirs.length, syncedAt: lastSynced, reason});
  if (dir != null) {
    broadcastMirrorChanged(accountId, [dir]);
  }
  // server truth landed locally: the "last sync" clock of every consumer resets here
  fireSyncDone();
  return lastSynced;
}
// ---- outbox: queued ops + replay -----------------------------------------

// Only folder-tree ops (and the internal per-item replays below) ride the
// outbox now: server-first execution + immediate resync of the affected
// folders. Client flag/trash/move mutations are pure local file edits (see
// mutate()) whose server effects the sync pass diff-drives from the disk;
// the outbox simply has nothing to queue for them anymore.

// One server mutation, whatever its route (internal diff replay/legacy
// outbox replay/direct op): the session is re-SELECTed onto the op's mailbox
// first, since the last folder touched may not be this one.
async function execOp(session, op) {
  switch (op.kind) {
    case 'flags':
      await session.useDir(op.dir);
      await session.call('store_flags', [op.uids, op.add, op.remove]);
      return;

    case 'move':
      await session.useDir(op.dir);
      await session.call('move_messages', [op.uids, op.target]);
      // Servers without UID MOVE get a COPY + STORE \Deleted fallback from
      // the core — but that residue stays in the source listing until
      // something expunges it, so a later pass would pull the mail back
      // (and body/body-search fetches would fail with "no body returned").
      // An expunge right away is a no-op after a real UID MOVE.
      try {
        await session.call('expunge_messages', [op.uids]);
      }
      catch {}
      return;

    case 'delete': {
      await session.useDir(op.dir);
      // the facade's deleteMessages does STORE "\Deleted" + UID EXPUNGE (when
      // the core build exports expunge_messages; otherwise the flag stays and
      // the server purges on its next expunge) — the index hides \Deleted
      // rows in both cases and the disk file retires once the listing drops
      await session.call('deleteMessages', [op.uids]);
      return;
    }

    case 'dir-create':
      await session.call('create_mailbox', [op.name]);
      return;

    case 'dir-delete':
      await session.call('delete_mailbox', [op.name]);
      return;

    default:
      throw new Error('unknown outbox op: ' + op.kind);
  }
}

// The folders whose mirror index a completed op invalidated.
const opAffectDirs = op => {
  switch (op.kind) {
    case 'flags': return [op.dir];
    case 'move': return [op.dir, op.target];
    case 'delete': return [op.dir];
    default: return [];
  }
};

// ---- mirror re-sync after server operations --------------------------------

// Full re-pull of the folders the ops touched so the mirror ends up with
// post-operation server truth even when counts happen to coincide.
async function resyncDirs(session, mirror, accountId, dirs) {
  for (const dir of dirs) {
    try {
      const res = await syncFolder(session, mirror, accountId, dir, {mode: 'full'});
      if (res.changed) {
        broadcastMirrorChanged(accountId, [dir]);
        const idx = await mirror.getIndex(dir);
        const spec = (await mirror.getPrefetch(dir)) ?? await loadGlobalSpec();
        await prefetchBodies(session, mirror, dir, idx?.messages ?? [], spec);
      }
    }
    catch (e) {
      emitActivity({accountId, phase: 'error', folder: dir, error: msg(e)});
    }
  }
  const lastSynced = await mirror.lastSynced();
  if (lastSynced) {
    engine.lastSynced.set(accountId, lastSynced);
    fireSyncDone();
  }
}

// ---- outbox replay -------------------------------------------------------------

// Execute every queued outbox op against the server (FIFO), drop the ones
// that made it, then resync the affected folders. Connection errors abort
// mid-queue (remaining ops stay queued); after MAX_ATTEMPTS a permanently
// failing op is dropped and the folder resync flags the divergence.
async function replay(accountId, {reason = 'replay'} = {}) {
  const mirror = await openMirror(accountId);
  const ops = await mirror.listOps();
  if (!ops.length) {
    return 0;
  }
  const session = await sessionFor(accountId);
  let played = 0;
  const affected = new Set();
  for (const op of ops) {
    try {
      await execOp(session, op);
      played++;
      await mirror.removeOps([op.id]);
      for (const dir of opAffectDirs(op).filter(Boolean)) {
        affected.add(dir);
      }
    }
    catch (e) {
      const attempts = (Number(op.attempts) || 0) + 1;
      const text = msg(e);
      if (CONN_ERROR.test(text)) {
        break; // transport down: replay continues at the next trigger
      }
      await mirror.removeOps([op.id]);
      if (PERMANENT_ERROR.test(text) || attempts >= MAX_ATTEMPTS) {
        // server rejected it for good (or too many tries): drop the op; the
        // folder resync lets the mirror converge with server truth anyway
        for (const dir of opAffectDirs(op).filter(Boolean)) {
          affected.add(dir);
        }
        emitActivity({accountId, phase: 'error', folder: op.dir, error: 'dropped ' + op.kind + ': ' + text, reason});
        continue;
      }
      // transient: requeue with the attempt count carried over and stop —
      // a failing op blocks later ones in the strict FIFO order
      await mirror.pushOp({...op, attempts});
      break;
    }
  }
  if (affected.size) {
    await resyncDirs(session, mirror, accountId, [...affected]);
  }
  broadcastMirrorChanged(accountId, [...affected]);
  return played;
}

// ---- direct mutations (server first, mirror learns through the resync) -------

// Used by the worker-side mirrorApi write consumers: an op runs on the server
// immediately and the affected folders are re-pulled right after, so the
// caller's next read sees post-op truth. The mirror itself is never
// pre-mutated. On server failure nothing is resynced and the error
// propagates.
async function execDirect(accountId, op) {
  const session = await sessionFor(accountId);
  await execOp(session, op);
  const mirror = await openMirror(accountId);
  const dirs = opAffectDirs(op).filter(Boolean);
  if (dirs.length) {
    await resyncDirs(session, mirror, accountId, dirs);
    broadcastMirrorChanged(accountId, dirs);
  }
  else {
    // folder-tree ops (create/delete): one light pass re-lists the mailbox
    // tree, prunes gone folders and pulls the new folder's index
    await syncAccount(accountId, {mode: 'light', reason: 'replay', skipFilterPrePass: true});
  }
  return dirs;
}

// ---- mutations (UI actions) --------------------------------------------------------

// Delete and move are PURE LOCAL FILE EDITS by the client: a delete renames
// the .eml with the T (trash) info flag, a move renames the file into the
// target folder's cur/ keeping its foreign FMD5. The engine's sync pass then
// diff-drives the server effects from the disk (STORE+EXPUNGE / UID MOVE) —
// fully offline-capable, and this prompt (a light sync trigger) fires without
// holding the action hostage. Flags from the client page take the same route
// (a plain info rename) — mirror-mutate keeps the legacy outbox path for
// worker-side callers only. Reached via the 'mirror-mutate' message from the
// client page.
async function mutate(accountId, op) {
  if (op.kind === 'delete' || op.kind === 'move') {
    const mirror = await openMirror(accountId);
    if (op.kind === 'delete') {
      await mirror.removeLocal(op.dir, op.uids);
    }
    else if (!op.target || op.target === op.dir) {
      throw new Error('move: a distinct target folder is required');
    }
    else {
      const rows = await mirror.moveLocal(op.dir, op.target, op.uids);
      if (!rows.length) {
        throw new Error('move: messages are no longer in the local folder');
      }
    }
    broadcastMirrorChanged(accountId, [op.dir, ...(op.kind === 'move' ? [op.target] : [])].filter(Boolean));
    // do not block the user's action on the server: the disk state (T flag /
    // foreign FMD5) guarantees convergence; online this pass purges/moves at
    // once, offline it errors quietly and the pending state waits for the
    // next sync trigger
    engine.sync(accountId, {
      mode: 'light',
      reason: 'replay',
      skipFilterPrePass: true,
    }).catch(() => {});
    return null;
  }
  const mirror = await openMirror(accountId);
  await mirror.pushOp(op);
  await engine.sync(accountId, {
    mode: op.kind === 'flags' ? 'full' : 'light',
    reason: 'replay',
    skipFilterPrePass: true,
  });
  return engine.lastSynced.get(accountId) ?? null;
}

// ---- body fetch (LocalApi runtime round trip) --------------------------------------

// A body the user opened that was never mirrored under the current policy:
// pull exactly that one from the server, persist it (the longname carries the
// locally known flags), and hand the bytes back through the 'mirror-fetch'
// message response.
async function fetchBody(accountId, dirName, uid) {
  const session = await sessionFor(accountId);
  const mirror = await openMirror(accountId);
  await session.useDir(dirName);
  const raw = await session.call('fetch_message', [Number(uid)]);
  const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
  const index = await mirror.getIndex(dirName);
  const flags = ((index?.messages ?? []).find(m => Number(m.uid) === Number(uid))?.flags) ?? [];
  await mirror.putBody(dirName, Number(uid), bytes, {flags});
  return bytes;
}

// ---- delimiter guess for optimistic folder creations -------------------------------

function guessDelimiter(dirs, name) {
  for (const d of Array.isArray(dirs) ? dirs : []) {
    if (d?.delimiter && name.includes(d.delimiter)) {
      return d.delimiter;
    }
  }
  return null;
}

// ---- raw server handle (filter passes) ----------------------------------------

// A MailApi-shaped handle that talks ONLY to the server through the shared
// session — no mirror reads, no mirror writes, no mirror-changed broadcasts.
// The filter pass evaluates INBOX server-side, applies its moves/deletes
// directly, and the caller lets the engine sync afterwards so the local
// clone ingests the post-filter state.
export async function openServerApi(accountId) {
  const session = await sessionFor(accountId);
  let selected = null;

  return {
    async connect() {},
    async close() {
      selected = null;
    },
    selectedDir() {
      return selected;
    },

    async listDirs() {
      return session.call('listDirs');
    },

    async openDir(name) {
      const status = await session.call('openDir', [name]);
      selected = name;
      return status;
    },

    async listFiles({page = 0, pageSize = 20, fromUid, toUid} = {}) {
      if (!selected) throw new Error('openDir() first');
      return session.call('listFiles', [{page, pageSize, fromUid, toUid}]);
    },

    async readFile(uid) {
      if (!selected) throw new Error('openDir() first');
      return session.call('readFile', [Number(uid)]);
    },

    async moveTo(uids, mailbox) {
      if (!selected) throw new Error('openDir() first');
      await session.call('moveTo', [(Array.isArray(uids) ? uids : []).map(Number), mailbox]);
    },

    async deleteMessages(uids) {
      if (!selected) throw new Error('openDir() first');
      await session.call('deleteMessages', [(Array.isArray(uids) ? uids : []).map(Number)]);
    },

    async createDir(name) {
      if (typeof name !== 'string' || !name.trim()) throw new Error('createDir: folder name required');
      await session.call('createDir', [name.trim()]);
    },
  };
}

// ---- worker-side MailApi over the mirror (badge counting) --------------

// A MailApi-contract facade for background consumers. Reads come straight
// from the mirror; writes execute on the server immediately and update the
// mirror. The badge count pre-pass uses this and never touches a session or
// the bridge itself.
export async function mirrorApi(accountId) {
  const mirror = await openMirror(accountId);
  let selected = null;

  return {
    async connect() {},
    async close() {
      selected = null;
    },
    selectedDir() {
      return selected;
    },

    async listDirs() {
      const meta = await mirror.getMeta();
      return (Array.isArray(meta.dirs) ? meta.dirs : []).filter(d => selectableFilters(d.attrs));
    },

    async openDir(name) {
      const index = await mirror.getIndex(name);
      if (!index) {
        const err = new Error('no such mailbox: ' + name);
        err.code = 'mirror';
        throw err;
      }
      selected = name;
      return {
        exists: Number(index.exists) || index.messages.length,
        uidvalidity: Number(index.uidvalidity) || 0,
        uidnext: Number(index.uidnext) || 0,
        unseen: index.messages.filter(m => !m.flags.includes('\\Seen')).length,
      };
    },

    async listFiles({page = 0, pageSize = 20, fromUid, toUid} = {}) {
      if (!selected) throw new Error('openDir() first');
      const index = await mirror.getIndex(selected);
      const all = (index?.messages ?? []).sort((a, b) => b.uid - a.uid);
      if (fromUid != null) {
        const lo = Number(fromUid);
        const hi = toUid != null ? Number(toUid) : lo;
        return all.filter(m => m.uid >= lo && m.uid <= hi);
      }
      const start = page * pageSize;
      return all.slice(start, start + pageSize);
    },

    async listThreads() {
      if (!selected) throw new Error('openDir() first');
      return threadSummaries(await mirror.getIndex(selected));
    },

    async readFile(uid) {
      if (!selected) throw new Error('openDir() first');
      const body = await mirror.getBody(selected, uid);
      if (body) {
        return body;
      }
      return fetchBody(accountId, selected, uid);
    },

    async search({dir, query, allFolders = false} = {}) {
      if (!query || !String(query).trim()) {
        return [];
      }
      return searchMirror(mirror, {dir: dir ?? selected, query, allFolders});
    },

    async setFlags(uids, addFlags, removeFlags) {
      const op = {
        kind: 'flags',
        dir: selected,
        uids: (Array.isArray(uids) ? uids : []).map(Number),
        add: (Array.isArray(addFlags) ? addFlags : []).map(String),
        remove: (Array.isArray(removeFlags) ? removeFlags : []).map(String),
      };
      if (!op.uids.length || (!op.add.length && !op.remove.length)) {
        return;
      }
      return execDirect(accountId, op);
    },

    async moveTo(uids, mailbox) {
      const op = {
        kind: 'move',
        dir: selected,
        uids: (Array.isArray(uids) ? uids : []).map(Number),
        target: mailbox,
      };
      if (!op.uids.length || !op.target) {
        return;
      }
      return execDirect(accountId, op);
    },

    async deleteMessages(uids) {
      const op = {
        kind: 'delete',
        dir: selected,
        uids: (Array.isArray(uids) ? uids : []).map(Number),
      };
      if (!op.uids.length) {
        return;
      }
      return execDirect(accountId, op);
    },

    async createDir(name) {
      if (typeof name !== 'string' || !name.trim()) throw new Error('createDir: folder name required');
      const {dirs} = await mirror.getMeta();
      await execDirect(accountId, {
        kind: 'dir-create',
        name: name.trim(),
        delimiter: guessDelimiter(dirs, name.trim()),
      });
    },

    async deleteDir(name) {
      if (typeof name !== 'string' || !name) throw new Error('deleteDir: folder name required');
      return execDirect(accountId, {kind: 'dir-delete', name});
    },

    async listDirCounts(onProgress) {
      const summaries = await mirror.summarized();
      const out = [];
      for (const [name, s] of summaries) {
        const entry = {name, unread: Number(s.unread) || 0, total: Number(s.total) || 0};
        out.push(entry);
        if (typeof onProgress === 'function') {
          try {
            onProgress(entry);
          }
          catch {}
        }
      }
      return out;
    },
  };
}

// ---- engine facade -----------------------------------------------------------------

const engine = {
  // accountId -> most recent full-sync timestamp (0 when never synced)
  lastSynced: new Map(),
  inFlight: new Map(), // accountId -> running syncAccount promise

  // Sync one account (or a single folder). Queued outbox ops are attempted
  // first: their server-side effects must exist before the folder reads, or
  // the resync would resurrect already-handled rows.
  // `reason` names why — surfaced in the client logger (user_request,
  // client_open, periodic, filters, replay, unlock, config).
  async sync(accountId, {dir = null, mode = 'light', reason = 'user_request', skipFilterPrePass = false} = {}) {
    try {
      const mirror = await openMirror(accountId);
      if ((await mirror.listOps()).length) {
        try {
          await replay(accountId, {reason: 'replay'});
        }
        catch {
          // not playable right now (offline/credentials): the sync itself
          // may still run and resyncing a folder whose ops failed is still
          // the right move — server truth wins
        }
      }
    }
    catch {
      /* mirror open failure surfaces below with the sync's own error */
    }
    return syncAccount(accountId, {dir, mode, reason, skipFilterPrePass});
  },

  async syncDir(accountId, dirName) {
    return syncAccount(accountId, {dir: dirName, mode: 'full', reason: 'user_request'});
  },

  // Late body work for the folder whose big-folder prompt was answered:
  // pull the .eml set the now-chosen cap wants (single session, reuse FIFO).
  async fetchBodies(accountId, dirName) {
    const session = await sessionFor(accountId);
    const mirror = await openMirror(accountId);
    const idx = await mirror.getIndex(dirName);
    if (!idx) {
      return 0;
    }
    const spec = (await mirror.getPrefetch(dirName)) ?? await loadGlobalSpec();
    return prefetchBodies(session, mirror, dirName, idx.messages, spec);
  },

  async mirrorStatus() {
    const out = {};
    try {
      const res = await chrome.storage.local.get('mirror.lastSynced');
      const persisted = res?.['mirror.lastSynced'] ?? {};
      for (const [id, t] of Object.entries(persisted)) {
        out[id] = Number(t) || 0;
      }
      for (const [id, t] of engine.lastSynced) {
        if (t) {
          out[id] = t;
        }
      }
    }
    catch {}
    return {lastSynced: out};
  },

  async dropAccount(accountId) {
    dropSession(accountId);
    dropMirror(accountId);
    await clearSyncAccountState(accountId);
    engine.lastSynced.delete(accountId);
    try {
      const res = await chrome.storage.local.get('mirror.lastSynced');
      const all = res?.['mirror.lastSynced'] ?? {};
      if (accountId in all) {
        delete all[accountId];
        await chrome.storage.local.set({'mirror.lastSynced': all});
      }
    }
    catch {}
  },
};

// Housekeeping: when an account is removed on the options page its mirror
// tree and session go with it (kept data otherwise survives invisible).
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !('accounts' in changes)) {
    return;
  }
  (async () => {
    const kept = new Set((Array.isArray(changes.accounts.newValue) ? changes.accounts.newValue : [])
      .map(a => a.id).filter(Boolean));
    const known = new Set([
      ...sessions.keys(),
      ...engine.lastSynced.keys(),
      ...engine.inFlight.keys(),
    ]);
    for (const id of known) {
      if (!kept.has(id)) {
        await engine.dropAccount(id);
      }
    }
  })().catch(() => {});
});

// The master password for this session was just confirmed (or removed):
// parked syncs become possible. The badge's own listener re-runs its check
// on the same change (which syncs through the engine); this re-sync covers
// the badge-disabled case directly.
if (chrome.storage.session?.onChanged) {
  chrome.storage.session.onChanged.addListener((changes) => {
    if (!('master.pass' in changes) || !changes['master.pass'].newValue) {
      return;
    }
    (async () => {
      const {accounts = []} = await chrome.storage.local.get({accounts: []});
      for (const a of Array.isArray(accounts) ? accounts : []) {
        if (!a?.id) {
          continue;
        }
        // sessions holding a stale null pass must not look "fresh"
        sessions.get(a.id)?.drop();
        engine.sync(a.id, {mode: 'light', reason: 'unlock'}).catch(() => {});
      }
    })().catch(() => {});
  });
}

// ---- runtime message surface -------------------------------------------------------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') {
    return;
  }
  switch (message.type) {
    case 'sync-now': {
      (async () => {
        const opts = {mode: 'full', reason: reasonOf(message.reason, 'user_request')};
        if (message.dir) {
          opts.dir = String(message.dir);
        }
        let ids = [String(message.accountId || '')];
        if (!message.accountId) {
          const {accounts} = await chrome.storage.local.get({accounts: []});
          ids = accounts.map(a => a.id);
        }
        let last = null;
        for (const id of ids) {
          if (!id) continue;
          last = await engine.sync(id, opts);
        }
        sendResponse({ok: true, lastSynced: last});
      })().catch(e => sendResponse({ok: false, error: msg(e)}));
      return true;
    }

    case 'sync-prefetch-answer': {
      // the client answered the big-folder body prompt: store the per-folder
      // cap and pull that folder's bodies on the spot
      const {accountId, dir, spec} = message;
      if (!accountId || !dir || !BODY_SPECS.includes(spec)) {
        sendResponse({ok: false, error: 'sync-prefetch-answer needs accountId, dir, spec (all|200|50|20)'});
        return true;
      }
      (async () => {
        const mirror = await openMirror(accountId);
        await mirror.setPrefetch(dir, spec);
        broadcastMirrorChanged(accountId, [dir]);
        await engine.fetchBodies(accountId, dir);
        broadcastMirrorChanged(accountId, [dir]);
        sendResponse({ok: true});
      })().catch(e => sendResponse({ok: false, error: msg(e)}));
      return true;
    }

    case 'mirror-mutate': {
      const {accountId, op} = message;
      if (!accountId || !op) {
        sendResponse({ok: false, error: 'mirror-mutate needs accountId + op'});
        return true;
      }
      // resolve only after the op replayed for real and the affected folders
      // resynced — the response is the "action has landed" moment the client
      // (and the badge recount) can rely on
      mutate(accountId, op)
        .then(lastSynced => sendResponse({ok: true, lastSynced}))
        .catch(e => sendResponse({ok: false, error: msg(e)}));
      return true;
    }

    case 'mirror-fetch': {
      const {accountId, dir, uid} = message;
      if (!accountId || !dir || uid == null) {
        sendResponse({ok: false, error: 'mirror-fetch needs accountId, dir, uid'});
        return true;
      }
      fetchBody(accountId, dir, uid)
        .then(bytes => sendResponse({ok: true, bytes}))
        .catch(e => {
          if (e?.code === 'credential') {
            try {
              chrome.runtime.sendMessage({type: 'sync-locked', accountId, error: msg(e)}).catch(() => {});
            }
            catch {}
          }
          sendResponse({ok: false, error: msg(e), code: e?.code});
        });
      return true;
    }

    case 'mirror-status':
      engine.mirrorStatus()
        .then(status => sendResponse({ok: true, ...status}))
        .catch(e => sendResponse({ok: false, error: msg(e)}));
      return true;
  }
  return;
});

export {engine};

// Exposed for the mirror-level harness tests (no runtime consumer): the
// diff-driven merge rules live in syncFolder and these internals.
export {syncFolder};
export const __internals = {replayFolderFlags, replayFolderMoveIn, hasPendingLocalEdits, prefetchBodies};
