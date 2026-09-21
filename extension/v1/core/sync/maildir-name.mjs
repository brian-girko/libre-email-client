// Sync-mirror filename format: OfflineIMAP longname + Maildir info part.
// The filename carries everything the client and the sync engine need to
// know: sender-part Improved generic 1717273399_1.61324.MBP.lan time counter,
// uid, folder digest and the maildir "info" flags — the client learns
// read/flagged/deleted state from the filename alone:

//   <base>,U=<uid>,FMD5=<md5>[:2,<chars>].eml
//
//   base   "<seconds>_<n>.<rand>.lma" — unique per message write
//   U      IMAP UID (unique per folder+uidvalidity)
//   FMD5   digest of the encoded folder name (format fidelity with
//          OfflineIMAP: anything scanned in the wrong directory carries a
//          foreign FMD5 — the sync layer reads it as "moved in, server
//          effect pending")
//   :2,<chars> maildir info flags (D F R S T; no info = not normalized,
//     freshly-written/unparsed body — the next pass renames it canonical)
//     S=\Seen, R=\Answered, F=\Flagged, T=\Deleted (trash), D=\Draft
//
// The `.eml` suffix keeps the file type obvious to OS-level tools and to the
// plain-content crypto sweep. Non-IMAP flag knowledge (custom keywords) stays
// out of the name: index rows retain the full server flag list.

'use strict';

// Char ↔ IMAP flag maps. Sorting: fixed deterministic order in filenames.
const FLAG_CHAR = new Map([
  ['S', '\\Seen'],
  ['R', '\\Answered'],
  ['F', '\\Flagged'],
  ['T', '\\Deleted'], // trash marker: deleted locally, server purge pending
  ['D', '\\Draft'],
]);

const CHAR_FOR_FLAG = new Map([...FLAG_CHAR].map(([c, f]) => [f, c]));

export function flagsForChars(chars) {
  const out = [];
  for (const c of String(chars || '')) {
    const flag = FLAG_CHAR.get(c.toUpperCase());
    if (flag && !out.includes(flag)) {
      out.push(flag);
    }
  }
  return out;
}

export function charsForFlags(flags) {
  const chars = new Set();
  for (const flag of Array.isArray(flags) ? flags : []) {
    const c = CHAR_FOR_FLAG.get(String(flag));
    if (c) {
      chars.add(c);
    }
  }
  return [...chars].sort().join('');
}

// Digest of the folder name encoded into every message filename (FMD5).
// OfflineIMAP uses an MD5 of the mailbox name; any stable digest works —
// SHA-256, truncated to the same 32-hex-char slot. Cached per name.
const md5Cache = new Map();

export async function folderDigest(name) {
  const key = String(name ?? '');
  let hit = md5Cache.get(key);
  if (hit !== undefined) {
    return hit;
  }
  const bytes = new TextEncoder().encode(key);
  let hex = '';
  if (globalThis.crypto?.subtle) {
    const hash = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    hex = [...new Uint8Array(hash).slice(0, 16)].map(b => b.toString(16).padStart(2, '0')).join('');
  }
  else {
    // deterministic non-crypto fallback (tests): 32 hex chars of a xorshift mix
    let h1 = 0x9e3779b9, h2 = 0x85ebca6b;
    for (const b of bytes) {
      h1 = Math.imul(h1 ^ b, 0x85ebca6b) >>> 0;
      h2 = Math.imul(h2 + b, 0xc2b2ae35) >>> 0;
    }
    let out = (h1 ^ h2) >>> 0;
    hex = out.toString(16).padStart(8, '0').repeat(4);
  }
  md5Cache.set(key, hex);
  return hex;
}

const NAME_RE = /^(?<base>.+?),U=(?<uid>\d+),FMD5=(?<md5>[0-9a-f]+)(?::2,(?<info>[A-Za-z]*))?\.eml$/;

// Parse a maildir longname. Returns null for foreign/non-message files
// (_index.json, legacy leftovers).
export function parseLongname(name) {
  const m = NAME_RE.exec(String(name || ''));
  if (!m) {
    return null;
  }
  return {
    name: m[0],
    base: m.groups.base,
    uid: Number(m.groups.uid),
    md5: m.groups.md5,
    // flags as IMAP strings; null = no ":2," info (untouched new copy)
    info: m.groups.info === undefined ? null : flagsForChars(m.groups.info),
  };
}

export function buildLongname({base, uid, md5, info}) {
  // `info` accepts either a string of maildir chars ('SRF') or IMAP flag
  // strings (['\\Seen','\\Flagged']) — both normalize to sorted chars
  const chars = typeof info === 'string'
    ? [...new Set([...info.toUpperCase()].filter(c => FLAG_CHAR.has(c)))]
    : [...charsForFlags(info)].sort();
  return `${base},U=${Number(uid)},FMD5=${md5}:2,${chars.sort().join('')}.eml`;
}

// Fresh unique base: "<seconds>_<seq>.<rand>.lma" (OfflineIMAP-ish shape;
// pid is not exposed to pages, so a random segment carries uniqueness).
let _seq = 0;

export function newBase(now = Date.now()) {
  const sec = Math.floor(now / 1000);
  const n = (++_seq).toString(36).padStart(4, '0');
  const rand = Math.random().toString(36).slice(2, 7).padEnd(5, '0');
  return `${sec}_${n}.${rand}.lma`;
}

// uid-only quick matcher (body lookup by identity, no flag care)
export const uidFromName = name => {
  const p = parseLongname(name);
  return p && p.uid;
};
