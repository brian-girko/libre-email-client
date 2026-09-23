// bridge.mjs — the refcounted host of the ws->tls bridge. Everything that
// needs chrome.runtime.connectNative (the com.add0n.node sandbox boot) lives
// HERE and only here; whoever wants the endpoint asks this module — directly
// (same JS context, e.g. the service worker) or over chrome.runtime messages
// (the offscreen sync engine receives the ready ws:// url from the worker).
//
// The bridge is shared: any number of modules (two different sync jobs, the
// mail client, ...) may hold a ref at the same time and still get the same
// sandbox server. A ref is just a string key:
//
//   const {url} = await acquire('sync-a');   // boots it on the first ref
//   ...
//   release('sync-a');                       // ref gone; the bridge drops
//                                            // only when the LAST ref goes
//
// It only needs the native port at boot: the sandbox keeps its ws server
// alive as long as the extension context that holds the port is alive, so
// the service worker must stay running while bridged (offscreen keeps it
// awake with 'sync-bridge-ping' messages).
//
// On the last release the bridge is dropped after a short idle grace, so a
// job that ends just as the next one starts doesn't pay a second boot. An
// unexpected sandbox death clears the live state (a late release becomes a
// no-op and the next acquire reboots from scratch).
//
//   acquire(key) → {ok, url}   boot or reuse the live one
//   release(key) → true        drop one ref; may tear down after the grace
//   bridgeUrl()  → the current url or null
//   bridgeAlive() → whether a bridge (or a boot) is holding native refs

'use strict';

import {startWsTlsBridge} from '/core/native/ws-bridge-client.mjs';
import {dlog} from '/core/debug-log.mjs';

const NATIVE_HOST = 'com.add0n.node';
const GRACE_MS = 30000;         // last-ref grace before the sandbox detach

let bridge = null;            // {url, detach} while alive
let booting = null;           // Promise while boot is in flight
let refs = new Set();         // live ref keys
let graceTimer = null;        // pending drop after the last release

function cancelGrace() {
  if (graceTimer) {
    clearTimeout(graceTimer);
    graceTimer = null;
  }
}

async function boot() {
  let live = null;            // the handle this boot owns
  const handle = await startWsTlsBridge(ev => {
    dlog('bridge', '[bridge] ' + (ev?.kind || '') + ': ' + (ev?.message || ''));
    // sandbox death (crash, SW-killed port): clear the live state so a late
    // release becomes a no-op and the next acquire reboots from scratch
    if (ev?.kind === 'down' && live && bridge === live) {
      bridge = null;
      dlog('bridge', '[bridge] sandbox died: refs stay, next acquire reboots');
    }
  });
  live = handle;
  const {url} = handle;
  bridge = {
    url,
    detach: handle.detach
  };
  dlog('bridge', '[bridge] serving ' + url);
  return {ok: true, url};
}

/** one shared bridge, count of refs decides its lifetime */
async function acquire(key = 'default') {
  if (!refs.has(key)) {
    refs.add(key);
  }
  cancelGrace();              // anything re-acquiring cancels the teardown
  if (bridge) {
    return {ok: true, url: bridge.url};
  }
  if (!booting) {
    dlog('bridge', '[bridge] booting (for ' + key + ')');
    booting = boot();
    booting.finally(() => {
      booting = null;
    });
  }
  return booting;
}

/** the last live ref dropped → schedule the teardown after the grace */
async function release(key = 'default') {
  if (refs.has(key)) {
    refs.delete(key);
  }
  if (refs.size > 0) {
    return true;
  }
  const drop = async () => {
    graceTimer = null;
    if (booting) {            // a boot in flight: let it settle, then drop
      try {
        await booting;
      }
      catch {}
      release(key);
      return;
    }
    if (!bridge) {
      return;
    }
    try {
      await bridge.detach();
    }
    catch {}
    bridge = null;
    dlog('bridge', '[bridge] dropped (idle)');
  };
  if (!graceTimer) {
    graceTimer = setTimeout(drop, GRACE_MS);
  }
  return true;
}

function bridgeUrl() {
  return bridge?.url ?? null;
}

function bridgeAlive() {
  return !!(bridge || booting || refs.size > 0);
}

export {
  acquire,
  release,
  bridgeUrl,
  bridgeAlive
};
