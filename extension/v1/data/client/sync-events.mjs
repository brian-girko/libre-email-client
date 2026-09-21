'use strict';

// sync-events.mjs — the client end of the SyncEngine's activity stream.
//
// The engine (core/sync/engine.mjs) broadcasts two things the open client
// cares about:
//
//   'activity' (source 'sync') — transient logger lines, one per sync pass:
//     "Syncing <account>…", a per-folder note on each folder pass, and a
//     completed line when the pass ends.
//   synced-at clocks — carried both by sync-end activities and by every
//     'mirror-changed' event. The persistent logger status line shows
//     "Last synced" per account ("A: 10:32 · B: 09:58"), "never" when an
//     account has not synced yet.

import * as logger from './logger.mjs';
import {mirrorChanged} from './local-api.mjs';
import {verifyMaster} from '../../crypto.mjs';

const MASTER_HASH = 'master.hash';
const MASTER_PASS = 'master.pass';

const accounts = new Map();   // accountId -> label
const lastSynced = new Map(); // accountId -> timestamp

function stamp(ts) {
  const d = new Date(Number(ts));
  if (Number.isNaN(d.getTime())) {
    return '';
  }
  return d.toDateString() === new Date().toDateString()
    ? d.toLocaleTimeString()
    : d.toLocaleString();
}

// The persistent status: one segment per known account, each with its own
// clock; rendered compactly by the logger view.
function refreshStatus(accountId = null) {
  const ids = accountId != null && accounts.has(accountId)
    ? [accountId]
    : [...new Set([...accounts.keys(), ...lastSynced.keys()])];
  const parts = [];
  for (const id of ids) {
    const label = accounts.get(id) || id;
    const t = lastSynced.get(id) || 0;
    parts.push(label + ': ' + (t ? 'last synced ' + stamp(t) : 'never synced'));
  }
  if (!parts.length) {
    return;
  }
  logger.setStatus(parts.join(' · '), {tone: 'info', time: Date.now()});
}

// ---- locked master password ---------------------------------------------------------
//
// The engine runs in the worker and cannot prompt for a password: when a
// saved password sits encrypted behind an unconfirmed master password the
// syncs are parked ('needs master password') and the worker broadcasts
// 'sync-locked'. This page then asks for the master once, verifies it
// against the stored verifier, and confirms it in session storage — the
// worker's own storage listener picks the change up and re-runs the check
// (sync first, badge recount after), which unblocks every account.

let unlocking = null; // single-flight prompt

function handleSyncLocked() {
  if (unlocking) {
    return;
  }
  unlocking = unlockMaster()
    .catch(e => console.warn('[unlock] master prompt failed', e))
    .finally(() => {
      unlocking = null;
    });
}

async function unlockMaster() {
  const [{[MASTER_HASH]: verifier}] = await Promise.all([chrome.storage.local.get(MASTER_HASH)]);
  if (!verifier) {
    return false; // no master configured: nothing to unlock
  }
  const prompt = document.getElementById('prompt');
  for (let i = 0; prompt && i < 3; i++) {
    let pass = null;
    try {
      pass = await prompt.ask(
        i ? 'Wrong master password, try again' : 'Master password to unlock saved passwords',
        {password: true},
      );
    }
    catch {
      return false; // dismissed
    }
    if (!pass) {
      return false;
    }
    if (await verifyMaster(pass, verifier)) {
      await chrome.storage.session.set({[MASTER_PASS]: pass});
      // the badge's session-storage listener picks this up: its check runs
      // the engine sync, which flushes outboxes and mirrors everything
      return true;
    }
  }
  return false;
}

// ---- per-pass activity lines ------------------------------------------------

const entryFor = accountId => 'sync:' + (accountId || 'all');
const running = new Map(); // accountId -> {reason, done, total, firstError}

// why the pass is running — carried on every engine activity event
const REASONS = {
  user_request: 'user request',
  client_open: 'client opened',
  periodic: 'periodic check',
  filters: 'after filtering',
  replay: 'after pending changes',
  unlock: 'after master unlock',
  config: 'after settings change',
};
const reasonText = r => REASONS[r] || 'manual sync';

// Running-label builder: reason, n/m folder progress and the folder being
// touched — "Syncing Work · periodic — 3/12 (INBOX)".
function syncLine({label, rss, folder, extra} = {}) {
  const reason = REASONS[rss?.reason] || 'manual sync';
  let out = 'Syncing ' + label + ' · ' + reason;
  if (rss && rss.total > 0) {
    out += ' — ' + (rss.done || 0) + '/' + rss.total;
    if (folder) {
      out += ' (' + folder + ')';
    }
  }
  else if (folder) {
    out += ' — ' + folder;
  }
  if (extra) {
    out += ' — ' + extra;
  }
  return out;
}

// Big-folder body prompt: "N messages — how many to keep locally?" with the
// same options as the settings page. One prompt per folder at a time; the
// answer rides back to the engine as 'sync-prefetch-answer'.
const askingFolders = new Set(); // 'accountId\u0000folder'

async function handleAskPrefetch(message) {
  const {accountId, dir, total} = message;
  if (!accountId || !dir || (!total)) {
    return;
  }
  const key = accountId + '\u0000' + dir;
  if (askingFolders.has(key)) {
    return;
  }
  askingFolders.add(key);
  try {
    const prompt = document.getElementById('prompt');
    if (!prompt) {
      return; // no client page up: the folder stays deferred until asked later
    }
    let choice = null;
    try {
      choice = await prompt.askChoice(
        '"' + dir + '" holds about ' + total + ' emails. How many should be stored on this device?',
        [
          {value: 'all', label: 'All'},
          {value: 200, label: '200'},
          {value: 50, label: '50'},
          {value: 20, label: '20'},
        ],
      );
    }
    catch {
      return; // cancelled / dismissed: nothing chosen this pass
    }
    if (choice == null) {
      return;
    }
    await chrome.runtime.sendMessage({type: 'sync-prefetch-answer', accountId, dir, spec: choice});
  }
  catch (e) {
    console.warn('[sync] prefetch answer failed', e);
  }
  finally {
    askingFolders.delete(key);
  }
}

function handleSyncActivity(message) {
  const {accountId = '', phase} = message;
  const id = entryFor(accountId);
  const label = accounts.get(accountId) || accountId || 'account';

  if (phase === 'start') {
    running.set(accountId, {
      reason: message.reason,
      done: 0,
      total: Number(message.total) > 0 ? Number(message.total) : 0,
      firstError: null,
    });
    logger.begin({
      id,
      source: 'sync',
      kind: 'sync',
      label: 'Syncing ' + label + ' · ' + reasonText(message.reason) + '…',
      doneLabel: 'Synced ' + label + ' · ' + reasonText(message.reason),
      cancelable: false,
    });
    logger.update(id, {state: 'running'});
    return;
  }
  if (phase === 'folder') {
    const rss = running.get(accountId);
    if (rss) {
      const done = Number(message.done);
      if (Number.isFinite(done)) {
        rss.done = done;
      }
      const total = Number(message.total);
      if (Number.isFinite(total) && total > 0) {
        rss.total = total;
      }
      logger.update(id, {
        state: 'running',
        label: syncLine({label, rss, folder: message.folder}),
      });
    }
    return;
  }
  if (phase === 'ask-prefetch') {
    // the engine hit a big folder with no body limit yet: show that state on
    // the line and pop the one-off choice dialog
    const rss = running.get(accountId);
    if (rss) {
      logger.update(id, {
        state: 'running',
        label: syncLine({
          label, rss,
          folder: message.folder,
          extra: 'asking — how many emails to keep locally',
        }),
      });
    }
    return;
  }
  if (phase === 'locked') {
    // the pass parked for a locked master password: the prompt flow above
    // resolves it — show that state on the line instead of a bare error
    const rss = running.get(accountId);
    if (rss) {
      rss.firstError = 'waiting for master password';
    }
    logger.update(id, {
      state: 'running',
      label: 'Syncing ' + label + ' — waiting for master password',
      error: null,
    });
    return;
  }
  if (phase === 'error') {
    const rss = running.get(accountId);
    const firstError = String(message.error ?? 'sync failed');
    if (rss && !rss.firstError) {
      rss.firstError = firstError;
    }
    logger.update(id, {
      state: 'running',
      error: message.folder ? ('folder ' + message.folder + ': ' + firstError) : firstError,
    });
    return;
  }
  if (phase === 'end') {
    const rss = running.get(accountId);
    running.delete(accountId);
    const folders = Number(message.folders);
    const n = Number.isFinite(folders) ? folders : 0;
    const err = message.error != null
      ? String(message.error)
      : rss?.firstError ?? null;
    const why = ' · ' + reasonText(message.reason);
    const closing = 'Synced ' + label + why + (n ? ' — ' + n + ' folder' + (n === 1 ? '' : 's') : '');
    if (err && !n) {
      if (err === 'waiting for master password') {
        logger.update(id, {error: null});
        logger.done(id, 'Syncing ' + label + why + ' — waiting for master password');
        return;
      }
      logger.fail(id, err);
      return;
    }
    logger.update(id, {error: err});
    logger.done(id, err ? (closing + ' · ' + err) : closing);
    return;
  }
}

// ---- last-synced clock ------------------------------------------------------

function noteSynced(accountId, syncedAt, {silent = false} = {}) {
  if (!accountId || !syncedAt) {
    return;
  }
  if ((lastSynced.get(accountId) || 0) >= Number(syncedAt)) {
    return; // monotonic: a folder-only sync never rewinds the account clock
  }
  lastSynced.set(accountId, Number(syncedAt));
  if (!silent) {
    refreshStatus(accountId);
  }
  else {
    refreshStatus(null);
  }
}

// Even silently-updated clocks want the status visible on the first paint:
// the initial status render happens once, at init.
let statusShown = false;

function maybeShow() {
  if (!statusShown && lastSynced.size) {
    refreshStatus(null);
    statusShown = true;
  }
}

async function loadAccounts() {
  try {
    const {accounts: list} = await chrome.storage.local.get({accounts: []});
    const next = new Map();
    for (const a of Array.isArray(list) ? list : []) {
      if (a?.id) {
        next.set(a.id, a.label || a.id);
      }
    }
    accounts.clear();
    for (const [k, v] of next) {
      accounts.set(k, v);
    }
    maybeShow();
  }
  catch {
    /* labels stay empty until storage answers */
  }
}

async function loadPersistence() {
  try {
    const all = await chrome.storage.local.get('mirror.lastSynced');
    for (const [id, t] of Object.entries(all?.['mirror.lastSynced'] ?? {})) {
      if (Number(t)) {
        lastSynced.set(id, Number(t));
      }
    }
    maybeShow();
  }
  catch {
    /* no stored clocks yet */
  }
}

// ---- wiring -------------------------------------------------------------------

function init() {
  loadAccounts();
  loadPersistence();

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && 'accounts' in changes) {
      loadAccounts();
    }
    if (area === 'local' && 'mirror.lastSynced' in changes) {
      const map = changes['mirror.lastSynced'].newValue ?? {};
      for (const [id, t] of Object.entries(map)) {
        if (Number(t)) {
          lastSynced.set(id, Number(t));
        }
      }
      maybeShow();
      refreshStatus(null);
    }
  });

  chrome.runtime.onMessage.addListener(message => {
    if (message?.type === 'sync-locked') {
      handleSyncLocked();
      return;
    }
    if (message?.type === 'sync-ask-prefetch') {
      handleAskPrefetch(message).catch(() => {});
      return;
    }
    if (message?.type !== 'activity' || message.source !== 'sync') {
      return;
    }
    handleSyncActivity(message);
  });

  mirrorChanged.subscribe(evt => {
    noteSynced(evt.accountId, evt.syncedAt, {silent: true});
  });
}

export {init};
