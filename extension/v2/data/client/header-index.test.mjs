#!/usr/bin/env node
// Regression tests for header-index.mjs — the persistent per-folder header
// cache (.headers.json next to .uidvalidity). A fake fs gateway counts
// message-file reads so the tests can prove the index actually serves.
// Run: node data/client/header-index.test.mjs

import assert from 'node:assert/strict';
import {hydrateMeta} from './header-index.mjs';

const DIR = 'acc/INBOX';
const INDEX = DIR + '/.headers.json';
const UIDVALIDITY = DIR + '/.uidvalidity';

// RFC822 fixture: header block + body
const mail = (subject, from, date, msgid, extra = '') =>
  `From: ${from}\r\nSubject: ${subject}\r\nDate: ${date}\r\n` +
  `Message-ID: <${msgid}>\r\n${extra}\r\n\r\nbody of ${msgid}\r\n`;

const M1 = mail('hello', 'a@example.com', 'Tue, 10 Nov 2026 10:00:00 +0000', 'm1@example.com');
const M2 = mail('thread', 'b@example.com', 'Wed, 04 Nov 2026 10:00:00 +0000',
  'm2@example.com', 'References: <m1@example.com>\r\nIn-Reply-To: <m1@example.com>');
const M3 = mail('later', 'c@example.com', 'Fri, 13 Nov 2026 10:00:00 +0000', 'm3@example.com');

// row the way folderRows() builds them: entry carries the maildir dir + path
const row = (uid, files) => ({
  uid,
  flags: [],
  subject: null,
  from: null,
  date: null,
  messageId: null,
  references: null,
  inReplyTo: null,
  entry: {uid, path: `${DIR}/cur/${uid}.eml`, maildir: {dir: DIR}}
});

// fake fs gateway: text files in a Map; counts .eml slice reads
function makeFs({files = new Map()} = {}) {
  const stats = {messageReads: 0, writes: []};
  const fs = {
    stats,
    reader: {
      async readText(path) {
        if (!files.has(path)) {
          const e = new Error('not found');
          e.name = 'NotFoundError';
          throw e;
        }
        return files.get(path);
      },
      async read(path) {
        const text = files.get(path);
        if (text == null) {
          const e = new Error('not found');
          e.name = 'NotFoundError';
          throw e;
        }
        if (path.endsWith('.eml')) {
          stats.messageReads++;
        }
        const bytes = new TextEncoder().encode(text);
        return {
          slice: (a, b) => ({
            async arrayBuffer() {
              return bytes.slice(a, b).buffer;
            }
          })
        };
      }
    },
    writer: {
      async write(path, text) {
        files.set(path, text);
        stats.writes.push(path);
      }
    }
  };
  return {fs, files};
}

const jsonOf = files => JSON.parse(files.get(INDEX));

// ---- 1. cold build: parse everything once, write the index ----------------
{
  const {fs, files} = makeFs();
  files.set(UIDVALIDITY, '42\n');
  files.set(`${DIR}/cur/1.eml`, M1);
  files.set(`${DIR}/cur/2.eml`, M2);
  const rows = [row(1), row(2)];
  await hydrateMeta(rows, fs);
  assert.equal(fs.stats.messageReads, 2, 'cold: every row parsed from its file');
  assert.equal(rows[0].subject, 'hello');
  assert.equal(rows[1].references, '<m1@example.com>');
  assert.equal(rows[1].inReplyTo, '<m1@example.com>');
  assert.equal(rows[0].date, 'Tue, 10 Nov 2026 10:00:00 +0000');
  assert.deepEqual(fs.stats.writes, [INDEX], 'index written once');
  const index = jsonOf(files);
  assert.equal(index.version, 1);
  assert.equal(index.uidvalidity, 42);
  assert.equal(index.messages['1'][1], 'hello');
  assert.equal(index.messages['2'][3], '<m2@example.com>');
}

// ---- 2. warm read: zero message-file reads, meta served from the index ----
{
  const {fs, files} = makeFs();
  files.set(UIDVALIDITY, '42\n');
  files.set(`${DIR}/cur/1.eml`, M1);
  files.set(INDEX, JSON.stringify({
    version: 1,
    uidvalidity: 42,
    messages: {
      1: ['Tue, 10 Nov 2026 10:00:00 +0000', 'hello', 'a@example.com', 'm1@example.com', null, null]
    }
  }));
  const rows = [row(1)];
  await hydrateMeta(rows, fs);
  assert.equal(fs.stats.messageReads, 0, 'warm: the index serves, no file read');
  assert.equal(rows[0].subject, 'hello');
  assert.equal(rows[0].messageId, 'm1@example.com');
  assert.deepEqual(fs.stats.writes, [], 'nothing changed → no rewrite');
}

// ---- 3. new uid joins; 4. stale uid is dropped on a FULL-folder read ------
{
  const {fs, files} = makeFs();
  files.set(UIDVALIDITY, '42\n');
  files.set(`${DIR}/cur/1.eml`, M1);
  files.set(`${DIR}/cur/3.eml`, M3);
  files.set(INDEX, JSON.stringify({
    version: 1,
    uidvalidity: 42,
    messages: {
      1: ['Tue, 10 Nov 2026 10:00:00 +0000', 'hello', 'a@example.com', 'm1@example.com', null, null],
      9: ['old', 'gone@example.com', 'x@example.com', 'm9@example.com', null, null]   // moved away
    }
  }));
  const rows = [row(1), row(3)];
  await hydrateMeta(rows, fs, {prune: true});   // full folder: rows cover every live uid
  assert.equal(fs.stats.messageReads, 1, 'only the unknown uid parsed');
  assert.equal(rows[1].subject, 'later');
  const index = jsonOf(files);
  assert.equal(index.messages['9'], undefined, 'uid no longer on disk dropped');
  assert.ok(index.messages['3'], 'new uid indexed');
  assert.equal(index.messages['1'][1], 'hello', 'known uid untouched');
  assert.deepEqual(fs.stats.writes, [INDEX], 'changed → rewritten once');
}

// ---- 3b. a SUBSET read never prunes (listFiles pages/ranges, delta adds) --
{
  const {fs, files} = makeFs();
  files.set(UIDVALIDITY, '42\n');
  files.set(`${DIR}/cur/1.eml`, M1);
  files.set(INDEX, JSON.stringify({
    version: 1,
    uidvalidity: 42,
    messages: {
      1: ['Tue, 10 Nov 2026 10:00:00 +0000', 'hello', 'a@example.com', 'm1@example.com', null, null],
      2: ['Wed, 04 Nov 2026 10:00:00 +0000', 'thread', 'b@example.com', 'm2@example.com', null, null]
    }
  }));
  const rows = [row(1)];   // a page slice holding only uid 1
  await hydrateMeta(rows, fs);   // no prune
  assert.equal(fs.stats.messageReads, 0);
  assert.equal(rows[0].subject, 'hello');
  assert.deepEqual(fs.stats.writes, [], 'subset read → index untouched, no rewrite');
  assert.ok(jsonOf(files).messages['2'], 'uid outside the subset SURVIVES');
}

// ---- 3c. new arrival via the delta path (subset) joins without pruning ----
{
  const {fs, files} = makeFs();
  files.set(UIDVALIDITY, '42\n');
  files.set(`${DIR}/cur/3.eml`, M3);
  files.set(INDEX, JSON.stringify({
    version: 1,
    uidvalidity: 42,
    messages: {
      1: ['Tue, 10 Nov 2026 10:00:00 +0000', 'hello', 'a@example.com', 'm1@example.com', null, null]
    }
  }));
  const rows = [row(3)];   // just the freshly arrived message
  await hydrateMeta(rows, fs);
  assert.equal(fs.stats.messageReads, 1);
  assert.equal(rows[0].subject, 'later');
  const index = jsonOf(files);
  assert.ok(index.messages['1'] && index.messages['3'], 'both uids indexed');
}

// ---- 5. uidvalidity change invalidates wholesale ---------------------------
{
  const {fs, files} = makeFs();
  files.set(UIDVALIDITY, '43\n');   // folder resynced: uids re-numbered
  files.set(`${DIR}/cur/1.eml`, M1);
  files.set(INDEX, JSON.stringify({
    version: 1,
    uidvalidity: 42,
    messages: {1: ['STALE', 'STALE', 'STALE', 'STALE', null, null]}
  }));
  const rows = [row(1)];
  await hydrateMeta(rows, fs, {prune: true});
  assert.equal(fs.stats.messageReads, 1, 'stale index ignored → re-parse');
  assert.equal(rows[0].subject, 'hello', 'fresh truth served');
  assert.equal(jsonOf(files).uidvalidity, 43);
}

// ---- 6. corrupt index falls back to a full parse ---------------------------
{
  const {fs, files} = makeFs();
  files.set(UIDVALIDITY, '42\n');
  files.set(`${DIR}/cur/1.eml`, M1);
  files.set(INDEX, '{not json');
  const rows = [row(1)];
  await hydrateMeta(rows, fs, {prune: true});
  assert.equal(fs.stats.messageReads, 1);
  assert.equal(rows[0].subject, 'hello');
  assert.ok(jsonOf(files).messages['1'], 'index rebuilt from the wreckage');
}

// ---- 7. unreadable message file: row stays bare, no index entry ------------
{
  const {fs, files} = makeFs();
  files.set(UIDVALIDITY, '42\n');
  // 2.eml missing from the fake store — the slice read throws
  files.set(`${DIR}/cur/1.eml`, M1);
  const rows = [row(1), row(2)];
  await hydrateMeta(rows, fs, {prune: true});
  assert.equal(rows[0].subject, 'hello');
  assert.equal(rows[1].subject, null, 'unreadable file: uid+flags only');
  assert.equal(jsonOf(files).messages['2'], undefined, 'nothing cached for it');
  // and a repeat read retries it (self-healing once the file appears)
  files.set(`${DIR}/cur/2.eml`, M2);
  await hydrateMeta([row(1), row(2)], fs, {prune: true});
  assert.equal(jsonOf(files).messages['2'][1], 'thread');
}

// ---- 7b. progress rides the parse: {done, total} per attempt ---------------
{
  const {fs, files} = makeFs();
  files.set(UIDVALIDITY, '42\n');
  files.set(`${DIR}/cur/1.eml`, M1);
  files.set(`${DIR}/cur/2.eml`, M2);
  const events = [];
  await hydrateMeta([row(1), row(2)], fs, {prune: true, onProgress: e => events.push({...e})});
  assert.deepEqual(events, [{done: 1, total: 2}, {done: 2, total: 2}]);
  // a warm read reports nothing
  events.length = 0;
  await hydrateMeta([row(1), row(2)], fs, {prune: true, onProgress: e => events.push({...e})});
  assert.deepEqual(events, [], 'warm read → no parse, no progress');
}

// ---- 7c. duplicate uids (interloper beside the live message): direct parse,
//         never indexed, never served from the index ------------------------
{
  const {fs, files} = makeFs();
  files.set(UIDVALIDITY, '42\n');
  files.set(`${DIR}/cur/5.eml`, M1);
  files.set(`${DIR}/cur/5x.eml`, M3);   // another file claiming uid 5
  const dup = uid => ({...row(uid), entry: {uid, path: `${DIR}/cur/${uid}.eml`, maildir: {dir: DIR}}});
  const rows = [dup(5), {...dup(5), entry: {uid: 5, path: `${DIR}/cur/5x.eml`, maildir: {dir: DIR}}}];
  await hydrateMeta(rows, fs, {prune: true});
  assert.equal(fs.stats.messageReads, 2, 'ambiguous rows always parse directly');
  assert.equal(rows[0].subject, 'hello', 'each keeps its OWN headers');
  assert.equal(rows[1].subject, 'later');
  assert.equal(files.get(INDEX), undefined, 'never indexed (nothing cacheable, no file written)');
  // warm read: the persisted ambiguity verdict binds subset reads — the
  // cached entry (which may belong to the OTHER file) is not served
  const {fs: fs2, files: files2} = makeFs();
  files2.set(UIDVALIDITY, '42\n');
  files2.set(`${DIR}/cur/5.eml`, M1);
  files2.set(`${DIR}/cur/5x.eml`, M3);
  files2.set(INDEX, JSON.stringify({
    version: 1,
    uidvalidity: 42,
    messages: {5: ['WRONG', 'WRONG', 'WRONG', 'WRONG', null, null]},
    ambiguous: [5]   // a full-folder read saw the pair and marked the uid
  }));
  const rows2 = [{...dup(5), entry: {uid: 5, path: `${DIR}/cur/5.eml`, maildir: {dir: DIR}}}];   // subset
  await hydrateMeta(rows2, fs2);
  assert.equal(fs2.stats.messageReads, 1, 'ambiguous uid parses directly even on a subset read');
  assert.equal(rows2[0].subject, 'hello', 'the other file\'s cached headers are not served');
  assert.equal(jsonOf(files2).messages['5'][1], 'WRONG', 'the entry itself survives (subset read cannot re-derive)');
  // the next FULL read resolves the pair truth: still ambiguous here → stays
  const before = fs2.stats.messageReads;
  await hydrateMeta([
    {...dup(5), entry: {uid: 5, path: `${DIR}/cur/5.eml`, maildir: {dir: DIR}}},
    {...dup(5), entry: {uid: 5, path: `${DIR}/cur/5x.eml`, maildir: {dir: DIR}}}
  ], fs2, {prune: true});
  assert.deepEqual(jsonOf(files2).ambiguous, [5]);
  assert.equal(fs2.stats.messageReads - before, 2, 'both rows of the pair parse directly');
}

// ---- 8. rows without an indexable entry parse directly, uncached -----------
{
  const {fs, files} = makeFs();
  files.set(UIDVALIDITY, '42\n');
  files.set(`${DIR}/cur/0.eml`, M1);
  const surrogate = {
    uid: null, flags: [], subject: null, from: null, date: null,
    messageId: null, references: null, inReplyTo: null,
    entry: {uid: null, path: `${DIR}/cur/0.eml`, maildir: {dir: DIR}}
  };
  const rows = [surrogate, row(1)];
  files.set(`${DIR}/cur/1.eml`, M2);
  await hydrateMeta(rows, fs);
  assert.equal(surrogate.subject, 'hello', 'surrogate parsed from its file');
  const index = jsonOf(files);
  assert.deepEqual(Object.keys(index.messages), ['1'],
    'only the positive-uid row enters the index');
  assert.equal(index.messages['1'][1], 'thread');
}

// ---- 9. index for a folder without .uidvalidity still serves ---------------
{
  const {fs, files} = makeFs();   // no .uidvalidity file at all
  files.set(`${DIR}/cur/1.eml`, M1);
  await hydrateMeta([row(1)], fs);
  assert.equal(jsonOf(files).uidvalidity, 0);
  const {fs: fs2, files: files2} = makeFs();
  files2.set(INDEX, files.get(INDEX));   // same index, still no uidvalidity
  const rows2 = [row(1)];
  await hydrateMeta(rows2, fs2);
  assert.equal(fs2.stats.messageReads, 0, 'uidvalidity-less folder keeps its index');
  assert.equal(rows2[0].subject, 'hello');
}

console.log('header-index.test.mjs — all assertions passed');
