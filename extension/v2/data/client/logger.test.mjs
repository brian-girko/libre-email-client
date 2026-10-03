#!/usr/bin/env node
// Regression tests for the one-failure-per-account rule in the mail client's
// activity logger (data/client/logger.mjs). The store is a plain module state
// with no chrome or DOM dependencies, so it runs directly under node.
// Run: node data/client/logger.test.mjs

import assert from 'node:assert/strict';
import * as logger from './logger.mjs';

// The store is module-level state: wipe every entry between sections so
// tests stay independent.
function reset() {
  for (const entry of logger.getAll()) {
    logger.remove(entry.id);
  }
}

const failedCount = () =>
  logger.getAll().filter(e => e.state === 'failed').length;

// ---- 1. two failures on the same account: the newer replaces the older ----
reset();
logger.begin({id: 'e1', kind: 'sync', account: 'a1', label: 'sync · a1'});
logger.fail('e1', 'network down');
logger.begin({id: 'e2', kind: 'sync', account: 'a1', label: 'sync · a1'});
logger.fail('e2', 'still offline');
// one failed line for the account, and it carries the NEWEST error text
assert.equal(failedCount(), 1);
assert.equal(logger.getAll().length, 1);
assert.equal(logger.get('e2').error, 'still offline');
assert.equal(logger.get('e1'), null);

// ---- 2. accounts are independent slots ----
reset();
logger.begin({id: 'b1', account: 'b1', label: 'sync · b1'});
logger.fail('b1', 'b1 error 1');
logger.begin({id: 'b2', account: 'b2', label: 'sync · b2'});
logger.fail('b2', 'b2 error 1');
assert.equal(failedCount(), 2);
// b1 fails again: its own row is replaced, b2's untouched
logger.begin({id: 'b3', account: 'b1', label: 'sync · b1'});
logger.fail('b3', 'b1 error 2');
assert.equal(failedCount(), 2);
assert.equal(logger.get('b1'), null);
assert.equal(logger.get('b3').error, 'b1 error 2');
assert.equal(logger.get('b2').error, 'b2 error 1');

// ---- 3. a successful run clears its account's failure; others survive ----
reset();
logger.begin({id: 'c-err', account: 'c1', label: 'sync · c1'});
logger.fail('c-err', 'c1 offline');
logger.begin({id: 'c-other', account: 'c3', label: 'sync · c3'});
logger.fail('c-other', 'c3 error');
// the clean run of c1 clears the failure slot, however old the failure is
logger.begin({id: 'c-run', account: 'c1', label: 'sync · c1'});
logger.done('c-run', 'sync finished');
assert.equal(logger.get('c-err'), null);
assert.equal(logger.get('c-other').state, 'failed');   // other account untouched
logger.remove('c-run');   // drop the done entry (it sits on the 4s TTL)

// ---- 4. a live queued/running sibling is never evicted by the rule ----
reset();
logger.begin({id: 'd-run', account: 'd1', label: 'sync · d1'});
logger.update('d-run', {state: 'running'});
logger.begin({id: 'd-err', account: 'd1', label: 'sync · d1'});
logger.fail('d-err', 'd1 failed');
// a second failure for the same account replaces the first one…
logger.begin({id: 'd-err2', account: 'd1', label: 'sync · d1'});
logger.fail('d-err2', 'd1 failed again');
// …but the live run is never touched (only failed entries are evicted)
assert.equal(logger.get('d-run').state, 'running');
assert.equal(failedCount(), 1);
assert.equal(logger.get('d-err2').error, 'd1 failed again');
logger.remove('d-run');

// ---- 5. quiet entries never touch the account slot ----
reset();
logger.begin({id: 'f-vis', account: 'f1', label: 'sync · f1'});
logger.fail('f-vis', 'f1 offline');
// a quiet (never-rendered) entry of the same account fails and vanishes:
// it must NOT evict the visible failure, nor claim the slot for itself
logger.begin({id: 'f-quiet', account: 'f1', label: 'mark-read', quiet: true});
logger.fail('f-quiet', 'quiet failure');
assert.equal(logger.get('f-quiet'), null);
assert.equal(logger.get('f-vis').state, 'failed');
// same in the success direction: a quiet entry finishing must NOT clear it
logger.begin({id: 'f-quiet2', account: 'f1', label: 'mark-read', quiet: true});
logger.done('f-quiet2', 'marked');
assert.equal(logger.get('f-vis').state, 'failed');
assert.equal(logger.get('f-quiet2'), null);

// ---- 6. entries without an account key behave exactly as before ----
reset();
logger.begin({id: 'g1', label: 'filter pass'});   // worker-owned, no account
logger.fail('g1', 'filter failed');
logger.begin({id: 'g2', label: 'filter pass'});
logger.fail('g2', 'filter failed again');
// both keyless failures persist — no account, no slot, no cross-eviction
assert.equal(failedCount(), 2);
// and a keyed account failure does not clear keyless failures
logger.begin({id: 'g3', account: 'g1', label: 'sync · g1'});
logger.fail('g3', 'g1 offline');
assert.equal(failedCount(), 3);

// ---- 7. the cap backstop: failed entries evict like done ones ----
reset();
for (let i = 0; i < 100; i++) {
  logger.begin({id: 'fill-' + i, kind: 'sync', label: 'sync · fill'});
  logger.fail('fill-' + i, 'offline ' + i);
}
assert.equal(logger.getAll().length, 100);
// one more begin runs over the cap: trim drops the OLDEST failed entry first
logger.begin({id: 'fill-extra', kind: 'sync', label: 'sync · fill'});
assert.equal(logger.getAll().length, 100);
assert.equal(logger.get('fill-0'), null);          // oldest failed, evicted
assert.notEqual(logger.get('fill-1'), null);       // newer failures survive
assert.equal(logger.get('fill-extra').state, 'queued');   // the newcomer is in
assert.equal(failedCount(), 99);                   // 99 survivors, 1 evicted
logger.remove('fill-extra');

console.log('logger tests: all passed');
