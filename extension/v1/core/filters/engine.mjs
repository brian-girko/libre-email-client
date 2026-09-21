'use strict';

// Email filter engine core. Environment-agnostic (runs in the service
// worker): no DOM, no prompts, no status plumbing — orchestration lives in
// the callers (the worker's filters.mjs module: standalone runs and the
// badge pre-pass).
//
// Enabled filters are evaluated in list order (first match wins) and act on
// new messages in INBOX by either moving them to an IMAP folder on the
// server or saving a raw .eml copy to a local directory (via the native
// client) and deleting the message from the server.
//
// Evaluation runs server-side only (the engine's shared session, through
// openServerApi): reads and moves/deletes touch the IMAP server directly
// and the local mirror ingests the results afterwards, when the engine
// syncs — so a pass always acts on the server before its mail reaches the
// local clone. No $Filtered keyword is written anymore: a pass moves mail
// out of INBOX for good, and mail moved back by hand is re-evaluated like
// any other unread message.
//
// The options page's "Run filters now" button can request a one-off 'unread'
// sweep instead: every unread message in INBOX is evaluated regardless of
// the watermark, and the watermark itself is left untouched — automatic
// runs keep treating exactly the same mail as new.
//
// Matching criteria: each filter holds a query in a tiny notmuch-like
// language (core/filters/query.mjs): field:value terms (subject:, from: —
// with the sender: alias —, to:, body:), bare words matching anywhere
// (including the body), "quoted phrases", and/or/not and parentheses; the
// query's lines are alternatives (a message matches when any line matches)
// and an empty query matches every message. The to/body fields need the
// parsed
// message (postal-mime); that single fetch/parse is only attempted when a
// query term actually reaches it, and bodies are cached per uid so repeated
// evaluations hit the mirror.
//
// Filters stored in the old per-category format (no 'query' key) are
// ignored — noted once per run, never migrated: edit and re-save them on
// the options page to convert them. A filter whose query does not parse is
// dropped with a note; neither ever parks the watermark.
//
// Filters stored in the old per-category format (no 'query' key) are
// ignored — noted once per run, never migrated: edit and re-save them on
// the options page to convert them. A filter whose query does not parse is
// dropped with a note; neither ever parks the watermark.
//
// A per-account watermark in chrome.storage.local tracks the last fully
// processed UID. There is no interactive first-run prompt here (a worker
// cannot confirm()): the options page stores the decision made when the
// first filter for an account was saved ('filters.firstRun.<accountId>':
// 'process' | 'skip') and this engine honors it on the account's first run.

import {openServerApi, engine as syncEngine} from '../sync/engine.mjs';
import {writeFile} from '../native/native-client.mjs';
import postalMime from '../parser/postal-mime.mjs';
import {resolvePassword} from '../creds.mjs';
import {parseQuery, matchesQuery} from './query.mjs';

const INBOX = 'INBOX';

const fieldKey = (name, id) => name + '.' + id;
const msg = e => e?.message || String(e);

// ---- watermark helpers ----

function wmKey(accountId) {
  return 'filters.wm.' + accountId + '.INBOX';
}

async function getWatermark(accountId) {
  const res = await chrome.storage.local.get(wmKey(accountId));
  return res[wmKey(accountId)] || null;
}

async function setWatermark(accountId, uid, uidvalidity) {
  await chrome.storage.local.set({
    [wmKey(accountId)]: {uid, uidvalidity}
  });
}

// ---- first-run decision (stored by the options page filter editor) ----

function decisionKey(accountId) {
  return 'filters.firstRun.' + accountId;
}

// 'process' runs the existing-unread backfill on the account's first run;
// anything else parks the watermark so only mail arriving from now on is
// filtered.
async function getFirstRunDecision(accountId) {
  const res = await chrome.storage.local.get(decisionKey(accountId));
  return res[decisionKey(accountId)] === 'process' ? 'process' : 'skip';
}

// ---- filter evaluation ----

// Parse every filter's query once per run. Old-format filters (per-category
// values, no 'query' key) are ignored with a single note — edit and re-save
// them on the options page to convert. A query that fails to parse drops
// its filter with a note; neither ever parks the watermark.
function prepareFilters(filters, entry) {
  const parsed = [];
  let legacyNoted = false;
  for (const filter of filters) {
    if (typeof filter.query !== 'string') {
      if (!legacyNoted) {
        entry.errors.push('old-format filter ignored — edit and save it in the options to convert it');
        legacyNoted = true;
      }
      continue;
    }
    try {
      parsed.push({filter, ast: parseQuery(filter.query)});
    }
    catch (e) {
      const cut = filter.query.trim().replace(/\s+/g, ' ').slice(0, 60);
      entry.errors.push('filter dropped (' + cut + '): ' + msg(e));
    }
  }
  return parsed;
}

function stripTags(html) {
  return String(html || '').replace(/<[^>]+>/g, ' ');
}

// A listed message whose server body has no bytes left (expunge pending
// after another client's delete): to/body conditions can't be evaluated.
function isBodyFetchError(e) {
  return /no body returned/i.test(String(e?.message ?? e));
}

// Body text and the To header of one message: the To header is not part of
// the list summaries (the wasm core's fetch_summaries omits it), so a "to"
// condition needs the parsed message just like a "body" condition does —
// both share this single fetch/parse (bodies are cached per uid, so repeated
// evaluations hit the mirror).
async function fetchEmailFields(api, uid) {
  const raw = await api.readFile(uid);
  const email = await postalMime.parse(raw);
  const parts = [];
  if (email.text) {
    parts.push(email.text);
  }
  if (email.html) {
    parts.push(stripTags(email.html));
  }
  const to = (Array.isArray(email.to) ? email.to : [])
    .map(a => [a?.name, a?.address].filter(Boolean).join(' '))
    .filter(Boolean)
    .join(' ');
  return {bodyText: parts.join(' '), to};
}

// ---- save stamp (mirrors list.mjs) ----

function saveStamp() {
  const p = n => String(n).padStart(2, '0');
  const d = new Date();
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
    + 'T' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}

// Enabled filters that apply to one account ('' = all accounts).
export async function filtersForAccount(accountId) {
  const res = await chrome.storage.local.get({filters: []});
  const filters = Array.isArray(res.filters) ? res.filters : [];
  return filters.filter(f => f.enabled && (!f.accountId || f.accountId === accountId));
}

// ---- core per-account pass ----

// Scan the whole INBOX and apply the filters to every unread message,
// oldest first. Shared by the first-run backfill (which advances the
// watermark as it goes) and the manual 'all unread' run (which never
// touches it). Returns {failedUid, lastGood}: failedUid is the uid that
// failed (processing stopped there), lastGood the last fully processed uid.
async function applyToUnread({api, accountId, parsed, entry, uidvalidity, trackWatermark, onProgress}) {
  const pageSize = 500;
  const all = [];
  for (let page = 0; ; page++) {
    const batch = await api.listFiles({page, pageSize});
    all.push(...batch);
    if (batch.length < pageSize) {
      break;
    }
  }
  const unread = all.filter(m => !m.flags.includes('\\Seen'));
  unread.sort((a, b) => a.uid - b.uid);
  let failedUid = null;
  let lastGood = null;
  let done = 0;
  for (const summary of unread) {
    if (!await applyFilters(api, parsed, summary, entry)) {
      failedUid = summary.uid;
      break;
    }
    lastGood = summary.uid;
    if (typeof onProgress === 'function') {
      onProgress(entry, ++done, unread.length);
    }
    if (trackWatermark) {
      await setWatermark(accountId, lastGood, uidvalidity);
    }
  }
  return {failedUid, lastGood};
}

// Apply the account's filters inside a connected api session: opens INBOX,
// then processes everything newer than the watermark. entry collects
// {moved, deleted, errors}. On a per-message error the watermark parks just
// before the failing UID so the next run retries from there.
// scope 'unread' (the options page's "Run filters now" button) replaces the
// watermark logic with a one-off sweep over all unread mail instead.
export async function runAccountFilters({api, accountId, filters, entry, scope, onProgress}) {
  const parsed = prepareFilters(filters, entry);
  const status = await api.openDir(INBOX);
  const uidnext = Number(status.uidnext) || 1;
  const uidvalidity = Number(status.uidvalidity) || 0;

  // manual sweep: apply the filters to every unread message in INBOX,
  // regardless of the watermark, and leave the watermark alone so the
  // automatic runs keep treating exactly the same mail as new. On a
  // per-message error the sweep stops and reports; the next press retries
  // (moved/deleted mail is gone, no-match mail is simply re-evaluated).
  if (scope === 'unread') {
    await applyToUnread({api, accountId, parsed, entry, uidvalidity, trackWatermark: false, onProgress});
    return entry;
  }

  let wm = await getWatermark(accountId);

  // uidvalidity changed — folder rebuilt; reset
  if (wm && wm.uidvalidity !== uidvalidity) {
    wm = null;
  }

  if (!wm) {
    // first run or validity reset: honor the decision stored when the first
    // filter for this account was saved on the options page
    if (await getFirstRunDecision(accountId) === 'process') {
      const {failedUid, lastGood} = await applyToUnread({
        api, accountId, parsed, entry, uidvalidity, trackWatermark: true, onProgress
      });
      if (failedUid == null) {
        // whole pre-existing set done (processed or nothing unread):
        // mark everything below uidnext so skipped (read) mail is
        // never re-scanned
        await setWatermark(accountId, uidnext - 1, uidvalidity);
      }
      else if (lastGood == null) {
        // failed on the very first unread message: park the watermark
        // just before it so the next run retries through the normal
        // (non-confirming) path instead of re-running the backfill
        await setWatermark(accountId, Math.max(0, failedUid - 1), uidvalidity);
      }
      // else: partial success — watermark already parked at the last
      // good UID; the tail (starting at the failed UID) is retried
    }
    else {
      await setWatermark(accountId, uidnext - 1, uidvalidity);
    }
    return entry;
  }

  // normal run: messages newer than watermark
  const fromUid = (wm.uid || 0) + 1;
  if (fromUid >= uidnext) {
    // no new messages
    return entry;
  }
  const newMessages = await api.listFiles({fromUid, toUid: uidnext - 1});
  if (!newMessages.length) {
    // range is empty (all expunged); advance watermark
    await setWatermark(accountId, uidnext - 1, uidvalidity);
    return entry;
  }
  newMessages.sort((a, b) => a.uid - b.uid);

  let done = 0;
  for (const summary of newMessages) {
    const processed = await applyFilters(api, parsed, summary, entry);
    if (processed) {
      await setWatermark(accountId, summary.uid, uidvalidity);
      if (typeof onProgress === 'function') {
        onProgress(entry, ++done, newMessages.length);
      }
    }
    else {
      break; // error — retry from here next run
    }
  }
  return entry;
}

// Record a per-message change {uid, from, to} on the pass entry (to === null
// when the message left the server entirely). Keeping the last 200 bounds
// the entry that ends up in activity events and 'filters.last'.
function recordChange(entry, uid, to) {
  const changes = entry.changes || (entry.changes = []);
  if (changes.length >= 200) {
    changes.shift();
  }
  changes.push({uid, from: INBOX, to});
}

// Returns true when the message was fully processed (acted or no match),
// false on error (caller stops and retries next run).
async function applyFilters(api, parsed, summary, entry) {
  for (const {filter, ast} of parsed) {
    try {
      // Lazy field provider for the query evaluator: subject/from come from
      // the list summary; to/body share one fetch/parse (cached per uid)
      // that only happens when the query actually reaches such a term. A
      // bare term (null field) matches anywhere, so it needs everything.
      let fields = null;
      let fieldsFailed = false;
      const getField = async field => {
        if (field === 'subject') {
          return String(summary.subject ?? '');
        }
        if (field === 'from') {
          return String(summary.from ?? '');
        }
        if (!fields) {
          if (fieldsFailed) {
            return '';
          }
          // A body that no longer fetches (expunge pending — "no body
          // returned") must not abort the whole pass: the failing terms
          // just don't match this message and evaluation falls back to
          // the summary fields (subject/from), which stay available.
          try {
            fields = await fetchEmailFields(api, summary.uid);
          }
          catch (e) {
            if (isBodyFetchError(e)) {
              fieldsFailed = true;
              entry.errors.push('uid ' + summary.uid + ': fields unavailable — ' + msg(e));
              return '';
            }
            throw e;
          }
        }
        if (field === 'to') {
          return fields.to;
        }
        if (field === 'body') {
          return fields.bodyText;
        }
        // bare term: anywhere, including the parsed fields
        return [summary.subject, summary.from, fields.to, fields.bodyText]
          .map(v => String(v ?? '')).join(' ');
      };
      if (!await matchesQuery(ast, getField)) {
        continue;
      }

      // first match — act
      if (filter.action === 'move') {
        const target = filter.folder.trim();
        if (!target) {
          throw new Error('no target folder specified');
        }
        if (filter.createFolder) {
          const dirs = await api.listDirs();
          if (!dirs.some(d => d.name === target)) {
            await api.createDir(target);
          }
        }
        await api.moveTo([summary.uid], target);
        entry.moved++;
        recordChange(entry, summary.uid, target);
      }
      else if (filter.action === 'eml') {
        const dir = filter.dir.trim();
        if (!dir) {
          throw new Error('no destination directory specified');
        }
        const raw = await api.readFile(summary.uid);
        await writeFile({dir, name: saveStamp() + '-' + Number(summary.uid) + '.eml', data: raw});
        // delete only after the copy succeeded: a failed save must leave the
        // message re-processable on the next run
        await api.deleteMessages([summary.uid]);
        entry.deleted++;
        recordChange(entry, summary.uid, null);
      }
      return true;
    }
    catch (e) {
      entry.errors.push('uid ' + summary.uid + ': ' + msg(e));
      return false;
    }
  }
  // no filter matched — message processed (watermark should advance)
  return true;
}

// ---- standalone pass ----

function labelFor(accounts, accountId) {
  const account = (Array.isArray(accounts) ? accounts : []).find(a => a.id === accountId);
  return account?.label || accountId;
}

// Apply every enabled filter to its account(s), server-side through the
// engine's shared session (one pass runs before the mirror ingests its
// results). scope 'unread' (the options page's "Run filters now" button)
// sweeps all unread INBOX mail instead of the watermark's new messages.
// Returns the run result:
//   {time, accounts: [{id, label, moved, deleted, errors}], total}
export async function runFilters({scope, onAccountStart, onAccountEnd, onAccountProgress} = {}) {
  const res = await chrome.storage.local.get({filters: [], accounts: []});
  const filters = Array.isArray(res.filters) ? res.filters : [];
  const accounts = Array.isArray(res.accounts) ? res.accounts : [];
  const enabled = filters.filter(f => f.enabled);
  if (!enabled.length || !accounts.length) {
    return {time: Date.now(), accounts: [], total: 0};
  }

  // group filters by accountId ('' = all accounts)
  const perAccount = new Map();
  for (const f of enabled) {
    const ids = f.accountId ? [f.accountId] : accounts.map(a => a.id);
    for (const id of ids) {
      if (!perAccount.has(id)) {
        perAccount.set(id, []);
      }
      perAccount.get(id).push(f);
    }
  }

  const result = {time: Date.now(), accounts: []};
  for (const accountId of perAccount.keys()) {
    result.accounts.push(await runAccountSession(
      accountId, perAccount.get(accountId), accounts,
      {scope, syncMode: 'light', reason: 'filters', onAccountStart, onAccountEnd, onAccountProgress}
    ));
  }

  result.total = result.accounts.reduce((s, a) => s + a.moved + a.deleted, 0);
  return result;
}

// One server-side filter pass per account: reads and mutations run against
// the IMAP server through the engine's shared session (openServerApi) — the
// mirror learns the results only afterwards, through the engine's sync, so
// filters always act before mail is stored to the local clone. Account-level
// problems (missing config/bridge) land in entry.errors so the status
// surfaces stay informative; a missing password is not an error: the account
// is skipped silently and the storage listener re-runs the pass once a
// password lands in session storage.
async function runAccountSession(accountId, accountFilters, accounts, {scope, syncMode, reason, onAccountStart, onAccountEnd, onAccountProgress}) {
  const entry = {
    id: accountId, label: labelFor(accounts, accountId),
    moved: 0, deleted: 0, errors: [],
    // one {uid, from, to} record per acted message (to === null: the mail
    // left the server entirely via the .eml action); capped so a large
    // backfill cannot grow the activity payload without bound
    changes: []
  };
  if (typeof onAccountStart === 'function') {
    try {
      onAccountStart(entry);
    }
    catch {}
  }
  let api = null;
  try {
    const cfgRes = await chrome.storage.local.get([
      fieldKey('imap.host', accountId),
      fieldKey('imap.port', accountId),
      fieldKey('imap.secure', accountId),
      fieldKey('imap.allowSelfSigned', accountId),
      fieldKey('user.name', accountId)
    ]);
    const host = cfgRes[fieldKey('imap.host', accountId)];
    const port = Number(cfgRes[fieldKey('imap.port', accountId)]);
    const user = cfgRes[fieldKey('user.name', accountId)];
    if (!host || !port || !user) {
      entry.errors.push('account not configured');
      return entry;
    }
    const pass = await resolvePassword(accountId);
    if (!pass) {
      // master not confirmed this session (or none stored yet): skip quietly
      // instead of failing the pass with "no password available"
      return entry;
    }
    api = await openServerApi(accountId);
    await runAccountFilters({api, accountId, filters: accountFilters, entry, scope, onProgress: onAccountProgress});
  }
  catch (e) {
    if (e?.code !== 'credential') {
      entry.errors.push(msg(e));
    }
  }
  finally {
    if (api) {
      try {
        await api.close();
      }
      catch {}
    }
    // The pass acted (or not) on the server: land the results in the mirror
    // right away so the local clone never stays pre-filter. Post-pass sync
    // (light mode: only folders whose fences moved get re-read).
    if (entry.moved || entry.deleted) {
      try {
        await syncEngine.sync(accountId, {mode: syncMode ?? 'light', reason: reason ?? 'filters'});
      }
      catch {}
    }
    // Always fires, including the early returns above (not configured, no
    // password, bridge unavailable), so a started jobs-bar line is never left
    // dangling.
    if (typeof onAccountEnd === 'function') {
      try {
        onAccountEnd(entry);
      }
      catch {}
    }
  }
  return entry;
}