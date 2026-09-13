'use strict';

// One best-effort activity channel from the service worker to open client
// pages. Messages are `{type: 'activity', source, phase, ...}`:
//   source 'badge'   phase 'start' | 'end'   (badge check status/sync)
//   source 'filters' phase 'start' | 'progress' | 'end' (filter pass)
// The client bridge (data/client/filters.mjs) routes them into the unified
// logger. There is usually no receiver (background passes with no client
// open); sendMessage rejects then and the rejection is swallowed.
export function emitActivity(payload) {
  try {
    chrome.runtime.sendMessage({type: 'activity', ...payload}).catch(() => {});
  }
  catch {
    /* no receiver / API unavailable */
  }
}
