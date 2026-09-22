'use strict';

// local-api.mjs — the MailApi the client UI talks to: a local-only facade
// over the offlineimap-style Maildir tree on the granted directory handle
// (data/sync/maildir.mjs). No server, no worker, no OPFS mirror — every read
// and every mutation is a file operation inside the root handle:
//
//   listDirs/count lists  → account-tree walk (MaildirStore.listFolders)
//   threads/bodies/search → per-message header parse (headers.mjs); bodies
//                           parse fully with postal-mime only on demand
//   setFlags/delete/move  → file renames (renameFile/moveBetweenFolders);
//                           delete = \Deleted flag rename, the sync engine
//                           replays the server effect from those names
//   createDir/deleteDir   → {tmp,new,cur} triple create / recursive delete
//
// Flag truth is the maildir filename info part (S R F T D letters — see
// data/sync/maildir.mjs): a local change is visible the moment the file
// rename happens, exactly like the old mirror semantics.
//
// Events: mirrorChanged.subscribe(fn) fires {accountId, dirs, syncedAt} after
// every local mutation (only local edits produce events; there is no engine
// feed anymore).

import {boot} from '../sync/disk.mjs';
import {
  MaildirStore,
  dirNameFor,
} from '../sync/maildir.mjs';
import {loadSnapshot} from '../sync/snapshot.mjs';
import {messageMeta} from './headers.mjs';
import {groupThreads} from './threads.mjs';
import postalMime from '/core/parser/postal-mime.mjs';

const HEADER_BYTES = 65536;
const MAX_META_MESSAGES = 2000; // header-parse cap for one folder read

// ---- mirror change subscription ----------------------------------------------

const listeners = new Set(); // fn({accountId, dirs, syncedAt})

function notifyLocalChange(accountId, dirs) {
  const evt = {type: 'mirror-changed', accountId, dirs, syncedAt: null};
  for (const fn of [...listeners]) {
    try {
      fn(evt);
    }
    catch {
      /* a broken listener must not break the mirror feed */
    }
  }
}

const mirrorChanged = {
  subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};

// ---- resync reports (worker bookkeeping) -------------------------------------
//
// Every local edit reports itself to the worker's dirty.mjs module — one
// fire-and-forget message per operation, carrying the operation's email
// ids, source dir, move destination and flag changes. The module marks the
// touched dirs as needing a server resync in chrome.storage.session (and
// clears them again when a sync actually runs). Nothing here depends on an
// answer: a worker that is not up must never break an edit.

function reportEdit(payload) {
  try {
    chrome.runtime.sendMessage({type: 'sync-dirty-report', ...payload})
      .catch(() => {});
  }
  catch {
    /* extension context gone (reload/close) — the edit itself still ran */
  }
}

// ---- per-message metadata (re-parsed on demand; no cache files) ---------------

// subject/from/date/threads re-parse per folder read (cheap header slices,
// capped so gigantic mailboxes degrade gracefully); mutations just notify the
// views, whose refetch re-parses fresh disk truth.

// Rows for one folder: uid/flags from the filenames, subject/from/date from
// the header block. \\Deleted rows leave every view.
async function folderRows(store, account, folder) {
  const local = await store.listLocal(folder);
  if (!local) {
    return {rows: [], entries: new Map()};
  }
  const entries = local.entries; // Map<uid, entry>
  const rows = [];
  for (const entry of entries.values()) {
    const flags = [...(entry.flags ?? [])];
    if (flags.includes('\\Deleted')) {
      continue;
    }
    rows.push({
      entry,
      folder,
      uid: entry.uid,
      flags,
      subject: null,
      from: null,
      date: null,
      messageId: null,
      references: null,
      inReplyTo: null,
    });
  }
  for (const interloper of local.interlopers ?? []) {
    rows.push({
      entry: interloper,
      folder,
      uid: interloper.uid,
      flags: [...(interloper.flags ?? [])],
      subject: null,
      from: null,
      date: null,
      messageId: null,
      references: null,
      inReplyTo: null,
    });
  }
  rows.sort((a, b) => b.uid - a.uid);
  return {rows, entries};
}

// Fill the header-derived fields of the rows. Cap: gigantic folders degrade
// gracefully (rows without metadata still list and open fine).
async function withMeta(rows) {
  const slice = rows.slice(0, MAX_META_MESSAGES);
  await Promise.all(slice.map(async row => {
    try {
      const file = await row.entry.file.getFile();
      const bytes = new Uint8Array(await file.slice(0, HEADER_BYTES).arrayBuffer());
      Object.assign(row, messageMeta(bytes));
    }
    catch {
      // unreadable/partial body: the row keeps uid+flags (flag truth) only
    }
  }));
  return rows;
}

// Raw RFC822 of one message, resilient to the maildir flag-rename races:
// a \Seen (or any flag) change renames the file (new/ <-> cur/, plus the
// info letters), and a listing taken just before the rename holds file
// handles whose paths no longer exist — getFile() then fails with the FS
// Access API's NotFoundError ("a requested file or directory could not be
// found"). Each attempt re-lists the folder so the entry reflects the
// current path; retries only the transient not-found cases and rethrows
// anything else untouched.
const READ_RETRIES = 3;
const READ_RETRY_DELAY = 25;

function isNotFound(e) {
  return e?.name === 'NotFoundError' || /could not be found/i.test(String(e?.message ?? e));
}

async function readMessage(store, accountId, folder, uid) {
  const wanted = Number(uid);
  for (let attempt = 0; ; attempt++) {
    try {
      const {rows} = await folderRows(store, accountId, folder);
      const row = rows.find(r => r.uid === wanted);
      if (!row) {
        throw new Error('body not available locally: uid ' + uid);
      }
      return await store.readFile(row.entry);
    }
    catch (e) {
      if (attempt >= READ_RETRIES - 1 || !isNotFound(e)) {
        throw e;
      }
      await new Promise(resolve => setTimeout(resolve, READ_RETRY_DELAY));
    }
  }
}

// ---- the API facade ------------------------------------------------------------

const apis = new Map(); // accountId -> Promise<api>

export function getRootHandle() {
  return boot(); // resolves the granted root or redirects to the picker
}

export async function getLocalApi(accountId) {
  if (!accountId) {
    throw new Error('getLocalApi: accountId required');
  }
  let memo = apis.get(accountId);
  if (memo) {
    return await memo;
  }
  memo = buildApi(accountId);
  apis.set(accountId, memo);
  return await memo;
}

export function dropLocalApi(accountId) {
  apis.delete(accountId);
  bodyCache.clear();
}

async function buildApi(accountId) {
  const root = await getRootHandle();
  const store = new MaildirStore(root, accountId);
  await store.open();
  let selected = null;

  const api = {
    // the old MailApi remnants (compatibility for stragglers)
    async connect() {},
    async close() {
      selected = null;
    },
    selectedDir() {
      return selected;
    },

    accountDir() {
      return store.account;
    },

    async listDirs() {
      // every local Maildir of this account, as the tree expects it
      const folders = await store.listFolders();
      return folders.filter(name => upper(name) !== 'EXPORTS').map(name => ({
        name,
        delimiter: '/',
        attrs: [],
      }));
    },

    async openDir(name) {
      const exists = (await store.listFolders()).some(f => f === name);
      if (!exists) {
        const err = new Error('no such mailbox: ' + name);
        err.code = 'mirror';
        throw err;
      }
      selected = name;
      const rows = (await folderRows(store, accountId, name)).rows;
      const uidvalidity = Number(await store.readUidValidity(name)) || 0;
      const unseen = rows.filter(r => !r.flags.includes('\\Seen')).length;
      return {
        exists: rows.length,
        uidvalidity,
        uidnext: 0,
        unseen,
      };
    },

    /**
     * Rows of the open dir (or an explicit fromUid/toUid range), newest uid
     * first, \\Deleted rows gone. Headers re-parse on every call (cheap
     * slice reads — the same truth listThreads() renders).
     */
    async listFiles({page = 0, pageSize = 20, fromUid, toUid} = {}) {
      if (!selected) throw new Error('openDir() first');
      let rows = (await folderRows(store, accountId, selected)).rows;
      if (fromUid != null) {
        const lo = Number(fromUid);
        const hi = toUid != null ? Number(toUid) : lo;
        return summarize(await withMeta(rows.filter(r => r.uid >= lo && r.uid <= hi)));
      }
      const start = page * pageSize;
      return summarize(await withMeta(rows.slice(start, start + pageSize)));
    },

    async listThreads() {
      if (!selected) throw new Error('openDir() first');
      const rows = (await folderRows(store, accountId, selected)).rows;
      return groupThreads(await withMeta(rows));
    },

    async readFile(uid) {
      if (!selected) throw new Error('openDir() first');
      return await readMessage(store, accountId, selected, uid);
    },

    async search(options) {
      const {
        dir,
        query,
        allFolders = false,
        onPage = null,
      } = options ?? {};
      return searchFolders(store, accountId, allFolders ? null : (dir ?? selected), query, onPage);
    },

    async listDirCounts(onProgress) {
      const dirs = await api.listDirs();
      const out = [];
      for (const d of dirs) {
        const {rows} = await folderRows(store, accountId, d.name);
        const unread = rows.filter(r => !r.flags.includes('\\Seen')).length;
        const page = {name: d.name, unread, total: rows.length};
        out.push(page);
        if (typeof onProgress === 'function') {
          try {
            onProgress(page);
          }
          catch {}
        }
      }
      return out;
    },

    // ---- mutations: pure local file edits (maildir semantics) ----
    // flags   → the maildir info letters rewrite themselves (S R F T D only;
    //           unknown IMAP keywords cannot be filename-encoded and drop)
    // delete  → the T (Deleted) letter; the sync engine replays the server
    //           purge from the filename truth on its own device
    // move    → the file renames into the target folder keeping its uid —
    //           the sync engine reads the FMD5 mismatch as a pending move

    async setFlags(uids, addFlags, removeFlags) {
      if (!selected) throw new Error('openDir() first');
      const wanted = new Set((uids ?? []).map(Number));
      const add = (addFlags ?? []).map(String);
      const remove = (removeFlags ?? []).map(String);
      const {rows} = await folderRows(store, accountId, selected);
      let touched = false;
      const touchedUids = [];
      for (const row of rows) {
        if (!wanted.has(row.uid)) {
          continue;
        }
        const flags = new Set(row.flags);
        for (const f of add) flags.add(f);
        for (const f of remove) flags.delete(f);
        const next = [...flags];
        if (sameSet(next, row.flags)) {
          continue;
        }
        await store.renameMessage(selected, row.entry, {flags: next});
        touched = true;
        touchedUids.push(row.uid);
      }
      if (touched) {
        notifyLocalChange(accountId, [selected]);
        reportEdit({
          accountId,
          uids: touchedUids,
          srcDir: selected,
          addFlags: add,
          removeFlags: remove
        });
      }
      return 0;
    },

    async moveTo(uids, mailbox) {
      if (!selected) throw new Error('openDir() first');
      if (!mailbox || mailbox === selected) {
        throw new Error('move: a distinct target folder is required');
      }
      const wanted = new Set((uids ?? []).map(Number));
      const {rows} = await folderRows(store, accountId, selected);
      const candidates = rows.filter(r => wanted.has(r.uid));
      if (!candidates.length) {
        throw new Error('move: messages are no longer in the local folder');
      }
      for (const row of candidates) {
        // keepFmd5: the renamed file keeps the source folder's FMD5 — the
        // offlineimap "pending move" marker the sync engine reads back as
        // one server MOVE (never a delete + append)
        await store.moveMessage(selected, row.entry, mailbox, row.uid, {keepFmd5: true});
      }
      notifyLocalChange(accountId, [selected, mailbox]);
      reportEdit({
        accountId,
        uids: candidates.map(r => r.uid),
        srcDir: selected,
        destDir: mailbox
      });
      return candidates.length;
    },

    async deleteMessages(uids) {
      if (!selected) throw new Error('openDir() first');
      const wanted = new Set((uids ?? []).map(Number));
      const {rows} = await folderRows(store, accountId, selected);
      const candidates = rows.filter(r => wanted.has(r.uid));
      if (!candidates.length) {
        throw new Error('delete: messages are no longer in the local folder');
      }
      for (const row of candidates) {
        const flags = [...row.flags.filter(f => f !== '\\Deleted'), '\\Deleted'];
        await store.renameMessage(selected, row.entry, {flags});
      }
      notifyLocalChange(accountId, [selected]);
      reportEdit({
        accountId,
        uids: candidates.map(r => r.uid),
        srcDir: selected,
        addFlags: ['\\Deleted']
      });
      return candidates.length;
    },

    async purgeMessages(uids) {
      if (!selected) throw new Error('openDir() first');
      const wanted = new Set((uids ?? []).map(Number));
      const {rows} = await folderRows(store, accountId, selected);
      const candidates = rows.filter(r => wanted.has(r.uid));
      if (!candidates.length) {
        throw new Error('purge: messages are no longer in the local folder');
      }
      let purged = 0;
      for (const row of candidates) {
        // hard removal of the message file; a missing file is not an error
        if (await store.removeMessage(row.entry)) {
          purged++;
        }
      }
      notifyLocalChange(accountId, [selected]);
      reportEdit({
        accountId,
        uids: candidates.map(r => r.uid),
        srcDir: selected
      });
      return purged;
    },

    async createDir(name) {
      if (typeof name !== 'string' || !name.trim()) {
        throw new Error('createDir: folder name required');
      }
      await store.folder(name.trim(), {create: true});
      notifyLocalChange(accountId, [name.trim()]);
      reportEdit({accountId, srcDir: name.trim()});
    },

    async deleteDir(name) {
      if (typeof name !== 'string' || !name) {
        throw new Error('deleteDir: folder name required');
      }
      await removeFolderDir(store, name);
      notifyLocalChange(accountId, [name]);
      reportEdit({accountId, srcDir: name});
    },

    async idle() {
      return {type: 'interrupt'};
    },

    // local no-op: there is no engine to prompt; the facade keeps the same
    // surface for the UI and answers with the disk state
    async syncNow() {
      return api.lastSynced();
    },

    /** last full-sync stamp of the account's .sync-state.json, ms or null */
    async lastSynced() {
      try {
        const snap = await loadSnapshot(store.account);
        const t = Date.parse(snap?.lastSyncAt);
        return Number.isNaN(t) ? null : t;
      }
      catch {
        return null;
      }
    },
  };

  return api;
}

const upper = s => String(s ?? '').toUpperCase();

// strips the fields the list view actually renders
function summarize(rows) {
  return rows.map(r => ({
    uid: r.uid,
    flags: [...r.flags],
    subject: r.subject,
    from: r.from,
    date: r.date,
    size: null,
  }));
}

function sameSet(a, b) {
  if (a.length !== b.length) {
    return false;
  }
  const s = new Set(b);
  return a.every(f => s.has(f));
}

// remove the Maildir triple + .uidvalidity of one folder (leaf deletions only)
async function removeFolderDir(store, folder) {
  const direction = dirNameFor(folder);
  try {
    await store.account.removeEntry(direction, {recursive: true});
  }
  catch {
    /* gone already */
  }
}

// ---- folder-scoped local search ------------------------------------------------

async function searchFolders(store, accountId, onlyDir, query, onPage) {
  const terms = parseQuery(query);
  if (!terms.length) {
    return [];
  }
  const dirs = onlyDir
    ? [onlyDir]
    : (await store.listFolders()).filter(n => upper(n) !== 'EXPORTS');
  if (!dirs.length) {
    throw new Error('search: no dir given and none open');
  }
  const out = [];
  for (const folder of dirs) {
    const {rows} = await folderRows(store, accountId, folder);
    if (onPage) {
      try {
        onPage({name: folder, done: 0, total: rows.length});
      }
      catch {}
    }
    for (const row of await withMeta(rows)) {
      if (row.flags.includes('\\Deleted')) {
        continue;
      }
      if (await matchMessage(row, terms, store, accountId)) {
        out.push(row);
      }
    }
  }
  return listThreadsFromRows(store, accountId, out);
}

// ThreadSummary[] of matching rows, tagged with their folder (the views show
// the folder name on all: imports results like the old mirror search did)
async function listThreadsFromRows(store, accountId, rows) {
  const byFolder = new Map();
  for (const row of rows) {
    let list = byFolder.get(row.folder);
    if (!list) {
      list = [];
      byFolder.set(row.folder, list);
    }
    list.push(row);
  }
  const out = [];
  for (const [folder, list] of byFolder) {
    const threads = groupThreads(await withMeta(list));
    for (const t of threads) {
      out.push({...t, dir: folder});
    }
  }
  out.sort((a, b) => (Date.parse(String(b.date ?? '')) || 0) - (Date.parse(String(a.date ?? '')) || 0));
  return out;
}

// ---- query language (same grammar as the old mirror search) ---------------------

const FLAG_KEYWORDS = {
  unseen: 'UNSEEN',
  seen: 'SEEN',
  flagged: 'FLAGGED',
  answered: 'ANSWERED',
  deleted: 'DELETED',
};

function parseQuery(query) {
  const raw = String(query ?? '').trim();
  if (!raw) {
    return [];
  }
  const terms = [];
  for (const token of raw.split(/\s+/)) {
    if (!token) {
      continue;
    }
    const m = token.match(/^(not:)?(from|to|subject|body|text|since|before|is):(.*)$/i);
    const neg = !!m?.[1];
    if (!m) {
      terms.push({neg, key: null, value: token, raw: token});
      continue;
    }
    const key = m[2].toLowerCase();
    const value = (m[3] ?? '').replace(/^"(.*)"$/, '$1');
    if (/^(since|before)$/.test(key) && !value) {
      continue;
    }
    if (/^is$/.test(key) && !value) {
      continue;
    }
    terms.push({neg, key, value, raw: token});
  }
  return terms;
}

const textHits = (hay, needle) =>
  String(hay ?? '').toLowerCase().includes(String(needle).toLowerCase());

function hasAnyFlag(flags, keyword) {
  const set = Array.isArray(flags) ? flags.map(String) : [];
  switch (keyword) {
    case 'UNSEEN': return !set.includes('\\Seen');
    case 'SEEN': return set.includes('\\Seen');
    case 'FLAGGED': return set.includes('\\Flagged');
    case 'ANSWERED': return set.includes('\\Answered');
    case 'DELETED': return set.includes('\\Deleted');
    default: return false;
  }
}

function parseImapDate(value) {
  const m = String(value).trim().match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
  if (!m) {
    const t = Date.parse(value);
    return Number.isNaN(t) ? null : new Date(t);
  }
  const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const month = months.indexOf(m[2].toLowerCase());
  if (month === -1) {
    return null;
  }
  const d = new Date(Number(m[3]), month, Number(m[1]));
  return Number.isNaN(d.getTime()) ? null : d;
}

function dateMatches(term, message) {
  const t = Date.parse(String(message.date ?? ''));
  if (!t) {
    return false;
  }
  const d = new Date(t);
  const day = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const dd = new Date(term.date);
  const cmp = new Date(dd.getFullYear(), dd.getMonth(), dd.getDate()).getTime();
  return term.key === 'since' ? day >= cmp : day < cmp;
}

// Lazy per-row body field resolver (full postal-mime): body text + To.
async function matchMessage(row, terms, store, accountId) {
  for (const term of terms) {
    let hit = false;
    if (term.key === null) {
      const needle = term.value.toLowerCase();
      hit = [row.subject, row.from, String(row.date ?? '')]
        .some(v => String(v ?? '').toLowerCase().includes(needle));
      if (!hit) {
        const fields = await bodyFields(store, accountId, row);
        hit = [fields.to, fields.bodyText].some(v => String(v ?? '').toLowerCase().includes(needle));
      }
    }
    else if (term.key === 'subject') {
      hit = textHits(row.subject, term.value);
    }
    else if (term.key === 'from') {
      hit = textHits(row.from, term.value);
    }
    else if (term.key === 'to' || term.key === 'body' || term.key === 'text') {
      const fields = await bodyFields(store, accountId, row);
      if (term.key === 'to') {
        hit = textHits(fields.to, term.value);
      }
      else if (term.key === 'body') {
        hit = textHits(fields.bodyText, term.value);
      }
      else {
        hit = [row.subject, row.from, fields.to, fields.bodyText]
          .some(v => textHits(v, term.value));
      }
    }
    else if (term.key === 'is') {
      hit = hasAnyFlag(row.flags, FLAG_KEYWORDS[term.value.toLowerCase()] ?? term.value.toUpperCase());
    }
    else if (term.key === 'since' || term.key === 'before') {
      term.date = parseImapDate(term.value);
      hit = term.date != null ? dateMatches(term, row) : false;
    }
    if (term.neg ? hit : !hit) {
      return false;
    }
  }
  return true;
}

// fully parsed body fields (body text + to), memoized per uid+folder
const bodyCache = new Map();

async function bodyFields(store, accountId, row) {
  const key = accountId + '\u0000' + row.folder + '\u0000' + row.uid;
  let hit = bodyCache.get(key);
  if (hit) {
    return hit;
  }
  const fields = {bodyText: '', to: ''};
  try {
    const raw = await readMessage(store, accountId, row.folder, row.uid);
    const email = await postalMime().parse(raw);
    const parts = [];
    if (email.text) {
      parts.push(email.text);
    }
    if (email.html) {
      parts.push(String(email.html).replace(/<[^>]+>/g, ' '));
    }
    fields.bodyText = parts.join(' ');
    fields.to = (Array.isArray(email.to) ? email.to : [])
      .map(a => [a?.name, a?.address].filter(Boolean).join(' '))
      .filter(Boolean)
      .join(' ');
  }
  catch {
    /* unreadable body: header-only matching */
  }
  bodyCache.set(key, fields);
  if (bodyCache.size > 400) {
    bodyCache.clear();
  }
  return fields;
}

// ---- exports kept for the UI modules --------------------------------------------

export {notifyLocalChange, mirrorChanged};
