// maildir.mjs — the local Maildir store, built on the fs gateway
// (core/fs.mjs — the one module that touches the granted storage root; the
// facade arrives prepared by the host context, so a page and the offscreen
// share this code but each emits its own origin on every fs-event).
// Layout is flat: one directory per server
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
//          letters S=Seen R=Answered F=Flagged T=Deleted D=Draft; lowercase
//          a..e carry the colored-star IMAP keywords ($star-*); other IMAP
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

// ---- colored stars: Gmail-palette colors as IMAP keywords ------------------
// The plain yellow star is \Flagged alone (what every IMAP client sees);
// the other palette colors ride as server keywords, encoded in the filename
// info part as the lowercase letters a..e (uppercase stays S R F T D).
// A colored star always keeps \Flagged set; at most one color keyword lives
// on a message — the client enforces that exclusivity, the sync engine just
// diffs the keyword like any standard flag.
const STAR_KEYWORDS = new Map([
  ['$star-red', 'a'],
  ['$star-orange', 'b'],
  ['$star-green', 'c'],
  ['$star-blue', 'd'],
  ['$star-purple', 'e']
]);
const STAR_LETTERS = new Map([...STAR_KEYWORDS].map(([k, v]) => [v, k]));

/** every flag that round-trips through a maildir filename (flags + stars) */
const FLAG_TO_LETTER = new Map([...FLAG_LETTERS, ...STAR_KEYWORDS]);

const LETTER_RE = /^[a-zA-Z]$/;
const INFO_RE = /^(?<unique>[^,]+),U=(?<uid>\d+)(?:,FMD5=(?<fmd5>[0-9a-f]{32}))?(?:(?::|,I=)(?<info>2,(?<letters>[a-zA-Z]*)))?$/i;

export const KNOWN_FLAG_NAMES = [...FLAG_TO_LETTER.keys()];
export const STAR_COLOR_KEYWORDS = [...STAR_KEYWORDS.keys()];

export function flagsToLetters(flags = []) {
  const seen = new Set();
  for (const f of flags) {
    const letter = FLAG_TO_LETTER.get(f);
    if (letter) {
      seen.add(letter);
    }
  }
  return [...seen].sort().join('');
}

export function knownFlags(flags = []) {
  return (flags ?? []).filter(f => FLAG_TO_LETTER.has(f));
}

/** server flags that cannot be encoded in a filename (logged, ignored) */
export function unknownFlags(flags = []) {
  return (flags ?? []).filter(f => !FLAG_TO_LETTER.has(f));
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

/**
 * Maps a user-typed folder name onto the account's canonical spelling:
 * '/'-typed paths are translated onto the hierarchy delimiter (the
 * convention the options page normalizes on save — this is the run-time
 * defence for already-stored filters). The inverse is never applied: on
 * a '/'-delimiter server '.' is a legal character INSIDE folder names
 * ("Notes 1.2" must not become "Notes 1/2"). Whitespace around the whole
 * name is trimmed.
 * @param {string} folder server folder name, any '/'-typed spelling
 * @param {string} delimiter server hierarchy delimiter
 * @returns {string} the folder spelled in the account delimiter
 */
export function normalizeFolderPath(folder, delimiter = '/') {
  const name = String(folder ?? '').trim();
  return delimiter !== '/' ? name.replaceAll('/', delimiter) : name;
}

/**
 * Folder-name equality in the account's spelling: exact, or equal after
 * both sides went through normalizeFolderPath — "Root/Sub" and
 * "Root.Sub" are the same folder on a '.'-delimiter account.
 * @param {string} a first folder name
 * @param {string} b second folder name
 * @param {string} delimiter server hierarchy delimiter
 * @returns {boolean}
 */
export function sameFolder(a, b, delimiter = '/') {
  if (a === b) {
    return true;
  }
  return normalizeFolderPath(a, delimiter) === normalizeFolderPath(b, delimiter);
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
    else if (STAR_LETTERS.has(ch)) {
      keywords.push(STAR_LETTERS.get(ch));
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
//
// All paths are root-relative (core/fs.mjs convention): the "maildir"
// object below carries PATHS, not handles — {dir, tmp, new, cur} as
// strings inside the account dir.

/** the account dir path, created when asked; null when absent */
export async function accountDir(fs, slug, {create = false} = {}) {
  const path = String(slug ?? '');
  if (!path) {
    throw new Error('accountDir: the account slug is required');
  }
  if (create) {
    await fs.writer.mkdir(path);
    return path;
  }
  return (await fs.reader.exists(path)) ? path : null;
}

/** existing Maildir triple → its {dir,tmp,new,cur} paths or null */
export async function maildirOf(fs, dirPath) {
  const triple = {
    dir: dirPath,
    tmp: dirPath + '/tmp',
    new: dirPath + '/new',
    cur: dirPath + '/cur'
  };
  const found = await Promise.all([
    fs.reader.exists(triple.tmp),
    fs.reader.exists(triple.new),
    fs.reader.exists(triple.cur)
  ]);
  return found.every(Boolean) ? triple : null;
}

/** the {dir,tmp,new,cur} paths for a server folder; optionally created */
export async function folderDir(fs, accountPath, folder, {create = false, delimiter = '/'} = {}) {
  const dir = accountPath + '/' + dirNameFor(folder, delimiter);
  if (create) {
    await fs.writer.mkdir(dir);
    const triple = {
      dir,
      tmp: dir + '/tmp',
      new: dir + '/new',
      cur: dir + '/cur'
    };
    await fs.writer.mkdir(triple.tmp);
    await fs.writer.mkdir(triple.new);
    await fs.writer.mkdir(triple.cur);
    return triple;
  }
  return maildirOf(fs, dir);
}

export async function readUidValidity(fs, maildir) {
  try {
    const n = Number((await fs.reader.readText(maildir.dir + '/.uidvalidity')).trim());
    return Number.isInteger(n) && n > 0 ? n : null;
  }
  catch {
    return null;
  }
}

export async function writeUidValidity(fs, maildir, uidvalidity) {
  await fs.writer.write(maildir.dir + '/.uidvalidity', String(uidvalidity));
}

export async function clearUidValidity(fs, accountPath, folder, delimiter = '/') {
  try {
    await fs.writer.remove(accountPath + '/' + dirNameFor(folder, delimiter) + '/.uidvalidity');
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
export async function listLocal(fs, maildir, folder) {
  const out = new Map();
  const excluded = [];
  const stranded = [];
  let surrogate = 0;
  for (const which of ['new', 'cur', 'tmp']) {
    const dirPath = maildir[which];
    let names;
    try {
      names = await fs.reader.list(dirPath);
    }
    catch (e) {
      if (e?.name === 'NotFoundError' || e?.name === 'TypeMismatchError') {
        continue;
      }
      throw e;
    }
    for (const {name, kind} of names) {
      // tmp/ is scratch: no tracking, only visibility
      if (which === 'tmp') {
        if (kind !== 'file' || name.startsWith('.')) {
          continue;
        }
        stranded.push({
          fileName: name,
          folder,
          reason: 'in-tmp',
          path: dirPath + '/' + name,
          maildir,
          dir: which
        });
        continue;
      }
      const parsed = parseFilename(name);
      const entry = {
        fileName: name,
        path: dirPath + '/' + name,
        maildir,
        fmd5: parsed?.fmd5 ?? null,
        // star-color keywords are filename-encodable (a..e) — they join the
        // flags so every consumer (rows, threads, sync classifier) sees one
        // coherent flag list; foreign single-letter keywords stay in
        // `keywords` (snapshot-only, never diffed against files)
        flags: which === 'new'
          ? []
          : [...(parsed?.flags ?? []), ...(parsed?.keywords ?? []).filter(k => STAR_KEYWORDS.has(k))],
        keywords: parsed?.keywords ?? [],
        dir: which,
        folder
      };
      if (!parsed) {
        out.set(-1 - surrogate++, {
          ...entry,
          uid: null,
          unique: null,
          surrogate: true
        });
        continue;
      }
      if (out.has(parsed.uid)) {
        // never leave a file invisible: the winner stays the earlier
        // entry (surrogates use negative keys, so no clash possible).
        // The loser keeps the FULL parsed identity — any later op on
        // this stat (flag rename, relocation) must stay field-complete
        // instead of writing "undefined" parts into the filename.
        excluded.push({
          ...entry,
          uid: parsed.uid,
          unique: parsed.unique,
          reason: 'duplicate-uid'
        });
        continue;
      }
      out.set(parsed.uid, {
        ...entry,
        uid: parsed.uid,
        unique: parsed.unique
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
export async function writeMessage(fs, maildir, folder, uid, flags, raw) {
  const now = Date.now();
  const unique = uniquePart(now);
  const fmd5 = md5hex(folder);
  const letters = flagsToLetters(flags);
  const bare = !letters;
  const name = makeFilename(folder, uid, flags, {unique, fmd5});
  const tmpName = `${name}.tmp-${now}-${seq}`;
  const tmpPath = maildir.tmp + '/' + tmpName;
  try {
    // the scratch write is quiet: the ONE user-visible event is the move
    // into new//cur/ below (a tmp/ leftover never reaches the bus)
    await fs.writer.write(tmpPath, raw instanceof Blob ? raw : new Blob([raw]), {quiet: true});
  }
  catch (e) {
    try {
      await fs.writer.remove(tmpPath, {quiet: true});
    }
    catch {}
    throw e;
  }
  const finalName = bare ? name.replace(/,I=2,$/, '') : name;
  const destPath = (bare ? maildir.new : maildir.cur) + '/' + finalName;
  await fs.writer.move(tmpPath, destPath);
  return {fileName: finalName};
}

/**
 * Renames a message within one Maildir — how flag changes and a corrected
 * UID are recorded. cur/ messages stay in cur/ even at zero letters.
 * @param {object} fs an fs gateway facade
 * @param {object} maildir folderDir() paths of the CURRENT folder
 * @param {object} entry listLocal() entry ({path, fileName, uid, flags, dir,
 *   unique, folder, ...})
 * @param {{uid?: number, flags?: string[], unique?: string}} patch
 * @returns {Promise<string>} new filename
 */
export async function renameFile(fs, maildir, entry, patch) {
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
  if (name !== entry.fileName) {
    const destPath = (toCur ? maildir.cur : maildir.new) + '/' + name;
    await fs.writer.move(entry.path, destPath);
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
/**
 * Moves a message file into another folder's Maildir. By default the file
 * is stamped with the destination folder's FMD5 and the uid the server
 * assigned over there (server-directed relocation). With {keepFmd5: true}
 * the source file's own FMD5 survives the rename instead: the file then
 * sits in the destination as an interloper — offlineimap's marker for a
 * locally moved message that has not been confirmed server-side yet and
 * must replay as a server MOVE at the next sync.
 * @param {object} fs an fs gateway facade
 * @param {object} entry source listLocal() entry (carries its own path)
 * @param {object} dstMaildir folderDir() paths of the destination
 * @param {string} dstFolder destination server folder name
 * @param {number} uid the message's UID in the destination
 * @param {{keepFmd5?: boolean}} [options] keep the source FMD5 marker
 * @returns {Promise<string>} new filename
 */
export async function moveBetweenFolders(fs, entry, dstMaildir, dstFolder, uid, {keepFmd5 = false} = {}) {
  const letters = flagsToLetters(entry.flags);
  const fmd5 = keepFmd5 ? (entry.fmd5 ?? md5hex(dstFolder)) : md5hex(dstFolder);
  const name = letters
    ? `${entry.unique},U=${uid},FMD5=${fmd5},I=2,${letters}`
    : `${entry.unique},U=${uid},FMD5=${fmd5}`;
  const destPath = (letters ? dstMaildir.cur : dstMaildir.new) + '/' + name;
  await fs.writer.move(entry.path, destPath);
  return name;
}

/** deletes one message file; a missing file is not an error */
export async function removeMessage(fs, entry) {
  try {
    return await fs.writer.remove(entry.path);
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
export async function wipeFolder(fs, maildir) {
  let n = 0;
  for (const which of ['tmp', 'new', 'cur']) {
    const dirPath = maildir[which];
    let names;
    try {
      names = await fs.reader.list(dirPath);
    }
    catch {
      continue;
    }
    for (const {name, kind} of names) {
      if (kind !== 'file') {
        continue;
      }
      try {
        if (await fs.writer.remove(dirPath + '/' + name)) {
          n++;
        }
      }
      catch {}
    }
  }
  return n;
}

// ------------------------------------------------------------------ store

/**
 * The one object the sync engine talks to — account-rooted convenience over
 * the low-level helpers above. Everything runs through the fs gateway
 * facade the host context prepared (core/fs.mjs): `account` is the
 * account dir's ROOT-RELATIVE PATH (the gateway never hands out handles),
 * and every mutation emits an fs-event carrying the host's origin.
 */
const PREFS_FILE = '.sync-prefs.json';

export class MaildirStore {
  /**
   * @param {string} [opts.delimiter] the account's known server hierarchy
   *   delimiter (delimiterFor() — the shared resolver): the spelling every
   *   folder name read/write assumes until the engine's survey refreshes it
   *   per folder. Default '/' for never-synced accounts (flat servers).
   */
  constructor(fs, slug, {delimiter = '/'} = {}) {
    this.fs = fs;          // {reader, writer} — the prepare() facade
    this.slug = slug;
    this.account = slug;   // account dir path, root-relative (open() confirms it)
    this.delimiter = delimiter || '/';  // server delimiter; the engine refreshes per survey
  }

  async open() {
    const dir = await accountDir(this.fs, this.slug, {create: true});
    if (!dir) {
      throw new Error(`cannot open account directory "${this.slug}"`);
    }
    this.account = dir;
    return dir;
  }

  /** last-known-good server view; the sync engine's "K" */
  async loadState() {
    return loadSnapshot(this.fs, this.account);
  }

  /** complete rewrite of .sync-state.json (saveSnapshot stamps lastSyncAt) */
  async saveState(snapshot) {
    return saveSnapshot(this.fs, this.account, snapshot);
  }

  /**
   * Per-account sync preferences file (<slug>/.sync-prefs.json) — account-level
   * preferences across syncs. Corrupt/missing → {}.
   * @returns {Promise<object>}
   */
  async loadPrefs() {
    try {
      const prefs = JSON.parse(await this.fs.reader.readText(this.account + '/' + PREFS_FILE));
      return prefs && typeof prefs === 'object' ? prefs : {};
    }
    catch {
      return {};
    }
  }

  /** merges + persists preferences; called after every answered decision */
  async savePrefs(prefs) {
    await this.fs.writer.write(this.account + '/' + PREFS_FILE, JSON.stringify(prefs ?? {}, null, 1));
    return prefs;
  }

  /** {dir,tmp,new,cur} paths, created on demand */
  async folder(folder, {create = true} = {}) {
    return folderDir(this.fs, this.account, folder, {create, delimiter: this.delimiter});
  }

  /**
   * Local view of one folder, split by filename FMD5:
   *  - entries:     files that belong here
   *  - interlopers: files whose FMD5 names another folder (candidate moves)
   *  - untracked:   files with no FMD5 at all (some other tool's mail)
   *  - excluded:    kept on disk but untracked, with the reason
   * @returns {Promise<null | {entries: Map<number,Meta>, untracked: Meta[],
   *            interlopers: Meta[], excluded: Meta[]}>}
   */
  async listLocal(folder) {
    const maildir = await this.folder(folder, {create: false});
    if (!maildir) {
      return null;
    }
    const {messages, excluded, stranded} = await listLocal(this.fs, maildir, folder);
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
    for (const entry of await this.fs.reader.list(this.account)) {
      if (entry.kind !== 'directory') {
        continue;
      }
      if (await maildirOf(this.fs, this.account + '/' + entry.name)) {
        out.push(folderFor(entry.name, this.delimiter));
      }
    }
    return out;
  }

  /** delivers raw bytes; the message lands in new/ or cur/ by flags */
  async writeMessage(folder, uid, flags, raw) {
    const maildir = await this.folder(folder, {create: true});
    return writeMessage(this.fs, maildir, folder, uid, flags, raw);
  }

  /**
   * Flag rewrite / uid fix inside one folder.
   * @param {{uid?: number, flags?: string[]}} patch
   * @returns {Promise<string>} new filename
   */
  async renameMessage(folder, entry, patch = {}) {
    const maildir = entry.maildir ?? (await this.folder(folder, {create: true}));
    return renameFile(this.fs, maildir, entry, patch);
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
    return moveBetweenFolders(this.fs, entry, dst, dstFolder, uid ?? entry.uid, {keepFmd5});
  }

  /** removes one local file; missing files succeed silently */
  async removeMessage(entry) {
    return removeMessage(this.fs, entry);
  }

  /**
   * Removes one local Maildir entirely (the sync engine's `dropLocal` op):
   * message files, the .uidvalidity marker, tmp/new/cur and the dir itself.
   * `removeEntry(name, {recursive: true})` on the PARENT (the spec-backed
   * path) rides the gateway's remove(); a manual bottom-up sweep is the
   * fallback for builds lacking the recursive flag. A dir that is not
   * there is a successful no-op.
   * @param {string} folder server folder name
   * @returns {Promise<{removed: boolean, files: number}>} files = mail files
   *   the sweep actually deleted (informational, best effort)
   */
  async removeFolder(folder) {
    const dirPath = this.account + '/' + dirNameFor(folder, this.delimiter);
    if (!await this.fs.reader.exists(dirPath)) {
      return {removed: false, files: 0};
    }
    const maildir = await maildirOf(this.fs, dirPath);
    let files = 0;
    if (maildir) {
      files += await wipeFolder(this.fs, maildir);
    }
    try {
      if (await this.fs.writer.remove(dirPath, {recursive: true})) {
        return {removed: true, files};
      }
    }
    catch {}
    // fallback for builds without the recursive flag: strip the children
    // bottom-up, then try again — plain first, recursive as a last resort
    if (maildir) {
      files += await wipeFolder(this.fs, maildir); // second pass catches stragglers
    }
    const killTree = async path => {
      let names = [];
      try {
        names = await this.fs.reader.list(path);
      }
      catch {
        return;
      }
      for (const {name: child, kind} of names) {
        const childPath = path + '/' + child;
        if (kind === 'file') {
          try {
            if (await this.fs.writer.remove(childPath)) {
              files++;
            }
          }
          catch {}
        }
        else {
          await killTree(childPath);
          try {
            await this.fs.writer.remove(childPath);
          }
          catch {}
        }
      }
    };
    await killTree(dirPath);
    try {
      if (await this.fs.writer.remove(dirPath)) {
        return {removed: true, files};
      }
    }
    catch {}
    try {
      if (await this.fs.writer.remove(dirPath, {recursive: true})) {
        return {removed: true, files};
      }
    }
    catch {}
    return {removed: false, files};
  }

  /** removes all message files of one folder (resync) */
  async wipe(folder) {
    const maildir = await this.folder(folder, {create: true});
    return wipeFolder(this.fs, maildir);
  }

  /** byte size of a message file, null when gone */
  async fileSize(entry) {
    try {
      const st = await this.fs.reader.stat(entry.path);
      return st.exists && st.kind === 'file' ? st.size : null;
    }
    catch {
      return null;
    }
  }

  /** RFC822 bytes of one local message (also reads untracked user droppings) */
  async readFile(entry) {
    const file = await this.fs.reader.read(entry.path);
    return new Uint8Array(await file.arrayBuffer());
  }

  async readUidValidity(folder) {
    const maildir = await this.folder(folder, {create: false});
    return maildir ? readUidValidity(this.fs, maildir) : null;
  }

  async writeUidValidity(folder, uidvalidity) {
    const maildir = await this.folder(folder, {create: true});
    await writeUidValidity(this.fs, maildir, uidvalidity);
  }

  /** deletes the stale .uidvalidity marker (folder about to be re-created) */
  async clearUidValidity(folder, delimiter = this.delimiter) {
    await clearUidValidity(this.fs, this.account, folder, delimiter);
  }

  /**
   * Discards the pulled local copy of this account: every Maildir, the
   * .uidvalidity markers and the snapshot are gone — the whole account dir
   * itself is removed from the root. The gateway's recursive remove() is
   * the spec-backed way; a manual deep sweep is the fallback for builds
   * lacking the recursive flag. Does NOT re-create the dir — the next
   * sync's open() brings it back fresh.
   * @returns {Promise<number>} top-level entries visibly freed
   */
  async reset() {
    let cleaned = 0;
    try {
      if (await this.fs.writer.remove(this.slug, {recursive: true})) {
        this.account = null;
        return 1;
      }
    }
    catch {}
    const kill = async path => {
      try {
        return await this.fs.writer.remove(path, {recursive: true});
      }
      catch {}
      let names = [];
      try {
        names = await this.fs.reader.list(path);
      }
      catch {
        return false;
      }
      let ok = true;
      for (const {name, kind} of names) {
        const childPath = path + '/' + name;
        ok = (kind === 'file'
          ? await this.fs.writer.remove(childPath).catch(() => false)
          : await kill(childPath)) && ok;
      }
      if (!ok) {
        return false;
      }
      try {
        return await this.fs.writer.remove(path);
      }
      catch {
        return false;
      }
    };
    const accountPath = this.account ?? this.slug;
    try {
      for (const {name, kind} of await this.fs.reader.list(accountPath)) {
        if (kind === 'file'
          ? await this.fs.writer.remove(accountPath + '/' + name).catch(() => false)
          : await kill(accountPath + '/' + name)) {
          cleaned++;
        }
      }
    }
    catch {}
    try {
      if (await this.fs.writer.remove(this.slug, {recursive: true})) {
        this.account = null;
      }
    }
    catch {}
    return cleaned;
  }
}
