// offscreen.mjs — the sync engine, run directly in the offscreen document
// (data/sync/offscreen/offscreen.html). No UI:
// the whole interface is chrome.runtime messages.
//
//   sync-job       {kind:'sync'|'dry'|'sync-dir'|'dry-dir'|'discard'|
//                   'sync-dirs', account, dir?, dirs?} → {ok, queued} —
//                   the job ENQUEUES and runs after the previous one;
//                   never a 'busy' rejection. 'sync-dirs' runs one scoped
//                   sync per dir in its dirs array (one session, per-dir
//                   failures logged and skipped; lastSyncAt stamps only
//                   when every dir finished clean)
//   sync-stop                       → the kill path: drops the queued jobs,
//                   says goodbye to the sync-views (a final log broadcast
//                   they all receive) and lets the worker close this document
//   sync-confirm   {requestId, ok, reason} → answers a pending purge/drop
//                  gate (reason:'rejected' = explicit Keep/Cancel; answers
//                  arrive over the 'sync-confirm' port, sendMessage kept as
//                  a legacy fallback)
//   sync-ui-init                    → {ok, logs, running, label, …}
//
// Narration lives in a module-level local var (`logs`, ring buffer). It is
// streamed out with chrome.runtime.sendMessage: every open <sync-view>
// (any number of them at once) receives each batch and appends; a newly
// opened panel pulls the whole array with sync-ui-init. No ports, no
// storage: the log var dies with this document — by design.
//
// Confirm gates (askPurge / askDropDirectory) are answered by whatever page
// has a panel open; the answers travel over long-lived 'sync-confirm' ports
// (chrome.runtime.connect, opened by the panel, see client/sync-panel.mjs) —
// a port death is an interface closing, and if the LAST port goes the pending
// gate declines instantly; with no responder at all the gate waits out a
// generous timeout and auto-declines.
//
// Lifecycle: this document only exists while jobs are going. The worker
// creates it for the first 'sync-job' it forwards; when the job list runs
// empty this document asks the worker (sync-close) to close it again.

'use strict';

import {createClient} from './client.mjs';
import {bootSilent} from '../disk.mjs';
import {MaildirStore} from '../maildir.mjs';
import {createSync} from './sync.mjs';

// Everything that needs restricted chrome.* APIs lives elsewhere:
//   - account configs arrive IN the job (the client page resolves them;
//     the offscreen has no chrome.storage)
//   - the ws->tls bridge is booted by the service worker (core/bridge.mjs,
//     connectNative, refcounted per run) and handed over as a ws:// url
//   - sync.lastSyncAt stamping happens in the worker on 'sync-synced'

// ---------------------------------------------------------------- log var

const LOG_CAP = 1000;
const logs = [];              // {i, ts, type, content, cls} — i = monotonic index
let logSeq = 0;

// every incarnation of this document restarts logSeq at 0, so every entry
// carries a generation stamp too: viewers key their pauses on (gen, seq)
const BOOT_GEN = Date.now();

// ---------------------------------------------------------------- streaming

const PROTO = 1; // protocol stamp so stale listeners of older builds are dropped

let flushQueued = false;
const pending = [];           // not-yet-broadcast entries

let lastBroadcastError = 0;

/**
 * fire-and-forget: delivery must never depend on a responder existing;
 * failures are rate-limited so a broken channel stays visible without
 * spamming the console
 */
function emit(msg) {
  const fail = e => {
    const now = Date.now();
    if (now - lastBroadcastError >= 30000) {
      lastBroadcastError = now;
      console.error('[sync] broadcast failed (' + (msg?.type || '?') + '):',
        e?.message || e);
    }
  };
  try {
    chrome.runtime.sendMessage(msg).catch(fail);
  }
  catch (e) {
    fail(e);
  }
}

function engineLog(type, content, cls = '') {
  // sync.mjs's emitLog calls back as log({type, content, cls}) — accept the
  // single-object form too
  if (type && typeof type === 'object' && !Array.isArray(type)) {
    const entry = type;
    type = entry.type;
    content = entry.content;
    cls = entry.cls || '';
  }
  const entry = {
    i: logSeq++,
    ts: Date.now(),
    type: String(type || 'system'),
    content,
    cls
  };
  logs.push(entry);
  if (logs.length > LOG_CAP) {
    logs.splice(0, logs.length - LOG_CAP);
  }
  pending.push(entry);
  if (!flushQueued) {
    // microtask, not setTimeout: DOM timers are clamped hard in the
    // permanently-hidden offscreen renderer (≥1s, ~1/min after 5 min),
    // which stalls the log stream exactly during long pull runs
    flushQueued = true;
    queueMicrotask(() => {
      flushQueued = false;
      flush();
    });
  }
}

/** broadcast every structured log entry accumulated so far to open views; */
function flush() {
  if (!pending.length) {
    return;
  }
  const lines = pending.splice(0, pending.length)
    .map(({i: seq, ts, type, content, cls}) =>
      ({seq, ts, type, content, cls, gen: BOOT_GEN}));
  emit({type: 'sync-log', proto: PROTO, gen: BOOT_GEN, lines});
}

function broadcast(msg) {
  emit(msg);
}

// ---------------------------------------------------------------- gates

const CONFIRM_TIMEOUT = 90 * 1000;

// ------------------------------------------------- default decisions
// Sync must work with and without a UI. Every destructive/shape question
// goes to an open sync panel first; when there is no interface at all
// (or the user never answers) these defaults stand in — so the engine
// never hangs on a question nobody can answer.
const DECISIONS = {
  /** concurrent message fetches within one scheduling quantum */
  pullBatch: 8,
  /** messages taken from one folder before the next folder gets a turn */
  pullQuantum: 10,
  /** raw-message batches used only for cross-folder move detection */
  miningBatch: 50,
  /** a panel dead across an engine restart gets this long to reconnect
      before the headless default answers on the user's behalf */
  gateGraceMs: 2000,
  /** no UI: deleteServer ops (server purges) */
  noUiPurgeServer: false,
  /** no UI: dropLocal ops (whole local dirs of gone server folders) */
  noUiDropLocalDir: false
};

let pendingConfirm = null;    // {requestId, resolve({ok, value})}
const gatePorts = new Set();  // live 'sync-confirm' ports (one per open panel)
let gateSeq = 0;

/**
 * A gate answered by the page with a panel open; the panel's answer arrives
 * over its port, and when the LAST port dies (every interface closed) any
 * pending gate declines instantly. Every gate broadcast goes out EVEN when
 * nobody is connected: a panel can survive an engine restart (its port died
 * with the old document) — if no port (re)connects within
 * DECISIONS.gateGraceMs, the DECISIONS default answers on the user's behalf;
 * gates whose panel went silent still time out to a decline.
 */
async function askGate(kind, {ops, describe, count}) {
  const lines = ops.slice(0, 10).map(op => '   ' + describe(op)).join('\n');
  const more = ops.length > 10 ? `\n   … and ${count - 10} more` : '';
  const requestId = 'cfm-' + (++gateSeq);
  const text =
    (kind === 'purge'
      ? `Remove ${count} message${count === 1 ? '' : 's'} from the server?`
      : `Remove ${count} local dir${count === 1 ? '' : 's'}?`) +
    '\n\n' + lines + more + (more ? '' : '\n');
  engineLog('system',
    `(waiting for the ${kind} confirmation — answer in the open sync interface)` +
    (gatePorts.size ? '' : ` (nobody is connected yet — the default decision ` +
      (DECISIONS[kind === 'purge' ? 'noUiPurgeServer' : 'noUiDropLocalDir']
        ? '(proceed)' : '(decline)') + `stands in after ${DECISIONS.gateGraceMs / 1000}s)`)
  );
  const grantedDefault = DECISIONS[kind === 'purge' ? 'noUiPurgeServer' : 'noUiDropLocalDir'];
  return new Promise(resolve => {
    let settled = false;
    const settle = (ok, value) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      clearTimeout(graceTimer);
      if (pendingConfirm?.requestId === requestId) {
        pendingConfirm = null;
      }
      resolve(value === undefined ? !!ok : {ok: !!ok, value});
    };
    const timer = setTimeout(() => {
      resolveGate(false, `(${kind} gate timed out — declined automatically)`);
    }, CONFIRM_TIMEOUT);
    // a panel may survive an engine restart (its port died with the old
    // document): the request still goes out so the panel reconnects
    // immediately — the headless default only falls through when NO port
    // has (re)connected within the grace window
    const graceTimer = DECISIONS.gateGraceMs
      ? setTimeout(() => {
        if (!gatePorts.size) {
          resolveGate(grantedDefault,
            `(no sync interface connected within the grace window — ${kind} default decision: ${grantedDefault ? 'proceed' : 'decline'})`);
        }
      }, DECISIONS.gateGraceMs)
      : null;
    pendingConfirm = {
      requestId,
      kind,
      resolve: settle
    };
    broadcast({type: 'sync-confirm-req', requestId, kind, text});
  });
}

/** resolves the pending gate exactly once; logs `line` when narrating */
function resolveGate(ok, line, value) {
  if (!pendingConfirm) {
    return;
  }
  const resolve = pendingConfirm.resolve;
  pendingConfirm = null;
  resolve(ok, value);
  if (line) {
    engineLog('warn', line, 'warn');
  }
}

chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'sync-confirm') {
    return;
  }
  gatePorts.add(port);
  port.onMessage.addListener(msg => {
    if (msg?.type === 'sync-confirm' &&
        pendingConfirm?.requestId === msg.requestId) {
      // first valid reply wins; rejections narrate their own line, plain
      // approvals let sync.mjs's confirmed line ride
      const rejected = msg.reason === 'rejected' && !msg.ok;
       resolveGate(!!msg.ok, rejected
        ? '(confirm rejected by the user — nothing was deleted)'
        : null);
    }
  });
  port.onDisconnect.addListener(() => {
    gatePorts.delete(port);
    // the last interface died: nobody can answer the gate anymore
    if (!gatePorts.size && pendingConfirm) {
      resolveGate(false, '(confirm gate declined — the sync interface closed)');
    }
  });
});

const confirmPurge = arg => askGate('purge', arg);
const confirmDropDirectory = arg => askGate('drop', arg);
// Pull settings: an env override may tune them per run.
const pullBatch = Math.max(1,
  Math.floor(Number(globalThis.process?.env?.SYNC_PULL_BATCH) || DECISIONS.pullBatch));
const pullQuantum = Math.max(1,
  Math.floor(Number(globalThis.process?.env?.SYNC_PULL_QUANTUM) || DECISIONS.pullQuantum));
const miningBatch = Math.max(1,
  Math.floor(Number(globalThis.process?.env?.SYNC_MINING_BATCH) || DECISIONS.miningBatch));

// ---------------------------------------------------------------- jobs

const queue = [];             // {rid, kind, account, dir} — rid = caller-
                              // assigned id, traced back to the view whose
                              // button pins while the job is pending
let draining = false;         // one session at a time (serial queue; no job
                              // kind is parallel yet)
let activeLabel = null;

const DIRS_LABEL_MAX = 3;         // names shown before "+N more"

/** human list of a sync-dirs job's targets (truncated) */
function describeDirs(dirs) {
  const names = (Array.isArray(dirs) ? dirs : []).map(String);
  if (!names.length) {
    return '';
  }
  const head = names.slice(0, DIRS_LABEL_MAX).join(', ');
  return names.length > DIRS_LABEL_MAX
    ? head + ` (+${names.length - DIRS_LABEL_MAX} more)`
    : head;
}

const describeJob = job => {
  const a = job.account || {};
  const name = a.name || a.id || 'account';
  if (job.kind === 'sync-dirs') {
    return `${job.kind} · ${name}` +
      (describeDirs(job.dirs) ? ' · ' + describeDirs(job.dirs) : '');
  }
  return `${job.kind} · ${name}` +
    (job.kind.endsWith('-dir') && job.dir ? ' · ' + job.dir : '');
};

/** every queue mutation broadcasts the full list, rid included */
function emitJobs() {
  emit({
    type: 'sync-jobs',
    busy: draining || queue.length > 0,
    items: queue.map(job => ({
      rid: job.rid, kind: job.kind, dir: job.dir, dirs: job.dirs,
      label: describeJob(job)
    }))
  });
}

/** busy = something going (a session running or jobs queued) */
function updateBusy() {
  const busy = draining || queue.length > 0;
  const label = activeLabel ?? (queue.length ? `${queue.length} queued` : null);
  broadcast({type: 'sync-running', busy, label: busy ? label : null});
}

function enqueueJob(msg) {
  queue.push({
    rid: msg.rid, kind: msg.kind, account: msg.account,
    dir: msg.dir, dirs: Array.isArray(msg.dirs) ? msg.dirs.slice() : null
  });
  engineLog('queue',
    `${describeJob(msg)} requested — ` +
    queue.map(describeJob).join(', ')
  );
  emitJobs();
  scheduleDrain();
}

// one recheck at a time (fresh permission check at session start)
let recheckPromise = null;
let pristineGrantLogged = false; // one 'granted' diagnostic per document

function rechecking() {
  if (!recheckPromise) {
    recheckPromise = recheckHandle().finally(() => {
      recheckPromise = null;
    });
  }
  return recheckPromise;
}

async function recheckHandle() {
  const gate = await bootSilent();
  // diagnosis channel: failures always log; granted only ever logs once
  if (!gate.ok || !pristineGrantLogged) {
    engineLog('sync',
      `access check (offscreen): queryPermission → "${gate.raw ?? 'none'}"` +
      ` → ${gate.ok ? 'granted' : gate.reason}`
    );
    pristineGrantLogged = gate.ok;
  }
  return gate;
}

// ---------------------------------------------------------------- runs

// {granted, reason, raw, at} — verdict kept only for handleInit's benefit
let access = {granted: false, reason: 'undetermined', raw: null, at: null};

// ---------------------------------------------------------------- keepalive

let pingTimer = null;

// while a run is going, reset the service worker's idle timer so its native
// port (and the bridge behind it) survives to the end of the run
function keepBridgeAlive() {
  if (!pingTimer) {
    pingTimer = setInterval(() => {
      try {
        chrome.runtime.sendMessage({type: 'sync-bridge-ping'}).catch(() => {});
      }
      catch {}
    }, 20000);
  }
}

function letBridgeSleep() {
  if (pingTimer) {
    clearInterval(pingTimer);
    pingTimer = null;
  }
}

/**
 * Fire-and-forget delimiter report: the engine's survey learned the
 * account's hierarchy delimiter; the service worker persists it
 * (sync.delimiter.<id>) so the options page can normalize '/'-typed
 * filter paths onto the server's spelling and the sync panel can seed
 * its stores — the offscreen document has no chrome.storage itself.
 */
function reportDelimiter(account, summary) {
  const delimiter = summary?.delimiter;
  if (account?.id && typeof delimiter === 'string' && delimiter) {
    broadcast({
      type: 'sync-delimiter',
      accountId: account.id,
      delimiter
    });
  }
}

/** every job boots its own client + engine and tears them down after */
async function withSession(job) {
  let mail = null;
  let store = null;
  let refHeld = false;
  try {
    const gate = await recheckHandle();
    access = {
      granted: gate.ok,
      reason: gate.ok ? null : (gate.reason ?? 'undetermined'),
      raw: gate.raw ?? null,
      at: Date.now()
    };
    if (!gate.ok) {
      engineLog('warn',
        gate.reason === 'need-regrant'
          ? 'directory access needs a re-grant — open the sync panel for the link'
          : gate.reason === 'gate-failure'
            ? `storage gate failed: ${gate.error || 'unknown error'}`
            : 'no granted directory (run the picker)',
        'warn'
      );
      return {started: false, reason: gate.reason};
    }
    const rootHandle = gate.handle;
    const account = job.account;
    const only = job.kind.endsWith('-dir') ? job.dir : undefined;
    const dirsNote = job.kind === 'sync-dirs'
      ? ` · ${describeDirs(job.dirs)}`
      : '';
    const label = `${account.name || account.id}${only ? ' · ' + only : ''}${dirsNote}`;
    activeLabel = label;
    updateBusy();
    keepBridgeAlive();
    engineLog('system', `— ${label} —`, 'system');
    // the com.add0n.node bridge lives in the service worker (connectNative
    // is not an offscreen capability); acquire one ref for this job and ask
    // for the ready ws:// url (one ref, dropped in the finally below)
    const bridgeRes = await chrome.runtime.sendMessage({
      type: 'sync-bridge-ensure'    // worker maps this to the 'sync' ref
    }).catch(() => null);
    if (!bridgeRes?.ok || !bridgeRes.url) {
      engineLog('warn',
        'bridge FAILED: ' + (bridgeRes?.error ||
          'the service worker did not provide a ws->tls bridge'),
        'warn'
      );
      return {started: true, reason: 'no-bridge'};
    }
    refHeld = true;
    mail = createClient({
      host: account.host,
      port: account.port,
      secure: account.secure,
      allowSelfSigned: account.allowSelfSigned,
      user: account.user,
      pass: account.pass,
      slug: account.slug,
      bridgeUrl: bridgeRes.url
    });
    store = new MaildirStore(rootHandle, account.slug);
    await store.open();
    if (job.kind === 'discard') {
      engineLog('discard', 'wiping the local copy…');
      const freed = await store.reset();
      engineLog('discard', `account dir removed (${freed} top-level entr${freed === 1 ? 'y' : 'ies'} freed)`);
      // the service worker stamps sync.lastSyncAt away (no chrome.storage here)
      broadcast({type: 'sync-synced', accountId: account.id, finishedAt: null});
      engineLog('discard', 'lastSyncAt handed to the service worker — press Sync for the full re-pull');
    }
    else if (job.kind === 'sync-dirs') {
      // one session, one scoped sync per suggested dir: each run reuses
      // the single-dir scoping (only: dir) and its own snapshot read —
      // a per-dir failure logs and moves on, the rest still sync
      const dirs = (job.dirs || []).filter(d =>
        typeof d === 'string' && d);
      if (!dirs.length) {
        engineLog('sync', '(no dirs listed — nothing to sync)');
        return {started: true};
      }
      let failed = 0;
      for (const dir of dirs) {
        engineLog('system', `— ${label} · ${dir} —`, 'system');
        try {
          const engine = createSync(mail, store, {
            account: `${account.user}@${account.host}`,
            log: engineLog,
            confirmPurge,
            confirmDropDirectory,
            pullBatch,
            pullQuantum,
            miningBatch,
            only: dir
          });
          const {summary} = await engine.run({dry: false});
          reportDelimiter(account, summary);
          engineLog('summary', summary);
          if (!summary.finishedAt || summary.failed) {
            failed++;
          }
        }
        catch (e) {
          failed++;
          engineLog('warn', `FAILED ${dir}: ` + (e?.stack || e), 'warn');
        }
      }
      // lastSyncAt is account-level: stamp it only when EVERY dir ran clean,
      // so a partial pass never looks like a completed account sync
      if (failed) {
        engineLog('sync',
          `${failed} of ${dirs.length} dir(s) failed — lastSyncAt left untouched`);
      }
      else {
        broadcast({
          type: 'sync-synced',
          accountId: account.id,
          finishedAt: Date.now()
        });
        engineLog('sync', 'lastSyncAt handed to the service worker');
      }
    }
    else {
      const engine = createSync(mail, store, {
        account: `${account.user}@${account.host}`,
        log: engineLog,
        confirmPurge,
        confirmDropDirectory,
        pullBatch,
        pullQuantum,
        miningBatch,
        only
      });
      const dry = job.kind.startsWith('dry');
      const {plan, summary} = await engine.run({dry});
      reportDelimiter(account, summary);   // dry runs survey too — always fresh
      engineLog('summary', summary);
      if (dry) {
        if (!plan.ops.length && !plan.conflicts.length) {
          engineLog('summary', '(nothing to do)');
        }
      }
      else if (summary.finishedAt && !summary.failed) {
        broadcast({
          type: 'sync-synced',
          accountId: account.id,
          finishedAt: summary.finishedAt
        });
        engineLog('sync', 'lastSyncAt handed to the service worker');
      }
    }
    return {started: true};
  }
  catch (e) {
    engineLog('warn', 'FAILED: ' + (e?.stack || e), 'warn');
    return {started: true, reason: 'failed'};
  }
  finally {
    if (mail) {
      try {
        await mail.close();
      }
      catch {}
    }
    store = null;
    letBridgeSleep();
    // our ref is due back: the bridge drops after this (or stays for a
    // waitlist of other jobs still holding refs)
    if (refHeld) {
      chrome.runtime.sendMessage({
        type: 'bridge-release',
        key: 'sync'
      }).catch(() => {});
    }
    activeLabel = null;
  }
}

/** the serial runner: one session at a time until the queue is empty */
async function scheduleDrain() {
  if (draining) {
    return;
  }
  draining = true;
  try {
    while (queue.length) {
      const job = queue[0];
      const left = queue.length;
      engineLog('queue', `starting ${describeJob(job)} (1 of ${left})`);
      await withSession(job);
      queue.shift();
      emitJobs();
    }
  }
  catch (e) {
    engineLog('warn', 'queue drain FAILED: ' + (e?.stack || e), 'warn');
    queue.length = 0;
    emitJobs();
  }
  finally {
    draining = false;
    updateBusy();
  }
  // idle → end of this document's life: hand the close back to the worker
  engineLog('queue', 'empty — closing the offscreen document');
  broadcast({type: 'sync-close'});
}

// ---------------------------------------------------------------- requests

function handleInit() {
  return {
    ok: true,
    proto: PROTO,
    gen: BOOT_GEN,
    logs: logs.map(({i: seq, ts, type, content, cls}) =>
      ({seq, ts, type, content, cls, gen: BOOT_GEN})),
    running: !!(draining || queue.length),
    label: activeLabel,
    granted: access.granted,
    reason: access.reason,
    raw: access.raw,
    checkedAt: access.at
  };
}

const acceptsJob = msg =>
  ['sync', 'dry', 'sync-dir', 'dry-dir', 'sync-dirs', 'discard'].includes(msg.kind) &&
  !!(msg.account && typeof msg.account === 'object' &&
     msg.account.host && msg.account.port && msg.account.user) &&
  (msg.kind !== 'sync-dirs' || (
    Array.isArray(msg.dirs) && msg.dirs.length &&
    msg.dirs.every(d => typeof d === 'string' && d)));

chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  switch (msg?.type) {
    case 'sync-ui-init':        // a panel opened: hand over the whole log var
      respond(handleInit());
      return false;
    case 'sync-job': {          // forwarded here by the worker after ensure
      if (!acceptsJob(msg)) {
        engineLog('request',
          `rejected bad request: ${JSON.stringify(msg?.kind)} · ` +
          JSON.stringify(msg?.account), 'warn'
        );
        respond({ok: true, started: false, reason: 'bad-request'});
        return false;
      }
      enqueueJob(msg);
      respond({ok: true, started: true, queued: queue.length});
      return false;
    }
    case 'sync-stop': {
      // the kill path: the current job is torn down WITH this document
      // (the worker closes it right after our ack); the queued ones are
      // dropped here. Every <sync-view> hears the goodbye.
      engineLog('kill',
        `sync stopped by the interface — ${queue.length} queued job(s) dropped`, 'warn'
      );
      queue.length = 0;
      if (pendingConfirm) {
        pendingConfirm.resolve(false);
      }
      // views re-enable their pinned buttons, and the goodbye line reaches
      // every panel before the doc dies (flush emits synchronously)
      emitJobs();
      flush();
      respond({ok: true});
      return false;
    }
    case 'sync-confirm': {      // legacy answer path (sendMessage; the live
      // path is the 'sync-confirm' port, see onConnect above)
      if (pendingConfirm?.requestId === msg.requestId) {
        pendingConfirm.resolve(!!msg.ok, msg.value);
      }
      return false;
    }
    default:
      return false;
  }
});

// Handshake for the worker (it answers sync-request only after this arrived)
broadcast({type: 'sync-ready'});

// prime the access state so a panel opening mid-queue sees a real verdict
rechecking().catch(() => {});
