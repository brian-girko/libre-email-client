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
//    carry root-relative `path`s (no handles leave the gateway).

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
  {match: 'other', slug: 'other', dirs: [], calls: [], note: 'other account'});
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
assert.deepEqual(c(ev('delete', 'acc')).calls, ['dir-view']);
ok('folder set changes (and the account dir) call dir-view');

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

console.log(`fs-gateway.test: all ${n} checks pass`);
