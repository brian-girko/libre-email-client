#!/usr/bin/env node
// test-dirs.mjs — end-to-end test for add/delete folders.
//
// Boots the IMAP test server + the ws-to-tls bridge, connects through the
// MailApi facade (wasm core) and exercises createDir/deleteDir end to end:
// creation (nested, implicit parents), listing refresh, opening the new
// mailbox, deletion, and every guard (INBOX, existing, unknown, parents).
//
//   node tests/test-dirs.mjs

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

const api = await createMailApi({
  bridgeUrl: bridge.url,
  host: '127.0.0.1',
  port: imap.port,
  secure: false,
  user: 'testuser',
  pass: 'testpass',
  accountId: 'test-dirs',
  cachePolicy: 'epoch',
  wasmBytes: new Uint8Array(
    await readFile(new URL('../extension/core/rust-imap-client/mail_core_bg.wasm', import.meta.url))
  ),
});

const names = async () => (await api.listDirs()).map(d => d.name);

try {
  await api.connect();

  // baseline: the seeded mailboxes
  assert.deepEqual(
    (await names()).sort(),
    ['Archive', 'INBOX', 'Sparse', 'Work', 'Work/Meetings', 'Work/Projects'],
    'seeded mailboxes listed'
  );

  // create top level
  await api.createDir('Test');
  assert.ok((await names()).includes('Test'), 'created folder shows up in listDirs');
  const testDir = (await api.listDirs()).find(d => d.name === 'Test');
  assert.ok(testDir.attrs.includes('\\HasNoChildren'), 'new folder has no children');

  // create nested under an existing folder
  await api.createDir('Work/Hobbies');
  assert.ok((await names()).includes('Work/Hobbies'), 'nested folder created');
  assert.ok(
    (await api.listDirs()).find(d => d.name === 'Work').attrs.includes('\\HasChildren'),
    'parent gains HasChildren after nested create'
  );

  // create with missing intermediate parents
  await api.createDir('Deep/A/B');
  assert.deepEqual(
    (await names()).filter(n => n === 'Deep' || n.startsWith('Deep/')).sort(),
    ['Deep', 'Deep/A', 'Deep/A/B'],
    'intermediate hierarchy created implicitly'
  );

  // the new mailbox is selectable and empty
  const status = await api.openDir('Test');
  assert.equal(status.exists, 0, 'new mailbox is empty');
  assert.deepEqual(await api.listThreads(), [], 'threads of an empty mailbox');
  assert.equal(api.selectedDir(), 'Test');

  // deletion
  await api.deleteDir('Work/Hobbies');
  assert.ok(!(await names()).includes('Work/Hobbies'), 'deleted folder gone from listDirs');
  assert.ok((await names()).includes('Work'), 'parent survives a child delete');

  await api.deleteDir('Deep/A/B');
  assert.deepEqual(
    (await names()).filter(n => n === 'Deep' || n.startsWith('Deep/')).sort(),
    ['Deep', 'Deep/A'],
    'leaf deleted, intermediates kept'
  );

  // deleting the open dir closes it
  await api.deleteDir('Test');
  assert.equal(api.selectedDir(), null, 'open dir reset after deleting it');
  await assert.rejects(() => api.listThreads(), /openDir/, 'listThreads requires openDir again');
  await api.openDir('INBOX');
  assert.equal(api.selectedDir(), 'INBOX', 'reselect works after delete');

  // guards: deletes
  await assert.rejects(() => api.deleteDir('INBOX'), /delete/i, 'INBOX cannot be deleted');
  await assert.rejects(() => api.deleteDir('Work'), /inferior|NO/i, 'parent with children cannot be deleted');
  await assert.rejects(() => api.deleteDir('NoSuchFolder'), /no such/i, 'unknown folder cannot be deleted');

  // guards: creates
  await assert.rejects(() => api.createDir('INBOX'), /create|INBOX|NO/i, 'INBOX cannot be created');
  await assert.rejects(() => api.createDir('Work'), /exists|NO/i, 'existing folder cannot be recreated');

  // the session still works after all the churn
  const dirs = await api.listDirs();
  assert.ok(dirs.length >= 6, 'listing healthy after create/delete churn');

  console.log('test-dirs: all assertions passed');
}
finally {
  await api.close().catch(() => {});
  await bridge.close();
  await imap.close();
}
