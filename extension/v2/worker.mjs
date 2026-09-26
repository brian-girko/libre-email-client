// worker.mjs — MV3 module service worker (module SW).
//
// Jobs:
//   action click → picker page (unchanged)
//   offscreen acquisition → the sync engine and the badge counter both run
//   in the one shared offscreen document (/offscreen/index.html, hosted by
//   manager.mjs there); the doc imports each module on its first routed
//   message and closes ITSELF (window.close()) once every loaded module is
//   idle. This worker only creates the doc on demand via core/offscreen.mjs
//   (ensure() until the 'offscreen-ready' handshake) and force-closes it on
//   Stop: pages send {type:'sync-request'} and this worker ensures the doc
//   and forwards {type:'sync-job'}; {type:'sync-kill'} asks for a
//   goodbye-broadcast, closes the doc and force-releases the bridge ref the
//   killed run never returned. The offscreen broadcasts
//   {type:'sync-running'} on busy-state changes; log lines
//   ({type:'sync-log'}) never pass through this worker.
//   bridge hosting → the com.add0n.node ws->tls bridge is refcounted in
//   core/bridge.mjs; any module acquires a named ref over runtime messages
//   (bridge-acquire/bridge-release) and the bridge drops when the last ref
//   goes (after a short idle grace).
//
// No file access, no storage logic here. Log lines never pass through the
// worker: they live in the engine's local var, streamed over ports.

'use strict';

import {acquire, release} from '/core/bridge.mjs';
import {ensure, closeNow, activeGen} from '/core/offscreen.mjs';
import {markSynced, clearSynced, loadGatePrefs} from '/data/sync/client/accounts.mjs';
import {loadFilters} from '/data/sync/filters/route.mjs';
import {dlog} from '/core/debug-log.mjs';
// side-effect imports: /dirty.mjs registers its own runtime listener — the
// resync bookkeeping (dirs that need a server sync) lives there, not in
// the switch below; /badge.mjs owns every badge-trigger listener and
// drives the toolbar badge (the counter itself rides the SAME offscreen
// document, data/badge/offscreen.mjs — its close is the doc's own doing);
// /sync-scheduler.mjs own alarm wiring feeds the same ensure()+'sync-job'
// handoff the page-visible flow uses
import '/dirty.mjs';
import '/context.mjs';
import '/badge.mjs';
import '/sync-scheduler.mjs';

chrome.action.onClicked.addListener(tab => {
  chrome.tabs.create({
    url: chrome.runtime.getURL('data/picker/index.html'),
    openerTabId: tab?.id
  });
});

// ---------------------------------------------------------------- offscreen
//
// The single shared offscreen document (/offscreen/index.html, manager.mjs)
// hosts both the sync engine and the badge counter and closes ITSELF when
// every module is idle. Here the worker only acquires it (create + wait for
// the manager's ready handshake) and force-closes it on the Stop path.

// There is no chrome.storage in an offscreen document, so the engine
// reports run results over runtime messages and this worker stamps
// sync.lastSyncAt.<id> (the addresses in places that do have storage):
//
//   'sync-synced' {accountId, finishedAt}  — finishedAt set: stamp it;
//     null (the discard path): remove the stamp so the next run re-pulls
chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  switch (msg?.type) {
    // a sync job: make sure the shared offscreen doc exists, then hand the
    // job over as 'sync-job' (its response settles the page's own). Opening
    // a sync panel never routes here — only actual job requests do.
    //
    // Post-sync filters are DEFAULT-ON here: the engine cannot read
    // chrome.storage, so the stored filter list rides in every forwarded
    // job and the engine applies it to the run's new INBOX pulls — the
    // only opt-out is the sync interface's own submissions (bare: true;
    // its filter row stays manual). Non-INBOX scopes / dry runs / discard
    // harmlessly carry filters: the engine's guard never runs the pass
    // for them.
    //
    // The stored gate preferences (sync-ui.purge / sync-ui.drop) ride
    // along the same way: when the run's gates are answered headless
    // (no panel connected within the grace window), the stored
    // 'Purge from server' / 'Drop local dir' choice stands in — an open
    // panel answering over its port still wins.
    case 'sync-request': {
      const withFilters = msg?.bare === true
        ? Promise.resolve(null)
        : loadFilters().then(list =>
            (Array.isArray(list) && list.length) ? list : null)
          .catch(() => null);
      ensure('sync')
        .then(() => Promise.all([withFilters, loadGatePrefs().catch(() => null)]))
        .then(([filters, prefs]) => chrome.runtime.sendMessage({
          ...msg,
          type: 'sync-job',
          ...(filters ? {filters} : {}),
          ...(prefs ? {prefs} : {})
        }))
        .then(res => respond(res ?? {ok: false, error: 'engine did not answer'}))
        .catch(e => respond({ok: false, error: e?.message || String(e)}));
      return true;
    }
    // drop ONE pending job by rid (the panel's queue list): the engine
    // removes that pending entry and re-broadcasts 'sync-jobs'. No doc up
    // means no queue — there is nothing to drop.
    case 'sync-job-drop': {
      if (typeof msg?.rid !== 'string' || !msg.rid) {
        respond({ok: false, error: 'missing rid'});
        return true;
      }
      chrome.runtime.sendMessage({type: 'sync-job-drop', rid: msg.rid})
        .then(res => respond(res ?? {ok: false, error: 'engine did not answer'}))
        .catch(() => respond({ok: true, dropped: false, reason: 'not-queued'}));
      return true;
    }
    // the interface's Stop button: let the offscreen broadcast its goodbye
    // to every open panel, then force-tear the doc (current job included)
    // down. The killed run never gets to return its bridge ref — drop it
    // here. Badge jobs die with the document; the next trigger re-acquires.
    case 'sync-kill':
      (async () => {
        try {
          const res = await chrome.runtime
            .sendMessage({type: 'sync-stop'})
            .catch(() => null);   // no document up: nothing to kill
          return {ok: true, dropped: res?.dropped};
        }
        finally {
          await closeNow();
          await release('sync').catch(() => {});
        }
      })().then(respond).catch(e => respond({ok: false, error: e?.message || String(e)}));
      return true;
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
    // the shared document's manager decided every module is idle: the
    // dependable closer lives here, since message delivery is never
    // throttled while the hidden renderer's timers are
    case 'offscreen-close':
      if (msg?.gen === activeGen()) {
        // only tear down a document THIS worker armed — a stale broadcast
        // from a previous incarnation must not kill a fresh doc
        closeNow();
      }
      return false;
    case 'offscreen-debug':
      dlog('offscreen', '[offscreen]', msg?.ev, msg?.key ?? '', msg?.extra ?? '');
      return false;
    // the engine pings every 20s during a run: resets the SW idle timer so
    // the native port (and the sandbox behind it) survive the whole run
    case 'sync-bridge-ping':
      respond({ok: true});
      return false;
    // engine broadcasts (this worker only notes them; pages listen direct);
    // close is NOT driven here: /offscreen/manager.mjs owns the document's
    // lifecycle (sync-close marks the sync module idle for it); the bridge
    // has its own refcount — see core/bridge.mjs — not this flag
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
    // the engine's survey learned the account's hierarchy delimiter:
    // persist it so the options page stores filter folder paths in the
    // server's own spelling and the panel seeds its stores with the same
    // value. Fire-and-forget, like the broadcast that carried it here.
    case 'sync-delimiter': {
      const id = msg.accountId;
      const d = msg.delimiter;
      if (typeof id === 'string' && id &&
          typeof d === 'string' && d.length === 1 && d !== '%') {
        chrome.storage.local.set({['sync.delimiter.' + id]: d})
          .catch(e => console.log('[sync] delimiter stamp failed: ' + (e?.message || e)));
      }
      return false;
    }
    default:
      return false;          // sync-ui-init / sync-confirm / sync-log / sync-close → offscreen + pages
  }
});
