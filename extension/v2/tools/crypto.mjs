// Password-based crypto helpers shared by the options page, the client and
// the service worker.
//
// Encrypted values stored in chrome.storage.local have the form
//   enc1.<b64(salt)>.<b64(iv)>.<b64(ciphertext)>
// (AES-GCM-256, per-value random 16 byte salt + 12 byte iv, key derived with
// PBKDF2-SHA256) so `enc1.` doubles as an "is encrypted" marker.
//
// The master password itself is never persisted at rest; chrome.storage.local
// only holds a verifier produced by hashMaster():
//   pb1.<iterations>.<b64(salt)>.<b64(hash)>
// The password lives in chrome.storage.session after it has been confirmed
// against that verifier once per browser session.

const ENC_PREFIX = 'enc1.';
const HASH_PREFIX = 'pb1.';
const ITERATIONS = 210000;
const SALT_BYTES = 16;
const IV_BYTES = 12;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// derived AES keys are expensive (PBKDF2), so cache them per master+salt
const keys = new Map();

const b64 = bytes => btoa(String.fromCharCode(...bytes));
const unb64 = str => Uint8Array.from(atob(str), c => c.charCodeAt(0));

async function deriveAesKey(master, salt) {
  const cacheKey = b64(salt) + '.' + master;
  if (keys.has(cacheKey)) {
    return keys.get(cacheKey);
  }
  const base = await crypto.subtle.importKey(
    'raw', encoder.encode(master), 'PBKDF2', false, ['deriveKey']
  );
  const key = await crypto.subtle.deriveKey(
    {name: 'PBKDF2', salt, iterations: ITERATIONS, hash: 'SHA-256'},
    base,
    {name: 'AES-GCM', length: 256},
    false,
    ['encrypt', 'decrypt']
  );
  if (keys.size > 100) {
    keys.clear();
  }
  keys.set(cacheKey, key);
  return key;
}

function isEncrypted(value) {
  if (typeof value !== 'string' || !value.startsWith(ENC_PREFIX)) {
    return false;
  }
  return value.split('.').length === 4;
}

async function encryptText(plain, master) {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await deriveAesKey(master, salt);
  const ct = await crypto.subtle.encrypt(
    {name: 'AES-GCM', iv},
    key,
    encoder.encode(plain)
  );
  return ENC_PREFIX + b64(salt) + '.' + b64(iv) + '.' + b64(new Uint8Array(ct));
}

async function decryptText(stored, master) {
  const parts = String(stored).split('.');
  if (parts.length !== 4 || parts[0] !== 'enc1') {
    throw new Error('malformed encrypted value');
  }
  const salt = unb64(parts[1]);
  const iv = unb64(parts[2]);
  const ct = unb64(parts[3]);
  const key = await deriveAesKey(master, salt);
  const plain = await crypto.subtle.decrypt({name: 'AES-GCM', iv}, key, ct);
  return decoder.decode(plain);
}

async function hashMaster(master) {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const base = await crypto.subtle.importKey(
    'raw', encoder.encode(master), 'PBKDF2', false, ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    {name: 'PBKDF2', salt, iterations: ITERATIONS, hash: 'SHA-256'},
    base,
    256
  );
  return HASH_PREFIX + ITERATIONS + '.' + b64(salt) + '.' + b64(new Uint8Array(bits));
}

async function verifyMaster(master, stored) {
  try {
    const parts = String(stored).split('.');
    if (parts.length !== 4 || parts[0] !== 'pb1') {
      return false;
    }
    const iterations = Number(parts[1]);
    if (!Number.isInteger(iterations) || iterations < 1) {
      return false;
    }
    const salt = unb64(parts[2]);
    const expected = unb64(parts[3]);
    const base = await crypto.subtle.importKey(
      'raw', encoder.encode(master), 'PBKDF2', false, ['deriveBits']
    );
    const bits = new Uint8Array(await crypto.subtle.deriveBits(
      {name: 'PBKDF2', salt, iterations, hash: 'SHA-256'},
      base,
      expected.length * 8
    ));
    let diff = bits.length ^ expected.length;
    for (let i = 0; i < bits.length && i < expected.length; i++) {
      diff |= bits[i] ^ expected[i];
    }
    return diff === 0;
  }
  catch {
    return false;
  }
}

export {
  ITERATIONS,
  isEncrypted,
  encryptText,
  decryptText,
  hashMaster,
  verifyMaster
};
