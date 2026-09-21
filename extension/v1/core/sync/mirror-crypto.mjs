'use strict';

// mirror-crypto.mjs — at-rest encryption for the local mail mirror.
//
// When a master password is configured (chrome.storage.local 'master.hash'
// verifier exists), every mirror file — indices, messages (.eml), bodies,
// outbox entries, account meta — is stored encrypted with a per-account AES
// key derived from the master password (PBKDF2-SHA256, 210k iterations) and
// a per-account random salt (kept in chrome.storage.local — worthless
// without the master). The confirmed master lives in session storage
// ('master.pass') and is available in both the worker and the client page,
// so both sides read/write transparently while it is confirmed.
//
// File envelope (UTF-8 text byte string):
//   MENC1.<b64(iv)>.<b64(ciphertext)>
// Plaintext legacy/transitional files simply lack the marker and pass
// through unchanged — reads tolerate mixed states.
//
// Without a confirmed master, decrypt encrypt'd content throws
// {code:'locked'} — nothing of the mirror is reachable in plain form.
// The master-change/removal triggers (engine-side) re-encrypt, wipe-only
// (master removed: decrypt to plaintext / or rebuild from the server).

const MAGIC = 'MENC1.';
const ITERATIONS = 210000;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const b64 = bytes => btoa(String.fromCharCode(...bytes));
const unb64 = str => Uint8Array.from(atob(str), c => c.charCodeAt(0));

const hasChrome =
  typeof chrome !== 'undefined' && chrome?.storage?.local?.get;

// ---- derived key (per account master+salt; cached per context) ------------

const keysByMasterSalt = new Map(); // 'master.saltB64' -> CryptoKey

async function deriveMasterKey(master, saltB64) {
  const cacheKey = String(master) + '|' + saltB64;
  const hit = keysByMasterSalt.get(cacheKey);
  if (hit) {
    return hit;
  }
  const base = await crypto.subtle.importKey(
    'raw', encoder.encode(String(master)), 'PBKDF2', false, ['deriveKey']
  );
  const key = await crypto.subtle.deriveKey(
    {name: 'PBKDF2', salt: unb64(saltB64), iterations: ITERATIONS, hash: 'SHA-256'},
    base,
    {name: 'AES-GCM', length: 256},
    false,
    ['encrypt', 'decrypt']
  );
  if (keysByMasterSalt.size > 50) {
    keysByMasterSalt.clear();
  }
  keysByMasterSalt.set(cacheKey, key);
  return key;
}

// ---- content encryption ---------------------------------------------------

export function looksEncrypted(bytes) {
  if (!bytes || bytes.length < MAGIC.length + 4) {
    return false;
  }
  return decoder.decode(bytes.slice(0, MAGIC.length)) === MAGIC;
}

export async function encryptWith(key, bytes) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({name: 'AES-GCM', iv}, key, bytes);
  const head = encoder.encode(MAGIC + b64(iv) + '.');
  const tail = encoder.encode(b64(new Uint8Array(ct)));
  const out = new Uint8Array(head.length + tail.length);
  out.set(head, 0);
  out.set(tail, head.length);
  return out;
}

export async function decryptWith(key, bytes) {
  const text = decoder.decode(bytes);
  const parts = text.split('.');
  if (parts.length !== 3 || parts[0] !== MAGIC.slice(0, -1)) {
    throw new Error('malformed encrypted mirror entry');
  }
  const iv = unb64(parts[1]);
  const ct = unb64(parts[2]);
  const plain = await crypto.subtle.decrypt({name: 'AES-GCM', iv}, key, ct);
  return new Uint8Array(plain);
}

// ---- per-account crypto state (storage bucket) ----------------------------

const bucketKey = accountId => 'mail.crypto.' + accountId;

export async function readCryptoState(accountId) {
  if (!hasChrome) {
    return null;
  }
  try {
    const res = await chrome.storage.local.get(bucketKey(accountId));
    const state = res?.[bucketKey(accountId)];
    if (state && typeof state === 'object' && typeof state.salt === 'string') {
      return {enabled: state.enabled !== false, salt: state.salt};
    }
  }
  catch {
    /* storage unreachable: treat as unmanaged (plain) */
  }
  return null;
}

export async function writeCryptoState(accountId, state) {
  if (!hasChrome) {
    return;
  }
  try {
    if (state) {
      await chrome.storage.local.set({[bucketKey(accountId)]: state});
    }
    else {
      await chrome.storage.local.remove(bucketKey(accountId));
    }
  }
  catch {
    /* best-effort */
  }
}

// The confirmed master of this browser session ('' when locked/absent).
export async function sessionMaster() {
  if (!hasChrome || !chrome?.storage?.session) {
    return null;
  }
  try {
    const {'master.pass': master} = await chrome.storage.session.get('master.pass');
    return master || null;
  }
  catch {
    return null;
  }
}

export function hasCryptoBucket(accountId) {
  return !!hasChrome;
}

// ---- juicy cover for the per-mirror usage -----------------------------------

// Attach per-account crypto state + encryption/decryption to a mirror.
//   enabled     — a salt exists and a master is configured (bucket state)
//   keyFor()    — cached CryptoKey, requires the confirmed session master;
//                 throws {code:'locked'} when it is absent
//   master()    — current confirmed session master ('' when none)
// Guarded in node tests: no chrome -> crypto stays disabled/plain.
export function attachMirrorCrypto(mirror, {accountId} = {}) {
  const bucket = accountId ?? mirror.accountId;
  let keyPromise = null;
  let cachedSalt = null;

  async function readState() {
    if (cachedSalt !== null) {
      return cachedSalt ? {enabled: true, salt: cachedSalt} : null;
    }
    const state = await readCryptoState(bucket);
    cachedSalt = state?.salt || '';
    return state;
  }

  const out = {
    // current session master ('' = locked or none configured)
    async master() {
      return await sessionMaster() ?? '';
    },

    // Whether mirror contents are (or should be) encrypted at rest.
    async enabled() {
      const state = await readState();
      return !!state?.enabled;
    },

    // Ensure the salt bucket exists (creates one on first encryption).
    async ensureSalt() {
      const state = await readState();
      if (state) {
        return state.salt;
      }
      const salt = b64(crypto.getRandomValues(new Uint8Array(16)));
      cachedSalt = salt;
      await writeCryptoState(bucket, {enabled: true, salt});
      return salt;
    },

    // CryptoKey for the confirmed master; 'locked' error without one.
    async keyFor(master = null) {
      const state = await readState();
      const salt = state?.salt;
      if (!salt) {
        return null; // never encrypted: nothing to derive
      }
      const active = master ?? (await sessionMaster());
      if (!active) {
        const err = new Error('mirror is locked — confirm the master password');
        err.code = 'locked';
        throw err;
      }
      if (!keyPromise) {
        keyPromise = deriveMasterKey(active, salt);
      }
      return keyPromise;
    },

    // Drop the cached key derivation (session master switched).
    reset() {
      keyPromise = null;
      cachedSalt = null;
    },

    looksEncrypted,

    async encrypt(bytes) {
      const key = await out.keyFor();
      if (!key) {
        return bytes; // no salt: mirror stays plain
      }
      return looksEncrypted(bytes) ? bytes : await encryptWith(key, bytes);
    },

    async decrypt(bytes) {
      if (!looksEncrypted(bytes)) {
        return bytes; // legacy/plaintext content passes through
      }
      const key = await out.keyFor();
      if (!key) {
        const err = new Error('mirror is locked — confirm the master password');
        err.code = 'locked';
        throw err;
      }
      try {
        return await decryptWith(key, bytes);
      }
      catch (e) {
        const err = new Error('mirror locked or key mismatch — confirm the master password');
        err.code = 'locked';
        throw err;
      }
    },

    async decryptOrThrow(bytes, fromKey = null) {
      if (!looksEncrypted(bytes)) {
        return bytes;
      }
      const key = fromKey ?? await out.keyFor();
      return decryptWith(key, bytes);
    },

    async keyWith(master, saltB64) {
      return deriveMasterKey(master, saltB64);
    },

    async clearKeyCache() {
      keyPromise = null;
      cachedSalt = null;
    },
  };
  return out;
}
