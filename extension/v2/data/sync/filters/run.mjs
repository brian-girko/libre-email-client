// run.mjs — filter execution over a local Maildir mirror.
//
// The executor for one options-page filter against one local Maildir dir:
// lists the mirror's unread messages, parses each with the bundled
// postal-mime parser, matches it with the query language (query.mjs) and —
// unless run as a dry run — renames every match into the filter's
// destination Maildir with the SOURCE folder's FMD5 kept ({keepFmd5: true},
// maildir.mjs). A renamed file is the engine's pending-move marker: the
// next sync classifies it as an interloper and replays it as ONE server
// MOVE — the local run never talks IMAP itself.
//
// Store-only by design: the caller hands in the MaildirStore, so this
// module runs equally panel-side (the sync interface page owns the granted
// handle too) and later inside the offscreen engine. No chrome.*, no
// snapshot writes, no lastSyncAt — a filter run is not a sync.
//
// Output contract: log(content, cls) with cls '' (plain line), 'hint',
// 'warn' or 'system' (bordered header/summary lines). One line per
// matched message — '"subject" (sender) → dest — line n: rule' — plus
// 'warn' lines for genuine errors (unreadable file, failed move) and
// nothing else: a dry run prints the same match lines, a successful
// move is silent.

'use strict';

import {parseMessage} from './route.mjs';
import {filterMatches} from './query.mjs';

// scope key → recency window in seconds ('unread' has none: every
// unread message is a candidate)
const SCOPES = {
  unread: null,
  '10m': 10 * 60,
  '30m': 30 * 60,
  '1h': 60 * 60,
  '5h': 5 * 60 * 60
};

const MAX_SUBJECT = 80;          // log-line truncation for subjects

/** normalized scope key ('unread' when unknown) */
function scopeKey(scope) {
  return Object.hasOwn(SCOPES, scope) ? scope : 'unread';
}

function trunc(text) {
  const s = String(text ?? '');
  return s.length > MAX_SUBJECT ? s.slice(0, MAX_SUBJECT - 1) + '…' : s;
}

/**
 * The message's own time: the parsed Date header; the local file's
 * landing time (lastModified) stands in when the header is missing or
 * unparsable. Null only when even the file stat fails.
 * @returns {Promise<number|null>} epoch ms
 */
async function messageTime(parsed, entry) {
  const d = parsed?.date;
  if (d instanceof Date && !Number.isNaN(d.getTime())) {
    return d.getTime();
  }
  if (typeof d === 'string') {
    const t = Date.parse(d);
    if (Number.isFinite(t)) {
      return t;
    }
  }
  try {
    return (await entry.file.getFile()).lastModified;
  }
  catch {
    return null;
  }
}

/**
 * Runs one filter over one local Maildir dir.
 * @param {MaildirStore} store the account's open local mirror
 * @param {object} opts
 * @param {string} opts.dir local Maildir dir (server folder name)
 * @param {object} opts.filter an options-page filter {id, enabled,
 *   accountId, query, folder, createFolder, description}
 * @param {string|null} [opts.accountId] the mail's own account id
 *   (filters scoped to another account never match)
 * @param {string} [opts.scope] 'unread' | '10m' | '30m' | '1h' | '5h' —
 *   the candidate set: all unread, or unread AND newer than the window
 * @param {boolean} [opts.dry] report matches, rename nothing
 * @param {Function} [opts.log] log(content, cls)
 * @returns {Promise<{candidates: number, matched: number, moved: number}>}
 */
export async function runFilter(store, {
  dir, filter, accountId = null, scope = 'unread', dry = false, log = () => {}
} = {}) {
  const res = {candidates: 0, matched: 0, moved: 0};
  if (!filter || typeof filter !== 'object' ||
      typeof filter.query !== 'string' || !filter.folder) {
    log('filter run: the selected filter is not runnable (no query or destination folder)', 'warn');
    return res;
  }
  if (filter.enabled === false) {
    log('filter run: the selected filter is disabled', 'warn');
    return res;
  }
  if (filter.accountId && filter.accountId !== accountId) {
    log(`filter run: the filter is scoped to another account (${filter.accountId})`, 'warn');
    return res;
  }
  const key = scopeKey(scope);

  const listing = await store.listLocal(dir).catch(() => null);
  if (!listing) {
    log(`filter run: "${dir}" has no local Maildir — sync once to pull the mirror first`, 'warn');
    return res;
  }

  // candidates: engine-tracked files of THIS dir that are unread (the S
  // letter is absent); recency scopes cut further by the message's own
  // Date header (the file's landing time stands in when missing)
  const cutoff = SCOPES[key] == null ? null : Date.now() - SCOPES[key] * 1000;
  const candidates = [];
  for (const [uid, entry] of listing.entries) {
    if (!Number.isFinite(uid) || (entry.flags ?? []).includes('\\Seen')) {
      continue;
    }
    candidates.push({uid, entry});
  }
  candidates.sort((a, b) => a.uid - b.uid);
  res.candidates = candidates.length;
  if (!candidates.length) {
    log(`filter ${dir}: 0 unread candidate(s) — nothing to do`, 'hint');
    return res;
  }

  // match pass: one postal-mime parse per candidate feeds both the
  // recency check and the query matcher
  const hits = [];
  for (const {uid, entry} of candidates) {
    let raw = null;
    try {
      raw = await store.readFile(entry);
    }
    catch (e) {
      log(`filter ${dir}: unreadable file ${entry.fileName}: ${e?.message || e}`, 'warn');
      continue;
    }
    const parsed = await parseMessage(raw);
    if (!parsed.ok) {
      log(`filter ${dir}: unparseable file ${entry.fileName} — skipped`, 'warn');
      continue;
    }
    if (cutoff != null) {
      const t = await messageTime(parsed.parsed, entry);
      if (t == null || t < cutoff) {
        continue;
      }
    }
    const detail = filterMatches(filter.query, parsed.msg);
    if (detail.matched) {
      res.matched++;
      // one line per match: who, where it goes, which query line(s) won
      // (the exact matching rule line(s), verbatim from the query)
      const rules = detail.lines
        .filter(l => l.hit)
        .map(l => `line ${l.n}: ${l.rule}`)
        .join('; ');
      const who = parsed.msg.from ? ` (${parsed.msg.from})` : '';
      const subj = parsed.msg.subject ? `"${trunc(parsed.msg.subject)}" ` : '';
      log(`${subj}${who}→ ${filter.folder}${rules ? ` — ${rules}` : ''}`);
      hits.push({uid, entry});
    }
  }
  if (!hits.length) {
    return res;
  }
  if (dry) {
    return res;
  }

  // destination sanity: the snapshot is the last sync's server view — a
  // folder missing there warns but never blocks (the run only renames
  // locally; the server move lands when the folder exists)
  const snap = await store.loadState().catch(() => null);
  if (snap?.folders && !snap.folders[filter.folder]) {
    log(`warning: destination "${filter.folder}" is not a folder of the last sync` +
      (filter.createFolder
        ? ' (the filter asks for folder creation — a local run cannot create it on the server)'
        : '') +
      ' — renaming anyway; the next sync pushes the move once the folder exists', 'warn');
  }

  let moved = 0;
  for (const {uid, entry} of hits) {
    try {
      // keepFmd5 stamps the SOURCE folder: the pending-move marker the
      // sync engine replays as a server MOVE on its next run
      await store.moveMessage(dir, entry, filter.folder, uid, {keepFmd5: true});
      moved++;
    }
    catch (e) {
      log(`move ${dir}/${uid} FAILED: ${e?.message || e} — file kept: ${entry.fileName}`, 'warn');
    }
  }
  res.moved = moved;
  return res;
}
