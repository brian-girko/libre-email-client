// snapshot.mjs — ".sync-state.json": the last-known-good view of the server
// per account. This is the "K" the classifier diffs against; it stores, per
// folder, uidvalidity/uidnext and uid → {msgid, flags, size}. The msgid is
// the parsed Message-ID header, or a synthetic "sha256:<hex>" of the first
// 64KB of raw bytes when the header is missing/broken — either way it is a
// stable identity that survives a UID change caused by a server-side move.
//
// The file is rewritten ONLY at the end of a fully successful apply, so a
// crashed or interrupted run simply re-detects the same diffs next time.
//
// version 2: flat maildir layout ("Archive.Test" instead of the nested
// "Archive/Test" tree). A version-1 snapshot is treated as unreadable — the
// next sync starts from empty "K" and re-pulls; the stale nested directory
// tree of a pre-flat account is not served by the flat layout (use the
// Discard local copy button to free it).

'use strict';

import PostalMime from '/core/parser/postal-mime.mjs';

const STATE_FILE = '.sync-state.json';
const SNAPSHOT_VERSION = 2;

export function emptySnapshot() {
  return {
    version: SNAPSHOT_VERSION,
    lastSyncAt: null,
    folders: {} // folder name → {uidvalidity, uidnext, messages: {uid → entry}}
  };
}

export async function loadSnapshot(account) {
  try {
    const fh = await account.getFileHandle(STATE_FILE);
    const text = await (await fh.getFile()).text();
    const snap = JSON.parse(text);
    if (snap && snap.version === SNAPSHOT_VERSION && typeof snap.folders === 'object') {
      return snap;
    }
  }
  catch {}
  return emptySnapshot();
}

export async function saveSnapshot(account, snap) {
  snap.lastSyncAt = new Date().toISOString();
  snap.version = SNAPSHOT_VERSION;
  const fh = await account.getFileHandle(STATE_FILE, {create: true});
  const w = await fh.createWritable();
  await w.write(JSON.stringify(snap, null, 1));
  await w.close();
}

export function folderState(snap, folder) {
  return snap.folders[folder] ?? null;
}

export function setFolderState(snap, folder, {uidvalidity, uidnext}) {
  snap.folders[folder] = {
    uidvalidity: uidvalidity ?? null,
    uidnext: uidnext ?? null,
    messages: snap.folders[folder]?.messages ?? {}
  };
  return snap.folders[folder];
}

export function dropFolderState(snap, folder) {
  delete snap.folders[folder];
}

/** uid → entry map for a folder ({msgid, flags}) */
export function messagesOf(folderState) {
  return folderState?.messages ?? {};
}

/** msgid → uid index built from a folder's snapshot messages */
export function msgidIndex(folderState) {
  const idx = new Map();
  for (const [uid, entry] of Object.entries(messagesOf(folderState))) {
    if (entry?.msgid) {
      idx.set(entry.msgid, Number(uid));
    }
  }
  return idx;
}

// ------------------------------------------------------------ msgid helpers

/**
 * Stable identity of a raw RFC822 message, via the bundled raw mail parser.
 * Prefers the parsed Message-ID header; a synthetic "sha256:<hex>" over the
 * first 64KB only catches messages with a missing/broken header.
 * @param {Uint8Array} raw
 * @returns {Promise<string>}
 */
export async function msgidOf(raw) {
  try {
    const parsed = await PostalMime.parse(raw);
    if (parsed.messageId) {
      return parsed.messageId.trim();
    }
  }
  catch {}
  return 'sha256:' + await sha256hex(raw.subarray(0, Math.min(raw.length, 65536)));
}

const HEADER_LINE_RE = /^[A-Za-z0-9-]+:\s/;
const HEADER_SCAN_BYTES = 65536; // header stacks can exceed 8KB on real mail
const MBOX_SENTINEL_RE = /^From \S+( .*)?\n/;   // mbox wrapper line

/**
 * Is this raw bytes an email at all? Locally dropped files can be anything
 * (a .DS_Store lands straight in a Maildir's new/), so local-born mail is
 * validated BEFORE it is classified or uploaded. Deliberately cheap and
 * strict:
 *   1. structural: the payload must start with RFC822-style "Name: value"
 *      header lines and contain a blank line separating them from the body
 *      — binary junk and plain prose don't look like that. The separator is
 *      searched within the first 64KB (Google-routed mail routinely ships
 *      >8KB of Received/DKIM headers), capped so a headerless binary file
 *      can never force a full scan;
 *   2. parsed: postal-mime must parse it AND find a From address or a Date
 *      header — a file that only survives via msgidOf's sha256 fallback
 *      is not a message worth uploading.
 * @param {Uint8Array} raw
 * @returns {Promise<{ok: true, parsed: object} | {ok: false, reason: string}>}
 */
export async function validateMail(raw) {
  if (!raw?.length) {
    return {ok: false, reason: 'empty'};
  }
  const text = new TextDecoder('utf-8', {fatal: false})
    .decode(raw.subarray(0, Math.min(raw.length, HEADER_SCAN_BYTES)))
    .replace(/\r\n/g, '\n');
  let head = text;
  const mbox = MBOX_SENTINEL_RE.exec(head);
  if (mbox) {
    head = head.slice(mbox[0].length);
  }
  const blank = head.indexOf('\n\n');
  if (blank < 0 || !head.slice(0, blank).split('\n').some(l => HEADER_LINE_RE.test(l))) {
    return {ok: false, reason: 'no RFC822 header block at the start'};
  }
  let parsed;
  try {
    parsed = await PostalMime.parse(raw);
  }
  catch (e) {
    return {ok: false, reason: 'unparseable: ' + (e?.message || e)};
  }
  const hasDate = (parsed?.headers ?? []).some(h => (h.key ?? h.name ?? '') === 'date');
  if (!(parsed?.from?.address || hasDate)) {
    return {ok: false, reason: 'no From address and no Date header — not a message'};
  }
  return {ok: true, parsed};
}

async function sha256hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}
