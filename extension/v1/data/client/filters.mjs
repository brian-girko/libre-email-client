'use strict';

// Client-side filters/sync bridge. The engine runs in the service worker
// (worker filters.mjs + core/filters/engine.mjs): enabled filters are applied
// by the engine's pre-pass hook before every sync copies anything into the
// mirror, so folder lists show post-filter mail without a per-page trigger
// (the options page keeps its explicit "Run filters now" button).
//
// This module is the client end of the worker's 'activity' channel and feeds
// the unified logger:
//   - source 'filters' -> read-only log lines with progress
//     ("Filtering (Work): 2/10 · 1 moved").
//   - source 'badge'   -> no log output; only the favicon rides these events
//     (mirrors the action icon).

import {isSearching, sync} from './list.mjs';
import {mirrorChanged} from './local-api.mjs';
import * as logger from './logger.mjs';

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
// means an all-accounts pass: any open folder may be affected. Not while
// search results are shown. A slightly older worker (mid page/worker reload)
// sends no uid detail: fall back to the inherited conservative check —
// reconcile when the open folder is an INBOX, the only folder the engine
// ever acts on.
function passTouchesOpenFolder(accountId, changes) {
  if (!selected || isSearching()) {
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
// The last real check result drives the favicon; the mirror-only recount
// after actions keeps it true without a server pass.
let lastBadgeResult = null;

function faviconState(result) {
  if (!result) {
    return 'blue';
  }
  const total = Math.max(0, Math.round(Number(result.total) || 0));
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
    const res = await chrome.storage.local.get('badge.last');
    lastBadgeResult = res?.['badge.last'] || null;
    setFavicon(faviconState(lastBadgeResult));
  }
  catch {
    // favicon stays at the static gray link when the state is unreadable
  }
}

// ---- mirror-driven in-place list sync -------------------------------------

// The engine broadcasts 'mirror-changed' through local-api.mjs whenever a
// sync pass, a replayed op or the post-op dir resync moved index data. When
// one of the touched folders is the folder open in the UI the list
// reconciles in place — precise: the event names exactly which folders
// moved. This is the regular update path for completed actions too (rows
// leave the view when their removal reaches the local copy). Not while
// search results are shown.
function handleMirrorChanged(evt) {
  const {accountId, dirs} = evt ?? {};
  if (!selected || !Array.isArray(dirs) || !dirs.length) {
    return;
  }
  if (accountId !== selected.accountId || isSearching()) {
    return;
  }
  if (!dirs.includes(selected.name)) {
    return;
  }
  sync(selected.accountId, selected.name);
}

function handleBadgeActivity(message) {
  if (message.phase === 'end') {
    lastBadgeResult = message.result;
    setFavicon(faviconState(message.result));
  }
  else if (message.phase === 'error') {
    setFavicon('blue');
  }
}

// ---- wiring ---------------------------------------------------------------

// The client-opening sync (reason client_open) already runs the worker's
// filter pre-pass before it copies anything into the mirror; the options
// page's "Run filters now" button keeps its explicit filters-check trigger.
// Nothing to fire here; accounts without a usable password are skipped
// silently by the worker, and the password landing re-runs the check via
// the storage listener (filters first) on its own.
function initFilters() {
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
  mirrorChanged.subscribe(handleMirrorChanged);
}

export {initFilters};
