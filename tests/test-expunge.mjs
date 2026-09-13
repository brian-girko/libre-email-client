#!/usr/bin/env node
// test-expunge.mjs — end-to-end test for true EXPUNGE ("Delete from IMAP
// after saving"). Boots the IMAP test server + the ws-to-tls bridge,
// connects through the MailApi facade (wasm core) and asserts that
// deleteMessages permanently removes exactly the given UIDs from the
// server mailbox (UID EXPUNGE, RFC 4315) — including the guarantee that
// other clients' \Deleted flags are NOT purged by our delete.
//
//   node tests/test-expunge.mjs

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
  await api.openDir('INBOX');
  const files = await api.listFiles({page: 0, pageSize: 50});
  assert.equal(files.length, 7, 'INBOX has 7 messages');

  // empty call is a no-op
  await api.deleteMessages([]);

  // true expunge: delete a middle-of-mailbox set (exercises EXPUNGE
  // renumbering) and the messages must be gone from the server
  await api.deleteMessages([103, 105]);
  const after = await api.listFiles({page: 0, pageSize: 50});
  assert.deepEqual(
    after.map(f => f.uid),
    [107, 106, 104, 102, 101],
    '103 and 105 permanently removed, rest untouched'
  );

  // re-select: the server itself must report the lower EXISTS count
  await api.openDir('INBOX');
  assert.equal(
    (await api.listFiles({page: 0, pageSize: 50})).length,
    5,
    're-SELECT confirms server-side EXISTS dropped to 5'
  );

  // survivors are intact and readable
  const body = await api.readFile(104);
  assert.ok(body.length > 0, 'surviving message still readable');
  assert.ok(new TextDecoder().decode(body).includes('Message-ID:'), 'survivor is a real RFC822 message');

  // UID EXPUNGE precision: another client may have its own \Deleted flags
  // pending; our deleteMessages must purge ONLY our uid set.
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
    // foreign client marks 101 \Deleted but does not expunge
    await api2.setFlags([101], ['\\Deleted'], []);

    // we delete only 102
    await api.deleteMessages([102]);

    // 101 must survive (its \Deleted flag was set by someone else);
    // 102 must be gone.
    await api.openDir('INBOX');
    const uids = (await api.listFiles({page: 0, pageSize: 50})).map(f => f.uid);
    assert.ok(uids.includes(101), 'foreign \\Deleted message NOT purged by our UID EXPUNGE');
    assert.ok(!uids.includes(102), 'our message purged');
    assert.equal(uids.length, 4, 'exactly one message removed');

    // cleaning up 101 works too
    await api2.deleteMessages([101]);
    await api.openDir('INBOX');
    const finalUids = (await api.listFiles({page: 0, pageSize: 50})).map(f => f.uid);
    assert.deepEqual(finalUids, [107, 106, 104], 'final purge leaves the 4 survivors');
  }
  finally {
    await api2.close().catch(() => {});
  }

  console.log('test-expunge: all assertions passed');
}
finally {
  await api.close().catch(() => {});
  await bridge.close();
  await imap.close();
}
