import {getMailApi} from './mail.mjs';
import * as logger from './logger.mjs';

// Per-account action queue. Every operation (moves, flag changes, folder
// create/delete) is enqueued here by the modules that own the UI — each job
// is a local file operation on the granted directory handle. Jobs run
// sequentially per account.
//
// A job is:
//   {
//     id, accountId, kind, label, doneLabel, quiet, uids, meta,
//     state: 'queued' | 'running' | 'done' | 'failed' | 'cancelled',
//     error, cancelable,
//     run,      // async (api, job) => the work
//     rollback  // () => undo a small optimistic UI touch (flag styles) on
//               // failure/cancel; moves/deletes run real-first, no rollback
//   }
// Callers that touch the view before the op lands (flags) hand the queue the
// reverse via rollback. quiet jobs never show a bar line but still
// count against the close guard.
//
// Display is delegated to the unified activity logger (logger.mjs): this
// module only owns the queue and mirrors each job's lifecycle into the logger,
// so action lines and worker lines (filters, badge sync) share one bar.

let nextId = 1;
const queues = new Map();   // accountId -> {running: Job|null, saves: Set<Job> (always empty), pending: Job[]}
const jobSubs = new Set();  // lifecycle listeners: fn(phase, job)

// Job lifecycle events: 'start' (enqueued), 'done', 'fail' (after rollback),
// 'cancel' (after rollback). Consumers that mirror an optimistically applied
// UI moment can hook here — currently only the flag buttons' style revert
// rides on rollback; rows for moves/deletes are never hidden up front.
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

// Local file edits are fast; the queue stays for UI coherence (labels,
// progress, cancellation) and the uidBusy guard over multi-select bursts.

function hasPending() {
  for (const [, q] of queues) {
    if (q.running || q.pending.length || q.saves.size) {
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
    q = {running: null, saves: new Set(), pending: []};
    queues.set(accountId, q);
  }
  q.pending.push(job);
  fire('start', job);
  process(accountId);
  return id;
}

// Every kind is serialized. runJob mirrors the job's state into the logger.
async function runJob(accountId, job, finish) {
  job.state = 'running';
  job.cancelable = false;
  logger.update(job.id, {state: 'running', cancelable: false});
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
    finish();
  }
}

function process(accountId) {
  const q = queues.get(accountId);
  if (!q) {
    return;
  }
  // one serialized slot: every job is a local file operation, sequential is
  // plenty and keeps the queue reasoning simple
  if (!q.running) {
    const idx = q.pending.findIndex(j => true);
    if (idx !== -1) {
      const [job] = q.pending.splice(idx, 1);
      job.state = 'running';
      q.running = job;
      runJob(accountId, job, () => {
        q.running = null;
        process(accountId);
      });
    }
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
    // a running job cannot be interrupted mid-flight (cancellation only
    // removes pending jobs); running jobs finish on their own
    return false;
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
  return [...(q.running ? [q.running] : []), ...q.saves, ...q.pending];
}

// True when the uid is already claimed by a job that relocates or deletes
// messages (moves, native saves, deletes, purges). Flag jobs are excluded
// so a pending mark-read never blocks moving the same message.
const MOVING_KINDS = new Set(['move', 'purge', 'save', 'delete']);

function uidBusy(accountId, uid) {
  const q = queues.get(accountId);
  if (!q) {
    return false;
  }
  const hit = j => MOVING_KINDS.has(j.kind) && j.uids && j.uids.includes(Number(uid));
  return (q.running && hit(q.running)) || [...q.saves].some(hit) || q.pending.some(hit);
}

// Progress/label updates from inside a running job's own steps: mirror them
// onto the job's logger line.
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
