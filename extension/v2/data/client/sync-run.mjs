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
// unchanged). Shift+Click keeps opening the sync interface instead
// (index.mjs).
//
// Feedback is one pinned logger entry per run: queued while the engine
// holds it, done/failed once the engine's sync-jobs broadcast drops the
// rid — the same settle signal the sync panel pins its buttons by. The
// engine's log stream ('sync-log') rides along: the newest line's raw
// content shows as the pinned entry's detail while the run is live (full
// history stays in the sync client's log pane).
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
import {loadFilters} from '../sync/filters/route.mjs';
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
      'sync ended while no client was watching — see the sync client log');
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
  readStoredRun()
    .then(run => {
      if (run && !active) {
        return reconstruct(run);
      }
      return null;
    })
    .catch(() => {});
}

function onMessage(msg) {
  if (!active) {
    return;
  }
  // the kill path (the sync interface's Stop button) broadcasts its
  // jobs state AND the goodbye log line before the engine document
  // dies — a kill must fail the entry, not finish it
  if (msg?.type === 'sync-log' &&
      (msg.lines || []).some(line => line?.type === 'kill')) {
    const job = active;
    active = null;
    clearStoredRun(job.rid);
    logger.fail(job.rid, 'sync stopped');
    return;
  }
  // mid-run detail: the newest engine log line rides on the pinned
  // entry as its detail (raw content — no prefix). Batches arrive per
  // flush; only the last one shows, a moving "last message" ticker.
  if (msg?.type === 'sync-log') {
    const lines = (msg.lines || []).filter(l =>
      l?.content != null && String(l.content).trim());
    const last = lines[lines.length - 1];
    if (last) {
      logger.update(active.rid, {detail: String(last.content)});
    }
    return;
  }
  // clean-completion stamp: the engine hands this to the worker only
  // when a run ended without failure, before the rid drop
  if (msg?.type === 'sync-synced' &&
      msg.accountId === active.id && msg.finishedAt != null) {
    active.synced = true;
    return;
  }
  // queue state: the engine keeps a running job listed until it
  // settles — the rid dropping means OUR job is done. The microtask
  // lets a same-batch kill line win the race against the drop.
  if (msg?.type === 'sync-jobs') {
    const job = active;
    const live = new Set((msg.items || []).map(j => j?.rid));
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
    logger.setStatus(
      'account "' + accountId + '" is not configured for sync (options page)',
      {tone: 'warn', time: Date.now()}
    );
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
    if (scope && dir.toUpperCase() !== 'INBOX') {
      payload.dir = dir;
    }
    else {
      if (scope) {
        // an INBOX-scoped dir run behaves like the account sync for
        // filters: the pass targets the run's own new INBOX pulls
        payload.dir = dir;
      }
      // the offscreen engine has no chrome.storage: the stored filter list
      // travels IN the job, and after the run lands the engine filters the
      // NEW INBOX messages (this run's pulls — new, not merely unread) on
      // the spot. The raw list goes over as stored: the engine applies the
      // runnable filter itself and numbers matches by stored order, exactly
      // like the sync interface's own "all filters" run. Dir-scoped runs
      // carry filters only when the run IS the INBOX — any other folder
      // syncs bare, no filters run.
      const filters = await loadFilters().catch(() => []);
      if (Array.isArray(filters) && filters.length) {
        payload.filters = filters;
      }
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
