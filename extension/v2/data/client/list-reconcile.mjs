'use strict';

// list-reconcile.mjs — the open-folder reconcile's guard state machine,
// extracted from filters.mjs so it stays unit-testable under plain node
// (filters.mjs itself transitively imports DOM-bound modules). The machine
// owns ONLY the deferral bookkeeping:
//
//   - star picker popover open → the reconcile is owed, retried on a short
//     timer until the picker closes, then flushed exactly once;
//   - search results shown → plain drop (clearSearch() re-renders the
//     folder from disk in full);
//   - the retry is BOUNDED: a leaked/never-closed mirror must not wedge
//     the mails view forever — after RETRY_MAX ticks the flush goes
//     through regardless (the worst case is a briefly detached popover,
//     which beats a dead view — the "stale until manual refresh" bug).
//
// All inputs are injected, this module touches no chrome/DOM directly.

// trailing edge: one retry per tick while the picker stays open
export const RETRY_MS = 250;
// bounded retries (~5 s) — then the flush forces through ("keep owing,
// keep retrying" must never become "owe forever")
export const RETRY_MAX = 20;

/**
 * Builds the reconciler. The flag callables are GETTERS evaluated per call.
 * @param {{syncCurrent: Function, starOpen?: Function, searching?: Function,
 *   retryMs?: number, retryMax?: number, log?: Function}} deps
 * @returns {{reconcile: Function, init: Function}} reconcile() per fs-event
 *   burst; init() resets the module state (for tests).
 */
export function createReconciler({
  syncCurrent,
  starOpen = null,
  searching = null,
  retryMs = RETRY_MS,
  retryMax = RETRY_MAX,
  log = () => {}
} = {}) {
  let deferred = false;   // a reconcile is owed once the picker closes
  let retries = 0;
  let retryTimer = null;

  const open = () => typeof starOpen === 'function' ? !!starOpen() : false;
  const mid = () => typeof searching === 'function' ? !!searching() : false;

  function flushDeferred() {
    clearTimeout(retryTimer);
    retryTimer = null;
    if (!deferred) {
      return;
    }
    if (open() && retries < retryMax) {
      retries++;   // palette still open — keep owing, keep retrying (bounded)
      scheduleRetry();
      return;
    }
    if (retries >= retryMax) {
      log('list reconcile flushed past the bounded retry cap');
    }
    deferred = false;
    retries = 0;
    syncCurrent?.();   // the guard targets absorb stale folder targets
    }

  function scheduleRetry() {
    if (!retryTimer) {
      retryTimer = setTimeout(flushDeferred, retryMs);
    }
  }

  function reconcile() {
    if (open()) {
      // deferred: the row this delta would touch may host the open popover;
      // flush once it closes (bounded retry while it stays open)
      if (!deferred) {
        log('list reconcile deferred — star picker open');
        retries = 0;
      }
      deferred = true;
      scheduleRetry();
      return;
    }
    if (mid()) {
      return;   // self-healing: clearSearch() → load() re-renders from disk
    }
    // a latched deferral rides along on this flush — identical folder re-diff
    deferred = false;
    retries = 0;
    clearTimeout(retryTimer);
    retryTimer = null;
    syncCurrent?.();
  }

  function init() {
    deferred = false;
    retries = 0;
    clearTimeout(retryTimer);
    retryTimer = null;
  }

  return {reconcile, init};
}
