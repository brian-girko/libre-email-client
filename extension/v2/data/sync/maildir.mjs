// maildir.mjs — the local Maildir store, built directly on the granted
// FileSystemDirectoryHandle. Layout is flat: one directory per server
// folder, directly inside the account dir, with the server's hierarchy
// delimiter spelled '.' (offlineimap's MaildirPlusPlus naming; chars that
// would collide are escaped):
//
//   <account>/INBOX/{tmp,new,cur} + INBOX/.uidvalidity
//   <account>/Work/...                           ← server "Work"
//   <account>/Archive.Test/...                   ← server "Archive/Test"
//
// dirNameFor()/folderFor() are the mapping: '%' → '%25', a literal '.'
// → '%2e', then the hierarchy delimiter joins segments as '.' — so
// "Work" vs "Work.Test" (even servers whose delimiter is '.') roundtrip
// without collisions.
//
// Message filenames carry all metadata (they are the source of truth — no
// JSON index of messages lives anywhere):
//
//   <ts>…<host>,U=<uid>,FMD5=<md5-of-folder>,I=2,<letters>
//
//   U      server UID
//   FMD5   md5 hex of the server folder name → a file whose FMD5 disagrees
//          with the folder it sits in is a *locally moved* message that has
//          not been confirmed server-side yet (offlineimap's own trick):
//          the client's folder-to-folder moves keep the SOURCE folder's
//          FMD5 until the sync engine replays them as one server MOVE;
//          server-directed relocations are stamped with the destination's
//   I=2,S  Maildir info (browser-safe spelling of the classic ":2,S");
//          letters S=Seen R=Answered F=Flagged T=Deleted D=Draft; other IMAP
//          keywords cannot be encoded and are ignored by the sync diffs
//
// Escaping per character: "%" maps to "%25" and a literal "." maps to
// "%2e"; the hierarchy delimiter becomes "." so the flat dir name stays
// a faithful roundtrip of the server folder name.

'use strict';

import {loadSnapshot, saveSnapshot} from './snapshot.mjs';

const FLAG_LETTERS = new Map([
  ['\\Seen', 'S'],
  ['\\Answered', 'R'],
  ['\\Flagged', 'F'],
  ['\\Deleted', 'T'],
  ['\\Draft', 'D']
]);
const LETTER_FLAGS = new Map([...FLAG_LETTERS].map(([k, v]) => [v, k]));
const LETTER_RE = /^[a-zA-Z]$/;
const INFO_RE = /^(?<unique>[^,]+),U=(?<uid>\d+)(?:,FMD5=(?<fmd5>[0-9a-f]{32}))?(?:(?::|,I=)(?<info>2,(?<letters>[a-zA-Z]*)))?$/i;

export const KNOWN_FLAG_NAMES = [...FLAG_LETTERS.keys()];

export function flagsToLetters(flags = []) {
  const seen = new Set();
  for (const f of flags) {
    const letter = FLAG_LETTERS.get(f);
    if (letter) {
      seen.add(letter);
    }
  }
  return [...seen].sort().join('');
}

export function knownFlags(flags = []) {
  return (flags ?? []).filter(f => FLAG_LETTERS.has(f));
}

/** server keywords that cannot be encoded in a filename (logged, ignored) */
export function unknownFlags(flags = []) {
  return (flags ?? []).filter(f => !FLAG_LETTERS.has(f));
}

/** order-independent flag equality over the representable subset */
export function sameFlags(a = [], b = []) {
  const x = [...knownFlags(a)].sort();
  const y = [...knownFlags(b)].sort();
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

// ------------------------------------------------------------------ md5

/** lowercase hex md5 of a string (RFC 1321, dependency-free) */
export function md5hex(str) {
  return toHex(md5(new TextEncoder().encode(String(str))));
}

function md5(bytes) {
  const S = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
  const K = new Int32Array(64);
  for (let i = 0; i < 64; i++) {
    K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296);
  }
  const len = bytes.length;
  const padded = new Uint8Array((((len + 8) >>> 6) + 1) * 64);
  padded.set(bytes);
  padded[len] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, (len * 8) >>> 0, true);
  view.setUint32(padded.length - 4, Math.floor(len / 536870912), true);

  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  const chunk = new Int32Array(16);
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) {
      chunk[i] = view.getInt32(off + i * 4, true);
    }
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let f, g;
      if (i < 16) {
        f = (B & C) | (~B & D);
        g = i;
      }
      else if (i < 32) {
        f = (D & B) | (~D & C);
        g = (5 * i + 1) % 16;
      }
      else if (i < 48) {
        f = B ^ C ^ D;
        g = (3 * i + 5) % 16;
      }
      else {
        f = C ^ (B | ~D);
        g = (7 * i) % 16;
      }
      f = (f + A + K[i] + chunk[g]) | 0;
      A = D;
      D = C;
      C = B;
      B = (B + ((f << S[i]) | (f >>> (32 - S[i])))) | 0;
    }
    a0 = (a0 + A) | 0;
    b0 = (b0 + B) | 0;
    c0 = (c0 + C) | 0;
    d0 = (d0 + D) | 0;
  }
  const out = new Uint8Array(16);
  const outView = new DataView(out.buffer);
  outView.setInt32(0, a0, true);
  outView.setInt32(4, b0, true);
  outView.setInt32(8, c0, true);
  outView.setInt32(12, d0, true);
  return out;
}

function toHex(bytes) {
  return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
}

// ------------------------------------------------------------------ names

/** leaves out any char that would break the flat-name roundtrip */
function escapePart(part) {
  return part
    .replaceAll('%', '%25')
    .replaceAll('.', '%2e');
}

function unescapePart(part) {
  return part
    .replaceAll('%2e', '.')
    .replaceAll('%25', '%');
}

/**
 * "Archive/Test" → "Archive.Test" (flat, one directory level per folder)
 * @param {string} folder server folder name, hierarchy spelled in `delimiter`
 * @param {string} delimiter server hierarchy delimiter
 */
export function dirNameFor(folder, delimiter = '/') {
  return folder
    .split(delimiter)
    .map(escapePart)
    .join('.');
}

/** "Archive.Test" → "Archive/Test" (flat name back to the server name) */
export function folderFor(dirName, delimiter = '/') {
  return dirName
    .split('.')
    .map(unescapePart)
    .join(delimiter);
}

let seq = 0;

/** "<ts>.M<msec>P<pid>Q<seq>.<host>" — the unique part of a maildir name */
export function uniquePart(now = Date.now()) {
  seq++;
  const secs = Math.floor(now / 1000);
  const host = 'sync';
  return `${secs}.M${now % 1000}P${(globalThis.self?.process?.pid ?? globalThis.crypto?.randomUUID?.().slice(0, 4) ?? 0)}Q${seq}.${host}`;
}

/**
 * Builds one offlineimap-style filename. The Maildir info section uses the
 * browser-safe ",I=2,<letters>" spelling instead of the classic ":2,<letters>"
 * (the FS Access API rejects ':' in filenames); parseFilename() still reads
 * the classic form so already-pulled files keep working.
 * @param {string} folder server folder name (source of FMD5 by default)
 * @param {number} uid
 * @param {string[]} flags
 * @param {{unique?: string, now?: number, fmd5?: string}} [extra]
 */
export function makeFilename(folder, uid, flags = [], extra = {}) {
  const unique = extra.unique ?? uniquePart(extra.now);
  const fmd5 = extra.fmd5 ?? md5hex(folder);
  const letters = flagsToLetters(flags);
  const info = letters ? `,I=2,${letters}` : '';
  return `${unique},U=${uid},FMD5=${fmd5}${info}`;
}

/**
 * Parses an offlineimap-style filename.
 * @returns {{unique:string, uid:number, fmd5:string|null, flags:string[],
 *            keywords:string[], info:string} | null}
 */
export function parseFilename(name) {
  const m = INFO_RE.exec(name);
  if (!m) {
    return null;
  }
  const flags = [];
  const keywords = [];
  for (const ch of m.groups.letters ?? '') {
    if (LETTER_FLAGS.has(ch)) {
      flags.push(LETTER_FLAGS.get(ch));
    }
    else if (LETTER_RE.test(ch)) {
      keywords.push(ch);
    }
  }
  return {
    unique: m.groups.unique,
    uid: Number(m.groups.uid),
    fmd5: m.groups.fmd5 ?? null,
    flags,
    keywords,
    info: m.groups.info ?? null
  };
}

// ------------------------------------------------------------------ dirs

async function getDir(parent, name, create) {
  try {
    return await parent.getDirectoryHandle(name, {create: !!create});
  }
  catch (e) {
    if (e?.name === 'NotFoundError' || e?.name === 'TypeMismatchError') {
      return null;
    }
    throw e;
  }
}

export async function accountDir(root, slug, {create = false} = {}) {
  return getDir(root, slug, create);
}

/** existing directory handle → its {dir,tmp,new,cur} or null */
export async function maildirOf(dir) {
  const tmp = await getDir(dir, 'tmp', false);
  const nw = await getDir(dir, 'new', false);
  const cur = await getDir(dir, 'cur', false);
  return tmp && nw && cur ? {dir, tmp, new: nw, cur} : null;
}

/** walks a flat dir name (no nesting — one getDirectoryHandle call) */
async function dirAt(account, name, create) {
  try {
    return await account.getDirectoryHandle(name, {create: !!create});
  }
  catch (e) {
    if (e?.name === 'NotFoundError' || e?.name === 'TypeMismatchError') {
      return null;
    }
    throw e;
  }
}

/** the {dir,tmp,new,cur} handles for a server folder; optionally created */
export async function folderDir(account, folder, {create = false, delimiter = '/'} = {}) {
  const dir = await dirAt(account, dirNameFor(folder, delimiter), create);
  if (!dir && !create) {
    return null;
  }
  const tmp = await getDir(dir, 'tmp', create);
  const nw = await getDir(dir, 'new', create);
  const cur = await getDir(dir, 'cur', create);
  return tmp && nw && cur ? {dir, tmp, new: nw, cur} : null;
}

export async function readUidValidity(maildir) {
  try {
    const fh = await maildir.dir.getFileHandle('.uidvalidity');
    const text = await (await fh.getFile()).text();
    const n = Number(text.trim());
    return Number.isInteger(n) && n > 0 ? n : null;
  }
  catch {
    return null;
  }
}

export async function writeUidValidity(maildir, uidvalidity) {
  const fh = await maildir.dir.getFileHandle('.uidvalidity', {create: true});
  const w = await fh.createWritable();
  await w.write(String(uidvalidity));
  await w.close();
}

export async function clearUidValidity(account, folder, delimiter = '/') {
  try {
    const dir = await dirAt(account, dirNameFor(folder, delimiter), false);
    if (dir) {
      await (await dir.getFileHandle('.uidvalidity')).remove();
    }
  }
  catch {}
}

/**
/**
 * Scans cur/ + new/ + tmp/, one entry per parseable message file PLUS every
 * other regular file (a user-dropped "1.eml") collected under fmd5 = null.
 * The store's listLocal() then routes those into `untracked` so the sync
 * engine can pick them up (duplicate → drop, otherwise pushed via APPEND).
 * A second file claiming a UID that a previous file already occupies is
 * kept on disk but excluded from tracking; it surfaces in the caller's
 * `excluded` list so the sync engine can log the reason. tmp/ is scratch
 * space by maildir convention and never served as live mail — files found
 * there are returned in `stranded` so nothing the scan sees can stay
 * invisible in the logs.
 * @param {object} maildir from folderDir()
 * @param {string} folder folder name stamped onto entries
 * @returns {Promise<{messages: Map<number|null, Meta>, excluded: object[],
 *   stranded: object[]}>}
 *   messages: uid (or null for surrogates) → entry; excluded: kept-but-
 *   untracked files with the reason (`duplicate-uid`); stranded: files
 *   seen in tmp/ only
 */
export async function listLocal(maildir, folder) {
  const out = new Map();
  const excluded = [];
  const stranded = [];
  let surrogate = 0;
  for (const dirEntry of [['new', maildir.new], ['cur', maildir.cur], ['tmp', maildir.tmp]]) {
    const which = dirEntry[0];
    const dir = dirEntry[1];
    // tmp/ is scratch: no tracking, only visibility
    if (which === 'tmp') {
      for await (const [name, fh] of dir.entries()) {
        if (fh.kind !== 'file' || name.startsWith('.')) {
          continue;
        }
        stranded.push({
          fileName: name,
          folder,
          reason: 'in-tmp',
          file: fh,
          maildir,
          dir: which
        });
      }
      continue;
    }
    for await (const [name, fh] of dir.entries()) {
      const parsed = parseFilename(name);
      if (!parsed) {
        out.set(-1 - surrogate++, {
          fileName: name,
          file: fh,
          maildir,
          uid: null,
          fmd5: null,
          flags: [],
          keywords: [],
          dir: which,
          unique: null,
          folder,
          surrogate: true
        });
        continue;
      }
      if (out.has(parsed.uid)) {
        // never leave a file invisible: the winner stays the earlier
        // entry (surrogates use negative keys, so no clash possible)
        excluded.push({
          fileName: name,
          uid: parsed.uid,
          folder,
          reason: 'duplicate-uid',
          file: fh,
          maildir,
          dir: which
        });
        continue;
      }
      out.set(parsed.uid, {
        fileName: name,
        file: fh,
        maildir,
        uid: parsed.uid,
        fmd5: parsed.fmd5,
        flags: which === 'new' ? [] : parsed.flags,
        keywords: parsed.keywords,
        dir: which,
        unique: parsed.unique,
        folder
      });
    }
  }
  return {messages: out, excluded, stranded};
}

/**
 * Writes a message atomically: bytes land in tmp/, the finished file moves
 * into new/ (no flags) or cur/ (with flags).
 * @param {object} maildir from folderDir(create:true)
 * @param {string} folder server folder name
 * @param {number} uid
 * @param {string[]} flags
 * @param {Uint8Array|Blob} raw RFC822 bytes
 * @returns {Promise<{fileName:string}>}
 */
export async function writeMessage(maildir, folder, uid, flags, raw) {
  const now = Date.now();
  const unique = uniquePart(now);
  const fmd5 = md5hex(folder);
  const letters = flagsToLetters(flags);
  const bare = !letters;
  const name = makeFilename(folder, uid, flags, {unique, fmd5});
  const tmpName = `${name}.tmp-${now}-${seq}`;
  const fh = await maildir.tmp.getFileHandle(tmpName, {create: true});
  const w = await fh.createWritable();
  try {
    await w.write(raw instanceof Blob ? raw : new Blob([raw]));
    await w.close();
  }
  catch (e) {
    try {
      await fh.remove();
    }
    catch {}
    throw e;
  }
  const finalName = bare ? name.replace(/,I=2,$/, '') : name;
  const dest = bare ? maildir.new : maildir.cur;
  await fh.move(dest, finalName);
  return {fileName: finalName};
}

/**
 * Renames a message within one Maildir — how flag changes and a corrected
 * UID are recorded. cur/ messages stay in cur/ even at zero letters.
 * @param {FileSystemFileHandle} file
 * @param {object} entry listLocal() entry ({file, fileName, uid, flags, dir, unique, folder})
 * @param {{uid?: number, flags?: string[], unique?: string}} patch
 * @returns {Promise<string>} new filename
 */
export async function renameFile(file, entry, patch, maildir) {
  const flags = patch.flags ?? entry.flags;
  const uid = patch.uid ?? entry.uid;
  const unique = patch.unique ?? entry.unique;
  // keep the filename's own FMD5: recomputing from entry.folder would
  // erase a pending-move marker on an interloper (its `folder` field is
  // the folder it was FOUND in, not the one the filename points to)
  const fmd5 = entry.fmd5 ?? md5hex(entry.folder);
  const toCur = flags.length > 0 || entry.dir === 'cur';
  const name = toCur
    ? `${unique},U=${uid},FMD5=${fmd5},I=2,${flagsToLetters(flags)}`
    : `${unique},U=${uid},FMD5=${fmd5}`;
  const destDir = toCur ? maildir.cur : maildir.new;
  if (name !== entry.fileName) {
    await file.move(destDir, name);
  }
  return name;
}

/**
 * Moves a message file into another folder's Maildir. By default the file
 * is stamped with the destination folder's FMD5 and the uid the server
 * assigned over there (server-directed relocation). With {keepFmd5: true}
 * the source file's own FMD5 survives the rename instead: the file then
 * sits in the destination as an interloper — offlineimap's marker for a
 * locally moved message that has not been confirmed server-side yet and
 * must replay as a server MOVE at the next sync.
 * @param {FileSystemFileHandle} file
 * @param {object} entry source listLocal() entry
 * @param {object} dstMaildir folderDir() of the destination (create:true)
 * @param {string} dstFolder destination server folder name
 * @param {number} uid the message's UID in the destination
 * @param {{keepFmd5?: boolean}} [options] keep the source FMD5 marker
 * @returns {Promise<string>} new filename
 */
export async function moveBetweenFolders(file, entry, dstMaildir, dstFolder, uid, {keepFmd5 = false} = {}) {
  const letters = flagsToLetters(entry.flags);
  const fmd5 = keepFmd5 ? (entry.fmd5 ?? md5hex(dstFolder)) : md5hex(dstFolder);
  const name = letters
    ? `${entry.unique},U=${uid},FMD5=${fmd5},I=2,${letters}`
    : `${entry.unique},U=${uid},FMD5=${fmd5}`;
  const dest = letters ? dstMaildir.cur : dstMaildir.new;
  await file.move(dest, name);
  return name;
}

/** deletes one message file; a missing file is not an error */
export async function removeMessage(file) {
  try {
    await file.remove();
    return true;
  }
  catch {
    return false;
  }
}

/**
 * Deletes every message file of a Maildir (resync). The folder itself and
 * the .uidvalidity file survive; callers decide whether that marker stays.
 * @returns {Promise<number>} files removed
 */
export async function wipeFolder(maildir) {
  let n = 0;
  for (const dir of [maildir.tmp, maildir.new, maildir.cur]) {
    for await (const [, fh] of dir.entries()) {
      if (fh.kind === 'file') {
        if (await removeMessage(fh)) {
          n++;
        }
      }
    }
  }
  return n;
}

// ------------------------------------------------------------------ store

/**
 * The one object the sync engine talks to — account-rooted convenience over
 * the low-level helpers above.
 */
const PREFS_FILE = '.sync-prefs.json';

/**
 * The one object the sync engine talks to — account-rooted convenience over
 * the low-level helpers above.
 */
export class MaildirStore {
  constructor(root, slug) {
    this.root = root;
    this.slug = slug;
    this.account = null;
    this.delimiter = '/';   // server delimiter; the engine refreshes per survey
  }

  async open() {
    this.account = await accountDir(this.root, this.slug, {create: true});
    if (!this.account) {
      throw new Error(`cannot open account directory "${this.slug}"`);
    }
    return this.account;
  }

  /** last-known-good server view; the sync engine's "K" */
  async loadState() {
    return loadSnapshot(this.account);
  }

  /** complete rewrite of .sync-state.json (saveSnapshot stamps lastSyncAt) */
  async saveState(snapshot) {
    return saveSnapshot(this.account, snapshot);
  }

  /**
   * Per-account sync preferences file (<slug>/.sync-prefs.json) — account-level
   * preferences across syncs. Corrupt/missing → {}.
   * @returns {Promise<object>}
   */
  async loadPrefs() {
    try {
      const fh = await this.account.getFileHandle(PREFS_FILE);
      const prefs = JSON.parse(await (await fh.getFile()).text());
      return prefs && typeof prefs === 'object' ? prefs : {};
    }
    catch {
      return {};
    }
  }

  /** merges + persists preferences; called after every answered decision */
  async savePrefs(prefs) {
    const fh = await this.account.getFileHandle(PREFS_FILE, {create: true});
    const w = await fh.createWritable();
    await w.write(JSON.stringify(prefs ?? {}, null, 1));
    await w.close();
    return prefs;
  }

  /** {dir,tmp,new,cur} handles, created on demand */
  async folder(folder, {create = true} = {}) {
    return folderDir(this.account, folder, {create, delimiter: this.delimiter});
  }

  /**
   * Local view of one folder, split by filename FMD5:
   *  - entries:     files that belong here
   *  - interlopers: files whose FMD5 names another folder (candidate moves)
   *  - untracked:   files with no FMD5 at all (some other tool's mail)
   *  - excluded:    kept on disk but untracked, with the reason
   * @returns {null | {entries: Map<number,Meta>, untracked: Meta[],
   *            interlopers: Meta[], excluded: Meta[]}}
   */
  async listLocal(folder) {
    const maildir = await this.folder(folder, {create: false});
    if (!maildir) {
      return null;
    }
    const {messages, excluded, stranded} = await listLocal(maildir, folder);
    const own = md5hex(folder);
    const entries = new Map();
    const untracked = [];
    const interlopers = [];
    for (const [uid, entry] of messages) {
      if (entry.fmd5 === own) {
        entries.set(uid, entry);
      }
      else if (entry.fmd5 == null) {
        untracked.push(entry);
      }
      else {
        interlopers.push(entry);
      }
    }
    return {entries, untracked, interlopers, excluded, stranded};
  }

  /**
   * Every local Maildir, as server folder names. Flat layout: each Maildir
   * is a directory directly inside the account dir.
   * @returns {Promise<string[]>}
   */
  async listFolders() {
    const out = [];
    for await (const [name, handle] of this.account.entries()) {
      if (handle.kind === 'directory' && (await maildirOf(handle))) {
        out.push(folderFor(name, this.delimiter));
      }
    }
    return out;
  }

  /** delivers raw bytes; the message lands in new/ or cur/ by flags */
  async writeMessage(folder, uid, flags, raw) {
    const maildir = await this.folder(folder, {create: true});
    return writeMessage(maildir, folder, uid, flags, raw);
  }

  /**
   * Flag rewrite / uid fix inside one folder.
   * @param {{uid?: number, flags?: string[]}} patch
   * @returns {Promise<string>} new filename
   */
  async renameMessage(folder, entry, patch = {}) {
    const maildir = entry.maildir ?? (await this.folder(folder, {create: true}));
    return renameFile(entry.file, entry, patch, maildir);
  }

  /**
   * Moves a message between folders. Default (destination FMD5) is for
   * server-directed relocations; the client's local moves pass
   * {keepFmd5: true} to keep the source folder's marker so the sync
   * engine classifies the file as a pending server-side move.
   * @param {{keepFmd5?: boolean}} [options]
   * @returns {Promise<string>} new filename
   */
  async moveMessage(srcFolder, entry, dstFolder, uid, {keepFmd5 = false} = {}) {
    const dst = await this.folder(dstFolder, {create: true});
    return moveBetweenFolders(entry.file, entry, dst, dstFolder, uid ?? entry.uid, {keepFmd5});
  }

  /** removes one local file; missing files succeed silently */
  async removeMessage(entry) {
    return removeMessage(entry.file);
  }

  /**
   * Removes one local Maildir entirely (the sync engine's `dropLocal` op):
   * message files, the .uidvalidity marker, tmp/new/cur and the dir itself.
   * `removeEntry(name, {recursive: true})` on the PARENT (the account dir)
   * is the spec-backed path; builds lacking the recursive flag fall back to
   * a manual sweep. A dir that is not there is a successful no-op.
   * @param {string} folder server folder name
   * @returns {Promise<{removed: boolean, files: number}>} files = mail files
   *   the sweep actually deleted (informational, best effort)
   */
  async removeFolder(folder) {
    const name = dirNameFor(folder, this.delimiter);
    let dir = null;
    try {
      dir = await dirAt(this.account, name, false);
    }
    catch (e) {
      if (e?.name === 'NotFoundError' || e?.name === 'TypeMismatchError') {
        return {removed: false, files: 0};
      }
      throw e;
    }
    if (!dir) {
      return {removed: false, files: 0};
    }
    const maildir = await maildirOf(dir);
    let files = 0;
    if (maildir) {
      files += await wipeFolder(maildir);
    }
    try {
      await this.account.removeEntry(name, {recursive: true});
      return {removed: true, files};
    }
    catch {}
    // fallback for builds without the recursive flag: strip the children
    // bottom-up, then try again non-recursively
    if (maildir) {
      files += await wipeFolder(maildir); // second pass catches stragglers
      for (const sub of [maildir.tmp, maildir.new, maildir.cur]) {
        for await (const [childName, child] of sub.entries()) {
          if (child.kind === 'file') {
            try {
              await child.remove();
            }
            catch {}
          }
          else {
            try {
              await sub.removeEntry(childName, {recursive: true});
            }
            catch {}
          }
        }
        try {
          await dir.removeEntry(sub === maildir.tmp ? 'tmp' : sub === maildir.new ? 'new' : 'cur');
        }
        catch {}
      }
    }
    for await (const [childName, child] of dir.entries()) {
      if (child.kind === 'file') {
        try {
          await child.remove();
          files++;
        }
        catch {}
      }
      else {
        try {
          await dir.removeEntry(childName, {recursive: true});
        }
        catch {}
      }
    }
    try {
      await this.account.removeEntry(name);
      return {removed: true, files};
    }
    catch {}
    try {
      await this.account.removeEntry(name, {recursive: true});
      return {removed: true, files};
    }
    catch {}
    return {removed: false, files};
  }

  /** removes all message files of one folder (resync) */
  async wipe(folder) {
    const maildir = await this.folder(folder, {create: true});
    return wipeFolder(maildir);
  }

  /** byte size of a message file, null when gone */
  async fileSize(entry) {
    try {
      return (await entry.file.getFile()).size;
    }
    catch {
      return null;
    }
  }

  /** RFC822 bytes of one local message (also reads untracked user droppings) */
  async readFile(entry) {
    const file = await entry.file.getFile();
    return new Uint8Array(await file.arrayBuffer());
  }

  async readUidValidity(folder) {
    const maildir = await this.folder(folder, {create: false});
    return maildir ? readUidValidity(maildir) : null;
  }

  async writeUidValidity(folder, uidvalidity) {
    const maildir = await this.folder(folder, {create: true});
    await writeUidValidity(maildir, uidvalidity);
  }

  /** deletes the stale .uidvalidity marker (folder about to be re-created) */
  async clearUidValidity(folder, delimiter = this.delimiter) {
    await clearUidValidity(this.account, folder, delimiter);
  }

  /**
   * Discards the pulled local copy of this account: every Maildir, the
   * .uidvalidity markers and the snapshot are gone — the whole account dir
   * itself is removed from the root. Uses removeEntry({recursive}) on the
   * PARENT handle (the spec-backed way); a manual deep sweep is the fallback
   * for builds lacking the recursive flag. Does NOT re-create the dir — the
   * next sync's open() brings it back fresh.
   * @returns {Promise<number>} top-level entries visibly freed
   */
  async reset() {
    let cleaned = 0;
    try {
      await this.root.removeEntry(this.slug, {recursive: true});
      this.account = null;
      return cleaned + 1;
    }
    catch {}
    const kill = async (parent, name, handle, recursive) => {
      try {
        await parent.removeEntry(name, {recursive: !!recursive});
        return true;
      }
      catch {}
      if (handle.kind === 'directory') {
        for await (const [childName, child] of handle.entries()) {
          await kill(handle, childName, child, true);
        }
        try {
          await parent.removeEntry(name, {recursive: true});
          return true;
        }
        catch {}
        try {
          await parent.removeEntry(name);
          return true;
        }
        catch {}
      }
      else {
        try {
          await handle.remove();
          return true;
        }
        catch {}
      }
      return false;
    };
    for await (const [name, handle] of this.account.entries()) {
      if (await kill(this.account, name, handle, true)) {
        cleaned++;
      }
    }
    try {
      await this.root.removeEntry(this.slug, {recursive: true});
      this.account = null;
    }
    catch {}
    return cleaned;
  }
}
