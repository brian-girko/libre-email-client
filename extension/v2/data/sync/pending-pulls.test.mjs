#!/usr/bin/env node
// Regression test for the pending-pull journal (data/sync/pending-pulls.mjs)
// and the MaildirStore methods built on it. Run from the extension root:
// node data/sync/pending-pulls.test.mjs

import assert from 'node:assert/strict';
import {register} from 'node:module';
import {FILE, loadPendingPulls, pullKey, pendingPullEntry} from './pending-pulls.mjs';

// maildir.mjs transitively imports browser-absolute modules ('/core/…', the
// extension's import-map spelling) — resolve them against the cwd here, then
// import it dynamically (hooks apply to imports made after registration)
register('data:text/javascript,' + encodeURIComponent(`
  export function resolve(spec, context, next) {
    if (spec.startsWith('/')) {
      return {url: 'file://' + process.cwd() + spec, shortCircuit: true};
    }
    return next(spec);
  }
`), import.meta.url);
const {MaildirStore} = await import('./maildir.mjs');

// ---- a tiny in-memory fs facade (only readText/write are needed) -----------

function memFs() {
  const files = new Map();
  return {
    files,
    reader: {
      async readText(path) {
        if (!files.has(path)) {
          const e = new Error('not found');
          e.name = 'NotFoundError';
          throw e;
        }
        return files.get(path);
      }
    },
    writer: {
      async write(path, text) {
        files.set(path, text);
      }
    }
  };
}

const ACC = 'acc1';
const path = `${ACC}/${FILE}`;

// ---- entry normalization ---------------------------------------------------

{
  // a valid entry survives
  const e = pendingPullEntry({folder: 'INBOX', uid: 7, uidvalidity: 1000, at: '2026-01-01T00:00:00Z'});
  assert.deepEqual(e, {folder: 'INBOX', uid: 7, uidvalidity: 1000, at: '2026-01-01T00:00:00Z'});
  // junk shapes are dropped, never thrown
  assert.equal(pendingPullEntry(null), null);
  assert.equal(pendingPullEntry('x'), null);
  assert.equal(pendingPullEntry({uid: 7}), null);                    // no folder
  assert.equal(pendingPullEntry({folder: 'INBOX'}), null);           // no uid
  assert.equal(pendingPullEntry({folder: 'INBOX', uid: 0}), null);   // uid ≤ 0
  assert.equal(pendingPullEntry({folder: 'INBOX', uid: 'x'}), null); // NaN uid
  // uidvalidity/at may be missing → null, uid coerced from a numeric string;
  // a non-positive uidvalidity is stored as null (never matchable)
  assert.deepEqual(pendingPullEntry({folder: 'INBOX', uid: '9', uidvalidity: 0}),
    {folder: 'INBOX', uid: 9, uidvalidity: null, at: null});
  assert.equal(pullKey('INBOX', 9), 'INBOX/9');
}

// ---- load: missing and corrupt files read as empty -------------------------

{
  const fs = memFs();
  assert.deepEqual(await loadPendingPulls(fs, ACC), []);
  fs.files.set(path, '{not json');
  assert.deepEqual(await loadPendingPulls(fs, ACC), []);
  fs.files.set(path, JSON.stringify({version: 1, entries: [{folder: 'INBOX', uid: 1}, 'junk']}));
  assert.deepEqual(await loadPendingPulls(fs, ACC),
    [{folder: 'INBOX', uid: 1, uidvalidity: null, at: null}]);
}

// ---- MaildirStore.addPendingPulls: merge, dedupe, re-pull replaces ---------

{
  const fs = memFs();
  const store = new MaildirStore(fs, ACC);
  assert.equal(await store.addPendingPulls([
    {folder: 'INBOX', uid: 3, uidvalidity: 1000, at: '2026-01-01T00:00:00Z'},
    {folder: 'Work', uid: 4, uidvalidity: 2000},
    {folder: null, uid: 5},                                           // invalid
    {folder: 'INBOX', uid: 99, uidvalidity: 1000}
  ]), 3);
  let list = await store.loadPendingPulls();
  assert.equal(list.length, 3);
  // a re-pull of the same folder/uid REPLACES the earlier entry — the fresh
  // pull's uidvalidity epoch is the truth (a resync's new epoch must retire
  // the stale record, unlike the tombstone merge which keeps the oldest)
  assert.equal(await store.addPendingPulls([
    {folder: 'INBOX', uid: 3, uidvalidity: 3001, at: '2026-02-01T00:00:00Z'}
  ]), 1);
  list = await store.loadPendingPulls();
  assert.equal(list.length, 3);
  const inbox3 = list.find(e => pullKey(e.folder, e.uid) === 'INBOX/3');
  assert.equal(inbox3.uidvalidity, 3001);
  assert.equal(inbox3.at, '2026-02-01T00:00:00Z');
  // the file on disk is the durable truth
  const onDisk = JSON.parse(fs.files.get(path));
  assert.equal(onDisk.version, 1);
  assert.equal(onDisk.entries.length, 3);
}

// ---- MaildirStore.clearPendingPulls: predicate and full clear --------------

{
  const fs = memFs();
  const store = new MaildirStore(fs, ACC);
  await store.addPendingPulls([
    {folder: 'INBOX', uid: 1, uidvalidity: 1000},
    {folder: 'INBOX', uid: 2, uidvalidity: 1000},
    {folder: 'Work', uid: 3, uidvalidity: 2000}
  ]);
  // predicate: only the entry it accepts is removed (the engine's
  // commit-time prune — "folder committed AND the snapshot tracks the uid")
  assert.equal(await store.clearPendingPulls(
    e => e.folder === 'INBOX' && e.uid === 2), 1);
  let list = await store.loadPendingPulls();
  assert.deepEqual(list.map(e => pullKey(e.folder, e.uid)), ['INBOX/1', 'Work/3']);
  // a predicate that removes nothing leaves the file untouched
  assert.equal(await store.clearPendingPulls(() => false), 0);
  assert.equal((await store.loadPendingPulls()).length, 2);
  // full clear
  assert.equal(await store.clearPendingPulls(), 2);
  assert.deepEqual(await store.loadPendingPulls(), []);
  assert.deepEqual(JSON.parse(fs.files.get(path)), {version: 1, entries: []});
}

console.log('pending-pulls.test.mjs: all assertions passed');
