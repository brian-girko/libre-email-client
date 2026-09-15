import * as jobs from './jobs.mjs';

// Global predictive counter manager.
//
// Every counter shown for a folder (unread/total in the tree, unread on the
// action icon) is served from here as: last server-confirmed base + pending
// predictions from still-unconfirmed user actions. The prediction is applied
// at the same moment the optimistic UI updates and vanishes as soon as server
// truth arrives (dir-count sweep, open-folder refresh, badge check end).
// In-memory only: a page reload drops every prediction.
//
// Badge accounting: the action icon counts *conversations* with unread mail
// in one folder per account ("count unread in folder"; query mode cannot be
// predicted). A mark-read ticks down one per affected conversation, a move
// ticks down only when the moved conversation's unread remainder reaches
// zero in the source folder and ticks up in the target whenever unread mail
// actually arrives.
//
// Applied deltas are recorded per job id (jobApplied), so an interrupted job
// can be reverted with exact numbers: the inverse of the UI rollback, hooked
// onto the job's fail/cancel lifecycle in jobs.mjs. 'done' keeps the deltas
// until server truth (reconcile) resolves them.

const accounts = new Map();   // accountId -> Map(folder -> {unread, total, du, dt, db})
const jobApplied = new Map(); // jobId -> [{accountId, folder, dUnread, dTotal, dBadge}]
const subs = new Set();

// Per-account badge folder name, null when this account cannot be predicted
// (badge off, query-count mode, unknown account). The worker decides what to
// display; this side only maps which folder its own actions predict.
let badgeFolders = new Map();

async function refreshBadgeFolders() {
  try {
    const cfg = await chrome.storage.local.get({'badge.enabled': true});
    if (cfg['badge.enabled'] === false) {
      badgeFolders = new Map();
      return;
    }
    const all = await chrome.storage.local.get(null);
    const map = new Map();
    for (const [key, value] of Object.entries(all)) {
      const m = key.match(/^email\.badgeFolder\.(.+)$/);
      if (m) {
        map.set(m[1], value);
      }
    }
    for (const a of Array.isArray(all.accounts) ? all.accounts : []) {
      if (!a?.id) {
        continue;
      }
      map.set(a.id, all['email.badgeMode.' + a.id] === 'query' ? null : (map.get(a.id) || 'INBOX'));
    }
    badgeFolders = map;
  }
  catch {
    // storage unreachable: no badge predictions until it answers again
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') {
    return;
  }
  if ('badge.enabled' in changes || 'accounts' in changes ||
      Object.keys(changes).some(k => k.startsWith('email.badge') || k.startsWith('badge.'))) {
    refreshBadgeFolders();
  }
});

function emit(accountId, folders) {
  for (const fn of subs) {
    try {
      fn({accountId, folders});
    }
    catch {
      // a listener must never break the prediction path
    }
  }
}

function stateMap(accountId) {
  let m = accounts.get(accountId);
  if (!m) {
    m = new Map();
    accounts.set(accountId, m);
  }
  return m;
}

function stateOf(accountId, folder) {
  if (!folder) {
    return null;
  }
  const m = stateMap(accountId);
  let s = m.get(folder);
  if (!s) {
    s = {unread: null, total: null, du: 0, dt: 0, db: 0};
    m.set(folder, s);
  }
  return s;
}

// The pending badge delta summed over every tracked folder; the favicon uses
// it while the action icon's own number still holds the last real count.
function badgePending() {
  let sum = 0;
  for (const m of accounts.values()) {
    for (const s of m.values()) {
      sum += s.db;
    }
  }
  return sum;
}

// Push pending badge deltas to the service worker so the toolbar icon ticks
// along with the favicon and the tree until the next real check.
function sendBadgePredict(accountId, delta) {
  if (!delta) {
    return;
  }
  try {
    chrome.runtime.sendMessage({type: 'badge-predict', accountId, delta: Number(delta)}).catch(() => {});
  }
  catch {
    // worker unreachable: predictions stay client-side until reconcile
  }
}

function normalize(ops) {
  const out = (Array.isArray(ops) ? ops : [ops]).filter(Boolean);
  return out.map(op => ({
    accountId: op.accountId,
    folder: String(op.folder || ''),
    dUnread: Math.round(Number(op.dUnread) || 0),
    dTotal: Math.round(Number(op.dTotal) || 0),
    dBadge: Math.round(Number(op.dBadge) || 0)
  })).filter(op => op.folder && (op.dUnread || op.dTotal || op.dBadge));
}

function mut(record, sign) {
  const s = stateOf(record.accountId, record.folder);
  if (!s) {
    return;
  }
  // Deltas are kept signed and unclamped: predicted() clamps the displayed
  // result at 0 and the worker clamps its badge total, so clamping here would
  // only destroy the prediction (every delta starts at 0, so a negative one
  // would be dropped) and break apply/revert symmetry.
  s.du += sign * record.dUnread;
  s.dt += sign * record.dTotal;
  s.db += sign * record.dBadge;
  sendBadgePredict(record.accountId, sign * record.dBadge);
}

// Apply the predicted effect of a job (also used mid-run by multi-step save
// jobs whose server outcome is only known at that step). Recorded under the
// job id so a later failure/cancel reverts exactly these numbers. Ops carry
// either their own accountId or inherit the job's.
function apply(job, ops) {
  const rows = normalize(ops);
  if (!rows.length || !job) {
    return;
  }
  let list = jobApplied.get(job.id);
  if (!list) {
    list = [];
    jobApplied.set(job.id, list);
  }
  for (const op of rows) {
    const record = {
      accountId: op.accountId || job.accountId,
      folder: op.folder,
      dUnread: op.dUnread,
      dTotal: op.dTotal,
      dBadge: op.dBadge
    };
    list.push(record);
    mut(record, +1);
  }
  for (const accountId of new Set(rows.map(op => op.accountId || job.accountId))) {
    const folders = new Set(rows.filter(op => (op.accountId || job.accountId) === accountId).map(op => op.folder));
    emit(accountId, [...folders]);
  }
}

// Server-truth arrival (dir-count sweep results). Replaces base and pending,
// because the truth already contains everything the deltas were guessing for.
function reconcile(accountId, folder, counts) {
  const s = stateOf(accountId, folder);
  if (!s) {
    return;
  }
  s.unread = Math.max(0, Math.round(Number(counts?.unread) || 0));
  s.total = Math.max(0, Math.round(Number(counts?.total) || 0));
  s.du = 0;
  s.dt = 0;
  if (badgeFolders.get(accountId) === folder) {
    s.db = 0;
  }
  emit(accountId, [folder]);
}

// Arrived mail detected by the badge pass (uidnext/exists grew): not a user
// action, so nothing records a job; the next sweep/badge-end resolves it.
// Tree counts only: the badge total in the same end event already includes
// the arrived mail, so a badge delta here would double-count it (icon text
// above the tooltip's fresh count until the next real check).
function arrival(accountId, folder, delta) {
  if (!Number.isInteger(delta) || delta <= 0) {
    return;
  }
  const s = stateOf(accountId, folder);
  if (!s) {
    return;
  }
  s.du += delta;
  s.dt += delta;
  emit(accountId, [folder]);
}

// The worker's real check finished: its total already includes every action
// that could have predicted, so the client-side badge deltas reset to zero.
function clearBadgeDeltas() {
  for (const m of accounts.values()) {
    for (const s of m.values()) {
      s.db = 0;
    }
  }
}

// Open-folder refresh / sweep resolution for a folder should not leave stale
// entries after a folder or whole account disappears server-side.
function prune(accountId, names) {
  const m = accounts.get(accountId);
  if (!m) {
    return;
  }
  const keep = new Set(Array.isArray(names) ? names : []);
  for (const folder of [...m.keys()]) {
    if (!keep.has(folder)) {
      m.delete(folder);
    }
  }
}

function dropAccount(accountId) {
  if (accounts.delete(accountId)) {
    emit(accountId, []);
  }
}

// The last server-confirmed view of a folder, predictions included. Null when
// nothing is known (callers keep showing their "-/-" placeholder).
function predicted(accountId, folder) {
  const s = accounts.get(accountId)?.get(folder);
  if (!s || s.unread == null) {
    return null;
  }
  return {
    unread: Math.max(0, s.unread + s.du),
    total: s.total == null ? null : Math.max(0, s.total + s.dt)
  };
}

// The per-chat badge folder for a given account, for producers to decide
// which of their folders' ops should carry badge deltas.
function badgeFolder(accountId) {
  return badgeFolders.get(accountId) ?? null;
}

// ---- job lifecycle wiring (jobs.mjs events) --------------------------------



// 'start'   -> predictions from meta.counters applied (optimistic moment)
// 'fail'/'cancel' -> revert everything recorded for the job
// 'done'    -> deltas stay until server truth reconciles the folder
function onJob(phase, job) {
  if (!job) {
    return;
  }
  if (phase === 'start') {
    const counters = job.meta?.counters;
    if (counters?.ops?.length) {
      apply(job, counters.ops);
    }
    return;
  }
  if (phase === 'fail' || phase === 'cancel') {
    const list = jobApplied.get(job.id);
    if (!list) {
      return;
    }
    for (const record of list) {
      mut(record, -1);
    }
    jobApplied.delete(job.id);
    for (const accountId of new Set(list.map(r => r.accountId))) {
      emit(accountId, [...new Set(list.filter(r => r.accountId === accountId).map(r => r.folder))]);
    }
  }
}

jobs.subscribe(onJob);
refreshBadgeFolders();

function subscribe(fn) {
  subs.add(fn);
  return () => subs.delete(fn);
}

export {
  badgeFolder,
  badgePending,
  apply,
  arrival,
  clearBadgeDeltas,
  predicted,
  prune,
  dropAccount,
  reconcile,
  refreshBadgeFolders,
  subscribe
};
