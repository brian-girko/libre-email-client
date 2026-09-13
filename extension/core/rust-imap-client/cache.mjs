'use strict';

// cache.mjs — persistent cache for the wasm MailApi facade.
//
// Three tiers share one backend:
//   bodies  — raw RFC822 of one message; content is immutable for a given
//             (accountId, uidvalidity, uid), so entries never go stale; they
//             are only bounded (LRU) and (optionally) time-expired.
//   threads — ThreadSummary[] of one mailbox; keyed by uidnext so new mail
//             misses automatically, and explicitly evicted when a mutating
//             action (setFlags/moveTo) runs.
//   dirs    — Folder[] of one account; one entry per account, evicted on
//             createDir/deleteDir and time-expired per cache policy.
//
// Backend: the browser CacheStorage API when available (binary-friendly,
// survives popup close and browser restart, no extra permission needed);
// otherwise a plain in-memory Map (Node tests). Every cache operation is
// best-effort: failures are swallowed so email loading never depends on the
// cache working.

const CACHE_NAME = 'mail-cache-v1';
const MAX_BODIES = 200;
const MAX_THREADS = 100;

// TTLs per cache policy ('epoch' | 'short' | 'keys'):
//   epoch: bodies never expire (content-immutable), threads/dirs 1h backstop
//   short: everything 15 minutes
//   keys:  no time expiry at all
const TTL = {
  epoch: {bodies: Infinity, threads: 60 * 60 * 1000, dirs: 60 * 60 * 1000},
  short: {bodies: 15 * 60 * 1000, threads: 15 * 60 * 1000, dirs: 15 * 60 * 1000},
  keys: {bodies: Infinity, threads: Infinity, dirs: Infinity},
};

function ttlFor(policy, kind) {
  return (TTL[policy] || TTL.epoch)[kind];
}

// ---- backends ------------------------------------------------------------

class MemoryBackend {
  constructor() {
    this.map = new Map(); // key -> {body: Uint8Array, storedAt}
  }
  async match(key) {
    const hit = this.map.get(key);
    if (hit === undefined) {
      return null;
    }
    // refresh LRU position (Map iterates in insertion order)
    this.map.delete(key);
    this.map.set(key, hit);
    return hit.body.slice();
  }
  async put(key, body) {
    // delete first so a re-put moves the key to the end (most recent)
    this.map.delete(key);
    this.map.set(key, {body, storedAt: Date.now()});
  }
  async delete(key) {
    return this.map.delete(key);
  }
  async keys() {
    return [...this.map.keys()];
  }
  async matchMeta(key) {
    const hit = this.map.get(key);
    return hit ? {storedAt: hit.storedAt} : null;
  }
}

class BrowserBackend {
  constructor(cache) {
    this.cache = cache;
  }
  static async open() {
    if (typeof caches !== 'undefined' && typeof caches.open === 'function') {
      const cache = await caches.open(CACHE_NAME);
      return new BrowserBackend(cache);
    }
    return null;
  }
  async match(key) {
    const res = await this.cache.match(key);
    return res ? new Uint8Array(await res.arrayBuffer()) : null;
  }
  async put(key, body) {
    const res = new Response(body.slice().buffer, {
      headers: {'content-type': 'application/octet-stream', 'x-stored-at': String(Date.now())}
    });
    await this.cache.put(key, res);
  }
  async delete(key) {
    return this.cache.delete(key);
  }
  async keys() {
    return [...(await this.cache.keys())].map(r => r.url);
  }
  async matchMeta(key) {
    const res = await this.cache.match(key);
    if (!res) {
      return null;
    }
    const storedAt = Number(res.headers.get('x-stored-at')) || 0;
    return {storedAt};
  }
}

// ---- public facade --------------------------------------------------------

export class MailCache {
  constructor({policy = 'epoch', accountId = '', log = () => {}} = {}) {
    this.policy = TTL[policy] ? policy : 'epoch';
    this.accountId = String(accountId || '');
    this.log = log;
    this.backend = null;
    this.backendName = 'memory';
    this.ready = this._init();
  }

  async _init() {
    try {
      const browser = await BrowserBackend.open();
      this.backend = browser || new MemoryBackend();
      this.backendName = browser ? 'CacheStorage' : 'memory';
      this.log(`cache backend: ${this.backendName}`);
    }
    catch (e) {
      this.backend = new MemoryBackend();
      this.backendName = 'memory';
      this.log(`cache backend: memory (CacheStorage unavailable: ${e?.message || e})`);
    }
    this.sweep().catch(() => {});
    return this;
  }

  url(kind, ...parts) {
    // synthetic URL keys: kind/accountId/...parts — safe for CacheStorage
    return `https://mail-cache.local/${this.accountId}/${kind}/${parts.map(encodeURIComponent).join('/')}`;
  }

  async get(kind, keyParts) {
    try {
      await this.ready;
      const url = this.url(kind, ...keyParts);
      const meta = await this.backend.matchMeta(url);
      if (!meta) {
        return null;
      }
      if (this.expired(meta, kind)) {
        this.backend.delete(url).catch(() => {});
        return null;
      }
      const body = await this.backend.match(url);
      if (body) {
        await this.touch(url, body); // LRU refresh
      }
      return body;
    }
    catch {
      return null;
    }
  }

  async put(kind, keyParts, body) {
    try {
      await this.ready;
      const url = this.url(kind, ...keyParts);
      await this.backend.put(url, body);
      await this.sweep(kind);
    }
    catch {
      /* best-effort */
    }
  }

  // LRU refresh for the memory backend is handled by put() ordering; for
  // CacheStorage there is no cheap reordering, so "touch" is a no-op there.
  async touch(url, body) {
    if (this.backend instanceof MemoryBackend) {
      await this.backend.put(url, body);
    }
  }

  expired(meta, kind) {
    const ttl = ttlFor(this.policy, kind);
    if (ttl === Infinity) {
      return false;
    }
    return Date.now() - (meta?.storedAt || 0) > ttl;
  }

  // Delete all thread entries of one directory (mutating actions).
  async invalidateThreads(dir) {
    try {
      await this.ready;
      const prefix = this.url('threads', dir);
      for (const key of await this.backend.keys()) {
        if (key.startsWith(prefix)) {
          await this.backend.delete(key);
        }
      }
    }
    catch {
      /* best-effort */
    }
  }

  // Delete the cached directory list for this account.
  async invalidateDirs() {
    try {
      await this.ready;
      const prefix = this.url('dirs');
      for (const key of await this.backend.keys()) {
        if (key === prefix || key.startsWith(prefix + '/')) {
          await this.backend.delete(key);
        }
      }
    }
    catch {
      /* best-effort */
    }
  }

  async clear() {
    try {
      await this.ready;
      for (const key of await this.backend.keys()) {
        if (key.includes('/' + this.accountId + '/')) {
          await this.backend.delete(key);
        }
      }
    }
    catch {
      /* best-effort */
    }
  }

  // Lazy maintenance: drop expired entries and enforce the LRU cap of one
  // kind ('bodies' | 'threads' | 'dirs'; undefined = all). Runs after every
  // put and once at open.
  async sweep(kind) {
    try {
      await this.ready;
        const caps = {bodies: MAX_BODIES, threads: MAX_THREADS, dirs: 1};
        const kinds = kind ? [kind] : ['bodies', 'threads', 'dirs'];
      for (const kind of kinds) {
        const prefix = this.url(kind);
        const keys = (await this.backend.keys()).filter(k => k.startsWith(prefix));
        // oldest first (storedAt ascending) for both expiry and LRU eviction
        const metas = [];
        for (const key of keys) {
          const meta = await this.backend.matchMeta(key);
          metas.push({key, storedAt: meta?.storedAt || 0});
        }
        metas.sort((a, b) => a.storedAt - b.storedAt);
        const ttl = ttlFor(this.policy, kind);
        const now = Date.now();
        let live = 0;
        for (const m of metas) {
          const isExpired = ttl !== Infinity && now - m.storedAt > ttl;
          if (isExpired) {
            await this.backend.delete(m.key);
            continue;
          }
          live++;
        }
        let overflow = live - caps[kind];
        for (const m of metas) {
          if (overflow <= 0) {
            break;
          }
          await this.backend.delete(m.key);
          overflow--;
        }
      }
    }
    catch {
      /* best-effort */
    }
  }
}

export async function openMailCache(opts) {
  return new MailCache(opts);
}

// Drop every entry of this extension's mail cache regardless of account
// (used to expire all caches from outside the affected MailApi instances).
export async function purgeMailCache() {
  try {
    if (typeof caches !== 'undefined' && typeof caches.keys === 'function') {
      for (const name of await caches.keys()) {
        if (name === CACHE_NAME) {
          const cache = await caches.open(name);
          for (const req of await cache.keys()) {
            await cache.delete(req);
          }
        }
      }
    }
  }
  catch {
    /* best-effort */
  }
}
