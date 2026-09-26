// client.mjs — top-level IMAP facade for the sync engine. Only this file in
// the whole extension knows what lives in core/: it connects the wasm MailApi
// to the ws->tls bridge endpoint and exposes small account-level operations
// (folders, listings, reads, flags, deletes, moves, search). Everything
// above — the offlineimap-style sync engine, UI code — imports only this
// file and never reaches into core/.
//
// No connectNative lives here: the bridge is booted by the service worker
// (core/bridge.mjs, refcounted) and handed over as a ready url — the
// offscreen engine passes it in with every run.
//
// Every await this facade makes rides a hard ceiling (SYNC_CMD_TIMEOUT_MS,
// default 2 min, 0 disables): a wedged bridge stream never resolves and
// jams the wasm FIFO for the whole stack, so an uncapped call/connect would
// hang the caller's session — and the sync queue with it — forever. The
// ceiling turns the hang into error text the sync engine recognizes
// ("timed out after …") and aborts on; the teardown close is capped at
// 10 s so a jammed stack can never hold the session's finally.
//
// Usage:
//   const bridgeUrl = await chrome.runtime.sendMessage({type:'sync-bridge-ensure'});
//   const mail = createClient({host, port, secure, user, pass, bridgeUrl});
//   await mail.connect();          // optional: first call bootstraps anyway
//   mail.info();                   // connection/folder snapshot
//   const dirs = await mail.folders();
//   await mail.readDir('INBOX');   // select(s) the dir
//   const rows = await mail.listMails({page: 0, pageSize: 20});
//   const raw  = await mail.readMail(uid);
//   await mail.seeMail(uid);       // \\Seen
//   await mail.deleteMail(uid);    // STORE +\\Deleted and purge
//   await mail.moveMail(uid, 'Archive');
//   await mail.close();

'use strict';

import {createMailApi} from '/core/rust-imap-client/api.mjs';

const WASM_URL = '/core/rust-imap-client/mail_core_bg.wasm';

export function createClient(settings) {
  const cfg = {
    secure: true,
    ...settings
  };

  // The live stack {bridge, api} — or null. Any command on a null pipe
  // rebuilds it; any failure tears it down so the next command starts clean.
  let pipe = null;
  let selected = null;
  let status = null;
  let shuttingDown = false;

  const base = () => `mail ${cfg.user}@${cfg.host}:${cfg.port}${cfg.secure ? ' (TLS)' : ' (plaintext)'}`;

  const say = msg => {
    console.log(`/topapi/ [client] ${msg}`);
  };

  const fail = (what, e) => {
    console.log(`/topapi/ [client] ${what} FAILED: ${e?.stack || e}`);
  };

  /**
   * Hard ceiling for one facade await — boot and every framed command. A
   * wedged bridge stream never resolves (and jams the wasm FIFO behind
   * it), so the cap converts a permanent hang into error text the sync
   * engine aborts on ("timed out after …"). SYNC_CMD_TIMEOUT_MS overrides
   * the default; 0 disables the call and close caps both.
   */
  const CEILING = Math.max(0,
    Number(globalThis.process?.env?.SYNC_CMD_TIMEOUT_MS) || 2 * 60 * 1000);
  const CLOSE_CAP = CEILING ? Math.min(10 * 1000, CEILING) : 0;

  function withCeiling(label, promise, ms = CEILING) {
    if (!ms || ms <= 0) {
      return promise;
    }
    let timer;
    const cap = new Promise((_, reject) => {
      timer = setTimeout(() =>
        reject(new Error(`${label} timed out after ${ms / 1000}s`)),
      ms);
    });
    return Promise.race([promise, cap]).finally(() => clearTimeout(timer));
  }

  /**
   * Boot sequence for one stack: wasm, MailApi, login — over the bridge
   * endpoint given in settings (there is no connectNative here; the
   * service worker boots and keeps the bridge alive for the run).
   * @param {{bridge: null, api: null}} ts stack under construction
   */
  async function buildStack(ts) {
    if (!cfg.bridgeUrl) {
      throw new Error('createClient: settings.bridgeUrl is required — ask the service worker for one ({type:"sync-bridge-ensure"}) before booting');
    }
    say('connecting ' + base() + ' via ' + cfg.bridgeUrl);
    const res = await fetch(chrome.runtime.getURL(WASM_URL));
    if (!res.ok) {
      throw new Error(`failed to load ${WASM_URL}: ${res.status}`);
    }
    const wasmBytes = new Uint8Array(await res.arrayBuffer());
    ts.api = await createMailApi({
      bridgeUrl: cfg.bridgeUrl,
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
      allowSelfSigned: cfg.allowSelfSigned,
      user: cfg.user,
      pass: cfg.pass,
      wasmBytes,
      debug: msg => console.log(`/topapi/ [rust-client] ${msg}`)
    });
    await ts.api.connect();
    say(`connect: OK (${base()})`);
  }

  // Tears the whole stack down (MailApi first, then the sandbox bridge);
  // only acts when ts is still the live stack. api.close() rides the close
  // cap: after a wedge the wasm FIFO is jammed for good (a hung close
  // would hold the session's finally forever), so the close is abandoned
  // after 10 s — the bridge is ALWAYS detached either way.
  async function bringDown(ts) {
    if (pipe !== ts) {
      return;
    }
    pipe = null;
    selected = null;
    status = null;
    const {api, bridge} = ts;
    if (api) {
      try {
        await withCeiling('close', api.close(), CLOSE_CAP);
      }
      catch (e) {
        // the close cap elapsed (jammed FIFO) or the server was already
        // gone — teardown carries on either way
        say(`close: ${e?.message || e}`);
      }
    }
    if (bridge) {
      try {
        bridge.detach();
      }
      catch {}
    }
  }

  // Runs fn against the live MailApi. First failure on a healthy stack is
  // retried exactly once after a rebuild: a restarted server, or a bridge the
  // sandbox dropped, must degrade into a slow page load, not an error.
  // The build (wasm session + login — the IMAP dial) and the call itself
  // both ride the call ceiling, so a dead network or a wedged stream
  // settles instead of hanging the session.
  async function run(fn) {
    for (let attempt = 0; ; attempt++) {
      if (!pipe) {
        if (shuttingDown) {
          throw new Error('client is shutting down');
        }
        const ts = {bridge: null, api: null};
        pipe = ts;
        try {
          await withCeiling('connect', buildStack(ts));
        }
        catch (e) {
          pipe = null;
          fail('boot', e);
          if (attempt > 0) {
            throw e;
          }
          continue;
        }
      }
      const ts = pipe;
      try {
        return await withCeiling('call', fn(ts.api));
      }
      catch (e) {
        say(`request failed${attempt === 0 ? '; rebuilding once' : ''}: ${e?.message || e}`);
        await bringDown(ts).catch(() => {});
        if (attempt > 0 || shuttingDown) {
          throw e;
        }
      }
    }
  }

  async function needOpenDir(name) {
    if (selected === name) {
      return status;
    }
    const st = await run(api => api.openDir(name));
    selected = name;
    status = st;
    return st;
  }

  return {
    /** boots bridge+wasm+session if needed; idempotent */
    connect() {
      return run(() => {});
    },

    /** connection snapshot: account, folders, open dir and its status */
    async info() {
      const dirs = (await run(api => api.listDirs())).map(d => d.name);
      return {
        account: `${cfg.user}@${cfg.host}`,
        secure: cfg.secure,
        connected: true,
        selected,
        dirs,
        status: selected
          ? {exists: status?.exists, uidvalidity: status?.uidvalidity, uidnext: status?.uidnext}
          : null
      };
    },

    /** every mailbox ({name, delimiter, attrs}) */
    async folders() {
      return run(api => api.listDirs());
    },

    /** selects a folder (SELECT) for the listing/reading calls below */
    async readDir(name) {
      if (!name || typeof name !== 'string') {
        throw new Error('readDir: folder name required');
      }
      const st = await run(api => api.openDir(name));
      selected = name;
      status = st;
      return {folder: name, exists: st.exists, uidvalidity: st.uidvalidity, uidnext: st.uidnext};
    },

    /**
     * Summaries of the selected dir, newest first.
     * @param {{page?: number, pageSize?: number, fromUid?: number, toUid?: number}} [opts]
     */
    async listMails(opts = {}) {
      if (!selected) {
        throw new Error('readDir(name) first');
      }
      const rows = await run(api => api.listFiles(opts ?? {}));
      return rows.map(m => ({
        uid: Number(m.uid),
        folder: selected,
        flags: m.flags ?? [],
        subject: m.subject,
        from: m.from,
        date: m.date ?? null,
        size: m.size ?? null
      }));
    },

    /** grouped conversations of the selected dir (JWZ), newest thread first */
    async listThreads() {
      if (!selected) {
        throw new Error('readDir(name) first');
      }
      return run(api => api.listThreads());
    },

    /**
     * Raw RFC822 bytes of one message, fetched on demand (offlineimap input)
     */
    async readMail(uid) {
      if (!selected) {
        throw new Error('readDir(name) first');
      }
      const raw = await run(api => api.readFile(Number(uid)));
      const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
      return {uid: Number(uid), folder: selected, size: bytes.length, raw: bytes};
    },

    /**
     * Batched pulls: several uids of the open dir through a bounded worker
     * pool — `concurrency` lanes each stream readMail(uid) sequentially, so
     * one message's network latency overlaps the next lane's fetch instead
     * of a strictly serial round-trip-per-message. Results (and failures)
     * come back in input order; each individual fetch keeps the normal
     * rebuild-once retry of readMail(). Throws the first per-message error
     * after all lanes settle — callers wanting partial results retry the
     * survivors via readMail().
     * @param {number[]} uids
     * @param {{concurrency?: number}} [opts]
     * @returns {Promise<Array<{uid:number, folder:string, size:number, raw:Uint8Array}>>}
     */
    async readMails(uids, {concurrency = 8} = {}) {
      const list = [...uids].map(Number).filter(Number.isFinite);
      if (!selected) {
        throw new Error('readDir(name) first');
      }
      if (!list.length) {
        return [];
      }
      const lanes = Math.max(1, Math.min(Math.floor(concurrency) || 1, list.length));
      const byUid = new Map();
      let errs = null;
      let cursor = 0;
      const worker = async () => {
        while (cursor < list.length) {
          const uid = list[cursor++];
          try {
            byUid.set(uid, await this.readMail(uid));
          }
          catch (e) {
            errs ??= [];
            errs.push(e);
          }
        }
      };
      await Promise.all(Array.from({length: lanes}, worker));
      const out = list.map(uid => byUid.get(uid)).filter(Boolean);
      if (!out.length && errs) {
        throw errs[0];
      }
      return out;
    },

    /** APPEND of raw RFC822 bytes into one mailbox (local .eml uplink) */
    async uploadMail(mailbox, raw, flags = []) {
      if (!mailbox || typeof mailbox !== 'string') {
        throw new Error('uploadMail: mailbox name required');
      }
      const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
      return run(async api => {
        if (typeof api.appendMail !== 'function') {
          throw new Error('uploadMail: core MailApi build has no appendMail; wire the append_message passthrough into core/rust-imap-client/api.mjs');
        }
        const opts = {content: bytes};
        const fl = [...(flags ?? [])];
        if (fl.length) {
          opts.flags = fl;
        }
        await api.appendMail(mailbox, opts);
      });
    },

    /** UID STORE add/remove flags on the selected dir */
    async markMail(uids, addFlags = [], removeFlags = []) {
      const list = Array.isArray(uids) ? uids : [uids];
      await run(api => api.setFlags(list, addFlags, removeFlags));
    },

    /** mark one message as seen (read) */
    async seeMail(uid) {
      await this.markMail(uid, ['\\Seen']);
    },

    /** marks \\Deleted and purges from the server (deleteMessages runs expunge when available) */
    async deleteMail(uids) {
      const list = Array.isArray(uids) ? uids : [uids];
      await run(api => api.deleteMessages(list));
    },

    /** MOVE of uids into another mailbox (trash/archive) */
    async moveMail(uids, mailbox) {
      const list = Array.isArray(uids) ? uids : [uids];
      await run(api => api.moveTo(list, mailbox));
    },

    /** CREATE of one mailbox on the server (locally-born dirs) */
    async createDir(name) {
      if (!name || typeof name !== 'string') {
        throw new Error('createDir: folder name required');
      }
      await run(async api => {
        if (typeof api.createDir !== 'function') {
          throw new Error('createDir: core MailApi build has no createDir; wire a create passthrough next to the other mutation wrappers in core/rust-imap-client/api.mjs');
        }
        await api.createDir(name);
      });
    },

    /** DELETE of one mailbox from the server (empty-dir mirror deletions) */
    async deleteDir(name) {
      if (!name || typeof name !== 'string') {
        throw new Error('deleteDir: folder name required');
      }
      await run(async api => {
        if (typeof api.deleteDir !== 'function') {
          throw new Error('deleteDir: core MailApi build has no deleteDir; wire a delete passthrough next to the other mutation wrappers in core/rust-imap-client/api.mjs');
        }
        await api.deleteDir(name);
      });
    },

    /** IMAP search rendered as conversations (ThreadSummary[] with dir tags) */
    async search(query, {dir, allFolders} = {}) {
      return run(api => api.search({dir, query, allFolders}));
    },

    /** unread/total sweep across folders; after it the open dir is restored */
    async folderCounts(onProgress) {
      const keep = selected;
      const out = await run(api => api.listDirCounts(onProgress));
      if (keep) {
        await needOpenDir(keep);
      }
      return out;
    },

    /** LOGOUT on the server, then tears the bridge down. This client is spent. */
    async close() {
      say('close: logging out and dropping the bridge');
      shuttingDown = true;
      try {
        if (pipe) {
          await bringDown(pipe);
        }
      }
      finally {
        shuttingDown = false;
        pipe = null;
      }
    },

    /** the currently SELECTed dir or null */
    currentDir() {
      return selected;
    }
  };
}
