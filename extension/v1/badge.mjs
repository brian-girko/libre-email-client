'use strict';

// Badge counter. Reads the local mirror: every server-backed pass first
// resyncs the accounts (the SyncEngine owns the IMAP session — badge code
// never touches the server itself), then counts unread conversations from
// the mirrored folders. On worker/browser restart the icon is painted
// INSTANTLY from the mirror alone (no filters, no server round trips), so
// the count is visible with at most one OPFS read of delay; a silent
// server-backed check then refines it.
// The combined total goes on the action icon (badge text is empty when the
// count is zero); the tooltip always ends with the time of the last
// completed check so an empty badge is not mistaken for one that never ran.
//
// Per account the options page stores either a plain folder ("count unread in
// folder", the default) or a folder + search query ("count unread matching
// the query"). Both modes run a local search over the mirror and count
// conversations: each thread holding at least one unread email adds one, and
// the tooltip lists one subject per counted thread. Folder mode counts unseen
// mail that is not flagged \Deleted.
//
// An optional global age window ("badge.maxAge" minutes, 0 = off) limits the
// badge to unread mail newer than the window, applied in the thread tally.
//
// Before an account is counted, its email filters run first and the count
// runs in the same critical section (behind filters.mjs' shared mutex), so
// mail a rule is about to move or save+delete never reaches the badge count
// and no standalone filter pass can slip in between. Filter mutations run on
// the server through the engine and are mirrored right away. The pass'
// outcome is merged into the shared 'filters.last' status.
//
// The badge answer is broadcast with the per-account folder/uidnext/exists
// so an open client can sync its list in place instead of reloading. The
// '...' placeholder is shown only for user-initiated checks; periodic alarm
// checks update silently.
//
// The worker cannot prompt for passwords: an account is usable only when its
// password is available in plain form (session "user.pass.<id>" typed earlier
// this session, or a stored plain value) or encrypted with a master password
// that has been confirmed this session ("master.pass" in session storage).
// Accounts without a usable password are reported in the title and status but
// excluded from the badge total. When a saved password is encrypted and the
// master has not been confirmed this session, the icon shows a 🔑 instead of
// the (necessarily incomplete) total until the master is unlocked.
//
// The action icon itself carries three states, rendered from the transparent
// envelope in data/icons/gray.svg: red when unread mail was counted (red wins
// even if some accounts could not be checked — the tooltip names them), blue
// when mail could not be checked at all (no usable password, locked master or
// unavailable bridge), and gray when the check ran cleanly with zero unread.
// A failed check pass also falls back to blue.

import {engine, mirrorApi, setSyncDone} from './core/sync/engine.mjs';
import {resolvePassword, needsMasterPassword} from './core/creds.mjs';
import {runForBadge, setBadgeTrigger} from './filters.mjs';
import {emitActivity} from './activity.mjs';
import {setupIncomplete} from './data/setup/bridge.mjs';

const MASTER_PASS = 'master.pass';
const PASS_PREFIX = 'user.pass.';
const ALARM_NAME = 'badge.check';
const BADGE_COLOR = '#1a73e8';
const MAX_BADGE = 999;
const MAX_SUBJECTS = 10;
const DEFAULT_TITLE = 'Libre Email Client';

// State icons rendered from data/icons/gray.svg (transparent background):
// gray = zero unread, red = new mail, blue = cannot check mail (missing
// password, locked master or unavailable bridge). Sizes mirror the manifest's
// icon set so the action icon stays crisp on every scale.
const ICON_SIZES = [16, 32, 48, 64, 128, 256];
const ICON_PATHS = {
  gray: Object.fromEntries(ICON_SIZES.map(size => [size, `/data/icons/gray/${size}.png`])),
  red: Object.fromEntries(ICON_SIZES.map(size => [size, `/data/icons/red/${size}.png`])),
  blue: Object.fromEntries(ICON_SIZES.map(size => [size, `/data/icons/blue/${size}.png`]))
};

async function setIcon(state) {
  try {
    await chrome.action.setIcon({path: ICON_PATHS[state] || ICON_PATHS.gray});
  }
  catch {
    // icon may be gone while the worker shuts down
  }
}

// Debug pref (options page): when off, check-failure warnings are silent.
async function warnDebug(message, e) {
  try {
    const {'badge.debug': debug} = await chrome.storage.local.get({'badge.debug': false});
    if (debug) {
      console.warn(message, e);
    }
  }
  catch {
    // storage unreachable: stay silent
  }
}

const fieldKey = (name, id) => name + '.' + id;
// badge checks surface the reason in the sync pass the engine performs —
// same labels the engine defines (user_request, periodic, config, ...)
const SYNC_REASONS = new Set(['user_request', 'client_open', 'periodic', 'filters', 'replay', 'unlock', 'config']);
const reasonOf = r => SYNC_REASONS.has(r) ? r : (r === 'startup' ? 'config' : 'periodic');
const msg = e => e?.message || String(e);

// An age limit only counts mail whose date parses and lies within the
// window; without a limit (cutoff 0) every unread message passes. A missing
// or unparseable date maps to the epoch, so with a limit it fails the check
// and the mail is not counted.
function withinAgeWindow(date, cutoff) {
  if (!cutoff) {
    return true;
  }
  const t = new Date(date ?? null).getTime();
  return !Number.isNaN(t) && t >= cutoff;
}

// Reduce search results to one entry per conversation that holds at least
// one unread message: each thread adds one count, no matter how many of its
// emails are unread. The entry shows the first unread email's subject (falls
// back to the thread's own subject/from). When a core build omits per-message
// flags, the thread-level unread count stands in (one entry per thread), and
// the thread's newest-message date decides the age window.
function tallyThreads(threads, cap, maxAge = 0) {
  const cutoff = maxAge > 0 ? Date.now() - maxAge * 60000 : 0;
  const hits = [];
  for (const t of Array.isArray(threads) ? threads : []) {
    const msgs = Array.isArray(t.messages) && t.messages.length ? t.messages : null;
    if (msgs) {
      const unread = msgs.find(m => !(Array.isArray(m.flags) ? m.flags : []).includes('\\Seen') &&
        withinAgeWindow(m.date, cutoff));
      if (unread) {
        hits.push({subject: unread.subject || t.subject || '', from: unread.from || t.from || ''});
      }
    }
    else if ((Number(t.unread) || 0) > 0 && withinAgeWindow(t.date, cutoff)) {
      hits.push({subject: t.subject || '', from: t.from || ''});
    }
  }
  return {
    count: hits.length,
    subjects: hits.slice(0, cap),
    more: Math.max(0, hits.length - cap)
  };
}

let running = null;
let rescheduling = null;
let setup = false;

// No prediction overlay: the badge only ever shows a real result. Client
// actions re-render from the mirror through the engine's resync and then ask
// for a mirror-only recount (badge-check {silent:true}); the fresh result
// always supersedes the previous one.
// The last completed result ALSO persists in chrome.storage.local
// ('badge.last') — on browser restart it seeds the icon while the mirror
// count and the first server check run.

async function badgeConfig() {
  const res = await chrome.storage.local.get({
    'badge.enabled': true,
    'badge.idleCheck': true,
    'badge.interval': 5,
    'badge.maxAge': 0,
    accounts: []
  });
  const accounts = Array.isArray(res.accounts) ? res.accounts : [];
  return {
    enabled: res['badge.enabled'] !== false,
    idleCheck: res['badge.idleCheck'] !== false,
    interval: Math.max(1, Number(res['badge.interval']) || 5),
    maxAge: Math.max(0, Math.round(Number(res['badge.maxAge']) || 0)),
    accounts
  };
}

async function loadAccountPrefs(id) {
  const res = await chrome.storage.local.get([
    fieldKey('imap.host', id),
    fieldKey('imap.port', id),
    fieldKey('imap.secure', id),
    fieldKey('imap.allowSelfSigned', id),
    fieldKey('user.name', id),
    fieldKey('email.badgeMode', id),
    fieldKey('email.badgeFolder', id),
    fieldKey('email.badgeQuery', id)
  ]);
  const mode = res[fieldKey('email.badgeMode', id)];
  return {
    host: res[fieldKey('imap.host', id)],
    port: Number(res[fieldKey('imap.port', id)]),
    secure: res[fieldKey('imap.secure', id)] !== false,
    allowSelfSigned: !!res[fieldKey('imap.allowSelfSigned', id)],
    user: res[fieldKey('user.name', id)],
    mode: mode === 'query' ? 'query' : 'folder',
    folder: (res[fieldKey('email.badgeFolder', id)] || 'INBOX').trim() || 'INBOX',
    query: res[fieldKey('email.badgeQuery', id)] || ''
  };
}

async function checkAccount(entry, resync, reason, maxAge) {
  const id = entry.id;
  const label = entry.label || entry.id || 'Unnamed account';
  const cfg = await loadAccountPrefs(id);
  if (!cfg.host || !cfg.port || !cfg.user) {
    return {id, label, count: 0, detail: 'not configured', error: true};
  }
  const pass = await resolvePassword(id);
  if (!pass) {
    // A locked master password gets its own signal on the icon (🔑): the
    // saved password exists, only this session's master confirmation is
    // missing, so the count for the account is unknown.
    const needsMaster = await needsMasterPassword(id);
    return {
      id, label, count: 0,
      detail: needsMaster ? 'needs master password' : 'no password available — sign in once from the client',
      error: true,
      needsMaster
    };
  }
  let api = null;
  try {
    // Filters → mirror sync → count, all inside runForBadge's shared mutex:
    // the filter pass acts directly on the server (no mirror involvement),
    // the engine then ingests the post-filter state into the mirror, and the
    // count reads the mirrored folder — so mail a rule moved can never reach
    // the count and no standalone pass can slip in between.
    api = await mirrorApi(id);
    const query = cfg.mode === 'query' && cfg.query.trim() ? cfg.query.trim() : null;
    let status = null;
    const {entry: filterEntry, counted} = await runForBadge({
      accountId: id,
      label,
      resync,
      reason,
      count: async () => {
        status = await api.openDir(cfg.folder);
        // Count conversations instead of trusting a SELECT UNSEEN number or
        // thread-level unread sums: the search returns per-message flags, so
        // each thread with unread mail adds exactly one and the title lists
        // one subject per counted thread. Folder mode skips mail flagged
        // \Deleted but not yet expunged.
        try {
          const threads = await api.search({
            dir: cfg.folder,
            query: query || 'is:unseen not:is:deleted'
          });
          return tallyThreads(threads, MAX_SUBJECTS, maxAge);
        }
        catch (e) {
          // Query mode needs real search; folder mode falls back to the
          // coarse SELECT-derived unseen number (no subject list, no dates).
          if (query || status.unseen == null) {
            throw e;
          }
          return {count: Number(status.unseen) || 0, subjects: [], more: 0};
        }
      }
    });
    let filterNote = '';
    if (filterEntry && (filterEntry.moved || filterEntry.deleted)) {
      filterNote = ' · filters: ' + filterEntry.moved + ' moved' +
        (filterEntry.deleted ? ', ' + filterEntry.deleted + ' deleted' : '');
    }
    else if (filterEntry && filterEntry.errors.length) {
      filterNote = ' · filters: ' + filterEntry.errors[0];
    }
    let detail = query ? 'query: ' + query : cfg.folder;
    if (filterNote) {
      detail += filterNote;
    }
    const {count = 0, subjects = [], more = 0} = counted || {};
    return {
      id, label, count, detail, subjects, more, error: false,
      folder: cfg.folder,
      uidnext: status ? Number(status.uidnext) || 0 : null,
      exists: status ? Number(status.exists) || 0 : null
    };
  }
  finally {
    if (api) {
      try {
        await api.close();
      }
      catch {
        // the session may already be gone
      }
    }
  }
}

// Mirror-only count for one account: reads the local clone only — no filter
// pass, no sync, no server contact, no password check. Used to paint the
// badge instantly on restart and for the silent post-action recount (the
// mirror is already up to date there: the engine resyncs right after every
// completed op). Same result shape as checkAccount().
async function countFromMirror(entry, maxAge) {
  const id = entry.id;
  const label = entry.label || entry.id || 'Unnamed account';
  const cfg = await loadAccountPrefs(id);
  if (!cfg.host || !cfg.port || !cfg.user) {
    throw new Error('not configured');
  }
  const api = await mirrorApi(id);
  try {
    const query = cfg.mode === 'query' && cfg.query.trim() ? cfg.query.trim() : null;
    const status = await api.openDir(cfg.folder);
    try {
      const threads = await api.search({
        dir: cfg.folder,
        query: query || 'is:unseen not:is:deleted'
      });
      const {count, subjects, more} = tallyThreads(threads, MAX_SUBJECTS, maxAge);
      const detail = query ? 'query: ' + query : cfg.folder;
      return {
        id, label, count, detail, subjects, more, error: false,
        folder: cfg.folder,
        uidnext: Number(status.uidnext) || 0,
        exists: Number(status.exists) || 0
      };
    }
    catch (e) {
      if (query || status.unseen == null) {
        throw e;
      }
      return {
        id, label,
        count: Number(status.unseen) || 0,
        detail: cfg.folder, subjects: [], more: 0, error: false,
        folder: cfg.folder,
        uidnext: Number(status.uidnext) || 0,
        exists: Number(status.exists) || 0
      };
    }
  }
  finally {
    try {
      await api.close();
    }
    catch {}
  }
}

// Count every badge-enabled account from the stored local copy. Returns null
// when the counter is disabled or nothing countable exists (no accounts /
// configuration), or a completed result — per-account failures land as error
// rows exactly like a server-backed check.
async function recountFromMirror() {
  const cfg = await badgeConfig();
  const result = {time: Date.now(), enabled: cfg.enabled, total: 0, accounts: []};
  if (!cfg.enabled) {
    return null;
  }
  const ids = cfg.accounts.map(a => a.id);
  const badgeKeys = ids.map(id => fieldKey('email.badge', id));
  const badges = badgeKeys.length ? await chrome.storage.local.get(badgeKeys) : {};
  const included = cfg.accounts.filter(a => badges[fieldKey('email.badge', a.id)] !== false);
  if (!included.length) {
    return null;
  }
  for (const entry of included) {
    try {
      result.accounts.push(await countFromMirror(entry, cfg.maxAge));
    }
    catch (e) {
      result.accounts.push({
        id: entry.id,
        label: entry.label || entry.id || 'Unnamed account',
        count: 0,
        detail: 'failed: ' + msg(e),
        error: true
      });
    }
  }
  result.total = result.accounts.reduce((sum, a) => sum + (Number(a.count) || 0), 0);
  return result;
}

// Paint the icon from the local copy with no server round trip: a fresh
// mirror recount wins; when every account failed to read (no mirror yet) the
// stored last result stands in. Returns the applied result or null.
async function recountFromLocalCopy() {
  const local = await recountFromMirror();
  const usable = local && local.accounts.some(a => !a.error);
  const result = usable
    ? local
    : ((await chrome.storage.local.get('badge.last').catch(() => ({})))?.['badge.last'] || null);
  if (!result) {
    return null;
  }
  await storeResult(result);
  await updateBadge(result);
  return result;
}

function cut(text, max) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function subjectLine(s) {
  return s.subject ? cut(s.subject, 60) : '(no subject)';
}

function syncStamp(time) {
  const d = new Date(time);
  if (Number.isNaN(d.getTime())) {
    return '';
  }
  const sameDay = d.toDateString() === new Date().toDateString();
  return 'Last synced ' + (sameDay ? d.toLocaleTimeString() : d.toLocaleString());
}

function composeTitle(result) {
  if (!result) {
    return DEFAULT_TITLE;
  }
  const rows = result.accounts || [];
  const errors = rows.filter(a => a.error);
  const counts = rows.filter(a => !a.error && a.count > 0);
  const locked = rows.filter(a => a.needsMaster);
  const fragments = [];
  for (const a of counts) {
    fragments.push(a.label + ': ' + a.count + (a.detail ? ' (' + a.detail + ')' : ''));
    for (const s of (a.subjects || [])) {
      fragments.push(subjectLine(s));
    }
    if (a.more > 0) {
      fragments.push('… +' + a.more + ' more');
    }
  }
  for (const a of errors) {
    fragments.push(a.label + ': ' + a.detail);
  }
  const head = locked.length
    ? DEFAULT_TITLE + ' — 🔑 master password needed'
    : result.total
      ? DEFAULT_TITLE + ' — ' + result.total + ' new'
      : DEFAULT_TITLE;
  const lines = [head, ...fragments];
  // Always report when the counter last synced — even with zero unread mail —
  // so an empty badge is distinguishable from a counter that never ran. Only
  // while the counter is enabled; older stored results without the flag are
  // treated as enabled.
  if (result.enabled !== false) {
    const stamp = syncStamp(result.time);
    if (stamp) {
      lines.push(stamp);
    }
  }
  return lines.join('\n');
}

// Icon state for the last completed check: red wins whenever any unread mail
// was counted (the tooltip already names the accounts that could not be
// checked), blue signals accounts that could not contribute because no usable
// password is available (missing password or locked master), or when the IMAP
// bridge itself is down, and gray means zero unread mail with everything
// checked. Gray is only honest when something was actually checked — with no
// accounts at all there is nothing behind the "all good" claim, so blue
// (nothing could be checked) is the right color.
function iconState(result) {
  if (!result) {
    return 'blue';
  }
  if (result.total > 0) {
    return 'red';
  }
  const rows = Array.isArray(result.accounts) ? result.accounts : [];
  // no badge-enabled account existed when this result was built
  if (!rows.length) {
    return 'blue';
  }
  const unchecked = rows.some(a => a.error);
  return unchecked ? 'blue' : 'gray';
}

async function updateBadge(result) {
  // Setup still unfinished (no bridge to any mail server): the icon stays
  // blue — the "cannot check mail" state. Without this guard the check would
  // paint gray ("zero unread, all good"), which is a lie when there is no
  // account that could ever be checked. The setup gate (data/setup/bridge.mjs)
  // owns the truth; once it passes, the normal state colors take over.
  if (await setupIncomplete()) {
    await setIcon('blue');
    return;
  }
  // Any badge-enabled account locked behind an unconfirmed master password
  // replaces the (necessarily incomplete) count with a key: the total would
  // silently miss that account. Confirming the master re-runs the check via
  // the storage listener, so the key yields to the real count at once.
  const locked = !!(result && Array.isArray(result.accounts) &&
    result.accounts.some(a => a.needsMaster));
  const total = Math.max(0, Math.round(Number(result?.total) || 0));
  const text = locked
    ? '🔑'
    : (total ? (total > MAX_BADGE ? '999+' : String(total)) : '');
  await chrome.action.setBadgeText({text});
  if (locked || total) {
    await chrome.action.setBadgeBackgroundColor({color: BADGE_COLOR});
  }
  await setIcon(iconState({...result, total}));
  await chrome.action.setTitle({title: composeTitle(result)});
}

async function storeResult(result) {
  try {
    // local persistence: the stored result also seeds the icon after a
    // browser restart (storage.session would not survive one)
    await chrome.storage.local.set({'badge.last': result});
  }
  catch {
    // the worker may be shutting down; the alarm re-runs the check
  }
}

async function doCheck(resync = true, reason = 'periodic') {
  const cfg = await badgeConfig();
  const result = {time: Date.now(), enabled: cfg.enabled, total: 0, accounts: []};
  if (!cfg.enabled) {
    await storeResult(result);
    await updateBadge(result);
    return result;
  }
  const ids = cfg.accounts.map(a => a.id);
  const badgeKeys = ids.map(id => fieldKey('email.badge', id));
  const badges = badgeKeys.length ? await chrome.storage.local.get(badgeKeys) : {};
  const included = cfg.accounts.filter(a => badges[fieldKey('email.badge', a.id)] !== false);
  if (!included.length) {
    await storeResult(result);
    await updateBadge(result);
    return result;
  }
  for (const entry of included) {
    try {
      result.accounts.push(await checkAccount(entry, resync, reason, cfg.maxAge));
    }
    catch (e) {
      // connection/bridge/credential errors land here: an unsynced mirror
      // still yields a reliable count when one exists, so the failure row
      // keeps the icon blue without erasing local knowledge
      result.accounts.push({
        id: entry.id,
        label: entry.label || entry.id || 'Unnamed account',
        count: 0,
        detail: 'failed: ' + msg(e),
        error: true
      });
    }
  }
  result.total = result.accounts.reduce((sum, a) => sum + (Number(a.count) || 0), 0);
  await storeResult(result);
  await updateBadge(result);
  return result;
}

// resync: request a server pull before counting (default true). The client's
// post-action recount does not come through here at all anymore — it counts
// the local copy directly (recountFromLocalCopy) with no server contact.
function runCheck({indicator = false, resync = true, reason} = {}) {
  const why = reasonOf(reason ?? (indicator ? 'user_request' : 'periodic'));
  // Only user-initiated checks (and the first one after startup) flash the
  // '...' placeholder; periodic alarm checks update silently.
  if (indicator) {
    showCheckIndicator().catch(() => {});
  }
  if (running) {
    return running;
  }
  // The activity broadcast logs nothing in the client; the end payload lets an
  // open client sync its list in place via accounts[].uidnext/exists.
  emitActivity({source: 'badge', phase: 'start', indicator});
  running = doCheck(resync, why).then(result => {
    emitActivity({source: 'badge', phase: 'end', result});
    return result;
  }).catch(async e => {
    warnDebug('[badge] check failed', e);
    emitActivity({source: 'badge', phase: 'error', error: msg(e)});
    try {
      // a failed pass must not leave the '...' indicator stuck on the icon,
      // and it must not erase the last known count either: the stored local
      // copy still answers (mirror truth), so it is repainted; the bare
      // blue icon only applies when nothing was ever counted
      const stored = (await chrome.storage.local.get('badge.last').catch(() => ({})))?.['badge.last'];
      if (stored) {
        await updateBadge(stored);
      }
      else {
        await chrome.action.setBadgeText({text: ''});
        await setIcon('blue');
      }
    }
    catch {
      // icon may be gone while the worker shuts down
    }
    throw e;
  }).finally(() => {
    running = null;
    // a pass that could not sync anything (offline, no credentials, disabled
    // mid-run) must not starve the periodic trigger: revive the alarm chain
    armIfUnscheduled();
  });
  return running;
}

// After a filter pass moved or deleted mail the badge is stale-high; the
// filters orchestrator calls back into runCheck (single-flight, so it
// coalesces with any check already in flight).
setBadgeTrigger(runCheck);

async function showCheckIndicator() {
  await chrome.action.setBadgeText({text: '...'});
  await chrome.action.setBadgeBackgroundColor({color: BADGE_COLOR});
}

// The periodic alarm is a one-shot that is re-armed after every COMPLETED
// sync (manual ones included — the engine fires the setSyncDone hook, which
// this module registers at the bottom). The next periodic check therefore
// falls exactly `interval` minutes after the most recent server→mirror sync,
// no matter whether that sync was manual or periodic. After a check that
// could not sync anything (offline, no credentials) the alarm is re-armed
// from "now" in the check's finally block, which keeps the retry cadence.
async function armAlarm(interval, anchorMs = Date.now()) {
  try {
    await chrome.alarms.clear(ALARM_NAME);
  }
  catch {
    // alarms permission missing: fall back to one-shot checks
  }
  const when = Math.round(anchorMs) + Math.max(1, interval) * 60000;
  try {
    await chrome.alarms.create(ALARM_NAME, {when: Math.max(Date.now() + 500, when)});
  }
  catch {
    // no alarms permission: periodic re-checks need the manual trigger
  }
}

// Called from runCheck's finally: revive the alarm chain when the completed
// pass did not land a new sync (failure, badge off mid-run, …) so the
// periodic trigger never dies.
async function armIfUnscheduled() {
  try {
    const cfg = await badgeConfig();
    if (!cfg.enabled) {
      return;
    }
    const existing = (await chrome.alarms.get(ALARM_NAME).catch(() => null));
    if (!existing) {
      await chrome.alarms.create(ALARM_NAME, {when: Date.now() + cfg.interval * 60000});
    }
  }
  catch {
    /* best-effort */
  }
}

async function rescheduleAlarm() {
  try {
    const cfg = await badgeConfig();
    if (cfg.enabled) {
      await armAlarm(cfg.interval);
    }
  }
  catch {
    /* storage hiccup: the next completed sync re-arms */
  }
}

// Every sync the engine completes (badge check, client open, user request,
// filter pass, outbox replay, post-op dir resync) resets the periodic
// countdown: interval minutes after the LAST sync, whichever kind it was.
setSyncDone(() => {
  rescheduleAlarm();
});

// Arm the one-shot periodic alarm (interval minutes after the anchor); with
// an interval of 0 the alarm just drops (badge off).
async function schedule(interval, anchorMs = Date.now()) {
  if (!interval) {
    try {
      await chrome.alarms.clear(ALARM_NAME);
    }
    catch {
      // alarms permission missing: fall back to one-shot checks
    }
    return;
  }
  await armAlarm(interval, anchorMs);
}

function relevantKeys(changes) {
  return Object.keys(changes).some(k =>
    k === 'badge.enabled' ||
    k === 'badge.idleCheck' ||
    k === 'badge.interval' ||
    k === 'badge.maxAge' ||
    k === 'accounts' ||
    k === 'filters' ||
    k.startsWith('email.badge.') ||
    k.startsWith('email.badgeMode.') ||
    k.startsWith('email.badgeFolder.') ||
    k.startsWith('email.badgeQuery.') ||
    k.startsWith(PASS_PREFIX) ||
    k === MASTER_PASS
  );
}

function reschedule() {
  if (rescheduling) {
    return rescheduling;
  }
  rescheduling = badgeConfig()
    .then(cfg => schedule(cfg.enabled ? cfg.interval : 0))
    .catch(() => {})
    .finally(() => {
      rescheduling = null;
    });
  return rescheduling;
}

async function onStartup() {
  const cfg = await badgeConfig();
  // the periodic countdown anchors at the last persisted sync, not at the
  // restart moment — the time the browser was closed still counts off
  let anchor = 0;
  try {
    const sync = (await chrome.storage.local.get('mirror.lastSynced'))?.['mirror.lastSynced'] ?? {};
    anchor = Math.max(0, ...Object.values(sync).map(t => Number(t) || 0));
  }
  catch {}
  await schedule(cfg.enabled ? cfg.interval : 0, anchor);
  if (cfg.enabled) {
    // instant paint from the stored local copy (mirror recount, falling back
    // to the persisted 'badge.last'), then a silent server-backed pass
    try {
      await recountFromLocalCopy();
    }
    catch (e) {
      warnDebug('[badge] mirror recount failed', e);
    }
    runCheck({indicator: false, reason: 'config'}).catch(e => warnDebug('[badge] initial check failed', e));
  }
}

// Reflect saved settings immediately: re-schedule the alarm (also dropping it
// when the badge is turned off) and run a check so the icon settles without
// waiting for the next tick. Config changes of any kind, account edits and
// session password entry all land here.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' && area !== 'session') {
    return;
  }
  if (!relevantKeys(changes)) {
    return;
  }
  reschedule();
  runCheck({indicator: true, reason: 'config'}).catch(e => warnDebug('[badge] check failed', e));
});

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === ALARM_NAME) {
    runCheck({reason: 'periodic'}).catch(e => warnDebug('[badge] check failed', e));
  }
});

// Idle-wake trigger, beside the periodic alarm: whenever the machine turns
// active again ("active" covers waking from idle, screen unlock and system
// resume), run one silent badge check so the icon is fresh the moment the
// user returns. Closed when the pref or the badge counter is disabled; the
// runCheck() single-flight coalesces this with any check already in flight.
if (chrome.idle?.onStateChanged) {
  chrome.idle.onStateChanged.addListener(state => {
    if (state !== 'active') {
      return;
    }
    badgeConfig()
      .then(cfg => {
        if (cfg.enabled && cfg.idleCheck) {
          runCheck({reason: 'periodic'}).catch(e => warnDebug('[badge] idle check failed', e));
        }
      })
      .catch(e => warnDebug('[badge] idle check failed', e));
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'badge-check') {
    if (message.silent) {
      // Post-action recount: count the stored local copy only — the engine
      // already resynced after the action completed, so no filter pass,
      // no sync, no server round trip here. Updates icon, tooltip, favicon
      // payload and the persisted last result.
      recountFromLocalCopy()
        .then(result => sendResponse({ok: true, result}))
        .catch(e => sendResponse({ok: false, error: msg(e)}));
      return true;
    }
    // Explicit refreshes (options "Check now", context menu) flash '...'
    // AND resync from the server.
    runCheck({indicator: true, reason: 'user_request'})
      .then(result => sendResponse({ok: true, result}))
      .catch(e => sendResponse({ok: false, error: msg(e)}));
    return true; // keep the channel open for the async response
  }
  return;
});

// Direct entry point for the worker's own UI (action-button context menu):
// chrome.runtime.sendMessage from the service worker is not delivered to its
// own onMessage listener, so the menu handler calls this instead. Always
// flashes the '...' indicator, like the options page's "Check now".
async function checkNow() {
  try {
    return {ok: true, result: await runCheck({indicator: true, reason: 'user_request'})};
  }
  catch (e) {
    return {ok: false, error: msg(e)};
  }
}

if (!setup) {
  setup = true;
  chrome.runtime.onInstalled.addListener(onStartup);
  chrome.runtime.onStartup.addListener(onStartup);
}

export {checkNow};