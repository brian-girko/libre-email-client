// offscreen.mjs — the sync engine, run inside the SHARED offscreen host
// document (/offscreen/index.html, routed by manager.mjs; this module is
// the 'sync-*' loader there). No UI:
// the whole interface is chrome.runtime messages.
//
//   sync-job       {kind:'sync'|'dry'|'sync-dir'|'dry-dir'|'discard'|
//                   'sync-dirs'|'dry-dirs', account, dir?, dirs?, filters?}
//                   → sync-dirs/dry-dirs run one scoped pass per listed dir
//                   {ok, queued} —
//                   the job ENQUEUES and runs after the previous one;
//                   never a 'busy' rejection. Before enqueuing, same-
//                   account jobs FOLD: a folder-based request merges its
//                   folders into the earlier pending job of the same
//                   family (sync/dry kept apart) and is dropped outright
//                   when a queued or running full run of that family
//                   covers the account; a full request folds the queued
//                   folder-based jobs of its account away (every decision
//                   narrated on the queue log). 'sync-dirs'/'dry-dirs'
//                   runs one scoped
//                   sync per dir in its dirs array (one session, per-dir
//                   failures logged and skipped; lastSyncAt stamps only
//                   when every dir finished clean). A full 'sync' job may
//                   carry the options-page filter list: after it lands,
//                   the LANDED INBOX messages are filtered on the spot —
//                   CLEAN OR FAILED RUN ALIKE (runPostSyncFilters; a
//                   failed run filters the messages it received anyway
//                   and reports the renamed dirs dirty) — interface jobs
//                   never carry filters, their behavior is unchanged
//   sync-job-drop  {rid} → {ok, dropped} — removes ONE pending job from
//                   the queue (the running one refuses; use sync-stop)
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
// Lifecycle: this document only exists while jobs are going — and it is the
// SHARED offscreen host now (/offscreen, manager.mjs): the manager imports
// this module on its first routed 'sync-*' message and hands the routed
// traffic + the 'sync-confirm' gate ports over; when the job list runs empty
// the module says so (sync-close + the manager's idle hook) and the manager
// closes the document itself once no other module has work either.
//
// Every settled non-dry job ends with a 'sync-refresh' broadcast
// {accountId, slug}: the writes happened here, so the open mail clients
// refresh their folder tree and open folder on receipt. The same settled
// run reports the store's leftover state as 'sync-pending-dirs': every
// dir left holding interlopers (unclaimed keepFmd5 moves, filter-pass
// dest dirs) — the worker's dirty store marks them and its scheduler
// re-arms the resync alarm from that report.
//
// No session can wedge forever on a network issue: the bridge round-trip
// at session boot rides a 30 s cap, the facade behind the engine caps
// EVERY call (connect included; 2 min, SYNC_CMD_TIMEOUT_MS) and tears
// down under a 10 s close cap — so a dead network or a wedged stream
// ABORTS the job ('no-bridge' or a settled FAILED session) instead of
// hanging the drain loop forever; the log stream stays live, the queue
// keeps draining and the document can go idle again.

'use strict';

import {createClient} from './client.mjs';
import {bootSilent} from '../disk.mjs';
import {MaildirStore} from '../maildir.mjs';
import {createSync} from './sync.mjs';
import {runAllFilters} from '../filters/run.mjs';

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
 * DECISIONS.gateGraceMs, the effective default answers on the user's behalf:
 * the job-carried stored preference ('Purge from server' / 'Drop local dir'
 * set to yes/no in the preferences dialog) when there is one, the DECISIONS
 * headless default otherwise; gates whose panel went silent still time out
 * to a decline.
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
  // the effective headless answer: a stored yes/no preference wins over
  // the built-in default (a 'yes' follows the user's standing approval,
  // a 'no' declines like an aborted confirm)
  const pref = gatePrefs[kind === 'purge' ? 'purge' : 'drop'];
  const grantedDefault = pref !== null
    ? pref === 'yes'
    : DECISIONS[kind === 'purge' ? 'noUiPurgeServer' : 'noUiDropLocalDir'];
  const defaultSource = pref !== null
    ? `stored ${kind === 'purge' ? 'purge from server' : 'drop local dir'} preference (${pref})`
    : 'default decision';
  engineLog('system',
    `waiting for the ${kind} confirmation — answer in the open sync interface` +
    (gatePorts.size ? '' : ` (nobody is connected yet — the ${defaultSource} ` +
      `(${grantedDefault ? 'proceed' : 'decline'}) stands in after ` +
      `${DECISIONS.gateGraceMs / 1000}s)`)
  );
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
    // immediately — the effective default only falls through when NO port
    // has (re)connected within the grace window
    const graceTimer = DECISIONS.gateGraceMs
      ? setTimeout(() => {
        if (!gatePorts.size) {
          resolveGate(grantedDefault,
            `(no sync interface connected within the grace window — ${defaultSource}: ${grantedDefault ? 'proceed' : 'decline'})`);
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

/** every gate port — live or arriving later, via onGatePort('sync-confirm') */
function attachGatePort(port) {
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
}

// Called by /offscreen/manager.mjs with every sync-confirm port it accepted
// BEFORE this module loaded (a panel may have opened the channel long
// before the first sync job made the manager import this module — this
// listener cannot be retroactively re-registered against older ports).
function onGatePort(port) {
  attachGatePort(port);
}

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
let activeJob = null;         // the RUNNING job (queue[0] while draining):
                              // merges and drops only ever consider the
                              // pending entries, never the live sessions

// the job-carried gate preferences (sync-ui.purge / sync-ui.drop, resolved
// by a chrome.storage-owning caller): the headless gate default below
// follows the stored choice instead of the hardcoded decline
let gatePrefs = {purge: null, drop: null};

/** normalize one job's carried prefs to {purge, drop} of 'yes'|'no'|null */
function gatePrefsOf(msg) {
  const raw = msg?.prefs;
  const one = value => (['yes', 'no'].includes(value) ? value : null);
  return {
    purge: one(raw?.purge),
    drop: one(raw?.drop)
  };
}

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
  if (job.kind === 'sync-dirs' || job.kind === 'dry-dirs') {
    return `${job.kind} · ${name}` +
      (describeDirs(job.dirs) ? ' · ' + describeDirs(job.dirs) : '');
  }
  return `${job.kind} · ${name}` +
    (job.kind.endsWith('-dir') && job.dir ? ' · ' + job.dir : '');
};

/** the queue-shape every consumer sees: rid included, the RUNNING job
 *  (activeJob) carries running:true — the interface's list renders it
 *  without a drop button (Stop ends a live session, never the ✕) */
const queueShape = () => queue.map(job => ({
  rid: job.rid, kind: job.kind, dir: job.dir, dirs: job.dirs,
  label: describeJob(job),
  running: job === activeJob
}));

/** every queue mutation broadcasts the full list, rid included */
function emitJobs() {
  emit({
    type: 'sync-jobs',
    busy: draining || queue.length > 0,
    items: queueShape()
  });
}

/** busy = something going (a session running or jobs queued) */
function updateBusy() {
  const busy = draining || queue.length > 0;
  const label = activeLabel ?? (queue.length ? `${queue.length} queued` : null);
  broadcast({type: 'sync-running', busy, label: busy ? label : null});
}

/** families the queue cares about: the full-account run of a family covers
 *  every folder of it, and folder-based jobs merge only inside their family
 *  (a queued dry run stays independent of a queued sync) */
const FULL_KINDS = new Set(['sync', 'dry']);
const DIR_KINDS = new Set(['sync-dir', 'dry-dir', 'sync-dirs', 'dry-dirs']);
const familyOf = kind => String(kind ?? '').startsWith('dry') ? 'dry' : 'sync';

/** identity of an account as far as the queue cares */
const accountKey = a =>
  a?.id ?? a?.slug ?? `${a?.host}:${a?.user}`;

/**
 * Queue hygiene before a fresh job joins (never touches the RUNNING job):
 * - a folder-based request is dropped when a full run of the same
 *   account+family is queued or already running (it covers every folder)
 * - folder-based requests merge their folders into the earlier pending
 *   job of the same account+family (a single-dir job spreads into the
 *   -dirs form); the earlier job keeps its rid/filters/prefs, the
 *   incoming rid leaves the queue (its view unpins via the broadcast)
 * - a full request folds away every pending folder-based job of the same
 *   account+family ahead of itself, and dedupes against a queued twin
 * - discard jobs ride past untouched
 * Every folding decision is narrated on the queue log.
 * @returns {'queued'|'merged'|'dropped'} what became of the request
 */
function mergeQueue(msg) {
  const kind = msg.kind;
  if (kind === 'discard') {
    return 'queued';
  }
  const family = familyOf(kind);
  const accKey = accountKey(msg.account);
  const sameAcc = j => familyOf(j.kind) === family &&
    accountKey(j.account) === accKey;

  if (DIR_KINDS.has(kind)) {
    // a full run in flight already sweeps the whole account
    if (FULL_KINDS.has(activeJob?.kind) && sameAcc(activeJob)) {
      engineLog('queue',
        `${describeJob(msg)} dropped — a full ${family === 'dry' ? 'dry' : 'sync'} run is in flight for this account`);
      return 'dropped';
    }
    const fullIdx = queue.findIndex(j => j !== activeJob && FULL_KINDS.has(j.kind) && sameAcc(j));
    if (fullIdx >= 0) {
      engineLog('queue',
        `${describeJob(msg)} dropped — covered by the queued ${describeJob(queue[fullIdx])}`);
      return 'dropped';
    }
    const idx = queue.findIndex(j => j !== activeJob && DIR_KINDS.has(j.kind) && sameAcc(j));
    if (idx >= 0) {
      const target = queue[idx];
      const incomingDirs = kind.endsWith('-dirs') ? msg.dirs.slice() : [msg.dir];
      const haveDirs = target.kind.endsWith('-dirs')
        ? (target.dirs ?? []).slice()
        : [target.dir];
      const merged = [...new Set([...haveDirs, ...incomingDirs])]
        .filter(d => typeof d === 'string' && d)
        .sort((a, b) => a.localeCompare(b));
      target.kind = family === 'dry' ? 'dry-dirs' : 'sync-dirs';
      target.dir = null;
      target.dirs = merged;
      engineLog('queue',
        `${describeJob(msg)} merged into the queued ${describeJob(target)}`);
      return 'merged';
    }
  }
  else if (FULL_KINDS.has(kind)) {
    if (FULL_KINDS.has(activeJob?.kind) && sameAcc(activeJob)) {
      engineLog('queue',
        `${describeJob(msg)} dropped — an identical full run is in flight`);
      return 'dropped';
    }
    const dupIdx = queue.findIndex(j => j !== activeJob && FULL_KINDS.has(j.kind) && sameAcc(j));
    if (dupIdx >= 0) {
      engineLog('queue',
        `${describeJob(msg)} dropped — already queued (${describeJob(queue[dupIdx])})`);
      return 'dropped';
    }
    const folded = queue.filter(j => j !== activeJob &&
      DIR_KINDS.has(j.kind) && sameAcc(j));
    for (const job of folded) {
      queue.splice(queue.indexOf(job), 1);
      engineLog('queue', `${describeJob(job)} dropped — the queued full run covers it`);
    }
    if (folded.length) {
      emitJobs();
    }
  }
  return 'queued';
}

function enqueueJob(msg) {
  const outcome = mergeQueue(msg);
  if (outcome !== 'queued') {
    emitJobs();   // dropped/merged rids leave (or never entered) the queue:
                  // their views unpin right away
    scheduleDrain();
    return;
  }
  queue.push({
    rid: msg.rid, kind: msg.kind, account: msg.account,
    dir: msg.dir, dirs: Array.isArray(msg.dirs) ? msg.dirs.slice() : null,
    // the mail client's syncs carry the stored filter list for the
    // post-sync pass over the NEW INBOX messages (runPostSyncFilters)
    filters: Array.isArray(msg.filters) ? msg.filters.slice() : null,
    // the stored gate preferences (sync-ui.purge / sync-ui.drop): only a
    // saved yes/no counts, null = ask (the DECISIONS default stands in)
    prefs: gatePrefsOf(msg)
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

/**
 * The mail client's syncs carry the options-page filter list in the job
 * (the offscreen has no chrome.storage). A settled run — CLEAN OR FAILED —
 * filters the INBOX messages it RECEIVED on the store the run just wrote;
 * the landed set (engine.landedInboxUids()) is the only source of truth:
 * the pull scheduler's committed rows PLUS the post-apply arrivals,
 * "new" regardless of read state, never the unread heuristic. Plan intent
 * is deliberately NOT consulted — a pull the run failed to land has
 * nothing on disk to filter, and a run that died mid-apply still filters
 * everything it managed to receive before dying ({dirty: true} narrates
 * that). First match wins per message in the filters' stored order
 * ('of Filter N' numbering); every match is renamed into its destination
 * Maildir (keepFmd5), the next sync pushes the server move — safe on a
 * failed run too, since the snapshot stays uncommitted and the renames
 * are re-detected as pending moves. Dir-scoped runs carry filters only
 * when the run is the INBOX itself; other folders sync bare. Interface-
 * submitted jobs carry no filters: the sync interface keeps its own
 * behavior — its filter row stays fully manual.
 * A pass failure logs a warn and never fails the sync itself.
 */
async function runPostSyncFilters(job, store, account, uids, {dirty = false} = {}) {
  const stored = Array.isArray(job.filters) ? job.filters : [];
  const filters = stored.filter(f => f && f.enabled !== false &&
    typeof f.query === 'string' && f.folder);
  // full-account runs and INBOX-scoped dir runs filter their new INBOX
  // pulls; any other folder's dir run is bare — no filter pass
  const dirScopedInbox = job.kind === 'sync-dir' &&
    String(job.dir || '').toUpperCase() === 'INBOX';
  if (job.kind !== 'sync' && !dirScopedInbox) {
    return;
  }
  if (!filters.length || !(uids instanceof Set)) {
    return;
  }
  const newUids = [...uids].map(Number).filter(Number.isFinite);
  if (!newUids.length) {
    if (!dirty) {
      engineLog('filter', 'no new INBOX messages — filter pass skipped', 'hint');
    }
    return;
  }
  const note = (content, cls = '') => engineLog('filter', content, cls);
  const t0 = Date.now();
  if (dirty) {
    engineLog('filter',
      'the run FAILED — filtering the messages that landed anyway', 'warn');
  }
  engineLog('filter',
    `— filters · ${account.name || account.id} · INBOX — ` +
    `${newUids.length} new message(s)`, 'system');
  try {
    const res = await runAllFilters(store, {
      dir: 'INBOX',
      filters,
      accountId: account.id,
      onlyUids: new Set(newUids),
      dry: false,
      filterNoOf: f => {
        const i = stored.findIndex(g => g && g.id === f.id);
        return i >= 0 ? i + 1 : null;
      },
      log: note
    });
    const secs = Math.max(1, Math.round((Date.now() - t0) / 1000));
    engineLog('filter',
      `filter pass finished: ${res.candidates} candidate(s), ` +
      `${res.matched} matched` +
      (res.kept ? ` (${res.kept} kept in place)` : '') +
      `, ${res.moved} moved (${secs}s)`, 'system');
  }
  catch (e) {
    engineLog('warn', 'filter pass FAILED: ' + (e?.stack || e), 'warn');
  }
}

/**
 * The ground-truth dirty report: after every non-dry run, each local dir
 * that holds INTERLOPERS — files whose FMD5 names another folder, the
 * keepFmd5 pending-move marker — really needs a resync, whatever moved
 * them there (this run's filter pass, a leftover the run did not claim,
 * anything else that wrote the store). A resync filters on the disk
 * state, not on who touched it: this runs the store over the fresh
 * local layout and reports the dirty dirs — the worker's dirty store
 * marks them, and its scheduler re-arms the alarm. Self-terminating:
 * once a sync claims and pushes the interlopers, the scan finds them
 * gone. The report rides the regular 'sync-pending-dirs' message.
 */
async function reportPendingMoves(store, account) {
  try {
    const dirs = [];
    for (const dir of await store.listFolders()) {
      const listing = await store.listLocal(dir).catch(() => null);
      if (listing?.interlopers?.length) {
        dirs.push(dir);
      }
    }
    if (!dirs.length) {
      return;
    }
    broadcast({
      type: 'sync-pending-dirs',
      accountId: account.id,
      slug: account.slug,
      dirs
    });
    engineLog('sync',
      'pending-move report handed over: ' + dirs.join(', '));
  }
  catch (e) {
    engineLog('warn',
      'pending-move scan FAILED: ' + (e?.stack || e), 'warn');
  }
}

// A hanging bridge boot (dead native host, unresponsive worker) is a
// pre-sync network failure like any other: the round-trip rides a hard
// cap and the job aborts as 'no-bridge' instead of stalling the drain
// forever. (Beside it the facade caps itself: 2 min for the boot connect
// and every framed call — SYNC_CMD_TIMEOUT_MS — and 10 s for the teardown
// close; see offscreen/client.mjs.)
const BRIDGE_ENSURE_CAP = 30 * 1000;

/** one capped worker round-trip for a ready ws:// bridge url */
function bridgeEnsure() {
  let timer;
  const cap = new Promise((_, reject) => {
    timer = setTimeout(() =>
      reject(new Error(
        `sync-bridge-ensure timed out after ${BRIDGE_ENSURE_CAP / 1000}s — the job aborts (no bridge)`)),
    BRIDGE_ENSURE_CAP);
  });
  return Promise.race([
    chrome.runtime.sendMessage({type: 'sync-bridge-ensure'}),
    cap
  ]).finally(() => clearTimeout(timer));
}

/** every job boots its own client + engine and tears them down after */
async function withSession(job) {
  let mail = null;
  let store = null;
  let refHeld = false;
  // hoisted above the try: the failing paths (a run that THREW mid-apply)
  // must still reach the engine's landedInboxUids() and the account list —
  // "received messages are filtered, error or not"
  let engine = null;
  let account = null;
  try {
    // the stored gate preferences ride in the job: the headless defaults
    // follow them until this session ends (the last job's prefs stand)
    gatePrefs = job.prefs || {purge: null, drop: null};
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
    account = job.account;
    const only = job.kind.endsWith('-dir') ? job.dir : undefined;
    const dirsNote = (job.kind === 'sync-dirs' || job.kind === 'dry-dirs')
      ? ` · ${describeDirs(job.dirs)}`
      : '';
    const label = `${account.name || account.id}${only ? ' · ' + only : ''}${dirsNote}`;
    activeLabel = label;
    updateBusy();
    keepBridgeAlive();
    engineLog('system', `Sync starts for ${label}`, 'system');
    // the com.add0n.node bridge lives in the service worker (connectNative
    // is not an offscreen capability); acquire one ref for this job and ask
    // for the ready ws:// url (one ref, dropped in the finally below).
    // The round-trip rides BRIDGE_ENSURE_CAP: a hanging boot aborts as
    // 'no-bridge' — the job settles, nothing on the queue wedges.
    const bridgeRes = await bridgeEnsure().catch(() => null);
    if (!bridgeRes?.ok || !bridgeRes.url) {
      engineLog('warn',
        'bridge FAILED: ' + (bridgeRes?.error ||
          'the service worker did not provide a ws->tls bridge (refused or timed out)'),
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
    else if (job.kind === 'sync-dirs' || job.kind === 'dry-dirs') {
      // one session, one scoped sync per dir: each run reuses the
      // single-dir scoping (only: dir) and its own snapshot read — a
      // per-dir failure logs and moves on, the rest still sync. dry-dirs
      // is the merge-fused form of queued dry-dir jobs: survey-only.
      const dry = job.kind.startsWith('dry');
      const dirs = (job.dirs || []).filter(d =>
        typeof d === 'string' && d);
      if (!dirs.length) {
        engineLog(dry ? 'dry' : 'sync', '(no dirs listed — nothing to sync)');
        return {started: true};
      }
      let failed = 0;
      for (const dir of dirs) {
        engineLog('system', `— ${label} · ${dir} —`, 'system');
        try {
          engine = createSync(mail, store, {
            account: `${account.user}@${account.host}`,
            log: engineLog,
            confirmPurge,
            confirmDropDirectory,
            pullBatch,
            pullQuantum,
            miningBatch,
            only: dir
          });
          const {plan, summary} = await engine.run({dry});
          reportDelimiter(account, summary);
          engineLog('summary', summary);
          if (dry) {
            if (!plan.ops.length && !plan.conflicts.length) {
              engineLog('summary', '(nothing to do)');
            }
          }
          else if (summary.finishedAt && !summary.failed) {
            // clean member dir — the plain filter pass below handles it
          }
          else {
            failed++;
          }
          // an INBOX member dir filters like every other non-interface
          // sync — kind-shimmed to the full-run filter pass over this
          // run's LANDED pulls; a failed dir is filtered too ({dirty}):
          // the received messages match their filters even then (failure
          // logs, never fails the sync — see runPostSyncFilters)
          if (!dry) {
            await runPostSyncFilters({...job, kind: 'sync-dir', dir},
              store, account, engine.landedInboxUids(),
              {dirty: !(summary.finishedAt && !summary.failed)});
          }
        }
        catch (e) {
          failed++;
          engineLog('warn', `FAILED ${dir}: ` + (e?.stack || e), 'warn');
          // the dir's landed pulls are filtered nonetheless: a run that
          // threw mid-apply may have received several — and they must
          // match the filters anyway. Best-effort here: the pass can
          // never re-fail this catch.
          try {
            await runPostSyncFilters({...job, kind: 'sync-dir', dir},
              store, account, engine?.landedInboxUids?.(), {dirty: true});
          }
          catch (e2) {
            engineLog('warn',
              'filter pass FAILED: ' + (e2?.stack || e2), 'warn');
          }
        }
      }
      // lastSyncAt is account-level: stamp it only when EVERY dir ran
      // clean, so a partial pass never looks like a completed account sync
      // (dry runs never stamp, and dry failures never count as real)
      if (dry) {
        if (failed) {
          engineLog('sync',
            `${failed} of ${dirs.length} dir(s) failed (dry run)`);
        }
      }
      else if (failed) {
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
      engine = createSync(mail, store, {
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
      else {
        if (summary.finishedAt && !summary.failed) {
          // the summary carries the snapshot's ISO lastSyncAt; broadcast
          // epoch ms like the sync-dirs path does, so the worker's
          // sync.lastSyncAt.<id> stamp has one format everywhere
          broadcast({
            type: 'sync-synced',
            accountId: account.id,
            finishedAt: Date.parse(summary.finishedAt) || Date.now()
          });
          engineLog('sync', 'lastSyncAt handed to the service worker');
        }
        // the mail client's syncs carry the filter list: the new INBOX
        // messages are filtered right here, before the job settles — on a
        // failed run too ({dirty} narrates): the pass matches exactly the
        // pulls the run LANDED (post-apply arrivals included), never the
        // plan's leftovers — "received messages are filtered, error or not"
        await runPostSyncFilters(job, store, account,
          engine.landedInboxUids(),
          {dirty: !(summary.finishedAt && !summary.failed)});
      }
    }
    // the state the store is left in decides the next resync: whatever
    // dirs still hold pending moves are reported dirty now (dry runs
    // include the survey's honest view, discard wipes the whole account)
    if (store && job.kind !== 'discard') {
      await reportPendingMoves(store, account);
    }
    return {started: true};
  }
  catch (e) {
    engineLog('warn', 'FAILED: ' + (e?.stack || e), 'warn');
    // The job still settles — always. Best-effort last duties before the
    // teardown: the INBOX messages the dying run LANDED are filtered too
    // ("received messages are filtered, error or not" — engine may be
    // null before the run even started, and the pass's own gates keep a
    // dry/readless/interface job out), and whatever the pass renamed (or
    // the run otherwise left behind) is reported dirty so the worker's
    // scheduler re-arms the resync alarm. Nothing here may fail the
    // settle: both steps are guarded.
    try {
      await runPostSyncFilters(job, store, account,
        engine?.landedInboxUids?.(), {dirty: true});
      if (store && job.kind !== 'discard') {
        await reportPendingMoves(store, account);
      }
    }
    catch (e2) {
      engineLog('warn',
        'failure cleanup FAILED: ' + (e2?.stack || e2), 'warn');
    }
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
      activeJob = job;
      engineLog('queue', `starting ${describeJob(job)} (1 of ${left})`);
      await withSession(job);
      queue.shift();
      activeJob = null;
      emitJobs();
      // the run (and its filter pass) wrote into the account dir from
      // this invisible document — every open mail client needs the
      // heads-up to refresh its tree and reconcile its open folder
      if (!job.kind.startsWith('dry')) {
        broadcast({
          type: 'sync-refresh',
          accountId: job.account?.id ?? null,
          slug: job.account?.slug ?? null
        });
      }
    }
  }
  catch (e) {
    engineLog('warn', 'queue drain FAILED: ' + (e?.stack || e), 'warn');
    queue.length = 0;
    emitJobs();
  }
  finally {
    activeJob = null;
    draining = false;
    updateBusy();
  }
  // idle → the shared document's close decision (/offscreen/manager.mjs
  // re-evaluates once no other module has work either)
  engineLog('queue', 'empty — sync is idle');
  broadcast({type: 'sync-close'});
  idleSync();
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
    // the pending queue, rid included: pages that track a submitted run
    // (e.g. the mail client's background sync, whose state survives its
    // own reloads in chrome.storage.session) ask whether THEIR rid is
    // still queued — same shape as the sync-jobs broadcast
    items: queueShape(),
    granted: access.granted,
    reason: access.reason,
    raw: access.raw,
    checkedAt: access.at
  };
}

const acceptsJob = msg =>
  ['sync', 'dry', 'sync-dir', 'dry-dir', 'sync-dirs', 'dry-dirs',
    'discard'].includes(msg.kind) &&
  !!(msg.account && typeof msg.account === 'object' &&
     msg.account.host && msg.account.port && msg.account.user) &&
  (msg.kind !== 'sync-dirs' && msg.kind !== 'dry-dirs' || (
    Array.isArray(msg.dirs) && msg.dirs.length &&
    msg.dirs.every(d => typeof d === 'string' && d)));

/**
 * The engine has own-message dispatch replaced by the manager contract:
 * handle(msg) returns what the old listener used to respond() with
 * (synchronously, or a Promise), and the manager owns both chrome.* sides
 * (onMessage registration, 'sync-confirm' port registration via
 * onGatePort). Returning `undefined` means no ack was intended.
 *
 * @param {object} msg routed runtime message
 * @returns {object|undefined} the responder's payload where one existed
 */
function handle(msg) {
  switch (msg?.type) {
    case 'sync-ui-init':        // a panel opened: hand over the whole log var
      return handleInit();
    case 'sync-job': {          // routed here by the manager (worker → doc)
      if (!acceptsJob(msg)) {
        engineLog('request',
          `rejected bad request: ${JSON.stringify(msg?.kind)} · ` +
          JSON.stringify(msg?.account), 'warn'
        );
        return {ok: true, started: false, reason: 'bad-request'};
      }
      enqueueJob(msg);
      return {ok: true, started: true, queued: queue.length};
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
      return {ok: true};
    }
    case 'sync-job-drop': {
      // drop ONE pending job by rid (the interface's queue list button);
      // the running job refuses — killing a live session is Stop's job
      const idx = queue.findIndex(job => job.rid === msg.rid && job !== activeJob);
      if (idx < 0) {
        const running = activeJob?.rid === msg.rid;
        return {ok: true, dropped: false,
          reason: running ? 'running' : 'not-queued'};
      }
      engineLog('queue',
        `${describeJob(queue[idx])} dropped from the queue by the interface`);
      queue.splice(idx, 1);
      emitJobs();
      scheduleDrain();   // re-evaluates the close/idle decision on an
                         // emptied queue
      return {ok: true, dropped: true};
    }
    case 'sync-confirm': {      // legacy answer path (sendMessage; the live
      // path is the 'sync-confirm' port routed by the manager)
      if (pendingConfirm?.requestId === msg.requestId) {
        pendingConfirm.resolve(!!msg.ok, msg.value);
      }
      return undefined;
    }
    default:
      return undefined;
  }
}

/** idles the shared document's manager (/offscreen/manager.mjs) */
function idleSync() {
  globalThis.__offscreen?.idle?.('sync');
}

export {handle, onGatePort};

// prime the access state so a panel opening mid-queue sees a real verdict
rechecking().catch(() => {});
