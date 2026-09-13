// fs.js — file-writer sandbox script for the com.add0n.node host.
//
// Shipped by the extension the same way the ws->tcp bridge ships
// ws-to-tls.js: the wrapper (core/native/native-client.mjs) fetches this
// file's text and posts it to the sandbox, which provides the push/connect/
// args globals. The host delivers extension messages to the connect()
// listener; push() sends replies back through the port.
//
// Requests (each carries an id; every reply echoes it):
//   {id, op:'ping'}                          -> {id, ok:true, version:1}
//   {id, op:'write', dir, name, data(b64)}   -> {id, ok:true, path}
//
// 'write' mkdir -p's the destination directory and never overwrites: when
// the requested name exists a -1/-2/... suffix is inserted before the
// extension, and the final wx write makes the pick race-free.

'use strict';

if (typeof push === 'function' && typeof connect === 'function' && typeof args !== 'undefined') {
  const fs = require('fs');
  const {Buffer} = require('node:buffer');

  const send = (msg) => {
    try {
      push(msg);
    }
    catch {
      // the host port is gone; nothing left to report to
    }
  };

  const joinPath = (dir, name) => {
    const d = String(dir);
    return (d.endsWith('/') || d.endsWith('\\') ? d : d + '/') + String(name);
  };

  // Collision-free absolute path inside dir; names never traverse out of it.
  const pickPath = (dir, name) => {
    const safe = String(name).replace(/[/\\]/g, '_').trim();
    const dot = safe.lastIndexOf('.');
    const base = dot > 0 ? safe.slice(0, dot) : safe;
    const ext = dot > 0 ? safe.slice(dot) : '';
    for (let i = 0; i < 10000; i++) {
      const candidate = joinPath(dir, i ? base + '-' + i + ext : safe);
      try {
        fs.accessSync(candidate, fs.constants.F_OK);
      }
      catch {
        return candidate; // does not exist -> ours
      }
    }
    throw new Error('no free file name found in ' + dir);
  };

  const handlers = {
    ping() {
      return {version: 1};
    },
    write({dir, name, data}) {
      if (typeof dir !== 'string' || !dir.trim()) {
        throw new Error('dir is required');
      }
      if (typeof name !== 'string' || !name.trim()) {
        throw new Error('name is required');
      }
      if (typeof data !== 'string') {
        throw new Error('base64 data is required');
      }
      fs.mkdirSync(dir, {recursive: true});
      const path = pickPath(dir, name);
      fs.writeFileSync(path, Buffer.from(data, 'base64'), {flag: 'wx'});
      return {path};
    }
  };

  connect(msg => {
    if (!msg || typeof msg !== 'object' || typeof msg.id !== 'string') {
      return;
    }
    const handler = handlers[msg.op];
    if (!handler) {
      send({id: msg.id, ok: false, error: 'unknown op: ' + msg.op});
      return;
    }
    try {
      send({id: msg.id, ok: true, ...handler(msg)});
    }
    catch (e) {
      send({id: msg.id, ok: false, error: e && e.message ? e.message : String(e)});
    }
  });

  send({cmd: 'ready'});
}
