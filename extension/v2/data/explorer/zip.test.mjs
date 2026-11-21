#!/usr/bin/env node
// Test for the explorer's zip writer (data/explorer/zip.mjs).
// Run: node data/explorer/zip.test.mjs
//
// Verifies the CRC-32 against the standard test vector, parses the built
// archive's structure back (EOCD → central directory → local headers),
// round-trips every entry's bytes (STORED plain, DEFLATED via zlib's
// inflateRaw), builds a Maildir archive through a fake fs gateway and
// asserts the Maildir shape (cur/new kept even when empty, tmp/ and its
// scratch left out, .uidvalidity in, .headers.json out). When an `unzip`
// binary is on the PATH, the archive is additionally checked with it.

'use strict';

import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import {spawnSync} from 'node:child_process';
import {existsSync, mkdtempSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ZipBuilder, crc32, zipMaildir} from './zip.mjs';

const nodeCrc32 = typeof zlib.crc32 === 'function' ? zlib.crc32 : null;
const enc = new TextEncoder();

// ---- crc-32 ----------------------------------------------------------------

assert.equal(crc32(enc.encode('123456789')), 0xCBF43926, 'the standard CRC-32 test vector');
assert.equal(crc32(new Uint8Array(0)), 0x00000000, 'CRC-32 of nothing is 0');
if (nodeCrc32) {
  const sample = enc.encode('The quick brown fox jumps over the lazy dog');
  assert.equal(crc32(sample), nodeCrc32(sample) >>> 0, 'CRC-32 agrees with zlib');
}
console.log('ok crc32');

// ---- a fake fs gateway facade (only reader.list/reader.read are used) ------

const file = (name, text, lastModified = 1700000000000) =>
  ({name, kind: 'file', bytes: enc.encode(text), lastModified});
const dir = (name, children = []) => ({name, kind: 'directory', children});

function fakeFs(root) {
  const notFound = path => Object.assign(new Error('not found: ' + path), {name: 'NotFoundError'});
  const find = path => {
    let list = root;
    let node = null;
    for (const seg of path.split('/').filter(Boolean)) {
      node = list.find(e => e.name === seg);
      if (!node) {
        throw notFound(path);
      }
      list = node.children ?? [];
    }
    return node;
  };
  return {
    reader: {
      async list(path) {
        const node = find(path);
        if (node.kind !== 'directory') {
          throw Object.assign(new Error('not a directory: ' + path), {name: 'TypeMismatchError'});
        }
        return node.children.map(({name, kind}) => ({name, kind}));
      },
      async read(path) {
        const node = find(path);
        if (node.kind !== 'file') {
          throw Object.assign(new Error('not a file: ' + path), {name: 'TypeMismatchError'});
        }
        return Object.assign(new Blob([node.bytes]), {lastModified: node.lastModified});
      }
    }
  };
}

// ---- structure: parse a built archive back ---------------------------------

function parseZip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocdAt = bytes.length - 22;
  assert.equal(view.getUint32(eocdAt, true), 0x06054b50, 'EOCD signature at the tail');
  const count = view.getUint16(eocdAt + 10, true);
  assert.equal(view.getUint16(eocdAt + 8, true), count, 'single-disk archive');
  assert.equal(view.getUint16(eocdAt + 20, true), 0, 'no zip comment');
  const centralSize = view.getUint32(eocdAt + 12, true);
  const centralOffset = view.getUint32(eocdAt + 16, true);
  assert.equal(centralOffset + centralSize, eocdAt, 'central directory ends at the EOCD');
  const out = [];
  let off = centralOffset;
  for (let i = 0; i < count; i++) {
    assert.equal(view.getUint32(off, true), 0x02014b50, 'central signature #' + i);
    const method = view.getUint16(off + 10, true);
    const crc = view.getUint32(off + 16, true);
    const compSize = view.getUint32(off + 20, true);
    const uncompSize = view.getUint32(off + 24, true);
    const nameLen = view.getUint16(off + 28, true);
    const localOffset = view.getUint32(off + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(off + 46, off + 46 + nameLen));
    assert.equal(view.getUint32(localOffset, true), 0x04034b50, 'local signature for ' + name);
    assert.equal(view.getUint16(localOffset + 8, true), method, 'method agrees for ' + name);
    assert.equal(view.getUint32(localOffset + 14, true), crc, 'crc agrees for ' + name);
    assert.equal(view.getUint32(localOffset + 18, true), compSize, 'compressed size agrees for ' + name);
    assert.equal(view.getUint32(localOffset + 22, true), uncompSize, 'uncompressed size agrees for ' + name);
    assert.equal(view.getUint16(localOffset + 6, true), 0x0800, 'utf-8 flag for ' + name);
    const lNameLen = view.getUint16(localOffset + 26, true);
    const lExtraLen = view.getUint16(localOffset + 28, true);
    assert.equal(new TextDecoder().decode(bytes.subarray(localOffset + 30, localOffset + 30 + lNameLen)), name,
      'local header name for ' + name);
    const dataAt = localOffset + 30 + lNameLen + lExtraLen;
    const payload = bytes.subarray(dataAt, dataAt + compSize);
    assert.ok(method === 0 || method === 8, 'known compression method for ' + name);
    const content = new Uint8Array(method === 8 ? zlib.inflateRawSync(payload) : payload);
    assert.equal(content.length, uncompSize, 'content size for ' + name);
    if (nodeCrc32) {
      assert.equal(nodeCrc32(content) >>> 0, crc, 'crc matches the content for ' + name);
    }
    out.push({name, method, crc, content, dir: name.endsWith('/')});
    off += 46 + nameLen;
  }
  assert.equal(off, eocdAt, 'central directory records exactly cover the section');
  return out;
}

// ---- ZipBuilder: dirs, stored, deflated, empty, utf-8 names ----------------

const plain = enc.encode('hello world');                       // too small to shrink
const repetitive = enc.encode('hello world '.repeat(60));      // shrinks well
const unicode = enc.encode('utf-8 names survive');

const builder = new ZipBuilder();
builder.addDirectory('docs');
await builder.addFile('docs/empty.txt', new Uint8Array(0));
await builder.addFile('docs/plain.txt', plain, {compress: false, lastModified: 1700000000000});
await builder.addFile('docs/deflated.txt', repetitive, {lastModified: 1700000000000});
builder.addDirectory('wörter');
await builder.addFile('wörter/日本語.txt', unicode, {lastModified: 1700000000000});
const built = new Uint8Array(await builder.finish().arrayBuffer());

const entries = parseZip(built);
const byName = new Map(entries.map(e => [e.name, e]));
assert.deepEqual([...byName.keys()].sort(),
  ['docs/', 'docs/deflated.txt', 'docs/empty.txt', 'docs/plain.txt', 'wörter/', 'wörter/日本語.txt']);
assert.ok(byName.get('docs/').dir, 'directory entry carries the trailing slash');
assert.equal(byName.get('docs/').content.length, 0, 'directory entries are empty');
assert.equal(byName.get('docs/plain.txt').method, 0, 'compress: false stays STORED');
assert.deepEqual(byName.get('docs/plain.txt').content, plain);
assert.equal(byName.get('docs/empty.txt').method, 0, 'an empty file is STORED');
assert.equal(byName.get('docs/deflated.txt').method, 8, 'shrinkable content is DEFLATED');
assert.deepEqual(byName.get('docs/deflated.txt').content, repetitive);
assert.deepEqual(byName.get('wörter/日本語.txt').content, unicode, 'utf-8 name round-trips');
console.log('ok zip builder structure (' + entries.length + ' entries)');

// ---- zipMaildir: the Maildir shape through a fake gateway ------------------

const FMD5 = 'a'.repeat(32);
const msgOne = `1720000000.M1P1Q1.sync,U=7,FMD5=${FMD5},I=2,S`;
const msgTwo = `1720000000.M2P2Q2.sync,U=8,FMD5=${FMD5}`;
const msgTmp = `1720000000.M3P3Q3.sync,U=9,FMD5=${FMD5}.tmp-1`;
const fs = fakeFs([
  dir('INBOX', [
    dir('cur', [file(msgOne, 'Message one'), file(msgTwo, 'Message two')]),
    dir('new', []),
    dir('tmp', [file(msgTmp, 'scratch bytes')]),
    file('.uidvalidity', '1234567890'),
    file('.headers.json', '{"cached":true}')
  ])
]);

let progress;
const maildirZip = new Uint8Array(await (await zipMaildir(fs, 'INBOX', 'INBOX', {
  onProgress: info => { progress = info; }
})).arrayBuffer());

const md = new Map(parseZip(maildirZip).map(e => [e.name, e]));
for (const expected of ['INBOX/', 'INBOX/cur/', 'INBOX/new/', 'INBOX/tmp/', 'INBOX/.uidvalidity',
  'INBOX/cur/' + msgOne, 'INBOX/cur/' + msgTwo]) {
  assert.ok(md.has(expected), 'archive holds ' + expected);
}
assert.ok(md.get('INBOX/new/').dir, 'an empty new/ still ships as a directory');
assert.ok(md.get('INBOX/tmp/').dir, 'tmp/ ships as a directory even when its files stay out');
assert.ok(![...md.keys()].some(n => n.startsWith('INBOX/tmp/') && n !== 'INBOX/tmp/'),
  'no scratch files ship from tmp/');
assert.ok(![...md.keys()].some(n => n.includes('scratch')),
  'the tmp/ scratch files stay out');
assert.equal(new TextDecoder().decode(md.get('INBOX/cur/' + msgOne).content), 'Message one');
assert.equal(new TextDecoder().decode(md.get('INBOX/cur/' + msgTwo).content), 'Message two');
assert.equal(new TextDecoder().decode(md.get('INBOX/.uidvalidity').content), '1234567890');
assert.ok(!md.has('INBOX/.headers.json'), 'the header cache stays out');
assert.deepEqual(progress, {files: 3, total: 3}, 'progress counts the packed files');
console.log('ok maildir archive (' + md.size + ' entries, tmp/ files excluded)');

// ---- unzip(1) round-trip when the binary is available ----------------------

const whichUnzip = spawnSync('unzip', ['-t', '/dev/null'], {encoding: 'utf8'});
if (!whichUnzip.error) {
  const base = existsSync('/tmp/opencode') ? '/tmp/opencode' : tmpdir();
  const work = mkdtempSync(join(base, 'zip-test-'));
  const zipPath = join(work, 'test.zip');
  writeFileSync(zipPath, maildirZip);
  const check = spawnSync('unzip', ['-t', zipPath], {encoding: 'utf8'});
  assert.equal(check.status, 0, 'unzip -t passes: ' + check.stdout + check.stderr);
  console.log('ok unzip -t round-trip');
}
else {
  console.log('skip unzip -t (no unzip binary)');
}

console.log('zip.test.mjs: all assertions passed');
