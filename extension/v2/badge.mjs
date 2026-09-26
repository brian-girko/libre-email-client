// badge.mjs — badge driver on the service worker.
//
// The badge shows unread counts read from the LOCAL maildir; the counting
// itself runs in the shared offscreen document (data/badge/offscreen.mjs),
// because only a page-like context can touch the granted directory handle.
// This module carries the worker parts:
//
//   selection   — everything the options page already saves: the global
//                 badge settings plus the per-account fields
//                 (email.badge / email.badgeMode / email.badgeFolder /
//                 email.badgeQuery), read fresh per check; account slugs
//                 come from the sync registry (loadAccounts with
//                 decrypt:false — badge jobs never carry server creds).
//                 Each account's sync.lastSyncAt.<id> stamp rides in the
//                 job too, so the tooltip can always show "last synced"
//                 per account (the offscreen document has no storage).
//   triggers    — 'sync-dirty-report' (client-side local edits; the same
//                 messages dirty.mjs consumes, so a burst of file renames =
//                 ONE check after the 3 s coalesce window), 'sync-refresh'
//                 (the engine's routine finish-of-run broadcast; a landed
//                 sync's own file writes never report themselves, so finished
//                 server truth is the moment to recount), and the options
//                 page's manual {type:'badge-check'} ("Check now").
//   dispatch    — acquire the shared offscreen, run the job, stamp
//                 chrome.storage.local['badge.last'] (the options status
//                 line renders it live via storage.onChanged).
//   badge write — chrome.action.setBadge{Text,BackgroundColor,Title}; 0 or
//                 disabled clears the badge. The tooltip always lists every
//                 account's last-sync time first, then the subjects of the
//                 unread mail that contributes to the count. The toolbar
//                 icon follows the count: red when unread mail is pending,
//                 gray at a real zero, default blue when no Maildir could
//                 be checked.

'use strict';

import {ensure} from '/core/offscreen.mjs';
import {loadAccounts} from '/data/sync/client/accounts.mjs';
import {runAllAccounts} from '/sync-scheduler.mjs';

const COALESCE_MS = 3000;   // an edit burst → one check, not one per rename

// the Check-now sync+count whole-op budget: the sync sweep enqueues into
// the engine's serial queue, this poll waits for the queue to empty
const DRAIN_POLL_MS = 1000;
const DRAIN_CAP_MS = 15 * 60 * 1000;

// the tooltip's subject list: subjects of the mails that contribute to the
// count, capped with one "+N more" line (Chrome truncates huge titles)
const MAX_SUBJECTS = 20;
const SUBJECT_CUT = 80;

const ICON_PATHS = {
  blue: {}, gray: {}, red: {}
};
for (const color of ['blue', 'gray', 'red']) {
  for (const size of [16, 32, 48, 64, 128, 256, 512]) {
    ICON_PATHS[color][size] = `/data/icons/${color}/${size}.png`;
  }
}

let timer = null;
let chain = Promise.resolve();   // checks never run concurrently

// ---------------------------------------------------------------- job build

async function buildJob() {
  const storage = await chrome.storage.local.get(null);
  if (storage['badge.enabled'] === false) {
    return null;   // badge turned off: nothing runs, the icon stays clear
  }
  const registry = await loadAccounts(null, {decrypt: false});
  const accounts = [];
  for (const acc of registry) {
    if (storage['email.badge.' + acc.id] === false) {
      continue;   // per-account opt-out (the options checkbox is default-on)
    }
    const folder = String(storage['email.badgeFolder.' + acc.id] ?? '').trim();
    const mode = storage['email.badgeMode.' + acc.id] === 'query' ? 'query' : 'folder';
    const query = String(storage['email.badgeQuery.' + acc.id] ?? '').trim();
    accounts.push({
      id: acc.id,
      label: acc.name,
      slug: acc.slug,
      mode,
      // folder '' = the engine-side INBOX default (the badge's default scope)
      folder: mode === 'folder' ? folder : '',
      query: mode === 'query' ? query : '',
      // the tooltip's "last synced" line reads the same stamp the client's
      // status line shows (worker-stamped on 'sync-synced', ISO or null)
      lastSyncAt: storage['sync.lastSyncAt.' + acc.id] ?? null
    });
  }
  if (!accounts.length) {
    console.log('[badge] no account to count: ' +
      (registry.length
        ? 'every registry account is badge-disabled or half-configured'
        : 'the account registry is empty or no account is fully configured'));
    return null;
  }
  const maxAge = Math.max(0, Math.round(Number(storage['badge.maxAge']) || 0));
  return {
    type: 'badge-job',
    id: 'badge-' + Date.now(),
    accounts,
    maxAge
  };
}

// ---------------------------------------------------------------- dispatch

/** the badge-enabled account ids — the Check-now sweep syncs exactly the
 *  accounts the count reads (one source of truth with buildJob) */
async function badgeAccountIds() {
  const storage = await chrome.storage.local.get(null);
  if (storage['badge.enabled'] === false) {
    return [];
  }
  const registry = await loadAccounts(null, {decrypt: false}).catch(() => []);
  return registry
    .filter(acc => storage['email.badge.' + acc.id] !== false)
    .map(acc => acc.id);
}

/**
 * The sweep only ENQUEUES jobs — wait for the engine's serial queue to
 * finish so the count below reflects server truth (and a settled run's
 * file writes have broadcast 'sync-refresh', touching the recount).
 */
async function waitDrain() {
  const t0 = Date.now();
  let grace = 2;   // a just-closed doc gets a couple of re-checks
  while (Date.now() - t0 < DRAIN_CAP_MS) {
    let items = null;
    try {
      const res = await chrome.runtime.sendMessage({type: 'sync-ui-init'});
      items = Array.isArray(res?.items) ? res.items : null;
    }
    catch {
      items = null;   // no engine document (or it just died)
    }
    if (items && items.length) {
      grace = 2;
    }
    else {
      if (items === null) {
        if (grace-- <= 0) {
          return;   // document gone for good — beyond rescue here
        }
      }
      else {
        return;   // queue empty with a live engine doc
      }
    }
    await new Promise(resolve => setTimeout(resolve, DRAIN_POLL_MS));
  }
  console.log('[badge] drain cap hit after ' +
    (Date.now() - t0) / 1000 + 's — counting anyway');
}

async function runCheck() {
  const job = await buildJob();
  if (!job) {
    await clearBadge();
    setIcon('blue');
    return null;
  }
  await ensure('badge');
  const result = await chrome.runtime.sendMessage(job);
  if (!result || typeof result.total !== 'number') {
    throw new Error(result && result.error ? String(result.error) : 'the badge document answered nothing');
  }
  await chrome.storage.local
    .set({['badge.last']: result})
    .catch(() => {});
  applyBadge(result);
  return result;
}

const BADGE_COLOR = '#1a73e8';

function setIcon(color) {
  return chrome.action.setIcon({path: ICON_PATHS[color]}).catch(() => {});
}

function clearBadge() {
  return chrome.action.setBadgeText({text: ''}).catch(() => {});
}

/** the always-present first lines: "label: last synced <time>" per account
 *  (the stamp every sync stamps, never absent from the tooltip) */
function lastSyncLines(result) {
  const lines = [];
  for (const a of result?.accounts ?? []) {
    const t = Date.parse(a.lastSyncAt ?? '');
    lines.push((a.label || a.id) + ': last synced ' +
      (Number.isFinite(t)
        ? new Date(t).toLocaleString()
        : 'never'));
  }
  return lines;
}

/** one subject per counted unread mail, collapsed flat across accounts.
 *  The offscreen ranks entries as plain subject strings */
function subjectLines(result) {
  const lines = [];
  let more = 0;
  for (const a of result?.accounts ?? []) {
    for (const s of (a.subjects || [])) {
      if (lines.length >= MAX_SUBJECTS) {
        break;   // account shape stays per-account; the cap is global
      }
      const s2 = String(s ?? '').replace(/\s+/g, ' ').trim();
      lines.push(!s2
        ? '(no subject)'
        : (s2.length > SUBJECT_CUT ? s2.slice(0, SUBJECT_CUT - 1) + '…' : s2));
    }
    // the remainder the counter already computed (cap + budget-dry truth)
    more += Math.max(0, Number(a.more) || 0);
  }
  if (more > 0 && lines.length) {
    lines.push('… +' + more + ' more');
  }
  return lines;
}

function applyBadge(result) {
  const lines = [];
  if (result && result.accounts) {
    lines.push(...lastSyncLines(result));
  }
  const subjects = result && result.total > 0 ? subjectLines(result) : [];
  if (subjects.length) {
    lines.push('');
    lines.push(...subjects);
  }
  const title = lines.join('\n');
  if (result && result.total > 0) {
    setIcon('red');
    chrome.action.setBadgeBackgroundColor({color: BADGE_COLOR}).catch(() => {});
    chrome.action.setBadgeText({text: String(result.total)}).catch(() => {});
    chrome.action.setTitle({title}).catch(() => {});
  }
  else if (result && result.maildir !== false) {
    setIcon('gray');
    chrome.action.setTitle({title}).catch(() => {});
    clearBadge();
  }
  else {
    setIcon('blue');
    if (title) {
      chrome.action.setTitle({title}).catch(() => {});
    }
    else {
      chrome.action.setTitle({title: 'Libre Email Client'}).catch(() => {});
    }
    clearBadge();
  }
}

// One flow, serialized: a manual check answers the options page with the
// settled chain's result, so a click while a scheduled check runs never
// races a second run.
function checkNow() {
  chain = chain
    .then(runCheck)
    .catch(e => {
      console.log('[badge] check failed: ' + (e?.message || e));
      return null;
    });
  return chain;
}

function chase(respond) {
  // Check now acts like the client's "Sync account" segment first: a
  // filtered full run per badge-enabled account, the engine queue
  // drained, THEN the count — the badge shows server truth. The
  // scheduler owns the runs ('...' while going out, '🔑' when a master
  // password is missing) and every settled run's 'sync-refresh' the
  // badge reactions below already consume.
  chain = chain
    .then(async () => {
      const ids = await badgeAccountIds();
      if (ids.length) {
        await runAllAccounts('badge check', ids);
        await waitDrain();
      }
      return runCheck();
    })
    .catch(e => {
      console.log('[badge] check failed: ' + (e?.message || e));
      return null;
    });
  return chain.then(result => {
    respond(result == null
      ? {ok: false, error: 'badge counter disabled or misconfigured'}
      : {ok: true, result});
  });
}

// Triggers coalesce into one check at a time.
function schedule() {
  if (timer) {
    return;
  }
  timer = setTimeout(() => {
    timer = null;
    checkNow();
  }, COALESCE_MS);
}

// ---------------------------------------------------------------- triggers

chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  if (msg?.type === 'badge-check') {
    chase(respond);
    return true;   // async respond to the options page
  }
  if (msg?.type === 'sync-dirty-report' || msg?.type === 'sync-refresh') {
    schedule();
  }
  return false;
});

// A purely local read needs no user gesture, no server and no master
// password: the FIRST check fires on every service-worker wake — the
// browser start (onStartup), page-triggered wakes (edits reporting, sync
// runs) and alarm deliveries alike — so the badge shows its counts as
// soon as there is anything to show.
chrome.runtime.onStartup.addListener(() => checkNow());
checkNow();
