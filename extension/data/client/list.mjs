import './components/list-view.js';
import {getMailApi} from './mail.mjs';
import {getPref, setPref} from './prefs.mjs';
import {writeFiles} from '../../core/native/native-client.mjs';
import {enqueue, updateJob, uidBusy} from './jobs.mjs';
import {currentDirs, setupIncomplete} from './dirs.mjs';
import * as counters from './counters.mjs';
import * as logger from './logger.mjs';

let el = null;
let accountId = null;
let dirName = null;
let loadToken = 0;
let page = 0;
let pageSize = 50;
let totalPages = 1;

const TRASH_NAMES = ['Trash', 'Deleted Messages', 'Deleted Items'];
const ARCHIVE_NAMES = ['Archive', 'Archives'];
const SPAM_NAMES = ['Junk', 'Spam', 'Junk E-mail', 'Junk Mail', 'Suspicious'];

// bulk-move targets: special-use attribute first (RFC 6154), then common names
const MOVE_TARGETS = {
  trash: {attr: '\\Trash', names: TRASH_NAMES, label: 'trash'},
  archive: {attr: '\\Archive', names: ARCHIVE_NAMES, label: 'archive'},
  spam: {attr: '\\Junk', names: SPAM_NAMES, label: 'spam/junk'}
};

function findSpecialDir(dirs, attr, names) {
  const wanted = String(attr).toLowerCase();
  const byAttr = dirs.find(d => Array.isArray(d.attrs) && d.attrs.some(a => String(a).toLowerCase() === wanted));
  if (byAttr) {
    return byAttr.name;
  }
  const byName = dirs.find(d => names.some(n => String(d.name).toLowerCase() === n.toLowerCase()));
  return byName ? byName.name : null;
}

function messageCountLabel(count) {
  return count + ' message' + (count === 1 ? '' : 's');
}

// ---- native save overrides ("Actions" tab in the options) ----
// An enabled override replaces the default IMAP move of the matching button
// with: copy the raw email(s) into the configured directory FIRST, and only
// then touch the server — delete from IMAP when the override's checkbox says
// so, otherwise ask the user per batch. A failed copy never blocks the other
// messages, and nothing is changed on the server for failed copies.
const OVERRIDE_PREFIX = 'override.';

async function readOverride(action) {
  const key = OVERRIDE_PREFIX + action + '.';
  const res = await chrome.storage.local.get({
    [key + 'enabled']: false,
    [key + 'path']: '',
    [key + 'delete']: false
  });
  if (!res[key + 'enabled']) {
    return null;
  }
  const path = String(res[key + 'path'] || '').trim();
  if (!path) {
    throw new Error('"Save to disk" override for ' + MOVE_TARGETS[action].label + ' is enabled without a destination path; fix it in the options');
  }
  return {path, remove: !!res[key + 'delete']};
}

function saveStamp() {
  const p = n => String(n).padStart(2, '0');
  const d = new Date();
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
    + 'T' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}

function reportFailures(failed) {
  const first = failed[0];
  return 'failed: uid ' + first.uid + ' (' + first.message + ')'
    + (failed.length > 1 ? ' +' + (failed.length - 1) + ' more' : '');
}

// Cut the pre-removal snapshots down to the given uids: after a job only the
// uids that failed to save were never touched on the server, so only those
// belong back in the list (their conversation siblings stay away).
function subsetSnapshot(snapshot, keepSet) {
  const out = [];
  for (const snap of snapshot) {
    const messages = snap.messages.filter(m => keepSet.has(Number(m.uid)));
    if (messages.length) {
      out.push({
        ...snap,
        messages,
        uids: messages.map(m => m.uid),
        count: messages.length,
        unread: messages.filter(m => !hasFlag(m.flags, '\\Seen')).length,
        flagged: messages.some(m => hasFlag(m.flags, '\\Flagged'))
      });
    }
  }
  return out;
}

// ---- optimistic background actions (jobs) ----

// hasFlag helper mirroring list-view's flag semantics
const hasFlag = (flags, flag) => (Array.isArray(flags) ? flags : []).includes(flag);

// Predicted counter deltas for a user action, served to counters.mjs via the
// job's meta.counters. Message-level unread changes are exact (snapshot data
// taken from the same thread objects the optimistic UI just applied); the
// badge counts conversations, so its move/flags deltas follow the confirmed
// bracket rule: only when a conversation's unread count actually flips.
// Unread mail arriving into the account's badge folder counts +1 there; a
// folder's counts are decremented only when they are its own actions.
function flagOps(id, folder, snapshot, uids, addFlags, removeFlags) {
  const addsSeen = hasFlag(addFlags, '\\Seen');
  const removesSeen = hasFlag(removeFlags, '\\Seen');
  if (!addsSeen && !removesSeen) {
    return [];
  }
  const badgeFolder = counters.badgeFolder(id);
  const wanted = new Set(uids.map(Number));
  // search results group threads across folders (each row carries its own
  // dir); normal folder views have no per-thread dir -> the open folder
  const byFolder = new Map();
  for (const t of snapshot) {
    const mine = (t.messages || []).filter(m => wanted.has(Number(m.uid)));
    if (!mine.length) {
      continue;
    }
    const src = t.dir || folder;
    const agg = byFolder.get(src) || {dUnread: 0, dBadge: 0};
    const unreadSel = mine.filter(m => !hasFlag(m.flags, '\\Seen')).length;
    const readSel = mine.length - unreadSel;
    if (addsSeen) {
      agg.dUnread -= unreadSel;
      if (badgeFolder === src && t.unread > 0 && t.unread - unreadSel <= 0) {
        agg.dBadge -= 1;
      }
    }
    else {
      agg.dUnread += readSel;
      if (badgeFolder === src && t.unread === 0 && readSel > 0) {
        agg.dBadge += 1;
      }
    }
    byFolder.set(src, agg);
  }
  const ops = [];
  for (const [src, agg] of byFolder) {
    if (agg.dUnread || agg.dBadge) {
      ops.push({accountId: id, folder: src, dUnread: agg.dUnread, dTotal: 0, dBadge: agg.dBadge});
    }
  }
  return ops;
}

function moveOps(id, folder, target, snapshot, candidates) {
  if (!snapshot) {
    return [];
  }
  const badgeFolder = counters.badgeFolder(id);
  const wanted = new Set(candidates.map(Number));
  // per-source aggregation: the source folder is the thread's own dir in
  // search results, the open folder otherwise
  const byFolder = new Map();
  let tgtBadge = 0;
  for (const t of snapshot) {
    const mine = (t.messages || []).filter(m => wanted.has(Number(m.uid)));
    if (!mine.length) {
      continue;
    }
    const mu = mine.filter(m => !hasFlag(m.flags, '\\Seen')).length;
    if (!mu) {
      continue;
    }
    const src = t.dir || folder;
    const agg = byFolder.get(src) || {dUnread: 0, dTotal: 0, dBadge: 0};
    agg.dUnread -= mu;
    agg.dTotal -= mine.length;
    if (badgeFolder === src && (t.unread || 0) - mu <= 0) {
      agg.dBadge -= 1;
    }
    if (target && badgeFolder === target) {
      tgtBadge += 1;
    }
    byFolder.set(src, agg);
  }
  if (!candidates.length) {
    return [];
  }
  const ops = [];
  let totalUnread = 0;
  let totalCount = 0;
  for (const [src, agg] of byFolder) {
    ops.push({accountId: id, folder: src, dUnread: agg.dUnread, dTotal: agg.dTotal, dBadge: agg.dBadge});
    totalUnread -= agg.dUnread;
    totalCount -= agg.dTotal;
  }
  if (target) {
    ops.push({
      accountId: id,
      folder: target,
      dUnread: totalUnread,
      dTotal: totalCount,
      dBadge: tgtBadge
    });
  }
  return ops;
}

function folderTotals(threads) {
  let unread = 0;
  let total = 0;
  for (const t of Array.isArray(threads) ? threads : []) {
    unread += Number(t.unread) || 0;
    total += Number(t.count) || 0;
  }
  return {unread, total};
}

// Forced move (trash/archive/spam/move). The messages drop out of the list
// immediately, then the batch server move runs as a job; on failure the
// snapshotted rows come back. Rollback only touches the view if the user is
// still on the same folder.
async function queueMove(id, name, uids, target, label, doneLabel) {
  if (target === name) {
    el.status('Messages are already in ' + target);
    return;
  }
  const candidates = uids.map(Number).filter(uid => !uidBusy(id, uid));
  if (!candidates.length) {
    return;
  }
  const snapshot = el.snapshotRows(candidates);
  const ops = moveOps(id, name, target, snapshot, candidates);
  el.removeRows(candidates);
  enqueue({
    accountId: id,
    kind: 'move',
    label,
    doneLabel,
    uids: candidates,
    meta: ops.length ? {counters: {ops}} : undefined,
    run: api => api.moveTo(candidates, target),
    rollback: () => {
      if (id !== accountId || name !== dirName) {
        return;
      }
      el.restoreRows(snapshot);
    }
  });
}

// Flag change (mark-read/unread, star): applied to the UI immediately, then
// synced as a job. quiet jobs render no bar line (auto mark-read on open).
function queueFlag(id, uids, addFlags, removeFlags, label, doneLabel = label, quiet = false) {
  if (!id || !Array.isArray(uids) || !uids.length) {
    return;
  }
  const list = uids.map(Number);
  // snapshot BEFORE the optimistic apply: the counters need the pre-action
  // unread state (applyFlags rewrites it in place)
  const snapshot = el.snapshotRows(list);
  const ops = flagOps(id, dirName, snapshot, list, addFlags, removeFlags);
  el.applyFlags(list, addFlags, removeFlags);
  enqueue({
    accountId: id,
    kind: 'flags',
    label,
    doneLabel,
    quiet,
    uids: list,
    meta: ops.length ? {counters: {ops}} : undefined,
    run: api => api.setFlags(list, addFlags, removeFlags),
    rollback: () => el.applyFlags(list, removeFlags, addFlags)
  });
}

async function runMoveDirAction(action, id, name, uids, token) {
  const spec = MOVE_TARGETS[action];
  if (!spec) {
    return;
  }

  const override = await readOverride(action);
  if (stale(token)) {
    return;
  }
  if (override) {
    await runSaveAction(action, override, spec, id, name, uids, token);
    return;
  }

  let target = findSpecialDir(currentDirs(id), spec.attr, spec.names);
  if (!target) {
    const api = await getMailApi(id);
    if (stale(token)) {
      return;
    }
    const dirs = await api.listDirs();
    if (stale(token)) {
      return;
    }
    target = findSpecialDir(dirs, spec.attr, spec.names);
  }
  if (!target) {
    throw new Error('No ' + spec.label + ' folder found on the server');
  }
  const count = uids.length;
  await queueMove(
    id, name, uids, target,
    `Moving ${messageCountLabel(count)} to ${target}`,
    `Moved ${messageCountLabel(count)} to ${target}`,
  );
}

async function runMovePickerAction(id, name, uids, token) {
  const api = await getMailApi(id);
  if (stale(token)) {
    return;
  }
  const dirs = await api.listDirs();
  if (stale(token)) {
    return;
  }
  // modal folder picker; null = cancelled
  const target = await el.askDestination(dirs, {current: name, count: uids.length});
  if (!target || stale(token)) {
    return;
  }
  const count = uids.length;
  await queueMove(
    id, name, uids, target,
    `Moving ${messageCountLabel(count)} to ${target}`,
    `Moved ${messageCountLabel(count)} to ${target}`,
  );
}

// Override flow as a single multi-stage job: the messages leave the list
// immediately, the raw copies are written to disk (cancelable), and only then
// the server side runs — auto-delete, or the askAfterSave modal deciding
// between delete / move / leave-on-server. Discarding ("do nothing") brings
// the rows back. Server problems are re-thrown with the save outcome prefixed
// so the user can tell copy from delete problems.
async function runSaveAction(action, override, spec, id, name, uids, token) {
  const dir = override.path;
  const candidates = uids.map(Number).filter(uid => !uidBusy(id, uid));
  if (!candidates.length) {
    return;
  }
  const snapshot = el.snapshotRows(candidates);
  el.removeRows(candidates);

  enqueue({
    accountId: id,
    kind: 'save',
    label: `Saving ${messageCountLabel(candidates.length)} to ${dir}`,
    uids: candidates,
    run: async (api, job) => {
      const copied = [];
      const failed = [];
      const total = candidates.length;
      const numbers = candidates.map(Number);
      // speed: reads run in a windowed pipeline (overlap the IMAP fetches of
      // the next slice with the disk writes of the previous one) and copies
      // leave in batched write-batch calls (10 files per IPC round trip)
      const WINDOW = 10;
      const BATCH = 10;
      let doneCount = 0;
      const buffer = [];
      let flusher = Promise.resolve();

      const flush = () => {
        if (!buffer.length) {
          return;
        }
        const batch = buffer.splice(0, BATCH);
        flusher = flusher.then(async () => {
          const res = await writeFiles(batch.map(entry => entry.file));
          const results = res?.results ?? [];
          for (let j = 0; j < batch.length; j++) {
            const entry = batch[j];
            const r = results[j];
            doneCount++;
            job.label = `Saving ${doneCount}/${total} to ${dir}…`;
            updateJob(job.id, {label: job.label, progress: {done: doneCount, total}});
            if (r && r.ok) {
              copied.push(entry.uid);
            }
            else {
              failed.push({uid: entry.uid, message: (r && r.error) || 'native client write failed'});
            }
          }
        });
      };
      const drain = () => flusher;

      for (let i = 0; i < total; i += WINDOW) {
        if (job.state === 'cancelled') {
          break;
        }
        const slice = numbers.slice(i, i + WINDOW);
        const reads = await Promise.allSettled(slice.map(uid => api.readFile(uid)));
        for (let j = 0; j < slice.length; j++) {
          const uid = slice[j];
          const read = reads[j];
          if (read.status === 'fulfilled') {
            if (job.state === 'cancelled') {
              break;
            }
            // queue the .eml; the write itself runs through the shared
            // batched chain, fully overlapping the next slice's fetches
            buffer.push({
              uid,
              file: {dir, name: saveStamp() + '-' + uid + '.eml', data: read.value}
            });
            flush();
          }
          else {
            // this one email failed; every other email still runs
            const e = read.reason;
            failed.push({uid, message: e?.message || String(e)});
            doneCount++;
            job.label = `Saving ${doneCount}/${total} to ${dir}…`;
            updateJob(job.id, {label: job.label, progress: {done: doneCount, total}});
          }
        }
      }
      await drain();
      if (job.state === 'cancelled') {
        return;
      }

      // failed emails remain harmless on the server: put their rows back (so
      // they do not silently disappear) and tag them with the reason
      if (failed.length) {
        const intactView = id === accountId && name === dirName;
        if (intactView) {
          const failedSet = new Set(failed.map(f => Number(f.uid)));
          el.restoreRows(subsetSnapshot(snapshot, failedSet));
          for (const f of failed) {
            el.markRowError([f.uid], f.message);
          }
        }
        // one activity-logger line per failed email
        for (const f of failed) {
          const lid = job.id + '-' + f.uid;
          logger.begin({
            id: lid,
            kind: 'save',
            label: 'Saving uid ' + f.uid + ' to ' + dir,
            doneLabel: 'Saved uid ' + f.uid + ' to ' + dir
          });
          logger.fail(lid, f.message);
        }
      }
      job.cancelable = false;

      const saved = messageCountLabel(copied.length);
      if (!copied.length) {
        throw new Error('Nothing was written to ' + dir + ' — ' + reportFailures(failed));
      }
      const failures = failed.length ? ' — ' + reportFailures(failed) : '';
      const intact = id === accountId && name === dirName;

      let choice = null;
      if (override.remove) {
        choice = 'deleted';
      }
      else if (intact) {
        choice = await el.askAfterSave(copied.length, spec.label);
      }
      if (job.state === 'cancelled') {
        return;
      }

      if (choice === 'deleted') {
        try {
          await api.deleteMessages(copied);
          // counters mid-run: server truth for this outcome is known now; a
          // later failure of the whole job reverts the applied prediction
          counters.apply(job, moveOps(id, name, null, snapshot, copied));
          job.label = `Saved ${saved} to ${dir} and deleted from IMAP${failures}`;
        }
        catch (e) {
          throw new Error('Saved ' + saved + ' to ' + dir + ', but deleting from IMAP failed: ' + (e?.message || e));
        }
      }
      else if (choice === 'move') {
        try {
          let dirs = currentDirs(id);
          if (!dirs.length) {
            dirs = await api.listDirs();
          }
          const target = findSpecialDir(dirs, spec.attr, spec.names);
          if (!target) {
            throw new Error('No ' + spec.label + ' folder found on the server');
          }
          await api.moveTo(copied, target);
          counters.apply(job, moveOps(id, name, target, snapshot, copied));
          job.label = `Saved ${saved} to ${dir} and moved to ${target}${failures}`;
        }
        catch (e) {
          throw new Error('Saved ' + saved + ' to ' + dir + ', but the move failed: ' + (e?.message || e));
        }
      }
      else {
        if (intact) {
          el.restoreRows(snapshot);
        }
        job.label = `Saved ${saved} to ${dir}; originals left on the server${failures}`;
      }
    },
    rollback: () => {
      if (id !== accountId || name !== dirName) {
        return;
      }
      el.restoreRows(snapshot);
    }
  });
}

const SORT_MODES = ['', 'date-asc', 'subject-asc', 'subject-desc', 'sender-asc', 'sender-desc'];

async function readPageSize() {
  const res = await chrome.storage.local.get({'ui.mailPageSize': 50});
  const n = Number(res['ui.mailPageSize']);
  return Number.isInteger(n) && n >= 1 && n <= 500 ? n : 50;
}

// apply persisted view prefs (sort order, flagged-on-top, unread-only) to the component
async function applyViewPrefs() {
  const sort = await getPref('mailSort', '');
  el.sortMode = SORT_MODES.includes(sort) ? sort : '';
  el.flaggedOnTop = !!(await getPref('mailFlaggedTop', false));
  el.unreadOnly = !!(await getPref('mailUnreadOnly', false));
  el.threadMode = (await getPref('mailThreadMode', true)) !== false;
}

// active search state; null = normal folder view
let search = null; // {query, scope, dir}

// True while search results (not the folder) are shown.
function isSearching() {
  return search !== null;
}

// Leave search mode and redraw the normal folder view.
async function clearSearch() {
  if (!search || !accountId || !dirName) {
    return;
  }
  await load(accountId, dirName);
}

// Threads are grouped for the whole folder inside the wasm core, so paging is
// a pure slice of that list: one page holds `pageSize` conversations.
// refresh: bypass both cache tiers and refetch the folder from the server.
async function load(id, name, {refresh = false} = {}) {
  const token = ++loadToken;
  if (id !== accountId || name !== dirName) {
    page = 0;
  }
  accountId = id;
  dirName = name;
  // a folder/account change invalidates the running search
  search = null;
  el.loading();
  if (!accountId || !name) {
    el.error('No directory selected');
    return;
  }
  try {
    const api = await getMailApi(accountId);
    if (token !== loadToken) {
      return;
    }
    const pageSizePref = await readPageSize();
    if (token !== loadToken) {
      return;
    }
    pageSize = pageSizePref;
    await applyViewPrefs();
    if (token !== loadToken) {
      return;
    }
    const status = await api.openDir(name);
    if (token !== loadToken) {
      return;
    }
    const threads = await api.listThreads({refresh});
    if (token !== loadToken) {
      return;
    }
    totalPages = Math.max(1, Math.ceil(threads.length / pageSize));
    if (page >= totalPages) {
      page = totalPages - 1;
    }
    const rows = threads.slice(page * pageSize, (page + 1) * pageSize);
    counters.reconcile(accountId, name, folderTotals(threads));
    el.build(rows);
    el.setPager({page, pageSize, total: threads.length});
  }
  catch (e) {
    if (token !== loadToken) {
      return;
    }
    const message = e?.message || String(e);
    // "Account not found" happens with a stale account id (or none at all):
    // it is normally a fixable-account case, but with no bridge configured
    // either the setup window is the real fix — offer it instead of the
    // bare "Account not found" text.
    if (/account .{0,40}not found/i.test(message) && await setupIncomplete()) {
      el.setupNeeded('Setup is not finished: configure a remote WS server or install the native client, then add an account.');
      return;
    }
    el.error(message);
  }
}

// Background sync: re-read the open folder and reconcile the list in place
// (add new conversations, drop gone ones) instead of reloading the view.
// Called after a worker filter/badge pass moved or delivered mail. Selection,
// expansion and the scroll position are preserved; the loading state is never
// shown. A no-op when the open folder changed or search results are shown.
async function sync(id, name) {
  if (!id || !name || id !== accountId || name !== dirName || search) {
    return;
  }
  const token = ++loadToken;
  try {
    const api = await getMailApi(id);
    if (token !== loadToken) {
      return;
    }
    await api.openDir(name);
    if (token !== loadToken) {
      return;
    }
    const threads = await api.listThreads();
    if (token !== loadToken) {
      return;
    }
    totalPages = Math.max(1, Math.ceil(threads.length / pageSize));
    if (page >= totalPages) {
      page = totalPages - 1;
    }
    const rows = threads.slice(page * pageSize, (page + 1) * pageSize);
    counters.reconcile(accountId, name, folderTotals(threads));
    el.sync(rows);
    el.setPager({page, pageSize, total: threads.length});
  }
  catch (e) {
    if (token !== loadToken) {
      return;
    }
    // A sync failure must not wipe the current view; surface it in the status
    // note and let the next action retry.
    console.warn('folder sync failed', e);
    el.status('Sync failed: ' + (e?.message || String(e)), true);
  }
}

// Light refresh of the currently open folder, without a folder change: the
// list is reconciled in place (see sync). A no-op when search results are
// shown or nothing is selected; reached from the worker's action-button ping.
function syncCurrent() {
  return sync(accountId, dirName);
}

// Run a server-side IMAP search and render the (threaded) results in place
// of the folder list. scope 'all' searches every folder of the account.
async function runSearch(id, name, query, scope) {
  const token = ++loadToken;
  accountId = id;
  dirName = name;
  el.loading();
  try {
    const api = await getMailApi(id);
    if (token !== loadToken) {
      return;
    }
    // make sure the folder is open so reads/actions stay bound to it
    await api.openDir(name);
    if (token !== loadToken) {
      return;
    }
    const all = scope === 'all';
    const results = await api.search({dir: name, query, allFolders: all});
    if (token !== loadToken) {
      return;
    }
    search = {query, scope};
    await applyViewPrefs();
    el.build(results);
    el.setPager(null);
    el.status(
      results.length
        ? `Search "${query}" — ${results.length} ${all ? 'threads in all folders' : 'conversations in ' + name}`
        : `No results for "${query}"`,
    );
  }
  catch (e) {
    if (token !== loadToken) {
      return;
    }
    el.error(e?.message || String(e));
  }
}

function gotoPage(next) {
  if (!accountId || !dirName || next < 0 || next >= totalPages || next === page) {
    return;
  }
  page = next;
  load(accountId, dirName);
}

function changePage(delta) {
  gotoPage(page + delta);
}

function stale(token) {
  return token !== loadToken;
}

async function runAction(action, uids) {
  const id = accountId;
  const name = dirName;
  if (!id || !name || !Array.isArray(uids) || uids.length === 0) {
    return;
  }
  const token = loadToken;
  try {
    if (action === 'mark-read' || action === 'mark-unread') {
      const read = action === 'mark-read';
      const count = uids.length;
      const what = read ? 'read' : 'unread';
      queueFlag(
        id, uids,
        read ? ['\\Seen'] : [],
        read ? [] : ['\\Seen'],
        `Marking ${messageCountLabel(count)} as ${what}`,
        `Marked ${messageCountLabel(count)} as ${what}`,
      );
    }
    else if (MOVE_TARGETS[action]) {
      await runMoveDirAction(action, id, name, uids, token);
    }
    else if (action === 'move') {
      await runMovePickerAction(id, name, uids, token);
    }
  }
  catch (e) {
    if (!stale(token)) {
      el.status(e?.message || String(e), true);
    }
  }
}

function runFlag(uids, flagged) {
  const count = Array.isArray(uids) ? uids.length : 0;
  if (!count) {
    return;
  }
  queueFlag(
    accountId, uids,
    flagged ? ['\\Flagged'] : [],
    flagged ? [] : ['\\Flagged'],
    (flagged ? 'Flagging ' : 'Unflagging ') + messageCountLabel(count),
    (flagged ? 'Flagged ' : 'Unflagged ') + messageCountLabel(count),
  );
}

// Auto mark-read when a conversation is previewed or opened. Optimistic and
// queued like the toolbar actions, but quiet: no bar line for the constant
// stream of reads that opening mail produces.
function markRead(uids) {
  const id = accountId;
  const name = dirName;
  if (!id || !name || !Array.isArray(uids) || !uids.length) {
    return;
  }
  const unread = uids.map(Number).filter(uid => !el.isRead(uid));
  if (!unread.length) {
    return;
  }
  queueFlag(
    id, unread, ['\\Seen'], [],
    `Marking ${messageCountLabel(unread.length)} as read`,
    `Marked ${messageCountLabel(unread.length)} as read`,
    true,
  );
}

function init(element) {
  el = element;
  el.addEventListener('page-first', () => gotoPage(0));
  el.addEventListener('page-prev', () => changePage(-1));
  el.addEventListener('page-next', () => changePage(1));
  el.addEventListener('page-last', () => gotoPage(totalPages - 1));
  el.addEventListener('sort-changed', e => {
    setPref('mailSort', e.detail?.mode ?? '');
  });
  el.addEventListener('unread-changed', e => {
    setPref('mailUnreadOnly', !!e.detail?.on);
  });
  el.addEventListener('thread-changed', e => {
    setPref('mailThreadMode', e.detail?.on !== false);
    if (accountId && dirName) {
      load(accountId, dirName);
    }
  });
  el.addEventListener('refresh', () => {
    if (accountId && dirName) {
      load(accountId, dirName, {refresh: true});
    }
  });
  el.addEventListener('star', e => {
    const detail = e.detail;
    if (!detail) {
      return;
    }
    runFlag(detail.uids, detail.flagged);
  });
  el.addEventListener('spam', e => runAction('spam', e.detail?.uids));
  el.addEventListener('move', e => runAction('move', e.detail?.uids));
  el.addEventListener('mark-read', e => runAction('mark-read', e.detail?.uids));
  el.addEventListener('mark-unread', e => runAction('mark-unread', e.detail?.uids));
  el.addEventListener('trash', e => runAction('trash', e.detail?.uids));
  el.addEventListener('archive', e => runAction('archive', e.detail?.uids));
  el.addEventListener('preview', e => {
    const detail = e.detail;
    if (!accountId || !detail) {
      return;
    }
    markRead(detail.uids);
    el.dispatchEvent(new CustomEvent('email-preview', {
      detail: {
        accountId,
        uids: detail.uids
      },
      bubbles: true,
      composed: true
    }));
  });
}

export {init, load, sync, syncCurrent, runSearch, clearSearch, isSearching};