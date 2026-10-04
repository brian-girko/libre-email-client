'use strict';

// The open folder's guarded in-place reconcile — the callable the fs-event
// router (data/client/fs-events.mjs) invokes as its mails-view(delta) op.
// The guards live here because they are view-state, not classification:
//   - not while search results are shown (runSearch owns the list view),
//   - not while the star picker's popover is open (the in-place sync
//     reconciles rows by key and a star-color change reaches exactly the
//     starred row — rebuilding its host element would detach the popover;
//     the optimistic applyFlags already shows the right state).
// The deferral state machine (latched deferral, bounded retry, forced
// flush) lives in list-reconcile.mjs — injectable and unit-tested there.
// The search guard stays a plain drop — search mode clears through
// clearSearch() → load(), which re-renders the folder from disk in full.

import {isSearching, syncCurrent} from './list.mjs';
import {starPickerOpen} from './components/star-toggle.js';
import {createReconciler} from './list-reconcile.mjs';

// ---- folder sync decisions --------------------------------------------------

const {reconcile} = createReconciler({
  syncCurrent,   // list.mjs's own guards absorb stale folder targets
  starOpen: starPickerOpen,
  searching: isSearching,
  log: note => console.log('[filters] ' + note)
});
const reconcileOpenFolder = reconcile;

// ---- wiring -----------------------------------------------------------------

function initFilters() {
  // no state to mirror: the folder/account identity lives in list.mjs
  // (syncCurrent guards accountId/dirName/search itself)
}

export {initFilters, reconcileOpenFolder};
