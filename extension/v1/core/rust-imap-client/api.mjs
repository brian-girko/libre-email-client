'use strict';

// Shared MailApi facade — WASM backend (mail-core).
//
// Implements the MailApi contract described below. nodejs-client/src/api.mjs
// exposes the exact same interface on top of ImapFlow; keep the typedef block
// in both files in sync (harness/test-api.mjs enforces the runtime contract).
//
// Usage:
//   import { createMailApi } from './js/api.mjs';
//   const api = await createMailApi({
//   bridgeUrl: 'ws://127.0.0.1:8787/<token>', // ws-bridge dial proxy
//   host: 'imap.example.com', port: 993, secure: true,
//     user: 'u', pass: 'p',
//     wasmBytes,            // Uint8Array with mail_core_bg.wasm (or wasmUrl)
//   });
//   await api.connect();
//   const dirs = await api.listDirs();
//   await api.openDir('INBOX');
//   const files = await api.listFiles({ page: 0, pageSize: 20 }); // newest first
//   const raw = await api.readFile(files[0].uid);
//   await api.setFlags([files[0].uid], ['\\Seen'], []);   // mark as read
//   await api.moveTo([files[0].uid], 'Trash');            // bulk trash/archive
//   const res = await api.idle({ timeoutMs: 20000 });
//   await api.close();

import { initSync, MailClient, TransportRx } from './mail_core.mjs';

let wasmReady = false;

async function loadWasm({ wasmBytes, wasmUrl }) {
    if (wasmReady) return;
    let bytes = wasmBytes;
    if (!bytes) {
        if (!wasmUrl) {
            throw new Error('createMailApi: provide wasmBytes or wasmUrl for mail_core_bg.wasm');
        }
        const res = await fetch(wasmUrl);
        if (!res.ok) throw new Error(`createMailApi: failed to fetch wasm (${res.status})`);
        bytes = new Uint8Array(await res.arrayBuffer());
    }
    initSync({ module: bytes });
    wasmReady = true;
}

async function pickWebSocket(WebSocketImpl) {
    if (WebSocketImpl) return WebSocketImpl;
    if (typeof globalThis.WebSocket === 'function') return globalThis.WebSocket;
    // Node fallback (harness tests); resolves 'ws' from the importing package.
    try {
        const mod = await import('ws');
        return mod.WebSocket ?? mod.default?.WebSocket;
    } catch {
        throw new Error('createMailApi: no WebSocket implementation available');
    }
}

function toU8(data) {
    if (data instanceof Uint8Array) return data;
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    return new Uint8Array(data?.buffer ?? data, data?.byteOffset ?? 0, data?.byteLength ?? data?.length ?? 0);
}

// ---- RFC 2047 MIME encoded-word decoding -------------------------------
// IMAP ENVELOPE strings arrive raw, e.g. subject "=?utf-8?B?...?=". Decode:
// parse the token, get the raw bytes (B: base64, Q: _=space, =XX=hex), then
// TextDecoder(charset). Idempotent on already-decoded text.

function b64ToBytes(b64) {
    const bin = atob(b64.replace(/\s+/g, ''));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

function qToBytes(q) {
    q = q.replace(/_/g, ' ');
    const out = new Uint8Array(q.length);
    let n = 0;
    for (let i = 0; i < q.length; i++) {
        if (q[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(q.slice(i + 1, i + 3))) {
            out[n++] = parseInt(q.slice(i + 1, i + 3), 16);
            i += 2;
        } else {
            out[n++] = q.charCodeAt(i) & 0xff;
        }
    }
    return out.subarray(0, n);
}

// ---- IMAP SEARCH criteria builder -----------------------------------------

// Escape a string for the IMAP wire: quoted strings escape \ and ".
function imapQuote(s) {
    return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

const MONTHS_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// IMAP date format for SINCE/BEFORE: "7-Sep-2026" (2-digit day not required).
function imapDate(d) {
    const date = new Date(d);
    if (isNaN(date.getTime())) {
        return null;
    }
    return `${date.getDate()}-${MONTHS_NAMES[date.getMonth()]}-${date.getFullYear()}`;
}

/**
 * Build an IMAP SEARCH criteria string from user input.
 * Plain text becomes `TEXT "…"` (server-side full-text). Prefixes map to
 * their IMAP keys: from: to: subject: body: since: before:. `is:` maps to
 * flag keys: is:unseen is:seen is:flagged is:answered is:deleted →
 * UNSEEN SEEN FLAGGED ANSWERED DELETED. Any key accepts an optional `not:`
 * prefix for negation (e.g. `not:is:deleted` → `NOT DELETED`; `not:` on
 * since/before dates is ignored). Multiple terms are ANDed (IMAP default).
 * Returns "" for empty input.
 * @param {string} query
 * @returns {string}
 */
export function buildCriteria(query) {
    const raw = String(query ?? '').trim();
    if (!raw) return '';
    const FLAGS = {
        unseen: 'UNSEEN',
        seen: 'SEEN',
        flagged: 'FLAGGED',
        answered: 'ANSWERED',
        deleted: 'DELETED',
    };
    const parts = [];
    for (const token of raw.split(/\s+/)) {
        const m = token.match(/^(not:)?(from|to|subject|body|text|since|before|is):(.*)$/i);
        if (!m) {
            parts.push(`TEXT ${imapQuote(token)}`);
            continue;
        }
        const [, neg, key, rest] = m;
        if (/^(since|before)$/i.test(key)) {
            const d = imapDate(rest);
            if (d) {
                parts.push(`${key.toUpperCase()} ${d}`);
            }
            continue;
        }
        if (/^is$/i.test(key)) {
            const flag = FLAGS[rest.toLowerCase()];
            if (flag) {
                parts.push(`${neg ? 'NOT ' : ''}${flag}`);
            }
            continue;
        }
        if (rest) {
            parts.push(`${neg ? 'NOT ' : ''}${key.toUpperCase()} ${imapQuote(rest)}`);
        }
    }
    return parts.join(' ');
}

export function decodeMimeWords(input) {
    if (!input || input.indexOf('=?') === -1) return input;
    // whitespace between adjacent encoded words is not part of the text
    const joined = input.replace(/(\?=)[ \t\r\n]+(=\?)/g, '$1$2');
    return joined.replace(/=\?([^?\s]+)\?([BbQq])\?([^?\s]*)\?=/g, (token, charset, enc, data) => {
        try {
            const bytes = enc.toUpperCase() === 'B' ? b64ToBytes(data) : qToBytes(data);
            return new TextDecoder(charset.toLowerCase()).decode(bytes).replace(/\s+/g, ' ').trim();
        } catch {
            return token; // unknown charset or malformed: leave untouched
        }
    });
}

/**
 * Normalize a raw wasm thread row into the documented ThreadSummary shape
 * (numbers as numbers, flags as strings, RFC 2047 encoded words decoded).
 * Shared by listThreads() and search() so both return the same shape.
 */
function mapThread(t) {
    return {
        uids: (Array.isArray(t.uids) ? t.uids : []).map(Number),
        count: Number(t.count) || 0,
        unread: Number(t.unread) || 0,
        flagged: !!t.flagged,
        subject: decodeMimeWords(t.subject ?? null),
        from: decodeMimeWords(t.from ?? null),
        date: t.date ?? null,
        messages: (Array.isArray(t.messages) ? t.messages : []).map((m) => ({
            uid: Number(m.uid),
            flags: Array.isArray(m.flags) ? m.flags.map(String) : [],
            subject: decodeMimeWords(m.subject ?? null),
            from: decodeMimeWords(m.from ?? null),
            date: m.date ?? null,
        })),
    };
}

/**
 * @typedef {Object} MailConfig
 * @property {string} bridgeUrl WebSocket URL of the ws-bridge dial proxy
 *   (ws://127.0.0.1:<port>/<token>). One connection is opened per API; the
 *   host/port below are dialed per connection via an {op:'open'} message.
 * @property {string} host IMAP server hostname (dial target).
 * @property {number} port IMAP server port.
 * @property {boolean} [secure=true] false => plaintext IMAP (no TLS on the wire).
 * @property {boolean} [allowSelfSigned=false] accept any server TLS certificate,
 *   including self-signed ones (skip chain/hostname validation; testing).
 *   Ignored when secure is false. The wasm binding keeps its set_insecure name.
 * @property {string} user
 * @property {string} pass
 * @property {boolean|((msg: string) => void)} [debug] connection diagnostics
 *   (resolved config at create time, connect/login, per-call timing).
 *   true => console.log; a function => messages passed to it.
 *   Passwords are never logged.
 * @property {Uint8Array} [wasmBytes] compiled mail_core_bg.wasm bytes.
 * @property {string} [wasmUrl] URL to fetch mail_core_bg.wasm from (browser).
 * @property {typeof WebSocket} [WebSocketImpl] WebSocket constructor override.
 * @property {string} [accountId] stable account id; scopes engine-side
 *   bookkeeping. Defaults to "user@host" when omitted.
 */

/**
 * @typedef {Object} Folder A mailbox ("dir" in the maildir analogy).
 * @property {string} name
 * @property {string|null} delimiter hierarchy separator, e.g. "/" or "."
 * @property {string[]} attrs e.g. ["\\HasNoChildren"]
 */

/**
 * @typedef {Object} MailboxStatus Result of opening a dir.
 * @property {number} exists number of messages
 * @property {number} uidvalidity
 * @property {number} uidnext next UID the server will assign
 * @property {number|null} unseen
 */

/**
 * @typedef {Object} DirCount unread/total for one folder.
 * @property {string} name full mailbox name
 * @property {number} unread messages without \Seen
 * @property {number} total messages in the folder
 */

/**
 * @typedef {Object} MessageSummary A message ("file" in the maildir analogy).
 * @property {number} uid
 * @property {string[]} flags
 * @property {string|null} subject decoded (RFC 2047 encoded words resolved)
 * @property {string|null} from decoded (RFC 2047 encoded words resolved)
 * @property {string|null} date RFC5322-ish date string
 * @property {number|null} size bytes
 */

/**
 * @typedef {Object} ListOpts
 * @property {number} [page=0] 0-based page, newest messages first.
 * @property {number} [pageSize=20] messages per page.
 * @property {number} [fromUid] explicit UID range (overrides page/pageSize).
 * @property {number} [toUid] explicit UID range end (inclusive).
 */

/**
 * @typedef {Object} IdleResult
 * @property {"timeout"|"new-data"|"interrupt"} type
 * @property {string} [raw] optional detail (server data / rejection text).
 */

/**
 * @typedef {Object} ThreadMessage One message inside a thread (same shape as
 *   MessageSummary minus size).
 * @property {number} uid
 * @property {string[]} flags
 * @property {string|null} subject decoded
 * @property {string|null} from decoded
 * @property {string|null} date RFC5322-ish date string
 */

/**
 * @typedef {Object} ThreadSummary A conversation of related messages.
 * @property {number[]} uids all message UIDs, oldest first
 * @property {number} count same as uids.length
 * @property {number} unread messages without \Seen
 * @property {boolean} flagged any message has \Flagged
 * @property {string|null} subject subject of the oldest message (decoded)
 * @property {string|null} from sender of the oldest message (decoded)
 * @property {string|null} date date of the newest message
 * @property {ThreadMessage[]} messages oldest first
 */

/**
 * @typedef {Object} MailApi
 * @property {() => Promise<void>} connect
 * @property {() => Promise<Folder[]>} listDirs list of mailboxes (LIST).
 * @property {(name: string) => Promise<MailboxStatus>} openDir selects the dir
 *   for subsequent listFiles/listThreads/readFile/idle.
 * @property {(onProgress?: (c: DirCount) => void) => Promise<DirCount[]>} listDirCounts
 *   per-folder unread/total, one server-side SEARCH per selectable mailbox;
 *   onProgress fires as each folder resolves (see DirCount).
 * @property {(name: string) => Promise<void>} createDir CREATE a new mailbox
 *   (hierarchy parents are created as needed; INBOX/existing names rejected).
 * @property {(name: string) => Promise<void>} deleteDir DELETE a mailbox;
 *   closes it when it was the open dir.
 * @property {(opts?: ListOpts) => Promise<MessageSummary[]>} listFiles one
 *   request per page; results sorted newest (highest UID) first.
 * @property {(opts?: {refresh?: boolean}) => Promise<ThreadSummary[]>} listThreads group the whole
 *   selected dir into conversations (JWZ threading inside the wasm core,
 *   newest thread first). Fresh from the server every call; listThreads' me
 *   mirror layer (engine) decides what to store locally.
 * @property {(uid: number) => Promise<Uint8Array>} readFile one FETCH per call,
 *   raw RFC822 bytes of a single message.
 * @property {(uids: number[], addFlags: string[], removeFlags: string[]) => Promise<void>} setFlags
 *   UID STORE on the selected dir; adds/removes IMAP flags (e.g. "\\Seen").
 * @property {(uids: number[], mailbox: string) => Promise<void>} moveTo UID MOVE
 *   to the given mailbox (trash/archive); cores without MOVE fall back to
 *   COPY + "\\Deleted" + EXPUNGE.
 * @property {(uids: number[]) => Promise<void>} deleteMessages STORE
 *   "\\Deleted" on the selected dir, then UID EXPUNGE when the core build
 *   exports expunge_messages; without that export the flag stays set and the
 *   server purges the messages on its next expunge.
 * @property {(opts?: {timeoutMs?: number}) => Promise<IdleResult>} idle wait for
 *   server updates on the selected dir; falls back to NOOP polling when the
 *   server has no IDLE support.
 * @property {() => Promise<void>} close
 * @property {() => string|null} selectedDir currently open dir or null.
 * @property {(opts: {dir?: string, query: string, allFolders?: boolean}) => Promise<ThreadSummary[]>} search
 *   server-side IMAP search rendered as conversations (same shape as
 *   listThreads). This-folder scope by default; allFolders=true searches
 *   every folder and tags each thread with `dir`.
 */

/**
 * Create the WASM-backed MailApi.
 * @param {MailConfig} cfg
 * @returns {Promise<MailApi>}
 */
export async function createMailApi(cfg) {
    const secure = cfg.secure !== false;
    const WebSocketImpl = await pickWebSocket(cfg.WebSocketImpl);
    await loadWasm(cfg);

    let ws = null;
    let rx = null;
    let client = null;
    let selected = null;
    let status = null;
    // Set by socket close/error. Results that resolve afterwards are
    // untrustworthy: once the transport is gone the wasm core can settle
    // pending commands with garbage (e.g. an empty mailbox list) instead of
    // an error, so reads re-check liveness and surface a real connection
    // error for the reconnect wrapper to act on.
    let transportDown = false;

    const log = (msg) => {
        if (!cfg.debug) return;
        const line = `[rust-client] ${msg}`;
        if (typeof cfg.debug === 'function') cfg.debug(line);
        else console.log(line);
    };

    // wasm-bindgen rejects with plain JsValues (often strings); normalize so
    // callers always get a real Error (err.message / err.stack work).
    const toError = (e) => (e instanceof Error ? e : new Error(String(e?.message ?? e)));
    const rethrow = (e) => {
        throw toError(e);
    };

    log(
        `createMailApi ${JSON.stringify({
            bridgeUrl: cfg.bridgeUrl,
            host: cfg.host,
            port: cfg.port,
            secure,
            allowSelfSigned: !!cfg.allowSelfSigned,
            user: cfg.user,
            pass: '***',
        })}`,
    );

    const assertConnected = () => {
        if (!client) throw new Error('not connected; call connect() first');
    };

    // The wasm MailClient is a single-owned Rust object: an in-flight async
    // call keeps it mutably borrowed (wasm-bindgen RefCell), so any
    // overlapping call panics with "recursive use of an object detected
    // which would lead to unsafe aliasing in rust" — and even before that,
    // concurrent commands would interleave on the single IMAP session and
    // cross-feed each other's responses. Run every client call through this
    // FIFO chain; concurrent callers just queue up.
    let tail = Promise.resolve();
    const clientCall = (name, args = [], {postCheck = true} = {}) => {
        const run = tail.then(() => {
            if (!client) throw new Error('not connected; call connect() first');
            if (transportDown) throw new Error('io: transport closed');
            return client[name](...args).catch(rethrow);
        }).then((value) => {
            // Mutations opt out (postCheck: false) so an already-applied
            // command is never re-run because the socket died right after
            // its response.
            if (postCheck && transportDown) throw new Error('io: transport closed');
            return value;
        });
        tail = run.then(() => {}, () => {});
        return run;
    };

    function openSocket() {
        return new Promise((resolve, reject) => {
            const sock = new WebSocketImpl(cfg.bridgeUrl);
            sock.binaryType = 'arraybuffer';
            sock.addEventListener('open', () => resolve(sock));
            sock.addEventListener('error', () => reject(new Error('ws connect failed')));
        });
    }

    // Sends the {op:'open'} dial request and awaits the bridge's control
    // reply. Binary frames that race in with the greeting are buffered and
    // replayed once the socket is wired to the wasm client.
    function dial(sock) {
        const pre = [];
        return new Promise((resolve, reject) => {
            const onMessage = (ev) => {
                if (typeof ev.data !== 'string') {
                    pre.push(toU8(ev.data));
                    return;
                }
                let msg;
                try {
                    msg = JSON.parse(ev.data);
                } catch {
                    fail(new Error('bridge: bad control frame: ' + ev.data));
                    return;
                }
                if (msg.op === 'ready') {
                    cleanup();
                    wireSocket(sock, pre);
                    resolve();
                } else if (msg.op === 'error') {
                    fail(new Error('bridge: ' + (msg.message || 'dial failed')));
                }
            };
            const onError = () => fail(new Error('ws error while dialing'));
            const fail = (e) => {
                cleanup();
                reject(e);
            };
            const cleanup = () => {
                sock.removeEventListener('message', onMessage);
                sock.removeEventListener('error', onError);
            };
            sock.addEventListener('message', onMessage);
            sock.addEventListener('error', onError);
            sock.send(JSON.stringify({
                op: 'open',
                host: cfg.host,
                port: cfg.port,
                secure: false, // the bridge tunnels plaintext; TLS is the wasm client's job
                allowSelfSigned: !!cfg.allowSelfSigned,
            }));
        });
    }

    function wireSocket(sock, pre = []) {
        rx = new TransportRx();
        client = new MailClient(cfg.host, cfg.user, cfg.pass, rx, {
            send: (bytes) => {
                if (sock.readyState === 1) sock.send(bytes);
            },
            close: () => {
                try {
                    sock.close();
                } catch {
                    /* ignore */
                }
            },
        });
        client.set_insecure(!!cfg.allowSelfSigned);
        client.set_plaintext(!secure);

        sock.addEventListener('message', (ev) => {
            // TEXT frames are bridge control (post-dial diagnostics); only
            // binary frames carry the IMAP byte stream
            if (typeof ev.data === 'string') {
                log(`bridge control: ${ev.data}`);
                return;
            }
            rx.push_bytes(toU8(ev.data));
        });
        sock.addEventListener('close', () => {
            transportDown = true;
            rx.transport_closed();
        });
        sock.addEventListener('error', (e) => {
            transportDown = true;
            rx.transport_error(String(e?.message || e));
        });
        for (const chunk of pre) rx.push_bytes(chunk);
    }

    return {
        async connect() {
            if (client) return;
            log(`connect: opening WS ${cfg.bridgeUrl}`);
            ws = await openSocket();
            log(`connect: dialing ${cfg.host}:${cfg.port} through the bridge`);
            await dial(ws);
            log(`connect: dialed (${secure ? 'TLS inside wasm' : 'plaintext'}), login ${cfg.user}@${cfg.host}:${cfg.port}`);
            const t0 = Date.now();
            try {
                await clientCall('connect');
                log(`connect: OK (${Date.now() - t0}ms)`);
            } catch (e) {
                log(`connect: FAILED after ${Date.now() - t0}ms: ${e.message}`);
                throw e;
            }
        },

        async listDirs() {
            assertConnected();
            const t0 = Date.now();
            try {
                const rows = await clientCall('list_mailboxes');
                const out = rows.map((m) => ({
                    name: m.name,
                    delimiter: m.delimiter ?? null,
                    attrs: Array.isArray(m.attrs) ? m.attrs.map(String) : [],
                }));
                if (!out.length) {
                    // IMAP guarantees INBOX for every authenticated session,
                    // so an empty LIST means the server closed the session in
                    // a way JS cannot observe (e.g. a TLS close_notify the
                    // wasm core absorbed after the DELETE of the open
                    // mailbox). Surface it as a connection error so the
                    // engine's session wrapper rebuilds and retries on a
                    // fresh session instead of passing on a bogus empty list.
                    log('listDirs(): empty mailbox list — treating the session as closed');
                    throw new Error('io: empty mailbox list (session closed by the server?)');
                }
                log(`listDirs() -> ${out.length} dirs (${Date.now() - t0}ms)`);
                return out;
            } catch (e) {
                log(`listDirs() FAILED after ${Date.now() - t0}ms: ${e.message}`);
                throw e;
            }
        },

        async openDir(name) {
            assertConnected();
            const t0 = Date.now();
            try {
                const s = await clientCall('select', [name]);
                selected = name;
                status = s;
                const out = {
                    exists: s.exists,
                    uidvalidity: Number(s.uidvalidity),
                    uidnext: Number(s.uidnext),
                    unseen: s.unseen ?? null,
                };
                log(`openDir(${JSON.stringify(name)}) -> {exists:${out.exists}, uidnext:${out.uidnext}} (${Date.now() - t0}ms)`);
                return out;
            } catch (e) {
                log(`openDir(${JSON.stringify(name)}) FAILED after ${Date.now() - t0}ms: ${e.message}`);
                throw e;
            }
        },

        /**
         * Unread/total per folder, without disturbing the selected mailbox.
         * The wasm core has no STATUS (build artifacts only), so this runs
         * the same per-folder SEARCH as allFolders search(): one match-all
         * search_threads() mailbox, threads carry unread/count sums. Folders
         * are walked sequentially (wasm FIFO); failures skip a folder's
         * counts but do not stop the sweep. onProgress, when given, fires
         * as each folder resolves so callers can update incrementally.
         * @param {(c: DirCount) => void} [onProgress]
         * @returns {Promise<DirCount[]>}
         */
        async listDirCounts(onProgress) {
            assertConnected();
            if (typeof client.search_threads !== 'function') {
                throw new Error('listDirCounts: mail core build does not support search; rebuild rust-client with search_threads export');
            }
            const folders = (await this.listDirs()).filter((f) =>
                !f.attrs.some((a) => /\\noselect|\\nonexistent/i.test(String(a)))
            );
            const t0 = Date.now();
            const criteria = buildCriteria('since:1970-01-01') || 'SINCE 1-Jan-1970';
            const out = [];
            for (const folder of folders) {
                let unread = 0;
                let total = 0;
                try {
                    const rows = await clientCall('search_threads', [folder.name, criteria]);
                    for (const t of rows) {
                        unread += Number(t.unread) || 0;
                        total += Number(t.count) || 0;
                    }
                }
                catch (e) {
                    log(`listDirCounts(${JSON.stringify(folder.name)}) FAILED: ${e.message}`);
                    continue;
                }
                const entry = {name: folder.name, unread, total};
                out.push(entry);
                if (typeof onProgress === 'function') {
                    try {
                        onProgress(entry);
                    }
                    catch {
                        /* caller-provided callback must not break the sweep */
                    }
                }
            }
            log(`listDirCounts() -> ${out.length}/${folders.length} dirs (${Date.now() - t0}ms)`);
            // A per-folder search may have left a different mailbox selected
            // on the server than the facade's `selected` state claims.
            // Re-assert the open dir so listFiles/listThreads keep fetching
            // the folder the caller opened. Best-effort: without a selected
            // dir there is nothing to restore.
            if (selected) {
                try {
                    await this.openDir(selected);
                }
                catch (e) {
                    log(`listDirCounts(): restore openDir(${JSON.stringify(selected)}) FAILED: ${e.message}`);
                }
            }
            return out;
        },

        async createDir(name) {
            assertConnected();
            if (typeof name !== 'string' || !name.trim()) throw new Error('createDir: folder name required');
            if (typeof client.create_mailbox !== 'function') {
                throw new Error('createDir: mail core build does not support CREATE; rebuild rust-client with create_mailbox export');
            }
            const t0 = Date.now();
            try {
                await clientCall('create_mailbox', [name], {postCheck: false});
                log(`createDir(${JSON.stringify(name)}) (${Date.now() - t0}ms)`);
            } catch (e) {
                log(`createDir(${JSON.stringify(name)}) FAILED after ${Date.now() - t0}ms: ${e.message}`);
                throw e;
            }
        },

        async deleteDir(name) {
            assertConnected();
            if (typeof name !== 'string' || !name) throw new Error('deleteDir: folder name required');
            if (typeof client.delete_mailbox !== 'function') {
                throw new Error('deleteDir: mail core build does not support DELETE; rebuild rust-client with delete_mailbox export');
            }
            const t0 = Date.now();
            try {
                await clientCall('delete_mailbox', [name], {postCheck: false});
                if (selected === name) {
                    selected = null;
                    status = null;
                }
                log(`deleteDir(${JSON.stringify(name)}) (${Date.now() - t0}ms)`);
            } catch (e) {
                log(`deleteDir(${JSON.stringify(name)}) FAILED after ${Date.now() - t0}ms: ${e.message}`);
                throw e;
            }
        },

        async listFiles(opts) {
            assertConnected();
            if (!selected) throw new Error('openDir() first');
            const { page = 0, pageSize = 20, fromUid, toUid } = opts ?? {};
            let set;
            if (fromUid != null) {
                set = toUid != null ? `${fromUid}:${toUid}` : `${fromUid}`;
            } else {
                const newest = Number(status?.uidnext ?? 1) - 1;
                const end = newest - page * pageSize;
                if (end < 1) return [];
                const start = Math.max(1, end - pageSize + 1);
                set = `${start}:${end}`;
            }
            const t0 = Date.now();
            try {
                const rows = await clientCall('fetch_summaries', [set]);
                const out = rows
                    .map((m) => ({
                        uid: Number(m.uid),
                        flags: Array.isArray(m.flags) ? m.flags.map(String) : [],
                        subject: decodeMimeWords(m.subject ?? null),
                        from: decodeMimeWords(m.from ?? null),
                        date: m.date ?? null,
                        size: m.size ?? null,
                    }))
                    .sort((a, b) => b.uid - a.uid);
                log(`listFiles(${JSON.stringify(opts ?? {})} uid set ${set}) -> ${out.length} rows (${Date.now() - t0}ms)`);
                return out;
            } catch (e) {
                log(`listFiles(${JSON.stringify(opts ?? {})}) FAILED after ${Date.now() - t0}ms: ${e.message}`);
                throw e;
            }
        },

        async listThreads(opts) {
            assertConnected();
            if (!selected) throw new Error('openDir() first');
            if (typeof client.fetch_threads !== 'function') {
                throw new Error('listThreads: mail core build does not support threading; rebuild rust-client with fetch_threads export');
            }
            const t0 = Date.now();
            try {
                const rows = await clientCall('fetch_threads', [selected]);
                const out = rows.map(mapThread);
                log(`listThreads() -> ${out.length} threads (${Date.now() - t0}ms)`);
                return out;
            } catch (e) {
                log(`listThreads() FAILED after ${Date.now() - t0}ms: ${e.message}`);
                throw e;
            }
        },

        async search({dir, query, allFolders} = {}) {
            assertConnected();
            if (typeof client.search_threads !== 'function') {
                throw new Error('search: mail core build does not support search; rebuild rust-client with search_threads export');
            }
            const criteria = buildCriteria(query);
            if (!criteria) {
                return [];
            }
            const t0 = Date.now();
            try {
                if (!allFolders) {
                    const target = dir || selected;
                    if (!target) throw new Error('search: no dir given and none open');
                    const rows = await clientCall('search_threads', [target, criteria]);
                    const out = rows.map((t) => ({...mapThread(t), dir: target}));
                    log(`search(${JSON.stringify(criteria)} in ${JSON.stringify(target)}) -> ${out.length} threads (${Date.now() - t0}ms)`);
                    return out;
                }
                // all folders: sequentially through the wasm FIFO; skip
                // mailboxes that cannot hold messages
                const folders = (await this.listDirs()).filter(
                    (f) => !f.attrs.some((a) => String(a).toLowerCase() === '\\noselect')
                );
                const merged = [];
                for (const folder of folders) {
                    const rows = await clientCall('search_threads', [folder.name, criteria]);
                    for (const t of rows) {
                        merged.push({...mapThread(t), dir: folder.name});
                    }
                }
                merged.sort((a, b) => Number(b.date ? +new Date(b.date) : 0) - Number(a.date ? +new Date(a.date) : 0));
                log(`search(${JSON.stringify(criteria)} in all folders) -> ${merged.length} threads (${Date.now() - t0}ms)`);
                return merged;
            } catch (e) {
                log(`search(${JSON.stringify(query)}) FAILED after ${Date.now() - t0}ms: ${e.message}`);
                throw e;
            }
        },

        async readFile(uid) {
            assertConnected();
            if (!selected) throw new Error('openDir() first');
            const t0 = Date.now();
            const uidNum = Number(uid);
            try {
                const raw = await clientCall('fetch_message', [uidNum]);
                const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
                log(`readFile(${uid}) -> ${bytes.length} bytes (${Date.now() - t0}ms)`);
                return bytes;
            } catch (e) {
                log(`readFile(${uid}) FAILED after ${Date.now() - t0}ms: ${e.message}`);
                throw e;
            }
        },

        async setFlags(uids, addFlags, removeFlags) {
            assertConnected();
            if (!selected) throw new Error('openDir() first');
            const add = Array.isArray(addFlags) ? addFlags.map(String) : [];
            const remove = Array.isArray(removeFlags) ? removeFlags.map(String) : [];
            const set = (Array.isArray(uids) ? uids : []).map(Number).filter(Number.isFinite);
            if (!set.length || (!add.length && !remove.length)) return;
            if (typeof client.store_flags !== 'function') {
                throw new Error('setFlags: mail core build does not support STORE; rebuild rust-client with store_flags export');
            }
            const t0 = Date.now();
            try {
                await clientCall('store_flags', [set, add, remove], {postCheck: false});
                log(`setFlags(${set.length} uids +[${add}] -[${remove}]) (${Date.now() - t0}ms)`);
            } catch (e) {
                log(`setFlags(${set.length} uids +[${add}] -[${remove}]) FAILED after ${Date.now() - t0}ms: ${e.message}`);
                throw e;
            }
        },

        async moveTo(uids, mailbox) {
            assertConnected();
            if (!selected) throw new Error('openDir() first');
            if (typeof mailbox !== 'string' || !mailbox) throw new Error('moveTo: target mailbox required');
            const set = (Array.isArray(uids) ? uids : []).map(Number).filter(Number.isFinite);
            if (!set.length) return;
            if (typeof client.move_messages !== 'function') {
                throw new Error('moveTo: mail core build does not support MOVE; rebuild rust-client with move_messages export');
            }
            const t0 = Date.now();
            try {
                await clientCall('move_messages', [set, mailbox], {postCheck: false});
                log(`moveTo(${set.length} uids -> ${JSON.stringify(mailbox)}) (${Date.now() - t0}ms)`);
            } catch (e) {
                log(`moveTo(${set.length} uids -> ${JSON.stringify(mailbox)}) FAILED after ${Date.now() - t0}ms: ${e.message}`);
                throw e;
            }
        },

        async deleteMessages(uids) {
            assertConnected();
            if (!selected) throw new Error('openDir() first');
            const set = (Array.isArray(uids) ? uids : []).map(Number).filter(Number.isFinite);
            if (!set.length) return;
            if (typeof client.store_flags !== 'function') {
                throw new Error('deleteMessages: mail core build does not support STORE; rebuild rust-client with store_flags export');
            }
            const t0 = Date.now();
            try {
                await clientCall('store_flags', [set, ['\\Deleted'], []], {postCheck: false});
                // True "delete now" needs the optional expunge_messages export
                // (UID EXPUNGE, RFC 4315); cores without it keep the flag and
                // let the server purge on its next expunge.
                if (typeof client.expunge_messages === 'function') {
                    await clientCall('expunge_messages', [set], {postCheck: false});
                }
                else {
                    log(`deleteMessages(${set.length} uids): \\Deleted set; no expunge_messages export in this core build`);
                }
                log(`deleteMessages(${set.length} uids) (${Date.now() - t0}ms)`);
            } catch (e) {
                log(`deleteMessages(${set.length} uids) FAILED after ${Date.now() - t0}ms: ${e.message}`);
                throw e;
            }
        },

        async idle(opts) {
            assertConnected();
            if (!selected) throw new Error('openDir() first');
            const timeoutMs = Math.max(1000, opts?.timeoutMs ?? 20000);
            const t0 = Date.now();
            try {
                const res = await clientCall('idle_once', [selected, timeoutMs]);
                const out = res?.raw != null ? { type: res.type, raw: res.raw } : { type: res.type };
                log(`idle({timeoutMs:${timeoutMs}}) -> ${out.type} (${Date.now() - t0}ms)`);
                return out;
            } catch (e) {
                log(`idle({timeoutMs:${timeoutMs}}) FAILED after ${Date.now() - t0}ms: ${e.message}`);
                throw e;
            }
        },

        async close() {
            log('close: logging out');
            try {
                if (client) await clientCall('logout', [], {postCheck: false});
            } catch {
                /* server may have already closed */
            }
            client = null;
            selected = null;
            status = null;
            if (ws) {
                try {
                    ws.close();
                } catch {
                    /* ignore */
                }
                ws = null;
            }
            log('close: done');
        },

        selectedDir() {
            return selected;
        },
    };
}
