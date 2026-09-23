// core/offscreen.mjs — the single shared offscreen document, worker-side.
//
// Chrome runs at most ONE offscreen document per extension, so every module
// that needs a page-like context (the sync IMAP engine, the badge counter)
// boots the same document: /offscreen/index.html. That document owns its own
// shutdown (its manager closes itself via window.close() once no module has
// work left); this helper only brings it up and tears it down on demand:
//
//   ensure(key)   → resolves once the document exists and has handshaken
//                   ('offscreen-ready'). key is advisory (which module asked)
//                   — no refcount lives here because the document closes
//                   itself, and a lapsed document is simply re-created on the
//                   next acquire.
//   closeNow()    → force close, tearing down the document (and with it every
//                   running module job) regardless of state; used by the
//                   sync Stop button AND by the graceful path: the document's
//                   manager broadcasts 'offscreen-close' once every module is
//                   idle (renderer timers are throttled, message delivery is
//                   not, so the worker is the dependable closer).
//                   Recreating afterwards is safe.

'use strict';

import {dlog} from '/core/debug-log.mjs';

const OFFSCREEN_URL = 'offscreen/index.html';

let creating = null;          // Promise while the doc is being created + handshake

function hasOffscreen() {
  return chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)]
  }).then(contexts => contexts.length > 0)
    .catch(() => false);
}

/** resolves once the fresh offscreen doc broadcast 'offscreen-ready' (10s) */
function waitForReady() {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.runtime.onMessage.removeListener(listener);
      reject(new Error('offscreen document did not come up'));
    }, 10000);
    const listener = msg => {
      if (msg?.type === 'offscreen-ready') {
        clearTimeout(timer);
        readyGen = msg?.gen ?? null;
        chrome.runtime.onMessage.removeListener(listener);
        resolve();
      }
    };
    chrome.runtime.onMessage.addListener(listener);
  });
}

// generation stamp of the document this worker generation armed (null once
// closed) — graceful close requests from an OLD doc must not tear a fresh
// one down
let readyGen = null;

// The document decides its own life (it closes itself when every module is
// idle, and the worker only learns of that through 'offscreen-close'), so
// hasOffscreen() is the source of truth on EVERY acquire — no memo may ever
// claim the doc exists beyond its actual lifetime.
async function ensure(_key) {
  if (await hasOffscreen()) {
    return true;
  }
  if (!creating) {
    creating = (async () => {
      const ready = waitForReady();   // armed first: the ready broadcast races us
      try {
        await chrome.offscreen.createDocument({
          url: OFFSCREEN_URL,
          reasons: ['DOM_SCRAPING'],
          justification: 'Shared offscreen host (sync engine + badge counter; no UI)'
        });
      }
      catch (e) {
        if (!String(e?.message || e).includes('single offscreen document')) {
          throw e;
        }
        // created concurrently; tolerate the race
      }
      await ready;
      return true;
    })();
    dlog('offscreen', '[offscreen] acquiring the shared document');
  }
  const known = await creating;
  creating = null;   // settled: the next acquire re-checks reality from scratch
  return known;
}

/** the generation of the document armed by this worker incarnation (or null) */
function activeGen() {
  return readyGen;
}

async function closeNow() {
  if (await hasOffscreen()) {
    try {
      await chrome.offscreen.closeDocument();
    }
    catch {}
  }
  // the memo must not claim the doc still exists after this
  creating = null;
  readyGen = null;
}

export {ensure, closeNow, activeGen};
