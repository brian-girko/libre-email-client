#!/usr/bin/env node
// test-threads.mjs — end-to-end test for Gmail-style threading.
//
// Boots the IMAP test server + the ws-to-tls bridge, connects through the
// MailApi facade (wasm core) and asserts that the seeded INBOX conversations
// group correctly via the JWZ threader inside the wasm module.
//
//   node tests/test-threads.mjs

import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';
import {startImapTestServer} from '../server/imap-test-server.mjs';
import {createMailApi} from '../extension/core/rust-imap-client/api.mjs';

const require = createRequire(import.meta.url);
const {startWsBridge} = require('../server/ws-to-tls.js');

const imap = await startImapTestServer({
  port: 0,
  noDelivery: true,
  stateFile: null,
  quiet: true,
});
const bridge = await startWsBridge({wsPort: 0});
console.log(`imap on 127.0.0.1:${imap.port}, bridge on ${bridge.url}`);

// INBOX seeds: 101/102 singles + 103 (reply to 101) + {104,105,106} chain + 107
const api = await createMailApi({
  bridgeUrl: bridge.url,
  host: '127.0.0.1',
  port: imap.port,
  secure: false,
  user: 'testuser',
  pass: 'testpass',
  accountId: 'test-account',
  cachePolicy: 'epoch',
  wasmBytes: new Uint8Array(
    await readFile(new URL('../extension/core/rust-imap-client/mail_core_bg.wasm', import.meta.url))
  ),
});

try {
  await api.connect();

  // flat listing still works
  await api.openDir('INBOX');
  const files = await api.listFiles({page: 0, pageSize: 50});
  assert.equal(files.length, 7, 'INBOX has 7 messages');
  assert.deepEqual(
    files.map(f => f.uid),
    [107, 106, 105, 104, 103, 102, 101],
    'flat list newest first'
  );

  // threads: JWZ grouping inside the wasm core
  const threads = await api.listThreads();
  assert.equal(threads.length, 4, 'INBOX groups into 4 conversations');
  assert.deepEqual(
    threads.map(t => t.uids),
    [[107], [104, 105, 106], [101, 103], [102]],
    'threads newest first, members oldest first'
  );

  const chain = threads[1];
  assert.equal(chain.count, 3);
  assert.equal(chain.subject, 'Sprint planning Friday', 'thread subject comes from the oldest message');
  assert.equal(chain.from, 'Dana Lead <dana@example.com>');
  assert.equal(chain.unread, 2, '104 and 105 unread, 106 seen');
  assert.equal(chain.flagged, false);
  assert.deepEqual(
    chain.messages.map(m => m.uid),
    [104, 105, 106],
    'thread messages oldest first'
  );

  const cross = threads[2];
  assert.equal(cross.subject, 'Тестовое письмо', 'reply joins the root conversation');
  assert.equal(cross.unread, 0);
  assert.deepEqual(cross.uids, [101, 103]);

  assert.equal(threads[0].unread, 1, 'single unread message');
  assert.equal(threads[3].subject, 'Second stub message');

  // thread cache must invalidate after a flag change
  await api.setFlags([107], ['\\Seen'], []);
  const after = await api.listThreads();
  assert.equal(after[0].unread, 0, 'mark-read reflected after cache invalidation');

  // regression: mailboxes with huge UID holes (uidnext >> exists) must not
  // walk the UID space; threading goes by sequence number
  await api.openDir('Sparse');
  const sparse = await api.listThreads();
  assert.equal(sparse.length, 2, 'sparse mailbox groups into 2 conversations');
  assert.deepEqual(
    sparse.map(t => t.uids),
    [[113931], [113929, 113930]],
    'sparse threads newest first despite UID holes'
  );

  // regression: concurrent API calls (e.g. thread preview firing readFile for
  // every message while listThreads/setFlags are in flight) must queue on
  // the wasm object instead of panicking with "recursive use of an object
  // detected" or cross-feeding IMAP responses ("no body returned")
  await api.openDir('INBOX');
  const bodies = await Promise.all([
    api.readFile(104),
    api.readFile(105),
    api.readFile(106),
    api.setFlags([103], ['\\Seen'], []),
    api.listThreads(),
  ]);
  for (const raw of bodies.slice(0, 3)) {
    assert.ok(raw.length > 0, 'concurrent readFile returned a body');
    assert.ok(new TextDecoder().decode(raw).includes('Message-ID:'), 'body is a real RFC822 message');
  }
  assert.equal(bodies[4].length, 4, 'listThreads still returns 4 conversations');

  // ---- cache behavior -----------------------------------------------------
  assert.equal(api.cacheBackend(), 'memory', 'Node e2e uses the memory cache fallback');
  // second readFile of the same uid must be served from the persistent cache
  const body104a = await api.readFile(104);
  const body104b = await api.readFile(104);
  assert.deepEqual([...body104b], [...body104a], 'second readFile served from cache, identical bytes');
  assert.ok(body104b.length > 0, 'cached body is non-empty');

  // a brand-new API instance (simulating a reopened popup) must also hit
  // the persistent cache — same wasm bytes, no need to refetch the body
  const api2 = await createMailApi({
    bridgeUrl: bridge.url,
    host: '127.0.0.1',
    port: imap.port,
    secure: false,
    user: 'testuser',
    pass: 'testpass',
    accountId: 'test-account',
    cachePolicy: 'epoch',
    wasmBytes: new Uint8Array(
      await readFile(new URL('../extension/core/rust-imap-client/mail_core_bg.wasm', import.meta.url))
    ),
  });
  try {
    await api2.connect();
    await api2.openDir('INBOX');
    const cached = await api2.readFile(104);
    assert.deepEqual([...cached], [...body104a], 'persistent cache survives across API sessions');
    await api2.setFlags([104], ['\\Flagged'], []);
  }
  finally {
    await api2.close().catch(() => {});
  }

  // ---- server-side search -------------------------------------------------
  // plain text lands in the {104,105,106} conversation via subject/body
  const hitsSprint = await api.search({dir: 'INBOX', query: 'sprint'});
  assert.deepEqual(
    hitsSprint.map(t => t.uids),
    [[104, 105, 106]],
    'search "sprint" finds the planning thread'
  );
  assert.equal(hitsSprint[0].dir, 'INBOX', 'this-folder results tagged with dir');

  // from: prefix matches only Dana's own messages (105 is Bob's reply);
  // the threader still groups the chain [104, 106] together
  const hitsDana = await api.search({dir: 'INBOX', query: 'from:dana'});
  assert.deepEqual(
    hitsDana.map(t => t.uids),
    [[104, 106]],
    'from:dana finds the two Dana messages, grouped'
  );

  // full-text hits the two Alice messages
  const hitsAlice = await api.search({dir: 'INBOX', query: 'alice@example.com'});
  assert.deepEqual(
    hitsAlice.map(t => t.uids),
    [[107], [102]],
    'search alice@example.com finds both Alice threads'
  );

  // no matches -> empty array
  assert.deepEqual(await api.search({dir: 'INBOX', query: 'zzz-no-match'}), [], 'no-match returns empty');

  // dates: the 104-106 chain is dated 8 Sep 2026; 107 on 9 Sep. Threads come
  // back newest-first: the 9 Sep single first, then the 8 Sep chain.
  const hitsSince = await api.search({dir: 'INBOX', query: 'since:2026-09-08'});
  assert.deepEqual(
    hitsSince.map(t => t.uids),
    [[107], [104, 105, 106]],
    'since:8-Sep-2026 -> 9 Sep thread first, then 8 Sep threads'
  );
  const hitsBefore = await api.search({dir: 'INBOX', query: 'before:2026-09-08'});
  assert.deepEqual(
    hitsBefore.map(t => t.uids),
    [[101, 103], [102]],
    'before:8-Sep-2026 -> 7 Sep threads newest-first'
  );

  // all-folder scope (the UI strips the all: prefix and sets the flag):
  // Archive seeds also match
  const hitsAll = await api.search({dir: 'INBOX', query: 'facture', allFolders: true});
  assert.ok(hitsAll.some(t => t.uids.includes(201)), 'all-folder search reaches Archive');
  assert.ok(hitsAll.every(t => t.dir), 'all-folder results carry dir tags');

  console.log('test-threads: all assertions passed');
}
finally {
  await api.close().catch(() => {});
  await bridge.close();
  await imap.close();
}
