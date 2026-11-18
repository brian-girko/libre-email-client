#!/usr/bin/env node
// Regression tests for list-order.mjs — the host-side folder-wide ordering
// (list.mjs renders through it: flatten → filter → partition → sort).
// No chrome/DOM: plain rows in, ordered rows out.
// Run: node data/client/list-order.test.mjs

import assert from 'node:assert/strict';
import {SORT_MODES, senderName, rowKey, flattenThreads, orderRows} from './list-order.mjs';

// conversation rows in the data layer's natural order (newest thread first)
const threads = [
  {
    uids: [3, 9], count: 2, unread: 1, flagged: true,
    subject: 'beta', from: 'Zed <zed@example.com>',
    date: 'Wed, 04 Nov 2026 10:00:00 +0000',
    messages: [
      {uid: 3, flags: ['\\Seen'], subject: 'beta', from: 'a@example.com', date: 'Sun, 01 Nov 2026 10:00:00 +0000'},
      {uid: 9, flags: [], subject: 'Re: beta', from: 'b@example.com', date: 'Wed, 04 Nov 2026 10:00:00 +0000'}
    ]
  },
  {
    uids: [5], count: 1, unread: 0, flagged: false,
    subject: 'alpha', from: 'Anna <anna@example.com>',
    date: 'Tue, 10 Nov 2026 10:00:00 +0000',
    messages: [{uid: 5, flags: ['\\Seen'], subject: 'alpha', from: 'anna@example.com', date: 'Tue, 10 Nov 2026 10:00:00 +0000'}]
  },
  {
    uids: [7], count: 1, unread: 1, flagged: false,
    subject: null, from: null,
    date: 'Mon, 02 Nov 2026 10:00:00 +0000',
    messages: [{uid: 7, flags: [], subject: null, from: null, date: 'Mon, 02 Nov 2026 10:00:00 +0000'}]
  }
];
const titles = rows => rows.map(t => t.uids.join('/'));

// ---- 1. natural order ("" mode) is a no-op -------------------------------
{
  const snapshot = JSON.stringify(threads);
  const out = orderRows(threads, {});
  assert.deepEqual(titles(out), ['3/9', '5', '7'], '"" keeps the data layer order');
  assert.equal(JSON.stringify(threads), snapshot, 'the input list is never mutated');
}

// ---- 2. date sorts: newest first (the new mode), oldest first ------------
{
  const desc = orderRows(threads, {sortMode: 'date-desc'});
  assert.deepEqual(titles(desc), ['5', '3/9', '7'],
    'date-desc: Nov 10, Nov 4, Nov 2 — no more page-local sorting');
  const asc = orderRows(threads, {sortMode: 'date-asc'});
  assert.deepEqual(titles(asc), ['7', '3/9', '5']);
}

// ---- 3. missing values always sort last, tiebreak by newest uid ----------
{
  const rows = [
    {uids: [2], date: 'Tue, 10 Nov 2026 10:00:00 +0000'},
    {uids: [8], date: null},
    {uids: [4], date: null},
    {uids: [6], date: 'Tue, 10 Nov 2026 10:00:00 +0000'}
  ];
  const desc = orderRows(rows, {sortMode: 'date-desc'});
  assert.deepEqual(titles(desc), ['6', '2', '8', '4'],
    'equal dates tiebreak descending by newest uid; dateless last (same uid direction)');
  const asc = orderRows(rows, {sortMode: 'date-asc'});
  assert.deepEqual(titles(asc), ['2', '6', '4', '8'],
    'equal dates tiebreak ascending by newest uid; dateless last either way');
}

// ---- 4. subject / sender sorts, empty values last ------------------------
{
  const desc = orderRows(threads, {sortMode: 'subject-desc'});
  assert.deepEqual(titles(desc), ['3/9', '5', '7'], 'Z→A: beta, alpha, subjectless last');
  const asc = orderRows(threads, {sortMode: 'subject-asc'});
  assert.deepEqual(titles(asc), ['5', '3/9', '7'], 'A→Z: alpha, beta, subjectless last');
  const sender = orderRows(threads, {sortMode: 'sender-asc'});
  assert.deepEqual(titles(sender), ['5', '3/9', '7'],
    'Anna before Zed (display name, not raw header); senderless last');
}

// ---- 5. flagged-on-top partitions, sort runs within each partition -------
{
  const out = orderRows(threads, {sortMode: 'date-asc', flaggedOnTop: true});
  assert.deepEqual(titles(out), ['3/9', '7', '5'],
    'flagged 3/9 first (Nov 4 > Nov 2 within partition), then unflagged asc');
}

// ---- 6. unread-only filter ------------------------------------------------
{
  const out = orderRows(threads, {unreadOnly: true});
  assert.deepEqual(titles(out), ['3/9', '7'], 'read conversation 5 dropped');
  const both = orderRows(threads, {unreadOnly: true, flaggedOnTop: true, sortMode: 'date-desc'});
  assert.deepEqual(titles(both), ['3/9', '7'], 'filter applies before partition+sort');
}

// ---- 7. flattenThreads: one pseudo-row per message, idempotent ------------
{
  const flat = flattenThreads(threads);
  assert.equal(flat.length, 4, '2 + 1 + 1 messages');
  assert.deepEqual(flat.map(t => t.uids[0]), [3, 9, 5, 7],
    'conversation order preserved, messages in conversation order');
  assert.deepEqual(flat.map(t => t.unread), [0, 1, 0, 1], 'per-message unread derived from flags');
  assert.equal(flattenThreads(flat).length, 4, 'flattening flat rows is a no-op');
  const beta = flat[1];
  assert.equal(beta.subject, 'Re: beta', 'message subject wins');
  assert.equal(beta.date, 'Wed, 04 Nov 2026 10:00:00 +0000', 'message date wins');
  assert.equal(flat[0].subject, 'beta', 'falls back to the thread subject');
  assert.equal(flattenThreads([]).length, 0);
  assert.equal(flattenThreads(null).length, 0);
  // flat date sort is per-message: the Nov 10 message leads, Nov 1 follow-up
  // no longer hides under its conversation
  const byDate = orderRows(flat, {sortMode: 'date-desc'});
  assert.deepEqual(byDate.map(t => t.uids[0]), [5, 9, 7, 3]);
}

// ---- 8. helpers ------------------------------------------------------------
{
  assert.ok(SORT_MODES.includes('date-desc'), 'date-desc is a known mode');
  assert.deepEqual(rowKey({uids: [3, 9]}), 3);
  assert.equal(rowKey({}), 0);
  assert.equal(rowKey(null), 0);
  assert.equal(senderName('Zed <zed@example.com>'), 'Zed');
  assert.equal(senderName('"Quoted" <q@example.com>'), 'Quoted');
  assert.equal(senderName('bare@example.com'), 'bare@example.com');
  assert.equal(senderName(null), '');
}

console.log('list-order.test.mjs — all assertions passed');
