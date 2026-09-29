'use strict';

// The open folder's guarded in-place reconcile — the callable the fs-event
// router (data/client/fs-events.mjs) invokes as its mails-view(delta) op.
// The guards live here because they are view-state, not classification:
//   - not while search results are shown (runSearch owns the list view),
//   - not while the star picker's popover is open (the in-place sync
//     reconciles rows by key and a star-color change reaches exactly the
//     starred row — rebuilding its host element would detach the popover;
//     the optimistic applyFlags already shows the right state, the next
//     reconcile lands normally).

import {isSearching, sync} from './list.mjs';
import {starPickerOpen} from './components/star-toggle.js';

let selected = null; // {accountId, name} of the open folder

// ---- folder sync decisions --------------------------------------------------

function reconcileOpenFolder() {
  if (!selected || isSearching() || starPickerOpen()) {
    return;
  }
  sync(selected.accountId, selected.name);
}

// ---- wiring -----------------------------------------------------------------

function initFilters() {
  window.addEventListener('dir-selected', e => {
    const detail = e.detail;
    if (detail?.accountId && detail?.name) {
      selected = {accountId: detail.accountId, name: detail.name};
    }
  });
}

export {initFilters, reconcileOpenFolder};
