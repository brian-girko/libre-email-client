// ws-bridge-client.mjs — boots the ws->tls bridge script (core/ws-to-tls/
// ws-to-tls.js) inside the com.add0n.node sandbox, so the extension gets a
// local WebSocket->TCP dial proxy without any user-launched process. The
// bridge script is mode-3 ready: it self-detects the sandbox's push/connect/
// args globals, starts the server with args[0] and pushes {cmd:'connected',
// port, token, url} once listening.
//
// Boot mirrors native-client.mjs: one native port, a postMessage boot frame
// {uuid, permissions, args, script}. For the bridge only self pushes matter
// ({cmd:'connected'|'log'|'disconnected'}, unwrapped); boot resolves when the
// connected push hands over the ws:// url, and startWsTlsBridge() then keeps
// the port alive for the lifetime of the bridge. The sandbox requires net/
// crypto/node:buffer permissions to run the bridge's server code.

'use strict';

const NATIVE_HOST = 'com.add0n.node';
const BOOT_TIMEOUT = 15000;
// ws-to-tls requires net/tls, crypto and Buffer; 'tls' lives behind the net
// permission in com.add0n.node.
const PERMISSIONS = ['net', 'crypto', 'node:buffer'];
const BRIDGE_ARGS = [{wsHost: '127.0.0.1', wsPort: 0}];

function loadBridgeScript() {
  return fetch(chrome.runtime.getURL('core/ws-to-tls/ws-to-tls.js')).then(res => {
    if (!res.ok) {
      throw new Error('failed to load core/ws-to-tls/ws-to-tls.js: ' + res.status);
    }
    return res.text();
  });
}

// Starts the embedded bridge. Resolves {url, detach()} where url is the
// ws://127.0.0.1:<port>/<token> endpoint to feed createMailApi(). Events the
// caller wants to see (bridge logs, unexpected shutdowns) go through the
// optional onEvent callback; detach() drops the native port, which takes the
// sandbox (and with it the bridging server) down.
async function startWsTlsBridge(onEvent) {
  const script = await loadBridgeScript();
  const report = (msg) => {
    if (typeof onEvent === 'function') {
      try {
        onEvent(msg);
      }
      catch {
        /* observer errors must not kill the bridge */
      }
    }
  };
  return new Promise((resolve, reject) => {
    let port;
    try {
      port = chrome.runtime.connectNative(NATIVE_HOST);
    }
    catch (e) {
      reject(new Error('Native client is not available (' + (e?.message || e) + ')'));
      return;
    }
    const uuid = crypto.randomUUID();
    let session = false;
    let settled = false;
    // Pre-connected pushes buffered until the caller has the handle, so no
    // early log line is lost.
    const events = [];

    const timer = setTimeout(() => {
      if (session || settled) {
        return;
      }
      settled = true;
      try {
        port.disconnect();
      }
      catch {}
      reject(new Error('ws bridge did not start in time'));
    }, BOOT_TIMEOUT);

    const finish = (fn, value) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      fn(value);
    };

    port.onMessage.addListener(msg => {
      if (!msg || typeof msg !== 'object') {
        return;
      }
      if (!session) {
        if (msg.cmd === 'connected') {
          session = true;
          resolve({
            url: msg.url,
            detach: () => {
              session = false;
              try {
                port.disconnect();
              }
              catch {}
            }
          });
          events.splice(0).forEach(report);
        }
        else if (msg.cmd === 'disconnected') {
          finish(reject, new Error(msg.message || 'bridge failed to start'));
          try {
            port.disconnect();
          }
          catch {}
        }
        else {
          // pre-connected log noise: report only once the caller is live
          events.push(msg);
        }
        return;
      }
      if (msg.cmd === 'log') {
        report({kind: 'log', message: msg.message});
      }
      else if (msg.cmd === 'disconnected') {
        report({kind: 'down', message: msg.message || 'bridge stopped'});
      }
    });

    port.onDisconnect.addListener(() => {
      const message = chrome.runtime.lastError?.message || 'Native client disconnected';
      if (!session) {
        finish(reject, new Error(message));
      }
      else {
        report({kind: 'down', message});
      }
    });

    try {
      port.postMessage({
        uuid,
        permissions: PERMISSIONS,
        args: BRIDGE_ARGS,
        script
      });
    }
    catch (e) {
      finish(reject, new Error('Failed to talk to the native client (' + (e?.message || e) + ')'));
    }
  });
}

// One-shot probe (diagnostics style boot): fresh port, wait for the connected
// push, disconnect. Resolves {installed, error}, never throws.
async function detectWsTlsBridge() {
  try {
    const script = await loadBridgeScript();
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
        finish(reject, new Error('Native client did not start in time'));
      }, BOOT_TIMEOUT);
      p.onMessage.addListener(msg => {
        if (msg && msg.cmd === 'disconnected') {
          finish(reject, new Error(msg.message || 'Native client failed to start'));
        }
        else if (msg && msg.cmd === 'connected') {
          finish(resolve, msg);
        }
      });
      p.onDisconnect.addListener(() => {
        finish(reject, new Error(chrome.runtime.lastError?.message || 'Native client is not available'));
      });
      try {
        p.postMessage({
          uuid,
          permissions: PERMISSIONS,
          args: BRIDGE_ARGS,
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

export {startWsTlsBridge, detectWsTlsBridge};
