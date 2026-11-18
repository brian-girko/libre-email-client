#!/usr/bin/env node
// test-flags-fetch.mjs — end-to-end test for the incremental-sync surface of
// the wasm MailApi: flag-only sweeps (listFlags), disjoint uid-set envelope
// fetches (listFiles {uids}) and CONDSTORE HIGHESTMODSEQ reporting (openDir).
//
// Boots the IMAP test server + the ws-to-tls bridge, connects through the
// MailApi facade (wasm core) and asserts the wire behavior the sync engine's
// incremental survey relies on.
//
//   node tests/test-flags-fetch.mjs

import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';
import {startImapTestServer} from '../server/imap-test-server.mjs';
import {createMailApi} from '../extension/v2/core/rust-imap-client/api.mjs';

const require = createRequire(import.meta.url);
const {startWsBridge} = require('../server/ws-to-tls.js');

const imap = await startImapTestServer({
  port: 0,
  noDelivery: true,
  condstore: true,
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
  wasmBytes: new Uint8Array(
    await readFile(new URL('../extension/v2/core/rust-imap-client/mail_core_bg.wasm', import.meta.url))
  ),
});

let n = 0;
const ok = (msg) => console.log(`  ✓ ${msg} (${++n})`);

try {
  await api.connect();

  // ---- CONDSTORE: the capability probe selects with (CONDSTORE) and the
  // untagged OK's HIGHESTMODSEQ surfaces as a decimal string
  const st = await api.openDir('INBOX');
  assert.equal(typeof st.highestModSeq, 'string', 'openDir reports a modseq string');
  assert.ok(/^[0-9]+$/.test(st.highestModSeq), `modseq is a decimal literal (${st.highestModSeq})`);
  ok('openDir carries HIGHESTMODSEQ as a decimal string');

  // ---- flag-only sweep: the whole range in one call
  const flags = await api.listFlags({fromUid: 1, toUid: 999});
  assert.equal(flags.length, 7, 'flag sweep covers all 7 seeded messages');
  assert.deepEqual(
    flags.map(f => f.uid),
    [101, 102, 103, 104, 105, 106, 107],
    'flag rows ascending by uid'
  );
  for (const row of flags) {
    assert.ok(Array.isArray(row.flags), 'each row carries a flags array');
    assert.equal(row.subject, undefined, 'no ENVELOPE data rides the flag sweep');
    assert.equal(row.size, undefined, 'no size rides the flag sweep');
  }
  ok('listFlags returns uid+flags only, ascending');

  // ---- flag-only sweep: single-uid form + a mid range
  const one = await api.listFlags({fromUid: 104});
  assert.deepEqual(one.map(f => f.uid), [104], 'single-uid form fetches exactly that uid');
  const mid = await api.listFlags({fromUid: 104, toUid: 106});
  assert.deepEqual(mid.map(f => f.uid), [104, 105, 106], 'range form is inclusive');
  ok('listFlags single-uid and range forms');

  // ---- flag-only sweep reflects a flag change on the next call
  await api.setFlags([102], ['\\Seen'], []);
  const after = await api.listFlags({fromUid: 102});
  assert.deepEqual(after[0].flags, ['\\Seen'], 'the STORE is visible to the flag sweep');
  // the STORE bumped the folder modseq (CONDSTORE)
  const st2 = await api.openDir('INBOX');
  assert.notEqual(
    Number(st2.highestModSeq), Number(st.highestModSeq),
    `the STORE bumped HIGHESTMODSEQ (${st.highestModSeq} → ${st2.highestModSeq})`
  );
  ok('STORE bumps the modseq; the flag sweep sees the new flags');

  // ---- disjoint uid-set envelope fetch (the sync engine's lost-record path)
  const rows = await api.listFiles({uids: [104, 101]});
  assert.deepEqual(
    rows.map(r => r.uid).sort((a, b) => a - b),
    [101, 104],
    'the uid set fetches exactly the asked uids'
  );
  for (const row of rows) {
    assert.ok(row.size > 0, `uid ${row.uid} carries an RFC822.SIZE`);
    assert.ok(row.subject != null, `uid ${row.uid} carries an ENVELOPE subject`);
    assert.ok(row.messageId, `uid ${row.uid} carries the ENVELOPE message-id`);
  }
  ok('listFiles({uids}) fetches a disjoint set in one call, envelope intact');

  // ---- empty uid set and legacy guard behaviors
  assert.deepEqual(await api.listFiles({uids: []}), [], 'an empty uid set returns nothing');
  await assert.rejects(
    () => api.listFlags({}),
    /fromUid required/,
    'listFlags demands a uid range'
  );
  ok('listFiles({uids: []}) and listFlags guard rails');

  // ---- a plain (non-CONDSTORE) server: modseq stays null
  const plain = await startImapTestServer({
    port: 0, noDelivery: true, stateFile: null, quiet: true,
  });
  const plainBridge = await startWsBridge({wsPort: 0});
  try {
    const api2 = await createMailApi({
      bridgeUrl: plainBridge.url,
      host: '127.0.0.1',
      port: plain.port,
      secure: false,
      user: 'testuser',
      pass: 'testpass',
      wasmBytes: new Uint8Array(
        await readFile(new URL('../extension/v2/core/rust-imap-client/mail_core_bg.wasm', import.meta.url))
      ),
    });
    await api2.connect();
    const st3 = await api2.openDir('INBOX');
    assert.equal(st3.highestModSeq, null,
      'a server without CONDSTORE reports no modseq');
    // the flag sweep works there just the same
    const plainFlags = await api2.listFlags({fromUid: 1, toUid: 999});
    assert.equal(plainFlags.length, 7, 'flag sweep on a plain server');
    ok('non-CONDSTORE server: highestModSeq null, flag sweep unaffected');
    await api2.close().catch(() => {});
  }
  finally {
    await plainBridge.close().catch(() => {});
    await plain.close();
  }
}
finally {
  await api.close().catch(() => {});
  await bridge.close();
  await imap.close();
}

console.log(`test-flags-fetch: all ${n} assertions passed`);
