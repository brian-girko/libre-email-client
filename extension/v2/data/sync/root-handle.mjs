// data/sync/root-handle.mjs — the storage-root plumbing shared by every page
// that needs the root directory handle: the gate (disk.mjs), the picker
// (data/picker) and the option page's storage-root panel.
//
// Two modes decide where the Maildir tree lives ('storage.mode' in
// chrome.storage.local):
//
//   'opfs'      — the extension's own origin-private storage (OPFS) via
//                 navigator.storage.getDirectory(). No permission flow: the
//                 handle is always granted, nothing to re-grant, nothing to
//                 pick. This is the default.
//   'external'  — a user-chosen directory. The handle is acquired by the
//                 picker or the options page and persisted in IndexedDB
//                 (db 'data-picker', store 'handles', key 'root') so other
//                 parts of the extension can pick it up later; a lapsed
//                 permission needs one user-gesture re-grant.

'use strict';

const DB_NAME = 'data-picker';
const STORE = 'handles';
const HANDLE_KEY = 'root';
const NAME_KEY = HANDLE_KEY + ':name';

export const MODE_KEY = 'storage.mode';
export const MODE_OPFS = 'opfs';
export const MODE_EXTERNAL = 'external';
export const MODE_DEFAULT = MODE_OPFS;

// IDB mirror of chrome.storage.local[MODE_KEY] (same store as the external
// handle) — the fallback read for contexts without chrome.* (the offscreen
// document)
const MODE_STORAGE_KEY = 'idb.' + MODE_KEY;
const modeCache = new Map();

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

export async function getStorageMode() {
  // chrome.storage first (the authoritative write target), but NOT every
  // consumer can use it: the offscreen document is an extension-origin page
  // without chrome.* APIs (data/sync/offscreen offscreen.mjs), so the mode
  // is mirrored into the same IDB store as the external handle. The cached
  // value also saves the recheck-per-job path an IDB round trip.
  if (modeCache.has(MODE_KEY)) {
    return modeCache.get(MODE_KEY);
  }
  try {
    const res = await chrome.storage.local.get(MODE_KEY);
    const mode = res[MODE_KEY] === MODE_EXTERNAL ? MODE_EXTERNAL : MODE_DEFAULT;
    modeCache.set(MODE_KEY, mode);
    healModeMirror(mode);
    return mode;
  }
  catch {
    // no chrome.* here (offscreen): the IDB mirror decides
    const conn = await openDb();
    try {
      const tx = conn.transaction(STORE, 'readonly');
      const value = await request(tx.objectStore(STORE).get(MODE_STORAGE_KEY));
      const mode = value === MODE_EXTERNAL ? MODE_EXTERNAL : MODE_DEFAULT;
      modeCache.set(MODE_KEY, mode);
      return mode;
    }
    finally {
      conn.close();
    }
  }
}

// Best-effort backfill of the IDB mirror after a chrome.storage read (an
// import of preferences writes chrome.storage directly, bypassing the dual
// write below). All mirror writes run serialized so a concurrent
// setStorageMode cannot interleave stale values.
let mirrorChain = Promise.resolve();

function mirrorStep(fn) {
  mirrorChain = mirrorChain.then(fn, fn);
  return mirrorChain;
}

async function healModeMirror(mode) {
  try {
    await mirrorStep(async () => {
      const conn = await openDb();
      try {
        const tx = conn.transaction(STORE, 'readonly');
        const stored = await request(tx.objectStore(STORE).get(MODE_STORAGE_KEY));
        if (stored !== mode) {
          await setModeMirror(mode);
        }
      }
      finally {
        conn.close();
      }
    });
  }
  catch {
    /* the mirror is convenience, not truth — tolerate failures */
  }
}

async function setModeMirror(mode) {
  const conn = await openDb();
  try {
    const tx = conn.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(mode, MODE_STORAGE_KEY);
    await eventDone(tx);
  }
  finally {
    conn.close();
  }
}

export function setStorageMode(mode) {
  const value = mode === MODE_EXTERNAL ? MODE_EXTERNAL : MODE_DEFAULT;
  modeCache.set(MODE_KEY, value);
  return chrome.storage.local.set({[MODE_KEY]: value}).then(() => {
    healModeMirror(value);
    return value;
  });
}

// The OPFS root: always granted, no permission flow. Synchronous permission
// check exists only for the same-call contract with the external mode.
export async function opfsRoot() {
  return navigator.storage.getDirectory();
}

// The persisted external handle with its display name; both values come back
// (name may be undefined for pre-name stores).
export async function ownedRootHandle() {
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

export async function persistRootHandle(handle, name) {
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

export async function clearRootHandle() {
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

// Proves the root is still writable: write a probe file. Covers both a
// dropped permission and a moved/renamed directory (queryPermission can
// claim 'granted' while real writes would fail). The probe file stays in
// place and is simply overwritten on each check — dot-names are ignored by
// the maildir walkers and the sync engine, so nothing sees it.
export async function verifyRoot(handle) {
  const file = await handle.getFileHandle('.picker-probe', {create: true});
  const writable = await file.createWritable();
  await writable.close();
}
