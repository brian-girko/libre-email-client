'use strict';

// Local-only client's list reconcile bridge. There are no worker filter or
// badge passes anymore; this module is one thin piece:
//   - the mirror-driven in-place list sync: every local mutation reports
//     exactly which folders changed, and the open folder reconciles in
//     place when one of them is the one the user is reading.

import {isSearching, sync} from './list.mjs';
import {mirrorChanged} from './local-api.mjs';

let selected = null; // {accountId, name} of the open folder

// ---- folder sync decisions --------------------------------------------------

// Trigger the in-place reconcile for the open folder after a mutation that
// touched it. Not while search results are shown.
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

// ---- wiring -----------------------------------------------------------------

function initFilters() {
  window.addEventListener('dir-selected', e => {
    const detail = e.detail;
    if (detail?.accountId && detail?.name) {
      selected = {accountId: detail.accountId, name: detail.name};
    }
  });
  mirrorChanged.subscribe(handleMirrorChanged);
}

export {initFilters};
