#!/usr/bin/env node
// compose-write.test.mjs — the full local compose write path: the api's
// composeMessage() building RFC822 bytes (compose.mjs) and landing them
// as a fresh unread mail file in the target folder's new/, exactly as the
// sync engine's local-born classification expects to find them.
// Run: node data/client/compose-write.test.mjs

import {register} from 'node:module';
register('../sync/offscreen/root-loader.mjs', import.meta.url);

import assert from 'node:assert/strict';

// ------------------------------------------------------------ FS mock

// Minimal in-memory FileSystemDirectoryHandle/FileSystemFileHandle: just
// enough of the spec surface the gateway touches (same shape as the
// fs-gateway test's mock).

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
}

// ------------------------------------------------------------ harness

// reportEdit() fires chrome.runtime messages — the dirty report the worker
// keys scheduled syncs on
const messages = [];
globalThis.chrome = {
  runtime: {
    sendMessage: async msg => {
      messages.push(msg);
      return undefined;
    }
  }
};

const {prepare} = await import('/core/fs.mjs');
const {MaildirStore} = await import('/data/sync/maildir.mjs');
const {apiForStore} = await import('/data/client/local-api.mjs');
const {validateMail} = await import('/data/sync/snapshot.mjs');

const root = new MockDir(null, 'usb-drive');
const fs = await prepare('test', {handle: root, fresh: true});

const store = new MaildirStore(fs, 'acc');
await store.open();
// the tree only offers folders whose Maildir exists on disk — compose
// targets are the same
await store.folder('INBOX', {create: true});
const api = apiForStore(store, 'acc');

const before = Date.now();
const uid = await api.composeMessage('INBOX', {
  from: 'alice@example.com',
  fromName: 'Alice Example',
  to: 'bob@example.com, carol@example.com',
  cc: '',
  bcc: 'secret@example.com',
  subject: 'Quarterly report',
  html: '',
  plain: 'the numbers are in'
});
const after = Date.now();

// ---- the placeholder uid: synthetic, monotonic, collision-free -------------

assert.equal(typeof uid, 'number', 'composeMessage resolves to the interim uid');
assert.ok(uid >= before && uid <= after + 1,
  'the synthetic uid seeds at Date.now()');

const uid2 = await api.composeMessage('INBOX', {
  from: 'alice@example.com', to: 'bob@example.com',
  subject: 'second', html: '', plain: 'x'
});
assert.ok(uid2 > uid, 'repeated composes mint strictly increasing uids');

// ---- the dirty report -------------------------------------------------------

assert.ok(messages.some(m => m.type === 'sync-dirty-report' &&
  m.accountId === 'acc' && m.srcDir === 'INBOX'),
  'the write reports the folder dirty (next sync uploads it)');

// ---- the file: fresh unread mail in new/ ------------------------------------

const local = await store.listLocal('INBOX');
assert.equal(local.entries.size, 2, 'both composed messages list as entries');
const entry = local.entries.get(uid);
assert.ok(entry, 'the first message lists under its interim uid');
assert.equal(entry.dir, 'new', 'no flags → the file lands in new/');
assert.deepEqual(entry.flags, [], 'the message is fresh unread mail');
assert.match(entry.fileName, new RegExp(',U=' + uid + ',FMD5=[0-9a-f]{32}$'),
  'filename carries the placeholder uid and the folder FMD5');

// ---- the bytes: valid RFC822 the engine's classifier accepts ----------------

const raw = await store.readFile(entry);
const text = new TextDecoder().decode(raw);
assert.ok(text.startsWith('From: Alice Example <alice@example.com>'),
  'From carries the identity');
assert.ok(text.includes('To: bob@example.com, carol@example.com'),
  'To lists the recipients');
assert.ok(!text.includes('secret@example.com'),
  'bcc never reaches the file');
assert.ok(text.includes('Subject: Quarterly report'), 'Subject present');
assert.match(text, /^Date: .*, .* \+0000\r$/m, 'a Date header rides');
assert.match(text, /^Message-ID: <compose\./m, 'a generated Message-ID rides');
assert.ok(text.includes('Content-Type: multipart/alternative'),
  'the body is multipart/alternative');
assert.ok(text.includes('\r\n\r\nthe numbers are in\r\n'),
  'the plain part carries the text');

// the sync engine's own gate: validateMail must accept the file, or the
// classifier would log "not an email" and never APPEND it
const v = await validateMail(raw);
assert.ok(v.ok, 'validateMail accepts the composed file: ' + (v.reason ?? ''));

// ---- visibility: the list serves the composed message -----------------------

await api.openDir('INBOX');
const threads = await api.listThreads();
const subjects = threads.map(t => t.subject);
assert.ok(subjects.includes('Quarterly report'),
  'listThreads serves the composed message as its own thread');
assert.ok(subjects.includes('second'),
  'and the second one');

// ---- a vanished folder never resurrects silently ---------------------------

await assert.rejects(
  () => api.composeMessage('NOPE', {from: 'a@x.com', to: 'b@x.com', html: '', plain: 'x'}),
  e => e.code === 'mirror' && /no such mailbox/.test(e.message),
  'composing into a folder without a Maildir fails with the mirror code');

console.log('compose write-path tests passed');
