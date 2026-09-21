// state.mjs — the Sync Engine's private per-folder sync state (IndexedDB).
//
// This is the OfflineIMAP "folder UID mapping / LastSeen" journal: the
// service worker records, for every mirrored folder, which remote uids it
// already knows and with which flags it last saw them. The CLIENT PAGE never
// touches this database — its view of the world is the maildir files alone
// (flags in filenames, metadata in the index cache). The engine diffs:
//
//   filename flags != lastseen flags      → local change → replay on server
//   server rows    != lastseen (not local)→ remote change → rename local file
//   lastseen uid, file gone, listing gone → server-purged → cleanup done
//
// Fallback: an in-memory map when IndexedDB is unavailable (tests).

'use strict';

const DB_NAME = 'mirror-sync-state';
const DB_VERSION = 1;
const STORE = 'folders'; // key `${accountId}\u0000${encFolder}`

function key(accountId, enc) {
  return accountId + '\u0000' + enc;
}

const mem = new Map(); // key -> state object (fallback / previous context)

let dbPromise = null;

function openDb() {
  if (dbPromise) {
    return dbPromise;
  }
  if (typeof indexedDB === 'undefined') {
    return null;
  }
  dbPromise = new Promise(resolve => {
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null); // fall back to memory
    }
    catch {
      resolve(null);
    }
  }).then(db => {
    if (!db) {
      return null; // permanent memory mode for this session
    }
    // context died (service worker restart): memory entries keep nothing
    return db;
  }).catch(() => null);
  return dbPromise;
}

function tx(db, mode) {
  return db.transaction(STORE, mode).objectStore(STORE);
}

function prom(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export function emptyFolderState() {
  return {uidvalidity: 0, lastseen: {}};
}

export async function getSyncState(accountId, enc) {
  const k = key(accountId, enc);
  const db = await openDb();
  if (!db) {
    return {...emptyFolderState(), ...(mem.get(k) ?? {})};
  }
  try {
    const value = await prom(tx(db, 'readonly').get(k));
    return value ?? emptyFolderState();
  }
  catch {
    return emptyFolderState();
  }
}

export async function putSyncState(accountId, enc, state) {
  const k = key(accountId, enc);
  const value = {...emptyFolderState(), ...state, lastseen: state?.lastseen ?? {}};
  const db = await openDb();
  if (!db) {
    mem.set(k, value);
    return;
  }
  try {
    tx(db, 'readwrite').put(value, k);
  }
  catch {
    mem.set(k, value);
  }
}

// Read-modify-write of one folder's state document.
export async function updateSyncState(accountId, enc, fn) {
  const state = await getSyncState(accountId, enc);
  const next = fn(state);
  if (next) {
    await putSyncState(accountId, enc, next);
  }
  return next;
}

// Drop one folder's journal (folder deleted locally/server-side).
export async function clearSyncState(accountId, enc) {
  const k = key(accountId, enc);
  const db = await openDb();
  mem.delete(k);
  if (!db) {
    return;
  }
  try {
    tx(db, 'readwrite').delete(k);
  }
  catch {}
}

// Find which folder's lastseen journal already knows an item (used to find
// the source folder of a foreign-FMD5 move). Returns the encoded folder name
// or null. Scans the given encoded folder list.
export async function findSourceFolder(accountId, uid, encs) {
  for (const enc of encs) {
    const st = await getSyncState(accountId, enc);
    if (st.lastseen && uid in st.lastseen) {
      return enc;
    }
  }
  return null;
}

// Drop the whole account (account removal).
export async function clearAccount(accountId) {
  const prefix = accountId + '\u0000';
  for (const k of [...mem.keys()]) {
    if (String(k).startsWith(prefix)) {
      mem.delete(k);
    }
  }
  const db = await openDb();
  if (!db) {
    return;
  }
  try {
    const store = tx(db, 'readwrite');
    const cursor = store.openCursor();
    await new Promise(resolve => {
      cursor.onsuccess = () => {
        const cur = cursor.result;
        if (!cur) {
          resolve();
          return;
        }
        if (String(cur.key).startsWith(prefix)) {
          cur.delete();
        }
        cur.continue();
      };
      cursor.onerror = () => resolve();
    });
  }
  catch {}
}
