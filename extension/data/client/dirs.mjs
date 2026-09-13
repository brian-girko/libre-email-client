import './components/directory-view.js';
import {getMailApi, dropMailApi} from './mail.mjs';
import {getPref, setPref} from './prefs.mjs';
import {enqueue, accountPendingJobs} from './jobs.mjs';
import * as counters from './counters.mjs';
import {detectNativeClient} from '/core/native/native-client.mjs';

let el = null;
let accountId = null;
let loadToken = 0;

const dirKey = id => 'dir.' + id;

function hasAccounts() {
  return chrome.storage.local.get({accounts: []})
    .then(prefs => Array.isArray(prefs.accounts) && prefs.accounts.length > 0);
}

// Mirrors the setup gate (data/setup/bridge.mjs), with one deliberate
// difference: 'setup.done' (the dismissed-setup flag) is ignored here. The
// auto-popup may stay silent after a dismissal, but the pane's "Run Setup"
// offer must come back whenever the extension still cannot reach the mail
// server — a stale dismissal flag must not hide it. An external ws URL is
// trusted (a down server is a Retry case, not a setup case); native mode is
// probed for real, because mail.mjs fails before ever touching the bridge
// ("Account not found" with an empty account list) so the load error itself
// proves nothing about the bridge.
async function setupIncomplete() {
  try {
    const {'ws.mode': mode, 'ws.url': url} = await chrome.storage.local.get({
      'ws.mode': 'native',
      'ws.url': ''
    });
    if (mode === 'external' && /^wss?:\/\//.test(url)) {
      return false;
    }
    // fast pong when installed, immediate connectNative failure when not
    return !(await detectNativeClient()).installed;
  }
  catch {
    return false;
  }
}

// The last server folder list for the current account, in memory on the tree
// view. Used by list.mjs to resolve special folders (Trash/Archive/Junk)
// without an extra round-trip before an optimistic move.
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

// parent folder of an IMAP mailbox name, split on the folder's own
// hierarchy delimiter; null for top-level folders
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
// column: each selectable folder costs one server-side SEARCH, walked
// sequentially through the wasm FIFO. Results land in the counter manager
// (server-confirmed base), which re-emits per folder — sweep result *and*
// pending predictions on top of it — via the subscription set up in init().
// Cancelled by any reload or account switch (token guard).
async function countDirs(api, id, token) {
  try {
    await api.listDirCounts(({name, unread, total}) => {
      if (token !== loadToken || accountId !== id || !el || !el.isConnected) {
        return;
      }
      counters.reconcile(id, name, {unread, total});
    });
  }
  catch (e) {
    console.warn('[dirs] folder counts sweep failed:', e?.message || e);
    // no search support (or the session died): the column simply stays empty
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
    // No accounts configured (empty select): the pane must not dead-end on
    // "No account selected" — without a bridge this is the setup case.
    if (await setupIncomplete()) {
      el.setupNeeded('Setup is not finished: configure a remote WS server or install the native client, then add an account.');
    }
    else {
      el.error('No account selected');
    }
    return;
  }
  try {
    const api = await getMailApi(id);
    if (token !== loadToken) {
      return;
    }
    const dirs = await api.listDirs();
    counters.prune(id, dirs.map(d => d?.name).filter(Boolean));
    if (token !== loadToken) {
      return;
    }
    el.dirs = dirs;
    countDirs(api, id, token);
    const saved = await getPref(dirKey(id), null);
    let initial = dirs.find(d => d.name === saved);
    if (!initial) {
      // saved folder no longer exists (deleted here or on another device):
      // clear the pref so the stale name cannot linger
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
  }
  catch (e) {
    if (token !== loadToken) {
      return;
    }
    const message = e?.message || String(e);
    // The account vanished or is unusable ("Account not found", incomplete
    // config): retrying can never fix that. But when no bridge is configured
    // either, fixing the account alone gets the client nowhere — offer the
    // setup window first ("Fix the bridge, then add an account").
    if (/account .{0,40}not found|not fully configured/i.test(message)) {
      if (await setupIncomplete()) {
        el.setupNeeded('Setup is not finished: configure a remote WS server or install the native client, then add an account.');
      }
      else {
        el.optionsNeeded(message + ' — add or fix the account in the options page.');
      }
      return;
    }
    // No bridge to the IMAP server at all → point the user at the setup
    // window instead of a bare error; anything else stays a normal error.
    if (await setupIncomplete()) {
      el.setupNeeded('Setup is not finished: configure a remote WS server or install the native client to reach your mail server.');
    }
    else {
      el.error(message);
    }
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
    // With no account configured the client page is dead weight: closing it
    // when the setup window opens avoids leaving two windows, and the
    // setup flow opens a fresh client page when the setup finishes.
    chrome.runtime.sendMessage({
      cmd: 'open-setup',
      closeClient: !(await hasAccounts())
    }).catch(() => {});
  });
  el.addEventListener('open-options', async () => {
    // same as open-setup: an empty client page is closed while the options
    // page takes over
    if (await hasAccounts()) {
      chrome.runtime.openOptionsPage().catch(() => {});
    }
    else {
      chrome.runtime.sendMessage({cmd: 'open-options'}).catch(() => {});
    }
  });
  el.addEventListener('create-dir', e => {
    createDir(e);
  });
  el.addEventListener('delete-dir', e => {
    deleteDir(e);
  });
}

// "+ New" on the folder pane: ask for a name, create under the selected
// folder (top level when none). The folder appears in the tree immediately;
// the server CREATE runs as a queued job and only selects the new folder
// once it succeeded. On failure the tree is restored and the job line shows
// the error.
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
// deletable), then the server DELETE runs as a queued job; when the deleted
// folder was the selected one the selection moves up to the parent folder,
// or INBOX/the first folder without an openable parent.
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
        // a retried delete after a dropped connection can fail with "no such
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

export {init, load, currentDirs, setupIncomplete};
