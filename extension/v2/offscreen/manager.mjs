// manager.mjs — the offscreen host document's router and lifecycle owner.
//
// Chrome allows ONE offscreen document per extension, so sync (the IMAP
// engine, data/sync/offscreen/offscreen.mjs) and the local badge counter
// (data/badge/offscreen.mjs) share this page. The manager:
//
//   routing  — every chrome.runtime.onMessage that reaches this document goes
//              through the manager; the exact message types the two modules
//              own are listed in ROUTES. Anything else is ignored. A module's
//              script is lazily import()ed on its first routed message; an
//              unloaded module costs nothing in memory or startup. Each
//              module exports two hooks instead of registering its own
//              listeners:
//        handle(msg) — a routed message; returns its response (or a
//                      Promise of it), undefined when nothing answers
//        onGatePort(port)     — a runtime port named 'sync-confirm'
//              (the gate channel; the manager registers onConnect once and
//              hands the ports over, since a module loaded long after the
//              port connected otherwise never sees it).
//
//   close    — this document owns its own shutdown. Every module job routed
//              touches lastJob; a module tells the manager it has no work
//              left by broadcasting (sync-close after its job queue drains,
//              badge-idle once the count result went out — a module that has
//              never loaded is idle by definition). When EVERY loaded module
//              is idle and the grace period has passed with no new job, the
//              manager closes the document itself: window.close() is the
//              supported self-close path for offscreen documents. Destruction
//              from outside (the worker's sync-kill path uses
//              chrome.offscreen.closeDocument()) bypasses all of this.
//
//   handshake— the worker waits for {type:'offscreen-ready'} after creating
//              the document; the manager broadcasts it exactly once at boot.
//
// Outbound traffic (sync-log, sync-jobs, badge-result, …) is sent by the
// modules through chrome.runtime.sendMessage broadcasts and never passes
// through here.

'use strict';

const GRACE_MS = 3000;

// every incarnation of this document restarts the generation stamp (same
// pattern as the engine's log viewer)
const BOOT_GEN = Date.now();

// one routing entry per module; a module loads when its ROUTES set or a
// 'sync-confirm' gate port (sync only) first matches. Only `busy` types
// mark the module as working — routing churn like a panel's sync-ui-init
// log read must NOT hold the document open (only the module itself, via
// its idle signal, decides when it is done).
const ROUTES = [
  {
    key: 'sync',
    url: '../data/sync/offscreen/offscreen.mjs',
    types: new Set(['sync-job', 'sync-ui-init', 'sync-stop', 'sync-confirm',
      'sync-job-drop']),
    busy: new Set(['sync-job', 'sync-stop']),
    ports: 'sync-confirm'
  },
  {
    key: 'badge',
    url: '../data/badge/offscreen.mjs',
    types: new Set(['badge-job']),
    busy: new Set(['badge-job']),
    ports: null
  }
];

const loading = new Map();    // key -> Promise<module>
const byType = new Map();     // runtime message type -> route

for (const route of ROUTES) {
  for (const type of route.types) {
    byType.set(type, route);
  }
}

function ensureModule(route) {
  if (!loading.has(route.key)) {
    loading.set(route.key, import(route.url));
  }
  return loading.get(route.key);
}

// ---------------------------------------------------------------- activity
//
// idle bookkeeping: a route is idle when nothing of its kind may be in
// flight (initially true; a routed job marks it busy; the module's explicit
// close/idle message returns it to idle)

const idle = {sync: true, badge: true};
let lastJob = 0;
let closing = null;

/** low-volume lifecycle trace, printed by the worker (one console) */
function trace(ev, key, extra) {
  chrome.runtime.sendMessage({
    type: 'offscreen-debug',
    ev,
    key,
    extra: extra ?? null,
    gen: BOOT_GEN
  }).catch(() => {});
}

function touch(route) {
  idle[route.key] = false;
  lastJob = Date.now();
  trace('busy', route.key);
  evaluate();
}

function markIdle(key) {
  idle[key] = true;
  trace('idle', key);
  evaluate();
}

// Modules cannot hear their own broadcasts, so the idle signal travels
// through this synchronous hook instead of a message. Exposed on the global
// (one document, two module scripts): a module calls
// globalThis.__offscreen.idle(key) exactly when it emitted the matching
// idle broadcast (sync-close / badge-idle), so the two stay in sync.
globalThis.__offscreen = {
  idle: markIdle,
  busy: key => {
    const route = ROUTES.find(r => r.key === key);
    if (route) {
      touch(route);
    }
  }
};

function evaluate() {
  clearTimeout(closing);
  closing = null;
  if (!ROUTES.every(route => idle[route.key])) {
    return;
  }
  const rest = Math.max(0, lastJob + GRACE_MS - Date.now());
  trace('close-armed', null, rest);
  closing = setTimeout(() => {
    closing = null;
    trace('close-fired', null);
    // The dependable closer is the SERVICE WORKER (message delivery is
    // never throttled; the hidden renderer's timers are). window.close()
    // below stays as the belt-and-braces fallback for a worker that is not
    // listening anymore.
    chrome.runtime.sendMessage({type: 'offscreen-close', gen: BOOT_GEN})
      .catch(() => window.close());
    setTimeout(() => window.close(), 1000);
  }, rest);
}

// ---------------------------------------------------------------- dispatch

chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  const route = byType.get(msg?.type);
  if (!route) {
    return false;   // not ours: sync-log/js broadcasts, dirty reports, …
  }
  if (route.busy.has(msg.type)) {
    touch(route);
  }
  ensureModule(route).then(mod => {
    // handle() may settle async (a badge count walks the tree); the same
    // Promise the module returns settles the caller's sendMessage
    return Promise.resolve(mod.handle(msg))
      .catch(e => ({ok: false, error: (e?.message || String(e))}));
  }).then(result => {
    respond(result);
  }).catch(e => {
    console.error('[offscreen] module', route.key, 'failed to load:', e);
    // a module that never loaded is idle by definition — no busy-leak;
    // drop the memo so the NEXT routed message re-imports it
    loading.delete(route.key);
    markIdle(route.key);
    respond({ok: false, error: 'module failed to load: ' + (e?.message || e)});
  });
  return true;      // async respond
});

// The gate channel: a sync panel (any page) may open its 'sync-confirm' port
// long before the engine module loads, and a port cannot be re-delivered.
// The manager accepts every such port up front; when the sync module loads
// (now or later) it receives them all plus every future one.
chrome.runtime.onConnect.addListener(port => {
  const route = ROUTES.find(r => r.ports === port.name);
  if (!route) {
    return;
  }
  ensureModule(route).then(mod => {
    if (typeof mod.onGatePort === 'function') {
      mod.onGatePort(port);
    }
  }).catch(e => {
    console.error('[offscreen] gate module', route.key, 'failed to load:',
      e?.message || e);
  });
});

// one handshake for the whole document; the worker resolves acquire() on it
chrome.runtime.sendMessage({
  type: 'offscreen-ready',
  gen: Date.now()
}).catch(() => {});

// a module can honestly say it is idle from the very start (a module that
// never loaded counts as idle), but the document was created on purpose —
// the creator's first job is already on its way: the boot moment stands in
// for that job's timestamp, so the countdown burns the grace period and a
// creation that leads nowhere dies quickly
lastJob = Date.now();
trace('boot', null);
evaluate();
