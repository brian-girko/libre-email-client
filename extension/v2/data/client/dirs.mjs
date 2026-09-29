import './components/directory-view.js';
import {getMailApi, dropMailApi} from './mail.mjs';
import {getPref, setPref} from './prefs.mjs';
import {enqueue, accountPendingJobs} from './jobs.mjs';
import * as counters from './counters.mjs';
import {listAccounts} from './accounts.mjs';
import {isSyncRunning} from './sync-events.mjs';
import {MODE_EXTERNAL, getStorageMode} from '../sync/root-handle.mjs';

let el = null;
let accountId = null;
let loadToken = 0;

const dirKey = id => 'dir.' + id;

// Mirror of the picker hand-off: the 'run setup' / 'open options' offers of
// the folder pane now lead to the two pages this extension has. With no
// account dir on the granted root the client page is dead weight: closing it
// when the picker opens avoids leaving two windows.
const PICKER_URL = '../picker/index.html';
const OPTIONS_URL = '../options/index.html';
const SYNC_URL = '../sync/client/index.html';

function openPage(url) {
  location.replace(chrome.runtime.getURL(url));
}

// The account dirs of the granted root, in memory on the tree view.
async function hasAccounts() {
  return (await listAccounts()).length > 0;
}

// The last folder list for the current account, in memory on the tree
// view. Used by list.mjs to resolve special folders (Trash/Archive/Junk)
// without an extra read before a move.
function currentDirs(id) {
  if (id !== accountId || !Array.isArray(el?.dirs)) {
    return [];
  }
  return el.dirs;
}

// A folder already being created or deleted must not be queued twice.
function dirJobPending(name) {
  return accountPendingJobs(accountId).some(j =>
    (j.kind === 'dir-create' || j.kind === 'dir-delete') && j.meta?.name === name
  );
}

// parent folder of a mailbox name, split on its hierarchy delimiter; null
// for top-level folders
function parentName(name, dirs) {
  const self = (Array.isArray(dirs) ? dirs : []).find(d => d?.name === name);
  const d = self?.delimiter || null;
  if (!d) {
    return null;
  }
  const base = name.endsWith(d) ? name.slice(0, -d.length) : name;
  const idx = base.lastIndexOf(d);
  return idx > 0 ? base.slice(0, idx) : null;
}

// Folder counts sweep. Best-effort decoration for the tree's unread/total
// column. Pure local reads: every folder's summary comes from the maildir
// filenames themselves, so the sweep answers from disk directly and streams
// per-folder results through the counter manager.
// Delta: reconcile only folders whose totals actually moved — the counter
// feed drives per-row text patches and the title/favicon, so re-emitting
// unchanged numbers on every sync broadcast is pure churn. `lastCounts`
// mirrors exactly what was delivered.
// Cancelled by any reload or account switch (token guard).
const lastCounts = new Map();   // accountId -> Map(folder -> {unread, total})

function deliverCount(id, page) {
  if (!page?.name) {
    return;
  }
  let map = lastCounts.get(id);
  if (!map) {
    map = new Map();
    lastCounts.set(id, map);
  }
  const prev = map.get(page.name);
  if (prev && prev.unread === page.unread && prev.total === page.total) {
    return;   // unchanged since the last delivery: skip the emit entirely
  }
  map.set(page.name, {unread: page.unread, total: page.total});
  counters.reconcile(id, page.name, page);
}

// Drop the mirror entries for folders that no longer exist — without it a
// recreated folder that painted the same numbers would be skipped forever.
function pruneCountCache(id, names) {
  const map = lastCounts.get(id);
  if (!map) {
    return;
  }
  const wanted = new Set(Array.isArray(names) ? names : []);
  for (const name of [...map.keys()]) {
    if (!wanted.has(name)) {
      map.delete(name);
    }
  }
}

async function countDirs(api, id, token) {
  try {
    // Consume the returned array even when the progress callback fired: a
    // callback drop must never leave the tree blank until the next sweep.
    const counts = await api.listDirCounts(({name, unread, total}) => {
      if (token !== loadToken || accountId !== id || !el || !el.isConnected) {
        return;
      }
      deliverCount(id, {name, unread, total});
    });
    if (token !== loadToken || accountId !== id || !el || !el.isConnected) {
      return;
    }
    for (const page of Array.isArray(counts) ? counts : []) {
      deliverCount(id, page);
    }
  }
  catch (e) {
    console.warn('[dirs] folder counts sweep failed:', e?.message || e);
  }
}

function notify(name) {
  el.dispatchEvent(new CustomEvent('dir-selected', {
    detail: {name, accountId},
    bubbles: true,
    composed: true
  }));
}

async function load(id) {
  accountId = id;
  const token = ++loadToken;
  el.loading();
  if (!id) {
    const running = isSyncRunning();
    if (await hasAccounts()) {
      el.optionsNeeded('Select an account to list its folders.');
    }
    else if (running) {
      el.setupNeeded('Initial sync in progress — please wait for it to complete.');
    }
    else if ((await getStorageMode()) === MODE_EXTERNAL) {
      el.setupNeeded('No account directories on the granted directory yet — run a sync first.');
    }
    else {
      // browser storage root: nothing to grant, the accounts missing are a
      // configuration matter, not a setup one
      el.optionsNeeded('No account directories yet — configure accounts and run a sync.');
    }
    return;
  }
  try {
    const api = await getMailApi(id);
    if (token !== loadToken) {
      return;
    }
    const dirs = await api.listDirs();
    if (token !== loadToken) {
      return;
    }
    const names = dirs.map(d => d?.name).filter(Boolean);
    counters.prune(id, names);
    pruneCountCache(id, names);
    if (token !== loadToken) {
      return;
    }
    el.dirs = dirs;
    countDirs(api, id, token);
    // Nothing to bring up to date in the background — the tree/list render
    // from the disk truth immediately (the picker's re-grant flow recovers a
    // lost handle; the sync engine's own pass refreshes the files).
    const saved = await getPref(dirKey(id), null);
    let initial = dirs.find(d => d.name === saved);
    if (!initial) {
      // saved folder no longer exists (deleted locally): clear the pref so
      // the stale name cannot linger
      if (saved != null) {
        await setPref(dirKey(id), null);
      }
      initial = dirs.find(d => d.name.toUpperCase() === 'INBOX') || dirs[0];
    }
    if (initial) {
      el.select(initial.name);
      if (initial.name !== saved) {
        await setPref(dirKey(id), initial.name);
      }
      if (token !== loadToken) {
        return;
      }
      notify(initial.name);
    }
    else {
      el.syncNeeded(isSyncRunning()
        ? 'Initial sync in progress — please wait for it to complete.'
        : 'This account has no folders yet — run a sync.');
    }
  }
  catch (e) {
    if (token !== loadToken) {
      return;
    }
    el.error(e?.message || String(e));
  }
}
function init(element) {
  el = element;
  // the settings dialog's "Expand sub dirs" checkbox (ui.dirsExpandSub, the
  // client settings dialog is the only writer) gates the tree's auto-
  // expansion; getPref caches, so folder loads read it without storage chatter
  getPref('dirsExpandSub', false).then(on => {
    if (el) {
      el.expandSubs = !!on;
    }
  });
  // Tree cells live-update straight from the counter manager: every folder
  // base (sweep, open-folder refresh) re-emits here with any pending user
  // action prediction applied on top.
  counters.subscribe(({accountId: id, folders}) => {
    if (!el || id !== accountId || !el.isConnected) {
      return;
    }
    for (const name of Array.isArray(folders) ? folders : []) {
      const p = counters.predicted(id, name);
      if (p) {
        el.addCount(name, p);
      }
    }
  });
  el.addEventListener('select', async e => {
    const name = e.detail?.name;
    if (!accountId || !name) {
      return;
    }
    await setPref(dirKey(accountId), name);
    notify(name);
  });
  el.addEventListener('retry', () => {
    if (!accountId) {
      return;
    }
    dropMailApi(accountId).finally(() => load(accountId));
  });
  el.addEventListener('open-setup', async () => {
    // the picker page grants / re-grants the external directory handle and
    // the client page comes back on its own once access is confirmed — in
    // browser-storage mode there is nothing to grant at all, so the offer
    // lands on the options page (accounts are managed and created there)
    if ((await getStorageMode()) === MODE_EXTERNAL) {
      return openPage(PICKER_URL);
    }
    openPage(OPTIONS_URL);
  });
  el.addEventListener('open-options', () => {
    // the options page is where accounts are managed and created
    location.replace(chrome.runtime.getURL(OPTIONS_URL));
  });
  el.addEventListener('open-sync', () => {
    // the sync client is what builds and refreshes the folder tree; the
    // mail client stays open so this offer does not cost the current spot
    chrome.runtime.sendMessage({cmd: 'iface-open', type: 'sync'});
  });
  // A populated tree needs no reload on sync start/finish: its rows
  // live-update through the counter feed (deliverCount → addCount) while
  // the list view reconciles itself in place. The EMPTY tree is the one
  // exception — the "Initial sync in progress" state must appear when the
  // first sync begins and clear when it lands — so only that path re-runs
  // the load's state derivation (and a tree with no rows re-reads cheaply).
  let lastSyncRunning = null;
  chrome.runtime.onMessage.addListener(msg => {
    if (msg?.type === 'sync-running') {
      const running = !!msg.busy;
      if (running !== lastSyncRunning) {
        lastSyncRunning = running;
        if (!el?.dirs?.length) {
          load(accountId);
        }
      }
    }
  });
  el.addEventListener('create-dir', e => {
    createDir(e);
  });
  el.addEventListener('delete-dir', e => {
    deleteDir(e);
  });
}

// Folder-list equality on the attributes the tree renders. The order is
// whatever listDirs() serves; a stable list must not re-render the tree.
function sameFolderList(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
    return false;
  }
  return a.every((d, i) =>
    d?.name === b[i]?.name &&
    (d?.delimiter ?? null) === (b[i]?.delimiter ?? null) &&
    JSON.stringify(d?.attrs ?? []) === JSON.stringify(b[i]?.attrs ?? [])
  );
}

// In-place tree refresh: re-read the folder list + counts from the
// granted root. Driven by the fs-event router (data/client/fs-events.mjs)
// on structural events — a folder of the current account was created or
// removed. No reload: the tree reconciles in place — `el.dirs` is
// re-assigned only when the folder set itself changed (folder
// create/drop), while the per-folder unread/total updates arrive through
// the counter feed row by row.
async function refreshTree() {
  if (!accountId || !el?.isConnected) {
    return;
  }
  try {
    const api = await getMailApi(accountId);
    const dirs = await api.listDirs();
    const names = dirs.map(d => d?.name).filter(Boolean);
    counters.prune(accountId, names);
    pruneCountCache(accountId, names);
    if (!el?.isConnected) {
      return;
    }
    if (!sameFolderList(el.dirs, dirs)) {
      el.dirs = dirs;
    }
    countDirs(api, accountId, loadToken);
  }
  catch {
    /* transient read failure: the next event retries */
  }
}

// The LIGHT half of the fs-event routing: folder names unchanged, only the
// per-folder unread/total moved (a message arrived, left or was renamed in
// {new,cur} of the current account). Re-runs the counter sweep alone — it
// streams per-folder results and deliverCount reconciles only the folders
// whose numbers actually moved; the tree rows never rebuild.
async function refreshCounts() {
  if (!accountId || !el?.isConnected) {
    return;
  }
  try {
    const api = await getMailApi(accountId);
    countDirs(api, accountId, loadToken);
  }
  catch {
    /* transient read failure: the next event retries */
  }
}

// "+ New" on the folder pane: ask for a name, create under the selected
// folder (top level when none). The folder appears in the tree immediately;
// the {tmp,new,cur} triple runs as a queued local job. On failure the tree
// is restored and the job line shows the error.
async function createDir(e) {
  if (!accountId) {
    return;
  }
  const {parent, delimiter} = e.detail || {};
  let name;
  try {
    name = await document.getElementById('prompt').ask(
      parent ? `New folder under "${parent}"` : 'New folder',
      {placeholder: 'Folder name'}
    );
  }
  catch {
    return;
  }
  name = String(name || '').trim();
  if (!name) {
    return;
  }
  const full = parent && delimiter ? parent + delimiter + name : name;
  if (dirJobPending(full)) {
    return;
  }

  const id = accountId;
  const saved = Array.isArray(el.dirs) ? el.dirs : [];

  // optimistic: add the leaf to the tree right away
  el.dirs = [...saved, {name: full, delimiter: delimiter || null, attrs: []}];

  enqueue({
    accountId: id,
    kind: 'dir-create',
    label: `Creating folder "${full}"`,
    doneLabel: `Created folder "${full}"`,
    meta: {name: full},
    run: async api => {
      await api.createDir(full);
      await setPref(dirKey(id), full);
      if (accountId !== id || !el.select(full)) {
        return;
      }
      notify(full);
    },
    rollback: () => {
      if (accountId !== id) {
        return;
      }
      el.dirs = saved;
    }
  });
}

// "Delete" on the folder pane: remove the confirmed folder. The node leaves
// the tree immediately (no descendants exist — only leaf folders are
// deletable), then the Maildir removal runs as a queued job; when the
// deleted folder was the selected one the selection moves up to the parent
// folder, or INBOX/the first folder without an openable parent.
async function deleteDir(e) {
  if (!accountId) {
    return;
  }
  const name = e.detail?.name;
  if (!name) {
    return;
  }
  if (dirJobPending(name)) {
    return;
  }

  const id = accountId;
  const saved = Array.isArray(el.dirs) ? el.dirs : [];
  const wasSelected = el.selected === name;

  // optimistic: drop the node from the tree right away
  el.dirs = saved.filter(d => d.name !== name);

  enqueue({
    accountId: id,
    kind: 'dir-delete',
    label: `Deleting folder "${name}"`,
    doneLabel: `Deleted folder "${name}"`,
    meta: {name},
    run: async api => {
      try {
        await api.deleteDir(name);
      }
      catch (err) {
        const msg = String(err?.message || err);
        // a retried delete after a dropped tree view can fail with "no such
        // mailbox" because the first attempt already removed it: gone = done
        if (!/no such mailbox|nonexistent|does ?not exist|doesn't exist|unknown mailbox/i.test(msg)) {
          throw err;
        }
      }
      if (accountId !== id || !wasSelected) {
        return;
      }
      const parent = parentName(name, el.dirs);
      const openable = !!parent && (Array.isArray(el.dirs) ? el.dirs : []).some(d =>
        d?.name === parent
        && !(Array.isArray(d.attrs) ? d.attrs : []).some(a => /\\noselect/i.test(String(a)))
      );
      const dirs = Array.isArray(el.dirs) ? el.dirs : [];
      const fallback = dirs.find(d => d.name.toUpperCase() === 'INBOX') || dirs[0];
      const target = openable ? parent : (fallback?.name ?? null);
      if (!target) {
        await setPref(dirKey(id), null);
        return;
      }
      await setPref(dirKey(id), target);
      if (el.select(target)) {
        notify(target);
      }
    },
    rollback: () => {
      if (accountId !== id) {
        return;
      }
      el.dirs = saved;
    }
  });
}

export {init, load, currentDirs, refreshTree as refresh, refreshCounts};
