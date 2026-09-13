#!/usr/bin/env node
// smoke-sort.mjs — assertions for the list-view view-local sort. Statically
// checks the wiring in the component source, then replicates the exact
// comparator semantics and asserts ordering against stub-server-like data.
//
//   node tests/smoke-sort.mjs

import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const src = await readFile(new URL('../extension/data/client/components/list-view.js', import.meta.url), 'utf8');

// static wiring assertions
assert.ok(src.includes("querySelector('.sort')"), 'sort select is wired');
assert.ok(src.includes("this.sortMode = this.#sort.value"), 'change event updates the mode via the setter');
assert.ok(src.includes("target === this.#sort"), 'keydown guard covers the select');
assert.ok(src.includes('#sortedRows()'), 'render() iterates the sorted view');
assert.ok(src.includes('<option value="date-asc">'), 'date ascending option exists');
assert.ok(src.includes('<option value="subject-desc">'), 'subject descending option exists');
assert.ok(src.includes('<option value="sender-desc">'), 'sender descending option exists');
assert.ok(src.includes("dispatchEvent(new CustomEvent('sort-changed'"), 'sort-changed event dispatched');
assert.ok(src.includes('get sortMode()'), 'sortMode getter exists');
assert.ok(src.includes('set sortMode(mode)'), 'sortMode setter exists');
assert.ok(src.includes('get flaggedOnTop()'), 'flaggedOnTop getter exists');
assert.ok(src.includes('set flaggedOnTop(on)'), 'flaggedOnTop setter exists');

// replicated semantics (mirror of list-view.js)
function senderName(from) {
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

const newestUid = (t, desc) => {
  const uid = t.uids.length ? t.uids[t.uids.length - 1] : 0;
  return desc ? -uid : uid;
};

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

function comparatorFor(key, desc) {
  switch (key) {
    case 'subject': {
      const val = t => (t.subject || '').trim().toLowerCase();
      return textComparator(val, desc);
    }
    case 'sender': {
      const val = t => senderName(t.from).trim().toLowerCase();
      return textComparator(val, desc);
    }
    case 'date': {
      const val = t => {
        const d = new Date(t.date || '');
        return isNaN(d.getTime()) ? null : d.getTime();
      };
      return numberComparator(val, desc);
    }
    default:
      return () => 0;
  }
}

function sortPartition(rows, mode) {
  if (!mode) {
    return rows;
  }
  const [key, dir] = mode.split('-');
  return [...rows].sort(comparatorFor(key, dir === 'desc'));
}

function sortedRows(rows, mode, flaggedOnTop) {
  if (flaggedOnTop) {
    const flagged = [];
    const rest = [];
    for (const t of rows) {
      (t.flagged ? flagged : rest).push(t);
    }
    return [...sortPartition(flagged, mode), ...sortPartition(rest, mode)];
  }
  return sortPartition(rows, mode);
}

const uidsOf = rows => rows.map(t => t.uids[0]);

// natural order = newest first
const natural = [
  {uids: [107], subject: 'Lunch tomorrow?', from: 'Alice Example <alice@example.com>', date: 'Wed, 9 Sep 2026 08:00:00 +0000'},
  {uids: [106, 104, 105], subject: 'Re: Sprint planning Friday', from: 'Dana Lead <dana@example.com>', date: 'Tue, 8 Sep 2026 11:00:00 +0000'},
  {uids: [103, 101], subject: 'Re: Тестовое письмо', from: 'user@example.com', date: 'Mon, 7 Sep 2026 11:45:00 +0000'},
  {uids: [102], subject: 'Second stub message', from: 'Alice Example <alice@example.com>', date: 'Mon, 7 Sep 2026 10:30:00 +0000'},
];

assert.deepEqual(uidsOf(sortedRows(natural, '')), [107, 106, 103, 102], 'empty mode keeps natural order');
assert.deepEqual(uidsOf(sortedRows(natural, 'subject-asc')), [107, 106, 103, 102], 'subject A→Z (lunch < re:sprint < re:тестовое < second)');
assert.deepEqual(uidsOf(sortedRows(natural, 'subject-desc')), [102, 103, 106, 107], 'subject Z→A');
assert.deepEqual(uidsOf(sortedRows(natural, 'sender-asc')), [102, 107, 106, 103], 'sender A→Z (Alice, Alice, Dana, user; UID tiebreak)');
assert.deepEqual(uidsOf(sortedRows(natural, 'sender-desc')), [103, 106, 107, 102], 'sender Z→A (user, Dana, Alice, Alice; UID tiebreak)');
assert.deepEqual(uidsOf(sortedRows(natural, 'date-asc')), [102, 103, 106, 107], 'date oldest first');

// missing values sort last in both directions
const withGaps = [
  {uids: [3], subject: '', from: '', date: 'bad-date'},
  {uids: [2], subject: 'Beta', from: 'Bob <b@x>', date: 'Tue, 8 Sep 2026 09:00:00 +0000'},
  {uids: [1], subject: 'Alpha', from: 'Ann <a@x>', date: 'Mon, 7 Sep 2026 09:00:00 +0000'},
];
assert.deepEqual(uidsOf(sortedRows(withGaps, 'subject-asc')), [1, 2, 3], 'missing subject last (asc)');
assert.deepEqual(uidsOf(sortedRows(withGaps, 'subject-desc')), [2, 1, 3], 'missing subject still last when descending');
assert.deepEqual(uidsOf(sortedRows(withGaps, 'sender-asc')), [1, 2, 3], 'missing sender last');
assert.deepEqual(uidsOf(sortedRows(withGaps, 'date-asc')), [1, 2, 3], 'unparseable date last');
assert.deepEqual(uidsOf(sortedRows(withGaps, 'date-desc')), [2, 1, 3], 'unparseable date last when descending');

// tiebreak stability: equal keys order by newest UID (mirrors direction)
const twins = [
  {uids: [9], subject: 'same', from: 'X <x@x>', date: 'Tue, 8 Sep 2026 09:00:00 +0000'},
  {uids: [5], subject: 'same', from: 'X <x@x>', date: 'Tue, 8 Sep 2026 09:00:00 +0000'},
  {uids: [7], subject: 'same', from: 'X <x@x>', date: 'Tue, 8 Sep 2026 09:00:00 +0000'},
];
assert.deepEqual(uidsOf(sortedRows(twins, 'subject-asc')), [5, 7, 9], 'equal subjects tiebreak on UID asc');
assert.deepEqual(uidsOf(sortedRows(twins, 'subject-desc')), [9, 7, 5], 'equal subjects tiebreak on UID desc');

// flagged-on-top: partition runs the active sort (or natural order) once per
// block; flagged block always first. Input is in natural newest-first order
// (as delivered by build()).
const mixed = [
  {uids: [305], subject: 'Apple', from: 'Lee <l@x>', date: 'Tue, 8 Sep 2026 09:00:00 +0000', flagged: true},
  {uids: [304], subject: 'Zebra', from: 'Zed <z@x>', date: 'Wed, 9 Sep 2026 09:00:00 +0000', flagged: false},
  {uids: [303], subject: 'Cherry', from: 'Max <m@x>', date: 'Mon, 7 Sep 2026 09:00:00 +0000', flagged: true},
  {uids: [302], subject: 'Apricot', from: 'Yan <y@x>', date: 'Thu, 10 Sep 2026 09:00:00 +0000', flagged: false},
];

// natural order (no sort): blocks keep their natural order, flagged on top
assert.deepEqual(
  uidsOf(sortedRows(mixed, '', true)),
  [305, 303, 304, 302],
  'flagged first under natural order'
);
// same input without the option: untouched natural order
assert.deepEqual(
  uidsOf(sortedRows(mixed, '', false)),
  [305, 304, 303, 302],
  'flaggedOnTop off keeps plain natural order'
);

// each partition sorted independently by the active comparator
assert.deepEqual(
  uidsOf(sortedRows(mixed, 'subject-asc', true)),
  [305, 303, 302, 304],
  'flagged Apple,Cherry first then unflagged sorted A→Z'
);
assert.deepEqual(
  uidsOf(sortedRows(mixed, 'subject-desc', true)),
  [303, 305, 304, 302],
  'flagged block Z→A then unflagged block Z→A'
);
assert.deepEqual(
  uidsOf(sortedRows(mixed, 'date-asc', true)),
  [303, 305, 304, 302],
  'date oldest first within each partition'
);
assert.deepEqual(
  uidsOf(sortedRows(mixed, 'sender-asc', true)),
  [305, 303, 302, 304],
  'sender A→Z within each partition'
);

// every thread flagged: identical to the unpartitioned sort
const allFlagged = mixed.map(t => ({...t, flagged: true}));
assert.deepEqual(
  uidsOf(sortedRows(allFlagged, 'subject-asc', true)),
  uidsOf(sortedRows(mixed, 'subject-asc')),
  'all-flagged partition equals unpartitioned sort'
);

console.log('smoke-sort: all assertions passed');
