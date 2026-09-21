// data/sync/index.js — sync page gate. The service worker cannot check
// FileSystem handle permissions, so this page is the real checkpoint (shared
// by the data/client gate): it loads the stored handle and confirms the
// readwrite permission is still in place, bouncing back to the picker when
// the handle is gone or the permission was revoked. Actual read/write proof
// is the picker's probe (data/picker), which runs right before a handle is
// handed off — a destination page never re-probes.

'use strict';

const DB_NAME = 'data-picker';
const STORE = 'handles';
const HANDLE_KEY = 'root';
const NAME_KEY = HANDLE_KEY + ':name';

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

// Cheap permission re-check (no writes, no probe): the picker owns the
// real read/write verification that precedes every hand-off.
function backToPicker() {
  location.replace(chrome.runtime.getURL('data/picker/index.html'));
}

// Offscreen-safe variant of boot(): same checks, no navigation (an
// offscreen document cannot redirect anywhere useful) — the caller gets a
// verdict instead and the client surfaces a link to the picker. The raw
// queryPermission value ('granted'|'prompt'|'denied') rides along so the
// calling side can tell a real lapse from a context-quirk verdict.
export async function bootSilent() {
  try {
    const {handle, name} = await owns();
    if (!handle || !(handle instanceof FileSystemDirectoryHandle)) {
      console.log('[sync] access check: no stored handle');
      return {ok: false, raw: null, reason: 'no-handle', name};
    }
    const raw = await handle.queryPermission({mode: 'readwrite'});
    console.log(`[sync] queryPermission → "${raw}" (name: ${name || '?'})`);
    return {
      ok: raw === 'granted',
      raw,
      reason: raw === 'granted' ? null : 'need-regrant',
      name,
      handle
    };
  }
  catch (e) {
    console.log('[sync] access check failed:', e?.message || e);
    return {ok: false, raw: null, reason: 'no-handle', error: e?.message || String(e)};
  }
}

export async function boot() {
  try {
    const {handle, name} = await owns();
    if (!handle || !(handle instanceof FileSystemDirectoryHandle)) {
      await clearHandle();
      return backToPicker();
    }
    if ((await handle.queryPermission({mode: 'readwrite'})) !== 'granted') {
      console.log('[sync] access needs a re-grant for ' + (name || 'the directory'));
      return backToPicker();
    }
    console.log('[sync] access confirmed for ' + (name || 'the directory'));
    return handle;
  }
  catch (e) {
    console.log('[sync] access check failed — returning to the picker:', e?.message || e);
    return backToPicker();
  }
}

