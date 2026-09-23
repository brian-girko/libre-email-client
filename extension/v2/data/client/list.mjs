import './components/list-view.js';
import {getMailApi} from './mail.mjs';
import {getPref, setPref} from './prefs.mjs';
import {enqueue, uidBusy} from './jobs.mjs';
import {currentDirs} from './dirs.mjs';
import {writeFiles} from '/core/native/native-client.mjs';
import {STAR_COLORS, starFlagOps} from './star-colors.mjs';
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

// bulk-move targets: common names (no server special-use attributes exist)
const MOVE_TARGETS = {
  trash: {names: TRASH_NAMES, label: 'trash'},
  archive: {names: ARCHIVE_NAMES, label: 'archive'},
  spam: {names: SPAM_NAMES, label: 'spam/junk'}
};

function findSpecialDir(dirs, spec) {
  const byName = dirs.find(d => spec.names.some(n => String(d.name).toLowerCase() === n.toLowerCase()));
  return byName ? byName.name : null;
}

function messageCountLabel(count) {
  return count + ' message' + (count === 1 ? '' : 's');
}

// ---- background actions (jobs) ----

function folderTotals(threads) {
  let unread = 0;
  let total = 0;
  for (const t of Array.isArray(threads) ? threads : []) {
    unread += Number(t.unread) || 0;
    total += Number(t.count) || 0;
  }
  return {unread, total};
}

// Forced move (trash/archive/spam/move). Nothing is hidden up front: the
// rows stay visible while the move runs for real through the jobs queue, and
// the folder re-renders from the local copy once the file renames land.
// Failures surface as a job error — no rollback to undo. `force` skips the
// uidBusy guard: follow-ups enqueued from inside a running save job target
// uids the save already owns (they were busy-filtered when it was created).
async function queueMove(id, name, uids, target, label, doneLabel, {force = false} = {}) {
  if (target === name) {
    el.status('Messages are already in ' + target);
    return;
  }
  const picked = uids.map(Number);
  const candidates = force ? picked : picked.filter(uid => !uidBusy(id, uid));
  if (!candidates.length) {
    return;
  }
  enqueue({
    accountId: id,
    kind: 'move',
    label,
    doneLabel,
    uids: candidates,
    run: api => api.moveTo(candidates, target)
  });
}

// ---- native "Actions" override (options > Actions) ----

// The override keys live in their own namespace (written by
// options/index.mjs) — no ui.* prefix like prefs.mjs keys.
async function actionOverride(action) {
  const key = name => 'override.' + action + '.' + name;
  const res = await chrome.storage.local.get({
    [key('enabled')]: false,
    [key('path')]: '',
    [key('delete')]: false
  });
  return res[key('enabled')] && res[key('path')]
    ? {path: String(res[key('path')]), remove: !!res[key('delete')]}
    : null;
}

// Permanent local delete of already-trashed mail: one warning, then the
// files go. The sync engine replays the removals as server purges at the
// next sync (gated by sync's own purge confirm). When `warned` is set the
// dialog has already been answered (post-save purge paths) — this is also
// the "remove originals" step of the native save override, inside the trash
// folder and out (outside it the save is the only copy that matters).
// `force` skips the uidBusy guard for those in-job follow-ups.
function queuePurge(id, uids, label, warned = false, force = false) {
  const picked = uids.map(Number);
  const candidates = force ? picked : picked.filter(uid => !uidBusy(id, uid));
  if (!candidates.length) {
    return;
  }
  if (!warned) {
    el.confirmPurge(candidates.length, label).then(ok => {
      if (ok) {
        queuePurge(id, uids, label, true);
      }
    });
    return;
  }
  enqueue({
    accountId: id,
    kind: 'purge',
    label: 'Deleting ' + messageCountLabel(candidates.length) + ' permanently',
    doneLabel: 'Deleted ' + messageCountLabel(candidates.length) + ' permanently',
    uids: candidates,
    run: api => api.purgeMessages(candidates)
  });
}

// Native save job: the raw RFC822 of every uid is written through the
// native host into the configured directory (the sandbox picks
// collision-free names). Row-level failures are tagged onto their rows;
// `finalize` decides what happens to the originals once the writes land.
function queueNativeSave(id, dir, uids, finalize) {
  const candidates = uids.map(Number).filter(uid => !uidBusy(id, uid));
  if (!candidates.length) {
    return;
  }
  enqueue({
    accountId: id,
    kind: 'save',
    label: 'Saving ' + messageCountLabel(candidates.length) + ' to disk',
    doneLabel: 'Saved ' + messageCountLabel(candidates.length) + ' to disk',
    uids: candidates,
    run: async api => {
      const files = [];
      for (const uid of candidates) {
        files.push({uid, dir, name: uid + '.eml', data: await api.readFile(uid)});
      }
      const {results} = await writeFiles(files);
      let saved = 0;
      results.forEach((result, i) => {
        if (result?.ok) {
          saved++;
        }
        else {
          el.markRowError([files[i].uid], result?.error || 'write failed');
        }
      });
      if (saved && finalize) {
        await finalize(saved, api);
      }
      if (saved < candidates.length) {
        el.status('Saved ' + messageCountLabel(saved) + ' — the rest failed', true);
      }
    }
  });
}

// The override truth for one press of trash/archive/spam: save the raw
// messages to the configured directory, then remove the originals. Inside
// the matching folder the originals are already "done" for this action, so
// the ask only offers the purge (the 'move' choice is meaningless there —
// the rows already sit in the target). Outside it the "remove originals"
// step is a purge in both forms (delete checkbox, or the post-save ask's
// Delete): the copies on disk are the keepsake, so the maildir files go now
// and the sync engine replays the removals as server purges at the next
// sync. force is required — the save job still owns these uids while its
// finalize runs inside it.
async function runOverrideAction(id, name, uids, token, override, spec) {
  const count = uids.length;
  const target = findSpecialDir(currentDirs(id), spec);
  const inTarget = target === name;
  if (inTarget) {
    queueNativeSave(id, override.path, uids, async saved => {
      if (override.remove) {
        queuePurge(id, uids, name, true, true);
      }
      else {
        const choice = await el.askAfterSave(saved, name, {move: false});
        if (choice === 'deleted') {
          queuePurge(id, uids, name, true, true);
        }
      }
    });
    return;
  }
  queueNativeSave(id, override.path, uids, async saved => {
    if (override.remove) {
      queuePurge(id, uids, name, true, true);
    }
    else {
      const choice = await el.askAfterSave(saved, spec.label, {move: !!target});
      if (choice === 'deleted') {
        queuePurge(id, uids, name, true, true);
      }
      else if (choice === 'move' && target) {
        queueMove(
          id, name, uids, target,
          `Moving ${messageCountLabel(count)} to ${target}`,
          `Moved ${messageCountLabel(count)} to ${target}`,
          {force: true}
        );
      }
    }
  });
}

// The no-override press. Outside the trash folder the action moves to it
// (default); inside it the originals are already trash, so the action
// degenerates to a purge.
async function runTrashAction(id, name, uids, token, trashDir) {
  const count = uids.length;
  if (trashDir === name) {
    await queuePurge(id, uids, trashDir);
    return;
  }
  await queueMove(
    id, name, uids, trashDir,
    `Moving ${messageCountLabel(count)} to ${trashDir}`,
    `Moved ${messageCountLabel(count)} to ${trashDir}`,
  );
}

// Flag change (mark-read/unread, star): the style toggles immediately and is
// reconciled by the folder re-render that follows the op's post-rename
// mirror-changed event. No counter prediction: the tree badges + title
// update when the reconcile runs. Quiet jobs render no bar line (auto
// mark-read on open).
function queueFlag(id, uids, addFlags, removeFlags, label, doneLabel = label, quiet = false) {
  if (!id || !Array.isArray(uids) || !uids.length) {
    return;
  }
  const list = uids.map(Number);
  el.applyFlags(list, addFlags, removeFlags);
  enqueue({
    accountId: id,
    kind: 'flags',
    label,
    doneLabel,
    quiet,
    uids: list,
    run: api => api.setFlags(list, addFlags, removeFlags),
    // only the instant style revert on failure/cancel; no counter ops
    rollback: () => el.applyFlags(list, removeFlags, addFlags)
  });
}

async function runMoveDirAction(action, id, name, uids, token) {
  const spec = MOVE_TARGETS[action];
  if (!spec) {
    return;
  }
  const override = await actionOverride(action);
  if (stale(token)) {
    return;
  }
  if (override) {
    // the override replaces the whole action: save locally, then drop the
    // originals — no local target folder is required at all
    await runOverrideAction(id, name, uids, token, override, spec);
    return;
  }
  let target = findSpecialDir(currentDirs(id), spec);
  if (!target) {
    const api = await getMailApi(id);
    if (stale(token)) {
      return;
    }
    const dirs = await api.listDirs();
    if (stale(token)) {
      return;
    }
    target = findSpecialDir(dirs, spec);
  }
  if (!target) {
    throw new Error('No ' + spec.label + ' folder found locally');
  }
  if (action === 'trash') {
    await runTrashAction(id, name, uids, token, target);
    return;
  }
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

// Threads grouped locally per folder read (threads.mjs), so paging is a pure
// slice of that list: one page holds `pageSize` conversations.
// refresh: re-reads the folder from the disk truth (no caching anywhere).
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
    el.error(e?.message || String(e));
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
// shown or nothing is selected.
function syncCurrent() {
  return sync(accountId, dirName);
}

// Run a local search over the maildir and render the (threaded) results in
// place of the folder list. scope 'all' searches every folder of the account.
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

// Star clicks cycle through the Gmail palette and back to none (the views
// hand us the color; starFlagOps turns it into flag add/remove lists —
// \Flagged always rides along, at most one $star-* keyword at a time).
function runStar(uids, color) {
  const count = Array.isArray(uids) ? uids.length : 0;
  if (!count || !(Number.isInteger(color) && color >= 0 && color < STAR_COLORS.length)) {
    return;
  }
  const {add, remove} = starFlagOps(color);
  const name = STAR_COLORS[color].name;
  queueFlag(
    accountId, uids, add, remove,
    color
      ? `Flagging ${messageCountLabel(count)} (${name})`
      : `Unflagging ${messageCountLabel(count)}`,
    color
      ? `Flagged ${messageCountLabel(count)} (${name})`
      : `Unflagged ${messageCountLabel(count)}`,
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
  el.addEventListener('refresh', async () => {
    // toolbar refresh = re-render the mails view from the disk truth only
    if (accountId && dirName) {
      load(accountId, dirName);
    }
  });
  el.addEventListener('star', e => {
    const detail = e.detail;
    if (!detail) {
      return;
    }
    // view rows send {uids, color}; the preview card forwards {uid, color}
    runStar(detail.uids ?? (detail.uid != null ? [detail.uid] : null), detail.color);
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