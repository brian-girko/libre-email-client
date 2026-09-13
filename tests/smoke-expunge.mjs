#!/usr/bin/env node
// smoke-expunge.mjs — static wiring assertions for true EXPUNGE
// ("Delete from IMAP after saving"): the wasm core must export
// expunge_messages (UID EXPUNGE, RFC 4315), the facade must call it from
// deleteMessages, and the test server must implement EXPUNGE / UID EXPUNGE.
//
//   node tests/smoke-expunge.mjs

import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const lib = await readFile(new URL('../rust-client/src/lib.rs', import.meta.url), 'utf8');
const glueDts = await readFile(new URL('../rust-client/pkg/mail_core_bg.wasm.d.ts', import.meta.url), 'utf8');
const glue = await readFile(new URL('../extension/core/rust-imap-client/mail_core.mjs', import.meta.url), 'utf8');
const apiSource = await readFile(new URL('../rust-client/js/api.mjs', import.meta.url), 'utf8');
const apiDeployed = await readFile(new URL('../extension/core/rust-imap-client/api.mjs', import.meta.url), 'utf8');
const server = await readFile(new URL('../server/imap-test-server.mjs', import.meta.url), 'utf8');

// rust core: UID EXPUNGE with UIDPLUS guard and safe fallback
assert.ok(lib.includes('pub async fn expunge_messages('), 'lib.rs exports expunge_messages');
assert.ok(/expunge_messages[\s\S]*?has_str\("UIDPLUS"\)/.test(lib), 'expunge_messages checks UIDPLUS capability');
assert.ok(/expunge_messages[\s\S]*?uid_expunge\(/.test(lib), 'expunge_messages issues UID EXPUNGE');
assert.ok(!/expunge_messages[\s\S]{0,600}?\.expunge\(\)/.test(lib), 'no-UIDPLUS fallback does NOT purge (flag-only)');

// wasm glue: export actually built into the deployed core
assert.ok(glueDts.includes('mailclient_expunge_messages'), 'pkg .d.ts declares the raw expunge export');
assert.ok(glue.includes('mailclient_expunge_messages'), 'deployed glue wraps mailclient_expunge_messages');

// facade: deleteMessages calls expunge_messages when the core provides it
for (const [name, src] of [['api source', apiSource], ['deployed api', apiDeployed]]) {
  assert.ok(src.includes('async deleteMessages(uids)'), `${name} has deleteMessages`);
  assert.ok(src.includes("typeof client.expunge_messages === 'function'"), `${name} gates on expunge_messages export`);
  assert.ok(src.includes("clientCall('expunge_messages', set)"), `${name} calls expunge_messages`);
}

// test server: both variants implemented
assert.ok(server.includes('handleExpunge(tag, true, args.slice(1))'), 'server dispatches UID EXPUNGE');
assert.ok(server.includes('handleExpunge(tag, false, args)'), 'server dispatches plain EXPUNGE');
assert.ok(server.includes('EXPUNGE completed'), 'server responds OK EXPUNGE completed');

console.log('smoke-expunge: all assertions passed');
