'use strict';

// Unified activity logger for the mail client. Every panel reports through
// this store — the toolbar action queue (jobs.mjs) and the worker's filter
// passes — and the logger-view component renders it at the bottom of the mail
// panel. Nothing here knows about IMAP, chrome APIs or the DOM: it is a plain
// state store plus a subscribe hook.
//
// Two kinds of output:
//   - `entries`: transient operation lines (queued/running/done/failed), with
//     an optional {done, total} progress counter and an optional cancel/dismiss
//     affordance. Done lines self-remove after a short delay. Failed lines
//     stay until dismissed, but carry an optional `account` key: the store
//     keeps ONE failed line per account — a newer failure replaces the older
//     one and a success clears it — so repeated failures (an offline
//     periodic sync re-arming itself, say) never stack a red row per attempt.
//   - `status`: one persistent cross-panel line. No current source feeds it;
//     the plumbing stays available for future use.

const DONE_TTL = 4000;
const MAX_ENTRIES = 100;

const entries = new Map(); // id -> entry
const listeners = new Set();
let status = null; // {text, tone, time} | null

function notify() {
  const list = getAll();
  for (const fn of [...listeners]) {
    try {
      fn(list, status);
    }
    catch {
      /* a broken listener must not break the logger */
    }
  }
}

export function subscribe(fn) {
  listeners.add(fn);
  try {
    fn(getAll(), status);
  }
  catch {}
  return () => listeners.delete(fn);
}

export function getAll() {
  return [...entries.values()];
}

export function getStatus() {
  return status;
}

export function get(id) {
  return entries.get(id) || null;
}

// Persistent status line shown above/with the operation lines. Pass an empty
// text to clear it.
export function setStatus(text, {tone = 'info', time = Date.now()} = {}) {
  status = text ? {text: String(text), tone, time} : null;
  notify();
}

function normalizeProgress(progress) {
  if (!progress || typeof progress !== 'object') {
    return null;
  }
  return {done: Number(progress.done) || 0, total: Number(progress.total) || 0};
}

// Create (or reset) an operation line. `quiet` entries are tracked but never
// rendered (the auto mark-read stream), matching the old jobs bar behavior.
export function begin({
  id,
  source = 'action',
  kind = '',
  account = null,
  label = '',
  doneLabel = '',
  cancelable = false,
  quiet = false,
  progress = null
} = {}) {
  trim();
  const entry = {
    id,
    source,
    kind,
    // the one-failure-per-account key: whichever account (or registry id)
    // this entry belongs to, null when the entry has no account slot
    account: account == null || account === '' ? null : String(account),
    label: String(label ?? kind),
    doneLabel: String(doneLabel ?? label ?? kind),
    state: 'queued',
    error: null,
    detail: null,
    cancelable: !!cancelable,
    quiet: !!quiet,
    progress: normalizeProgress(progress),
    time: Date.now(),
    _timer: null
  };
  entries.set(id, entry);
  notify();
  return entry;
}

export function update(id, patch = {}) {
  const entry = entries.get(id);
  if (!entry) {
    return null;
  }
  if ('progress' in patch) {
    patch = {...patch, progress: normalizeProgress(patch.progress)};
  }
  Object.assign(entry, patch);
  if (patch.state && patch.state !== 'done' && patch.state !== 'failed' && entry._timer) {
    clearTimeout(entry._timer);
    entry._timer = null;
  }
  notify();
  return entry;
}

export function progress(id, done, total, label) {
  const entry = entries.get(id);
  if (!entry) {
    return null;
  }
  entry.progress = {done: Number(done) || 0, total: Number(total) || 0};
  if (label != null) {
    entry.label = String(label);
  }
  notify();
  return entry;
}

export function done(id, label) {
  const entry = entries.get(id);
  if (!entry) {
    return null;
  }
  entry.state = 'done';
  if (label != null) {
    entry.doneLabel = String(label);
  }
  entry.detail = null;
  // a successful run of this account clears its failure slot (quiet entries
  // are never rendered and stay out of the account rule entirely)
  if (!entry.quiet) {
    clearAccountFailures(entry.account, id);
  }
  if (entry.quiet) {
    remove(id);
    return entry;
  }
  scheduleRemove(id);
  notify();
  return entry;
}

export function fail(id, error) {
  const entry = entries.get(id);
  if (!entry) {
    return null;
  }
  entry.state = 'failed';
  entry.error = error == null ? 'failed' : String(error);
  entry.detail = null;
  // the one-failure-per-account rule: a newer failure for the same account
  // discards the older one (quiet entries never touch the slot at all)
  if (!entry.quiet) {
    clearAccountFailures(entry.account, id);
  }
  if (entry.quiet) {
    remove(id);
    return entry;
  }
  notify();
  return entry;
}

export function remove(id) {
  const entry = entries.get(id);
  if (!entry) {
    return false;
  }
  if (entry._timer) {
    clearTimeout(entry._timer);
    entry._timer = null;
  }
  entries.delete(id);
  notify();
  return true;
}

function scheduleRemove(id) {
  const entry = entries.get(id);
  if (!entry) {
    return;
  }
  if (entry._timer) {
    clearTimeout(entry._timer);
  }
  entry._timer = setTimeout(() => {
    entry._timer = null;
    remove(id);
  }, DONE_TTL);
}

// One error per account: a newer failure for the same account discards the
// older one, and a successful run of that account clears it. Repeated
// periodic-sync failures while offline therefore collapse to one line
// instead of stacking a red row per attempt. Quiet entries are never
// rendered, so they participate in neither direction; entries without an
// `account` key have no slot and behave exactly as before.
function clearAccountFailures(account, keepId) {
  if (!account) {
    return;
  }
  for (const [id, entry] of entries) {
    if (id !== keepId && entry.account === account && entry.state === 'failed') {
      remove(id);   // Map iteration tolerates deleting the current entry's neighbor
    }
  }
}

// Keep the store bounded: drop the oldest non-live lines when over the cap.
// Failed lines now evict too — a burst of failures (periodic sync offline,
// say) must never grow the store without bound; live queued/running lines
// are always spared.
function trim() {
  if (entries.size < MAX_ENTRIES) {
    return;
  }
  for (const [id, entry] of entries) {
    if (entry.state === 'done' || entry.state === 'failed') {
      remove(id);
      if (entries.size < MAX_ENTRIES) {
        return;
      }
    }
  }
}
