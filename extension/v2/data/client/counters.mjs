// Folder counter store.
//
// Every counter shown for a folder (unread/total in the tree, the unread
// base the client title uses) is served from here: the last mirror-confirmed
// base, reconciled whenever the list/folder view re-reads the local copy.
// Actions no longer predict — the mirror only moves when the engine's sync
// lands server truth, and each landed sync reconciles the open folder, the
// tree-count sweep and the open-folder refresh.
//
// In-memory only: a page reload rebuilds it from the next sweep.

const accounts = new Map();   // accountId -> Map(folder -> {unread, total})
const subs = new Set();

function emit(accountId, folders) {
  for (const fn of subs) {
    try {
      fn({accountId, folders});
    }
    catch {
      // a listener must never break the counter path
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
    s = {unread: null, total: null};
    m.set(folder, s);
  }
  return s;
}

// Mirror-truth arrival (dir-count sweep results, open-folder load, in-place
// list sync). Replaces the stored base wholesale: the numbers come from the
// local copy, which now reflects every landed action.
function reconcile(accountId, folder, counts) {
  const s = stateOf(accountId, folder);
  if (!s) {
    return;
  }
  s.unread = Math.max(0, Math.round(Number(counts?.unread) || 0));
  s.total = Math.max(0, Math.round(Number(counts?.total) || 0));
  emit(accountId, [folder]);
}

// Counter truth resolution for a folder should not leave stale entries after
// a folder or whole account disappears server-side.
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

// The last mirror-confirmed view of a folder. Null when nothing is known
// (callers keep showing their "-/-" placeholder).
function predicted(accountId, folder) {
  const s = accounts.get(accountId)?.get(folder);
  if (!s || s.unread == null) {
    return null;
  }
  return {
    unread: Math.max(0, s.unread),
    total: s.total == null ? null : Math.max(0, s.total)
  };
}

function subscribe(fn) {
  subs.add(fn);
  return () => subs.delete(fn);
}

export {
  predicted,
  prune,
  dropAccount,
  reconcile,
  subscribe
};
