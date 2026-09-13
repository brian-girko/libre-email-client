import {getMailApi} from './mail.mjs';
import * as logger from './logger.mjs';

// Per-account action queue. Every server-side operation (moves, flag
// changes, save-to-disk overrides, folder create/delete) is enqueued here by
// the modules that own the UI, so the queue is the single gateway to IMAP.
// Jobs run sequentially per account (the wasm client serializes commands
// anyway); different accounts run in parallel.
//
// A job is:
//   {
//     id, accountId, kind, label, doneLabel, quiet, uids, meta,
//     state: 'queued' | 'running' | 'done' | 'failed' | 'cancelled',
//     error, cancelable,
//     run,      // async (api, job) => server work
//     rollback  // () => undo the optimistic UI change on failure/cancel
//   }
// The caller applies the optimistic UI update BEFORE enqueueing and hands the
// queue the reverse via rollback. quiet jobs never show a bar line but still
// count against the close guard.
//
// Display is delegated to the unified activity logger (logger.mjs): this
// module only owns the queue and mirrors each job's lifecycle into the logger,
// so action lines and worker lines (filters, badge sync) share one bar.

let nextId = 1;
const queues = new Map();   // accountId -> {running: Job|null, pending: Job[]}
const jobSubs = new Set();  // lifecycle listeners: fn(phase, job)

// Job lifecycle events: 'start' (enqueued), 'done', 'fail' (after rollback),
// 'cancel' (after rollback). Consumers mirror the optimistic UI moments —
// e.g. counters.mjs predicting badge/folder counts.
function subscribe(fn) {
  jobSubs.add(fn);
  return () => jobSubs.delete(fn);
}

function fire(phase, job) {
  for (const fn of jobSubs) {
    try {
      fn(phase, job);
    }
    catch {
      // a lifecycle listener must never break the queue
    }
  }
}

// Ask the service worker to re-run the badge counter after unread-affecting
// work lands. Trailing debounce so a burst of actions (multi-select or the
// quiet auto mark-read on open) coalesces into one IMAP check. The worker
// guards against overlapping passes itself (single-flight runCheck). The
// recount is a background consequence of the action, so it updates the icon
// silently (silent: true) instead of flashing the '...' placeholder.
let badgeNotifyTimer = null;
const BADGE_NOTIFY_DELAY = 1000;
const BADGE_KINDS = new Set(['move', 'flags', 'save']);

function notifyBadge() {
  clearTimeout(badgeNotifyTimer);
  badgeNotifyTimer = setTimeout(() => {
    badgeNotifyTimer = null;
    chrome.runtime.sendMessage({type: 'badge-check', silent: true}).catch(() => {});
  }, BADGE_NOTIFY_DELAY);
}

function hasPending() {
  for (const [, q] of queues) {
    if (q.running || q.pending.length) {
      return true;
    }
  }
  return false;
}

function enqueue({
  accountId,
  kind,
  label,
  doneLabel,
  quiet = false,
  uids,
  meta,
  run,
  rollback
}) {
  const id = nextId++;
  const job = {
    id,
    accountId,
    kind,
    label: String(label ?? kind),
    doneLabel: doneLabel != null ? String(doneLabel) : String(label ?? kind),
    quiet: !!quiet,
    uids: Array.isArray(uids) ? uids.map(Number) : null,
    meta,
    run,
    rollback,
    state: 'queued',
    error: null,
    cancelable: true
  };
  logger.begin({
    id,
    source: 'action',
    kind,
    label: job.label,
    doneLabel: job.doneLabel,
    quiet: job.quiet,
    // queued jobs are cancelable; process() narrows this to save jobs once
    // the job is actually running (atomic batches cannot be interrupted)
    cancelable: true
  });
  let q = queues.get(accountId);
  if (!q) {
    q = {running: null, pending: []};
    queues.set(accountId, q);
  }
  q.pending.push(job);
  fire('start', job);
  process(accountId);
  return id;
}

async function process(accountId) {
  const q = queues.get(accountId);
  if (!q || q.running) {
    return;
  }
  const job = q.pending.shift();
  if (!job) {
    return;
  }
  q.running = job;
  job.state = 'running';
  // Only multi-stage save jobs can be interrupted mid-flight; a queued job is
  // always cancelable, a running atomic batch call is not.
  job.cancelable = job.kind === 'save';
  logger.update(job.id, {state: 'running', cancelable: job.cancelable});
  const initialLabel = job.label;

  try {
    const api = await getMailApi(job.accountId);
    await job.run(api, job);
    if (job.state === 'cancelled') {
      return;
    }
    job.state = 'done';
    if (job.quiet) {
      logger.remove(job.id);
    }
    else {
      // run() may have rewritten the label with a richer final message
      logger.done(job.id, job.label !== initialLabel ? job.label : job.doneLabel);
    }
    if (BADGE_KINDS.has(job.kind)) {
      notifyBadge();
    }
    fire('done', job);
  }
  catch (e) {
    if (job.state === 'cancelled') {
      return;
    }
    job.state = 'failed';
    job.error = e?.message || String(e);
    if (job.rollback) {
      try {
        job.rollback();
      }
      catch {}
    }
    fire('fail', job);
    if (job.quiet) {
      logger.remove(job.id);
    }
    else {
      logger.fail(job.id, job.error);
    }
  }
  finally {
    q.running = null;
    process(accountId);
  }
}

function cancel(id) {
  for (const [, q] of queues) {
    const idx = q.pending.findIndex(j => j.id === id);
    if (idx !== -1) {
      const [job] = q.pending.splice(idx, 1);
      if (job.rollback) {
        try {
          job.rollback();
        }
        catch {}
      }
      fire('cancel', job);
      logger.remove(id);
      return true;
    }
    if (q.running && q.running.id === id) {
      if (!q.running.cancelable) {
        return false;
      }
      q.running.state = 'cancelled';
      if (q.running.rollback) {
        try {
          q.running.rollback();
        }
        catch {}
      }
      fire('cancel', q.running);
      logger.remove(id);
      return true;
    }
  }
  return false;
}

// Failed action lines are no longer in the queue, so dismissing just drops the
// log line; known ids still return true (the queue owns them until they end).
function dismiss(id) {
  return logger.remove(id);
}

function accountPendingJobs(accountId) {
  const q = queues.get(accountId);
  if (!q) {
    return [];
  }
  return [...(q.running ? [q.running] : []), ...q.pending];
}

// True when the uid is already claimed by a job that relocates or deletes
// messages server-side (moves and save-override jobs). Flag jobs are
// excluded so a pending mark-read never blocks moving the same message.
const MOVING_KINDS = new Set(['move', 'save']);

function uidBusy(accountId, uid) {
  const q = queues.get(accountId);
  if (!q) {
    return false;
  }
  const hit = j => MOVING_KINDS.has(j.kind) && j.uids && j.uids.includes(Number(uid));
  return (q.running && hit(q.running)) || q.pending.some(hit);
}

// Progress/label updates from inside a running job's own steps (the
// save-to-disk loop): mirror them onto the job's logger line.
function updateJob(id, patch) {
  return logger.update(id, patch);
}

// Block closing the tab while queued/running work is in flight so the actions
// the user started are not abandoned mid-way. The browser shows its native
// leave-confirmation; there is no styleable close handler in a web page.
window.addEventListener('beforeunload', e => {
  if (hasPending()) {
    e.preventDefault();
    e.returnValue = '';
  }
});

export {enqueue, cancel, dismiss, updateJob, hasPending, accountPendingJobs, uidBusy, subscribe};
