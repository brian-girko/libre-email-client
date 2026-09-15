import {getMailApi} from './mail.mjs';
import * as logger from './logger.mjs';

// Per-account action queue. Every server-side operation (moves, flag
// changes, save-to-disk overrides, folder create/delete) is enqueued here by
// the modules that own the UI, so the queue is the single gateway to IMAP.
// Jobs run sequentially per account — except save-to-disk jobs, which run in
// their own concurrent bank so a new archive never waits for an in-flight
// one (the wasm client serializes IMAP commands anyway).
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
const queues = new Map();   // accountId -> {running: Job|null, saves: Set<Job>, pending: Job[]}
const SAVE_SLOTS = 3;       // concurrent save jobs per account
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

// Saves run in their own concurrent bank (SAVE_SLOTS at once) so a new
// archive starts immediately while earlier ones are still copying to disk —
// IMAP safety comes from the wasm client's FIFO and uidBusy() filters uid
// clashes. Every other kind stays serialized and only starts when both
// lanes are idle, so counter predictions never interleave.
async function runJob(accountId, job, finish) {
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
    finish();
  }
}

function process(accountId) {
  const q = queues.get(accountId);
  if (!q) {
    return;
  }
  // start save jobs until the save bank is full
  while (q.saves.size < SAVE_SLOTS) {
    const idx = q.pending.findIndex(j => j.kind === 'save');
    if (idx === -1) {
      break;
    }
    const [job] = q.pending.splice(idx, 1);
    job.state = 'running';
    q.saves.add(job);
    runJob(accountId, job, () => {
      q.saves.delete(job);
      process(accountId);
    });
  }
  // one serialized slot for every non-save kind: it only starts when both
  // lanes are idle so its counter prediction never interleaves with a save
  if (!q.running && !q.saves.size) {
    const idx = q.pending.findIndex(j => j.kind !== 'save');
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
    // a cancelled save job shares its lane; its cancelable flag says whether
    // it may be interrupted mid-flight (cancellation is cooperative: the
    // loop inside run() notices state 'cancelled' and stops)
    const flying = q.running?.id === id ? q.running : [...q.saves].find(j => j.id === id);
    if (flying) {
      if (!flying.cancelable) {
        return false;
      }
      flying.state = 'cancelled';
      if (flying.rollback) {
        try {
          flying.rollback();
        }
        catch {}
      }
      fire('cancel', flying);
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
  return [...(q.running ? [q.running] : []), ...q.saves, ...q.pending];
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
  return (q.running && hit(q.running)) || [...q.saves].some(hit) || q.pending.some(hit);
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
