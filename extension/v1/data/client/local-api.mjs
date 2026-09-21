'use strict';

// local-api.mjs — the MailApi the client UI talks to: a local-first facade
// over the OPFS maildir (core/sync/store.mjs).
//
// Every read (folders, counts, threads, message lists, search, bodies) is
// answered locally — the client page never opens an IMAP session. Flag state
// is read from the .eml longnames (maildir info part), so a local change is
// visible the moment the file rename happens. Folder-tree ops (create/delete)
// still go to the engine as queued ops ('mirror-mutate', server-first).
//
// Flag/delete/move mutations are LOCAL FILE EDITS this layer performs itself:
//   setFlags   → longname info rename (the engine diff-replays the STORE)
//   delete     → T (trash) info rename (engine replays \Deleted + EXPUNGE)
//   move       → cross-folder .eml rename keeping the foreign FMD5 (engine
//                replays the server UID MOVE and normalizes the name later)
// each followed by a fire-and-forget sync prompt (requestSync) — never a
// blocking round trip, and offline everything keeps working. The re-render
// happens through the mirrorChanged subscription below.
//
// Events: mirrorChanged.subscribe(fn) fires {accountId, dirs, syncedAt}
// whenever the engine moved index data for an account.

import {openMirror, threadSummaries} from '../../core/sync/store.mjs';
import {searchMirror} from '../../core/sync/search.mjs';

const selectable = attrs => !(Array.isArray(attrs) ? attrs : [])
  .some(a => /\\noselect|\\nonexistent/i.test(String(a)));

// ---- mirror change subscription (also: last-synced clock) -------------------

const listeners = new Set(); // fn({accountId, dirs, syncedAt})

chrome.runtime.onMessage.addListener(message => {
  if (message?.type === 'mirror-changed') {
    if (message.accountId && message.syncedAt) {
      (lastSyncedMap ??= {})[message.accountId] = message.syncedAt;
    }
    for (const fn of [...listeners]) {
      try {
        fn(message);
      }
      catch {
        /* a broken listener must not break the mirror feed */
      }
    }
  }
});

const mirrorChanged = {
  subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};

// Local edits (flag rename / trash / move) change files instantly — the open
// client must re-render just as instantly. chrome.runtime does not deliver
// the sender's own messages, so the facade calls this page's listeners
// directly (the worker's next mirror-changed event still follows with the
// synced-at clock).
function notifyLocalChange(accountId, dirs) {
  const evt = {type: 'mirror-changed', accountId, dirs, syncedAt: null};
  for (const fn of [...listeners]) {
    try {
      fn(evt);
    }
    catch {
      /* a broken listener must not break the mirror feed */
    }
  }
}

// Latest 'last synced' timestamps per account, merged engine snapshots +
// live updates (kept across client reloads in 'mirror.lastSynced').

let lastSyncedMap = null;

async function loadSyncSnapshot() {
  if (!lastSyncedMap) {
    lastSyncedMap = {};
    try {
      const all = await chrome.storage.local.get('mirror.lastSynced');
      for (const [id, t] of Object.entries(all?.['mirror.lastSynced'] ?? {})) {
        lastSyncedMap[id] = Number(t) || 0;
      }
    }
    catch {}
  }
  return lastSyncedMap;
}

function lastSynced(accountId) {
  return lastSyncedMap?.[accountId] ?? null;
}

// ---- API facade --------------------------------------------------------------


const apis = new Map(); // accountId -> api instance

// Native-filesystem-less — bodies live in OPFS, so the page reads them with
// the same calls the worker uses. A missing body (policy 'recent') is
// fetched on demand via the engine ('mirror-fetch').

async function fetchMissing(accountId, dirName, uid) {
  const res = await chrome.runtime.sendMessage({
    type: 'mirror-fetch',
    accountId,
    dir: dirName,
    uid: Number(uid),
  }).catch(() => null);
  if (!res?.ok) {
    throw new Error(res?.error || 'body not available locally and the sync engine is unreachable');
  }
  return res.bytes instanceof Uint8Array ? res.bytes : new Uint8Array(res.bytes);
}

export async function getLocalApi(accountId) {
  if (!accountId) {
    throw new Error('getLocalApi: accountId required');
  }
  if (apis.has(accountId)) {
    return apis.get(accountId);
  }
  const mirror = await openMirror(accountId);
  let selected = null;

  const sendMutation = op =>
    mutation(accountId, op);

  const api = {
    // the old MailApi remnants (compatibility for stragglers)
    async connect() {},
    async close() {
      selected = null;
    },
    selectedDir() {
      return selected;
    },

    async listDirs() {
      const meta = await mirror.getMeta();
      return (Array.isArray(meta.dirs) ? meta.dirs : []).filter(d => selectable(d.attrs));
    },

    async openDir(name) {
      const index = await mirror.getIndex(name);
      if (!index) {
        const err = new Error('no such mailbox: ' + name);
        err.code = 'mirror';
        throw err;
      }
      selected = name;
      // flag truth comes from the disk: every row's flags re-derive from the
      // longname info part (a local flag rename is visible instantly, before
      // any sync)
      const infoOf = new Map((await mirror.listItems(name)).map(it => [it.uid, it.info ?? []]));
      const messages = (index.messages ?? [])
        .map(row => ({...row, flags: infoOf.get(Number(row.uid)) ?? row.flags}))
        .filter(row => !row.flags.includes('\\Deleted'));
      return {
        exists: Number(index.exists) || messages.length,
        uidvalidity: Number(index.uidvalidity) || 0,
        uidnext: Number(index.uidnext) || 0,
        unseen: messages.filter(m => !m.flags.includes('\\Seen')).length,
      };
    },

    async listFiles({page = 0, pageSize = 20, fromUid, toUid} = {}) {
      if (!selected) throw new Error('openDir() first');
      const index = await mirror.getIndex(selected);
      const infoOf = new Map((await mirror.listItems(selected)).map(it => [it.uid, it.info ?? []]));
      // filename flags win (local edits); trash rows leave every list
      const all = ((index?.messages ?? []) ?? [])
        .map(row => ({...row, flags: infoOf.get(Number(row.uid)) ?? row.flags}))
        .filter(row => !row.flags.includes('\\Deleted'))
        .sort((a, b) => b.uid - a.uid);
      if (fromUid != null) {
        const lo = Number(fromUid);
        const hi = toUid != null ? Number(toUid) : lo;
        return all.filter(m => m.uid >= lo && m.uid <= hi);
      }
      const start = page * pageSize;
      return all.slice(start, start + pageSize);
    },

    async listThreads({refresh = false} = {}) {
      if (!selected) throw new Error('openDir() first');
      const index = await mirror.getIndex(selected);
      const infoOf = new Map((await mirror.listItems(selected)).map(it => [it.uid, it.info ?? []]));
      const merged = {
        ...index,
        messages: (index.messages ?? [])
          .map(row => ({...row, flags: infoOf.get(Number(row.uid)) ?? row.flags}))
          .filter(row => !row.flags.includes('\\Deleted')),
      };
      return threadSummaries(merged);
    },

    async readFile(uid) {
      if (!selected) throw new Error('openDir() first');
      const body = await mirror.getBody(selected, uid);
      if (body) {
        return body;
      }
      return fetchMissing(accountId, selected, uid);
    },

    async search({dir, query, allFolders = false} = {}) {
      const target = dir ?? selected;
      return searchMirror(mirror, {
        dir: target,
        query,
        allFolders: !!allFolders,
        // body reads may reach the engine when a body never landed locally
        getBody: async (dirName, uid) => (await mirror.getBody(dirName, uid))
          ?? await fetchMissing(accountId, dirName, uid),
      });
    },

    async listDirCounts(onProgress) {
      const meta = await mirror.getMeta();
      const dirs = (Array.isArray(meta.dirs) ? meta.dirs : []).filter(d => selectable(d.attrs));
      const summaries = await mirror.summarized();
      const out = [];
      for (const d of dirs) {
        const s = summaries.get(d.name) ?? {};
        const entry = {name: d.name, unread: Number(s.unread) || 0, total: Number(s.total) || 0};
        out.push(entry);
        if (typeof onProgress === 'function') {
          try {
            onProgress(entry);
          }
          catch {}
        }
      }
      return out;
    },

    // ---- mutations: pure local file edits (maildir semantics) ----
    // flags   → the longname info part rewrites itself; the next sync pass
    //           diff-drives the server STORE from the filename-vs-journal
    // delete  → the T (trash) info flag; the engine replays \Deleted +
    //           EXPUNGE and retires the file once the listing confirms
    // move    → the .eml renames into the target folder's cur/ keeping its
    //           foreign FMD5 — the sync pass replays the server UID MOVE
    // None of these block on the server: the fire-and-forget sync prompt
    // (action's write click) covers the replay; offline everything waits.

    async setFlags(uids, addFlags, removeFlags) {
      if (!selected) throw new Error('openDir() first');
      await mirror.setLocalFlags(selected, uids, addFlags, removeFlags);
      requestSync(accountId, selected);
      notifyLocalChange(accountId, [selected]);
      return 0;
    },

    async moveTo(uids, mailbox) {
      if (!selected) throw new Error('openDir() first');
      if (!mailbox || mailbox === selected) {
        throw new Error('move: a distinct target folder is required');
      }
      const rows = await mirror.moveLocal(selected, mailbox, uids);
      if (!rows.length) {
        throw new Error('move: messages are no longer in the local folder');
      }
      requestSync(accountId, selected);
      notifyLocalChange(accountId, [selected, mailbox]);
      return 0;
    },

    async deleteMessages(uids) {
      if (!selected) throw new Error('openDir() first');
      const rows = await mirror.removeLocal(selected, uids);
      if (!rows.length) {
        throw new Error('delete: messages are no longer in the local folder');
      }
      requestSync(accountId, selected);
      notifyLocalChange(accountId, [selected]);
      return 0;
    },

    async createDir(name) {
      if (typeof name !== 'string' || !name.trim()) throw new Error('createDir: folder name required');
      // the worker derives the delimiter from the parent; the tree needs it
      // only for hierarchy display before the folder's first server sync
      return sendMutation({kind: 'dir-create', name: name.trim()});
    },

    async deleteDir(name) {
      if (typeof name !== 'string' || !name) throw new Error('deleteDir: folder name required');
      return sendMutation({kind: 'dir-delete', name});
    },

    async idle() {
      return {type: 'interrupt'};
    },

    // sync controls used by the UI; `reason` explains the pass in the
    // logger (user_request, client_open, periodic, ...)
    async syncNow(dir = null, reason = 'user_request') {
      const res = await chrome.runtime.sendMessage({
        type: 'sync-now',
        accountId,
        reason,
        ...(dir ? {dir} : {}),
      }).catch(e => ({ok: false, error: e?.message || String(e)}));
      if (!res?.ok) {
        throw new Error(res?.error || 'sync failed');
      }
      return res.lastSynced;
    },

    lastSynced() {
      return lastSynced(accountId);
    },
  };

  apis.set(accountId, api);
  return api;
}

// The mutation ops ride the runtime channel; boolean-ish flag arguments are
// normalized to plain arrays so the worker can store them into the outbox.
async function sendMutation(op) {
  return chrome.runtime.sendMessage({type: 'mirror-mutate', accountId: op.accountId, op});
}

// Fire-and-forget sync prompt (action's write click): the Engine decides when
// it actually runs — single-flight, alarm cadence respected — and the diff
// replay reads this very disk next pass. Never blocks the caller.
function requestSync(id, dir) {
  chrome.runtime.sendMessage({
    type: 'sync-now',
    accountId: id,
    reason: 'replay',
    ...(dir ? {dir} : {}),
  }).catch(() => {});
}

// fixed: mutation senders must include the account id — re-wrapped here.
// Folder-tree ops resolve only after the op replayed for real and the touched
// folders resynced (engine execDirect). Client flag/delete/move mutations do
// NOT come through here anymore: they are local file edits (see the facade).
async function mutation(accountId, op) {
  const res = await chrome.runtime.sendMessage({type: 'mirror-mutate', accountId, op})
    .catch(e => ({ok: false, error: e?.message || String(e)}));
  if (!res?.ok) {
    throw new Error(res?.error || 'mutation failed');
  }
  return Number(res.lastSynced) || 0;
}

export {mirrorChanged, mutation, loadSyncSnapshot};
export function dropLocalApi(accountId) {
  apis.delete(accountId);
}
