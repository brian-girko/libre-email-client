'use strict';

// Refcounted singleton for the internal ws->tcp bridge (com.add0n.node).
// Like a wake lock: the first request() starts the bridge, the last
// release() stops it. All createMailApi instances share this one service.
//
// When the 'ws.mode' pref is 'external' the internal service is not needed;
// request() simply resolves with the configured 'ws.url' and release() no-ops.

import {ws} from '/core/ws-to-tls/core.mjs';

const config = {
  token: 'this.is.a.token'
  // no dial target here: createMailApi sends {op:'open', host, port} per
  // connection, so one shared bridge serves any number of accounts
};

let count = 0;
let urlPromise = null;

function start(debug) {
  const p = new Promise((resolve, reject) => {
    let settled = false;
    ws.start({
      ...config,
      debug,
      ready(o) {
        settled = true;
        resolve(o.url);
      },
      log(o) {
        if (debug) {
          console.log('ws log', o);
        }
      }
    }).catch(e => {
      if (!settled) {
        settled = true;
        reject(e);
      }
    });
  });
  // allow a fresh start after a failed one
  p.catch(() => {
    if (urlPromise === p) {
      urlPromise = null;
      count = 0;
    }
  });
  return p;
}

async function request() {
  const prefs = await chrome.storage.local.get({
    'ws.mode': 'native',
    'ws.url': '',
    'ws.debug': false
  });
  if (prefs['ws.mode'] === 'external') {
    if (prefs['ws.debug']) {
      console.log('ws-manager: external mode', prefs['ws.url']);
    }
    return prefs['ws.url'];
  }
  count += 1;
  if (prefs['ws.debug']) {
    console.log('ws-manager: requests', count);
  }
  if (count === 1) {
    // debug only applies when the bridge starts (first request wins)
    urlPromise = start(prefs['ws.debug']);
  }
  return urlPromise;
}

async function release() {
  const {'ws.mode': mode, 'ws.debug': debug} = await chrome.storage.local.get({
    'ws.mode': 'native',
    'ws.debug': false
  });
  if (mode === 'external' || count === 0) {
    return;
  }
  count -= 1;
  if (debug) {
    console.log('ws-manager: requests', count);
  }
  if (count === 0) {
    urlPromise = null;
    if (debug) {
      console.log('ws-manager: bridge stopped');
    }
    try {
      ws.stop();
    }
    catch {
      // the native port may already be gone
    }
  }
}

export {request, release};
