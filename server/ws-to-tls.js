// ws-to-tls.js — WebSocket -> TCP/TLS bridge server (standalone + embedded).
//
// The same file runs in three modes:
//   1. standalone CLI   node ws-to-tls.js [options]
//   2. programmatic     const {startWsBridge} = require('./ws-to-tls.js');
//   3. embedded         the extension (core/ws-to-tls/core.mjs) fetches this
//                       file and ships its text to the com.add0n.node
//                       sandbox, which provides the push/connect/args globals
//
// Dial protocol (per WebSocket connection): the client first sends a TEXT
// frame {op:'open', host, port, secure, allowSelfSigned}; the server replies
// TEXT {op:'ready', host, port, secure} or {op:'error', message} and then
// tunnels the stream as BINARY frames. secure:false dials plaintext TCP
// (clients like the WASM IMAP client do TLS themselves); secure:true lets
// this server terminate TLS.

'use strict';

const net = require('net');
const tls = require('tls');
const crypto = require('crypto');
const {Buffer} = require('node:buffer');

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_FRAME = 8 * 1024 * 1024;

// ---------- WebSocket frame codec (RFC 6455, server side) ----------
function encodeFrame(opcode, payload) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  }
  else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  }
  else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeUInt32BE(Math.floor(len / 4294967296), 2);
    header.writeUInt32BE(len >>> 0, 6);
  }
  header[0] = 0x80 | opcode; // FIN=1
  return Buffer.concat([header, payload]);
}

// returns {fin, opcode, payload, bytesConsumed} or null if incomplete
function decodeFrame(buf) {
  if (buf.length < 2) {
    return null;
  }
  const fin = (buf[0] & 0x80) !== 0;
  const opcode = buf[0] & 0x0f;
  const masked = (buf[1] & 0x80) !== 0;
  let len = buf[1] & 0x7f;
  let offset = 2;
  if (len === 126) {
    if (buf.length < 4) {
      return null;
    }
    len = buf.readUInt16BE(2);
    offset = 4;
  }
  else if (len === 127) {
    if (buf.length < 10) {
      return null;
    }
    const hi = buf.readUInt32BE(2);
    const lo = buf.readUInt32BE(6);
    if (hi > 0 || lo > MAX_FRAME) {
      throw new Error('frame too large');
    }
    len = lo;
    offset = 10;
  }
  let maskKey = null;
  if (masked) {
    if (buf.length < offset + 4) {
      return null;
    }
    maskKey = buf.slice(offset, offset + 4);
    offset += 4;
  }
  if (buf.length < offset + len) {
    return null;
  }
  let payload = buf.slice(offset, offset + len);
  if (masked && len > 0) {
    const out = Buffer.alloc(len);
    for (let i = 0; i < len; i++) {
      out[i] = payload[i] ^ maskKey[i & 3];
    }
    payload = out;
  }
  return {
    fin,
    opcode,
    payload,
    bytesConsumed: offset + len
  };
}

// ---------- one proxied WebSocket connection ----------
function makeConn(sock, options, log) {
  // connection/dial events are only reported when options.debug is set;
  // the transport-error log below is always on
  const dlog = (message) => {
    if (options.debug) {
      log(message);
    }
  };
  const conn = {
    sock,
    upstream: null,
    mode: null, // 'native-ctl' once the first TEXT (open) frame arrives
    fragOpcode: 0,
    fragBuf: Buffer.alloc(0),
    rxbuf: Buffer.alloc(0),
    pending: Buffer.alloc(0),
    upgraded: false,
    closed: false,
  };
  conn.sendFrame = (opcode, payload) => {
    if (conn.closed) {
      return;
    }
    try {
      sock.write(encodeFrame(opcode, payload));
    }
    catch {
      conn.teardown();
    }
  };
  conn.sendText = (s) => conn.sendFrame(0x1, Buffer.from(s, 'utf8'));
  conn.teardown = () => {
    if (conn.closed) {
      return;
    }
    conn.closed = true;
    if (conn.upstream) {
      conn.upstream.destroy();
      conn.upstream = null;
    }
    try {
      sock.destroy();
    }
    catch {}
  };
  // Graceful close: send (or echo) a WebSocket close frame and end the TCP
  // stream so the peer sees a clean 1000-close instead of an aborted socket.
  conn.gracefulClose = (payload) => {
    if (conn.closing) {
      return;
    }
    conn.closing = true;
    conn.closed = true;
    if (conn.upstream) {
      conn.upstream.destroy();
      conn.upstream = null;
    }
    try {
      sock.write(encodeFrame(0x8, payload || Buffer.from([0x03, 0xe8])));
    }
    catch {}
    try {
      sock.end();
    }
    catch {}
    const t = setTimeout(() => {
      try {
        sock.destroy();
      }
      catch {}
    }, 1000);
    if (typeof t.unref === 'function') {
      t.unref();
    }
  };
  conn.forward = (chunk) => {
    if (conn.upstream && !conn.upstream.destroyed) {
      conn.upstream.write(chunk);
    }
  };
  conn.dial = (target) => {
    const host = String(target.host || '');
    const port = Number(target.port);
    if (!host || !(port >= 1 && port <= 65535)) {
      conn.sendText(JSON.stringify({
        op: 'error',
        message: 'open: host and port are required'
      }));
      conn.teardown();
      return;
    }
    const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
    const secure = target.secure !== false;
    dlog('open request: ' + host + ':' + port + (secure ? ' (TLS)' : ' (plaintext)'));
    const sockOpts = {
      host,
      port
    };
    if (target.family) {
      sockOpts.family = Number(target.family);
    }
    if (!isIp) {
      sockOpts.servername = host;
    }
    try {
      if (!secure) {
        conn.upstream = net.connect(sockOpts, () => {
          if (!conn.closed && conn.mode === 'native-ctl') {
            conn.sendText(JSON.stringify({
              op: 'ready',
              host,
              port,
              secure: false
            }));
          }
        });
      }
      else {
        if (target.allowSelfSigned || options.allowSelfSigned) {
          sockOpts.rejectUnauthorized = false;
        }
        conn.upstream = tls.connect(sockOpts, () => {
          if (!conn.closed && conn.mode === 'native-ctl') {
            conn.sendText(JSON.stringify({
              op: 'ready',
              host,
              port,
              secure: true
            }));
          }
        });
      }
    }
    catch (e) {
      conn.sendText(JSON.stringify({
        op: 'error',
        message: 'connect failed: ' + e.message
      }));
      conn.teardown();
      return;
    }
    conn.upstream.on('data', (d) => conn.sendFrame(0x2, d));
    conn.upstream.on('error', (e) => {
      if (log) {
        log('upstream error: ' + e.message);
      }
      if (conn.mode === 'native-ctl') {
        conn.sendText(JSON.stringify({
          op: 'error',
          message: 'upstream: ' + e.message
        }));
      }
      conn.teardown();
    });
    conn.upstream.on('close', () => {
      if (!conn.closed) {
        conn.gracefulClose();
      }
    });
  };
  conn.handleControl = (payload) => {
    let msg;
    try {
      msg = JSON.parse(payload.toString('utf8'));
    }
    catch {
      conn.sendText(JSON.stringify({
        op: 'error',
        message: 'bad control frame'
      }));
      conn.teardown();
      return;
    }
    if (msg.op === 'open') {
      conn.dial(msg);
    }
    else {
      conn.sendText(JSON.stringify({
        op: 'error',
        message: 'unknown op: ' + msg.op
      }));
    }
  };
  conn.dispatch = (opcode, payload) => {
    if (opcode === 0x1) {
      // first TEXT frame carries the {op:'open'} dial request
      conn.mode = conn.mode || 'native-ctl';
      if (conn.ctlHandled) {
        return; // ignore late control frames after dial
      }
      conn.ctlHandled = true;
      conn.handleControl(payload);
    }
    else if (opcode === 0x2) {
      if (!conn.upstream) {
        // binary frame before a successful {op:'open'} dial: protocol violation
        conn.sendText(JSON.stringify({
          op: 'error',
          message: 'no dial target: send an {op:open, host, port} control frame first'
        }));
        conn.teardown();
        return;
      }
      conn.forward(payload);
    }
  };
  conn.handleFrame = (frame) => {
    const opcode = frame.opcode;
    if (opcode === 0x0) {
      if (!conn.fragOpcode) {
        conn.teardown();
        return;
      }
      conn.fragBuf = Buffer.concat([conn.fragBuf, frame.payload]);
      if (frame.fin) {
        const op = conn.fragOpcode;
        const buf = conn.fragBuf;
        conn.fragOpcode = 0;
        conn.fragBuf = Buffer.alloc(0);
        conn.dispatch(op, buf);
      }
      return;
    }
    if (opcode === 0x8) {
      // echo the peer's close code/reason and finish the handshake
      conn.gracefulClose(frame.payload && frame.payload.length >= 2 ? frame.payload.slice(0, 2) : undefined);
      return;
    }
    if (opcode === 0x9) {
      conn.sendFrame(0xa, frame.payload);
      return;
    }
    if (opcode === 0xa) {
      return;
    }
    if (!frame.fin) {
      conn.fragOpcode = opcode;
      conn.fragBuf = frame.payload;
      return;
    }
    conn.dispatch(opcode, frame.payload);
  };
  conn.handshake = (head) => {
    const lines = head.split('\r\n');
    const reqLine = lines[0] || '';
    const headers = {};
    for (let i = 1; i < lines.length; i++) {
      const c = lines[i].indexOf(':');
      if (c > 0) {
        headers[lines[i].slice(0, c).trim().toLowerCase()] = lines[i].slice(c + 1).trim();
      }
    }
    const okPath = !options.token || reqLine.indexOf('GET /' + options.token + ' ') === 0;
    const okUpgrade = /websocket/i.test(headers['upgrade'] || '');
    const key = headers['sec-websocket-key'];
    if (!okPath || !okUpgrade || !key) {
      try {
        sock.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      }
      catch {}
      conn.teardown();
      return false;
    }
    const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
    sock.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      'Sec-WebSocket-Accept: ' + accept + '\r\n' +
      '\r\n'
    );
    dlog('ws client connected from ' + sock.remoteAddress);
    return true;
  };
  sock.on('data', (chunk) => {
    if (conn.closed) {
      return;
    }
    if (!conn.upgraded) {
      conn.pending = Buffer.concat([conn.pending, chunk]);
      const idx = conn.pending.indexOf('\r\n\r\n');
      if (idx < 0) {
        if (conn.pending.length > 16384) {
          conn.teardown();
        }
        return;
      }
      const head = conn.pending.slice(0, idx).toString('utf8');
      conn.rxbuf = conn.pending.slice(idx + 4);
      conn.pending = Buffer.alloc(0);
      if (!conn.handshake(head)) {
        return;
      }
      conn.upgraded = true;
    }
    else {
      conn.rxbuf = Buffer.concat([conn.rxbuf, chunk]);
    }
    while (conn.rxbuf.length > 0 && !conn.closed) {
      let frame;
      try {
        frame = decodeFrame(conn.rxbuf);
      }
      catch {
        conn.teardown();
        return;
      }
      if (!frame) {
        return;
      }
      conn.rxbuf = conn.rxbuf.slice(frame.bytesConsumed);
      conn.handleFrame(frame);
    }
  });
  sock.on('error', () => conn.teardown());
  sock.on('close', () => conn.teardown());
  return conn;
}

// ---------- server bootstrap (shared by all run modes) ----------
// push({cmd, ...}) reports 'connected' (port/token/url), 'disconnected'
// ('requested' | 'error') and 'log' messages to the surrounding mode.
function startBridge(options, push) {
  const log = (message) => push({cmd: 'log', message});
  const server = net.createServer((sock) => {
    makeConn(sock, options, log);
  });
  server.on('error', (e) => push({
    cmd: 'disconnected',
    reason: 'error',
    message: e.message
  }));
  const close = () => new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections?.();
  });
  const host = options.wsHost || '127.0.0.1';
  console.log(host);
  server.listen(options.wsPort || 0, host, () => {
    const port = server.address().port;
    const token = options.token || null;
    push({
      cmd: 'connected',
      port,
      token,
      url: 'ws://' + host + ':' + port + (token ? '/' + token : '')
    });
  });
  return {server, close};
}

// ---------- mode 3: embedded in the com.add0n.node sandbox ----------
if (typeof push === 'function' && typeof connect === 'function' && typeof args !== 'undefined') {
  const bridge = startBridge(args[0], push);
  connect((msg) => {
    if (msg.cmd === 'disconnect') {
      bridge.close().then(() => push({
        cmd: 'disconnected',
        reason: 'requested'
      }));
    }
  });
}

// ---------- mode 1: standalone CLI ----------
const USAGE = [
  'usage: node ws-to-tls.js [options]',
  '',
  'WebSocket -> TCP/TLS dial proxy: each WS client first sends a TEXT',
  "{op:'open', host, port} control frame; the server dials and tunnels the",
  'stream as binary frames.',
  '',
  'options:',
  '  --ws-host HOST       host to listen on (default 127.0.0.1)',
  '  --ws-port N          port to listen on (default 0 = random)',
  '  --token TOKEN        URL path token (default: a random one is generated)',
  '  --allow-self-signed  default for open frames without allowSelfSigned',
  '  --quiet              suppress per-frame logging',
  '  -h, --help'
].join('\n');

function cli(argv) {
  const flag = (name) => argv.includes(name);
  const value = (name, fallback) => {
    const i = argv.indexOf(name);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback;
  };
  if (flag('--help') || flag('-h')) {
    console.log(USAGE);
    process.exit(0);
  }
  const quiet = flag('--quiet');
  const options = {
    wsHost: value('--ws-host', '127.0.0.1'),
    wsPort: parseInt(value('--ws-port', '0'), 10) || 0,
    // random token when not provided: the printed ws:// url is the only way in
    token: value('--token', '') || crypto.randomUUID(),
    allowSelfSigned: flag('--allow-self-signed'),
    debug: true // connection/dial logs are always on for the CLI (--quiet filters)
  };
  startBridge(options, (msg) => {
    if (msg.cmd === 'connected') {
      console.log(`ws-to-tls bridge on ${msg.url}`);
    }
    else if (msg.cmd === 'disconnected') {
      if (msg.reason === 'error') {
        console.error(`ws-to-tls error: ${msg.message}`);
        process.exitCode = 1;
      }
      else {
        console.log(`ws-to-tls bridge stopped (${msg.reason})`);
      }
    }
    else if (!quiet && msg.cmd === 'log') {
      console.log(msg.message);
    }
  });
  const stop = () => process.exit(0);
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

if (typeof module !== 'undefined' && module.exports && require.main === module) {
  cli(process.argv.slice(2));
}

// ---------- mode 2: programmatic use ----------
// Resolves with {port, token, url, close()} once the server is listening.
// Per-frame traffic is silent unless options.log is provided.
function startWsBridge(options = {}) {
  return new Promise((resolve, reject) => {
    let connected = false;
    const bridge = startBridge(options, (msg) => {
      if (msg.cmd === 'connected') {
        connected = true;
        resolve({
          port: msg.port,
          token: msg.token,
          url: msg.url,
          close: () => bridge.close()
        });
      }
      else if (msg.cmd === 'disconnected' && msg.reason === 'error') {
        if (connected) {
          console.error(`ws-to-tls error: ${msg.message}`);
        }
        else {
          reject(new Error(msg.message));
        }
      }
      else if (msg.cmd === 'log' && typeof options.log === 'function') {
        options.log(msg.message);
      }
    });
  });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {startBridge, startWsBridge};
}
