// data/badge/offscreen.mjs — the local badge counter, running inside the
// shared offscreen document (/offscreen — see manager.mjs there).
//
// READ-ONLY by design: no storage writes, no server, no bridge, no ports.
// Every count is a filesystem read of the local maildir tree on the granted
// root; flag truth is the maildir filename (S=seen, T=deleted), exactly the
// way the client's folder views answer their counters (listLocal() rows
// without \Seen, \Deleted rows excluded, interlopers/untracked visible).
//
// Contract with the manager (see /offscreen/manager.mjs):
//   handle(msg) → routed 'badge-job' messages; resolves the result for the
//                 message's caller. When the count goes out the module
//                 broadcasts 'badge-idle' and pokes the manager's idle hook,
//                 so the shared document can close.
//
// The job carries EVERYTHING the count needs — the offscreen document has no
// chrome.storage — assembled by /badge.mjs on the service worker:
//
//   {type:'badge-job', id, accounts:[{id, label, slug, mode, folder, query}],
//    maxAge}
//
// Folder mode counts the configured folder — INBOX when nothing is
// configured (the badge's default scope). Query mode filters each folder's
// unseen mail through a reduced, header-only search grammar. maxAge
// (minutes, 0 = no limit) restricts the count to unread mail younger than
// the window; its cost is one 64 KB header slice per candidate — the same
// cheap read the client's list rows already pay.

'use strict';

import {bootSilent} from '../sync/disk.mjs';
import {
  accountDir,
  maildirOf,
  folderDir,
  folderFor,
  listLocal
} from '../sync/maildir.mjs';
import {messageMeta} from '../client/headers.mjs';

// header-slice budget per job: gigantic mailboxes degrade to a flag-truth
// count instead of endless parsing (the local-api search caps the same way)
const MAX_HEADER_READS = 3000;
const HEADER_BYTES = 65536;

// the subject list the tooltip shows: subjects of the mails that contribute
// to the count, up to this many per account (the driver renders a flat,
// capped list with one "+N more" line over all accounts)
const MAX_SUBJECTS = 40;

// ------------------------------------------------------------- matching

// Reduced, header-slice-only version of the local search grammar
// (data/client/local-api.mjs): `is:<flag>` off the filename flags and
// free-text/`subject:`/`from:` matches on the header block, `not:` negation
// riding the same shape. Body/to terms and date windows do not exist here —
// only what 64 KB of headers plus the filename flags can decide is decided.
const FLAG_KEYWORDS = new Map([
  ['unseen', 'UNSEEN'],
  ['seen', 'SEEN'],
  ['flagged', 'FLAGGED'],
  ['starred', 'FLAGGED'],
  ['answered', 'ANSWERED'],
  ['deleted', 'DELETED'],
  ['draft', 'DRAFT']
]);

function parseQuery(query) {
  const raw = String(query ?? '').trim();
  if (!raw) {
    return [];
  }
  const terms = [];
  for (const token of raw.split(/\s+/)) {
    if (!token) {
      continue;
    }
    const m = token.match(/^(not:)?(subject|from|is):(.*)$/i);
    const neg = !!m?.[1];
    let key = null;
    let value = token;
    if (m) {
      key = m[2].toLowerCase();
      value = (m[3] ?? '').replace(/^"(.*)"$/, '$1');
      if (!value) {
        continue;
      }
      if (key === 'is' && !FLAG_KEYWORDS.has(value.toLowerCase())) {
        continue;   // unknown flag keyword: term is a no-op filter
      }
    }
    terms.push({neg, key, value});
  }
  return terms;
}

const textHit = (hay, needle) =>
  String(hay ?? '').toLowerCase().includes(String(needle).toLowerCase());

function isHit(flags, meta, term) {
  if (term.key === 'is') {
    const word = term.value.toLowerCase();
    if (word === 'unseen') {
      return !flags.includes('\\Seen');
    }
    if (word === 'seen') {
      return flags.includes('\\Seen');
    }
    return flags.includes('\\' + FLAG_KEYWORDS.get(word));
  }
  if (term.key === 'subject') {
    return textHit(meta.subject, term.value);
  }
  if (term.key === 'from') {
    return textHit(meta.from, term.value);
  }
  return [meta.subject, meta.from].some(v => textHit(v, term.value));
}

function matchUnread(flags, meta, terms) {
  for (const term of terms) {
    const hit = isHit(flags, meta, term);
    if (term.neg ? hit : !hit) {
      return false;
    }
  }
  return true;
}

// true = the candidate trails the window (older than maxAgeAt); a message
// whose Date header does not parse takes the search-engine stance
// (SENTSINCE finds nothing on it) and trails too.
function outsideWindow(meta, maxAgeAt) {
  if (!maxAgeAt) {
    return false;
  }
  const t = Date.parse(String(meta?.date ?? ''));
  return !(Number.isFinite(t) && t >= maxAgeAt);
}

// ---------------------------------------------------------------- scanner

/** Every local Maildir of an account, as server folder names. */
async function accountFolders(account) {
  const out = [];
  for await (const [name, handle] of account.entries()) {
    if (handle.kind === 'directory') {
      const md = await maildirOf(handle);
      if (md) {
        out.push(folderFor(name, '/'));
      }
    }
  }
  return out;
}

function isLiveUnread(entry) {
  if (entry.dir === 'tmp') {
    return false;   // tmp/ is scratch, never live mail
  }
  const flags = entry.flags ?? [];
  return !flags.includes('\\Deleted') && !flags.includes('\\Seen');
}

/**
 * Unread count of one account. Folder mode: `folder` exactly, INBOX when
 * no folder is configured (the default badge scope). Query mode: the query
 * filters every folder's unseen mail. Age filter: applies where the
 * (capped) header reads let it. Returns {count, scanned, subjects, more,
 * detail, error}: `subjects` are the counted mails' subject lines — exactly
 * the mails that contribute to the count — capped at MAX_SUBJECTS, and
 * `more` is the remainder (also set when the header budget ran dry, since
 * those candidates count but cannot show a subject).
 */
async function countAccount(root, spec, maxAgeAt) {
  const account = await accountDir(root, spec.slug, {create: false});
  if (!account) {
    return {count: 0, scanned: 0, subjects: [], more: 0,
      detail: 'no local copy synced yet', error: null, hasMaildir: false};
  }
  const folderSel = String(spec.folder ?? '').trim() || 'INBOX';
  const folders = spec.mode === 'query'
    ? (await accountFolders(account))
    : [folderSel];
  if (spec.mode === 'query') {
    folders.sort((a, b) => (a === 'INBOX' ? -1 : b === 'INBOX' ? 1 : 0));
  }
  const terms = spec.mode === 'query' ? parseQuery(spec.query) : null;
  const budget = {left: MAX_HEADER_READS};
  const subjects = new Set();   // keep duplicates out of the tooltip
  let unread = 0;
  let scanned = 0;
  let remaining = false;   // budget dry / list cap: count kept, subject not shown
  for (const folder of folders) {
    const md = await folderDir(account, folder, {create: false, delimiter: '/'});
    if (!md) {
      continue;
    }
    const local = await listLocal(md, folder);
    for (const entry of local.messages.values()) {
      if (!isLiveUnread(entry)) {
        continue;
      }
      scanned++;
      if (!maxAgeAt && !terms) {
        unread++;   // the common path: filename flags alone
        if (subjects.size >= MAX_SUBJECTS) {
          remaining = true;
          continue;
        }
        // the common path reads its slice now, for the subject line
        budget.left--;
        const fh = await entry.file.getFile().catch(() => null);
        if (fh) {
          const meta = messageMeta(new Uint8Array(
            await fh.slice(0, HEADER_BYTES).arrayBuffer()));
          subjects.add(meta.subject ?? '');
        }
        continue;
      }
      if (budget.left <= 0) {
        // budget dry: fall back to flag truth (the header was already read
        // for this candidate above? not necessarily — count it to keep the
        // badge an upper bound, never an undercount)
        unread++;
        remaining = true;
        continue;
      }
      budget.left--;
      const fh = await entry.file.getFile().catch(() => null);
      if (!fh) {
        continue;   // renamed away mid-scan (flag race), not unknown truth
      }
      const meta = messageMeta(new Uint8Array(
        await fh.slice(0, HEADER_BYTES).arrayBuffer()));
      if (terms) {
        if (!matchUnread(entry.flags ?? [], meta, terms)) {
          continue;
        }
      }
      if (outsideWindow(meta, maxAgeAt)) {
        continue;
      }
      unread++;
      if (subjects.size < MAX_SUBJECTS) {
        subjects.add(meta.subject ?? '');
      }
      else {
        remaining = true;
      }
    }
  }
  return {
    count: unread,
    scanned,
    subjects: [...subjects],
    more: unread - subjects.size,
    hasMaildir: true,
    detail: (spec.mode === 'query'
      ? 'query · all folders'
      : 'folder: ' + folderSel) +
      (budget.left <= 0 ? ' — header budget exhausted, counts are flag-truth' : ''),
    error: null
  };
}

// ---------------------------------------------------------------- handle

async function handle(msg) {
  if (msg?.type !== 'badge-job' || !msg?.id) {
    return null;
  }
  const accounts = Array.isArray(msg.accounts) ? msg.accounts : [];
  const result = {
    time: Date.now(),
    total: 0,
    accounts: []
  };
  try {
    const verdict = await bootSilent();
    if (!verdict.ok || !(verdict.handle instanceof FileSystemDirectoryHandle)) {
      // a lapsed pick or a failing gate: nothing can be read. Report the
      // condition on every account (the sync engine narrates the same
      // verdicts over its own log channel).
      const why = verdict.reason === 'need-regrant'
        ? 'directory access needs re-granting'
        : verdict.reason === 'gate-failure'
          ? 'storage gate failed: ' + (verdict.error || 'unknown error')
          : 'no granted directory (run the picker)';
      result.maildir = false;   // no Maildir was checked — icon stays default
      for (const spec of accounts) {
        result.accounts.push({
          id: spec.id,
          label: spec.label || spec.id,
          count: 0,
          detail: why
        });
      }
    }
    else {
      const maxAgeMinutes = Math.max(0, Math.round(Number(msg.maxAge) || 0));
      const maxAgeAt = maxAgeMinutes ? Date.now() - maxAgeMinutes * 60000 : 0;
      for (const spec of accounts) {
        const entry = {
          id: spec.id,
          label: spec.label || spec.id,
          count: 0,
          detail: '',
          error: null
        };
        try {
          const r = await countAccount(verdict.handle, spec, maxAgeAt);
          entry.count = r.count;
          entry.detail = r.detail;
          entry.hasMaildir = r.hasMaildir !== false;
          // the tooltip's flat subject list: exactly the mails that
          // contribute to the count, capped — `more` is the remainder
          entry.subjects = (r.subjects ?? []).map(s =>
            String(s ?? '').replace(/\s+/g, ' ').trim());
          entry.more = Math.max(0, r.more ?? 0);
        }
        catch (e) {
          entry.error = e?.message || String(e);
        }
        result.accounts.push(entry);
      }
      result.total = result.accounts.reduce((sum, a) =>
        sum + (a.error ? 0 : (a.count || 0)), 0);
      // at least one account had a readable Maildir → the zero is real
      result.maildir = result.accounts.some(a => a.hasMaildir);
    }
  }
  catch (e) {
    result.error = e?.message || String(e);
  }
  // badge is done the moment the result goes out — the shared document can
  // go off unless another module still has work
  try {
    chrome.runtime.sendMessage({type: 'badge-idle'}).catch(() => {});
  }
  catch {}
  globalThis.__offscreen?.idle('badge');
  return result;
}

export {handle};
