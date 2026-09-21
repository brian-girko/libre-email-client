// worker.mjs — MV3 module service worker (module SW).
//
// Three jobs:
//   action click → picker page (unchanged)
//   sync offscreen lifecycle → the sync engine runs directly in a hidden
//   offscreen document (data/sync/offscreen/offscreen.html): no UI. Opening a sync
//   panel must NOT boot the document — it only exists while jobs are
//   queued. Pages send {type:'sync-request'} and this worker creates the
//   doc on demand, waits for its 'sync-ready' handshake and forwards the
//   job ({type:'sync-job'}); the offscreen enqueues and runs them
//   one-by-one, and when its job list runs empty it asks {type:'sync-close'}
//   to be closed again. {type:'sync-kill'} (the interface's Stop button)
//   asks the offscreen for a goodbye-broadcast, then closes the doc and
//   force-releases the bridge ref the killed run never returned. The
//   offscreen broadcasts {type:'sync-running'} whenever the busy state
//   changes; log lines ({type:'sync-log'}) never pass through this worker.
//   bridge hosting → the com.add0n.node ws->tls bridge is refcounted in
//   core/bridge.mjs; any module acquires a named ref over runtime messages
//   (bridge-acquire/bridge-release) and the bridge drops when the last ref
//   goes (after a short idle grace).
//
// No file access, no storage logic here. Log lines never pass through the
// worker: they live in the engine's local var, streamed over ports.

'use strict';

import {acquire, release} from '/core/bridge.mjs';
import {markSynced, clearSynced} from '/data/sync/client/accounts.mjs';
import '/context.mjs';

const OFFSCREEN_URL = 'data/sync/offscreen/offscreen.html';
chrome.action.onClicked.addListener(tab => {
  chrome.tabs.create({
    url: chrome.runtime.getURL('data/picker/index.html'),
    openerTabId: tab?.id
  });
});

// ---------------------------------------------------------------- offscreen

let creating = null;   // Promise while the doc is being created + handshakes

function hasOffscreen() {
  return chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)]
  }).then(contexts => contexts.length > 0)
    .catch(() => false);
}

async function ensureOffscreen() {
  if (creating) {
    const known = await creating;
    if (known) {
      return true;
    }
    creating = null;   // stale memo: the doc was closed again, recreate
  }
  if (await hasOffscreen()) {
    creating = Promise.resolve(true);
    return true;
  }
  creating = (async () => {
    const ready = waitForReady();   // armed first: the ready broadcast races us
    try {
      await chrome.offscreen.createDocument({
        url: OFFSCREEN_URL,
        reasons: ['DOM_SCRAPING'],
        justification: 'Hidden IMAP sync engine (no UI, message relay only)'
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
  return creating;
}

/** resolves once the fresh offscreen doc says 'sync-ready' (10s timeout) */
function waitForReady() {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.runtime.onMessage.removeListener(listener);
      reject(new Error('offscreen sync document did not come up'));
    }, 10000);
    const listener = msg => {
      if (msg?.type === 'sync-ready') {
        clearTimeout(timer);
        chrome.runtime.onMessage.removeListener(listener);
        resolve();
      }
    };
    chrome.runtime.onMessage.addListener(listener);
  });
}

async function closeOffscreen() {
  if (await hasOffscreen()) {
    try {
      await chrome.offscreen.closeDocument();
    }
    catch {}
  }
  // the memo must not claim the doc still exists after this
  creating = null;
}

// There is no chrome.storage in an offscreen document, so the engine
// reports run results over runtime messages and this worker stamps
// sync.lastSyncAt.<id> (the addresses in places that do have storage):
//
//   'sync-synced' {accountId, finishedAt}  — finishedAt set: stamp it;
//     null (the discard path): remove the stamp so the next run re-pulls
chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  switch (msg?.type) {
    // a sync job: make sure the offscreen doc exists, then hand the job
    // over as 'sync-job' (its response settles the page's own). Opening a
    // sync panel never routes here — only actual job requests do.
    case 'sync-request':
      ensureOffscreen()
        .then(() => chrome.runtime.sendMessage({...msg, type: 'sync-job'}))
        .then(res => respond(res ?? {ok: false, error: 'engine did not answer'}))
        .catch(e => respond({ok: false, error: e?.message || String(e)}));
      return true;
    // the interface's Stop button: let the offscreen broadcast its goodbye
    // to every open panel, then tear the doc (current job included) down.
    // The killed run never gets to return its bridge ref — drop it here.
    case 'sync-kill':
      (async () => {
        try {
          if (await hasOffscreen()) {
            const res = await chrome.runtime.sendMessage({type: 'sync-stop'});
            return {ok: true, dropped: res?.dropped};
          }
          return {ok: true, dropped: 0};
        }
        finally {
          await closeOffscreen();
          await release('sync').catch(() => {});
        }
      })().then(respond).catch(e => respond({ok: false, error: e?.message || String(e)}));
      return true;
    // the offscreen's job list ran empty: it closes itself off
    case 'sync-close':
      closeOffscreen();
      return false;
    // worker/page capability; offscreen documents get the ready ws:// url
    // only. Refs are per-module keys; the bridge drops after the LAST
    // release plus the idle grace — 'sync-bridge-ensure' is the legacy
    // alias that maps a run to the fixed 'sync' key.
    case 'bridge-acquire':
    case 'sync-bridge-ensure':
      acquire(msg.type === 'sync-bridge-ensure' ? 'sync' : msg.key)
        .then(({url}) => respond({ok: true, url}))
        .catch(e => respond({ok: false, error: e?.message || String(e)}));
      return true;
    // run over: one ref gone (the legacy alias releases 'sync' too)
    case 'bridge-release':
    case 'sync-bridge-drop':
      release(msg.type === 'sync-bridge-drop' ? 'sync' : msg.key)
        .then(() => respond({ok: true}))
        .catch(e => respond({ok: false, error: e?.message || String(e)}));
      return true;
    // the engine pings every 20s during a run: resets the SW idle timer so
    // the native port (and the sandbox behind it) survive the whole run
    case 'sync-bridge-ping':
      respond({ok: true});
      return false;
    // engine broadcasts (this worker only notes them; pages listen direct);
    // close is NOT driven here: the offscreen decides, on an empty job
    // list, via 'sync-close'; the bridge has its own refcount — see
    // core/bridge.mjs — not this flag
    case 'sync-running':
      return false;
    case 'sync-synced': {
      const id = msg.accountId;
      if (!id) {
        return false;
      }
      (async () => {
        try {
          if (msg.finishedAt == null) {
            await clearSynced(id);
          }
          else {
            await markSynced(id, msg.finishedAt);
          }
        }
        catch (e) {
          console.log('[sync] lastSync stamp failed: ' + (e?.message || e));
        }
      })();
      return false;
    }
    default:
      return false;          // sync-ui-init / sync-confirm / sync-log → offscreen + pages
  }
});
