'use strict';

// Badge counter. Runs in the service worker and periodically asks every
// badge-enabled account for unread mail, then shows the combined total on the
// action icon (badge text is empty when the count is zero). The tooltip always
// ends with the time of the last completed sync — even with zero unread mail —
// so an empty badge is not mistaken for a counter that never ran.
//
// Per account the options page stores either a plain folder ("count unread in
// folder", the default) or a folder + IMAP search query ("count unread
// matching the query"). Both modes run a server-side IMAP SEARCH and count
// conversations: each thread holding at least one unread email adds one, and
// the tooltip lists one subject per counted thread. Folder mode counts unseen
// mail that is not flagged \Deleted; if the wasm build lacks search support
// the folder count falls back to the server's SELECT UNSEEN value.
//
// An optional global age window ("badge.maxAge" minutes, 0 = off) limits the
// badge to unread mail newer than the window. It is applied client-side in
// the thread tally (IMAP SINCE is day-granular and YOUNGER is not portable);
// the coarse SELECT UNSEEN fallback carries no dates and ignores the window.
// The count is always of *unread* mail, and the check rides short-lived IMAP
// sessions so it never fights the mail client.
//
// Before an account is counted, its email filters run first and the count
// runs in the same critical section (same session, behind filters.mjs' shared
// mutex), so mail a rule is about to move or save+delete never reaches the
// badge count and no standalone filter pass can slip in between. The pass'
// outcome is merged into the shared 'filters.last' status. Afterwards the
// shared persistent cache is warmed (dirs + threads tiers, CacheStorage) so
// the mail client's next load renders from cache instead of refetching.
//
// When the check finishes it broadcasts the per-account folder/uidnext/exists
// over runtime messaging so an open client can sync its list in place instead
// of reloading. The '...' placeholder is shown only for user-initiated checks
// (and the first check after startup); periodic alarm checks update silently.
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

import {createMailApi} from './core/rust-imap-client/api.mjs';
import {request as bridgeRequest, release as bridgeRelease} from './core/ws-to-tls/manager.js';
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

// Client-side counter predictions (counters.mjs in the mail client) stream in
// via 'badge-predict' messages so the toolbar icon ticks the same instant a
// mark-read or move is applied optimistically. Overlay is volatile in-memory
// and covers at most until the real check converges (the ~1s debounced
// recount after any unread-affecting action); storeResult() clears it because
// a fresh result always supersedes every pending prediction.
const predictedOffset = new Map(); // accountId -> pending badge delta
let lastResult = null;

function predictedTotal(result) {
  let sum = 0;
  for (const v of predictedOffset.values()) {
    sum += Number(v) || 0;
  }
  return Math.max(0, Math.round((Number(result?.total) || 0) + sum));
}

async function badgeConfig() {
  const res = await chrome.storage.local.get({
    'badge.enabled': true,
    'badge.interval': 5,
    'badge.maxAge': 0,
    accounts: []
  });
  const accounts = Array.isArray(res.accounts) ? res.accounts : [];
  return {
    enabled: res['badge.enabled'] !== false,
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

async function checkAccount(entry, bridgeUrl, cachePolicy, debug, maxAge) {
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
    api = await createMailApi({
      bridgeUrl,
      wasmUrl: chrome.runtime.getURL('core/rust-imap-client/mail_core_bg.wasm'),
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
      allowSelfSigned: cfg.allowSelfSigned,
      user: cfg.user,
      pass,
      accountId: id,
      cachePolicy,
      debug
    });
    await api.connect();
    const query = cfg.mode === 'query' && cfg.query.trim() ? cfg.query.trim() : null;
    // Filters and the unread count run in one critical section inside
    // runForBadge: no standalone filter pass can move mail between "filters
    // applied" and "mail counted", so the badge never counts mail a rule is
    // about to move. `status` is filled by the count callback below.
    let status = null;
    const {entry: filterEntry, counted} = await runForBadge({
      api,
      accountId: id,
      label,
      count: async () => {
        status = await api.openDir(cfg.folder);
        // Count conversations instead of trusting the server's SELECT
        // UNSEEN number or thread-level unread sums: the search returns
        // per-message flags, so each thread with unread mail adds exactly
        // one and the title lists one subject per counted thread. Folder
        // mode skips mail flagged \Deleted but not yet expunged.
        try {
          const threads = await api.search({
            dir: cfg.folder,
            query: query || 'is:unseen not:is:deleted'
          });
          return tallyThreads(threads, MAX_SUBJECTS, maxAge);
        }
        catch (e) {
          // Core builds without search support: plain folder mode falls
          // back to the coarse SELECT UNSEEN number (no subject list and no
          // per-message dates, so the age window cannot apply here).
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
    // Warm the shared persistent cache (dirs + threads tiers, CacheStorage)
    // so the mail client's next load renders from cache instead of
    // refetching. Best-effort: core builds without threading simply skip
    // the threads tier, and the thread entries were evicted by any filter
    // move above, so what lands here is the post-filter state.
    try {
      await api.listDirs();
    }
    catch {}
    try {
      await api.listThreads();
    }
    catch {}
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
  const total = predictedTotal(result);
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
  // A fresh real result supersedes every pending prediction, overlay resets.
  predictedOffset.clear();
  lastResult = result;
  try {
    await chrome.storage.session.set({'badge.last': result});
  }
  catch {
    // the worker may be shutting down; the alarm re-runs the check
  }
}

async function doCheck() {
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
  const {'ui.cachePolicy': cachePolicy, 'mail.debug': debug} = await chrome.storage.local.get({
    'ui.cachePolicy': 'epoch',
    'mail.debug': false
  });
  let bridgeUrl = null;
  try {
    bridgeUrl = await bridgeRequest();
  }
  catch (e) {
    const bridgeless = {id: '', label: 'IMAP bridge', count: 0, detail: 'unavailable: ' + msg(e), error: true};
    result.accounts.push(bridgeless);
    await storeResult(result);
    await updateBadge(result);
    return result;
  }
  if (!bridgeUrl) {
    const bridgeless = {id: '', label: 'IMAP bridge', count: 0, detail: 'not configured', error: true};
    result.accounts.push(bridgeless);
    await storeResult(result);
    await updateBadge(result);
    return result;
  }  try {
    for (const entry of included) {
      try {
        result.accounts.push(await checkAccount(entry, bridgeUrl, cachePolicy, !!debug, cfg.maxAge));
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
  }
  finally {
    try {
      await bridgeRelease();
    }
    catch {
      // the bridge may already be gone
    }
  }
  result.total = result.accounts.reduce((sum, a) => sum + (Number(a.count) || 0), 0);
  await storeResult(result);
  await updateBadge(result);
  return result;
}

function runCheck({indicator = false} = {}) {
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
  running = doCheck().then(result => {
    emitActivity({source: 'badge', phase: 'end', result});
    return result;
  }).catch(async e => {
    warnDebug('[badge] check failed', e);
    emitActivity({source: 'badge', phase: 'error', error: msg(e)});
    try {
      // a failed pass must not leave the '...' indicator stuck on the icon;
      // blue because the state is now unknown / mail could not be checked
      await chrome.action.setBadgeText({text: ''});
      await setIcon('blue');
    }
    catch {
      // icon may be gone while the worker shuts down
    }
    throw e;
  }).finally(() => {
    running = null;
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

async function schedule(interval) {
  try {
    await chrome.alarms.clear(ALARM_NAME);
  }
  catch {
    // alarms permission missing: fall back to one-shot checks
  }
  if (interval > 0) {
    try {
      await chrome.alarms.create(ALARM_NAME, {periodInMinutes: interval});
    }
    catch {
      // no alarms permission: periodic re-checks need the manual trigger
    }
  }
}

function relevantKeys(changes) {
  return Object.keys(changes).some(k =>
    k === 'badge.enabled' ||
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
  await schedule(cfg.enabled ? cfg.interval : 0);
  if (cfg.enabled) {
    runCheck({indicator: true}).catch(e => warnDebug('[badge] initial check failed', e));
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
  runCheck({indicator: true}).catch(e => warnDebug('[badge] check failed', e));
});

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === ALARM_NAME) {
    runCheck().catch(e => warnDebug('[badge] check failed', e));
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'badge-predict') {
    const delta = Math.round(Number(message.delta)) || 0;
    if (message.accountId && delta) {
      predictedOffset.set(
        message.accountId,
        (predictedOffset.get(message.accountId) || 0) + delta
      );
      updateBadge(lastResult).catch(() => {});
    }
    return;
  }
  if (message?.type !== 'badge-check') {
    return;
  }
  // Explicit refreshes (options "Check now", context menu) flash '...'; the
  // client's post-action recount passes silent: true and updates quietly.
  runCheck({indicator: !message.silent})
    .then(result => sendResponse({ok: true, result}))
    .catch(e => sendResponse({ok: false, error: msg(e)}));
  return true; // keep the channel open for the async response
});

// Direct entry point for the worker's own UI (action-button context menu):
// chrome.runtime.sendMessage from the service worker is not delivered to its
// own onMessage listener, so the menu handler calls this instead. Always
// flashes the '...' indicator, like the options page's "Check now".
async function checkNow() {
  try {
    return {ok: true, result: await runCheck({indicator: true})};
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