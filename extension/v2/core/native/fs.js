// fs.js — sandbox script for the com.add0n.node native client.
//
// The extension (core/native/native-client.mjs) fetches this file and ships
// its text to the sandbox the same way the ws->tcp bridge ships
// ws-to-tls.js: the boot frame {uuid, permissions, args, script} starts the
// script, whose push/connect globals let the extension exchange messages
// with it. Requests arrive wrapped as {cmd:'post-message', uuid, data} —
// the host unwraps them and only forwards frames whose uuid matches the
// boot session; replies go back through push() unwrapped.
//
// Boot: push({cmd:'ready'}) fires as soon as the sandbox is live; the
// extension resolves its boot on that frame, then starts sending requests.
//
// Requests (data after unwrapping, replies always echo the id):
//   {id, op:'ping'}                            -> {id, ok:true, version}
//   {id, op:'write', dir, name, data(base64)}  -> {id, ok:true, path} —
//       writes into the absolute dir under a collision-free name derived
//       from name; existing files are never overwritten.
//   {id, op:'write-batch', files:[{dir,name,data}]}   -> {id, ok:true,
//       results:[{ok:true,path} | {ok:false,error}]} — the batch succeeds
//       as a whole even when single entries fail; per-entry results are
//       reported individually so one bad entry cannot kill the batch.

'use strict';

const fs = require('fs');

// The com.add0n.node sandbox only resolves require ids that appear verbatim
// in the boot permissions list (host.js) and has no global Buffer — match the
// ws-to-tls.js pattern: require('node:buffer'). The node:path form is tried
// first with the bare name as a fallback for older bundled Node versions.
function req(id) {
  try {
    return require(id);
  }
  catch {
    return null;
  }
}
const path = req('node:path') || req('path');
const {Buffer} = req('node:buffer') || {};

const VERSION = '1';
// bare filenames only: no path separators, no dot-dot, no control chars
const NAME_FORBIDDEN = /[/\\]|\.\.|[\x00-\x1f]/;

// `${stem-2}${suffix}` — the extension/base split handles multi-dot names
// ("2026-09-17_012800,uid=42.eml" keeps its ".eml" suffix through retries).
function freeName(dir, name) {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  let candidate = name;
  for (let i = 2; fs.existsSync(path.join(dir, candidate)); i++) {
    candidate = stem + '-' + i + ext;
  }
  return candidate;
}

function writeOne(dir, name, base64) {
  if (typeof dir !== 'string' || !(dir.startsWith('/') || /^[A-Za-z]:[\\/]/.test(dir))) {
    return {ok: false, error: 'dir must be an absolute path'};
  }
  if (typeof name !== 'string' || !name || NAME_FORBIDDEN.test(name) || !path.extname(name)) {
    return {ok: false, error: 'name must be a bare file name with an extension'};
  }
  if (typeof base64 !== 'string') {
    return {ok: false, error: 'data must be a base64 string'};
  }
  const bytes = Buffer.from(base64, 'base64');
  if (!bytes.length) {
    return {ok: false, error: 'data is empty'};
  }
  dir = path.resolve(dir);
  fs.mkdirSync(dir, {recursive: true});
  const file = path.join(dir, freeName(dir, name));
  fs.writeFileSync(file, bytes);
  return {ok: true, path: file};
}

function handle(msg) {
  if (!msg || typeof msg !== 'object' || typeof msg.id !== 'string') {
    return;
  }
  const reply = (value) => push(value);
  try {
    if (msg.op === 'ping') {
      reply({id: msg.id, ok: true, version: VERSION});
    }
    else if (msg.op === 'write') {
      reply({id: msg.id, ...writeOne(msg.dir, msg.name, msg.data)});
    }
    else if (msg.op === 'write-batch') {
      const files = Array.isArray(msg.files) ? msg.files : [];
      reply({id: msg.id, ok: true, results: files.map(f => writeOne(f.dir, f.name, f.data))});
    }
    else {
      reply({id: msg.id, ok: false, error: 'unsupported op'});
    }
  }
  catch (e) {
    reply({id: msg.id, ok: false, error: e?.message || String(e)});
  }
}

// ---------- embedded in the com.add0n.node sandbox ----------
// Missing permissions come back as null modules, which would only surface
// later as a cryptic "reading 'extname'" crash on the first save — report
// the obvious cause instead.
if (typeof push === 'function' && typeof connect === 'function') {
  const missing = [
    ['fs', fs],
    ['path', path],
    ['Buffer', typeof Buffer === 'undefined' ? null : Buffer]
  ].filter(([, mod]) => !mod).map(([name]) => name);
  if (missing.length) {
    push({cmd: 'disconnected', message: 'sandbox lacks module permissions: ' + missing.join(', ')});
  }
  else {
    connect(handle);
    push({cmd: 'ready'});
  }
}
