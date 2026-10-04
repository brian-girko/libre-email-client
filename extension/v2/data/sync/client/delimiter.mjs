// delimiter.mjs — the ONE resolver for an account's IMAP hierarchy
// delimiter:
//
//   The split: the offscreen engine's survey discovers the server's own
//   delimiter (INBOX's after ImapClient.folders(), '/' for flat servers)
//   and pings the worker ('sync-delimiter' → sync.delimiter.<options-id>,
//   see worker.mjs) — while the options page, the sync interface, the mail
//   client and the badge each used to look it up by their own paths and
//   spellings ('/'-typed paths vs '.'-typed server names). This module is
//   the shared truth: every consumer asks delimiterFor() and gets the same
//   stamp for the same account, however it is referenced here.

'use strict';

import {loadAccounts} from './accounts.mjs';

const KEY_BASE = 'sync.delimiter.';
// a stamp the worker itself would never persist ('sync-delimiter' guard):
// '%' is the escaping root ('%2e' is a literal '.' in flat names — a '%'
// delimiter could never rejoin the flat name)
const CHARS_BANNED = new Set(['%']);

/** a stamp the worker would have persisted (sync-delimiter's own guard) */
export function isValidDelimiter(delimiter) {
  return typeof delimiter === 'string' &&
    delimiter.length === 1 &&
    !CHARS_BANNED.has(delimiter);
}

/**
 * The account's stored hierarchy delimiter — identical for every caller.
 * Reads `sync.delimiter.<id>` for the registry account behind the given
 * reference: an options-page id, a client slug, or the account object
 * itself ({id}/{slug}). Accepting either spelling mirrors sync-panel
 * findAccount / scheduler findAccount semantics: one account, two keys.
 * @param {string|{id?: string, slug?: string}} accountRef
 * @returns {Promise<string|null>} one char ('.'/…), or null when the
 *   account is unknown or never synced (no stamp yet — the callers'
 *   '/' defaults then apply)
 */
export async function delimiterFor(accountRef) {
  const wanted = typeof accountRef === 'object' && accountRef !== null
    ? (accountRef.id || accountRef.slug || null)
    : accountRef;
  if (!wanted || typeof wanted !== 'string') {
    return null;
  }
  const accounts = await loadAccounts(null, {decrypt: false})
    .catch(() => []);
  const acc = accounts.find(a => a.id === wanted) ??
    accounts.find(a => a.slug === wanted) ??
    null;
  if (!acc?.id) {
    return null;
  }
  const key = KEY_BASE + acc.id;
  const res = await chrome.storage.local.get(key).catch(() => ({}));
  return isValidDelimiter(res[key]) ? res[key] : null;
}
