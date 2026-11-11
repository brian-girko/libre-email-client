'use strict';

// ignore.mjs — the per-account folder ignore list (chrome.storage.local,
// flat key `sync.ignore.<registry-id>`, one array of server-spelled folder
// names per account — the same flat per-account key style as
// `sync.delimiter.<id>` and `sync.lastSyncAt.<id>`).
//
// An ignored folder is NEVER synced: the engine's survey skips it (its
// whole subtree — see isIgnoredFolder in maildir.mjs) and the local mirror
// copy is kept untouched (line-through on the client's folder tree). The
// snapshot entry survives every run, so un-ignoring later diff-reconciles
// the folder instead of re-pulling it from scratch. The server copy is
// never touched by ignoring.
//
// The offscreen engine has no chrome.storage: like the filter list and
// the gate preferences, the list travels IN the job — the service worker
// (worker.mjs) and the scheduler (sync-scheduler.mjs) attach it as
// `ignores` to every forwarded 'sync-job'. Writers are the client's
// folder-pane checkbox mode (data/client/dirs.mjs) and the sync panel's
// ignored-folders row (data/sync/client/sync-panel.mjs).

import {loadAccounts} from './client/accounts.mjs';

const KEY_BASE = 'sync.ignore.';

export const ignoreKey = id => KEY_BASE + id;

/**
 * Resolves an account reference onto the registry id the storage key
 * needs — mirrors delimiterFor(): an options-page id, a client slug (the
 * mail client's folder pane keys accounts by the granted-directory tree),
 * or the account object itself ({id}/{slug}).
 * @param {string|{id?: string, slug?: string}} accountRef
 * @returns {Promise<string|null>} the registry id, or null when unknown
 */
async function accountIdOf(accountRef) {
  const wanted = typeof accountRef === 'object' && accountRef !== null
    ? (accountRef.id || accountRef.slug || null)
    : accountRef;
  if (!wanted || typeof wanted !== 'string') {
    return null;
  }
  const accounts = await loadAccounts(null, {decrypt: false}).catch(() => []);
  const acc = accounts.find(a => a.id === wanted) ??
    accounts.find(a => a.slug === wanted) ??
    null;
  return acc?.id ?? null;
}

/**
 * The account's stored ignore list (server-spelled folder names). An
 * unknown account or a storage hiccup reads as an empty list — ignoring
 * nothing is the safe default everywhere.
 * @param {string|{id?: string, slug?: string}} accountRef
 * @returns {Promise<string[]>}
 */
export async function loadIgnores(accountRef) {
  const id = await accountIdOf(accountRef);
  return loadIgnoresById(id);
}

/**
 * Same read, by the KNOWN registry id (the panel and the client's wiring
 * resolve their account first and reuse it).
 * @param {string|null} id registry account id
 * @returns {Promise<string[]>}
 */
export async function loadIgnoresById(id) {
  if (!id || typeof id !== 'string') {
    return [];
  }
  const key = ignoreKey(id);
  const stored = await chrome.storage.local.get(key).catch(() => ({}));
  const value = stored[key];
  return Array.isArray(value)
    ? value.filter(n => typeof n === 'string' && n)
    : [];
}

/**
 * Replaces the account's ignore list with the given names (duplicates
 * dropped, order preserved). Empty list removes the key entirely — no
 * empty-array husks in storage.
 * @param {string|{id?: string, slug?: string}} accountRef
 * @param {string[]} names server-spelled folder names
 */
export async function saveIgnores(accountRef, names) {
  const id = await accountIdOf(accountRef);
  if (!id || typeof id !== 'string') {
    return;
  }
  const key = ignoreKey(id);
  const list = [...new Set((Array.isArray(names) ? names : [])
    .filter(n => typeof n === 'string' && n))];
  if (!list.length) {
    await chrome.storage.local.remove(key).catch(() => {});
    return;
  }
  await chrome.storage.local.set({[key]: list}).catch(() => {});
}
