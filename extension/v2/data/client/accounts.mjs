'use strict';

// accounts.mjs — account enumeration from the granted directory handle.
//
// Every top-level directory of the root handle is an offlineimap-style
// account tree (its name is the sync slug). No chrome.storage, no worker:
// accounts are what the filesystem shows.

import {getPref, setPref} from './prefs.mjs';
import {getRootHandle} from './local-api.mjs';
import {load as loadDirs} from './dirs.mjs';

/**
 * Account directories directly under the granted root, alphabetical.
 * @returns {Promise<Array<{id, label}>>}
 */
export async function listAccounts() {
  try {
    const fs = await getRootHandle();
    const out = [];
    for (const entry of await fs.reader.list('')) {
      if (entry.kind !== 'directory' || entry.name.startsWith('.')) {
        continue;
      }
      out.push({id: entry.name, label: entry.name});
    }
    out.sort((a, b) => a.id.localeCompare(b.id));
    return out;
  }
  catch (e) {
    console.warn('[accounts] root enumeration failed:', e?.message || e);
    return [];
  }
}

let select = null;

// the sync-events status line keys on the currently selected account
const changeListeners = new Set();

// The <option> ids the picker was last built from — the diff guard of
// refreshAccounts(): an fs-event burst that lists the same tree must not
// churn the select.
let knownIds = '';

/** @returns {string|null} the account picker's current value, if any */
function selected() {
  return select?.value || null;
}

function onSelectionChange(fn) {
  if (typeof fn === 'function') {
    changeListeners.add(fn);
  }
}

function buildOptions(accounts) {
  knownIds = accounts.map(a => a.id).join('\n');
  select.replaceChildren(...accounts.map(account => {
    const opt = document.createElement('option');
    opt.value = account.id;
    opt.textContent = account.label || account.id;
    return opt;
  }));
}

async function loadAccounts() {
  const accounts = await listAccounts();
  if (!accounts.length) {
    const opt = document.createElement('option');
    // the placeholder's value must be '' — an <option> without a value
    // attribute reads as its text content, so select.value would be the
    // string "No accounts" and loadDirs() would treat it as a real id,
    // mkdir'ing a bogus account dir on the granted root
    opt.value = '';
    opt.textContent = 'No accounts';
    opt.disabled = true;
    opt.selected = true;
    knownIds = '';
    select.replaceChildren(opt);
    loadDirs(select.value);
    return;
  }
  buildOptions(accounts);
  const saved = await getPref('account', null);
  const match = saved && accounts.find(a => a.id === saved);
  select.value = match ? match.id : accounts[0].id;
  loadDirs(select.value);
}

/**
 * The fs-event router's accounts-view callable: an account directory
 * appeared under, or was removed from, the granted root while this page is
 * open (root-level single-segment events, data/client/fs-events.mjs).
 * Re-enumerates and reconciles the picker in place — a repeat enumeration
 * rebuilds nothing, a transient failed one leaves the picker untouched, the
 * open account surviving keeps both its value and its loaded tree, and a
 * vanished (or first-ever) account falls back exactly like the loader --
 * pref match, else first -- and loads that fallback's tree.
 */
async function refreshAccounts() {
  if (!select) {
    return;
  }
  const accounts = await listAccounts();
  const key = accounts.map(a => a.id).join('\n');
  if (key === knownIds) {
    return;   // unchanged since the last build: skip the churn
  }
  if (!accounts.length) {
    return;   // a failed/unreadable enumeration must not wipe the picker
  }
  const ids = new Set(accounts.map(a => a.id));
  const prev = select.value;
  buildOptions(accounts);
  if (prev && ids.has(prev)) {
    select.value = prev;   // the open account survived: keep it, no reload
    return;
  }
  const saved = await getPref('account', null);
  const match = saved && accounts.find(a => a.id === saved);
  select.value = match ? match.id : accounts[0].id;
  setPref('account', select.value).catch(() => {});
  loadDirs(select.value);
  for (const fn of changeListeners) {
    fn(selected());
  }
}

function init(element) {
  select = element;
  select.addEventListener('change', () => {
    setPref('account', select.value);
    loadDirs(select.value);
    for (const fn of changeListeners) {
      fn(selected());
    }
  });
  loadAccounts();
}

export {init, selected, onSelectionChange, refreshAccounts};
