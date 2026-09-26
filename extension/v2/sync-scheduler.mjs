// sync-scheduler.mjs — automated sync scheduling on chrome.alarms.
//
// A fully independent worker-level module: side-effect imported by the
// worker, it registers its own chrome.runtime.onMessage and
// chrome.alarms.onAlarm listeners and shares nothing with the worker's
// own switch. It performs no syncs of its own — it feeds the regular
// chain: ensure('sync') boots the shared offscreen engine on demand and
// the job travels over as {type:'sync-job'}, exactly like the worker's
// own 'sync-request' forward.
//
// Two timers per account, both one-shot alarms that re-arm as they go
// (all timers configurable via chrome.storage.local, read fresh on
// every arm/fire):
//
//   dirty  — a client edit ('sync-dirty-report') re-arms
//            'sync.auto.dirty.<accountId>' to fire
//            <sync.auto.dirtyDelay> seconds out (default 60; Chrome
//            delays alarm delivery below 30s, and a burst of edits
//            coalesces into the last report), then a fired alarm
//            submits ONE 'sync-dirs' job carrying exactly the dirs the
//            dirty store lists for that account. A full run is
//            deliberately avoided here: 'sync' resets the account's
//            full timer, and a full op would wipe dir marks that landed
//            after the job was read — wrong for an early alarm.
//
//   full   — every configured account gets its own
//            'sync.auto.full.<id>' alarm, keyed on the registry id
//            (slugs change with user/host/port; the options-page id
//            does not). It is one-shot: the fire re-arms the next one
//            before submitting, so the result is a self-continuing
//            cadence — one skipped or failed run is retried by the
//            NEXT alarm <sync.auto.fullInterval> seconds later
//            (default 900), never remembered here. A manual full sync
//            (client combo or sync interface — both arrive as a
//            'sync-request', which this module eavesdrops on) resets
//            THAT account's timer alone: the next automated run lands
//            one interval after the manual one, every other account's
//            cadence is untouched. A 'discard' counts as one too — the
//            local copy is gone, the next full run re-pulls it.
//
// The full account config — password included, decrypted just-in-time
// WITHOUT a prompt element — travels IN the job (the engine document
// has no chrome.storage): plain stored passwords always run; encrypted
// ones need master.pass in chrome.storage.session (cached by whoever
// last confirmed it in a page). A missing master = one logged skip:
// dirty marks stay, the full timer keeps its cadence and retries.
// Scheduled full runs carry the stored filter list, so the engine
// filters the run's new INBOX pulls on the spot — like the mail
// client's own full syncs.
//
// Bookkeeping: a service worker never hears its own runtime messages,
// so the scheduler's submissions pass dirty.mjs's 'sync-request'
// enqueue clear UNSEEN. The scheduler clears what its jobs will resync
// itself instead — exactly the submitted dirs after the engine accepted
// a 'sync-dirs' run (dirty.mjs exports clearDirs for it), the whole
// account records after a 'sync' was accepted (the same whole-account
// wipe the enqueue path applies). Manual submissions keep clearing
// through the eavesdropped 'sync-request'.
//
// Alarms persist beyond the worker's lifetime; the registry does not.
// On every boot the alarm set is reconciled against the registry and
// the settings: stale names are dropped, missing full cadences are
// (re)started, and a disabled switch clears the whole set.
//
// Out-of-cycle triggers: a master.pass write into chrome.storage.session
// (any page, any write with a value) runs the full-boot sweep — accounts
// that skipped for an unconfirmed master sync right away. The engine's
// post-run 'sync-pending-dirs' state report re-arms the account's dirty
// alarm, so dirs left holding pending moves resync on the dirty cadence.
// The context menu adds two more: a full sweep ('Sync Now') and a badge
// dirty sweep ('Update Badge Now' — syncBadgeDirs, one 'sync-dirs' job per
// badge-enabled account over its badge-defined folder, or over the account's
// dirty-store dirs for query-mode badges, submitted at once with no alarm).
// The idle-end full sweep can be switched off on its own
// ('sync.auto.idleEnabled').

'use strict';

import {ensure} from '/core/offscreen.mjs';
import {dlog} from '/core/debug-log.mjs';
import {loadAccounts, decryptPassword, loadGatePrefs} from '/data/sync/client/accounts.mjs';
import {loadFilters} from '/data/sync/filters/route.mjs';
import {getNeeded, clearDirs, clearAccount} from '/dirty.mjs';

const ENABLED = 'sync.auto.enabled';
const FULL_ENABLED = 'sync.auto.fullEnabled';
const DIRTY_ENABLED = 'sync.auto.dirtyEnabled';
const DIRTY_DELAY = 'sync.auto.dirtyDelay';
const IDLE_ENABLED = 'sync.auto.idleEnabled';
const FULL_INTERVAL = 'sync.auto.fullInterval';

const DIRTY_PREFIX = 'sync.auto.dirty.';   // keyed by the report's id
const FULL_PREFIX = 'sync.auto.full.';     // keyed by the registry id

// the documented defaults: a 15-min full cadence, edits coalescing into
// a 60s dirty alarm — Chrome delays alarm delivery below 30s, so the
// dirty alarm never sits under that floor
const DEFAULT_DIRTY_S = 60;
const DEFAULT_FULL_S = 900;

// the hard floors: Chrome's alarm delivery granularity for the dirty
// delay, and a 5-minute minimum cadence for the full run
const MIN_DIRTY_S = 30;
const MIN_FULL_S = 300;

// return-from-idle trigger threshold: 10 minutes of inactivity — the
// onStateChanged detection interval (seconds; re-asserted per wake)
const IDLE_SECONDS = 600;
try {
  chrome.idle.setDetectionInterval(IDLE_SECONDS);
}
catch (e) {
  dlog('scheduler', '[scheduler] idle threshold not set:',
    e?.message || e);
}

let chain = Promise.resolve();   // scheduled submissions never run concurrently

// ------------------------------------------------------------- settings

async function settings() {
  const res = await chrome.storage.local
    .get([ENABLED, FULL_ENABLED, DIRTY_ENABLED, DIRTY_DELAY, IDLE_ENABLED,
      FULL_INTERVAL])
    .catch(() => ({}));
  const delay = Math.round(Number(res[DIRTY_DELAY]) || DEFAULT_DIRTY_S);
  const full = Math.round(Number(res[FULL_INTERVAL]) || DEFAULT_FULL_S);
  return {
    enabled: res[ENABLED] !== false,
    fullEnabled: res[FULL_ENABLED] !== false,
    dirtyEnabled: res[DIRTY_ENABLED] !== false,
    idleEnabled: res[IDLE_ENABLED] !== false,
    // Chrome delays alarm delivery below 30s — keep the floor honest
    delayMs: Math.max(MIN_DIRTY_S, delay) * 1000,
    fullMs: Math.max(MIN_FULL_S, full) * 1000
  };
}

// -------------------------------------------------------------- alarms

/**
 * Debug trace: one line per account with its next scheduled run — when
 * it goes off and WHY (dirty resync vs full cadence). Re-armed alarms
 * replace one-shot names, so this is always the true picture.
 */
async function logNextRuns(tag) {
  try {
    const [accounts, all] = await Promise.all([
      registry(),
      chrome.alarms.getAll()
    ]);
    const rows = [];
    for (const alarm of all.filter(a => isOurs(a.name))) {
      const kind = alarm.name.startsWith(DIRTY_PREFIX) ? 'dirty' : 'full';
      const acc = findAccount(accounts, alarm.name.slice(
        (kind === 'dirty' ? DIRTY_PREFIX : FULL_PREFIX).length));
      const when = alarm.scheduledTime
        ? new Date(alarm.scheduledTime).toISOString()
        : 'no scheduledTime';
      const inMs = alarm.scheduledTime
        ? ' (in ' + Math.max(0, alarm.scheduledTime - Date.now()) + ' ms)'
        : '';
      rows.push((acc ? (acc.name || acc.id) : alarm.name) +
        ' → ' + when + inMs + ' [' + kind + ']');
    }
    rows.sort();
    dlog('scheduler', '[scheduler] next runs' +
      (tag ? ' (after ' + tag + ')' : '') + ':',
      rows.length ? '\n  ' + rows.join('\n  ') : 'none');
  }
  catch (e) {
    dlog('scheduler', '[scheduler] next-run trace failed:', e?.message || e);
  }
}

function rearm(name, ms, tag) {
  return chrome.alarms.create(name, {when: Date.now() + ms})
    .then(() => logNextRuns(tag));
}

function armFull(id, fullMs, tag) {
  return rearm(FULL_PREFIX + id, fullMs, tag || 'full rearm ' + id);
}

function armDirty(id, delayMs, tag) {
  return rearm(DIRTY_PREFIX + id, delayMs, tag || 'dirty rearm ' + id);
}

/** whether an alarm name is one of ours (other modules' are untouched) */
function isOurs(name) {
  return name.startsWith(DIRTY_PREFIX) || name.startsWith(FULL_PREFIX);
}

/** whether one of ours belongs to a kind whose periodic sync is disabled */
function isOursDisabledKind(alarm, cfg) {
  return alarm.name.startsWith(FULL_PREFIX)
    ? !cfg.fullEnabled
    : !cfg.dirtyEnabled;
}

function dropAlarm(name) {
  return chrome.alarms.clear(name).catch(() => {});
}

// -------------------------------------------------------------- accounts

async function registry() {
  return loadAccounts(null, {decrypt: false}).catch(() => []);
}

/** the registry account behind either id spelling */
function findAccount(accounts, id) {
  return accounts.find(a => a.id === id) ??
    accounts.find(a => a.slug === id) ?? null;
}

/** both spellings an account's records may be keyed under */
function accountKeys(acc) {
  return [...new Set([acc.id, acc.slug].filter(Boolean))];
}

/** the dirty dir stamps of one account, under either key spelling */
async function dirtyDirs(id, slug) {
  const needed = await getNeeded().catch(() => ({}));
  return needed[id] || needed[slug] || null;
}

/** the stored filter list for full runs — the engine applies it to the
 *  run's new INBOX pulls in stored order, like the client's own syncs */
async function filters() {
  const list = await loadFilters().catch(() => []);
  return Array.isArray(list) ? list : [];
}

// -------------------------------------------------------------- submit

/** rid for a scheduled job: 'auto-' tags it apart from page trackers */
function rid(kind) {
  return 'auto-' + kind + '-' + Date.now().toString(36) + '-' +
    Math.floor(Math.random() * 1e6).toString(36);
}

/**
 * Submits one job straight to the engine over the worker's regular
 * ensure('sync') + 'sync-job' handoff. A service worker never hears its
 * own runtime messages, so the pass-through the worker performs for
 * pages is unrolled here.
 */
async function submitJob(msg) {
  if (!await ensure('sync')) {
    throw new Error('the shared offscreen document would not come up');
  }
  const res = await chrome.runtime.sendMessage(msg)
    .catch(e => { throw new Error(e?.message || String(e)); });
  if (!res) {
    throw new Error('the engine answered nothing');
  }
  if (!res.ok) {
    throw new Error(res.error || res.reason || 'request rejected');
  }
  return res;
}

/**
 * The account's password for a scheduled run: plain stored values (and
 * accounts without one) resolve without a prompt; an encrypted value
 * resolves only when master.pass sits in chrome.storage.session. A
 * thrown error = skip this run (logged by the caller).
 */
async function pass(acc) {
  const stored = (await chrome.storage.local
    .get('user.pass.' + acc.id)
    .catch(() => ({})))['user.pass.' + acc.id] ?? '';
  return decryptPassword(stored, null, acc.name || acc.id);
}

// -------------------------------------------------------------- jobs

/**
 * The dirty alarm fired: submit ONE 'sync-dirs' job carrying exactly
 * the dirty store's dir list for the account. An empty list = the marks
 * were cleared meanwhile (a manual run beat the alarm) — nothing to do.
 * After the engine accepts, the submitted dirs leave the dirty store
 * right away: the enqueue clear never sees this message, and marks that
 * landed between the read and the acceptance keep their stamps.
 */
function jobDirty(alarm) {
  const task = chain.then(async () => {
    const cfg = await settings();
    if (!cfg.enabled || !cfg.dirtyEnabled) {
      return;   // disabled since the arm: marks stay, nothing runs
    }
    const id = alarm.name.slice(DIRTY_PREFIX.length);
    const acc = findAccount(await registry(), id);
    if (!acc) {
      dlog('scheduler', '[scheduler] dirty: no registry account for', id,
        '— alarm dropped');
      await dropAlarm(alarm.name);
      return;
    }
    const marks = await dirtyDirs(acc.id, acc.slug);
    const dirs = marks ? Object.keys(marks).sort() : [];
    if (!dirs.length) {
      return;
    }
    let passValue;
    try {
      passValue = await pass(acc);
    }
    catch (e) {
      setKeyBadge();
      dlog('scheduler', '[scheduler] dirty: skipping', acc.name || acc.id,
        '—', e?.message || e);
      return;   // marks stay: a full cycle (or the next page) picks them up
    }
    const list = await filters();
    const prefs = await loadGatePrefs().catch(() => null);
    const res = await submitJob({
      type: 'sync-job',
      rid: rid('dirs'),
      kind: 'sync-dirs',
      account: {...acc, pass: passValue},
      dirs,
      // filter parity: the stored list rides along like every other
      // non-interface run — the engine's dirty branch runs the pass over
      // a landed INBOX dir's new pulls
      ...(list.length ? {filters: list} : {}),
      // the stored gate preferences ride along the same way (the engine
      // has no chrome.storage): a headless answer follows the saved
      // 'Purge from server' / 'Drop local dir' choice
      ...(prefs ? {prefs} : {})
    });
    if (res.started !== false) {
      await clearDirs(accountKeys(acc), dirs)
        .catch(e => dlog('scheduler', '[scheduler] dirty: dir clear failed —',
          e?.message || e));
    }
  });
  chain = task.catch(() => {});
  return task.catch(e =>
    dlog('scheduler', '[scheduler] dirty run failed:', e?.message || e));
}

/**
 * The raw full-account run body, shared by every trigger — NEVER enqueues
 * itself: re-arm the next cadence FIRST (a manual/triggered run resets
 * THAT account's timer like a manual sync always has), then submit — a
 * skipped password or a failed job is retried by the next alarm, not
 * remembered here. After an accepted run the account's whole dirty
 * record leaves the store (the full sync covers every dir — the same
 * whole-account wipe the enqueue path applies).
 * @param {string|{type:string}} tag the logNextRuns cause tag for the re-arm
 * @param {string} passValue the ALREADY-RESOLVED password — unresolved
 *   (null) retires the cycle after the re-arm; the caller decides skip
 *   semantics and badge state BEFORE arming
 */
async function submitFull(acc, cfg, tag, passValue) {
  await armFull(acc.id, cfg.fullMs, tag);
  if (passValue == null) {
    return;   // unresolvable password: skipped, retried next cycle
  }
  const payload = {
    type: 'sync-job',
    rid: rid('full'),
    kind: 'sync',
    account: {...acc, pass: passValue}
  };
  const [list, prefs] = await Promise.all([
    filters(),
    loadGatePrefs().catch(() => null)
  ]);
  if (list.length) {
    payload.filters = list;
  }
  if (prefs) {
    payload.prefs = prefs;
  }
  const res = await submitJob(payload);
  if (res.started !== false) {
    for (const key of accountKeys(acc)) {
      await clearAccount(key).catch(() => {});
    }
  }
}

/** writes the action badge: a "…" while a sweep's runs are underway —
 *  every settled run broadcasts 'sync-refresh', the badge recount over it */
function badgeBusy() {
  chrome.action.setBadgeBackgroundColor({color: '#1a73e8'}).catch(() => {});
  return chrome.action.setBadgeText({text: '...'}).catch(() => {});
}

/** swaps the "..." for a key: the account needs the master password (its
 *  stored password is encrypted and none is confirmed in the session) */
function setKeyBadge() {
  chrome.action.setBadgeBackgroundColor({color: '#d93025'}).catch(() => {});
  return chrome.action.setBadgeText({text: '🔑'}).catch(() => {});
}

/**
 * The full alarm fired: resolve the account behind the alarm name and
 * hand the run to the sweep entry (a password failure marks the key
 * badge and retires this cycle — re-armed, retried next alarm).
 */
function jobFull(alarm) {
  return chain.then(async () => {
    const cfg = await settings();
    if (cfg.enabled && cfg.fullEnabled) {
      const id = alarm.name.slice(FULL_PREFIX.length);
      const acc = findAccount(await registry(), id);
      if (!acc) {
        dlog('scheduler', '[scheduler] full: no registry account for', id,
          '— alarm dropped');
        await dropAlarm(alarm.name);
        return;
      }
      await runFullAccountForSweep(acc, cfg, 'full fired — next ' + acc.id);
    }
    else {
      // disabled since the arm: the cadence is over, nothing to re-arm
      await dropAlarm(alarm.name);
    }
  });
}

/**
 * One sweep entry: resolve the password BEFORE arming, so the badge
 * shows the key the moment an unresolvable account is hit. A null
 * password still re-arms the cadence (retried next cycle) but submits
 * nothing.
 */
async function runFullAccountForSweep(acc, cfg, tag) {
  let passValue = null;
  try {
    passValue = await pass(acc);
  }
  catch (e) {
    setKeyBadge();
    dlog('scheduler', '[scheduler]', tag, '— skipping', acc.name || acc.id,
      '—', e?.message || e);
    passValue = null;
  }
  await submitFull(acc, cfg, tag, passValue)
    .catch(e => dlog('scheduler', '[scheduler]', tag, 'run failed for',
      acc.name || acc.id, '—', e?.message || e));
}

/**
 * One full run per account — the trigger-driven path shared by startup,
 * idle-end, the context menu and the badge's Check now. Already
 * serialized inside the chain, so the raw bodies run directly (chaining
 * from INSIDE a chain task would deadlock: the sweep would await tasks
 * that only resolve once the sweep itself does). One skipped account
 * does not stop the sweep — a retry-next-alarm schedule stays honest
  * for it; the armed cadences land one interval after their run, so the
  * full rhythm recovers by itself.
 * @param {string} cause what asked for the runs ('startup', 'idle end',
 *   'menu', 'badge check')
 * @param {string[]|null} [accountIds] ONLY these registry accounts
 *   (id or slug; the badge check passes its badge-enabled set which is
 *   id-keyed); null/empty = every registered account
 */
function runAllAccounts(cause, accountIds = null) {
  const task = chain.then(async () => {
    const cfg = await settings();
    if (!cfg.enabled || !cfg.fullEnabled) {
      return;
    }
    let list = await registry();
    if (Array.isArray(accountIds) && accountIds.length) {
      const wanted = new Set(accountIds);
      list = list.filter(acc => wanted.has(acc.id) || wanted.has(acc.slug));
    }
    if (!list.length) {
      return;
    }
    dlog('scheduler', '[scheduler]', cause, '— full runs for', list.length,
      'account(s)');
    await badgeBusy();
    for (const acc of list) {
      await runFullAccountForSweep(acc, cfg, cause + ' — next ' + acc.id);
    }
    await logNextRuns(cause);
  });
  chain = task.catch(() => {});
  return task.catch(e =>
    dlog('scheduler', '[scheduler]', cause, 'sweep failed:', e?.message || e));
}

/**
 * A sync pass over exactly the folders the badge counter counts — the
 * context menu's 'Update Badge Now'. Like runAllAccounts it submits to the
 * engine directly, but as ONE 'sync-dirs' job per badge-enabled account,
 * fired immediately (no alarm, no delay). What each account contributes
 * follows its badge preference:
 *
 *   folder mode — the defined badge folder, or the engine-side INBOX
 *                 default when none is set; synced unconditionally (a
 *                 server update always shows up in the badge count after
 *                 this run's settled writes)
 *   query mode  — the account's dirty-store marks: the query scans every
 *                 local folder, so the dirs a server update could have
 *                 landed in are exactly the dirs on record; with no marks
 *                 the all-folder scan is already server truth
 *
 * The badge recounts by itself: every settled run broadcasts
 * 'sync-refresh', which /badge.mjs consumes.
 * @param {string} cause what asked for the runs ('menu')
 */
function syncBadgeDirs(cause) {
  const task = chain.then(async () => {
    const cfg = await settings();
    if (!cfg.enabled || !cfg.dirtyEnabled) {
      return;
    }
    const storage = await chrome.storage.local.get(null);
    if (storage['badge.enabled'] === false) {
      return;   // badge off: its folders are not a scope worth syncing
    }
    const registryAccounts = await registry();
    const jobs = [];
    const needed = await getNeeded().catch(() => ({}));
    for (const acc of registryAccounts) {
      if (storage['email.badge.' + acc.id] === false) {
        continue;   // per-account opt-out, the same truth buildJob reads
      }
      const mode = storage['email.badgeMode.' + acc.id] === 'query'
        ? 'query'
        : 'folder';
      if (mode === 'folder') {
        const folder = String(storage['email.badgeFolder.' + acc.id] ?? '')
          .trim();
        // the engine-side INBOX default when the badge counts its INBOX
        jobs.push({acc, dirs: [folder || 'INBOX']});
        continue;
      }
      // query mode: every dir the all-folder scan would read server truth
      const marks = needed[acc.id] || needed[acc.slug] || null;
      const dirs = marks ? Object.keys(marks).sort() : [];
      if (dirs.length) {
        jobs.push({acc, dirs});
      }
    }
    if (!jobs.length) {
      dlog('scheduler', '[scheduler]', cause,
        '— no badge folders / dirty marks to sync');
      return;
    }
    dlog('scheduler', '[scheduler]', cause, '— dirty badge runs for',
      jobs.length, 'account(s)');
    await badgeBusy();
    for (const {acc, dirs} of jobs) {
      let passValue;
      try {
        passValue = await pass(acc);
      }
      catch (e) {
        setKeyBadge();
        dlog('scheduler', '[scheduler]', cause, ': skipping',
          acc.name || acc.id, '—', e?.message || e);
        continue;   // marks stay: a full cycle (or the next page) picks them up
      }
      try {
        const list = await filters();
        const prefs = await loadGatePrefs().catch(() => null);
        const res = await submitJob({
          type: 'sync-job',
          rid: rid('badge-dirs'),
          kind: 'sync-dirs',
          account: {...acc, pass: passValue},
          dirs,
          ...(list.length ? {filters: list} : {}),
          ...(prefs ? {prefs} : {})
        });
        if (res.started !== false) {
          await clearDirs(accountKeys(acc), dirs)
            .catch(e => dlog('scheduler', '[scheduler]', cause,
              ': dir clear failed —', e?.message || e));
        }
      }
      catch (e) {
        dlog('scheduler', '[scheduler]', cause, ': dirty badge run failed for',
          acc.name || acc.id, '—', e?.message || e);
      }
    }
    await logNextRuns(cause);
  });
  chain = task.catch(() => {});
  return task.catch(e =>
    dlog('scheduler', '[scheduler]', cause, 'badge sweep failed:',
      e?.message || e));
}

// -------------------------------------------------------------- reconcile

/**
 * The worker (re)booted: reconcile the alarm set against the registry
 * and the settings — alarms persist beyond the worker's lifetime, the
 * registry does not, so both directions need sweeping.
 */
const booting = (async () => {
  try {
    const cfg = await settings();
    const accounts = await registry();
    let existing = (await chrome.alarms.getAll()
      .catch(() => []))
      .filter(a => isOurs(a.name));
    if (!cfg.enabled) {
      const names = existing.map(a => a.name);
      for (const name of names) {
        await dropAlarm(name);
      }
      if (names.length) {
        dlog('scheduler', '[scheduler] disabled — cleared', names.length,
          'alarm(s)');
      }
      return;
    }
    // a disabled kind clears its whole alarm set (the fire handlers apply
    // the same switch mid-flight, so toggles never need a worker restart)
    let droppedDisabled = 0;
    for (const alarm of existing) {
      const kindDisabled = alarm.name.startsWith(FULL_PREFIX)
        ? !cfg.fullEnabled
        : !cfg.dirtyEnabled;
      if (kindDisabled) {
        await dropAlarm(alarm.name);
        droppedDisabled++;
      }
    }
    existing = existing.filter(a => !isOursDisabledKind(a, cfg));
    if (droppedDisabled) {
      dlog('scheduler', '[scheduler] disabled kind(s) — cleared',
        droppedDisabled, 'alarm(s)');
    }
    for (const alarm of existing) {
      const key = alarm.name.startsWith(DIRTY_PREFIX)
        ? alarm.name.slice(DIRTY_PREFIX.length)
        : alarm.name.slice(FULL_PREFIX.length);
      const acc = findAccount(accounts, key);
      if (!acc) {
        await dropAlarm(alarm.name);
        dlog('scheduler', '[scheduler] dropped stale alarm', alarm.name);
      }
      else if (alarm.name.startsWith(FULL_PREFIX) &&
               alarm.name !== FULL_PREFIX + acc.id) {
        // defensively re-home a non-id-keyed full alarm (e.g. one armed
        // by a slug before the registry id was known), keeping its
        // scheduled time
        await dropAlarm(alarm.name);
        await chrome.alarms.create(FULL_PREFIX + acc.id, {
          when: alarm.scheduledTime || Date.now() + cfg.fullMs
        }).catch(() => {});
      }
      else if (alarm.name.startsWith(FULL_PREFIX) &&
               !alarm.scheduledTime) {
        await armFull(acc.id, cfg.fullMs, 'boot rearm ' + acc.id)
          .catch(() => {});
      }
    }
    for (const acc of accounts) {
      // fresh cadence for accounts without one (only when full syncs are on)
      if (cfg.fullEnabled &&
          !existing.some(a => a.name === FULL_PREFIX + acc.id)) {
        await armFull(acc.id, cfg.fullMs, 'boot fresh ' + acc.id)
          .catch(() => {});
      }
      // a dirty alarm only when the store actually holds marks
      // (and dirty syncs are on)
      const dirtyName = DIRTY_PREFIX + acc.id;
      const dirtySlug = DIRTY_PREFIX + acc.slug;
      if (cfg.dirtyEnabled &&
          !existing.some(a => a.name === dirtyName ||
                             a.name === dirtySlug)) {
        const marks = await dirtyDirs(acc.id, acc.slug);
        if (marks && Object.keys(marks).length) {
          await armDirty(acc.slug, cfg.delayMs, 'boot dirty ' + acc.slug)
            .catch(() => {});
        }
      }
    }
    await logNextRuns('boot');
  }
  catch (e) {
    dlog('scheduler', '[scheduler] boot reconcile failed:', e?.message || e);
  }
})();

// -------------------------------------------------------------- listeners

chrome.alarms.onAlarm.addListener(alarm => {
  if (!isOurs(alarm?.name)) {
    return;
  }
  if (alarm.name.startsWith(DIRTY_PREFIX)) {
    jobDirty(alarm);
  }
  else {
    jobFull(alarm);
  }
});

// the browser started: a full sweep straight away, then the regular
// cadence takes over (runFullAccountForSweep re-arms each alarm)
chrome.runtime.onStartup.addListener(() => {
  booting
    .then(() => runAllAccounts('startup'))
    .catch(e =>
      dlog('scheduler', '[scheduler] startup sync failed:', e?.message || e));
});

// the computer came back from idle/locked: a full sweep on the
// transition only. The previous idle state lives in chrome.storage.session
// (a service worker restarts lose memory); with no recorded state the
// event is just noted — a fresh worker must not guess a transition.
const IDLE_STATE = 'sync.auto.idleState';

chrome.idle.onStateChanged.addListener(state => {
  (async () => {
    const stored = await chrome.storage.session.get(IDLE_STATE);
    const previous = stored?.[IDLE_STATE] || null;
    await chrome.storage.session.set({[IDLE_STATE]: state});
    if (state !== 'active' ||
        (previous !== 'idle' && previous !== 'locked')) {
      return;
    }
    const cfg = await settings();
    if (!cfg.enabled || !cfg.idleEnabled) {
      return;   // idle syncs disabled since the wake: no sweep
    }
    await booting;
    await runAllAccounts('idle end');
  })().catch(e =>
    dlog('scheduler', '[scheduler] idle transition failed:', e?.message || e));
});

// the master password was written to chrome.storage.session (set or
// confirmed in any page: the options page, the client's first-open
// prompt): encrypted accounts resolve instantly from now on, so run the
// same full sweep the boot performs — the accounts that skipped for an
// unconfirmed master stop waiting for their next alarm. Only a present
// value triggers; a removal changes no account's resolution.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'session' || !(changes['master.pass']?.newValue)) {
    return;
  }
  (async () => {
    await booting;
    await runAllAccounts('master pass confirmed');
  })().catch(e =>
    dlog('scheduler', '[scheduler] master-pass sweep failed:',
      e?.message || e));
});

chrome.runtime.onMessage.addListener(msg => {
  switch (msg?.type) {
    // a client edit: (re)arm the account's dirty alarm one delay out —
    // a burst of reports keeps updating the ONE alarm instead of
    // stacking runs. The report's id is the client's slug; the job
    // resolver accepts either spelling.
    case 'sync-dirty-report':
      if (typeof msg.accountId === 'string' && msg.accountId) {
        const id = msg.accountId;
        (async () => {
          await booting;
          const cfg = await settings();
          if (!cfg.enabled || !cfg.dirtyEnabled) {
            return;
          }
          await armDirty(id, cfg.delayMs, 'dirty report ' + id);
        })().catch(e =>
          dlog('scheduler', '[scheduler] dirty arm failed:', e?.message || e));
      }
      return false;   // no response: dirty.mjs owns this message
    case 'sync-pending-dirs': {
      // the engine's post-run state report: dirs left holding pending
      // moves were marked by dirty.mjs — re-arm that account's dirty
      // alarm one delay out, so the store's leftovers resync soon
      if (Array.isArray(msg.dirs) && msg.dirs.length) {
        const key = typeof msg.slug === 'string' && msg.slug
          ? msg.slug
          : (typeof msg.accountId === 'string' ? msg.accountId : null);
        if (key) {
          (async () => {
            await booting;
            const cfg = await settings();
            if (!cfg.enabled || !cfg.dirtyEnabled) {
              return;
            }
            await armDirty(key, cfg.delayMs, 'pending dirs ' + key);
          })().catch(e =>
            dlog('scheduler', '[scheduler] pending-dirs arm failed:',
              e?.message || e));
        }
      }
      return false;   // no response: dirty.mjs owns this message
    }
    // a full-account run anywhere in the extension (a manual one from
    // the client combo or the sync interface) resets THAT account's
    // timer — the next automated run lands one interval after it
    case 'sync-request':
      if (msg.kind === 'sync' || msg.kind === 'discard') {
        (async () => {
          await booting;
          const cfg = await settings();
          if (!cfg.enabled || !cfg.fullEnabled) {
            return;
          }
          const key = msg.account?.id || msg.account?.slug;
          if (typeof key === 'string' && key) {
            await armFull(key, cfg.fullMs, 'manual reset ' + key);
          }
        })().catch(e =>
          dlog('scheduler', '[scheduler] full reset failed:', e?.message || e));
      }
      return false;   // no response: the worker's listener owns this
    default:
      return false;
  }
});

/** wipe every alarm this module created (other modules' are untouched) */
function clearSchedules() {
  return chrome.alarms.getAll()
    .then(all => Promise.all(
      all.filter(a => isOurs(a.name)).map(a => chrome.alarms.clear(a.name))))
    .then(() => undefined);
}

export {clearSchedules, runAllAccounts, syncBadgeDirs};
