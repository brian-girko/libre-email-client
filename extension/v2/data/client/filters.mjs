'use strict';

// The open folder's guarded in-place reconcile — the callable the fs-event
// router (data/client/fs-events.mjs) invokes as its mails-view(delta) op.
// The guards live here because they are view-state, not classification:
//   - not while search results are shown (runSearch owns the list view),
//   - not while the star picker's popover is open (the in-place sync
//     reconciles rows by key and a star-color change reaches exactly the
//     starred row — rebuilding its host element would detach the popover;
//     the optimistic applyFlags already shows the right state).
// Deferral, not dropping: a guard that merely swallowed the reconcile with
// nothing to re-arm it left the mails view stale until a manual refresh
// (the star-palette popover outliving its folder's only move/delete event).
// The search guard stays a plain drop — search mode clears through
// clearSearch() → load(), which re-renders the folder from disk in full.

import {isSearching, syncCurrent} from './list.mjs';
import {starPickerOpen} from './components/star-toggle.js';

const RETRY_MS = 250;

let deferred = false;   // a reconcile is owed once the popover closes
let retryTimer = null;

function flushDeferred() {
  clearTimeout(retryTimer);
  retryTimer = null;
  if (!deferred) {
    return;
  }
  if (starPickerOpen()) {
    scheduleRetry();   // palette still open — keep owing, keep retrying
    return;
  }
  deferred = false;
  syncCurrent();   // list.mjs's own guards absorb stale folder targets
}

function scheduleRetry() {
  if (!retryTimer) {
    retryTimer = setTimeout(flushDeferred, RETRY_MS);
  }
}

// ---- folder sync decisions --------------------------------------------------

function reconcileOpenFolder() {
  if (starPickerOpen()) {
    // deferred: the row this delta would touch may host the open popover;
    // flush once it closes (bounded retry while it stays open)
    if (!deferred) {
      console.log('[filters] list reconcile deferred — star picker open');
    }
    deferred = true;
    scheduleRetry();
    return;
  }
  if (isSearching()) {
    return;   // self-healing: clearSearch() → load() re-renders from disk
  }
  // a latched deferral rides along on this flush — identical folder re-diff
  deferred = false;
  clearTimeout(retryTimer);
  retryTimer = null;
  syncCurrent();
}

// ---- wiring -----------------------------------------------------------------

function initFilters() {
  // no state to mirror: the folder/account identity lives in list.mjs
  // (syncCurrent guards accountId/dirName/search itself)
}

export {initFilters, reconcileOpenFolder};
