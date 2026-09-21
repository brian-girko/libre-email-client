// data/picker/index.js — tab page that acquires read/write access to a local
// directory via the File System Access API and stores the directory handle in
// IndexedDB (db 'data-picker', store 'handles', key 'root') so other parts of
// the extension can pick it up later. Handles survive browser restarts; a
// stale permission is restored with one user-gesture re-grant. When the
// stored handle still has permission, this page offers the choice between the
// sync client interface (data/sync/client/index.html) and the mail client
// (data/client/index.html).

'use strict';

const DB_NAME = 'data-picker';
const STORE = 'handles';
const KEY = 'root';
const NAME_KEY = KEY + ':name';
const HANDLE_KEY = KEY;

const pickBtn = document.getElementById('pick');
const grantBtn = document.getElementById('grant');
const forgetBtn = document.getElementById('forget');
const openSyncBtn = document.getElementById('open-sync');
const openClientBtn = document.getElementById('open-client');
const statusEl = document.getElementById('status');
const dirEl = document.getElementById('dir');

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function request(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function eventDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

async function persist(handle, name) {
  const conn = await openDb();
  try {
    const tx = conn.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    store.put(handle, HANDLE_KEY);
    store.put(name, NAME_KEY);
    await eventDone(tx);
  }
  finally {
    conn.close();
  }
}

async function owns() {
  const conn = await openDb();
  try {
    const tx = conn.transaction(STORE, 'readonly');
    const store = tx.objectStore(STORE);
    const handle = await request(store.get(HANDLE_KEY));
    const name = await request(store.get(NAME_KEY));
    return {handle, name};
  }
  finally {
    conn.close();
  }
}

async function clearHandle() {
  const conn = await openDb();
  try {
    const tx = conn.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    store.delete(HANDLE_KEY);
    store.delete(NAME_KEY);
    await eventDone(tx);
  }
  finally {
    conn.close();
  }
}

const e2msg = e => e?.message || String(e);

function setStatus(text, ok) {
  statusEl.textContent = text;
  statusEl.className = ok ? 'ok' : 'bad';
}

function setDir(name) {
  dirEl.textContent = name || '';
  dirEl.hidden = !name;
}

function forget() {
  pickBtn.hidden = false;
  grantBtn.hidden = true;
  forgetBtn.hidden = true;
  openSyncBtn.hidden = true;
  openClientBtn.hidden = true;
  setDir('');
  setStatus('No directory access granted yet.');
}

// Proves the stored handle is still usable: write a probe file. Covers both
// a dropped permission and a moved/renamed directory (queryPermission can
// claim 'granted' while real writes would fail). The probe file stays in
// place and is simply overwritten on each boot — dot-names are ignored by
// the maildir walkers and the sync engine, so nothing sees it.
async function verify(handle) {
  const file = await handle.getFileHandle('.picker-probe', {create: true});
  const writable = await file.createWritable();
  await writable.close();
}

async function boot() {
  try {
    const {handle, name} = await owns();
    if (!handle || !(handle instanceof FileSystemDirectoryHandle)) {
      forget();
      return;
    }
    setDir(name);
    forgetBtn.hidden = false;
    try {
      await verify(handle);
      // access is confirmed: let the user pick the destination page
      pickBtn.hidden = true;
      grantBtn.hidden = true;
      forgetBtn.hidden = false;
      openSyncBtn.hidden = false;
      openClientBtn.hidden = false;
      setStatus('Access confirmed for ' + (name || 'the directory') + '.', true);
      return;
    }
    catch {
      pickBtn.hidden = true;
      forgetBtn.hidden = false;
      const state = await handle.queryPermission({mode: 'readwrite'});
      if (state === 'granted') {
        await persist(handle, name);
        return boot();
      }
      grantBtn.hidden = state !== 'prompt';
      if (grantBtn.hidden) {
        forget();
        return;
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
    await persist(handle, handle.name);
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
    const {handle, name} = await owns();
    if (!handle) {
      return forget();
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
  clearHandle().then(forget, forget);
});

const handOff = page => {
  location.replace(chrome.runtime.getURL(page));
};
openSyncBtn.addEventListener('click', () => handOff('data/sync/client/index.html'));
openClientBtn.addEventListener('click', () => handOff('data/client/index.html'));

boot();
