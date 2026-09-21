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
    const root = await getRootHandle();
    const out = [];
    for await (const [name, handle] of root.entries()) {
      if (handle.kind !== 'directory' || name.startsWith('.')) {
        continue;
      }
      out.push({id: name, label: name});
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

async function loadAccounts() {
  const accounts = await listAccounts();
  if (!accounts.length) {
    const opt = document.createElement('option');
    opt.textContent = 'No accounts';
    opt.disabled = true;
    opt.selected = true;
    select.replaceChildren(opt);
    loadDirs(select.value);
    return;
  }
  select.replaceChildren(...accounts.map(account => {
    const opt = document.createElement('option');
    opt.value = account.id;
    opt.textContent = account.label || account.id;
    return opt;
  }));
  const saved = await getPref('account', null);
  const match = saved && accounts.find(a => a.id === saved);
  select.value = match ? match.id : accounts[0].id;
  loadDirs(select.value);
}

function init(element) {
  select = element;
  select.addEventListener('change', () => {
    setPref('account', select.value);
    loadDirs(select.value);
  });
  loadAccounts();
}

export {init};
