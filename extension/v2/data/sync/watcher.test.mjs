#!/usr/bin/env node
// Regression test for the mid-run tombstone feed's event parsing
// (data/sync/watcher.mjs). Run: node data/sync/watcher.test.mjs
//
// The bug this pins: the offscreen watcher filtered fs-events by
// operation 'remove', but the fs gateway (core/fs.mjs) spells every
// removal 'delete' — its whole vocabulary is 'create' | 'change' |
// 'delete' | 'move'. The instant feed never fired a single event, so a
// message deleted while a sync ran was invisible to the engine until a
// pull-chunk boundary (when a durable tombstone existed at all), and the
// running sync's own writes could resurrect the deleted mail. The parser
// lives here pure so the REAL event shapes stay pinned under node.

import assert from 'node:assert/strict';
import {register} from 'node:module';
register('./offscreen/root-loader.mjs', import.meta.url);

const {tombstonesFromFsEvent} = await import('./watcher.mjs');
const {md5hex, makeFilename} = await import('./maildir.mjs');

const ok = what => console.log('watcher.test: ' + what);

const ev = (operation, src, origin = 'client') =>
  ({type: 'fs-event', origin, operation, src, dest: null});

// ---- the gateway's real spelling: removals are 'delete' ---------------------

{
  const name = makeFilename('INBOX', 7, ['\\Seen']);
  const out = tombstonesFromFsEvent(
    ev('delete', `acc/INBOX/cur/${name}`), {account: 'acc'});
  assert.equal(out.length, 1, 'a message-file removal yields one entry');
  const e = out[0];
  assert.equal(e.folder, 'INBOX');
  assert.equal(e.uid, 7);
  assert.equal(e.msgid, null, 'the file is gone — the watcher cannot read it');
  assert.ok(!Number.isNaN(Date.parse(e.at)), 'the entry is timestamped');
  ok("'delete' under the account dir parses (the feed actually fires)");
}

// ---- the shapes that must yield nothing -------------------------------------

{
  const name = makeFilename('INBOX', 7, []);
  const none = (msg, out, why) =>
    assert.deepEqual(out, [], why + ': ' + JSON.stringify(msg));

  none({type: 'fs-event', origin: 'offscreen', operation: 'delete',
      src: `acc/INBOX/cur/${name}`},
    tombstonesFromFsEvent(
      {type: 'fs-event', origin: 'offscreen', operation: 'delete',
        src: `acc/INBOX/cur/${name}`}, {account: 'acc'}),
    'the engine\'s own writes never tombstone');
  none({operation: 'create', src: `acc/INBOX/new/${name}`},
    tombstonesFromFsEvent(ev('create', `acc/INBOX/new/${name}`), {account: 'acc'}),
    'a landing file is not a deletion');
  none({operation: 'change', src: `acc/INBOX/cur/${name}`},
    tombstonesFromFsEvent(ev('change', `acc/INBOX/cur/${name}`), {account: 'acc'}),
    'a content rewrite is not a deletion');
  none({operation: 'move', src: `acc/INBOX/cur/${name}`,
      dest: 'acc/Trash/cur/x'},
    tombstonesFromFsEvent(
      {type: 'fs-event', origin: 'client', operation: 'move',
        src: `acc/INBOX/cur/${name}`, dest: 'acc/Trash/cur/x'}, {account: 'acc'}),
    'a move stays the pending-move marker system\'s business');
  none({operation: 'delete', src: `acc/INBOX/tmp/${name}`},
    tombstonesFromFsEvent(ev('delete', `acc/INBOX/tmp/${name}`), {account: 'acc'}),
    'tmp/ scratch is never live mail');
  none({operation: 'delete', src: 'acc/INBOX'},
    tombstonesFromFsEvent(ev('delete', 'acc/INBOX'), {account: 'acc'}),
    'a directory removal is not a message deletion');
  none({operation: 'delete', src: 'acc/INBOX/cur/notes.txt'},
    tombstonesFromFsEvent(ev('delete', 'acc/INBOX/cur/notes.txt'), {account: 'acc'}),
    'a non-maildir filename is not a message');
  none({operation: 'delete', src: 'acc/INBOX/cur/.DS_Store'},
    tombstonesFromFsEvent(ev('delete', 'acc/INBOX/cur/.DS_Store'), {account: 'acc'}),
    'a dotfile is not a message');
  none({operation: 'delete', src: `other/INBOX/cur/${name}`},
    tombstonesFromFsEvent(ev('delete', `other/INBOX/cur/${name}`), {account: 'acc'}),
    'another account\'s dir is not this session\'s');
  none({operation: 'delete', src: `acc/INBOX/cur/${name}`},
    tombstonesFromFsEvent(ev('delete', `acc/INBOX/cur/${name}`), {}),
    'no account given — nothing to match');
  assert.deepEqual(
    tombstonesFromFsEvent(null, {account: 'acc'}), [],
    'a missing message is nothing');
  ok('non-events (origin, tmp/, dirs, dotfiles, other accounts) stay quiet');
}

// ---- the new/ landing side and the delimiter mapping ------------------------

{
  const name = makeFilename('INBOX', 12, []);
  const out = tombstonesFromFsEvent(
    ev('delete', `acc/INBOX/new/${name}`), {account: 'acc'});
  assert.deepEqual(out.map(e => [e.folder, e.uid]), [['INBOX', 12]],
    'a new/ removal counts exactly like cur/');
  ok('new/ removals feed too');
}

{
  const sub = makeFilename('Work.Sub', 3, []);
  const dot = tombstonesFromFsEvent(
    ev('delete', `acc/Work.Sub/cur/${sub}`), {account: 'acc', delimiter: '.'});
  assert.equal(dot[0].folder, 'Work.Sub',
    'a .-delimiter server keeps its literal spelling');
  const slash = tombstonesFromFsEvent(
    ev('delete', `acc/Work.Sub/cur/${sub}`), {account: 'acc', delimiter: '/'});
  assert.equal(slash[0].folder, 'Work/Sub',
    'the flat dir name maps back to the server folder WITH the delimiter');
  ok('the account delimiter rides the folder mapping');
}

// ---- a marker file (foreign FMD5) is still the folder it SITS in ------------

{
  // a pending-move marker: the file lives in Work but carries INBOX's FMD5 —
  // the tombstone must key by Work (where a purge would record it), so the
  // engine's by-old-uid veto can match it
  const marker = makeFilename('INBOX', 5, [], {fmd5: md5hex('INBOX')});
  const out = tombstonesFromFsEvent(
    ev('delete', `acc/Work/cur/${marker}`), {account: 'acc'});
  assert.deepEqual(out.map(e => [e.folder, e.uid]), [['Work', 5]],
    'the tombstone keys by the folder the file sat in');
  ok('marker files tombstone under their holding folder');
}

console.log('watcher.test: all assertions passed');
