'use strict';

// Client-side filters/sync bridge. The engine itself runs in the service
// worker (worker filters.mjs + core/filters/engine.mjs): enabled filters are
// applied to new INBOX mail before every badge check and whenever this page
// opens, so folder lists show post-filter mail.
//
// This module is the client end of the worker's single 'activity' channel and
// feeds the unified logger:
//   - source 'filters' -> read-only log lines with progress
//     ("Filtering (Work): 2/10 · 1 moved").
//   - source 'badge'   -> no log output; only the in-place list sync rides
//     these events (add/remove rows, no reload) when the open folder gained
//     or lost mail.
// It also asks for a filter pass when the client opens.

import {isSearching, sync} from './list.mjs';
import {accountPendingJobs} from './jobs.mjs';
import * as logger from './logger.mjs';
import * as counters from './counters.mjs';

let selected = null; // {accountId, name} of the open folder

// ---- filter activity lines ------------------------------------------------

function filterPrefix(label) {
  return 'Filtering' + (label ? ' (' + label + ')' : '');
}

function filterEntryId(accountId) {
  return 'filter:' + (accountId || 'all');
}

// Ensure the account has a running line for the current pass (worker 'end'
// events for periodic badge passes arrive with no preceding 'start').
function ensureFilterEntry(accountId, label) {
  const id = filterEntryId(accountId);
  if (!logger.get(id)) {
    logger.begin({
      id,
      source: 'filters',
      kind: 'filters',
      label: filterPrefix(label) + ': filtering…',
      cancelable: false
    });
    logger.update(id, {state: 'running'});
  }
  return id;
}

function handleFiltersActivity(message) {
  const {accountId = '', label = '', phase} = message;
  const id = ensureFilterEntry(accountId, label);
  if (phase === 'start') {
    logger.update(id, {state: 'running', error: null, label: filterPrefix(label) + ': filtering…'});
    return;
  }
  if (phase === 'progress') {
    const done = Number(message.done) || 0;
    const total = Number(message.total) || 0;
    const moved = Number(message.moved) || 0;
    const deleted = Number(message.deleted) || 0;
    const bits = [];
    if (moved) {
      bits.push(moved + ' moved');
    }
    if (deleted) {
      bits.push(deleted + ' deleted');
    }
    logger.update(id, {
      state: 'running',
      error: null,
      label: filterPrefix(label) + ': ' + done + '/' + total + (bits.length ? ' · ' + bits.join(', ') : ''),
      progress: {done, total}
    });
    return;
  }
  // end
  const errors = Array.isArray(message.errors) ? message.errors : [];
  const moved = Number(message.moved) || 0;
  const deleted = Number(message.deleted) || 0;
  if (errors.length) {
    logger.fail(id, errors[0]);
  }
  else if (moved || deleted) {
    const bits = [];
    if (moved) {
      bits.push(moved + ' moved');
    }
    if (deleted) {
      bits.push(deleted + ' deleted');
    }
    logger.done(id, filterPrefix(label) + ': ' + bits.join(', '));
  }
  else {
    logger.done(id, filterPrefix(label) + ': no matches');
  }
  // The pass acted on mail: reconcile the open view in place when one of its
  // per-message changes ('{uid, from, to}' — the worker's separate session
  // already invalidated the shared threads cache) involves the folder the
  // user is reading. The periodic badge event alone cannot do this reliably
  // (its first sighting after a page open only seeds seenState), so a pass
  // whose mail left or entered the open folder is the direct trigger.
  if (moved || deleted) {
    if (passTouchesOpenFolder(accountId, message.changes)) {
      sync(selected.accountId, selected.name);
    }
  }
}

// ---- folder sync decisions ----------------------------------------------

// Decide whether a filter pass acted on the open folder and sync it in place
// if so. The worker sends per-message changes [{uid, from, to}] (to === null
// when the mail left the server entirely via the .eml action), so any viewed
// folder is covered: mail moved out of it (its rows were expunged) as well as
// mail moved into it (new threads appeared) — a pass moving mail into the
// non-INBOX folder the user is reading reconciles that view. accountId ''
// means an all-accounts pass: any open folder may be affected. No sync while
// search results are shown or a toolbar job is running (as with the
// badge-driven sync below, the next event retries instead of clobbering
// optimistic row removal). A slightly older worker (mid page/worker reload)
// sends no uid detail: fall back to the inherited conservative check —
// reconcile when the open folder is an INBOX, the only folder the engine
// ever acts on.
function passTouchesOpenFolder(accountId, changes) {
  if (!selected || isSearching() || accountPendingJobs(selected.accountId).length) {
    return false;
  }
  if (accountId !== '' && accountId !== selected.accountId) {
    return false;
  }
  if (!Array.isArray(changes)) {
    return selected.name.toUpperCase() === 'INBOX';
  }
  return changes.some(c => c && (c.from === selected.name || c.to === selected.name));
}

// ---- favicon mirrors the action icon ---------------------------------------

// The client tab shows the same state icons as the toolbar action button:
// red when unread mail was counted, blue when mail could not be checked
// (errors, bridge down, or no account to check at all), gray when every
// account was checked and had zero unread.
const FAVICON_PATHS = {
  gray: '/data/icons/gray/32.png',
  blue: '/data/icons/blue/32.png',
  red: '/data/icons/red/32.png'
};
// Red favicon baseline: the last real check result, cached so prediction
// ticks (badgePending) can re-evaluate the state without a storage read.
let lastBadgeResult = null;

function faviconState(result) {
  if (!result) {
    return 'blue';
  }
  // badgePending() keeps the favicon tracking predicted badge moves/reads
  // between the action and the debounced real check
  const total = (Number(result.total) || 0) + counters.badgePending();
  if (total > 0) {
    return 'red';
  }
  const rows = Array.isArray(result.accounts) ? result.accounts : [];
  // no badge-enabled account existed when this result was built — nothing
  // could be checked, so "all good" gray would be a lie (mirrors iconState()
  // in badge.mjs)
  if (!rows.length) {
    return 'blue';
  }
  return rows.some(a => a.error) ? 'blue' : 'gray';
}

function setFavicon(state) {
  const el = document.getElementById('favicon');
  if (el) {
    el.href = FAVICON_PATHS[state] || FAVICON_PATHS.gray;
  }
}

async function seedFavicon() {
  try {
    const res = await chrome.storage.session.get('badge.last');
    lastBadgeResult = res?.['badge.last'] || null;
    setFavicon(faviconState(lastBadgeResult));
  }
  catch {
    // favicon stays at the static gray link when the state is unreadable
  }
}

// Prediction ticks keep the favicon in sync between real checks
function faviconTick() {
  if (lastBadgeResult) {
    setFavicon(faviconState(lastBadgeResult));
  }
}

// ---- badge-driven in-place list sync --------------------------------------

// Last uidnext/exists seen per account+folder, so a periodic badge check only
// triggers a sync when the open folder actually gained/lost mail.
const seenState = new Map(); // 'accountId/folder' -> {uidnext, exists}

function handleMailSync(result) {
  if (!Array.isArray(result?.accounts)) {
    return;
  }
  for (const a of result.accounts) {
    if (!a || a.error || !a.folder) {
      continue;
    }
    const key = a.id + '/' + a.folder;
    const prev = seenState.get(key);
    const next = {uidnext: a.uidnext ?? null, exists: a.exists ?? null};
    const changed = prev && (prev.uidnext !== next.uidnext || prev.exists !== next.exists);
    if (!changed) {
      seenState.set(key, next);
      continue;
    }
    // Arrived mail predicted until the next server truth: the badge pass
    // reports the folder's exists growth. Skipped while a move/save to that
    // folder is in flight — the move's own prediction already counted the
    // arrival and the exists delta would double it.
    const arrived = Number(prev.exists) >= 0 && Number(next.exists) >= 0
      ? (Number(next.exists) - Number(prev.exists))
      : 0;
    const migrating = accountPendingJobs(a.id).some(j => j.kind === 'move' || j.kind === 'save');
    if (arrived > 0 && !migrating) {
      counters.arrival(a.id, a.folder, arrived);
    }
    if (selected?.accountId === a.id && selected?.name === a.folder && !isSearching()) {
      // A toolbar action is still running: keep the old snapshot so the next
      // event retries instead of syncing over the optimistic row removal.
      if (accountPendingJobs(a.id).length) {
        continue;
      }
      sync(a.id, a.folder);
    }
    seenState.set(key, next);
  }
}

function handleBadgeActivity(message) {
  if (message.phase === 'end') {
    // The real check includes everything the predictions guessed; badge-side
    // predictions reset so the numbers snap to server truth (the worker
    // clears its own overlay on the same event).
    counters.clearBadgeDeltas();
    lastBadgeResult = message.result;
    setFavicon(faviconState(message.result));
    handleMailSync(message.result);
  }
  else if (message.phase === 'error') {
    setFavicon('blue');
  }
}

// ---- wiring ---------------------------------------------------------------

// One filter pass per client open. Accounts without a usable password yet
// are skipped silently by the worker; once the user signs in, the password
// lands in session storage and the badge's storage listener re-runs the
// check (filters first) on its own.
async function runOnOpen() {
  try {
    await chrome.runtime.sendMessage({type: 'filters-check'});
  }
  catch {
    // worker unreachable; the alarm-driven checks still filter
  }
}

function initFilters() {
  counters.subscribe(faviconTick);
  seedFavicon();
  window.addEventListener('dir-selected', e => {
    const detail = e.detail;
    if (detail?.accountId && detail?.name) {
      selected = {accountId: detail.accountId, name: detail.name};
    }
  });
  chrome.runtime.onMessage.addListener(message => {
    if (message?.type !== 'activity') {
      return;
    }
    if (message.source === 'filters') {
      handleFiltersActivity(message);
    }
    else if (message.source === 'badge') {
      handleBadgeActivity(message);
    }
  });
  runOnOpen();
}

export {initFilters};
