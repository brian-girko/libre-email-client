'use strict';

// fs-events.mjs — the client's fs-event stream router. core/fs.mjs emits
// one {type:'fs-event', origin, operation, src, dest} after every file/dir
// mutation — broadcast over the runtime bus AND echoed to same-context
// onFsEvent() subscribers (sendMessage never delivers to the sender, the
// echo is how the client sees its own edits). This module is the ONE place
// that turns those events into view refreshes:
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
//                     context); a create can never be the open message.
//                     No fs-event can change mail content (flag truth is
//                     the filename), so the preview only reconciles the
//                     toolbar from the filename flags — it never re-parses
//                     the body; a vanished message closes the card
//   accounts-view     the account picker — a ROOT-LEVEL single-segment path
//                     (an account directory mkdir'd under or removed from
//                     the granted root) re-reads the picker's enumeration no
//                     matter which account this page is showing, so a first
//                     (or second) account comes alive without a reload
//
// Everything else is filtered out with a reason: events of other accounts,
// metadata files (.sync-state.json, .sync-prefs.json, .uidvalidity,
// probes), tmp/ scratch and the tmp/new/cur triple mkdirs that accompany
// a folder's first message (their real event is the move that follows).
//
// The view callables arrive injected from index.mjs (dirs.refresh,
// dirs.refreshCounts, filters.reconcileOpenFolder, preview.refresh) — this
// module stays decoupled from the views it drives. Calls are COALESCED:
// a sync lands hundreds of events, the views need one reconcile per burst
// — 150 ms trailing edge, forced at 1 s so a long run still refreshes
// progressively. classifyEvent() itself is pure and unit-tested.

import {folderFor, parseFilename} from '../sync/maildir.mjs';
import {onFsEvent} from '/core/fs.mjs';

const DELAY_MS = 150;     // trailing edge: one reconcile per event burst
const MAX_WAIT_MS = 1000; // forced fire mid-burst (progressive sync updates)

/**
 * Classifies one fs-event against the client's current account and open
 * dir. Pure — no chrome, no DOM — so tests can drive it directly.
 * @param {{type?: string, origin?: string, operation?: string, src?: string,
 *   dest?: string|null}} msg the runtime message
 * @param {{account?: string|null, dir?: string|null}} ctx the currently
 *   selected account id (== the maildir slug) and open dir (server folder
 *   name spelling, as the tree serves it), both nullable
 * @returns {{match: 'mine'|'other'|'unselected', slug: string|null,
 *   dirs: string[], calls: string[], actions: object[], note: string|null}}
 *   dirs = affected server folder names; actions = machine-readable view
 *   ops (the router's input); calls = the same ops as printable strings
 *   (dir-view → dirs.refresh, dir-view(counts) → dirs.refreshCounts,
 *   mails-view(delta) → filters.reconcileOpenFolder, mail-view(uid N) →
 *   preview.refresh, accounts-view → accounts.refreshAccounts);
 *   note = why nothing would be called (null otherwise)
 */
export function classifyEvent(msg, {account = null, dir = null} = {}) {
  const verdict = {
    match: 'mine', slug: null, dirs: [], calls: [], actions: [], note: null
  };
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
  // A root-level single-segment endpoint is an ACCOUNT-tree change: an
  // account dir mkdir'd under, or removed from, the granted root. It
  // concerns the account picker no matter which account this page shows —
  // classified before the account-match short-circuits below and dispatched
  // as the accounts-view op from here even when the match isn't 'mine'.
  // Root-hidden entries (.picker-probe & friends) are not accounts.
  const accountDirs = dest ? [src, dest] : [src];
  if (accountDirs.some(segs => segs.length === 1 && !segs[0].startsWith('.'))) {
    verdict.actions.push({component: 'accounts-view'});
    verdict.calls.push('accounts-view');
  }
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
    verdict.actions.push({component: 'dir-view'});
    verdict.calls.push('dir-view');
  }
  if (mailsDelta) {
    verdict.actions.push({component: 'mails-view', dir});
    verdict.calls.push(`mails-view(delta ${dir})`);
  }
  // the tree's counter sweep rides a light call of its own — the
  // structural dir-view above already re-runs it, so no double entry
  if (!dirView && countDirs.size) {
    verdict.actions.push({component: 'dir-view', kind: 'counts', dirs: [...countDirs]});
    verdict.calls.push(`dir-view(counts ${[...countDirs].join(', ')})`);
  }
  if (mailUid != null) {
    verdict.actions.push({component: 'mail-view', uid: mailUid});
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

// ---- the router ------------------------------------------------------------

let calls = null;   // {dirView, dirCounts, mailsDelta, mailView,
                    //  accountsView} — injected
let ctx = () => ({});   // {account, dir} getters, evaluated per event

const timers = {};
let pendingUids = new Set();

function schedule(key, fn) {
  if (timers[key]) {
    return;   // already scheduled — the pending pair fires for this burst
  }
  const forceId = key === 'dirView' ? null : setTimeout(() => {
    // a long burst (a whole sync run) must not starve the views forever:
    // force MY OWN trailing edge through after MAX_WAIT_MS — and only mine
    // (a later schedule() call's trailing edge must never be cancelled here)
    if (timers[key] === trailing) {
      clearTimeout(trailing);
      delete timers[key];
      fn();
    }
    delete timers[key + ':force'];
  }, MAX_WAIT_MS);
  const trailing = setTimeout(() => {
    // normal fire: retire my force timer first so no orphan can later cancel
    // a NEW trailing edge scheduled for the next burst
    if (forceId != null) {
      clearTimeout(forceId);
      delete timers[key + ':force'];
    }
    delete timers[key];
    fn();
  }, DELAY_MS);
  timers[key] = trailing;
  if (forceId != null) {
    timers[key + ':force'] = forceId;
  }
}

function route(msg) {
  const verdict = classifyEvent(msg, ctx());
  const route_ = msg.dest != null ? `${msg.src} → ${msg.dest}` : String(msg.src ?? '');
  const who = verdict.match === 'mine' ? 'mine'
    : verdict.match === 'unselected' ? 'no account selected'
    : `other account (${verdict.slug ?? '?'})`;
  console.log(`[fs-event] ${msg.origin ?? '?'} · ${msg.operation} · ${route_} · ${who}` +
    (verdict.calls.length
      ? ` · would call: ${verdict.calls.join(', ')}`
      : ` · none (${verdict.note})`));
  if (verdict.match !== 'mine') {
    // non-mine events drive ONLY the accounts-view op (an account dir
    // appearing/disappearing matters with this page showing any account);
    // the view ops below need the matching context
    if (!calls || !verdict.actions.some(a => a.component === 'accounts-view')) {
      return;
    }
    for (const action of verdict.actions) {
      if (action.component === 'accounts-view') {
        schedule('accounts', () => calls.accountsView?.());
      }
    }
    return;
  }
  if (!calls) {
    return;
  }
  for (const action of verdict.actions) {
    if (action.component === 'dir-view' && !action.kind) {
      schedule('dirView', () => calls.dirView?.());
    }
    else if (action.component === 'mails-view') {
      schedule('mails', () => calls.mailsDelta?.());
    }
    else if (action.component === 'dir-view') {
      schedule('counts', () => calls.dirCounts?.());
    }
    else if (action.component === 'accounts-view') {
      // a root-level change of THIS account also re-reads the picker: the
      // dir-view above rebuilds the tree, this keeps the <select> honest
      schedule('accounts', () => calls.accountsView?.());
    }
    else if (action.component === 'mail-view') {
      pendingUids.add(action.uid);
      schedule('mail', () => {
        for (const uid of pendingUids) {
          calls.mailView?.(uid);
        }
        pendingUids = new Set();
      });
    }
  }
}

/**
 * Installs the router. account/dir are GETTER functions evaluated per
 * event — account from the folder tree (dirs.mjs, valid before any folder
 * is selected), dir mirrored from the dir-selected event; the calls object
 * carries the view callables — any entry may be absent, that view simply
 * never refreshes from events.
 * @param {{account?: Function, dir?: Function, calls?: {
 *   dirView?: Function, dirCounts?: Function, mailsDelta?: Function,
 *   mailView?: Function, accountsView?: Function}}} wiring
 */
export function init({account, dir, calls: injected} = {}) {
  calls = injected ?? null;
  ctx = () => ({
    account: typeof account === 'function' ? account() : (account ?? null),
    dir: typeof dir === 'function' ? dir() : (dir ?? null)
  });
  // same-context events (the client's own edits) + the runtime bus
  // (engine, sync panel, other client windows) — one router for both
  onFsEvent(route);
  chrome.runtime.onMessage.addListener(msg => {
    if (msg?.type === 'fs-event') {
      route(msg);
    }
  });
}
