// route.mjs — filter routing: one raw email in, its destination folder out.
//
// The bridge between the options-page filter list (chrome.storage.local
// or chrome.storage.sync — the area is chosen by the 'storage.type.filters'
// pref in chrome.storage.local, 'local' by default; see getFiltersArea
// below) and the matcher in query.mjs. routeMessage(raw, opts)
// parses the message with the bundled postal-mime parser, walks the filter
// list in stored order (first match wins — the options page's rule) and
// reports WHAT matched: a move filter's destination folder (plus its
// createFolder wish so the caller can create the directory before
// moving) or a stop filter's "leave it, and skip the remaining filters".
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

/** Minimal HTML→text for the body haystack: comments, script and style
 *  blocks dropped, tags stripped, the common entities decoded — so a
 *  `body:` contains-match sees words, not markup. */
function htmlToText(html) {
  if (typeof html !== 'string' || !html.trim()) {
    return '';
  }
  return html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Parses a raw RFC822 message into the field shape query.mjs's matcher
 * expects. From/To become plain strings so the case-insensitive
 * contains-matching sees names and addresses alike; recipients of To AND
 * Cc are joined into one string, plus the envelope recipients a To/Cc
 * view never sees (Delivered-To, X-Original-To, List-Id — Bcc and list
 * delivery). When the message has no text part the HTML body stands in
 * for bodyText, stripped of tags (contains-matching works the same).
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
  // Delivered-To / X-Original-To name the recipient on Bcc and
  // mailing-list delivery (the address parser only sees To/Cc headers);
  // List-Id identifies the list when its address appears nowhere else.
  // All three join the `to` haystack so to:- and bare-word filters match
  // list mail that a To/Cc-only view could never see.
  const envelope = (parsed.headers ?? [])
    .filter(h => h && ['delivered-to', 'x-original-to', 'list-id'].includes(h.key))
    .map(h => String(h.value ?? '').trim())
    .filter(Boolean);
  const to = [...(parsed.to ?? []), ...(parsed.cc ?? [])]
    .map(addressText)
    .filter(Boolean)
    .concat(envelope)
    .join(', ');
  const msg = {
    subject: String(parsed.subject ?? ''),
    from,
    to,
    bodyText: typeof parsed.text === 'string' && parsed.text.trim()
      ? parsed.text
      : htmlToText(parsed.html)
  };
  return {ok: true, msg, parsed};
}

/**
 * Decides the destination of one email: parses it, walks the filter list
 * in order and reports the folder of the first filter that matches.
 * moving); a winning 'stop' filter (action === 'stop') names no folder —
 * it means "leave this message alone, later filters are not consulted".
 * Skipped: disabled filters, filters scoped to another account
 * (accountId '' = all accounts) and legacy entries whose query is not a
 * string ("old format — edit and save again" rows never match). An empty
 * query matches nothing, exactly like the query language itself.
 * @param {Uint8Array} raw raw RFC822 message bytes
 * @param {{filters: Array, accountId?: string|null}} opts filters as
 *   stored by the options page ({id, enabled, accountId, query, action,
 *   folder, createFolder, description}); accountId of the mail's own
 *   account
 * @returns {Promise<{matched: boolean, parsed: boolean,
 *            action: string|null, folder: string|null,
 *            createFolder: boolean,
 *            filter: {id, description}|null, detail: object|null}>}
 *   action is 'move' | 'stop' | null (nothing matched); folder is the
 *   winning move filter's destination, null for a stop winner. parsed is
 *   false only when the message could not be parsed — the filter walk
 *   never ran, which the sync engine's post-sync fallback keys on
 *   (a parse failure must never be treated as a final no-match).
 */
export async function routeMessage(raw, {filters, accountId = null} = {}) {
  // parsed: whether the filter walk actually RAN. A parse failure must not
  // read as "no match" — the sync engine keys its post-sync filter
  // fallback (routeLanding / runPostSyncFilters) on this flag, so an
  // unparseable message stays unrouted and is retried on the next pass
  // instead of being silently anchored in INBOX forever.
  const none = {matched: false, action: null, folder: null, createFolder: false, filter: null, detail: null, parsed: true};
  const parsed = await parseMessage(raw);
  if (!parsed.ok) {
    return {...none, parsed: false, detail: {reason: parsed.reason}};
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
    const stop = filter.action === 'stop';
    if (!stop && !filter.folder) {
      continue;   // a move filter without a destination is not runnable
    }
    const detail = filterMatches(filter.query, parsed.msg);
    if (detail.matched) {
      return {
        matched: true,
        parsed: true,
        action: stop ? 'stop' : 'move',
        folder: stop ? null : String(filter.folder ?? ''),
        createFolder: stop ? false : !!filter.createFolder,
        filter: {id: filter.id ?? null, description: filter.description ?? ''},
        // the winner's subject, for pull-time narration lines shaped like
        // the filter runner's ("subject" -> Line n of Filter N -> dest)
        subject: String(parsed.msg.subject ?? ''),
        detail
      };
    }
  }
  return none;
}

/**
 * Which chrome.storage area holds the filter list right now. The pref
 * 'storage.type.filters' is 'local' | 'sync' and always lives in
 * chrome.storage.local (it has to be readable before we know where to
 * look for anything else). Anything other than 'sync' falls back to
 * 'local', so old installs without the pref keep working as before.
 * @returns {Promise<'local'|'sync'>}
 */
export async function getFiltersArea() {
  const res = await chrome.storage.local
    .get({'storage.type.filters': 'local'})
    .catch(() => ({'storage.type.filters': 'local'}));
  return res['storage.type.filters'] === 'sync' ? 'sync' : 'local';
}

/**
 * Reads the filter list of one specific area (no mode lookup — used for
 * migration on a mode switch). Unknown shapes are dropped, like the
 * options page does.
 * @param {'local'|'sync'} area
 * @returns {Promise<Array<object>>}
 */
export async function getFiltersFrom(area) {
  const res = await chrome.storage[area].get({filters: []});
  return (Array.isArray(res.filters) ? res.filters : [])
    .filter(f => f && typeof f === 'object');
}

/**
 * Writes the filter list to one specific area.
 * @param {'local'|'sync'} area
 * @param {Array<object>} list
 * @returns {Promise<void>} rejects with the write error (the options
 *   page surfaces quota failures to the user)
 */
export async function saveFiltersTo(area, list) {
  await chrome.storage[area].set({filters: list});
}

/**
 * The filter list as the options page stores it, read from the active
 * area ('local' or 'sync' per getFiltersArea). Interface-side only —
 * the offscreen document has no chrome.storage and receives the list as
 * a parameter instead.
 * @returns {Promise<Array<object>>}
 */
export async function loadFilters() {
  return getFiltersFrom(await getFiltersArea());
}
