'use strict';

// search.mjs — local search over the mirror.
//
// The old client sent IMAP SEARCH criteria to the server; with the local
// IMAP clone in place the same query language is evaluated against the
// mirrored messages. Only messages present in the mirror are searchable, and
// header-only fields (subject/from) answer from the folder index while
// `to:`/`body:`/bare terms lazily parse the stored .eml (postal-mime) — one
// parse per message per query, memoized for the duration of the run.
//
// Semantics follow the old buildCriteria()/server SEARCH behavior:
// multiple terms are ANDed, `not:` negates, `since:/before:` take RFC dates,
// `is:` takes flag keywords (unseen/seen/flagged/answered/deleted).

import postalMime from '../parser/postal-mime.mjs';
import {threadSummaries} from './store.mjs';

// ---- query parsing -----------------------------------------------------------

const FLAG_KEYWORDS = {
  unseen: 'UNSEEN',
  seen: 'SEEN',
  flagged: 'FLAGGED',
  answered: 'ANSWERED',
  deleted: 'DELETED',
};

function tokenValue(token) {
  return Object.hasOwn(FLAG_KEYWORDS, token) ? FLAG_KEYWORDS[token] : null;
}

// Returns a list of terms: {neg, key, value, raw} — key is 'from' | 'to' |
// 'subject' | 'body' | 'text' | 'since' | 'before' | 'is' | null (bare).
export function parseQuery(query) {
  const raw = String(query ?? '').trim();
  if (!raw) {
    return [];
  }
  const terms = [];
  for (const token of raw.split(/\s+/)) {
    if (!token) {
      continue;
    }
    const m = token.match(/^(not:)?(from|to|subject|body|text|since|before|is):(.*)$/i);
    const neg = !!m?.[1];
    if (!m) {
      terms.push({neg, key: null, value: token, raw: token});
      continue;
    }
    const key = m[2].toLowerCase();
    // drop paired surrounding quotes (quoted phrases) from the value
    const value = (m[3] ?? '').replace(/^"(.*)"$/, '$1');
    if (/^(since|before)$/.test(key) && !value) {
      continue; // bare key without a date: dropped
    }
    if (/^is$/.test(key) && !value) {
      continue;
    }
    terms.push({neg, key, value, raw: token});
  }
  return terms;
}

// ---- message field resolution (lazy, memoized) ------------------------------

function stripTags(html) {
  return String(html || '').replace(/<[^>]+>/g, ' ');
}

// One lazy parse cache per search run. Body reads go through getBody(dir,uid)
// — the mirror (or its fetch fallback) wraps this.
function makeFieldResolver(mirror, getBodyOverride) {
  const cache = new Map(); // `${dir}\u0000${uid}` -> {bodyText, to}
  return async (dirName, uid) => {
    const key = dirName + '\u0000' + uid;
    let fields = cache.get(key);
    if (!fields) {
      let text = '';
      let to = '';
      try {
        const raw = getBodyOverride
          ? await getBodyOverride(dirName, uid)
          : await mirror.getBody(dirName, uid);
        if (raw) {
          const email = await postalMime.parse(raw);
          const parts = [];
          if (email.text) {
            parts.push(email.text);
          }
          if (email.html) {
            parts.push(stripTags(email.html));
          }
          text = parts.join(' ');
          to = (Array.isArray(email.to) ? email.to : [])
            .map(a => [a?.name, a?.address].filter(Boolean).join(' '))
            .filter(Boolean)
            .join(' ');
          // addresses in HTML mail come bare; add the header form too
        }
      }
      catch {
        // unreadable body: header-only matching for this message
      }
      fields = {bodyText: text, to};
      cache.set(key, fields);
    }
    return fields;
  };
}

// ---- matching ------------------------------------------------------------------

function hasAnyFlag(flags, keyword) {
  const set = Array.isArray(flags) ? flags.map(String) : [];
  switch (keyword) {
    case 'UNSEEN': return !set.includes('\\Seen');
    case 'SEEN': return set.includes('\\Seen');
    case 'FLAGGED': return set.includes('\\Flagged');
    case 'ANSWERED': return set.includes('\\Answered');
    case 'DELETED': return set.includes('\\Deleted');
    default: return false;
  }
}

function dateMatches(term, message) {
  const t = Date.parse(String(message.date ?? ''));
  if (!t) {
    return false;
  }
  const d = new Date(t);
  const day = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const dd = new Date(term.date);
  const cmp = new Date(dd.getFullYear(), dd.getMonth(), dd.getDate()).getTime();
  return term.key === 'since' ? day >= cmp : day < cmp;
}

function textHits(hay, needle) {
  return String(hay ?? '').toLowerCase().includes(String(needle).toLowerCase());
}

// Evaluate one message against the parsed terms; fields(field) resolves the
// lazy `to`/`body`/`text` extras. All terms must pass (IMAP AND semantics);
// a `not:` term must fail.
async function matchMessage(message, terms, dirName, resolveFields) {
  for (const term of terms) {
    let hit = false;
    if (term.key === null) {
      // bare term: anywhere — headers first (cheap), then the parsed fields
      const needleLc = term.value.toLowerCase();
      hit = [message.subject, message.from, String(message.date ?? '')]
        .some(v => String(v ?? '').toLowerCase().includes(needleLc));
      if (!hit) {
        const fields = await resolveFields(dirName, message.uid);
        hit = [fields.to, fields.bodyText].some(v => String(v ?? '').toLowerCase().includes(needleLc));
      }
    }
    else if (term.key === 'subject') {
      hit = String(message.subject ?? '').toLowerCase().includes(term.value.toLowerCase());
    }
    else if (term.key === 'from') {
      hit = String(message.from ?? '').toLowerCase().includes(term.value.toLowerCase());
    }
    else if (term.key === 'to' || term.key === 'body' || term.key === 'text') {
      const fields = await resolveFields(dirName, message.uid);
      if (term.key === 'to') {
        hit = String(fields.to).toLowerCase().includes(term.value.toLowerCase());
      }
      else if (term.key === 'body') {
        hit = String(fields.bodyText).toLowerCase().includes(term.value.toLowerCase());
      }
      else {
        // text: headers plus parsed fields
        hit = [message.subject, message.from, fields.to, fields.bodyText]
          .some(v => String(v ?? '').toLowerCase().includes(term.value.toLowerCase()));
      }
    }
    else if (term.key === 'is') {
      hit = hasAnyFlag(message.flags, tokenValue(term.value.toLowerCase()) ?? term.value.toUpperCase());
    }
    else if (term.key === 'since' || term.key === 'before') {
      term.date = parseImapDate(term.value);
      hit = term.date != null ? dateMatches(term, message) : false;
    }
    if (term.neg ? hit : !hit) {
      return false;
    }
  }
  return true;
}

// "7-Sep-2026" (case-insensitive, 2-digit day optional) — same grammar as the
// old IMAP criteria builder.
function parseImapDate(value) {
  const m = String(value).trim().match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
  if (!m) {
    // fall back to ISO-ish parse (2026-09-07) as well
    const t = Date.parse(value);
    return Number.isNaN(t) ? null : new Date(t);
  }
  const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const month = months.indexOf(m[2].toLowerCase());
  if (month === -1) {
    return null;
  }
  const d = new Date(Number(m[3]), month, Number(m[1]));
  return Number.isNaN(d.getTime()) ? null : d;
}

// ---- main entry -----------------------------------------------------------------

// Search the mirror. Returns ThreadSummary[]; when allFolders=true each row
// also carries `dir` (folder name). Mirrors the old server-side search shape:
// threads that contain at least one matching message.
export async function searchMirror(mirror, {dir, query, allFolders = false, getBody = null} = {}) {
  const terms = parseQuery(query);
  if (!terms.length) {
    return [];
  }
  const resolveFields = makeFieldResolver(mirror, getBody);

  const folderList = allFolders
    ? (await mirror.getMeta()).dirs
        .filter(d => !(Array.isArray(d.attrs) ? d.attrs : []).some(a => /\\noselect/i.test(String(a))))
        .map(d => d.name)
    : [dir];
  if (!folderList.length || (folderList.length === 1 && !folderList[0])) {
    throw new Error('search: no dir given and none open');
  }

  const out = [];
  for (const folder of folderList) {
    const index = await mirror.getIndex(folder);
    if (!index) {
      continue;
    }
    const threads = threadSummaries(index);
    for (const thread of threads) {
      const matched = [];
      for (const message of thread.messages) {
        if (await matchMessage(message, terms, folder, resolveFields)) {
          matched.push(message);
        }
      }
      if (matched.length) {
        out.push({...thread, dir: folder});
      }
    }
  }
  out.sort((a, b) => (Date.parse(String(b.date ?? '')) || 0) - (Date.parse(String(a.date ?? '')) || 0));
  return out;
}
