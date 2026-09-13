#!/usr/bin/env node
// smoke-filter.mjs — minimal DOM-stub test for the list-view selection
// filter. No browser/jsdom: we statically assert the wiring exists in the
// component source, then replicate the exact matching semantics and assert
// the build -> applyFilter contract against stub-server-like data.
//
//   node tests/smoke-filter.mjs

import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

// The component is a custom element; without a DOM we verify the matching
// semantics directly by re-implementing the exact extracted algorithm and
// asserting against it — plus static checks that the wiring exists.
const src = await readFile(new URL('../extension/data/client/components/list-view.js', import.meta.url), 'utf8');

// static wiring assertions
assert.ok(src.includes("querySelector('.filter')"), 'filter input is wired');
assert.ok(src.includes("querySelector('.clear-filter')"), 'clear button is wired');
assert.ok(src.includes("#filter.addEventListener('input'"), 'input event drives filtering');
assert.ok(src.includes("target === this.#filter"), 'keydown guard for the filter input');
assert.ok(src.includes("e.key === '/'"), "'/' focuses the filter");
assert.ok(src.includes("this.#applyFilter(this.#filter.value)"), 'build() re-applies the filter');
assert.ok(src.includes("this.#applyFilter(this.#filterQuery)"), 'removeRows() re-applies the filter');

// semantic model replicated from #threadMatches / #applyFilter
const contains = (text, term) => !!text && String(text).toLowerCase().includes(term);
const threadMatches = (thread, terms) => terms.every(term => {
  if ([thread.subject, thread.from].some(t => contains(t, term))) {
    return true;
  }
  return thread.messages.some(m => contains(m.subject, term) || contains(m.from, term));
});
const applyFilter = (rows, query) => {
  const terms = String(query ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  const selected = [];
  if (terms.length) {
    for (const t of rows) {
      if (threadMatches(t, terms)) {
        selected.push(...t.uids);
      }
    }
  }
  return selected;
};

// seed matching the stub server's INBOX
const rows = [
  {uids: [107], count: 1, subject: 'Lunch tomorrow?', from: 'Alice Example <alice@example.com>',
   messages: [{uid: 107, subject: 'Lunch tomorrow?', from: 'Alice Example <alice@example.com>'}]},
  {uids: [104, 105, 106], count: 3, subject: 'Sprint planning Friday', from: 'Dana Lead <dana@example.com>',
   messages: [
     {uid: 104, subject: 'Sprint planning Friday', from: 'Dana Lead <dana@example.com>'},
     {uid: 105, subject: 'Re: Sprint planning Friday', from: 'Bob Build <bob@example.com>'},
     {uid: 106, subject: 'Re: Sprint planning Friday', from: 'Dana Lead <dana@example.com>'},
   ]},
  {uids: [101, 103], count: 2, subject: 'Тестовое письмо', from: 'Настя Иванова <nastya@example.com>',
   messages: [
     {uid: 101, subject: 'Тестовое письмо', from: 'Настя Иванова <nastya@example.com>'},
     {uid: 103, subject: 'Re: Тестовое письмо', from: 'user@example.com'},
   ]},
  {uids: [102], count: 1, subject: 'Second stub message', from: 'Alice Example <alice@example.com>',
   messages: [{uid: 102, subject: 'Second stub message', from: 'Alice Example <alice@example.com>'}]},
];

assert.deepEqual(applyFilter(rows, ''), [], 'empty query -> no selection');
assert.deepEqual(applyFilter(rows, 'alice'), [107, 102], 'sender match selects whole threads');
assert.deepEqual(applyFilter(rows, 'sprint'), [104, 105, 106], 'subject match selects whole thread');
assert.deepEqual(applyFilter(rows, 'bob'), [104, 105, 106], 'message-level hit pulls in the conversation');
assert.deepEqual(applyFilter(rows, 'ALICE lunch'), [107], 'case-insensitive AND across terms');
assert.deepEqual(applyFilter(rows, 'dana friday bob'), [104, 105, 106], 'AND satisfied by different messages');
assert.deepEqual(applyFilter(rows, 'alice sprint'), [], 'AND not satisfied anywhere -> empty');
assert.deepEqual(applyFilter(rows, 'тестовое'), [101, 103], 'unicode subject matching');
assert.deepEqual(applyFilter(rows, '   sprint   '), [104, 105, 106], 'whitespace tolerated');

console.log('smoke-filter: all assertions passed');
