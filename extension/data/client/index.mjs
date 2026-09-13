import './components/prompt-view.js';
import './components/combo-view.js';
import './components/logger-view.js';
import {initTheme} from './theme.mjs';
import {initFontScale} from './font-scale.mjs';
import {init as initDirs, load as loadDirs} from './dirs.mjs';
import {init as initList, load as loadList, runSearch, clearSearch, isSearching} from './list.mjs';
import {init as initPreview} from './preview.mjs';
import {init as initAccounts} from './accounts.mjs';
import {init as initResize} from './resize.mjs';
import {init as initShortcuts} from './shortcuts.mjs';
import {initFilters} from './filters.mjs';
import {subscribe as subscribeLog} from './logger.mjs';
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
applyPopupSize();

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
});
function currentAccountId() {
  return selectedAccount;
}
function currentDirName() {
  return selectedDir;
}

// document.title: "<dir> [<n> unread] :: <extension name>". Unread is the
// counters' predicted value, so optimistic moves/reads keep the title true;
// with no folder (or unknown counters) the title falls back to the base.
const BASE_TITLE = document.title;
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
  }
});

initShortcuts({
  dirs: dirsView,
  list: document.getElementById('emails'),
  preview: document.getElementById('preview'),
  prompt: document.getElementById('prompt')
});

// Reached from the service worker's action-button click: a ping proves this
// page is a live client — right afterwards the page asks to be brought up
// itself, so the worker learns the tab from that message's sender.tab; a
// refresh-dir refetches the open folder, same as the toolbar refresh button
// (the event is dispatched on the list view, where list.mjs listens).
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.cmd === 'client-ping') {
    chrome.runtime.sendMessage({cmd: 'up'}).catch(() => {});
    sendResponse({ok: true});
    return;
  }
  if (msg?.type === 'refresh-dir') {
    document.getElementById('emails').dispatchEvent(new CustomEvent('refresh'));
    sendResponse({ok: true});
    return;
  }
});
