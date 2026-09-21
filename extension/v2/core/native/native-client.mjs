'use strict';

// Native client (com.add0n.node) access shared by the options page and the
// mail client. The sandbox script core/native/fs.js is shipped to the host
// the same way the ws->tcp bridge ships ws-to-tls.js: one boot postMessage
// with {uuid, permissions, args, script} starts the sandbox, and every
// conversation with the sandbox script afterwards is wrapped as
// {cmd:'post-message', uuid, data} — the host routes the wrapped data to the
// script's connect() listener only when the uuid matches the boot session.
// Messages the script pushes itself (push(x)) arrive unwrapped.
//
// The sandbox supports (data after unwrapping, replies echo the id):
//   {id, op:'ping'}                           -> {id, ok:true, version}
//   {id, op:'write', dir, name, data(base64)} -> {id, ok:true, path}
//
// detectNativeClient() probes with a throwaway port — boot plus a full ping
// round trip, closed right after — so the options page only reports "native
// client available" when the whole protocol works, not merely the boot.
// writeFile() reuses one persistent port so repeated saves do not pay the
// startup cost.

const NATIVE_HOST = 'com.add0n.node';
const BOOT_TIMEOUT = 15000;
const REQUEST_TIMEOUT = 60000;

let scriptPromise = null;
let bootPromise = null;

// The live boot session: {port, uuid} or null. uuid must accompany every
// wrapped request or the host silently drops it.
let session = null;
let seq = 0;
const pending = new Map();

function loadScript() {
  if (!scriptPromise) {
    scriptPromise = fetch(chrome.runtime.getURL('core/native/fs.js')).then(res => {
      if (!res.ok) {
        throw new Error('failed to load core/native/fs.js: ' + res.status);
      }
      return res.text();
    });
    // allow a retry after a transient fetch failure
    scriptPromise.catch(() => {
      scriptPromise = null;
    });
  }
  return scriptPromise;
}

function toBase64(bytes) {
  let bin = '';
  const chunk = 0x8000; // keep String.fromCharCode below the arg limit
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

function dropPort(message) {
  if (session) {
    try {
      session.port.disconnect();
    }
    catch {
      // already gone
    }
    session = null;
  }
  const error = new Error(message);
  for (const entry of pending.values()) {
    clearTimeout(entry.timer);
    entry.reject(error);
  }
  pending.clear();
}

function dispatch(msg) {
  if (!msg || typeof msg.id !== 'string' || !pending.has(msg.id)) {
    return;
  }
  const entry = pending.get(msg.id);
  pending.delete(msg.id);
  clearTimeout(entry.timer);
  if (msg.ok) {
    entry.resolve(msg);
  }
  else {
    entry.reject(new Error(msg.error || 'native fs request failed'));
  }
}

// Brings up (or returns) the persistent fs session. Resolves once the
// sandbox script reported {cmd:'ready'}; rejects with a user-facing message
// when the native host is missing or fails to start.
function connect() {
  if (session) {
    return Promise.resolve();
  }
  if (!bootPromise) {
    bootPromise = loadScript().then(script => new Promise((resolve, reject) => {
      const uuid = crypto.randomUUID();
      let p;
      try {
        p = chrome.runtime.connectNative(NATIVE_HOST);
      }
      catch (e) {
        reject(new Error('Native client is not available (' + (e?.message || e) + ')'));
        return;
      }
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        try {
          p.disconnect();
        }
        catch {}
        reject(new Error('Native client did not start in time'));
      }, BOOT_TIMEOUT);
      p.onMessage.addListener(msg => {
        if (!settled) {
          if (msg && msg.cmd === 'ready') {
            settled = true;
            clearTimeout(timer);
            session = {port: p, uuid};
            resolve();
          }
          else if (msg && msg.cmd === 'disconnected') {
            settled = true;
            clearTimeout(timer);
            reject(new Error(msg.message || 'Native client failed to start'));
          }
          return;
        }
        if (msg && msg.cmd === 'disconnected') {
          dropPort(msg.message || 'Native client disconnected');
        }
        else {
          dispatch(msg);
        }
      });
      p.onDisconnect.addListener(() => {
        const message = chrome.runtime.lastError?.message || 'Native client disconnected';
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error(message));
        }
        else {
          dropPort(message);
        }
      });
      try {
        p.postMessage({
          uuid,
          permissions: ['fs', 'node:buffer', 'node:path', 'path'],
          args: [],
          script
        });
      }
      catch (e) {
        settled = true;
        clearTimeout(timer);
        reject(new Error('Failed to talk to the native client (' + (e?.message || e) + ')'));
      }
    }));
    // a settled boot must not pin the state; a dead session re-boots on demand
    const settle = () => {
      bootPromise = null;
    };
    bootPromise.then(settle, settle);
  }
  return bootPromise;
}

// One sandbox-script request over the persistent session. The data frame is
// wrapped in {cmd:'post-message', uuid} — without the wrapper the host never
// forwards it to the sandbox and the request would die in the timeout below.
function request(data, timeout = REQUEST_TIMEOUT) {
  return connect().then(() => {
    const s = session;
    if (!s) {
      throw new Error('Native client disconnected');
    }
    const id = 'r' + (++seq);
    return new Promise((resolve, reject) => {
      const entry = {
        timer: setTimeout(() => {
          pending.delete(id);
          reject(new Error('Native client request timed out'));
        }, timeout),
        resolve: null,
        reject: null
      };
      entry.resolve = value => {
        clearTimeout(entry.timer);
        resolve(value);
      };
      entry.reject = error => {
        clearTimeout(entry.timer);
        reject(error);
      };
      pending.set(id, entry);
      try {
        s.port.postMessage({
          cmd: 'post-message',
          uuid: s.uuid,
          data: {id, ...data}
        });
      }
      catch (e) {
        pending.delete(id);
        clearTimeout(entry.timer);
        reject(new Error('Failed to talk to the native client (' + (e?.message || e) + ')'));
      }
    });
  });
}

// One-shot probe used by the options page: fresh port, boot, a full ping
// round trip through the post-message wrapper, disconnect. Proving the round
// trip is the point — a host that boots but cannot talk to the sandbox is
// not usable. Resolves {installed, error} and never throws.
async function detectNativeClient() {
  try {
    const script = await loadScript();
    await new Promise((resolve, reject) => {
      const uuid = crypto.randomUUID();
      let p;
      try {
        p = chrome.runtime.connectNative(NATIVE_HOST);
      }
      catch (e) {
        reject(new Error(e?.message || String(e)));
        return;
      }
      let done = false;
      let ponged = false;
      const finish = (fn, value) => {
        if (done) {
          return;
        }
        done = true;
        clearTimeout(timer);
        try {
          p.disconnect();
        }
        catch {}
        fn(value);
      };
      const timer = setTimeout(() => {
        finish(reject, new Error(ponged ? 'Native client did not respond in time' : 'Native client did not start in time'));
      }, BOOT_TIMEOUT);
      p.onMessage.addListener(msg => {
        if (msg && msg.cmd === 'disconnected') {
          finish(reject, new Error(msg.message || 'Native client failed to start'));
        }
        else if (msg && msg.cmd === 'ready' && !ponged) {
          // sandbox booted; now verify the request path with a ping
          ponged = true;
          try {
            p.postMessage({
              cmd: 'post-message',
              uuid,
              data: {id: 'ping', op: 'ping'}
            });
          }
          catch (e) {
            finish(reject, new Error('Failed to talk to the native client (' + (e?.message || e) + ')'));
          }
        }
        else if (msg && msg.id === 'ping' && msg.ok) {
          finish(resolve, msg);
        }
        else if (msg && msg.id === 'ping' && msg.ok === false) {
          finish(reject, new Error(msg.error || 'native ping failed'));
        }
      });
      p.onDisconnect.addListener(() => {
        finish(reject, new Error(chrome.runtime.lastError?.message || 'Native client is not available'));
      });
      try {
        p.postMessage({
          uuid,
        permissions: ['fs', 'node:buffer', 'node:path', 'path'],
        args: [],
        script
      });
    }
    catch (e) {
      finish(reject, new Error('Failed to talk to the native client (' + (e?.message || e) + ')'));
    }
    });
    return {installed: true, error: ''};
  }
  catch (e) {
    return {installed: false, error: e?.message || String(e)};
  }
}

// Writes raw bytes into dir under name; the sandbox picks a collision-free
// name and never overwrites. Resolves with {path} — the actual file written.
function writeFile({dir, name, data}) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  return request({op: 'write', dir: String(dir || ''), name: String(name || ''), data: toBase64(bytes)});
}

// Batch form of writeFile: many {dir, name, data} entries, one IPC round
// trip. Entries report independently — resolve is [{ok:true, path} | {ok:
// false, error}]. The msg.ok reply gate is bypassed here because the batch
// itself succeeds even when single entries fail; read results out of
// msg.results.
function writeFiles(files) {
  const list = Array.isArray(files) ? files : [];
  if (!list.length) {
    return Promise.resolve({results: []});
  }
  return request({op: 'write-batch', files: list.map(f => ({
    dir: String(f?.dir || ''),
    name: String(f?.name || ''),
    data: toBase64(f?.data instanceof Uint8Array ? f.data : new Uint8Array(f?.data ?? []))
  }))}, 5 * REQUEST_TIMEOUT);
}

export {detectNativeClient, writeFile, writeFiles};
