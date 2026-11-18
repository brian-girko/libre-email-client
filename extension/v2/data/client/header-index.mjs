'use strict';

// header-index.mjs — persistent per-folder header cache for the local client.
//
// Every row's subject/from/date/threading headers were re-parsed from the
// message file on each folder read (capped — beyond the cap rows rendered
// without metadata). This module replaces that with a sidecar index next to
// the existing .uidvalidity file:
//
//   <account>/<folder>/.headers.json
//   {version, uidvalidity, messages: {uid: [date, subject, from,
//                                           messageId, references, inReplyTo]}}
//
// Dot-files at the folder root are invisible to the sync engine: the
// maildir walkers only scan cur/new/tmp and listFolders() only accepts
// directories with that triple, exactly like .uidvalidity. The sync engine's
// resync wipe (maildir.wipeFolder) removes the file alongside .uidvalidity,
// so re-pulled folders re-index from scratch.
//
// Per folder read:
//   - a valid index (same uidvalidity) serves known uids without a single
//     message-file read;
//   - unknown uids parse their header slice once (bounded concurrency) and
//     join the index; the file is rewritten only when something changed;
//   - with {prune: true} (FULL-folder reads only — listThreads, the delta
//     fresh sheet, search's per-folder sweep) uids no longer on disk are
//     dropped. Subset reads (listFiles pages/ranges, the delta's fresh
//     arrivals) must NEVER prune: their rows are a slice of the folder, and
//     pruning to them would truncate the index;
//   - flags stay OUT — the maildir filename remains the flag truth;
//   - a message's headers cannot change under one uid (the same assumption
//     the delta reconcile already makes), so entries never refresh;
//   - duplicate uids in one read (a pending-move interloper beside the live
//     message) share the uid key: their headers are ambiguous, so they never
//     enter the index — they parse directly on every read until the sync
//     renumbers them.
// Any read/parse/IO error falls back to parsing the header slices directly;
// the index is never load-bearing.

import {messageMeta} from './headers.mjs';

const INDEX_FILE = '.headers.json';
const UIDVALIDITY_FILE = '.uidvalidity';
const INDEX_VERSION = 1;
const HEADER_BYTES = 65536;      // header stacks can exceed 8KB on real mail
const PARSE_CONCURRENCY = 24;    // parallel header-slice reads

const metaOf = m => [m.date, m.subject, m.from, m.messageId, m.references, m.inReplyTo];

function applyMeta(row, meta) {
  row.date = meta[0];
  row.subject = meta[1];
  row.from = meta[2];
  row.messageId = meta[3];
  row.references = meta[4];
  row.inReplyTo = meta[5];
}

// bounded-concurrency worker pool over one list
async function pool(items, limit, fn) {
  let i = 0;
  const workers = Array.from({length: Math.max(1, Math.min(limit, items.length))}, async () => {
    while (i < items.length) {
      const item = items[i++];
      await fn(item);
    }
  });
  await Promise.all(workers);
}

// read + parse the header slice of each row; rows whose file cannot be read
// keep uid+flags only (flag truth lives in the filename). Returns the
// [row, compactMeta] pairs that parsed, index-ready. Reports
// {done, total} through onProgress after every attempt (success or not).
async function parseSlices(rows, fs, onProgress = null) {
  const out = [];
  const total = rows.length;
  if (!total) {
    return out;
  }
  let done = 0;
  await pool(rows, PARSE_CONCURRENCY, async row => {
    try {
      const file = await fs.reader.read(row.entry.path);
      const bytes = new Uint8Array(await file.slice(0, HEADER_BYTES).arrayBuffer());
      out.push([row, metaOf(messageMeta(bytes))]);
    }
    catch {
      // unreadable/partial body — same degrade as the uncapped path
    }
    done++;
    if (onProgress) {
      try {
        onProgress({done, total});
      }
      catch {}
    }
  });
  return out;
}

/**
 * Fill the header-derived fields of the rows through the persistent index.
 * Rows may span folders (search); each folder's group is hydrated against
 * its own .headers.json. Rows without an indexable folder dir or positive
 * uid (surrogates) parse directly, uncached.
 * @param {Array<object>} rows folderRows-shaped rows ({entry, uid, ...})
 * @param {object} fs an fs gateway facade (prepare()'s {reader, writer})
 * @param {{prune?: boolean, onProgress?: Function|null}} [opts]
 *   prune: the rows cover the WHOLE folder — drop cached uids no longer on
 *   disk. Subset reads must leave this off (see the module comment).
 *   onProgress: {done, total} per parsed header slice (only rows that need
 *   parsing count — a warm read reports nothing).
 * @returns {Array<object>} the same rows, meta-filled in place
 */
export async function hydrateMeta(rows, fs, {prune = false, onProgress = null} = {}) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) {
    return list;
  }
  const groups = new Map();
  const loose = [];
  for (const row of list) {
    const dir = row?.entry?.maildir?.dir;
    const uid = Number(row?.uid);
    if (dir && Number.isInteger(uid) && uid > 0) {
      let group = groups.get(dir);
      if (!group) {
        group = [];
        groups.set(dir, group);
      }
      group.push(row);
    }
    else {
      loose.push(row);
    }
  }
  await Promise.all(
    [...groups.values()].map(group => fillGroup(group, fs, {prune, onProgress}))
  );
  if (loose.length) {
    // no index for these — parse and fill directly
    for (const [row, meta] of await parseSlices(loose, fs, onProgress)) {
      applyMeta(row, meta);
    }
  }
  return list;
}

async function fillGroup(rows, fs, {prune = false, onProgress = null} = {}) {
  const dir = rows[0].entry.maildir.dir;
  const file = dir + '/' + INDEX_FILE;
  let uidvalidity = 0;
  try {
    uidvalidity = Number(String(await fs.reader.readText(dir + '/' + UIDVALIDITY_FILE) ?? '').trim()) || 0;
  }
  catch {}
  let index = null;
  try {
    const parsed = JSON.parse(await fs.reader.readText(file));
    if (parsed && parsed.version === INDEX_VERSION &&
        parsed.messages && typeof parsed.messages === 'object') {
      // a uidvalidity change invalidates wholesale (uids are re-numbered);
      // a folder without .uidvalidity keeps whichever index it has
      index = uidvalidity && parsed.uidvalidity && parsed.uidvalidity !== uidvalidity
        ? null
        : parsed;
    }
  }
  catch {
    /* missing/corrupt → rebuild below */
  }
  const messages = index?.messages ?? {};

  // uid → rows: uids held by MORE than one row of this read are ambiguous
  // (pending-move interloper beside the live message) — they never enter the
  // index and always parse directly. The set persists in the index file: a
  // SUBSET read seeing one file of a pair must not serve the other file's
  // cached headers, so a full read's ambiguity verdict binds later reads
  // until the next full read re-derives it.
  const byUid = new Map();
  for (const row of rows) {
    const uid = Number(row.uid);
    const list = byUid.get(uid);
    if (list) {
      list.push(row);
    }
    else {
      byUid.set(uid, [row]);
    }
  }
  const perReadAmbiguous = new Set(
    [...byUid].flatMap(([uid, list]) => list.length > 1 ? [uid] : [])
  );
  const ambiguous = new Set([...(index?.ambiguous ?? []), ...perReadAmbiguous]);

  let dirty = false;
  if (index && prune) {
    // full-folder read: uids no longer on disk leave the index (moved away,
    // purged, \Deleted). Set-built once — the prune is linear, not per-key
    // scans.
    const live = new Set(byUid.keys());
    for (const uid of Object.keys(messages)) {
      if (!live.has(Number(uid))) {
        delete messages[uid];
        dirty = true;
      }
    }
    for (const uid of [...ambiguous]) {
      // the folder truth re-derives ambiguity wholesale: a uid still on disk
      // stays ambiguous only while this read still sees it doubled
      if (!live.has(Number(uid)) || !perReadAmbiguous.has(uid)) {
        ambiguous.delete(uid);
        dirty = true;
      }
    }
  }
  else if (index) {
    // subset read: ambiguity can only grow (a pair discovered here binds
    // later reads; un-ambiguating is the full read's job)
    for (const uid of perReadAmbiguous) {
      if (!ambiguous.has(uid)) {
        ambiguous.add(uid);
        dirty = true;
      }
    }
  }

  const direct = [];
  const missing = [];
  for (const row of rows) {
    const uid = Number(row.uid);
    if (ambiguous.has(uid)) {
      direct.push(row);
    }
    else if (!messages[uid]) {
      missing.push(row);
    }
  }
  const parsed = new Map(await parseSlices([...direct, ...missing], fs, onProgress));
  for (const row of direct) {
    const meta = parsed.get(row);
    if (meta) {
      applyMeta(row, meta);
    }
  }
  for (const row of missing) {
    const meta = parsed.get(row);
    if (meta) {
      messages[Number(row.uid)] = meta;
      dirty = true;
    }
  }
  if (dirty) {
    try {
      await fs.writer.write(file, JSON.stringify({
        version: INDEX_VERSION,
        uidvalidity,
        messages,
        ambiguous: [...ambiguous]
      }));
    }
    catch {
      /* a failed write only costs the next read a re-parse */
    }
  }
  for (const row of rows) {
    if (ambiguous.has(Number(row.uid))) {
      continue;   // served from its direct parse above
    }
    const meta = messages[Number(row.uid)];
    if (meta) {
      applyMeta(row, meta);
    }
  }
}
