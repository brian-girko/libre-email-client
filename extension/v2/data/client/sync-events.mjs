'use strict';

// sync-events.mjs — last-synced status line.
//
// The engine-era module received the worker's sync activity broadcasts and
// master-password prompts; with the local-only client there is nothing to
// listen to. What survives is the persistent logger status line: the
// currently SELECTED account's "last synced" stamp, read from the
// account's .sync-state.json (written by the sync interface's runs),
// re-rendered when the local store reports a change or the account
// picker changes.

import * as logger from './logger.mjs';
import {listAccounts, selected as selectedAccount, onSelectionChange} from './accounts.mjs';
import {getMailApi} from './mail.mjs';
import {findRegistryAccount} from './sync-run.mjs';

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

// Sync stamps arrive in more than one shape — ms numbers (the engine's
// sync-dirs path), numeric strings, and ISO strings (the engine's plain
// sync summary carries the snapshot's ISO lastSyncAt). Number(ISO) is
// NaN, and a NaN in the clock map renders as "never synced" — every
// stamp is normalized to epoch ms before it enters the map.
function toMs(ts) {
  if (typeof ts === 'number') {
    return Number.isFinite(ts) ? ts : 0;
  }
  const n = Number(ts);
  if (Number.isFinite(n) && n > 0) {
    return n;
  }
  const p = Date.parse(ts);
  return Number.isFinite(p) ? p : 0;
}

// The persistent status: the SELECTED account's stamp only. The picker's
// current value is read live at every render — no stale mirror — and a
// selection change repaints (wiring below). Fallback: all known accounts,
// for pages/tests that never had a picker.
function refreshStatus() {
  const pick = selectedAccount();
  const ids = pick && (accounts.has(pick) || lastSynced.has(pick))
    ? [pick]
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

function noteSynced(accountId, syncedAt) {
  const at = toMs(syncedAt);
  if (!accountId || !at) {
    return;
  }
  if ((lastSynced.get(accountId) || 0) >= at) {
    return; // monotonic: a folder-only touch never rewinds the clock
  }
  lastSynced.set(accountId, at);
  // the status line follows the selection, so a run of another account
  // only updates the clock here — its stamp shows once it's selected
  refreshStatus();
}

// Even silently-updated clocks want the status visible on the first paint:
// the initial status render happens once, at init.
let statusShown = false;

function maybeShow() {
  if (!statusShown && lastSynced.size) {
    refreshStatus();
    statusShown = true;
  }
}

async function loadAccounts() {
  try {
    const list = await listAccounts();
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
    /* labels stay empty until the handle answers */
  }
}

// Seed the clocks from the accounts' .sync-state.json files.
async function loadPersistence() {
  try {
    const ids = [...accounts.keys()];
    for (const id of ids) {
      try {
        const t = toMs(await (await getMailApi(id)).lastSynced());
        if (t) {
          noteSynced(id, t, {silent: true});
        }
      }
      catch {
        /* account not openable yet */
      }
    }
    maybeShow();
  }
  catch {
    /* no state files yet */
  }
}

// ---- wiring -----------------------------------------------------------------

// Live clocks: every sync run (a background one submitted here, or one
// from the sync interface) ends with the engine's 'sync-synced'
// broadcast. It carries the registry id; the clocks here key by the
// granted-directory slug — resolve it through the sync registry. The
// null-finishedAt discard path resets the stamp on the server side only:
// the local copy is gone, nothing to show a clock for.
chrome.runtime.onMessage.addListener(msg => {
  if (msg?.type !== 'sync-synced' || msg.finishedAt == null) {
    return;
  }
  findRegistryAccount(msg.accountId).then(acc => {
    if (acc?.slug) {
      noteSynced(acc.slug, msg.finishedAt);
    }
  }).catch(() => {});
});

// The account picker changed: repaint the status for the new selection —
// its clock may already be seeded (or landed silently).
onSelectionChange(() => refreshStatus());

function init() {
  loadAccounts().then(loadPersistence);
  onSelectionChange(() => {
    if (statusShown) {
      refreshStatus();
    }
  });
}

export {init};
