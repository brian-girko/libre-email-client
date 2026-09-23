import '../components/prompt-view.js';
import '../components/combo-view.js';
import './components/logger-view.js';
import {initTheme} from './theme.mjs';
import {initFontScale} from './font-scale.mjs';
import {init as initDirs, load as loadDirs, refresh as refreshDirs} from './dirs.mjs';
import {loadAccounts} from '../sync/client/accounts.mjs';
import {init as initList, load as loadList, runSearch, clearSearch, isSearching,
  syncCurrent} from './list.mjs';
import {init as initPreview} from './preview.mjs';
import {init as initAccounts} from './accounts.mjs';
import {init as initResize} from './resize.mjs';
import {init as initShortcuts} from './shortcuts.mjs';
import {initFilters} from './filters.mjs';
import {init as initSyncEvents} from './sync-events.mjs';
import {subscribe as subscribeLog, setStatus as setLogStatus} from './logger.mjs';
import {init as initSyncRun, requestSync} from './sync-run.mjs';
import {cancel as cancelJob, dismiss as dismissJob} from './jobs.mjs';
import * as counters from './counters.mjs';

initTheme();
initFontScale();

// The bottom logger renders the panels' activity (toolbar action queue,
// worker filter passes). The ✕ cancels a running action or
// dismisses a failed line; worker-owned lines are read-only.
const loggerView = document.getElementById('logger');
subscribeLog((entries, status) => loggerView.setEntries(entries, status));
loggerView.addEventListener('logger-cancel', e => {
  cancelJob(e.detail?.id);
});
loggerView.addEventListener('logger-dismiss', e => {
  dismissJob(e.detail?.id);
});

function applyPopupSize() {
  const params = new URLSearchParams(location.search);
  const width = Number(params.get('width'));
  const height = Number(params.get('height'));
  if (width > 0) document.body.style.width = Math.round(width) + 'px';
  if (height > 0) document.body.style.height = Math.round(height) + 'px';
}

const dirsView = document.getElementById('dirs');
initDirs(dirsView);
dirsView.addEventListener('dir-selected', e => {
  loadList(e.detail.accountId, e.detail.name);
});

initList(document.getElementById('emails'));
document.getElementById('emails').addEventListener('open-setup', () => {
  // the list's "Run Setup" offer reuses the folder pane's handler, which
  // accepts the no-account close-the-page behavior added there
  dirsView.dispatchEvent(new CustomEvent('open-setup', {bubbles: true, composed: true}));
});
initPreview(document.getElementById('preview'), document.getElementById('emails'), dirsView);
initAccounts(document.getElementById('account-select'));
initResize();

initFilters();
initSyncEvents();
applyPopupSize();

// ---- sync: combo button → background run / sync tab --------------------------
//
// The client is a local Maildir viewer only — it carries no sync interface.
// A plain click on a combo segment submits a background sync (sync-run.mjs —
// one pinned logger line, no interface): "Dir" scopes the run to the selected
// folder of the selected account, "Account" syncs the whole account, and
// "Open" just opens the sync client (data/sync/client/index.html) on a new
// tab without syncing. The selected-account mirror lives further down; the
// synced callback only reads it from callbacks, long after this module
// finished evaluating.

const syncDirBtn = document.getElementById('sync-dir');
const syncAccountBtn = document.getElementById('sync-account');
const syncOpenBtn = document.getElementById('sync-open');

initSyncRun({
  prompt: document.getElementById('prompt'),
  synced: slug => {
    if (slug === selectedAccount) {
      // a clean run of the open account: reconcile the open folder in
      // place (list.mjs' sync — no reload; counters drive the tree
      // badges, title and favicon from there)
      syncCurrent();
    }
  }
});

// first open of the client: if any stored password is encrypted and the
// master password is not confirmed for this session, ask for it NOW —
// even without a sync request — so scheduled runs finish waiting for a
// page that is already open. Success caches master.pass into
// chrome.storage.session (verified against master.hash); a cancel leaves
// the warn status and the next open (or the next sync click) asks again.
// Plain and empty passwords never reach the prompt path.
loadAccounts(document.getElementById('prompt')).catch(e => {
  setLogStatus('master password not confirmed — scheduled runs will skip ' +
    'encrypted accounts (' + (e?.message || e) + ')',
    {tone: 'warn', time: Date.now()});
});

// the third segment: open the sync interface, sync nothing
syncOpenBtn.addEventListener('click', () => {
  chrome.tabs.create({url: chrome.runtime.getURL('/data/sync/client/index.html')});
});

syncDirBtn.addEventListener('click', () => {
  const id = currentAccountId();
  const dir = currentDirName();
  if (id && dir) {
    requestSync(id, {dir});
  }
  else {
    setLogStatus(!id ? 'no account selected' : 'no folder selected',
      {tone: 'warn', time: Date.now()});
  }
});

syncAccountBtn.addEventListener('click', () => {
  const id = currentAccountId();
  if (id) {
    requestSync(id);
  }
  else {
    setLogStatus('no account selected', {tone: 'warn', time: Date.now()});
  }
});

// ---- explorer: button → /data/explorer/index.html ----------------------------

const explorerOpen = document.getElementById('explorer-open');
explorerOpen.addEventListener('click', () => {
  chrome.tabs.create({url: chrome.runtime.getURL('/data/explorer/index.html')});
});

// server-side search: Enter runs it, Esc clears; the ✕ button mirrors Esc.
// Scope "this folder" vs "all folders" comes from an all: prefix.
const searchInput = document.getElementById('mail-search');
const searchClear = document.getElementById('search-clear');
function searchScope(query) {
  return /^\s*all:/i.test(query) ? 'all' : 'dir';
}
function stripScope(query) {
  return query.replace(/^\s*all:\s*/i, '');
}
searchInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    e.preventDefault();
    const query = stripAll(searchInput.value);
    if (query) {
      const id = currentAccountId();
      const dir = currentDirName();
      if (id && dir) {
        runSearch(id, dir, query, searchScope(searchInput.value));
      }
    }
  }
  else if (e.key === 'Escape') {
    e.stopPropagation();
    resetSearchBox();
    clearSearch();
  }
});
searchInput.addEventListener('input', () => {
  searchClear.hidden = !searchInput.value;
});
searchClear.addEventListener('click', () => {
  resetSearchBox();
  clearSearch();
});
function stripAll(value) {
  return value.replace(/^\s*all:\s*/i, '');
}
function resetSearchBox() {
  searchInput.value = '';
  searchClear.hidden = true;
}
// the currently selected account/dir live in dirs.mjs/list.mjs state; the
// dir-selected listener mirrors them here
let selectedAccount = null;
let selectedDir = null;
dirsView.addEventListener('dir-selected', e => {
  selectedAccount = e.detail.accountId;
  selectedDir = e.detail.name;
  updateTitle();
  updateFavicon();
});
function currentAccountId() {
  return selectedAccount;
}
function currentDirName() {
  return selectedDir;
}

// sync and filter runs write into the account dir from other pages (the
// offscreen engine — background syncs and their post-sync INBOX filter
// pass — and the sync interface's filter row): their 'sync-refresh'
// broadcast asks every open client instance to update. This one refreshes
// the selected account's folder tree and reconciles its open folder in
// place — no reload, search-safe (list.mjs' sync no-ops during search).
chrome.runtime.onMessage.addListener(msg => {
  if (msg?.type !== 'sync-refresh' || msg.slug !== selectedAccount) {
    return;
  }
  refreshDirs();
  syncCurrent();
});

// document.title: "<dir> [<n> unread] :: <extension name>". Unread comes
// from the counter store's mirror-confirmed base, re-rendered on every
// mirror-changed sync, so actions land in the title once their resync brings
// the local copy up to date; with no folder (or unknown counters) the title
// falls back to the base.
// Same subscription drives the tab badge: the favicon is red when the
// selected account's INBOX has unread mail and gray otherwise.
const BASE_TITLE = document.title;
const FAVICON_GRAY = '/data/icons/gray/32.png';
const FAVICON_RED = '/data/icons/red/32.png';

function updateFavicon() {
  const el = document.getElementById('favicon');
  if (!el) {
    return;
  }
  const unread = counters.predicted(selectedAccount, 'INBOX')?.unread ?? 0;
  el.href = unread > 0 ? FAVICON_RED : FAVICON_GRAY;
}

function updateTitle() {
  if (!selectedAccount || !selectedDir) {
    document.title = BASE_TITLE;
    return;
  }
  const unread = counters.predicted(selectedAccount, selectedDir)?.unread ?? 0;
  const unreadSuffix = unread > 0 ? ' (' + unread + ')' : '';
  document.title = selectedDir + unreadSuffix + ' :: ' + BASE_TITLE;
}
counters.subscribe(({accountId}) => {
  if (accountId === selectedAccount) {
    updateTitle();
    updateFavicon();
  }
});

initShortcuts({
  dirs: dirsView,
  list: document.getElementById('emails'),
  preview: document.getElementById('preview'),
  prompt: document.getElementById('prompt')
});
