'use strict';

// list-order.mjs — shared ordering + flattening for the mails list.
//
// The host (list.mjs) owns the full folder list and the pagination, so the
// ordering happens HERE, folder-wide, before any page is sliced:
//   1. flat mode ("Show single messages") reshapes conversations into one
//      pseudo-row per message;
//   2. the unread-only filter drops rows without unread mail;
//   3. the flagged-on-top partition (when on) runs the comparator once per
//      partition;
//   4. the active sort orders each partition — "" is the natural
//      conversation order (threads by newest message date, newest UID as
//      tiebreak — threads.mjs output order), a no-op.
// The view renders the page it is given and never reorders.

// Text comparator: locale compare; empty/missing values always sort last
// regardless of direction; ties broken by the row's newest UID.
function textComparator(get, desc) {
  const sign = desc ? -1 : 1;
  return (a, b) => {
    const va = get(a);
    const vb = get(b);
    if (!va && !vb) return newestUid(a, desc) - newestUid(b, desc);
    if (!va) return 1;
    if (!vb) return -1;
    return sign * va.localeCompare(vb) || newestUid(a, desc) - newestUid(b, desc);
  };
}

// Numeric comparator (timestamps): missing (null) values always sort last.
function numberComparator(get, desc) {
  const sign = desc ? -1 : 1;
  return (a, b) => {
    const va = get(a);
    const vb = get(b);
    if (va === null && vb === null) return newestUid(a, desc) - newestUid(b, desc);
    if (va === null) return 1;
    if (vb === null) return -1;
    return sign * (va - vb) || newestUid(a, desc) - newestUid(b, desc);
  };
}

// Deterministic tiebreak: equal values order by newest UID — ascending for
// asc sorts, descending for desc sorts (mirrors the value direction).
function newestUid(row, desc) {
  const uids = Array.isArray(row?.uids) ? row.uids : [];
  const uid = uids.length ? uids[uids.length - 1] : 0;
  return desc ? -uid : uid;
}

const timeOf = value => {
  const t = Date.parse(String(value ?? ''));
  return Number.isNaN(t) ? null : t;
};

/** "Name <addr>" / bare addr → the display name (the sender column's text) */
export function senderName(from) {
  if (!from) {
    return '';
  }
  const s = String(from);
  const lt = s.lastIndexOf('<');
  const gt = s.lastIndexOf('>');
  if (lt > -1 && gt > lt) {
    const name = s.slice(0, lt).trim().replace(/^"+|"+$/g, '').trim();
    return name || s.slice(lt + 1, gt).trim();
  }
  return s.trim();
}

/** Stable identity of a row for page anchoring: its first uid. */
export function rowKey(row) {
  const uids = Array.isArray(row?.uids) ? row.uids : [];
  const uid = Number(uids[0]);
  return Number.isInteger(uid) ? uid : 0;
}

/**
 * Reshape conversations into one pseudo-row per message (the flat
 * "Show single messages" mode). Idempotent: flattening already-flat rows
 * returns them unchanged.
 * @param {Array<object>} threads ThreadSummary-like rows
 * @returns {Array<object>} one row per message, conversation order preserved
 */
export function flattenThreads(threads) {
  const out = [];
  for (const thread of Array.isArray(threads) ? threads : []) {
    const messages = Array.isArray(thread?.messages) ? thread.messages : [];
    if (!messages.length) {
      out.push(thread);
      continue;
    }
    for (const item of messages) {
      const flags = Array.isArray(item.flags) ? item.flags.map(String) : [];
      out.push({
        uids: [Number(item.uid)],
        messages: [item],
        count: 1,
        unread: flags.includes('\\Seen') ? 0 : 1,
        flagged: flags.includes('\\Flagged'),
        subject: item.subject || thread.subject || '',
        from: item.from || thread.from || '',
        date: item.date || thread.date || ''
      });
    }
  }
  return out;
}

/**
 * Folder-wide view ordering: unread-only filter, flagged-on-top partition,
 * then the active sort. Returns the input order untouched for "" (the
 * natural conversation order the data layer already produces).
 * @param {Array<object>} rows thread-shaped rows (real or flattened)
 * @param {{sortMode?: string, flaggedOnTop?: boolean, unreadOnly?: boolean}} view
 * @returns {Array<object>} new array; the input is never mutated
 */
export function orderRows(rows, {sortMode = '', flaggedOnTop = false, unreadOnly = false} = {}) {
  const list = (Array.isArray(rows) ? rows : [])
    .filter(row => !unreadOnly || (Number(row?.unread) || 0) > 0);
  const cmp = comparatorFor(sortMode);
  const run = part => (cmp ? [...part].sort(cmp) : part);
  if (!flaggedOnTop) {
    return run(list);
  }
  const flagged = [];
  const rest = [];
  for (const row of list) {
    (row.flagged ? flagged : rest).push(row);
  }
  return [...run(flagged), ...run(rest)];
}

function comparatorFor(sortMode) {
  if (!SORT_MODES.includes(sortMode) || sortMode === '') {
    return null;
  }
  const [key, dir] = sortMode.split('-');
  const desc = dir === 'desc';
  switch (key) {
    case 'subject':
      return textComparator(row => String(row?.subject ?? '').trim().toLowerCase(), desc);
    case 'sender':
      return textComparator(row => senderName(row?.from).trim().toLowerCase(), desc);
    case 'date':
      return numberComparator(row => timeOf(row?.date), desc);
    default:
      return null;
  }
}

export const SORT_MODES = ['', 'date-asc', 'date-desc', 'subject-asc', 'subject-desc', 'sender-asc', 'sender-desc'];
