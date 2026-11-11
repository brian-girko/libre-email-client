#!/usr/bin/env node
// Regression test for the tombstone store (data/sync/tombstones.mjs) and the
// MaildirStore methods built on it. Run: node data/sync/tombstones.test.mjs

import assert from 'node:assert/strict';
import {register} from 'node:module';
import {FILE, loadTombstones, tombKey, tombstoneEntry} from './tombstones.mjs';

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
  const e = tombstoneEntry({folder: 'INBOX', uid: 7, msgid: '<a@b>', at: '2026-01-01T00:00:00Z'});
  assert.deepEqual(e, {folder: 'INBOX', uid: 7, msgid: '<a@b>', at: '2026-01-01T00:00:00Z'});
  // junk shapes are dropped, never thrown
  assert.equal(tombstoneEntry(null), null);
  assert.equal(tombstoneEntry('x'), null);
  assert.equal(tombstoneEntry({uid: 7}), null);                    // no folder
  assert.equal(tombstoneEntry({folder: 'INBOX'}), null);           // no uid
  assert.equal(tombstoneEntry({folder: 'INBOX', uid: 0}), null);   // uid ≤ 0
  assert.equal(tombstoneEntry({folder: 'INBOX', uid: 'x'}), null); // NaN uid
  // msgid/at may be missing → null, uid coerced from a numeric string
  assert.deepEqual(tombstoneEntry({folder: 'INBOX', uid: '9'}),
    {folder: 'INBOX', uid: 9, msgid: null, at: null});
}

// ---- load: missing and corrupt files read as empty -------------------------

{
  const fs = memFs();
  assert.deepEqual(await loadTombstones(fs, ACC), []);
  fs.files.set(path, '{not json');
  assert.deepEqual(await loadTombstones(fs, ACC), []);
  fs.files.set(path, JSON.stringify({version: 1, entries: [{folder: 'INBOX', uid: 1}, 'junk']}));
  assert.deepEqual(await loadTombstones(fs, ACC), [{folder: 'INBOX', uid: 1, msgid: null, at: null}]);
}

// ---- MaildirStore.addTombstones: merge, dedupe, msgid/at fill --------------

{
  const fs = memFs();
  const store = new MaildirStore(fs, ACC);
  assert.equal(await store.addTombstones([
    {folder: 'INBOX', uid: 3, msgid: '<a@b>', at: '2026-01-01T00:00:00Z'},
    {folder: 'Work', uid: 4, msgid: null},
    {folder: 'INBOX', uid: 3, msgid: null, at: '2026-01-02T00:00:00Z'},  // dup
    {folder: null, uid: 5},                                              // invalid
    {folder: 'INBOX', uid: 99, msgid: '<c@d>'}
  ]), 3);   // 3 NEW entries (the dup merges in place)
  let list = await store.loadTombstones();
  assert.equal(list.length, 3);
  const inbox3 = list.find(e => e.uid === 3);
  // the dup's newer `at` wins; the first record's msgid is kept
  assert.equal(inbox3.msgid, '<a@b>');
  assert.equal(inbox3.at, '2026-01-02T00:00:00Z');
  // a later entry fills a missing msgid
  await store.addTombstones([{folder: 'Work', uid: 4, msgid: '<w@x>'}]);
  list = await store.loadTombstones();
  assert.equal(list.find(e => e.uid === 4).msgid, '<w@x>');
  // the file on disk is the durable truth
  const onDisk = JSON.parse(fs.files.get(path));
  assert.equal(onDisk.version, 1);
  assert.equal(onDisk.entries.length, 3);
}

// ---- MaildirStore.clearTombstones: predicate and full clear ----------------

{
  const fs = memFs();
  const store = new MaildirStore(fs, ACC);
  await store.addTombstones([
    {folder: 'INBOX', uid: 1, msgid: '<1>'},
    {folder: 'INBOX', uid: 2, msgid: '<2>'},
    {folder: 'Work', uid: 3, msgid: '<3>'}
  ]);
  // predicate: only the entry it accepts is removed (the engine's
  // commit-time prune — "message no longer on the server")
  assert.equal(await store.clearTombstones(
    e => e.folder === 'INBOX' && e.uid === 2), 1);
  let list = await store.loadTombstones();
  assert.deepEqual(list.map(e => tombKey(e.folder, e.uid)), ['INBOX/1', 'Work/3']);
  // a predicate that removes nothing leaves the file untouched
  assert.equal(await store.clearTombstones(() => false), 0);
  assert.equal((await store.loadTombstones()).length, 2);
  // full clear
  assert.equal(await store.clearTombstones(), 2);
  assert.deepEqual(await store.loadTombstones(), []);
  assert.deepEqual(JSON.parse(fs.files.get(path)), {version: 1, entries: []});
}

console.log('tombstones.test.mjs: all assertions passed');
