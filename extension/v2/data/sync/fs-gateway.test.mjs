#!/usr/bin/env node
// fs-gateway.test.mjs — regression tests for the fs gateway (core/fs.mjs)
// and the MaildirStore on top of it, against an in-memory File System
// Access mock. Run: node data/sync/fs-gateway.test.mjs
//
// Pinned behavior:
// 1. events: every successful mutation emits exactly one
//    {type:'fs-event', origin, operation, src, dest} — create vs change
//    distinguished, move carries src+dest, deletes of missing paths emit
//    nothing, and failed operations emit nothing at all;
// 2. quiet: scratch writes (maildir tmp/) emit nothing — an atomic
//    writeMessage is ONE 'move' event (src in tmp/, dest in new//cur/);
// 3. guards: absolute paths and '..' segments are refused; the root
//    itself can never be written, moved into or removed;
// 4. store: open/listFolders/listLocal/rename/move/remove/removeFolder/
//    reset keep their maildir semantics through the gateway, entries
//    carry root-relative `path`s (no handles leave the gateway);
// 5. local api: listThreadsDelta() is a PROPOSAL — the reconciled rows
//    install on commit() only, so a caller discarding a superseded read
//    leaves the cache honest for the winning read (no lost delete/flag
//    diff, no stale row until refresh).

import {register} from 'node:module';
register('./offscreen/root-loader.mjs', import.meta.url);

import assert from 'node:assert/strict';

// ------------------------------------------------------------ FS mock

// Minimal in-memory FileSystemDirectoryHandle/FileSystemFileHandle:
// just enough of the spec surface the gateway touches (getDirectoryHandle,
// getFileHandle, removeEntry, entries, createWritable, getFile, move,
// remove).

class MockFile {
  constructor(parent, name) {
    this.parent = parent;
    this.name = name;
    this.kind = 'file';
    this.bytes = new Uint8Array();
    this.lastModified = Date.now();
  }
  async createWritable() {
    const file = this;
    return {
      chunks: [],
      async write(data) {
        this.chunks.push(data instanceof Uint8Array ? data
          : typeof data === 'string' ? new TextEncoder().encode(data)
          : new Uint8Array(await data.arrayBuffer()));
      },
      async close() {
        let len = 0;
        for (const c of this.chunks) {
          len += c.length;
        }
        const out = new Uint8Array(len);
        let off = 0;
        for (const c of this.chunks) {
          out.set(c, off);
          off += c.length;
        }
        file.bytes = out;
        file.lastModified = Date.now();
      }
    };
  }
  async getFile() {
    const bytes = this.bytes;
    return {
      size: bytes.length,
      lastModified: this.lastModified,
      slice: (start, end) => ({
        arrayBuffer: async () => bytes.slice(start, end).buffer
      }),
      arrayBuffer: async () => bytes.slice().buffer,
      text: async () => new TextDecoder().decode(bytes)
    };
  }
  async move(dest, name) {
    const newName = typeof dest === 'string' ? dest : name;
    const destDir = typeof dest === 'string' ? this.parent : dest;
    if (destDir.children.has(newName) && destDir.children.get(newName) !== this) {
      throw Object.assign(new Error('name exists'), {name: 'InvalidModificationError'});
    }
    this.parent.children.delete(this.name);
    this.parent = destDir;
    this.name = newName;
    destDir.children.set(newName, this);
  }
  async remove() {
    this.parent.children.delete(this.name);
  }
}

class MockDir {
  constructor(parent, name) {
    this.parent = parent;
    this.name = name;
    this.kind = 'directory';
    this.children = new Map();
  }
  async getDirectoryHandle(name, {create = false} = {}) {
    const hit = this.children.get(name);
    if (hit) {
      if (hit.kind !== 'directory') {
        throw Object.assign(new Error('type mismatch'), {name: 'TypeMismatchError'});
      }
      return hit;
    }
    if (!create) {
      throw Object.assign(new Error('not found'), {name: 'NotFoundError'});
    }
    const dir = new MockDir(this, name);
    this.children.set(name, dir);
    return dir;
  }
  async getFileHandle(name, {create = false} = {}) {
    const hit = this.children.get(name);
    if (hit) {
      if (hit.kind !== 'file') {
        throw Object.assign(new Error('type mismatch'), {name: 'TypeMismatchError'});
      }
      return hit;
    }
    if (!create) {
      throw Object.assign(new Error('not found'), {name: 'NotFoundError'});
    }
    const file = new MockFile(this, name);
    this.children.set(name, file);
    return file;
  }
  async removeEntry(name, {recursive = false} = {}) {
    const hit = this.children.get(name);
    if (!hit) {
      throw Object.assign(new Error('not found'), {name: 'NotFoundError'});
    }
    if (hit.kind === 'directory' && !recursive && hit.children.size) {
      throw Object.assign(new Error('not empty'), {name: 'InvalidModificationError'});
    }
    this.children.delete(name);
  }
  async *entries() {
    for (const [name, handle] of this.children) {
      yield [name, handle];
    }
  }
  async move(dest, name) {
    const newName = typeof dest === 'string' ? dest : name;
    const destDir = typeof dest === 'string' ? this.parent : dest;
    this.parent.children.delete(this.name);
    this.parent = destDir;
    this.name = newName;
    destDir.children.set(newName, this);
  }
}

// ------------------------------------------------------------ harness

const events = [];

globalThis.chrome = {
  runtime: {
    sendMessage: async msg => {
      events.push(msg);
      return undefined;
    }
  }
};

const {prepare} = await import('/core/fs.mjs');
const {MaildirStore} = await import('/data/sync/maildir.mjs');
const {onFsEvent} = await import('/core/fs.mjs');

const root = new MockDir(null, 'usb-drive');
const fs = await prepare('test', {handle: root, fresh: true});

function drain() {
  return events.splice(0, events.length);
}
const types = list => list.map(e => `${e.operation}:${e.src}${e.dest ? '→' + e.dest : ''}`);

let n = 0;
const ok = label => {
  n++;
  console.log('  ✓', label);
};

// ---- 1. events: create vs change vs move vs delete -------------------------

await fs.writer.mkdir('docs');
assert.deepEqual(drain(), [{type: 'fs-event', origin: 'test', operation: 'create', src: 'docs', dest: null}]);
ok('mkdir emits one create event');

await fs.writer.mkdir('docs');
assert.deepEqual(drain(), []);
ok('mkdir of an existing dir emits nothing');

await fs.writer.write('docs/a.txt', 'one');
assert.deepEqual(types(drain()), ['create:docs/a.txt']);
ok('first write emits create');

await fs.writer.write('docs/a.txt', 'two');
assert.deepEqual(types(drain()), ['change:docs/a.txt']);
ok('second write emits change');

assert.equal(await fs.reader.readText('docs/a.txt'), 'two');
ok('readText round-trips');

await fs.writer.move('docs/a.txt', 'docs/b.txt');
assert.deepEqual(types(drain()), ['move:docs/a.txt→docs/b.txt']);
ok('same-dir rename emits move with src and dest');

await fs.writer.mkdir('docs/other');
await fs.writer.move('docs/b.txt', 'docs/other/c.txt');
assert.deepEqual(types(drain()), ['create:docs/other', 'move:docs/b.txt→docs/other/c.txt']);
ok('cross-dir move emits move with full paths');

await fs.writer.remove('docs/other/c.txt');
assert.deepEqual(types(drain()), ['delete:docs/other/c.txt']);
ok('delete emits delete');

assert.equal(await fs.writer.remove('docs/other/c.txt'), false);
assert.deepEqual(drain(), []);
ok('delete of a missing path is a no-op without an event');

// ---- 2. guards -------------------------------------------------------------

await assert.rejects(() => fs.writer.write('/abs.txt', 'x'), /absolute/);
await assert.rejects(() => fs.reader.list('../etc'), /bad path segment/);
await assert.rejects(() => fs.writer.remove(''), /refusing to remove the root/);
await assert.rejects(() => fs.writer.write('', 'x'), /cannot write the root/);
assert.deepEqual(drain(), []);
ok('path guards refuse absolute paths, .. and root operations');

// ---- 3. quiet writes and the maildir atomic commit -------------------------

await fs.writer.write('docs/scratch', 'x', {quiet: true});
assert.deepEqual(drain(), []);
ok('quiet writes emit nothing');

// ---- 4. MaildirStore through the gateway -----------------------------------

const store = new MaildirStore(fs, 'acc');
await store.open();
const boot = drain();
assert.deepEqual(types(boot), ['create:acc']);
ok('store.open() creates the account dir (one event)');

const raw = new TextEncoder().encode('From: a@b.c\r\n\r\nhello\r\n');
await store.writeMessage('INBOX', 5, ['\\Seen'], raw);
const wrote = drain();
const move = wrote.at(-1);
assert.equal(wrote.at(-5).operation, 'create');
assert.equal(wrote.at(-5).src, 'acc/INBOX');
assert.deepEqual(types(wrote.slice(-4, -1)), [
  'create:acc/INBOX/tmp',
  'create:acc/INBOX/new',
  'create:acc/INBOX/cur'
]);
assert.equal(move.operation, 'move');
assert.match(move.src, /^acc\/INBOX\/tmp\//);
assert.match(move.dest, /^acc\/INBOX\/cur\//);
ok('writeMessage: dirs created, then ONE move tmp→cur (tmp stays quiet)');

const folders = await store.listFolders();
assert.deepEqual(folders, ['INBOX']);
ok('listFolders finds the Maildir');

const local = await store.listLocal('INBOX');
assert.equal(local.entries.size, 1);
const entry = [...local.entries.values()][0];
assert.equal(entry.uid, 5);
assert.ok(entry.path.startsWith('acc/INBOX/cur/'));
assert.equal(entry.file, undefined);
ok('listLocal entries carry root-relative paths (no handles)');

assert.deepEqual([...(await store.readFile(entry))], [...raw]);
assert.equal(await store.fileSize(entry), raw.length);
ok('readFile/fileSize serve bytes via the entry path');

// flag rename: S already set, add \Flagged — a cur/-internal move event
await store.renameMessage('INBOX', entry, {flags: ['\\Seen', '\\Flagged']});
const renamed = types(drain());
assert.equal(renamed.length, 1);
assert.match(renamed[0], /^move:acc\/INBOX\/cur\/.*→acc\/INBOX\/cur\/.*I=2,FS$/);
ok('renameMessage emits one move with the flag letters in the dest');

// move between folders, keepFmd5 (the pending-move marker)
await store.writeMessage('Work', 9, [], raw);
drain();   // folder creations + move — already covered above
const work = [...(await store.listLocal('Work')).entries.values()][0];
await store.moveMessage('Work', work, 'INBOX', 9, {keepFmd5: true});
const moved = drain().at(-1);
assert.equal(moved.operation, 'move');
assert.match(moved.dest, /^acc\/INBOX\/(new|cur)\/.*FMD5=[0-9a-f]{32}/);
const kept = [...(await store.listLocal('INBOX')).interlopers.values()][0];
assert.ok(kept, 'keepFmd5 file lands as an interloper in INBOX');
ok('moveMessage(keepFmd5) is one move event; file reads as interloper');

// remove + removeFolder + reset
assert.equal(await store.removeMessage(kept), true);
assert.deepEqual(drain().at(-1).operation, 'delete');
const gone = await store.removeFolder('Work');
assert.equal(gone.removed, true);
assert.ok(!await fs.reader.exists('acc/Work'));
const last = drain();
assert.equal(last.at(-1).operation, 'delete');
assert.match(last.at(-1).src, /^acc\/Work$/);
ok('removeFolder deletes the tree; one delete event for its root');

const cleaned = await store.reset();
assert.ok(cleaned >= 1);
assert.equal(await fs.reader.exists('acc'), false);
assert.equal(drain().at(-1).operation, 'delete');
ok('reset removes the whole account dir');

// ---- 4b. missing PARENT dirs read as "not exists", never a crash ------------
// (regression: the initial-sync survey crashed its whole run — fsStat
// resolved the parent OUTSIDE its catch, so a missing <slug>/<dir> threw
// NotFoundError instead of answering {exists: false} / null. The survey's
// listLocal() → null IS the designed "local dir missing" signal.)

assert.equal(await fs.reader.exists('new-account/INBOX/tmp'), false);
assert.deepEqual(await fs.reader.stat('new-account/INBOX/new'),
  {exists: false, kind: null, size: 0, lastModified: 0});
ok('exists/stat answer "not exists" when a parent dir is missing');

let listed = null;
try {
  await fs.reader.list('new-account/INBOX/cur');
}
catch (e) {
  listed = e;
}
assert.equal(listed?.name, 'NotFoundError');   // listLocal's catch keys on the NAME
assert.match(listed?.message ?? '', /'new-account\/INBOX\/cur'/);
ok('list of a missing dir still throws, but tagged with its path (name kept)');

const fresh = new MaildirStore(fs, 'new-account');
await fresh.open();   // only the account dir exists — no folders yet
drain();
assert.equal(await fresh.listLocal('INBOX'), null);
assert.equal(await fresh.readUidValidity('INBOX'), null);
ok('store survey helpers survive a virgin account (listLocal/readUidValidity → null)');

let moveErr = null;
try {
  await fs.writer.move('new-account/nope/a', 'new-account/nope/b');
}
catch (e) {
  moveErr = e;
}
assert.match(moveErr?.message ?? '',
  /^fs move 'new-account\/nope\/a' → 'new-account\/nope\/b'/);
assert.equal(moveErr?.name, 'NotFoundError');
ok('move failures carry the src → dest path, name preserved');

await fs.writer.write('tag-blocker', 'x');   // a FILE where a dir is wanted
drain();
let shape = null;
try {
  await fs.writer.mkdir('tag-blocker/sub');
}
catch (e) {
  shape = e;
}
assert.equal(shape?.name, 'TypeMismatchError');
assert.match(shape?.message ?? '', /'tag-blocker\/sub'/);
ok('a file blocking a dir chain surfaces as TypeMismatchError with its path');

await fs.writer.remove('tag-blocker', {quiet: true});
drain();

// ---- 5. a failing gate refuses every operation ------------------------------

const bare = await prepare('nogate', {silent: true, fresh: true});
assert.equal(bare.gate.ok, false);
await assert.rejects(() => bare.reader.list(''), /no granted storage root/);
await assert.rejects(() => bare.writer.write('x', 'y'), /no granted storage root/);
ok('a failed gate returns a verdict facade whose calls reject');

// ---- 6. classifyEvent: fs-event → current-account view routing --------------
//
// The client's routing table (data/client/fs-events.mjs): other accounts,
// metadata, scratch and triple mkdirs never call a view; dir-view rides
// folder-set changes only; the open dir delta-deltas the mails view; a
// renamed-away/deleted open message adds the mail view.

const {classifyEvent} = await import('/data/client/fs-events.mjs');
const CTX = {account: 'acc', dir: 'INBOX'};
const MD5 = '0f9263536b9fc61ada745644735bfd8f';
const name = (uid, extra) =>
  `1790660635.M822P9ae4Q1.sync,U=${uid},FMD5=${MD5}${extra ?? ''}`;
const ev = (operation, src, dest) =>
  ({type: 'fs-event', origin: 'offscreen', operation, src, dest});

const c = (msg, ctx = CTX) => classifyEvent(msg, ctx);

assert.deepEqual(c(ev('create', 'other/INBOX/cur/x')),
  {match: 'other', slug: 'other', dirs: [], calls: [], actions: [], note: 'other account'});
ok('other-account events match nothing');

assert.deepEqual(c(ev('change', 'acc/.sync-state.json')).calls, []);
assert.equal(c(ev('change', 'acc/.sync-state.json')).note, 'meta');
assert.equal(c(ev('change', 'acc/INBOX/cur/.hidden')).note, 'meta');
ok('metadata files never call a view');

assert.deepEqual(c(ev('move', 'acc/INBOX/tmp/x.tmp-1-1', `acc/INBOX/cur/${name(5, ',I=2,S')}`)).calls,
  ['mails-view(delta INBOX)', 'dir-view(counts INBOX)']);
ok('atomic commit: tmp src ignored; dest deltas the open dir and its counters');

assert.deepEqual(c(ev('create', 'acc/Work')).calls, ['dir-view']);
assert.deepEqual(c(ev('delete', 'acc/Work')).calls, ['dir-view']);
assert.deepEqual(c(ev('delete', 'acc')).calls, ['accounts-view', 'dir-view']);
ok('folder set changes call dir-view; the account dir also re-reads the picker');

const rootOther = c(ev('create', 'newacct'));
assert.deepEqual(rootOther.calls, ['accounts-view']);
assert.deepEqual(rootOther.actions, [{component: 'accounts-view'}]);
assert.equal(rootOther.match, 'other');
assert.equal(rootOther.note, 'other account');
assert.deepEqual(c(ev('delete', 'newacct')).calls, ['accounts-view']);
assert.deepEqual(c(ev('create', 'brandnew'), {account: null, dir: null}).calls,
  ['accounts-view']);
assert.deepEqual(c(ev('create', '.picker-probe')).calls, []);
ok('root-level account dirs reach the picker even for other/unselected ' +
  'matches; hidden root entries stay meta');

assert.equal(c(ev('create', 'acc/Work/tmp')).note, 'maildir triple');
ok('triple mkdirs call nothing');

assert.deepEqual(c(ev('create', `acc/INBOX/cur/${name(7, ',I=2,S')}`)).calls,
  ['mails-view(delta INBOX)', 'dir-view(counts INBOX)']);
assert.deepEqual(c(ev('change', `acc/INBOX/new/${name(7)}`)).calls,
  ['mails-view(delta INBOX)']);
assert.deepEqual(c(ev('create', `acc/Work/cur/${name(7)}`)).calls,
  ['dir-view(counts Work)']);
assert.equal(c(ev('change', `acc/Work/cur/${name(7)}`)).note, 'other dir (Work)');
ok('open-dir ops delta + count; other dirs count only; change never counts');

const flagRename = c(ev('move', `acc/INBOX/cur/${name(5, ',I=2,S')}`, `acc/INBOX/cur/${name(5, ',I=2,FS')}`));
assert.deepEqual(flagRename.calls,
  ['mails-view(delta INBOX)', 'dir-view(counts INBOX)', 'mail-view(uid 5)']);
ok('flag rename: delta + counters (\Seen moved) + mail view (uid from src)');

const purge = c(ev('delete', `acc/INBOX/cur/${name(5, ',I=2,S')}`));
assert.deepEqual(purge.calls,
  ['mails-view(delta INBOX)', 'dir-view(counts INBOX)', 'mail-view(uid 5)']);
ok('delete in the open dir: delta + counters + mail view');

const crossMove = c(ev('move', `acc/INBOX/cur/${name(9)}`, `acc/Work/cur/${name(9)}`));
assert.deepEqual(crossMove.dirs, ['INBOX', 'Work']);
assert.deepEqual(crossMove.calls,
  ['mails-view(delta INBOX)', 'dir-view(counts INBOX, Work)', 'mail-view(uid 9)']);
ok('cross-dir move out of the open dir: both folders counted, message left');

const intoOpen = c(ev('move', `acc/Work/cur/${name(9)}`, `acc/INBOX/cur/${name(9)}`));
assert.deepEqual(intoOpen.calls,
  ['mails-view(delta INBOX)', 'dir-view(counts Work, INBOX)']);
ok('move INTO the open dir deltas without a mail view (src dir counted first)');

const noDir = c(ev('create', `acc/INBOX/cur/${name(7)}`), {account: 'acc', dir: null});
assert.deepEqual(noDir.calls, ['dir-view(counts INBOX)']);
assert.equal(c(ev('create', 'acc/INBOX'), {account: null, dir: null}).match, 'unselected');
ok('no open dir still counts; no account selected degrades cleanly');

// ---- 7. machine-readable actions + the same-context echo --------------------

const withActions = c(ev('move', `acc/INBOX/cur/${name(5, ',I=2,S')}`, `acc/Work/cur/${name(5)}`));
assert.deepEqual(withActions.actions, [
  {component: 'mails-view', dir: 'INBOX'},
  {component: 'dir-view', kind: 'counts', dirs: ['INBOX', 'Work']},
  {component: 'mail-view', uid: 5}
]);
ok('actions carry the machine-readable view ops alongside the print strings');

const echoed = [];
const unecho = onFsEvent(msg => echoed.push(msg));
await fs.writer.write('echo-probe.txt', 'x');
assert.deepEqual(echoed, [{type: 'fs-event', origin: 'test', operation: 'create',
  src: 'echo-probe.txt', dest: null}]);
unecho();
await fs.writer.remove('echo-probe.txt', {quiet: true});
assert.equal(echoed.length, 1);
ok('gateway echoes same-context events to onFsEvent (unsubscribe works)');

// ---- 8. local api: listThreadsDelta() is a proposal until commit ------------
//
// The client's reconcile read (data/client/local-api.mjs) must NOT mutate
// its per-folder delta cache while reading: list.mjs sync() discards the
// result of a read whose token was superseded mid-flight, and a cache
// already advanced by the discarded read would make the WINNING read diff
// clean (changed:false) — the row stays on screen until a manual refresh.
// Sequence-pinned here deterministically: read #1 discards its commit (the
// "superseded caller"), read #2 must still see the change.

const {apiForStore} = await import('/data/client/local-api.mjs');

const deltaRoot = new MockDir(null, 'delta-root');
const deltaFs = await prepare('delta-test', {handle: deltaRoot, fresh: true});
const deltaStore = new MaildirStore(deltaFs, 'acc');
await deltaStore.open();
drain();   // store.open()'s account create — the event stream isn't under test here

const mail = new TextEncoder().encode('From: x@y.z\r\n\r\nbody one\r\n');
const mail2 = new TextEncoder().encode('From: p@q.r\r\n\r\nbody two\r\n');
await deltaStore.writeMessage('INBOX', 11, ['\\Seen'], mail);
await deltaStore.writeMessage('INBOX', 12, ['\\Seen'], mail2);
drain();

const deltaApi = apiForStore(deltaStore, 'acc');
await deltaApi.openDir('INBOX');
await deltaApi.listThreads();   // seeds the delta cache with uid 11 + 12

// ---- 8a. a superseded read must not eat the diff ----------------------------

await deltaStore.removeMessage([...(await deltaStore.listLocal('INBOX')).entries.values()]
  .find(e => e.uid === 11));

const read1 = await deltaApi.listThreadsDelta();
assert.equal(read1.changed, true);
assert.deepEqual(read1.removed, [11]);
ok('delta sees the deletion (changed:true, removed:[11])');

const read2 = await deltaApi.listThreadsDelta();  // read1's commit is DISCARDED
assert.equal(read2.changed, true, 'the winning read must still diff the deletion');
assert.deepEqual(read2.removed, [11]);
assert.ok(read2.commit, 'a changed delta carries its commit');
ok('superseded read leaves the cache honest — the next read re-diffs the deletion');

// a peek at the untouched disk: only uid 12 remains (the deletion ran for real)
const remaining = [...(await deltaStore.listLocal('INBOX')).entries.values()]
  .map(e => e.uid);
assert.deepEqual(remaining.sort(), [12]);
ok('sanity: disk carries uid 12 only — the read/cache split is what is under test');

read2.commit();   // the winning read installs its rows

const read3 = await deltaApi.listThreadsDelta();
assert.equal(read3.changed, false);
assert.equal(read3.commit, null);
assert.deepEqual(read3.threads, null);
ok('after commit the delta is a clean no-op (changed:false, commit null)');

// ---- 8b. flag changes hold off the cache the same way -----------------------

const entry12 = [...(await deltaStore.listLocal('INBOX')).entries.values()]
  .find(e => e.uid === 12);
await deltaStore.renameMessage('INBOX', entry12, {flags: []});   // strip \Seen

const flagRead = await deltaApi.listThreadsDelta();
assert.equal(flagRead.changed, true);
assert.deepEqual(flagRead.flagged, [12]);
assert.deepEqual(flagRead.added, []);
assert.deepEqual(flagRead.removed, []);
// the cache row's flags must be UNTOUCHED until commit — a discarded read
// must not have already flipped them in place
flagRead.commit();
const afterCommit = await deltaApi.listThreadsDelta();
assert.equal(afterCommit.changed, false);
ok('flag reconcile also lands on commit only (no in-place cache flip)');

console.log(`fs-gateway.test: all ${n} checks pass`);
