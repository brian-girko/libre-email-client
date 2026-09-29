'use strict';

// fs-events.mjs — the client's fs-event stream listener. core/fs.mjs
// broadcasts one {type:'fs-event', origin, operation, src, dest} after
// every file/dir mutation anywhere in the extension; this module decides
// whether an event concerns the CURRENTLY SELECTED account and, if so,
// which view components would need to refresh:
//
//   dir-view          the folder tree — ONLY when the account's directory
//                     structure itself changed (a Maildir folder created
//                     or removed; a move never changes the folder set)
//   mails-view(delta) the open folder's message list — any file landing in,
//                     changing in or leaving {new,cur} of the OPEN dir;
//                     the delta path (listThreadsDelta) reconciles in place
//   dir-view(counts)  the tree's per-folder unread/total counters — a
//                     message file arriving, leaving or being RENAMED in
//                     {new,cur} of ANY folder of the account moves them
//                     (INBOX → Spam = one unread less, one more). A
//                     same-name content rewrite ('change') never counts —
//                     flag truth lives in the filename
//   mail-view         the open message — its file was renamed away or
//                     deleted under it (a flag rename or purge from another
//                     context); a create can never be the open message
//
// Everything else is filtered out with a reason: events of other accounts,
// metadata files (.sync-state.json, .sync-prefs.json, .uidvalidity,
// probes), tmp/ scratch and the tmp/new/cur triple mkdirs that accompany
// a folder's first message (their real event is the move that follows).
//
// The client's own edits never arrive here (sendMessage does not deliver
// to the sender) — self-edits refresh through the mirrorChanged feed.
//
// PRINT-ONLY for now: the listener logs "would call: …" instead of
// calling anything. Wiring it up means mapping the calls onto
// dirs.refresh() / list.syncCurrent() / a preview re-read — and likely
// retiring the parallel 'sync-refresh' handler in index.mjs, which this
// module's routing is shaped after (same account check, same two calls).

import {folderFor, parseFilename} from '../sync/maildir.mjs';

/**
 * Classifies one fs-event against the client's current account and open
 * dir. Pure — no chrome, no DOM — so tests can drive it directly.
 * @param {{type?: string, origin?: string, operation?: string, src?: string,
 *   dest?: string|null}} msg the runtime message
 * @param {{account?: string|null, dir?: string|null}} ctx the currently
 *   selected account id (== the maildir slug) and open dir (server folder
 *   name spelling, as the tree serves it), both nullable
 * @returns {{match: 'mine'|'other'|'unselected', slug: string|null,
 *   dirs: string[], calls: string[], note: string|null}} dirs = affected
 *   server folder names; calls = the components that would refresh, in
 *   call order; note = why nothing would be called (null when calls exist)
 */
export function classifyEvent(msg, {account = null, dir = null} = {}) {
  const verdict = {match: 'mine', slug: null, dirs: [], calls: [], note: null};
  if (msg?.type !== 'fs-event') {
    verdict.match = 'other';
    verdict.note = 'not an fs-event';
    return verdict;
  }
  const src = toSegs(msg.src);
  const dest = msg.dest == null ? null : toSegs(msg.dest);
  if (!src.length || (msg.dest != null && !dest?.length)) {
    verdict.match = 'other';
    verdict.note = 'malformed path';
    return verdict;
  }
  verdict.slug = src[0];
  if (!account) {
    verdict.match = 'unselected';
    verdict.note = 'no account selected';
    return verdict;
  }
  // a cross-account move never happens today; both endpoints are checked
  // anyway — the event belongs here when EITHER side is this account
  if (src[0] !== account && !(dest && dest[0] === account)) {
    verdict.match = 'other';
    verdict.note = 'other account';
    return verdict;
  }

  let dirView = false;
  let mailsDelta = false;
  let mailUid = null;
  const countDirs = new Set();
  const meta = {hit: false};
  const scratch = {hit: false};
  const triple = {hit: false};
  const unclassified = {hit: false};
  const otherDirs = new Set();

  // one endpoint = one affected path: the operation itself for src, the
  // landing side of a move for dest (where the file came to rest)
  const endpoints = [{segs: src, op: String(msg.operation ?? '')}];
  if (dest) {
    endpoints.push({segs: dest, op: 'move-dest'});
  }
  for (const {segs, op} of endpoints) {
    if (segs[0] !== account) {
      continue;   // the other side of a (hypothetical) cross-account move
    }
    if (segs[segs.length - 1].startsWith('.')) {
      meta.hit = true;   // .sync-state.json, .uidvalidity, probes, …
      continue;
    }
    if (segs.length <= 2) {
      // <slug> itself or <slug>/<dirName>: the account's directory
      // structure changed (folder created/removed, account dir appeared)
      dirView = true;
      continue;
    }
    if (segs.length === 3) {
      triple.hit = true;   // tmp/new/cur of a Maildir
      continue;
    }
    if (segs[2] === 'tmp') {
      scratch.hit = true;   // maildir scratch — a move's src rides here
      continue;
    }
    if (segs[2] !== 'new' && segs[2] !== 'cur') {
      unclassified.hit = true;   // a stray file outside the triple
      continue;
    }
    const dirName = folderFor(segs[1], '/');
    if (!verdict.dirs.includes(dirName)) {
      verdict.dirs.push(dirName);
    }
    // counters (unread/total per folder) come from the filenames too: a
    // message arriving, leaving or being renamed moves them; a same-name
    // content rewrite ('change') cannot — flags live in the filename
    if (op !== 'change') {
      countDirs.add(dirName);
    }
    const isOpen = dir != null && dirName === dir;
    if (!isOpen) {
      otherDirs.add(dirName);
      continue;
    }
    mailsDelta = true;
    // the open message's file vanished under it: renamed away (flag
    // rewrite, folder move — the src side) or deleted; a landing file
    // (create/change/move-dest) cannot be the already-open message
    const gone = (op === 'move' && segs === src) || op === 'delete';
    if (gone) {
      const uid = parseFilename(segs[segs.length - 1])?.uid;
      if (uid != null) {
        mailUid = uid;
      }
    }
  }

  if (dirView) {
    verdict.calls.push('dir-view');
  }
  if (mailsDelta) {
    verdict.calls.push(`mails-view(delta ${dir})`);
  }
  // the tree's counter sweep rides a light call of its own — the
  // structural dir-view above already re-runs it, so no double entry
  if (!dirView && countDirs.size) {
    verdict.calls.push(`dir-view(counts ${[...countDirs].join(', ')})`);
  }
  if (mailUid != null) {
    verdict.calls.push(`mail-view(uid ${mailUid})`);
  }
  if (!verdict.calls.length) {
    verdict.note = meta.hit ? 'meta'
      : scratch.hit ? 'scratch'
      : triple.hit ? 'maildir triple'
      : otherDirs.size ? `other dir (${[...otherDirs].join(', ')})`
      : unclassified.hit ? 'outside the maildir triple'
      : 'no matching rule';
  }
  return verdict;
}

function toSegs(path) {
  return String(path ?? '').split('/').filter(Boolean);
}

/**
 * Installs the listener. account/dir are GETTER functions so the verdict
 * always reflects the selection at event time (index.mjs mirrors them
 * from the dir-selected event).
 * @param {{account?: Function, dir?: Function}} getters
 */
export function init({account, dir} = {}) {
  chrome.runtime.onMessage.addListener(msg => {
    if (msg?.type !== 'fs-event') {
      return;
    }
    let ctx;
    try {
      ctx = {
        account: typeof account === 'function' ? account() : (account ?? null),
        dir: typeof dir === 'function' ? dir() : (dir ?? null)
      };
    }
    catch {
      ctx = {};
    }
    const verdict = classifyEvent(msg, ctx);
    const route = msg.dest != null ? `${msg.src} → ${msg.dest}` : String(msg.src ?? '');
    const who = verdict.match === 'mine' ? 'mine'
      : verdict.match === 'unselected' ? 'no account selected'
      : `other account (${verdict.slug ?? '?'})`;
    console.log(`[fs-event] ${msg.origin ?? '?'} · ${msg.operation} · ${route} · ${who}` +
      (verdict.calls.length
        ? ` · would call: ${verdict.calls.join(', ')}`
        : ` · none (${verdict.note})`));
  });
}
