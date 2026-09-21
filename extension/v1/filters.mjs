'use strict';

// Filter orchestration in the service worker. The engine itself is
// environment-agnostic (core/filters/engine.mjs); this module owns the
// worker-side plumbing:
//
//   - the engine's filter pre-pass (setFilterPrePass): every sync pass runs
//     an incremental 'new' pass on the server before copying anything into
//     the mirror. ('filters-check' runtime messages — the options page
//     "Run filters now" button — run a standalone pass explicitly; the button
//     may request scope 'unread', a one-off sweep over all unread INBOX
//     mail.)
//   - persisting outcomes in session storage ('filters.last') so the
//     options page and the client status stay current.
//   - triggering a badge re-check after mail was moved/deleted (badge.mjs
//     registers the trigger to avoid a circular import).
//   - broadcasting run milestones ('activity', source 'filters') so the open
//     client can show filter activity as read-only lines in its logger.
//   - a mutex shared by the standalone pass and the badge pre-pass so two
//     passes never interleave on the same account's watermark. The badge
//     pre-pass also runs its unread count inside this mutex, so the count is
//     atomic with the filter pass.

import {
  runAccountFilters,
  runFilters as runEnginePass,
  filtersForAccount
} from './core/filters/engine.mjs';
import {
  openServerApi,
  engine as syncEngine,
  setFilterPrePass
} from './core/sync/engine.mjs';
import {emitActivity} from './activity.mjs';

const msg = e => e?.message || String(e);

let running = null;
let mutex = Promise.resolve();
let badgeTrigger = null;

// Registered by badge.mjs: re-run the badge check after filters moved or
// deleted mail (single-flight there coalesces with any running check).
export function setBadgeTrigger(fn) {
  badgeTrigger = typeof fn === 'function' ? fn : null;
}

// Registered with the sync engine: every sync pass runs this incremental
// filter pass on the server BEFORE any folder is pulled into the mirror, so
// the local copy only ever holds post-filter placement (no mail shows up in
// a folder a rule is about to move it out of). The pass's own post-action
// syncs carry reason 'filters' and skip the hook, so this cannot recurse.
setFilterPrePass(() => runFilters('new'));

// Serialize filter passes: the badge pre-pass and a standalone run must not
// process the same account's watermark at the same time.
function withLock(fn) {
  const run = mutex.then(fn, fn);
  mutex = run.then(() => {}, () => {});
  return run;
}

// Progress forwarder: throttled per account (~200 ms) and always emitted on
// the final item. `requireAction` keeps periodic badge pre-passes silent until
// they actually move/delete something, so a no-op tick adds no log line.
function progressEmitter({requireAction = false} = {}) {
  const last = new Map(); // accountId -> timestamp
  return (entry, done, total) => {
    if (requireAction && !entry.moved && !entry.deleted) {
      return;
    }
    const now = Date.now();
    if (done < total && now - (last.get(entry.id) || 0) < 200) {
      return;
    }
    last.set(entry.id, now);
    emitActivity({
      source: 'filters', phase: 'progress',
      accountId: entry.id, label: entry.label,
      done, total, moved: entry.moved, deleted: entry.deleted
    });
  };
}

async function storeResult(result) {
  try {
    await chrome.storage.session.set({'filters.last': result});
  }
  catch {
    // the worker may be shutting down
  }
}

async function doRun(scope) {
  const result = await runEnginePass({
    scope,
    onAccountStart: entry => emitActivity({
      source: 'filters', phase: 'start', accountId: entry.id, label: entry.label
    }),
    onAccountEnd: entry => emitActivity({
      source: 'filters', phase: 'end', accountId: entry.id, label: entry.label,
      moved: entry.moved, deleted: entry.deleted, errors: entry.errors,
      changes: [...(entry.changes || [])]
    }),
    onAccountProgress: progressEmitter()
  });
  await storeResult(result);
  if (result.total > 0 && badgeTrigger) {
    try {
      badgeTrigger();
    }
    catch {}
  }
  return result;
}

// scope: 'new' (default, incremental watermark pass) or 'unread' (the
// options page's one-off all-unread sweep). A run already in flight wins:
// concurrent callers share its result regardless of scope.
export function runFilters(scope) {
  if (running) {
    return running;
  }
  running = withLock(() => doRun(scope))
    .catch(e => {
      console.warn('[filters] run failed', e);
      return null;
    })
    .finally(() => {
      running = null;
    });
  return running;
}

// Badge pre-pass, under the shared mutex: (1) apply this account's filters
// directly on the server (openServerApi — no mirror involvement), (2) sync
// the account so the mirror ingests the post-filter state, (3) run the
// badge's count over the mirror. The count can therefore never see mail a
// rule moved, and no standalone pass can slip between the steps.
// `count(entry)` is the caller's count callback; it receives the filter
// outcome (or null when no filter applies) and its return value is handed
// back as `counted`. resync toggles the sync depth (full on user/alarm
// checks, light for the silent post-action recount).
// Returns {entry, counted}; entry is null when no filter applies.
export async function runForBadge({accountId, label, count, resync = true, reason = 'filters'}) {
  const filters = await filtersForAccount(accountId);
  const out = await withLock(async () => {
    let entry = null;
    if (filters.length) {
      entry = await applyForBadge({accountId, label, filters, onProgress: progressEmitter({requireAction: true})});
    }
    // the mirror ingest: post-filter server truth before the count reads it.
    // skipFilterPrePass: this path already applied the filters under the
    // shared mutex — the engine must not run them a second time.
    try {
      await syncEngine.sync(accountId, {mode: resync ? 'full' : 'light', reason, skipFilterPrePass: true});
    }
    catch {
      // sync failure (offline/credentials): the count still runs and the
      // badge keeps working off whatever mirror state exists
    }
    const counted = typeof count === 'function' ? await count(entry) : null;
    return {entry, counted};
  });
  if (out.entry) {
    await mergeIntoLast(out.entry);
  }
  return out;
}

// Badge pre-pass body (caller holds the filter mutex via runForBadge): the
// filter pass runs server-side via the engine's shared session (openServerApi
// — no mirror involvement); the engine sync that follows in runForBadge
// brings the mirror to the post-filter state before the count reads it. A
// periodic pass stays silent unless it actually moved or deleted mail or hit
// an error, so the logger only reports real filter activity.
async function applyForBadge({accountId, label, filters, onProgress}) {
  const entry = {id: accountId, label, moved: 0, deleted: 0, errors: [], changes: []};
  const serverApi = await openServerApi(accountId);
  try {
    await runAccountFilters({api: serverApi, accountId, filters, entry, onProgress});
  }
  finally {
    try {
      await serverApi.close();
    }
    catch {}
  }
  if (entry.moved || entry.deleted || entry.errors.length) {
    emitActivity({
      source: 'filters', phase: 'end', accountId, label,
      moved: entry.moved, deleted: entry.deleted, errors: entry.errors,
      changes: [...(entry.changes || [])]
    });
  }
  return entry;
}

// Merge one account's outcome into the shared 'filters.last' status.
async function mergeIntoLast(entry) {
  try {
    const {['filters.last']: last} = await chrome.storage.session.get('filters.last');
    const base = last && Array.isArray(last.accounts)
      ? last
      : {time: Date.now(), accounts: []};
    const accounts = base.accounts.filter(a => a.id !== entry.id);
    accounts.push(entry);
    await chrome.storage.session.set({
      'filters.last': {
        ...base,
        time: Date.now(),
        accounts,
        total: accounts.reduce((s, a) => s + (a.moved || 0) + (a.deleted || 0), 0)
      }
    });
  }
  catch {
    /* best-effort */
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'filters-check') {
    return;
  }
  // only the options page's "Run filters now" button asks for the 'unread'
  // sweep; the client-open trigger and any other caller stay incremental.
  runFilters(message.scope === 'unread' ? 'unread' : 'new')
    .then(result => sendResponse({ok: true, result}))
    .catch(e => sendResponse({ok: false, error: msg(e)}));
  return true; // keep the channel open for the async response
});