#!/usr/bin/env node
// smoke-cache.mjs — assertions for the MailCache helper (memory backend in
// Node): epoch/short/keys TTL policies, key-scoped entries, LRU overflow,
// account isolation, and sweep behavior.
//
//   node tests/smoke-cache.mjs

import assert from 'node:assert/strict';
import {MailCache} from '../rust-client/js/cache.mjs';

// --- basic put/get round trip + key scoping -------------------------------
const c1 = await new MailCache({policy: 'epoch', accountId: 'a1'});
assert.equal(c1.backendName, 'memory', 'Node falls back to the memory backend');

await c1.put('bodies', ['INBOX', '100', '55'], new Uint8Array([1, 2, 3]));
const hit = await c1.get('bodies', ['INBOX', '100', '55']);
assert.ok(hit instanceof Uint8Array && hit.length === 3 && hit[0] === 1, 'body round trip');
assert.deepEqual(await c1.get('bodies', ['INBOX', '100', '56']), null, 'different uid misses');
assert.deepEqual(await c1.get('bodies', ['Archive', '100', '55']), null, 'different dir misses');

// account isolation
const c2 = await new MailCache({policy: 'epoch', accountId: 'a2'});
assert.deepEqual(await c2.get('bodies', ['INBOX', '100', '55']), null, 'other account misses');
await c2.put('bodies', ['INBOX', '100', '55'], new Uint8Array([9]));
assert.equal((await c1.get('bodies', ['INBOX', '100', '55']))[0], 1, 'c1 unaffected by c2 write');
await c2.clear();
assert.equal(await c2.get('bodies', ['INBOX', '100', '55']), null, 'clear wipes own account');
assert.equal((await c1.get('bodies', ['INBOX', '100', '55']))[0], 1, 'clear does not touch other accounts');

// uidvalidity epoch isolation: a new epoch never sees the old one
await c1.put('bodies', ['INBOX', '111', '55'], new Uint8Array([7]));
assert.equal((await c1.get('bodies', ['INBOX', '100', '55']))[0], 1, 'old epoch intact');
assert.notEqual(
  c1.url('bodies', 'INBOX', '111', '55'),
  c1.url('bodies', 'INBOX', '100', '55'),
  'new epoch key differs from old epoch key'
);

// --- invalidateThreads: only the given dir's thread entries die ------------
await c1.put('threads', ['INBOX', '114000', '100'], new Uint8Array([1]));
await c1.put('threads', ['Archive', '114000', '100'], new Uint8Array([2]));
await c1.put('bodies', ['INBOX', '100', '55'], new Uint8Array([3])); // must survive
await c1.invalidateThreads('INBOX');
assert.deepEqual(await c1.get('threads', ['INBOX', '114000', '100']), null, 'dir threads invalidated');
assert.equal((await c1.get('threads', ['Archive', '114000', '100']))[0], 2, 'other dir threads intact');
assert.ok(await c1.get('bodies', ['INBOX', '100', '55']), 'bodies survive thread invalidation');

// --- TTL policies ----------------------------------------------------------
const short = await new MailCache({policy: 'short', accountId: 't'});
await short.put('bodies', ['INBOX', '1', '1'], new Uint8Array([1]));
await short.put('threads', ['INBOX', '1', '1'], new Uint8Array([2]));
// backdate both entries beyond the 15-minute window
for (const key of await short.backend.keys()) {
  const hit = short.backend.map.get(key);
  hit.storedAt = Date.now() - 20 * 60 * 1000;
}
assert.deepEqual(await short.get('bodies', ['INBOX', '1', '55']), null, 'short policy: expired body misses');
assert.deepEqual(await short.get('threads', ['INBOX', '1', '1']), null, 'short policy: expired threads miss');

const keysOnly = await new MailCache({policy: 'keys', accountId: 'k'});
await keysOnly.put('bodies', ['INBOX', '1', '55'], new Uint8Array([1]));
const meta = keysOnly.backend.map.get(keysOnly.url('bodies', 'INBOX', '1', '55'));
meta.storedAt = Date.now() - 48 * 60 * 60 * 1000; // 2 days old
assert.ok(await keysOnly.get('bodies', ['INBOX', '1', '55']), 'keys policy: age never expires');

const epoch = await new MailCache({policy: 'epoch', accountId: 'e'});
await epoch.put('bodies', ['INBOX', '1', '55'], new Uint8Array([1]));
epoch.backend.map.get(epoch.url('bodies', 'INBOX', '1', '55')).storedAt = Date.now() - 48 * 60 * 60 * 1000;
assert.ok(await epoch.get('bodies', ['INBOX', '1', '55']), 'epoch policy: bodies never expire');
// threads: backdate past the 1h backstop
await epoch.put('threads', ['INBOX', '114000', '100'], new Uint8Array([4]));
epoch.backend.map.get(epoch.url('threads', 'INBOX', '114000', '100')).storedAt = Date.now() - 2 * 60 * 60 * 1000;
assert.deepEqual(await epoch.get('threads', ['INBOX', '114000', '100']), null, 'epoch policy: 1h thread backstop');

// --- LRU overflow -----------------------------------------------------------
const tiny = await new MailCache({policy: 'keys', accountId: 'lru'});
// fill beyond the cap
for (let i = 1; i <= 250; i++) {
  await tiny.put('bodies', ['INBOX', String(i)], new Uint8Array([i % 256]));
}
const survivors = (await tiny.backend.keys()).filter(k => k.startsWith(tiny.url('bodies'))).length;
assert.ok(survivors <= 200, `LRU cap enforced (${survivors} <= 200)`);

// unknown policy falls back to epoch semantics
const odd = await new MailCache({policy: 'bogus', accountId: 'x'});
assert.equal(odd.policy, 'epoch', 'unknown policy falls back to epoch');

console.log('smoke-cache: all assertions passed');
