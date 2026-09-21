'use strict';

// store.mjs — the local IMAP clone ("the mirror").
//
// An OfflineIMAP/Maildir-style layout inside OPFS
// (navigator.storage.getDirectory()), one directory per IMAP mailbox:
//
//   <accountId>/_meta.json                          {dirs, folders, ...}
//   <accountId>/_outbox/<id>.json                   queued server operations
//   <accountId>/<folderEnc>/_index.json             metadata cache ONLY
//                                                   (subject/from/date/size/
//                                                   threads per uid, no flag
//                                                   truth)
//   <accountId>/<folderEnc>/cur/<longname>.eml      raw RFC822 bodies, whose
//     longname carries uid + folder digest (FMD5) + maildir flags:
//     <base>,U=<uid>,FMD5=<md5>[:2,<chars>].eml (see maildir-name.mjs)
//
// FLAG TRUTH LIVES IN FILENAMES. The index is only a metadata cache; whoever
// reads flags derives them from the .eml longname locally (client and engine
// alike). Local changes are file operations the client performs itself —
// a delete renames the file with the T flag, a move renames it into the
// target folder's cur/ dir — and the sync engine reads the disk next pass to
// replay server effects. Tombstone dot-files and staged-move batches are gone:
// a foreign FMD5 in a directory IS the staged move, ":2,T" IS the delete.
//
// The store is process-agnostic: the service worker (SyncEngine + its private
// IndexedDB state) and the client page (LocalMailApi) both open the same OPFS
// tree, so every read-modify-write runs under a Web Lock shared across the
// two contexts. Node tests (no OPFS) swap in an in-memory fs with the same
// interface.

import {attachMirrorCrypto, looksEncrypted, decryptWith, encryptWith} from './mirror-crypto.mjs';
import {parseLongname, buildLongname, newBase, folderDigest, charsForFlags} from './maildir-name.mjs';

const META_VERSION = 1;

// ---- folder-name <-> safe file-system segment ------------------------------

export function encodeDirName(name) {
  return encodeURIComponent(String(name || ''));
}

export function decodeDirName(enc) {
  try {
    return decodeURIComponent(enc);
  }
  catch {
    return enc;
  }
}

// summary stored in _meta.json per folder (one small file serves aggregate
// reads: tree counts, last synced, dir counts)
export function emptySummary() {
  return {uidvalidity: 0, uidnext: 0, exists: 0, unread: 0, total: 0, lastSync: 0};
}

export function emptyIndex(name) {
  return {
    name: String(name || ''),
    uidvalidity: 0,
    uidnext: 0,
    exists: 0,
    lastSync: 0,
    messages: [], // metadata cache: {uid, flags, subject, from, date, size}
    threads: [],  // [[uid, uid…]] conversations, newest thread first
  };
}

// ---- index helpers (shared by engine + LocalMailApi) -----------------------

const hasFlag = (flags, flag) => (Array.isArray(flags) ? flags : []).includes(flag);

function messageRow(m) {
  return {
    uid: Number(m.uid),
    flags: Array.isArray(m.flags) ? m.flags.map(String) : [],
    subject: m.subject ?? null,
    from: m.from ?? null,
    date: m.date ?? null,
    size: m.size ?? null,
  };
}

// Aggregate a stable summary for a folder index. Kept in _meta.json so tree
// counts and last-synced reads never touch per-folder files.
export function summarizeIndex(index) {
  const row = messagesOf(index);
  const unread = row.filter(m => !hasFlag(m.flags, '\\Seen')).length;
  return {
    uidvalidity: Number(index?.uidvalidity) || 0,
    uidnext: Number(index?.uidnext) || 0,
    exists: Number(index?.exists) || row.length,
    unread,
    total: row.length,
    lastSync: Number(index?.lastSync) || 0,
  };
}

function messagesOf(index) {
  let row = index?.messages;
  if (!Array.isArray(row)) {
    row = Object.values(index?.messages ?? {}); // tolerate old object shape
  }
  return row.map(messageRow);
}

// JWZ-agnostic thread reconstruction from the stored thread groups: the Sync
// Engine groups inside the wasm core and stores uids per thread; aggregates
// (unread/flagged/subject/from/date) are always computed from the message
// rows so flag changes need no thread rewrite.
export function threadSummaries(index) {
  const byUid = new Map(messagesOf(index).map(m => [Number(m.uid), m]));
  const out = [];
  for (const group of Array.isArray(index?.threads) ? index.threads : []) {
    const uids = (Array.isArray(group) ? group : [group])
      .map(Number)
      .filter(uid => byUid.has(uid));
    if (!uids.length) {
      continue;
    }
    const messages = uids
      .map(uid => byUid.get(uid))
      .sort((a, b) => (Number(a.uid) - Number(b.uid)) || timeOf(a.date) - timeOf(b.date));
    const oldest = messages[0];
    const newest = messages[messages.length - 1];
    out.push({
      uids: messages.map(m => m.uid),
      count: messages.length,
      unread: messages.filter(m => !hasFlag(m.flags, '\\Seen')).length,
      flagged: messages.some(m => hasFlag(m.flags, '\\Flagged')),
      subject: oldest.subject ?? null,
      from: oldest.from ?? null,
      date: newestDate(messages),
      messages: messages.map(m => ({
        uid: m.uid, flags: m.flags, subject: m.subject, from: m.from, date: m.date,
      })),
    });
  }
  out.sort((a, b) => timeOf(b.date) - timeOf(a.date));
  return out;
}

function timeOf(v) {
  const ms = Date.parse(String(v ?? ''));
  return Number.isNaN(ms) ? 0 : ms;
}

// the newest date across the thread (the wasm core reports the thread's
// top message date; fall back to the max parseable one)
function newestDate(messages) {
  let best = null;
  for (const m of messages) {
    const raw = timeOf(m.date);
    if (raw && (!best || raw > timeOf(best))) {
      best = m.date;
    }
  }
  return best ?? (messages[messages.length - 1]?.date ?? null);
}

// ---- index mutations (engine-side; sync diffs) -----------------------------

// Insert a summary or merge flags into an existing row. Returns true when
// the row changed. `summary` is the MessageSummary shape (uid/flags/...).
export function upsertMessage(index, summary) {
  const row = messageRow(summary);
  const messages = (index.messages = Array.isArray(index.messages) ? index.messages : []);
  const idx = messages.findIndex(m => Number(m.uid) === row.uid);
  if (idx === -1) {
    messages.push(row);
    return true;
  }
  const prev = messages[idx];
  messages[idx] = {
    ...prev,
    ...row,
    flags: row.flags.length ? row.flags : prev.flags,
  };
  return JSON.stringify(prev) !== JSON.stringify(messages[idx]);
}

export function removeMessages(index, uids) {
  const drop = new Set((Array.isArray(uids) ? uids : []).map(Number));
  if (!drop.size || !Array.isArray(index.messages)) {
    return;
  }
  index.messages = index.messages.filter(m => !drop.has(Number(m.uid)));
}

export function applyFlagDelta(index, uids, addFlags, removeFlags) {
  const add = (Array.isArray(addFlags) ? addFlags : []).map(String);
  const remove = (Array.isArray(removeFlags) ? removeFlags : []).map(String);
  const set = new Set((Array.isArray(uids) ? uids : []).map(Number));
  if (!set.size || (!add.length && !remove.length)) {
    return false;
  }
  let touched = false;
  for (const m of Array.isArray(index.messages) ? index.messages : []) {
    if (!set.has(Number(m.uid))) {
      continue;
    }
    const flags = new Set(Array.isArray(m.flags) ? m.flags : []);
    for (const f of add) flags.add(f);
    for (const f of remove) flags.delete(f);
    m.flags = [...flags];
    touched = true;
  }
  return touched;
}

// ---- fs backends -----------------------------------------------------------
// Five primitives are all the store needs:
//   ensureDir(segments) -> dir handle
//   readFile(segments) -> Uint8Array | null
//   writeFile(segments, data) -> void
//   deleteFile(segments) -> void
//   listFiles(dirSegments) -> [{name}] files only
//   removeDir(segments) -> void (recursive, best-effort)

const Encoder = new TextEncoder();
const Decoder = new TextDecoder();

function toU8(data) {
  if (data instanceof Uint8Array) {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  return new Uint8Array(data?.buffer ?? data, data?.byteOffset ?? 0, data?.byteLength ?? data?.length ?? 0);
}

export function encodeJson(value) {
  return Encoder.encode(JSON.stringify(value));
}

export function decodeJson(bytes) {
  try {
    return JSON.parse(Decoder.decode(bytes));
  }
  catch {
    return null;
  }
}

class OpfsFs {
  constructor(root) {
    this.root = root;
  }

  static async open() {
    if (typeof navigator?.storage?.getDirectory !== 'function') {
      return null;
    }
    try {
      return new OpfsFs(await navigator.storage.getDirectory());
    }
    catch {
      return null;
    }
  }

  async dirOf(segments) {
    let dir = this.root;
    for (const seg of segments) {
      dir = await dir.getDirectoryHandle(seg, {create: true});
    }
    return dir;
  }

  async ensureDir(segments) {
    return this.dirOf(segments);
  }

  async fileHandle(segments, create = false) {
    const dir = await this.dirOf(segments.slice(0, -1));
    return dir.getFileHandle(segments[segments.length - 1], {create});
  }

  async readFile(segments) {
    try {
      const fh = await this.fileHandle(segments);
      return new Uint8Array(await (await fh.getFile()).arrayBuffer());
    }
    catch {
      return null;
    }
  }

  async writeFile(segments, data) {
    const dir = await this.dirOf(segments.slice(0, -1));
    const handle = await dir.getFileHandle(segments[segments.length - 1], {create: true});
    const stream = await handle.createWritable();
    try {
      await stream.write(data.slice().buffer);
    }
    finally {
      await stream.close();
    }
  }

  async deleteFile(segments) {
    try {
      const dir = await this.dirOf(segments.slice(0, -1));
      await dir.removeEntry(segments[segments.length - 1]);
    }
    catch {
      /* missing file is fine */
    }
  }

  async listFiles(segments) {
    try {
      const dir = await this.dirOf(segments);
      const out = [];
      for await (const [name, handle] of dir.entries()) {
        if (handle.kind === 'file') {
          out.push({name});
        }
      }
      return out;
    }
    catch {
      return [];
    }
  }

  async removeDir(segments) {
    if (!segments.length) {
      return;
    }
    try {
      const dir = await this.dirOf(segments.slice(0, -1));
      await dir.removeEntry(segments[segments.length - 1], {recursive: true});
    }
    catch {
      /* best-effort */
    }
  }
}

// Node/tests fallback: identical contract on in-memory Maps.
export function openMemoryFs() {
  return new MemFs();
}

class MemFs {
  constructor() {
    this.files = new Map(); // joined path -> Uint8Array
    this.dirs = new Set();  // joined dirs (incl. ancestors)
  }

  static async open() {
    return new MemFs();
  }

  async ensureDir(segments) {
    let path = '';
    for (const seg of segments) {
      path += '/' + seg;
      this.dirs.add(path);
    }
    return {path};
  }

  async dirOf(segments) {
    let path = '';
    for (const seg of segments) {
      path += '/' + seg;
      if (!this.dirs.has(path)) {
        this.dirs.add(path);
      }
    }
    return {path};
  }

  async readFile(segments) {
    const hit = this.files.get('/' + segments.join('/'));
    return hit ? hit.slice() : null;
  }

  async writeFile(segments, data) {
    const key = '/' + segments.join('/');
    const dir = '/' + segments.slice(0, -1).join('/');
    this.dirs.add(dir);
    this.files.set(key, data instanceof Uint8Array ? data.slice() : new Uint8Array(data));
  }

  async deleteFile(segments) {
    this.files.delete('/' + segments.join('/'));
  }

  async listFiles(segments) {
    const prefix = '/' + segments.join('/') + '/';
    const names = new Set();
    for (const key of this.files.keys()) {
      if (key.startsWith(prefix)) {
        names.add(key.slice(prefix.length).split('/')[0]);
      }
    }
    return [...names].map(name => ({name}));
  }

  async removeDir(segments) {
    const prefix = '/' + segments.join('/');
    for (const key of [...this.files.keys()]) {
      if (key === prefix || key.startsWith(prefix + '/')) {
        this.files.delete(key);
      }
    }
    for (const key of [...this.dirs]) {
      if (key === prefix || key.startsWith(prefix + '/')) {
        this.dirs.delete(key);
      }
    }
  }
}

// ---- cross-context index locking -------------------------------------------

const localLocks = new Map(); // key -> Promise chain (fallback, same-context)

async function withLock(key, fn) {
  if (typeof navigator?.locks?.request === 'function') {
    try {
      return await navigator.locks.request(key, fn);
    }
    catch {
      // web-locks are unavailable in some restricted contexts — fall through
    }
  }
  return localLockFallback(key, fn);
}

function localLockFallback(key, fn) {
  const run = (localLocks.get(key) || Promise.resolve()).then(fn, fn);
  localLocks.set(key, run.then(() => {}, () => {}));
  return run;
}

// ---- public facade -----------------------------------------------------------

// fs layer that swaps plaintext mirror contents for encrypted ones whenever
// the account's mirror crypto is on (a master password + salt bucket exist).
// Every read decrypts (a locked session surfaces {code:'locked'}), every
// write encrypts; file names and the directory layout stay unencrypted so
// listing stays cheap. Legacy/plaintext content passes through either way.
class CryptoWrap {
  constructor(inner, mirror) {
    this.inner = inner;
    this.mirror = mirror;
  }

  async dirOf(segments) {
    return this.inner.dirOf(segments);
  }

  async ensureDir(segments) {
    return this.inner.ensureDir(segments);
  }

  async readFile(segments) {
    const bytes = await this.inner.readFile(segments);
    if (bytes == null) {
      return null;
    }
    return this.mirror.crypto.decrypt(bytes);
  }

  async writeFile(segments, data) {
    const payload = await this.mirror.crypto.encrypt(data);
    return this.inner.writeFile(segments, payload);
  }

  async deleteFile(segments) {
    return this.inner.deleteFile(segments);
  }

  async listFiles(segments) {
    return this.inner.listFiles(segments);
  }

  async removeDir(segments) {
    return this.inner.removeDir(segments);
  }
}

export class MailDirMirror {
  constructor(backend, accountId, log = () => {}) {
    this.raw = backend;
    this.accountId = String(accountId || '');
    this.log = log;
    this._outboxSeq = 0;
    this.crypto = attachMirrorCrypto(this, {accountId: this.accountId});
    this.fs = new CryptoWrap(backend, this);
  }

  static async open(accountId, {log = () => {}, backend = null} = {}) {
    let fs = backend;
    if (!fs) {
      fs = await OpfsFs.open() ?? new MemFs();
      log(`mirror backend: ${fs instanceof OpfsFs ? 'OPFS' : 'memory'}`);
    }
    return new MailDirMirror(fs, accountId, log);
  }

  get backendKind() {
    return this.raw instanceof OpfsFs ? 'opfs' : 'memory';
  }

  ctx(...segments) {
    return [this.accountId, ...segments];
  }

  lockKey(...segments) {
    return `mirror:${this.accountId}:${segments.join('/')}`;
  }

  // ---- account meta (folder list + per-folder summaries) ----

  async getMeta() {
    const raw = await this.fs.readFile(this.ctx('_meta.json'));
    const meta = raw ? decodeJson(raw) : null;
    return meta && typeof meta === 'object' ? meta : {version: META_VERSION, dirs: [], folders: {}};
  }

  async setMeta(meta) {
    await this.fs.writeFile(this.ctx('_meta.json'), encodeJson(meta ?? {version: META_VERSION, dirs: [], folders: {}}));
  }

  // Update a single folder's summary line inside _meta.json (locked RMW).
  async updateSummary(dirName, fn) {
    await withLock(this.lockKey('_meta'), async () => {
      const meta = await this.getMeta();
      const enc = encodeDirName(dirName);
      const folders = (meta.folders = meta.folders ?? {});
      folders[enc] = fn({...emptySummary(), ...(folders[enc] ?? {})});
      await this.setMeta(meta);
    });
  }

  async summarized() {
    const meta = await this.getMeta();
    const out = new Map();
    for (const [enc, summary] of Object.entries(meta.folders ?? {})) {
      out.set(decodeDirName(enc), {enc, ...summary});
    }
    return out;
  }

  // ---- folder indices ----

  async getIndex(dirName) {
    const enc = encodeDirName(dirName);
    const raw = await this.fs.readFile(this.ctx(enc, '_index.json'));
    const index = raw ? decodeJson(raw) : null;
    return index && Array.isArray(index.messages) ? index : null;
  }

  async putIndex(dirName, index) {
    const enc = encodeDirName(dirName);
    await withLock(this.lockKey(enc), async () => {
      await this.fs.writeFile(this.ctx(enc, '_index.json'), encodeJson(index));
    });
    const summary = summarizeIndex(index);
    await this.updateSummary(dirName, s => ({...s, ...summary}));
  }

  // Read-modify-write of one folder's index under the cross-context lock;
  // fn(index) must return the new index (or null to abort without writing).
  async updateIndex(dirName, fn) {
    let result = null;
    await withLock(this.lockKey(encodeDirName(dirName)), async () => {
      const index = (await this.getIndex(dirName)) ?? emptyIndex(dirName);
      const next = await fn(index);
      if (next) {
        await this.fs.writeFile(this.ctx(encodeDirName(dirName), '_index.json'), encodeJson(next));
        await this.updateSummary(dirName, s => ({...s, ...summarizeIndex(next)}));
      }
      result = next;
    });
    return result;
  }

  // Index write WITHOUT acquiring the folder lock — for callers that already
  // hold it (setLocalFlags / removeLocal / moveLocal chain file renames and
  // the index write in one critical section; web locks are not re-entrant).
  async _writeIndex(dirName, index, enc) {
    enc = enc ?? encodeDirName(dirName);
    await this.fs.writeFile(this.ctx(enc, '_index.json'), encodeJson(index));
    await this.updateSummary(dirName, s => ({...s, ...summarizeIndex(index)}));
  }

  // ---- bodies ----

  // Row cleanup when a uid no longer fetches ("no body returned") though it
  // still appears in listings — expunge-pending mail from other clients.
  async dropUids(dirName, uids) {
    const set = new Set((uids ?? []).map(Number));
    return this.updateIndex(dirName, index => {
      removeMessages(index, [...set]);
      index.threads = (index.threads ?? [])
        .map(group => group.filter(uid => !set.has(Number(uid))))
        .filter(group => group.length);
      return index;
    });
  }

  // ---- Maildir items: longname bodies, trash flag, file moves ------------
  //
  // Each body file is a Maildir longname (`cur/<base>,U=<uid>,FMD5=<md5>[:2,
  // <chars>].eml`). All flag state lives in that name; local edits are plain
  // file operations the client performs:
  //   delete  → the file is renamed with the T flag (trash) — views already
  //             dropped the row locally, the server purge replays at the next
  //             sync, where the engine deletes the file for real;
  //   move    → the file is renamed across folders keeping its foreign FMD5 —
  //             the sync engine reads the mismatch as "moved in, server move
  //             pending", replays UID MOVE and normalizes the name afterwards.
  // A per-folder in-memory name cache (uid -> parsed longname) keeps lookups
  // cheap; it is rebuilt whenever anything in that folder mutates.

  _names = new Map(); // enc -> Map(uid -> parsed longname)

  dirEnc(dirName) {
    return encodeDirName(dirName);
  }

  // the cur/ directory segments (listing; _curPath is for file names)
  _curDir(enc) {
    return this.ctx(enc, 'cur');
  }

  _curPath(enc, name) {
    return this.ctx(enc, 'cur', name);
  }

  async _digest(enc) {
    return folderDigest(enc);
  }

  _dirty(enc) {
    this._names.delete(enc);
  }

  // Fallback IMAP flags from the metadata cache for a uid (legacy migration
  // and body-less markers keep their known flags through renames).
  async _rowFlags(dirName, uid) {
    const index = await this.getIndex(dirName);
    const row = (index?.messages ?? []).find(m => Number(m.uid) === Number(uid));
    return row ? (row.flags ?? []).filter(f => typeof f === 'string') : [];
  }

  // uid -> parsed longname for one folder, from disk. Unparseable files
  // (legacy `<uid>.eml`, tombstone dot files) migrate in place on first
  // contact so every layout consumer sees canonical longnames only.
  async _nameIndex(enc) {
    const hit = this._names.get(enc);
    if (hit) {
      return hit;
    }
    const map = new Map();
    for (const {name} of await this.fs.listFiles(this._curDir(enc))) {
      const item = parseLongname(name);
      if (item) {
        map.set(item.uid, item);
      }
    }
    const legacy = new Map();
    for (const {name} of await this.fs.listFiles(this.ctx(enc))) {
      let m = name.match(/^(\d+)\.eml$/);
      if (m) {
        legacy.set(Number(m[1]), {name, tomb: false});
        continue;
      }
      m = name.match(/^\.(\d+)\.eml$/);
      if (m) {
        const uid = Number(m[1]);
        if (!legacy.has(uid)) {
          legacy.set(uid, {name, tomb: true});
        }
      }
    }
    if (legacy.size) {
      const dirName = decodeDirName(enc);
      const digest = await this._digest(enc);
      for (const [uid, meta] of legacy) {
        if (map.has(uid)) {
          await this.fs.deleteFile(this.ctx(enc, meta.name)); // duplicate: drop
          continue;
        }
        let flags = await this._rowFlags(dirName, uid);
        if (meta.tomb) {
          flags = [...flags.filter(f => f !== '\\Deleted'), '\\Deleted'];
        }
        const long = buildLongname({uid, base: newBase(), md5: digest, info: flags});
        const bytes = await this.fs.readFile(this.ctx(enc, meta.name));
        await this.fs.writeFile(this._curPath(enc, long), bytes ?? new Uint8Array(0));
        await this.fs.deleteFile(this.ctx(enc, meta.name));
        map.set(uid, parseLongname(long));
      }
    }
    this._names.set(enc, map);
    return map;
  }

  // All parsed mail-items of one folder from the disk truth (filenames).
  async listItems(dirName) {
    const map = await this._nameIndex(this.dirEnc(dirName));
    return [...map.values()];
  }

  // body-file info for one uid — {uid, md5, base, info} or null
  async bodyNameFor(dirName, uid) {
    return (await this._nameIndex(this.dirEnc(dirName))).get(Number(uid)) ?? null;
  }

  // Write a body: an existing item keeps its base/flags identity (name may
  // regenerate when the info part was missing), a new one gets a fresh
  // longname. `flags` (IMAP strings) override the info part when given.
  async putBody(dirName, uid, bytes, {flags = null} = {}) {
    const enc = this.dirEnc(dirName);
    const map = await this._nameIndex(enc);
    const digest = await this._digest(enc);
    const existing = map.get(Number(uid));
    if (existing) {
      const info = flags ?? existing.info ?? [];
      const fresh = buildLongname({uid, base: existing.base, md5: digest, info});
      if (fresh === existing.name) {
        return existing.name;
      }
      await this.fs.writeFile(this._curPath(enc, fresh), toU8(bytes));
      await this.fs.deleteFile(this._curPath(enc, existing.name));
      map.set(Number(uid), parseLongname(fresh));
      this._names.set(enc, map);
      return fresh;
    }
    const long = buildLongname({uid, base: newBase(), md5: digest, info: flags ?? []});
    await this.fs.writeFile(this._curPath(enc, long), toU8(bytes));
    map.set(Number(uid), parseLongname(long));
    this._names.set(enc, map);
    return long;
  }

  async getBody(dirName, uid) {
    const enc = this.dirEnc(dirName);
    const item = (await this._nameIndex(enc)).get(Number(uid));
    if (item) {
      return this.fs.readFile(this._curPath(enc, item.name));
    }
    return null;
  }

  // Delete any file the uid owns in this folder. The engine calls this once
  // the server listing confirmed an expunge, replacing the old tombstone
  // dot-file bookkeeping.
  async delBody(dirName, uid) {
    const enc = this.dirEnc(dirName);
    const map = await this._nameIndex(enc);
    const item = map.get(Number(uid));
    if (item) {
      await this.fs.deleteFile(this._curPath(enc, item.name));
      map.delete(Number(uid));
      this._names.set(enc, map);
    }
    // legacy safety: also delete any un-parseable duplicate on the folder root
    for (const {name} of await this.fs.listFiles(this.ctx(enc))) {
      if (new RegExp('^\\.?' + Number(uid) + '\\.eml$').test(name)) {
        await this.fs.deleteFile(this.ctx(enc, name));
      }
    }
  }

  // Rename one item's longname explicitly (no index change): engine-side
  // flag merges, post-move uid/FMD5 normalization, fresh-info backfill.
  // Returns the new name or null when the uid has no file.
  async renameItem(dirName, uid, {info = null, uid: newUid = null, md5 = null} = {}) {
    const enc = this.dirEnc(dirName);
    const map = await this._nameIndex(enc);
    const item = map.get(Number(uid));
    if (!item) {
      return null;
    }
    const fresh = buildLongname({
      uid: newUid ?? uid,
      base: item.base,
      md5: md5 ?? item.md5 ?? await this._digest(enc),
      info: info ?? item.info ?? [],
    });
    if (fresh === item.name && (newUid ?? uid) === uid) {
      return item.name;
    }
    const bytes = await this.fs.readFile(this._curPath(enc, item.name));
    await this.fs.writeFile(this._curPath(enc, fresh), bytes ?? new Uint8Array(0));
    await this.fs.deleteFile(this._curPath(enc, item.name));
    map.delete(Number(uid));
    map.set(Number(newUid ?? uid), parseLongname(fresh));
    this._names.set(enc, map);
    return fresh;
  }

  // Local flag mutation (client-side): rename the files with the new maildir
  // info AND mirror the IMAP flags into the index metadata cache (rows keep
  // the full server flag list — custom keywords stay there; unknown IMAP
  // flags simply do not change the filename). Under the folder lock so the
  // names and the cache always agree.
  async setLocalFlags(dirName, uids, addFlags, removeFlags) {
    const enc = this.dirEnc(dirName);
    const wanted = [...(Array.isArray(uids) ? uids : []).map(Number)];
    const add = (addFlags ?? []).map(String);
    const remove = (removeFlags ?? []).map(String);
    if (!wanted.length || (!add.length && !remove.length)) {
      return false;
    }
    let applied = false;
    await withLock(this.lockKey(enc), async () => {
      // update the index first (locked RMW inside the folder lock — the
      // _writeIndex variant avoids re-acquiring this same lock)
      const index = (await this.getIndex(dirName)) ?? emptyIndex(dirName);
      applyFlagDelta(index, wanted, add, remove);
      await this._writeIndex(dirName, index, enc);
      for (const uid of wanted) {
        let item = (await this._nameIndex(enc)).get(uid);
        if (!item) {
          // body-less uid: flags need a file to live in — write a zero-length
          // marker. The body sweep only deletes files whose uid is missing
          // from the index, so the marker survives.
          const starter = buildLongname({
            uid,
            base: newBase(),
            md5: await this._digest(enc),
            info: charsForFlags(await this._rowFlags(dirName, uid)),
          });
          await this.fs.writeFile(this._curPath(enc, starter), new Uint8Array(0));
          (await this._nameIndex(enc)).set(uid, parseLongname(starter));
          item = (await this._nameIndex(enc)).get(uid);
        }
        const cur = new Set(item.info ?? []);
        const flags = [...cur];
        for (const f of add) {
          if (!flags.includes(f)) {
            flags.push(f);
          }
        }
        for (const f of remove) {
          const i = flags.indexOf(f);
          if (i !== -1) {
            flags.splice(i, 1);
          }
        }
        const next = new Set(flags);
        if (next.size === cur.size && [...next].every(f => cur.has(f))) {
          continue; // nothing changed for this uid
        }
        await this.renameItem(dirName, uid, {info: flags});
        applied = true;
      }
    });
    return applied;
  }

  // Delete disappears locally: rows leave every view/count and each file
  // gains the T (trash) flag. The sync engine replays the purge server-side
  // and deletes the file for real once the server listing confirms; a
  // definitive rejection renames the T away (restoreLocal) with the metadata
  // recovered from the engine's lastseen journal.
  async removeLocal(dirName, uids) {
    const enc = this.dirEnc(dirName);
    const wanted = (Array.isArray(uids) ? uids : []).map(Number);
    let rows = [];
    await withLock(this.lockKey(enc), async () => {
      const index = (await this.getIndex(dirName)) ?? emptyIndex(dirName);
      const byUid = new Map((index.messages ?? []).map(m => [Number(m.uid), m]));
      for (const uid of wanted) {
        const row = byUid.get(uid);
        if (row) {
          rows.push({...row});
        }
      }
      if (rows.length) {
        removeMessages(index, wanted);
        const drop = new Set(wanted);
        index.threads = (index.threads ?? [])
          .map(group => group.filter(uid => !drop.has(Number(uid))))
          .filter(group => group.length);
        await this._writeIndex(dirName, index, enc);
      }
      for (const uid of wanted) {
        try {
          await this.renameItem(dirName, uid, {info: ['\\Deleted']});
        }
        catch {
          // a failed rename leaves the file untouched; the next mutation
          // (or the sync pass) retries the T marker
        }
      }
    });
    return rows;
  }

  // Local move (client-side): the FILE is renamed into the destination's
  // cur/ dir keeping its source FMD5 (the engine reads the folder mismatch
  // as a pending server move). Index metadata rows travel with the move;
  // source rows leave the view immediately.
  async moveLocal(from, target, uids) {
    const fromEnc = this.dirEnc(from);
    const targetEnc = this.dirEnc(target);
    if (!from || !target || from === target) {
      throw new Error('moveLocal: distinct source/target folders required');
    }
    // locks in a fixed order so two racing chores never interlock
    const keys = [fromEnc, targetEnc].sort();
    let rows = [];
    await withLock(this.lockKey(keys[0]), async () => {
      await withLock(this.lockKey(keys[1]), async () => {
        const srcMap = await this._nameIndex(fromEnc);
        const byUid = new Map((await this.getIndex(from))?.messages?.map(m => [Number(m.uid), m]) ?? []);
        for (const uid of (Array.isArray(uids) ? uids : []).map(Number)) {
          const row = byUid.get(uid);
          if (row && !rows.some(r => Number(r.uid) === uid)) {
            rows.push({...row});
          }
        }
        if (!rows.length) {
          return;
        }
        const moved = new Set(rows.map(r => Number(r.uid)));
        const srcIndex = await this.getIndex(from);
        if (srcIndex) {
          removeMessages(srcIndex, [...moved]);
          srcIndex.threads = (srcIndex.threads ?? [])
            .map(group => group.filter(uid => !moved.has(Number(uid))))
            .filter(group => group.length);
          await this._writeIndex(from, srcIndex, fromEnc);
        }
        const dstIndex = (await this.getIndex(target)) ?? emptyIndex(target);
        for (const row of rows) {
          upsertMessage(dstIndex, row);
        }
        dstIndex.threads = (dstIndex.threads ?? []).concat([rows.map(r => Number(r.uid))]);
        await this._writeIndex(target, dstIndex, targetEnc);
        const srcDigest = await this._digest(fromEnc);
        for (const row of rows) {
          const item = srcMap.get(Number(row.uid));
          const bytes = await this.fs.readFile(item
            ? this._curPath(fromEnc, item.name)
            : this.ctx(fromEnc, `${Number(row.uid)}.eml`));
          const long = item
            ? item.name // keep base/md5/info — the foreign FMD5 IS the signal
            : buildLongname({uid: row.uid, base: newBase(), md5: srcDigest, info: []});
          await this.fs.writeFile(this._curPath(targetEnc, long), bytes ?? new Uint8Array(0));
          if (item) {
            await this.fs.deleteFile(this._curPath(fromEnc, item.name));
            srcMap.delete(Number(row.uid));
          }
        }
        this._names.set(fromEnc, srcMap);
      });
    });
    this._dirty(fromEnc);
    this._dirty(targetEnc);
    return rows;
  }

  // ---- folders ----

  async removeFolder(dirName) {
    await this.fs.removeDir(this.ctx(encodeDirName(dirName)));
    await withLock(this.lockKey('_meta'), async () => {
      const meta = await this.getMeta();
      const enc = encodeDirName(dirName);
      if (meta.folders) {
        delete meta.folders[enc];
        await this.setMeta(meta);
      }
    });
  }

  async saveDirs(dirs) {
    await withLock(this.lockKey('_meta'), async () => {
      const meta = await this.getMeta();
      meta.dirs = (Array.isArray(dirs) ? dirs : []).map(d => ({
        name: String(d.name),
        delimiter: d.delimiter ?? null,
        attrs: Array.isArray(d.attrs) ? d.attrs.map(String) : [],
      }));
      await this.setMeta(meta);
    });
  }

  // Add one folder to the folder list: no-op when already present.
  // attributes/delimiter may be unknown at that point.
  async addFolder(name, {delimiter = null, attrs = []} = {}) {
    await withLock(this.lockKey('_meta'), async () => {
      const meta = await this.getMeta();
      const folders = (meta.folders = meta.folders ?? {});
      const enc = encodeDirName(name);
      if (!folders[enc]) {
        folders[enc] = emptySummary();
      }
      const dirs = Array.isArray(meta.dirs) ? meta.dirs : [];
      if (!dirs.some(d => d.name === name)) {
        dirs.push({name: String(name), delimiter, attrs: attrs.map(String)});
        meta.dirs = dirs;
      }
      await this.setMeta(meta);
    });
  }

  // ---- per-folder body limit (big-folder prompt) ----

  async _patchMeta(fn) {
    await withLock(this.lockKey('_meta'), async () => {
      const meta = await this.getMeta();
      fn(meta);
      await this.setMeta(meta);
    });
  }

  // Body-fetch spec for one folder ('all' | 200 | 50 | 20), stored under
  // meta.prefetch[<encoded folder>] by the client's big-folder prompt.
  // null when unset (the global option applies).
  async getPrefetch(dirName) {
    const meta = await this.getMeta();
    const v = meta.prefetch?.[encodeDirName(dirName)];
    return v == null ? null : v;
  }

  async setPrefetch(dirName, spec) {
    await this._patchMeta(meta => {
      meta.prefetch = meta.prefetch ?? {};
      if (spec == null) {
        delete meta.prefetch[encodeDirName(dirName)];
      }
      else {
        meta.prefetch[encodeDirName(dirName)] = spec;
      }
    });
  }

  // wipe the whole account (clear-all / account removal)
  async clear() {
    await this.fs.removeDir([this.accountId]);
  }

  // ---- mirror crypto migration ------------------------------------------------

  // Bulk rest-crypto migrate of every account file. Self-healing like the
  // account passwords' re-encryption: a file that already decrypts (or is
  // already plain) under the target rule is skipped, an undecryptable stale
  // entry is dropped (the mirror rebuilds it from the server), and each file
  // transforms under the same per-folder/outbox locks the regular writes use
  // so a racing sync/mutation cannot tear a file.
  //   {oldMaster, newMaster}  — rekey to a new master
  //   {oldMaster, newMaster: ''}  — master removed: decrypt everything
  //   {oldMaster: '', newMaster}  — master set on a plain mirror: encrypt
  async transformCrypto({oldMaster = '', newMaster = ''} = {}) {
    // one worker at a time on this account's tree
    await localLockFallback(this.lockKey('rekey'), async () => {
      const salt = await this.crypto.ensureSalt();
      const fromKey = oldMaster ? await this.crypto.keyWith(oldMaster, salt) : null;
      const toKey = newMaster ? await this.crypto.keyWith(newMaster, salt) : null;
      const ctxPaths = [];
      const addFolder = async enc => {
        ctxPaths.push([this.accountId, enc, '_index.json']);
        // bodies live in cur/ with unencrypted longnames (maildir format, see
        // store.mjs header); legacy files on the folder root migrate away on
        // the next read but still transform here too
        for (const {name} of await this.raw.listFiles([this.accountId, enc, 'cur'])) {
          if (parseLongname(name)) {
            ctxPaths.push([this.accountId, enc, 'cur', name]);
          }
        }
        for (const {name} of await this.raw.listFiles([this.accountId, enc])) {
          if (/^\.?\d+\.eml$/.test(name)) {
            ctxPaths.push([this.accountId, enc, name]);
          }
        }
      };

      // account meta first — folder names come from it; undecryptable meta
      // means the whole tree can no longer be read: wipe and rebuild.
      const metaPath = this.ctx('_meta.json');
      const rawMeta = await this.raw.readFile(metaPath);
      let folders = [];
      if (rawMeta) {
        let decoded = null;
        if (looksEncrypted(rawMeta)) {
          if (fromKey) {
            try {
              decoded = decodeJson(await decryptWith(fromKey, rawMeta));
            }
            catch {}
          }
        }
        else {
          decoded = decodeJson(rawMeta);
        }
        if (decoded && typeof decoded === 'object') {
          folders = Object.keys(decoded.folders ?? {});
          ctxPaths.push(metaPath);
        }
        else {
          await this.raw.deleteFile(metaPath); // lost key: rebuild
          this.log('crypto transform: undecryptable account meta — will rebuild');
        }
      }

      for (const enc of folders) {
        await addFolder(enc);
      }
      for (const {name} of await this.raw.listFiles([this.accountId, '_outbox'])) {
        if (name.endsWith('.json')) {
          ctxPaths.push([this.accountId, '_outbox', name]);
        }
      }

      for (const path of ctxPaths) {
        await withLock(this.lockKey(...path.slice(1)), async () => {
          const bytes = await this.raw.readFile(path);
          if (!bytes) {
            return;
          }
          let plain = bytes;
          if (looksEncrypted(bytes)) {
            // already correct for the target master? leave it untouched
            if (toKey) {
              try {
                await decryptWith(toKey, bytes);
                return;
              }
              catch {}
            }
            if (!fromKey) {
              await this.raw.deleteFile(path);
              this.log(`crypto transform: dropped undecryptable ${path.slice(1).join('/')}`);
              return;
            }
            try {
              plain = await decryptWith(fromKey, bytes);
            }
            catch {
              await this.raw.deleteFile(path);
              this.log(`crypto transform: dropped undecryptable ${path.slice(1).join('/')}`);
              return;
            }
          }
          // plain content: encrypt when a target master is set
          const next = toKey ? await encryptWith(toKey, plain) : plain;
          const alreadyTarget = toKey ? looksEncrypted(bytes) : !looksEncrypted(bytes);
          if (!alreadyTarget) {
            await this.raw.writeFile(path, next);
          }
        });
      }
      this.crypto.clearKeyCache();
    });
  }

  async lastSynced() {
    let latest = 0;
    for (const s of (await this.summarized()).values()) {
      latest = Math.max(latest, Number(s.lastSync) || 0);
    }
    return latest;
  }

  // ---- outbox (queued server operations) ----

  async _nextOutboxId() {
    if (!this._outboxSeq) {
      this._outboxSeq = Date.now();
    }
    this._outboxSeq++;
    return `${this._outboxSeq}-${Math.random().toString(36).slice(2, 8)}`;
  }

  async pushOp(op) {
    const id = await this._nextOutboxId();
    const entry = {...op, id, ts: Date.now()};
    await this.fs.writeFile(this.ctx('_outbox', `${id}.json`), encodeJson(entry));
    return entry;
  }

  async listOps() {
    const entries = await this.fs.listFiles(this.ctx('_outbox'));
    const out = [];
    for (const {name} of entries) {
      if (!name.endsWith('.json')) {
        continue;
      }
      const raw = await this.fs.readFile(this.ctx('_outbox', name));
      const op = raw ? decodeJson(raw) : null;
      if (!op || op.done) {
        continue;
      }
      out.push({...op, id: op.id || name.replace(/\.json$/, '')});
    }
    out.sort((a, b) => (Number(a.id) - Number(b.id)) || (a.ts - b.ts));
    return out;
  }

  async removeOps(ids) {
    const set = new Set(ids);
    for (const {name} of await this.fs.listFiles(this.ctx('_outbox'))) {
      if (!name.endsWith('.json')) {
        continue;
      }
      const id = name.replace(/\.json$/, '');
      if (set.has(id)) {
        await this.fs.deleteFile(this.ctx('_outbox', name));
      }
    }
  }

  // approximate size in bytes of the account mirror (bodies dominate)
  async usage() {
    if (typeof navigator?.storage?.estimate !== 'function' || this.backendKind !== 'opfs') {
      // memory fallback: sum the stored buffers
      let total = 0;
      for (const v of (this.raw.files?.values?.() ?? [])) {
        total += v.byteLength ?? 0;
      }
      return total;
    }
    try {
      const {usage, quota} = await navigator.storage.estimate();
      return {usage: usage ?? 0, quota: quota ?? 0};
    }
    catch {
      return {usage: 0, quota: 0};
    }
  }
}

// process-wide mirror cache (SW + page each keep one)
const mirrors = new Map();

export async function openMirror(accountId, opts = {}) {
  if (!accountId) {
    throw new Error('openMirror: accountId required');
  }
  if (mirrors.has(accountId)) {
    return mirrors.get(accountId);
  }
  const mirror = await MailDirMirror.open(accountId, opts);
  mirrors.set(accountId, mirror);
  return mirror;
}

export function dropMirror(accountId) {
  mirrors.delete(accountId);
}
