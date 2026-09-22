import './components/directory-view.js';
import {getMailApi, dropMailApi} from './mail.mjs';
import {mirrorChanged} from './local-api.mjs';
import {getPref, setPref} from './prefs.mjs';
import {enqueue, accountPendingJobs} from './jobs.mjs';
import * as counters from './counters.mjs';
import {listAccounts} from './accounts.mjs';
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
// Cancelled by any reload or account switch (token guard).
async function countDirs(api, id, token) {
  try {
    // Consume the returned array even when the progress callback fired: a
    // callback drop must never leave the tree blank until the next sweep.
    const counts = await api.listDirCounts(({name, unread, total}) => {
      if (token !== loadToken || accountId !== id || !el || !el.isConnected) {
        return;
      }
      counters.reconcile(id, name, {unread, total});
    });
    if (token !== loadToken || accountId !== id || !el || !el.isConnected) {
      return;
    }
    for (const page of Array.isArray(counts) ? counts : []) {
      if (page?.name) {
        counters.reconcile(id, page.name, page);
      }
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
    if (await hasAccounts()) {
      el.optionsNeeded('Select an account to list its folders.');
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
    counters.prune(id, dirs.map(d => d?.name).filter(Boolean));
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
      el.syncNeeded('This account has no folders yet — run a sync.');
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
    window.open(chrome.runtime.getURL(SYNC_URL), '_blank');
  });
  el.addEventListener('create-dir', e => {
    createDir(e);
  });
  el.addEventListener('delete-dir', e => {
    deleteDir(e);
  });
  // Local mutations (folder create/delete moves the tree) refresh the tree
  // in place: re-read the folder list + counts from the handle.
  mirrorChanged.subscribe(async evt => {
    if (evt?.accountId !== accountId || !el?.isConnected) {
      return;
    }
    try {
      const api = await getMailApi(accountId);
      const dirs = await api.listDirs();
      counters.prune(accountId, dirs.map(d => d?.name).filter(Boolean));
      if (!el?.isConnected) {
        return;
      }
      el.dirs = dirs;
      countDirs(api, accountId, loadToken);
    }
    catch {
      /* transient read failure: the next event retries */
    }
  });
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

export {init, load, currentDirs};
