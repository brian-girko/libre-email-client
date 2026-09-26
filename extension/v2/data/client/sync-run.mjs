'use strict';

// sync-run.mjs — background sync runs from the mail client's Sync combo.
//
// A plain click on a combo segment submits a 'sync-request' job for the
// selected account — the same chain the sync panel uses: the worker boots
// the offscreen engine on demand and forwards the job; the engine queues
// and runs it serially. The account config (with the just-in-time decrypted
// password) travels IN the request: the engine document has no
// chrome.storage. The "Account" segment submits a full-account run; the
// "Dir" segment submits a dir-scoped run (kind 'sync-dir', dir travels in
// the job — the engine's only-this-folder scoping). The stored filter list
// travels with full-account runs only: after the run lands, the engine
// filters the NEW INBOX messages of the synced account on the spot (the
// sync interface's own buttons carry no filters — their behavior is
// unchanged). The combo's "Open" segment keeps opening the sync interface
// without syncing (index.mjs).
//
// Feedback is one pinned logger entry per run: queued while the engine
// holds it, done/failed once the engine's sync-jobs broadcast drops the
// rid — the same settle signal the sync panel pins its buttons by. The
// pinned entry stays static: its label names the account that is syncing
// and its detail is never written live. The engine's global log stream
// ('sync-log') feeds the logger's persistent status text instead — one
// always-current last-log line, whatever initiated the run (combo,
// context menu, sync interface or the scheduler's automated passes).
//
// Runs of OTHER origin get the same account line here: the engine tags
// its busy/queue broadcasts with the RUNNING job's structured identity
// (accountId/slug/name, kind, dir/dirs — see offscreen.mjs scopeOf), and
// this module mirrors it as one pinned entry whenever the page tracks no
// run of its own. Settle mirrors the combo semantics (sync finished /
// sync failed — see the sync client log); dry runs and discards settle
// by their kind, the engine's warn lines keep the status line honest.
// A kill line settles the mirror as 'sync stopped'.
//
// The tracked run is mirrored into chrome.storage.session
// ('sync.clientRun'): the record survives page reloads and reaches every
// client window, so a refreshed or newly opened client re-pins the entry
// and keeps settling it. Settle signals stay live broadcasts (instant);
// a run that settled while NO client watched is reconstructed from the
// pending-rids query (sync-ui-init) plus the worker's clean-run stamp
// (sync.lastSyncAt.<id>) on the next client open. Session storage clears
// with the browser — nothing survives a restart.
//
// When a run of an account finishes clean (the engine broadcasts
// 'sync-synced', handed to the worker only when the run ended without
// failure), the onSynced callback fires so the client can reconcile the
// open folder in place.

import {loadAccounts, decryptPassword} from '../sync/client/accounts.mjs';
import * as logger from './logger.mjs';

const RUN_KEY = 'sync.clientRun';

let promptEl = null;
let onSynced = null;

// the one tracked run: {rid, slug, id, name, dir, startedAt, synced}.
// Guarded, so re-clicks while a run is pending — or while a
// master-password prompt is open — are no-ops.
let active = null;
let ridSeq = 0;

/**
 * Resolves a client-side account id (the granted-directory slug) or a
 * sync-registry id to a registry account — the same rule the sync
 * panel's findAccount applies (both spell the same account).
 * @returns {Promise<object|null>} null when the account is not
 *   configured on the options page
 */
export async function findRegistryAccount(id) {
  if (!id) {
    return null;
  }
  const accounts = await loadAccounts(null, {decrypt: false}).catch(() => []);
  return accounts.find(a => a.slug === id) ??
    accounts.find(a => a.id === id) ?? null;
}

// ---- chrome.storage.session run record ---------------------------------------
// The mirror every client window reads: {rid, slug, id, name, startedAt}
// while the tracked run is pending, gone once it settles. Writers guard
// by rid so a stale settle never drops a NEWER run's record.

async function readStoredRun() {
  const stored = await chrome.storage.session.get(RUN_KEY).catch(() => ({}));
  const run = stored[RUN_KEY];
  return run && run.rid ? run : null;
}

function writeStoredRun(run) {
  return chrome.storage.session.set({[RUN_KEY]: run}).catch(() => {});
}

async function clearStoredRun(rid) {
  try {
    const stored = await chrome.storage.session.get(RUN_KEY);
    const run = stored[RUN_KEY];
    if (run?.rid === rid) {
      await chrome.storage.session.remove(RUN_KEY);
    }
  }
  catch {
    /* storage gone (browser restart): nothing to clear */
  }
}

/** rids the engine still holds (empty when the engine document is gone) */
async function pendingRids() {
  try {
    const res = await chrome.runtime.sendMessage({type: 'sync-ui-init'});
    return new Set((res?.items || []).map(j => j?.rid));
  }
  catch {
    return new Set();   // no engine document — nothing pending
  }
}

/**
 * Brings a recorded run back into this page's view after a reload (or in
 * a freshly opened client window). Still queued → re-pin the entry and
 * resume tracking. Settled while no client watched → show the outcome:
 * the worker stamps sync.lastSyncAt.<id> only on clean runs, so a stamp
 * newer than the run's start says "finished", anything else "ended".
 * Clears a settled record. @returns true when the run is live again.
 */
async function reconstruct(run) {
  if (active) {
    return false;   // this page already tracks a run
  }
  if ((await pendingRids()).has(run.rid)) {
    pinRun(run);
    active = {...run, synced: false};
    return true;
  }
  await clearStoredRun(run.rid);
  const res = await chrome.storage.local
    .get('sync.lastSyncAt.' + run.id).catch(() => ({}));
  const stamp = Date.parse(res['sync.lastSyncAt.' + run.id] ?? '');
  logger.begin({
    id: run.rid,
    kind: 'sync',
    label: 'sync · ' + (run.name || run.id),
    doneLabel: 'sync finished'
  });
  if (Number.isFinite(stamp) && stamp >= run.startedAt) {
    logger.done(run.rid, 'sync finished');
    if (onSynced) {
      onSynced(run.slug);
    }
  }
  else {
    logger.fail(run.rid,
      'ended while no client was watching — see the sync client log');
  }
  return false;
}

/** one pinned entry for a run (fresh or reconstructed) */
function pinRun(run) {
  const scope = run.dir ? ' · ' + run.dir : '';
  logger.begin({
    id: run.rid,
    kind: 'sync',
    label: 'sync · ' + (run.name || run.id) + scope,
    doneLabel: 'sync finished'
  });
  logger.update(run.rid, {state: 'running'});
}

// ---- external runs (the engine's own narration) ------------------------------
// A run submitted elsewhere — the sync interface, the scheduler, the
// context menu — reaches this page only as broadcasts. The engine tags
// its busy/queue state with the RUNNING job's structured identity
// (accountId/slug/name, kind, dir/dirs), so the mirror entry shows the
// same 'sync · <account>' line the client's own runs use.

// the mirrored external run: {entryId, accountId, slug, name, kind, dir,
// dirs, synced} or null; a settled mirror leaves null and its entry fades
// via the logger's done-TTL (or stays failed until dismissed)
let external = null;
let extSeq = 0;

/** the readable mirror label: family first, account, then the scope */
function labelFor(run) {
  const dry = typeof run.kind === 'string' && run.kind.startsWith('dry');
  let scope = '';
  if (run.kind === 'sync-dirs' || run.kind === 'dry-dirs') {
    const dirs = (run.dirs || []).filter(Boolean);
    if (dirs.length) {
      scope = ' · ' + dirs.slice(0, 3).join(', ') +
        (dirs.length > 3 ? ' (+' + (dirs.length - 3) + ' more)' : '');
    }
  }
  else if (run.dir) {
    scope = ' · ' + run.dir;
  }
  return (dry ? 'dry' : 'sync') + ' · ' +
    (run.name || run.accountId || 'account') + scope;
}

/**
 * Starts (or refreshes) the mirror entry from a broadcast's account scope.
 * Same account still running → the scope fields refresh in place (the
 * synced flag survives); a different account means the previous serial run
 * settled already (its mirror left with the queue fade) and this opens a
 * fresh entry. Never called for a run this page tracks itself (rid match).
 */
function mirrorExternal(meta) {
  if (!meta?.accountId) {
    return;
  }
  const sameRun = external && (external.accountId === meta.accountId ||
    (external.slug && external.slug === meta.accountSlug));
  if (!sameRun && external) {
    // a different account is running: the previous serial run ended
    // (the engine runs one session at a time) — settle it by whatever
    // its sync-synced stamp said before this fresh pin
    settleExternal();
  }
  let run;
  if (sameRun) {
    run = {...external,
      name: meta.name || external.name,
      kind: meta.kind ?? external.kind,
      dir: meta.dir ?? external.dir,
      dirs: Array.isArray(meta.dirs) ? meta.dirs : external.dirs};
    logger.update(run.entryId, {label: labelFor(run), state: 'running'});
  }
  else {
    run = {
      entryId: 'ext-' + Date.now().toString(36) + '-' + (++extSeq),
      accountId: meta.accountId,
      slug: meta.accountSlug || null,
      name: meta.name || meta.accountSlug || meta.accountId,
      kind: meta.kind ?? null,
      dir: meta.dir ?? null,
      dirs: Array.isArray(meta.dirs) ? meta.dirs : null,
      synced: false
    };
    logger.begin({
      id: run.entryId,
      kind: 'sync',
      label: labelFor(run),
      doneLabel: 'sync finished'
    });
    logger.update(run.entryId, {state: 'running'});
  }
  external = run;
}

/**
 * Settles the mirror entry exactly like the combo's own run: clean →
 * 'sync finished' (the logger's done-TTL removes it), anything else →
 * the combo's own failure wording. Dry runs never stamp lastSyncAt (no
 * sync-synced ever arrives) and a discard resets it (finishedAt null) —
 * both settle by their kind; a failed pass still turns the status line
 * red through the engine's FAILED warns. A reason (the kill path) fails
 * the entry outright.
 */
function settleExternal(reason) {
  const job = external;
  if (!job) {
    return;
  }
  external = null;
  if (reason) {
    logger.fail(job.entryId, reason);
    return;
  }
  const kind = job.kind || 'sync';
  if (kind === 'discard') {
    logger.done(job.entryId, 'local copy discarded');
  }
  else if (kind.startsWith('dry')) {
    logger.done(job.entryId, 'dry run finished');
  }
  else if (job.synced) {
    logger.done(job.entryId, 'sync finished');
  }
  else {
    logger.fail(job.entryId, 'sync failed — see the sync client log');
  }
}

/** the mirror scope of a broadcast's running job, when it is not OURS */
function externalScopeOf(src) {
  if (!src?.accountId || (src.rid && src.rid === active?.rid)) {
    return null;
  }
  return {
    accountId: src.accountId,
    accountSlug: src.accountSlug,
    name: src.accountName,
    kind: src.kind,
    dir: src.dir,
    dirs: src.dirs
  };
}

/**
 * Wires the background-sync feedback: remembers the prompt host for
 * master-password prompts, listens for the engine's broadcasts and
 * re-attaches a run recorded in chrome.storage.session (page reload,
 * second client window).
 * @param {object} [opts]
 * @param {Element} [opts.prompt] a <prompt-view> used to ask for the
 *   master password when a stored password is encrypted
 * @param {Function} [opts.synced] called with the account slug when a
 *   tracked run finished clean
 */
export function init({prompt, synced} = {}) {
  promptEl = prompt || null;
  onSynced = typeof synced === 'function' ? synced : null;
  chrome.runtime.onMessage.addListener(onMessage);
  const primed = readStoredRun()
    .then(run => {
      if (run && !active) {
        return reconstruct(run);
      }
      return null;
    })
    .catch(() => {});
  // an engine already mid-run of OTHER origin (the interface, the
  // scheduler): mirror its live run at once, so a freshly opened or
  // reloaded client shows the account line without waiting for the next
  // broadcast — the init snapshot carries the same structured identity
  primed.then(() => {
    if (active) {
      return null;   // our own reconstructed run is pinned already
    }
    return chrome.runtime.sendMessage({type: 'sync-ui-init'})
      .then(data => {
        if (!data?.running) {
          return null;   // idle engine — nothing to mirror
        }
        const running = (data.items || []).find(item => item?.running) ?? data;
        const scope = externalScopeOf(running);
        if (scope) {
          mirrorExternal(scope);
        }
        return null;
      })
      .catch(() => {});   // a dead engine means nothing to mirror
  });
}

function onMessage(msg) {
  // the engine's log stream is global — every run the extension performs
  // (this page's combo, the context menu, the sync interface, the
  // scheduler) narrates through the same 'sync-log' broadcasts. The
  // logger's persistent status line always carries the newest line, so
  // the dedicated log section prints the last log whatever initiated
  // the sync. A run of OTHER origin gets its pinned entry maintained
  // through the account-carrying broadcasts below; this page's own runs
  // are tracked by rid here as before.
  if (msg?.type === 'sync-log') {
    const lines = (msg.lines || []).filter(l =>
      l?.content != null && String(l.content).trim());
    const last = lines[lines.length - 1];
    if (last) {
      logger.setStatus(String(last.content), {
        tone: last.type === 'warn' || last.type === 'kill' ? 'error' : 'info'
      });
    }
    // the kill path (the sync interface's Stop button) broadcasts its
    // goodbye log line before the engine document dies — a kill must
    // fail the tracked entry, not leave it spinning
    if ((msg.lines || []).some(line => line?.type === 'kill')) {
      if (active) {
        const job = active;
        active = null;
        clearStoredRun(job.rid);
        logger.fail(job.rid, 'sync stopped');
      }
      if (external) {
        settleExternal('sync stopped');
      }
    }
    return;
  }
  // clean-completion stamps: the engine hands this to the worker only
  // when a run ended without failure, before the rid drop — it decides
  // done/failed for BOTH the client's own run and the external mirror
  if (msg?.type === 'sync-synced') {
    if (active && msg.accountId === active.id && msg.finishedAt != null) {
      active.synced = true;
      return;
    }
    if (external && msg.finishedAt != null &&
        (msg.accountId === external.accountId ||
          (external.slug && msg.accountId === external.slug))) {
      external.synced = true;
      return;
    }
    return;
  }
  // queue state: the engine keeps a running job listed until it
  // settles — the rid dropping means OUR job is done. The microtask
  // lets a same-batch kill line win the race against the drop.
  if (msg?.type === 'sync-jobs') {
    const items = Array.isArray(msg.items) ? msg.items : [];
    const runningItem = items.find(item => item?.running) ?? null;
    // a run of another origin still going keeps its mirror fresh — the
    // account ALWAYS rides along, whatever submitted the job (our own
    // tracked run is excluded: its entry exists already)
    const scope = externalScopeOf(runningItem);
    if (scope) {
      mirrorExternal(scope);
    }
    else if (external && !runningItem) {
      // the mirrored run left the queue with no successor running:
      // settle by whatever sync-synced said before the fade
      settleExternal();
    }
    if (active) {
      const job = active;
      const live = new Set(items.map(j => j?.rid));
      if (job && !live.has(job.rid)) {
        queueMicrotask(() => {
          if (active !== job) {
            return;   // a kill line settled it already
          }
          active = null;
          clearStoredRun(job.rid);
          if (job.synced) {
            logger.done(job.rid, 'sync finished');
            if (onSynced) {
              onSynced(job.slug);
            }
          }
          else {
            logger.fail(job.rid, 'sync failed — see the sync client log');
          }
        });
      }
    }
    return;
  }
  // busy flips: an idle engine settles the external mirror (a clean run
  // stamped its synced flag above; a failed one shows the combo's own
  // failure wording); a newly busy engine with an account mirrors it —
  // the account ALWAYS rides along, whatever submitted the job
  if (msg?.type === 'sync-running') {
    if (!msg.busy) {
      settleExternal();
      return;
    }
    if (active && msg.rid && msg.rid === active.rid) {
      // our own tracked run took the engine over: any lingering mirror
      // yields (its run ended — the engine runs one session at a time)
      settleExternal();
      return;
    }
    const scope = externalScopeOf(msg);
    if (scope) {
      mirrorExternal(scope);
    }
    return;
  }
}

/**
 * Submits one sync run for the client-side account id (the
 * granted-directory slug) without opening the sync interface — a
 * full-account run, or a dir-scoped one when opts.dir names a folder.
 * One run at a time — across every client window: a click while a run is
 * pending re-pins that run's entry here and submits nothing.
 * @param {string} accountId
 * @param {object} [opts]
 * @param {string} [opts.dir] sync only this folder of the account
 */
export async function requestSync(accountId, {dir} = {}) {
  if (active) {
    return;
  }
  // a recorded run from another window (or before a reload): settle it
  // first — a still-running one re-pins and blocks the new submit, a
  // finished one shows its outcome and gives way
  const stored = await readStoredRun();
  if (stored && await reconstruct(stored)) {
    return;
  }
  const registry = await findRegistryAccount(accountId).catch(() => null);
  if (!registry) {
    // non-volatile: a failed entry persists until dismissed, immune to
    // the later log-line overwrites of the status text
    const errRid = 'cfg-' + Date.now().toString(36) + '-' + (++ridSeq);
    logger.begin({
      id: errRid,
      kind: 'sync',
      label: 'sync · ' + accountId,
      doneLabel: 'sync finished'
    });
    logger.fail(errRid,
      'account is not configured for sync (options page)');
    return;
  }
  const rid = 'job-' + Date.now().toString(36) + '-' + (++ridSeq);
  const scope = typeof dir === 'string' && dir ? ' · ' + dir : '';
  logger.begin({
    id: rid,
    kind: 'sync',
    label: 'sync · ' + (registry.name || registry.id) + scope,
    doneLabel: 'sync finished'
  });
  active = {
    rid,
    slug: registry.slug,
    id: registry.id,
    name: registry.name || registry.id,
    dir: scope ? dir : undefined,
    startedAt: Date.now(),
    synced: false
  };
  try {
    // the offscreen engine has no chrome.storage: the resolved config —
    // including the password — travels IN the request. Encrypted
    // passwords are decrypted just-in-time (the master-password prompt,
    // when one is configured, goes through the client's prompt-view);
    // a cancel or failure aborts before anything is sent.
    const storage = await chrome.storage.local.get('user.pass.' + registry.id)
      .catch(() => ({}));
    const pass = await decryptPassword(
      storage['user.pass.' + registry.id],
      promptEl,
      registry.name || registry.id
    );
    const payload = {
      type: 'sync-request',
      rid,
      kind: scope ? 'sync-dir' : 'sync',
      account: {...registry, pass}
    };
    if (scope) {
      payload.dir = dir;
      // an INBOX-scoped dir run behaves like the account sync for
      // filters: the pass targets the run's own new INBOX pulls. The
      // stored filter list travels from the WORKER's default-on attach
      // (nothing to load here) — the engine only ever applies it to the
      // INBOX scope, other folders sync bare, no filters run.
    }
    const res = await chrome.runtime.sendMessage(payload);
    if (!res?.ok || res?.started === false) {
      failRun(rid, 'request rejected: ' + (res?.reason || res?.error || 'unknown'));
      return;
    }
    // accepted: mirror the run into the session (a reload or another
    // client window can now re-attach) and keep the entry pinned until
    // the engine's sync-jobs broadcast drops the rid — unless it already
    // did (the broadcast races the response): then leave no record and
    // leave the settled entry alone
    if (active?.rid === rid) {
      await writeStoredRun({
        rid,
        slug: registry.slug,
        id: registry.id,
        name: registry.name || registry.id,
        dir: scope ? dir : undefined,
        startedAt: active.startedAt
      });
    }
    if (active?.rid === rid) {
      logger.update(rid, {state: 'running'});
    }
  }
  catch (e) {
    failRun(rid, e?.message || String(e));
  }
}

function failRun(rid, message) {
  if (active?.rid === rid) {
    active = null;
  }
  logger.fail(rid, message);
}
