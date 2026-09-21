// route.mjs — filter routing: one raw email in, its destination folder out.
//
// The bridge between the options-page filter list (chrome.storage.local,
// key 'filters') and the matcher in query.mjs. routeMessage(raw, opts)
// parses the message with the bundled postal-mime parser, walks the filter
// list in stored order (first match wins — the options page's rule) and
// returns the folder the message has to be delivered to, plus the filter's
// createFolder wish so the caller can create the directory before moving.
//
// Callers: the sync interface (via loadFilters) and the offscreen engine.
// The offscreen document has no chrome.storage, so the filter LIST always
// travels to routeMessage as a parameter — loadFilters() is the
// interface-side convenience only.

'use strict';

import PostalMime from '/core/parser/postal-mime.mjs';
import {filterMatches} from './query.mjs';

/** `"Name" <addr>` from one postal-mime address entry (either half optional) */
function addressText(entry) {
  if (!entry || typeof entry !== 'object') {
    return '';
  }
  const name = String(entry.name ?? '').trim();
  const address = String(entry.address ?? '').trim();
  if (name && address) {
    return `${name} <${address}>`;
  }
  return address || name;
}

/**
 * Parses a raw RFC822 message into the field shape query.mjs's matcher
 * expects. From/To become plain strings so the case-insensitive
 * contains-matching sees names and addresses alike; recipients of To AND
 * Cc are joined into one string. When the message has no text part the
 * HTML body stands in for bodyText (contains-matching works the same).
 * @param {Uint8Array} raw
 * @returns {Promise<{ok: true, msg: {subject, from, to, bodyText},
 *            parsed: object} | {ok: false, reason: string}>}
 */
export async function parseMessage(raw) {
  let parsed;
  try {
    parsed = await PostalMime.parse(raw);
  }
  catch (e) {
    return {ok: false, reason: 'unparseable: ' + (e?.message || e)};
  }
  const from = addressText(parsed.from) || addressText(parsed.sender);
  const to = [...(parsed.to ?? []), ...(parsed.cc ?? [])]
    .map(addressText)
    .filter(Boolean)
    .join(', ');
  const msg = {
    subject: String(parsed.subject ?? ''),
    from,
    to,
    bodyText: typeof parsed.text === 'string' && parsed.text.trim()
      ? parsed.text
      : String(parsed.html ?? '')
  };
  return {ok: true, msg, parsed};
}

/**
 * Decides the destination of one email: parses it, walks the filter list
 * in order and reports the folder of the first filter that matches.
 * Skipped: disabled filters, filters scoped to another account
 * (accountId '' = all accounts) and legacy entries whose query is not a
 * string ("old format — edit and save again" rows never match). An empty
 * query matches nothing, exactly like the query language itself.
 * @param {Uint8Array} raw raw RFC822 message bytes
 * @param {{filters: Array, accountId?: string|null}} opts filters as
 *   stored by the options page ({id, enabled, accountId, query, folder,
 *   createFolder, description}); accountId of the mail's own account
 * @returns {Promise<{matched: boolean, folder: string|null,
 *            createFolder: boolean, filter: {id, description}|null,
 *            detail: object|null}>}
 */
export async function routeMessage(raw, {filters, accountId = null} = {}) {
  const none = {matched: false, folder: null, createFolder: false, filter: null, detail: null};
  const parsed = await parseMessage(raw);
  if (!parsed.ok) {
    return {...none, detail: {reason: parsed.reason}};
  }
  for (const filter of Array.isArray(filters) ? filters : []) {
    if (!filter || typeof filter !== 'object' || filter.enabled === false) {
      continue;
    }
    if (filter.accountId && filter.accountId !== accountId) {
      continue;
    }
    if (typeof filter.query !== 'string') {
      continue;   // legacy row: can never match until edited and saved
    }
    const detail = filterMatches(filter.query, parsed.msg);
    if (detail.matched) {
      return {
        matched: true,
        folder: String(filter.folder ?? ''),
        createFolder: !!filter.createFolder,
        filter: {id: filter.id ?? null, description: filter.description ?? ''},
        detail
      };
    }
  }
  return none;
}

/**
 * The filter list as the options page stores it. Interface-side only —
 * the offscreen document has no chrome.storage and receives the list as
 * a parameter instead.
 * @returns {Promise<Array<object>>}
 */
export async function loadFilters() {
  const stored = await chrome.storage.local.get({filters: []});
  return (Array.isArray(stored.filters) ? stored.filters : [])
    .filter(f => f && typeof f === 'object');
}
