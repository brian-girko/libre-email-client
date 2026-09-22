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
// runAllFilters() is the 'use all filters' executor: same candidates and
// moves, but FIRST MATCH WINS per message — the filters' stored order is
// the precedence, and a match whose destination equals the source dir
// anchors the message in place instead of letting later filters move it.
//
// Store-only by design: the caller hands in the MaildirStore, so this
// module runs equally panel-side (the sync interface page owns the granted
// handle too) and later inside the offscreen engine. No chrome.*, no
// snapshot writes, no lastSyncAt — a filter run is not a sync.
//
// Output contract: log(content, cls) with cls '' (plain line), 'hint',
// 'warn' or 'system' (bordered header/summary lines). One line per
// matched message — '"subject" -> Line n[, m][ of Filter N] -> dest' —
// the matched query line NUMBERS only, never the rule text itself; the
// 'of Filter N' suffix appears only when the caller passes a filterNo.
// Plus 'warn' lines for genuine errors (unreadable file, failed move)
// and nothing else: a dry run prints the same match lines, a
// successful move is silent.

'use strict';

import {parseMessage} from './route.mjs';
import {filterMatches} from './query.mjs';
import {normalizeFolderPath, sameFolder} from '../maildir.mjs';

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
 *   accountId, query, folder, createFolder, description} — folder is
 *   canonicalized onto the store's delimiter before any comparison,
 *   log line or move ('/'-typed paths on '.'-delimiter servers)
 * @param {string|null} [opts.accountId] the mail's own account id
 *   (filters scoped to another account never match)
 * @param {string} [opts.scope] 'unread' | '10m' | '30m' | '1h' | '5h' —
 *   the candidate set: all unread, or unread AND newer than the window
 * @param {boolean} [opts.dry] report matches, rename nothing
 * @param {number|null} [opts.filterNo] 1-based position of the filter in
 *   the stored list (shown as 'of Filter N' in match lines); null/absent
 *   omits the filter number (single-filter runs)
 * @param {Function} [opts.log] log(content, cls)
 * @returns {Promise<{candidates: number, matched: number, moved: number}>}
 */
export async function runFilter(store, {
  dir, filter, accountId = null, scope = 'unread', dry = false,
  filterNo = null, log = () => {}
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
  // the destination in the account's own spelling: '/'-typed filter
  // paths map onto the hierarchy delimiter, so the src===dest guard,
  // the snapshot lookup, the match lines and the move all compare and
  // target the canonical name
  const dest = normalizeFolderPath(filter.folder, store.delimiter);
  if (dir && sameFolder(dest, dir, store.delimiter)) {
    log(`filter skipped: source and destination are both "${dir}" — nothing to match`, 'warn');
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
      // one line per match: subject, the MATCHED query line numbers only
      // (never the rule text — a query line can be huge), destination;
      // 'of Filter N' suffix when the caller named the filter's position
      const nums = detail.lines
        .filter(l => l.hit)
        .map(l => l.n)
        .join(', ');
      const lines = filterNo != null && Number.isFinite(Number(filterNo))
        ? `Line ${nums} of Filter ${Number(filterNo)}`
        : `Line ${nums}`;
      const subj = parsed.msg.subject ? `"${trunc(parsed.msg.subject)}" ` : '';
      log(`${subj}-> ${lines} -> ${dest}`);
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
  if (snap?.folders && !snap.folders[dest]) {
    log(`warning: destination "${dest}" is not a folder of the last sync` +
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
      await store.moveMessage(dir, entry, dest, uid, {keepFmd5: true});
      moved++;
    }
    catch (e) {
      log(`move ${dir}/${uid} FAILED: ${e?.message || e} — file kept: ${entry.fileName}`, 'warn');
    }
  }
  res.moved = moved;
  return res;
}

/**
 * Runs several filters over one local Maildir dir, FIRST MATCH WINS per
 * message: every candidate is walked against the filters in stored order
 * and the first matching filter alone decides the message's fate —
 * exactly the options page's delivery-time rule. A winner whose
 * destination IS the run's source dir anchors the message in place
 * (nothing to move, later filters never see it), so a self-targeted
 * match can never push the message into a wrong dir. One candidate
 * failing (unreadable, unparseable, failed move) never stops the rest.
 * @param {MaildirStore} store the account's open local mirror
 * @param {object} opts
 * @param {string} opts.dir local Maildir dir (server folder name)
 * @param {Array<object>} opts.filters options-page filters in STORED
 *   order ({id, enabled, accountId, query, folder, createFolder,
 *   description}) — the walk order IS the precedence; each folder is
 *   canonicalized onto the store's delimiter before any comparison,
 *   log line or move
 * @param {string|null} [opts.accountId] the mail's own account id
 * @param {string} [opts.scope] 'unread' | '10m' | '30m' | '1h' | '5h'
 * @param {Set<number>} [opts.onlyUids] explicit candidate set — replaces
 *   the unread/recency gates entirely (the engine's post-sync pass names
 *   exactly the messages the run pulled: "new", regardless of read state)
 * @param {boolean} [opts.dry] report matches, rename nothing
 * @param {Function} [opts.filterNoOf] filterNoOf(filter) → 1-based
 *   position in the stored list (shown as 'of Filter N'); null/absent
 *   or a non-finite result omits the filter number
 * @param {Function} [opts.log] log(content, cls)
 * @returns {Promise<{candidates: number, matched: number, moved: number,
 *            kept: number}>} kept = messages anchored in dir by a
 *   winner whose destination equals the source dir
 */
export async function runAllFilters(store, {
  dir, filters, accountId = null, scope = 'unread', dry = false,
  onlyUids = null, filterNoOf = null, log = () => {}
} = {}) {
  const res = {candidates: 0, matched: 0, moved: 0, kept: 0};
  const list = Array.isArray(filters) ? filters : [];
  if (!dir) {
    log('filter run: no source dir', 'warn');
    return res;
  }

  const listing = await store.listLocal(dir).catch(() => null);
  if (!listing) {
    log(`filter run: "${dir}" has no local Maildir — sync once to pull the mirror first`, 'warn');
    return res;
  }

  // candidates: engine-tracked files of THIS dir that are unread (the S
  // letter is absent); recency scopes cut further by the message's own
  // Date header (the file's landing time stands in when missing).
  // onlyUids replaces all of that with an explicit set — the post-sync
  // pass targets exactly the run's pulls, read or unread.
  const only = onlyUids instanceof Set ? onlyUids : null;
  const cutoff = only ? null : (() => {
    const key = scopeKey(scope);
    return SCOPES[key] == null ? null : Date.now() - SCOPES[key] * 1000;
  })();
  const candidates = [];
  for (const [uid, entry] of listing.entries) {
    if (!Number.isFinite(uid)) {
      continue;
    }
    if (only ? !only.has(uid) : (entry.flags ?? []).includes('\\Seen')) {
      continue;
    }
    candidates.push({uid, entry});
  }
  candidates.sort((a, b) => a.uid - b.uid);
  res.candidates = candidates.length;
  if (!candidates.length) {
    log(`filter ${dir}: 0 ${only ? 'new' : 'unread'} candidate(s) — nothing to do`, 'hint');
    return res;
  }

  const number = filter => {
    const n = filterNoOf?.(filter);
    return n != null && Number.isFinite(Number(n)) ? Number(n) : null;
  };

  const hits = [];
  for (const {uid, entry} of candidates) {
    try {
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

      // first match wins: stop the walk at the first matching filter —
      // later filters are never consulted for this message
      let winner = null;
      for (const filter of list) {
        if (!filter || typeof filter !== 'object' || filter.enabled === false ||
            typeof filter.query !== 'string' || !filter.folder ||
            (filter.accountId && filter.accountId !== accountId)) {
          continue;
        }
        const detail = filterMatches(filter.query, parsed.msg);
        if (detail.matched) {
          winner = {filter, detail};
          break;
        }
      }
      if (!winner) {
        continue;
      }
      res.matched++;

      // one line per match: subject, the MATCHED query line numbers only
      // (never the rule text), destination — 'of Filter N' when the
      // caller can name the filter's position in the stored list; the
      // destination is canonicalized onto the store's delimiter before
      // any comparison or move ('/'-typed paths on '.'-delimiter servers)
      const filter = winner.filter;
      const dest = normalizeFolderPath(filter.folder, store.delimiter);
      const nums = winner.detail.lines
        .filter(l => l.hit)
        .map(l => l.n)
        .join(', ');
      const no = number(filter);
      const lines = no != null ? `Line ${nums} of Filter ${no}` : `Line ${nums}`;
      const subj = parsed.msg.subject ? `"${trunc(parsed.msg.subject)}" ` : '';
      if (sameFolder(dest, dir, store.delimiter)) {
        log(`${subj}-> ${lines} -> stays in "${dir}" ` +
          '(destination equals source — later filters skipped)');
        res.kept++;
        continue;
      }
      log(`${subj}-> ${lines} -> ${dest}`);
      hits.push({uid, entry, filter, dest});
    }
    catch (e) {
      log(`filter ${dir}: candidate ${entry.fileName} failed: ${e?.message || e} — skipped`, 'warn');
    }
  }

  if (dry || !hits.length) {
    return res;
  }

  // destination sanity: the snapshot is the last sync's server view — a
  // folder missing there warns but never blocks (one warn per distinct
  // winning destination folder)
  const snap = await store.loadState().catch(() => null);
  const warned = new Set();
  for (const {filter, dest} of hits) {
    if (warned.has(dest) || !snap?.folders || snap.folders[dest]) {
      continue;
    }
    warned.add(dest);
    log(`warning: destination "${dest}" is not a folder of the last sync` +
      (filter.createFolder
        ? ' (the filter asks for folder creation — a local run cannot create it on the server)'
        : '') +
      ' — renaming anyway; the next sync pushes the move once the folder exists', 'warn');
  }

  let moved = 0;
  for (const {uid, entry, dest} of hits) {
    try {
      // keepFmd5 stamps the SOURCE folder: the pending-move marker the
      // sync engine replays as a server MOVE on its next run
      await store.moveMessage(dir, entry, dest, uid, {keepFmd5: true});
      moved++;
    }
    catch (e) {
      log(`move ${dir}/${uid} FAILED: ${e?.message || e} — file kept: ${entry.fileName}`, 'warn');
    }
  }
  res.moved = moved;
  return res;
}
