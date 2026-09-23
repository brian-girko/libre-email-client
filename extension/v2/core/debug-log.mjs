// debug-log.mjs — the worker-context debug switches behind the options
// page's Debugging checkboxes (offscreen.debug / bridge.debug /
// scheduler.debug, all default false). The switches are read FRESH from
// chrome.storage.local on every call: a service worker restarts lose all
// memory, and a checkbox flip must land on the next log line, not "after
// the next restart".
//
//   debugOn(name) → Promise<boolean>   is the `<name>.debug` flag on?
//   dlog(name, ...args)               gated console.log (fire-and-forget)
//
// Cheap by design: one storage.get of one key per call, no caching —
// these traces fire at most a few times a minute. Failures (no storage
// API, storage blew up) resolve false so logging can never break a run.

'use strict';

async function debugOn(name) {
  try {
    const res = await chrome.storage.local.get(name + '.debug');
    return res[name + '.debug'] === true;
  }
  catch {
    return false;
  }
}

function dlog(name, ...args) {
  debugOn(name).then(on => {
    if (on) {
      console.log(...args);
    }
  }).catch(() => {});
}

export {debugOn, dlog};
