// data/picker/index.js — tab page that acquires read/write access to a local
// directory via the File System Access API and stores the directory handle in
// IndexedDB (db 'data-picker', store 'handles', key 'root') so other parts of
// the extension can pick it up later. Handles survive browser restarts; a
// stale permission is restored with one user-gesture re-grant.
//
// The page only matters in the 'external' storage mode; with the default
// 'browser storage' root (OPFS, data/sync/root-handle.mjs) there is nothing
// to grant — it says so and offers the way back to the options. When the
// stored external handle still has permission (or in OPFS mode, straight
// away), this page hands off to the mail client (data/client/index.html) by
// default; the 'picker.autoOpen' preference (options page, default on) keeps
// the destination buttons around for a manual choice instead.

'use strict';

import {
  MODE_EXTERNAL,
  getStorageMode,
  ownedRootHandle,
  persistRootHandle,
  clearRootHandle,
  verifyRoot
} from '../sync/root-handle.mjs';

const pickBtn = document.getElementById('pick');
const grantBtn = document.getElementById('grant');
const forgetBtn = document.getElementById('forget');
const openSyncBtn = document.getElementById('open-sync');
const openClientBtn = document.getElementById('open-client');
const openExplorerBtn = document.getElementById('open-explorer');
const openOptionsBtn = document.getElementById('open-options');
const statusEl = document.getElementById('status');
const dirEl = document.getElementById('dir');

const e2msg = e => e?.message || String(e);

// options preference: hand off to the mail client as soon as access is
// confirmed (default on; off keeps the manual destination choice)
async function autoOpen() {
  const {'picker.autoOpen': value} = await chrome.storage.local.get({'picker.autoOpen': true});
  return value !== false;
}

function openClient() {
  location.replace(chrome.runtime.getURL('data/client/index.html'));
}

function setStatus(text, ok) {
  statusEl.textContent = text;
  statusEl.className = ok ? 'ok' : 'bad';
}

function setDir(name) {
  dirEl.textContent = name || '';
  dirEl.hidden = !name;
}

async function forget() {
  pickBtn.hidden = false;
  grantBtn.hidden = true;
  forgetBtn.hidden = true;
  openSyncBtn.hidden = true;
  openClientBtn.hidden = true;
  openExplorerBtn.hidden = true;
  openOptionsBtn.hidden = true;
  setDir('');
  await renderStatus();
}

// OPFS mode needs no handle at all: hand off to the mail client (or point
// the visitor back to the options for a manual choice).
async function opfsMode() {
  if (await autoOpen()) {
    return openClient();
  }
  pickBtn.hidden = true;
  grantBtn.hidden = true;
  forgetBtn.hidden = true;
  // the destinations are mode-independent: browser storage may be the root,
  // but the sync and the mail client still open from here
  openSyncBtn.hidden = false;
  openClientBtn.hidden = false;
  openExplorerBtn.hidden = false;
  openOptionsBtn.hidden = false;
  setDir('');
  setStatus('Mail is stored in browser storage (the default) — no directory access is needed. To use a custom directory instead, change it in the options.', true);
}

// Boot text for the external mode without touching the handle: grants, lapses
// and availability are rendered without the write probe (the probe runs right
// before the handle is handed off; a destination page never re-probes).
async function renderStatus() {
  const {handle, name} = await ownedRootHandle();
  if (!handle || !(handle instanceof FileSystemDirectoryHandle)) {
    return 'No directory access granted yet.';
  }
  const state = await handle.queryPermission({mode: 'readwrite'});
  if (state === 'granted') {
    return 'Access confirmed for ' + (name || 'the directory') + '.';
  }
  return state === 'prompt'
    ? 'Access needs to be re-granted for ' + name + '.'
    : 'Permission denied for ' + (name || 'the directory') + '.';
}

// Provisional text for the brief boot window; boot() overwrites it with the
// verified verdict below.
async function boot() {
  const status = await renderStatus();
  setStatus(status, /\bconfirmed\b/.test(status));
  setDir((await ownedRootHandle()).name || '');

  try {
    if ((await getStorageMode()) !== MODE_EXTERNAL) {
      return await opfsMode();
    }
    const {handle, name} = await ownedRootHandle();
    if (!handle || !(handle instanceof FileSystemDirectoryHandle)) {
      return await forget();
    }
    setDir(name);
    forgetBtn.hidden = false;
    openOptionsBtn.hidden = false;
    try {
      await verifyRoot(handle);
      // access is confirmed: hand off to the mail client by default, let the
      // user pick the destination page when the preference says so
      if (await autoOpen()) {
        setStatus('Access confirmed for ' + (name || 'the directory') + '.', true);
        return openClient();
      }
      pickBtn.hidden = true;
      grantBtn.hidden = true;
      forgetBtn.hidden = false;
      openSyncBtn.hidden = false;
      openClientBtn.hidden = false;
      openExplorerBtn.hidden = false;
      openOptionsBtn.hidden = false;
      setStatus('Access confirmed for ' + (name || 'the directory') + '.', true);
      return;
    }
    catch {
      pickBtn.hidden = true;
      forgetBtn.hidden = false;
      const state = await handle.queryPermission({mode: 'readwrite'});
      if (state === 'granted') {
        await persistRootHandle(handle, name);
        return boot();
      }
      grantBtn.hidden = state !== 'prompt';
      if (grantBtn.hidden) {
        return await forget();
      }
      setStatus('Access needs to be re-granted for ' + name + '.', false);
    }
  }
  catch (e) {
    setStatus('Storage check failed: ' + e2msg(e), false);
  }
}

pickBtn.addEventListener('click', async () => {
  try {
    const handle = await window.showDirectoryPicker({mode: 'readwrite'});
    await persistRootHandle(handle, handle.name);
    return boot();
  }
  catch (e) {
    if (e?.name === 'AbortError') {
      return;
    }
    setStatus('Directory pick failed: ' + e2msg(e), false);
  }
});

grantBtn.addEventListener('click', async () => {
  try {
    const {handle, name} = await ownedRootHandle();
    if (!handle) {
      return await forget();
    }
    const result = await handle.requestPermission({mode: 'readwrite'});
    if (result === 'granted') {
      return boot();
    }
    setStatus('Permission denied for ' + (name || 'the directory') + '.', false);
  }
  catch (e) {
    setStatus('Permission request failed: ' + e2msg(e), false);
  }
});

forgetBtn.addEventListener('click', () => {
  clearRootHandle().then(forget, forget);
});

openSyncBtn.addEventListener('click', () => {
  location.replace(chrome.runtime.getURL('data/sync/client/index.html'));
});

openClientBtn.addEventListener('click', () => {
  location.replace(chrome.runtime.getURL('data/client/index.html'));
});

openExplorerBtn.addEventListener('click', () => {
  location.replace(chrome.runtime.getURL('data/explorer/index.html'));
});

openOptionsBtn.addEventListener('click', () => {
  location.replace(chrome.runtime.getURL('data/options/index.html#global'));
});

boot();
