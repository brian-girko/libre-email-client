#!/usr/bin/env node
// run.test.mjs — regression tests for the filter executor's 'stop' action
// (data/sync/filters/run.mjs + route.mjs). A 'stop' filter matches without
// moving: the message stays where it is and every LATER filter is skipped
// for it — the per-message guard. Run:
//   node data/sync/filters/run.test.mjs
//
// Pinned behavior:
// 1. precedence: stop-above-move keeps the message (kept 1, no rename);
//    move-above-stop still moves it (first match wins either way);
// 2. reach: a stop filter only shields the messages IT matched — others
//    keep flowing down the list to the move filters below;
// 3. single runs: runFilter with a stop filter reports matches, renames
//    nothing, and runs without a destination folder; a legacy filter
//    without an action field still moves;
// 4. routeMessage: a stop winner answers action 'stop' with folder null
//    and the walk ends there;
// 5. dry runs print the same stop lines, rename nothing.

import {register} from 'node:module';
register('../offscreen/root-loader.mjs', import.meta.url);

import assert from 'node:assert/strict';

// dynamic: the resolve hook above must be in place before '/core/...'
// specifiers (route.mjs's bundled postal-mime) are resolved
const {runFilter, runAllFilters} = await import('./run.mjs');
const {routeMessage} = await import('./route.mjs');

// ------------------------------------------------------------ mock store

// The surface run.mjs touches: delimiter, listLocal(dir) → {entries: Map},
// readFile(entry) → Uint8Array, moveMessage(dir, entry, dest, uid),
// loadState() → snapshot-like {folders}. Duck-typed — no MaildirStore.
class MockStore {
  constructor({dir = 'INBOX', raws = [], folders = {Zoo: {}}, delimiter = '/'} = {}) {
    this.delimiter = delimiter;
    this.dir = dir;
    this.folders = folders;
    this.moves = [];
    this.files = new Map();      // uid → entry
    this.bodies = new Map();     // uid → raw bytes
    let uid = 0;
    for (const raw of raws) {
      uid++;
      this.files.set(uid, {uid, path: dir + '/' + uid, fileName: String(uid), flags: []});
      this.bodies.set(uid, raw);
    }
  }
  async listLocal(dir) {
    return dir === this.dir ? {entries: new Map(this.files)} : null;
  }
  async readFile(entry) {
    return this.bodies.get(entry.uid);
  }
  async moveMessage(dir, entry, dest, uid) {
    this.moves.push({dir, dest, uid});
    this.files.delete(uid);
  }
  async loadState() {
    return {folders: this.folders};
  }
}

const message = ({from, subject}) =>
  new TextEncoder().encode(
    `From: ${from}\r\nTo: me@example.com\r\nSubject: ${subject}\r\n` +
    `Date: Wed, 23 Sep 2026 10:00:00 +0000\r\nMessage-Id: <t${Math.random()}@test>\r\n\r\nbody\r\n`);

const collect = () => {
  const lines = [];
  return {lines, log: (content, cls) => lines.push({content, cls})};
};

// ------------------------------------------------------------ fixtures

const STOP = {id: 's', enabled: true, accountId: '', action: 'stop',
  query: 'guardme', folder: ''};
const STOP_STALE = {...STOP, folder: 'GhostFolder'};   // stop ignores folder
const MOVE = {id: 'm', enabled: true, accountId: '', action: 'move',
  query: 'shipme', folder: 'Zoo', createFolder: false};
const LEGACY_MOVE = {id: 'l', enabled: true, accountId: '',
  query: 'shipme', folder: 'Zoo', createFolder: false};   // no action field
const MOVE_BOTH = {id: 'b', enabled: true, accountId: '', action: 'move',
  query: 'guardme', folder: 'Zoo', createFolder: false};

const GUARDED = message({from: 'boss@example.com', subject: 'guardme please'});
const FREE = message({from: 'dev@example.com', subject: 'shipme please'});
const BOTH = message({from: 'x@example.com', subject: 'guardme and shipme'});

// ------------------------------------------------------------ tests

// 1. stop-above-move: the guarded message is anchored, the free one moves
{
  const store = new MockStore({raws: [GUARDED, FREE]});
  const {lines, log} = collect();
  const res = await runAllFilters(store, {
    dir: 'INBOX', filters: [STOP, MOVE], log
  });
  assert.deepEqual(
    {candidates: res.candidates, matched: res.matched, moved: res.moved, kept: res.kept},
    {candidates: 2, matched: 2, moved: 1, kept: 1});
  assert.deepEqual(store.moves, [{dir: 'INBOX', dest: 'Zoo', uid: 2}]);
  assert.ok(lines.some(l => l.content.includes('stop filters') &&
    l.content.includes('later filters skipped')), 'stop line logged');
  assert.ok(lines.some(l => l.content.includes('-> Zoo')), 'move line logged');
}

// 1b. move-above-stop: first match wins — the same message moves
{
  const store = new MockStore({raws: [BOTH]});
  const res = await runAllFilters(store, {
    dir: 'INBOX', filters: [MOVE_BOTH, STOP], log: () => {}
  });
  assert.equal(res.moved, 1);
  assert.equal(res.kept, 0);
  assert.deepEqual(store.moves, [{dir: 'INBOX', dest: 'Zoo', uid: 1}]);
}

// 2. a stop filter shields only ITS matches: the SAME move filter below
//    would take both messages, but only the unguarded one reaches it
{
  const MOVE_ALL = {id: 'p', enabled: true, accountId: '', action: 'move',
    query: 'please', folder: 'Zoo', createFolder: false};
  const store = new MockStore({raws: [GUARDED, FREE]});
  const res = await runAllFilters(store, {
    dir: 'INBOX', filters: [STOP, MOVE_ALL], log: () => {}
  });
  // GUARDED matches stop first (shielded); FREE only matches MOVE_ALL
  assert.equal(res.moved, 1);
  assert.equal(res.kept, 1);
  assert.deepEqual(store.moves, [{dir: 'INBOX', dest: 'Zoo', uid: 2}]);
}

// 3. single-filter run: a stop filter runs without a folder, moves nothing
{
  const store = new MockStore({raws: [GUARDED]});
  const {lines, log} = collect();
  const res = await runFilter(store, {
    dir: 'INBOX', filter: STOP, log
  });
  assert.deepEqual(
    {candidates: res.candidates, matched: res.matched, moved: res.moved, kept: res.kept},
    {candidates: 1, matched: 1, moved: 0, kept: 1});
  assert.deepEqual(store.moves, [], 'no rename for a stop match');
  assert.ok(lines.some(l => l.content.includes('stop filters (nothing moved)')));
  assert.ok(!lines.some(l => l.cls === 'warn'), 'no warnings on a clean stop run');
}

// 3b. a stop filter with a stale folder moves nothing and never warns
{
  const store = new MockStore({raws: [GUARDED], folders: {}});
  const {lines, log} = collect();
  const res = await runFilter(store, {
    dir: 'INBOX', filter: STOP_STALE, log
  });
  assert.equal(res.matched, 1);
  assert.equal(res.moved, 0);
  assert.ok(!lines.some(l => l.cls === 'warn'), 'no destination warnings');
}

// 3c. legacy row without an action field still moves (backward compat)
{
  const store = new MockStore({raws: [FREE]});
  const res = await runFilter(store, {
    dir: 'INBOX', filter: LEGACY_MOVE, log: () => {}
  });
  assert.equal(res.moved, 1);
  assert.deepEqual(store.moves, [{dir: 'INBOX', dest: 'Zoo', uid: 1}]);
}

// 4. routeMessage: the stop winner answers action 'stop' and ends the walk
{
  const res = await routeMessage(GUARDED, {filters: [STOP, MOVE_BOTH]});
  assert.equal(res.matched, true);
  assert.equal(res.action, 'stop');
  assert.equal(res.folder, null);
  assert.equal(res.createFolder, false);

  const moved = await routeMessage(GUARDED, {filters: [MOVE_BOTH, STOP]});
  assert.equal(moved.action, 'move');
  assert.equal(moved.folder, 'Zoo');

  const none = await routeMessage(FREE, {filters: [STOP]});
  assert.equal(none.matched, false);
  assert.equal(none.action, null);
}

// 5. dry run: same stop lines, nothing renamed
{
  const store = new MockStore({raws: [GUARDED, FREE]});
  const res = await runAllFilters(store, {
    dir: 'INBOX', filters: [STOP, MOVE], dry: true, log: () => {}
  });
  assert.equal(res.matched, 2);
  assert.equal(res.moved, 0);
  assert.deepEqual(store.moves, []);
}

// 6. disabled stop filters fall out of the walk like any disabled filter
{
  const store = new MockStore({raws: [BOTH]});
  const res = await runAllFilters(store, {
    dir: 'INBOX', filters: [{...STOP, enabled: false}, MOVE_BOTH], log: () => {}
  });
  assert.equal(res.moved, 1);
  assert.equal(res.kept, 0);
}

console.log('run.test.mjs: all filter stop-action tests passed');
