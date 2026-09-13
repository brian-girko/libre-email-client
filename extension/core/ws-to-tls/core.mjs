'use strict';

// WebSocket -> TCP/TLS bridge used by IMAP client. The node server lives in
// ws-to-tls.js (a packaged copy of /server/ws-to-tls.js — keep in sync); this
// wrapper ships its text to the com.add0n.node sandbox and wires ready/log.
// The bridge dials no fixed target: each WS client sends {op:'open', host,
// port} per connection (see rust-imap-client/api.mjs), so one bridge serves
// multiple accounts.

const uuid = crypto.randomUUID();
const ws = {
  post(data) {
    this.port.postMessage({
      cmd: 'post-message',
      uuid,
      data
    });
  },
  async start({token, wsHost, wsPort, allowSelfSigned, debug, ready, log}) {
    const script = await fetch(chrome.runtime.getURL('core/ws-to-tls/ws-to-tls.js')).then(r => {
      if (!r.ok) {
        throw Error('failed to load ws-to-tls.js: ' + r.status);
      }
      return r.text();
    });
    return new Promise((resolve, reject) => {
      this.port = chrome.runtime.connectNative('com.add0n.node');
      this.port.onDisconnect.addListener(() => {
        reject(Error('WS/TCP is disconnected'));
      });

      this.port.onMessage.addListener(request => {
        if (request.cmd === 'disconnected') {
          if (request.reason === 'error') {
            reject(Error(request.message));
          }
          else {
            resolve(request.reason);
          }
        }
        else if (request.cmd === 'connected') {
          ready(request);
        }
        else {
          log(request);
        }
      });

      this.port.postMessage({
        uuid,
        permissions: ['net', 'tls', 'crypto', 'node:buffer'],
        args: [{
          token, // @param {string} [options.token] require this URL path token if set
          wsHost, // @param {number} [options.wsHost] host to listen on
          wsPort, // @param {number} [options.wsPort] port to listen on (0 = random)
          allowSelfSigned, // @param {boolean} [options.allowSelfSigned] accept any upstream TLS certificate
          debug // @param {boolean} [options.debug] log ws client connections and open requests
        }],
        script
      });
    });
  },
  stop() {
    this.post({
      cmd: 'disconnect'
    });
  }
};


export {ws};
