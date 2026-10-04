#!/usr/bin/env node
// Regression tests for the open-folder reconcile's guard state machine
// (data/client/list-reconcile.mjs) — the mails-view(delta) op the fs-event
// router calls. No chrome/DOM: every input is injected. Under node the
// timing is shrunk (retryMs 1) so the cycles still yield to the timers.
// Run: node data/client/list-reconcile.test.mjs

import assert from 'node:assert/strict';
import {createReconciler} from './list-reconcile.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// one reconciler per section, fully injectable
function make({starOpen = () => false, searching = () => false, retryMax = 20} = {}) {
  const seen = {syncs: 0, logs: []};
  const r = createReconciler({
    syncCurrent: () => { seen.syncs++; return 'synced'; },
    starOpen,
    searching,
    retryMs: 1,
    retryMax,
    log: note => seen.logs.push(note)
  });
  return {r, seen};
}

// settle the retry cycle: generous ceiling ≫ any realistic retry budget
async function settle() {
  await sleep(50);
}

// ---- 1. plain reconcile syncs at once; repeated calls keep syncing ----
{
  const {r, seen} = make();
  r.reconcile();
  assert.equal(seen.syncs, 1, 'open guards absent → immediate flush');
  r.reconcile();
  await settle();
  assert.equal(seen.syncs, 2);
}

// ---- 2. picker open → deferred; the flush lands exactly once on close ----
{
  let open = true;
  const {r, seen} = make({starOpen: () => open});
  r.reconcile();
  r.reconcile();
  r.reconcile();
  assert.equal(seen.syncs, 0, 'deferred while the palette is open');
  open = false;
  await settle();
  assert.equal(seen.syncs, 1, 'owed flush runs once after close');
  await settle();
  assert.equal(seen.syncs, 1, 'no runaway flushes after the close');
}

// ---- 3. a leaked open mirror (THE BUG: openCount never decremented)
//      must not wedge the view: the flush forces through past the cap ----
{
  const {r, seen} = make({starOpen: () => true, retryMax: 200});   // ~200 ms
  r.reconcile();   // latched forever by the bad mirror
  await sleep(50);
  assert.equal(seen.syncs, 0, 'still waiting while under the cap');
  await sleep(250);
  assert.equal(seen.syncs, 1, 'bounded cap forced the flush through');
}

// ---- 4. search mode is a plain drop (no deferral, no retry churn) ----
{
  const {r, seen} = make({searching: () => true});
  r.reconcile();
  await settle();
  await settle();
  assert.equal(seen.syncs, 0, 'search drop stays dropped');
  assert.deepEqual(seen.logs, [], 'no deferral log on the search path');
}

// ---- 5. the deciding guard is evaluated LIVE per call ----
{
  let open = true;
  const {r, seen} = make({starOpen: () => open});
  r.reconcile();
  open = false;   // closed before the first tick — no retry needed
  await settle();
  assert.equal(seen.syncs, 1);
}

// ---- 6. init() clears a latched deferral ----
{
  const {r, seen} = make({starOpen: () => true});
  r.reconcile();
  r.init();
  r.reconcile();   // guard re-evaluated fresh after init
  assert.ok(seen.logs.filter(l => l.includes('deferred')).length >= 1);
}

console.log('list-reconcile.test.mjs — all assertions passed');
