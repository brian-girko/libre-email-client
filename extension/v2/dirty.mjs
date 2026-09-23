// dirty.mjs — resync bookkeeping: which dirs need a server sync.
//
// A fully independent worker-level module: imported for side effect only,
// it registers its own chrome.runtime.onMessage listener and shares
// nothing with the worker's own switch — no imports, no jobs, no bridge.
// It only STORES the dirs that need resyncing, per account; nothing here
// performs work.
//
//   sync-dirty-report {accountId, uids, srcDir, destDir?, addFlags?,
//                      removeFlags?} → a local edit done on a client
//                      interface (one report per operation). The affected
//                      dirs (src + dest on moves) are marked as needing a
//                      resync; a dir already on record keeps its original
//                      timestamp — repeated edits to the same folder are
//                      no-ops, since the mark is dir-level.
//   sync-request      {kind, account, dir} → page-sent sync jobs pass
//                      through this worker, so the store self-clears at
//                      enqueue: 'sync' and 'discard' wipe the whole
//                      account, 'sync-dir' removes just that folder,
//                      'sync-dirs' removes every folder listed in its
//                      dirs array, and dry runs ('dry', 'dry-dir') are
//                      ignored — a survey syncs nothing. The store keys
//                      accounts by the client's slug while a job's
//                      account object carries the options-page id too —
//                      both spellings are cleared. The worker's own
//                      listener answers these; this module only eavesdrops.
//   sync-dirty-query  {accountId?} → {ok, dirs} — the read-only report of
//                      what needs resyncing on the next call:
//                      {[accountId]: {dir: timestamp}} (one account only
//                      when an id is given).
//   sync-dirty-clear  {accountId?} → clear all stored jobs (one account's
//                      when an id is given).
//   sync-pending-dirs {accountId, slug, dirs} → the engine's ground-truth
//                      report after a settled sync: every local dir left
//                      holding interlopers (pending keepFmd5 moves).
//                      State decides the mark, not the mutating agent —
//                      the report is scanned, the listed dirs marked
//                      (first stamp wins), an empty or unknown-account
//                      report is a no-op. Retires every init that has
//                      no work here: a run that leaves nothing pending
//                      sends nothing.
//
// The auto-sync scheduler (/sync-scheduler.mjs) submits its jobs straight
// to the engine — a service worker never hears its own runtime messages,
// so the 'sync-request' eavesdrop below never fires for them. It clears
// exactly the submitted dirs through the clearDirs() export instead, once
// the engine has accepted the job.
//
// Records live in chrome.storage.session under one key as
// {[accountId]: {[dirName]: timestamp}}: browser-session truth that dies
// with the session — like the other session-stored state (master.pass).
// accountId here is the client's slug (its granted-directory folder
// name); the sync registry's options-page id never appears as a key, but
// a job's account object carries both spellings, so clears match either.
// The engine's 'sync-pending-dirs' report follows the same convention
// (its payload carries both spellings; the slug is recorded, matching
// the client-edit keying). Writes go through a promise chain so a report
// racing a clear cannot interleave read-modify-writes. Note the offscreen
// document has no chrome.storage at all — it can never report edits; its
// sync-pending-dirs messages reach the worker like any other broadcast.

'use strict';

const KEY = 'sync.dirty';

let chain = Promise.resolve();

/** serialized read-modify-write; the returned promise carries the result */
function update(fn) {
  const run = chain.then(fn);
  chain = run.then(() => {}, () => {});
  return run;
}

async function readStore() {
  try {
    const res = await chrome.storage.session.get(KEY);
    return res?.[KEY] || {};
  }
  catch {
    return {};
  }
}

async function writeStore(store) {
  await chrome.storage.session.set({[KEY]: store});
}

/** the dirs an edit touched: the source, plus the destination of a move */
function affectedDirs(msg) {
  const dirs = [];
  const src = typeof msg.srcDir === 'string' && msg.srcDir ? msg.srcDir : null;
  const dest = typeof msg.destDir === 'string' && msg.destDir ? msg.destDir : null;
  if (src) {
    dirs.push(src);
  }
  if (dest && dest !== src) {
    dirs.push(dest);
  }
  return dirs;
}

/** mark the report's dirs; first stamp wins — existing marks are kept */
function markReport(store, msg) {
  const id = msg.accountId;
  const dirs = affectedDirs(msg);
  if (!id || !dirs.length) {
    return;
  }
  const account = store[id] || (store[id] = {});
  const now = Date.now();
  for (const dir of dirs) {
    if (!(dir in account)) {
      account[dir] = now;
    }
  }
}

/** the store keys a job's account may live under: the client reports its
 *  edits by slug (the granted-directory folder name), the sync registry
 *  keys by the options-page id — a job's account object carries both, so
 *  both spellings are cleared */
function accountKeys(msg) {
  const keys = new Set();
  for (const key of [msg.account?.id, msg.account?.slug]) {
    if (typeof key === 'string' && key) {
      keys.add(key);
    }
  }
  return [...keys];
}

/**
 * Enqueue-time clear: everything a real (non-dry) sync job will pick up,
 * under every key the account may be stored as.
 * @returns what was cleared — {keys, dirs} ('*' dirs = whole accounts) —
 *   or null when nothing on record matched (the diagnostic log's input)
 */
function clearJob(store, msg) {
  const keys = accountKeys(msg);
  if (!keys.length) {
    return null;
  }
  if (msg.kind === 'sync' || msg.kind === 'discard') {
    const hit = keys.filter(key => key in store);
    for (const key of keys) {
      delete store[key];
    }
    return hit.length ? {keys: hit, dirs: '*'} : null;
  }
  // per-dir kinds: 'sync-dir' clears one folder, 'sync-dirs' its whole list
  const dirList = msg.kind === 'sync-dir'
    ? (typeof msg.dir === 'string' && msg.dir ? [msg.dir] : [])
    : msg.kind === 'sync-dirs' && Array.isArray(msg.dirs)
      ? msg.dirs.filter(d => typeof d === 'string' && d)
      : [];
  if (!dirList.length) {
    return null;
  }
  const hitKeys = [];
  const hitDirs = [];
  for (const key of keys) {
    const account = store[key];
    if (!account) {
      continue;
    }
    const gone = dirList.filter(dir => dir in account);
    if (!gone.length) {
      continue;
    }
    for (const dir of gone) {
      delete account[dir];
      if (!hitDirs.includes(dir)) {
        hitDirs.push(dir);
      }
    }
    hitKeys.push(key);
    if (!Object.keys(account).length) {
      delete store[key];
    }
  }
  return hitKeys.length ? {keys: hitKeys, dirs: hitDirs} : null;
}

const CLEARABLE = new Set(['sync', 'sync-dir', 'sync-dirs', 'discard']);

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  switch (msg?.type) {
    // a client edit: mark its dirs (existing stamps untouched)
    case 'sync-dirty-report':
      update(async () => {
        const store = await readStore();
        markReport(store, msg);
        await writeStore(store);
      })
        .then(() => respond({ok: true}))
        .catch(e => respond({ok: false, error: e?.message || String(e)}));
      return true;
    // what needs resyncing: the whole store, or one account's dirs
    case 'sync-dirty-query':
      readStore()
        .then(store => respond({
          ok: true,
          dirs: msg.accountId ? (store[msg.accountId] || {}) : store
        }))
        .catch(e => respond({ok: false, error: e?.message || String(e)}));
      return true;
    // clear all stored jobs (or one account's)
    case 'sync-dirty-clear':
      update(async () => {
        if (!msg.accountId) {
          await writeStore({});
          return;
        }
        const store = await readStore();
        if (msg.accountId in store) {
          delete store[msg.accountId];
          await writeStore(store);
        }
      })
        .then(() => respond({ok: true}))
        .catch(e => respond({ok: false, error: e?.message || String(e)}));
      return true;
    // the engine's state report: every dir left holding pending moves
    // needs a resync — mark them (first stamp wins) under the slug (or
    // id as fallback), like client-edit reports key the store. The
    // scheduler eavesdrops the same message to re-arm the alarm.
    case 'sync-pending-dirs': {
      const dirs = Array.isArray(msg.dirs)
        ? msg.dirs.filter(d => typeof d === 'string' && d)
        : [];
      const id = typeof msg.slug === 'string' && msg.slug
        ? msg.slug
        : (typeof msg.accountId === 'string' ? msg.accountId : null);
      if (id && dirs.length) {
        update(async () => {
          const store = await readStore();
          const account = store[id] || (store[id] = {});
          const now = Date.now();
          let changed = false;
          for (const dir of dirs) {
            if (!(dir in account)) {
              account[dir] = now;
              changed = true;
            }
          }
          if (changed) {
            await writeStore(store);
            console.log('[dirty] marked from engine report:',
              id, dirs.join(', '));
          }
        }).catch(() => {});
      }
      return false;
    }
    // a real sync job was accepted: everything it will resync leaves the
    // store now. Dry runs are surveys — ignored. No response: the worker's
    // own listener owns this message.
    case 'sync-request':
      if (CLEARABLE.has(msg.kind)) {
        update(async () => {
          const store = await readStore();
          const before = JSON.stringify(store);
          const cleared = clearJob(store, msg);
          if (JSON.stringify(store) !== before) {
            await writeStore(store);
            console.log('[dirty] cleared at enqueue:',
              msg.kind, JSON.stringify(cleared));
          }
        }).catch(() => {});
      }
      return false;
    default:
      return false;
  }
});

/** wipe every stored record */
function clearAll() {
  return update(() => writeStore({}));
}

/** wipe one account's records */
function clearAccount(accountId) {
  return update(async () => {
    if (!accountId) {
      return;
    }
    const store = await readStore();
    if (accountId in store) {
      delete store[accountId];
      await writeStore(store);
    }
  });
}

/** read-only report: {[accountId]: {dir: timestamp}} — or one account's */
async function getNeeded(accountId = null) {
  const store = await readStore();
  return accountId ? (store[accountId] || {}) : store;
}

/**
 * Drop specific dirs from one account's record — the scheduler's own
 * enqueue clear: its jobs reach the engine without a 'sync-request'
 * passing through, so nothing here eavesdrops for them.
 * @param {string|Array<string>} keys every spelling the account may be
 *   stored under (a registry account carries both its id and slug)
 * @param {string[]} dirs the dirs the submitted job will resync
 * @returns {Promise<{keys: string[], dirs: string[]}|null>} what was
 *   cleared, or null when nothing on record matched. Marks that landed
 *   after the job was built keep their stamps (only listed dirs go).
 */
function clearDirs(keys, dirs) {
  const keyList = (Array.isArray(keys) ? keys : [keys])
    .filter(key => typeof key === 'string' && key);
  const dirList = (Array.isArray(dirs) ? dirs : [])
    .filter(dir => typeof dir === 'string' && dir);
  if (!keyList.length || !dirList.length) {
    return Promise.resolve(null);
  }
  return update(async () => {
    const store = await readStore();
    const before = JSON.stringify(store);
    const hitKeys = [];
    const hitDirs = [];
    for (const key of keyList) {
      const account = store[key];
      if (!account) {
        continue;
      }
      const gone = dirList.filter(dir => dir in account);
      if (!gone.length) {
        continue;
      }
      for (const dir of gone) {
        delete account[dir];
        if (!hitDirs.includes(dir)) {
          hitDirs.push(dir);
        }
      }
      hitKeys.push(key);
      if (!Object.keys(account).length) {
        delete store[key];
      }
    }
    if (JSON.stringify(store) === before) {
      return null;
    }
    await writeStore(store);
    return {keys: hitKeys, dirs: hitDirs};
  });
}

export {clearAll, clearAccount, clearDirs, getNeeded};
