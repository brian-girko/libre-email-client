// accounts.mjs — account registry for the sync page. Accounts live in
// chrome.storage.local, exactly the way the options page writes them:
//
//   accounts            → [{id, label, primary, order}, ...]  (metadata only)
//   imap.host.<id>      → string
//   imap.port.<id>      → number
//   imap.secure.<id>    → bool
//   imap.allowSelfSigned.<id> → bool
//   user.name.<id>      → string
//   user.pass.<id>      → plain string, or "enc1.<s>.<iv>.<ct>" when a
//                         master password is configured (master.hash exists)
//   sync.lastSyncAt.<id> → ISO stamp written by markSynced()
//
// No chrome.runtime messaging here — the page reads storage itself.
// Encrypted passwords are decrypted with the master password: taken from
// chrome.storage.session ('master.pass', cached there by whoever confirmed
// it before), or asked from the user through a <prompt-view> element and
// verified against the stored verifier once per page load (then cached).

'use strict';

import {
  isEncrypted,
  decryptText,
  verifyMaster
} from '/tools/crypto.mjs';

const MASTER_HASH = 'master.hash';
const MASTER_PASS = 'master.pass';
const LAST_SYNC_PREFIX = 'sync.lastSyncAt.';

// session-cached master for this page load; avoids re-prompting per account
let cachedMaster = null;

export function slugify({user, host, port} = {}) {
  if (!host) {
    throw new Error('account without host');
  }
  const u = String(user ?? '').replaceAll('.', '_');
  const h = String(host).replaceAll('.', '_');
  return `${u}_${h}_${port}`;
}

export function normalizeAccount(id, cfg) {
  return {id, ...cfg};
}

// Returns the master password for this browser session, asking for it (and
// checking it against the stored verifier) when it is not known yet. Returns
// null when there is no master password or the user did not confirm it.
async function ensureMaster(promptEl) {
  if (cachedMaster) {
    return cachedMaster;
  }
  const session = await chrome.storage.session.get(MASTER_PASS);
  if (session[MASTER_PASS]) {
    cachedMaster = session[MASTER_PASS];
    return cachedMaster;
  }
  if (!promptEl) {
    return null;
  }
  const verifier = (await chrome.storage.local.get(MASTER_HASH))[MASTER_HASH];
  if (!verifier) {
    return null;
  }
  for (let i = 0; i < 3; i++) {
    let master = null;
    try {
      master = await promptEl.ask(i ? 'Wrong master password, try again' : 'Enter your master password', {password: true});
    }
    catch {
      return null;
    }
    if (!master) {
      return null;
    }
    if (await verifyMaster(master, verifier)) {
      cachedMaster = master;
      await chrome.storage.session.set({[MASTER_PASS]: master});
      return master;
    }
  }
  return null;
}

// Decodes one stored user.pass.<id> value into the plain password. Throws a
// descriptive error when the value is encrypted and the master password is
// not available in this session.
async function resolvePassword(stored, promptEl, label) {
  if (typeof stored !== 'string' || !stored) {
    return '';
  }
  if (!isEncrypted(stored)) {
    return stored;
  }
  const master = await ensureMaster(promptEl);
  if (!master) {
    throw new Error(
      `password of "${label}" is encrypted and the master password was not confirmed`
    );
  }
  try {
    return await decryptText(stored, master);
  }
  catch {
    throw new Error(`password of "${label}" could not be decrypted`);
  }
}

/**
 * Decrypts one stored user.pass value just-in-time (asks for/verifies the
 * master password through `promptEl` when needed and caches it into
 * chrome.storage.session). Exported for the lazy path: the sync panel loads
 * account metadata without passwords and decrypts only the account actually
 * being synced.
 */
export async function decryptPassword(stored, promptEl, label) {
  return resolvePassword(stored, promptEl, label);
}

/**
 * Every configured account, as an array with the id stamped onto each entry.
 * By default the password is already decrypted when possible (prompting for
 * the master password through `promptEl` for encrypted ones); with
 * `{decrypt: false}` the stored values stay unread — `pass` is '' and
 * `encrypted` flags the entries whose password needs a
 * `decryptPassword()` just-in-time before use.
 * @param {Element} [promptEl] a <prompt-view> used to ask for the master
 *   password when a stored password is encrypted and not yet confirmed
 * @param {{decrypt?: boolean}} [opts]
 * @returns {Promise<Array<{id, name, host, port, secure, allowSelfSigned,
 *                          user, pass, encrypted, slug, lastSyncAt}>>}
 */
export async function loadAccounts(promptEl, {decrypt = true} = {}) {
  const storage = await chrome.storage.local.get(null);
  const list = Array.isArray(storage.accounts) ? storage.accounts : [];
  const accounts = [];
  for (const meta of list) {
    const {id} = meta;
    const read = name => storage[name + '.' + id];
    const label = meta.label || 'Unnamed account';
    const base = {
      name: label,
      host: read('imap.host') || '',
      port: Number(read('imap.port')) || 0,
      secure: !!read('imap.secure'),
      allowSelfSigned: !!read('imap.allowSelfSigned'),
      user: read('user.name') || '',
      pass: '',
      lastSyncAt: storage[LAST_SYNC_PREFIX + id] ?? null
    };
    if (!base.host || !base.port || !base.user) {
      continue; // half-configured account, never showed as syncable
    }
    base.encrypted = isEncrypted(read('user.pass'));
    if (decrypt) {
      base.pass = await resolvePassword(read('user.pass'), promptEl, label);
    }
    accounts.push(normalizeAccount(id, {...base, slug: slugify(base)}));
  }
  return accounts;
}

/**
 * Preference order: best host/user/port match first; null when empty.
 */
export function pickAccount(accounts, {host, port, user} = {}) {
  const score = (a) =>
    (a.host === host ? 4 : 0) +
    (a.user === (user ?? a.user) ? 2 : 0) +
    (a.port === (port ?? a.port) ? 1 : 0);
  const sorted = [...accounts].sort((a, b) => score(b) - score(a));
  return sorted[0] ?? null;
}

/**
 * Stamps lastSyncAt on one account in chrome.storage.local. The engine's
 * sync-synced broadcasts carry epoch-ms numbers ("one format everywhere"),
 * the stamp's documented shape is the ISO string — normalize here so every
 * reader (client status, badge tooltip) sees one format.
 */
export async function markSynced(id, lastSyncAt = new Date().toISOString()) {
  const ms = Number(lastSyncAt);
  const iso = Number.isFinite(ms) && ms > 0
    ? new Date(ms).toISOString()
    : (lastSyncAt && Date.parse(lastSyncAt)
      ? lastSyncAt
      : new Date().toISOString());
  await chrome.storage.local.set({
    [LAST_SYNC_PREFIX + id]: iso
  });
  return true;
}

/** clears a sync.lastSyncAt stamp (the discard path) */
export async function clearSynced(id) {
  await chrome.storage.local.remove(LAST_SYNC_PREFIX + id);
  return true;
}

/**
 * The stored gate preferences (the sync panel's dialog, flat
 * `sync-ui.purge` / `sync-ui.drop` keys): 'yes' | 'no', or null for
 * 'ask' / anything unset. The offscreen engine has no chrome.storage —
 * callers (worker, scheduler) carry these IN the job so a run with no
 * open panel answers its purge / dir-drop gates per the stored choice
 * instead of the hardcoded decline.
 * @returns {Promise<{purge: string|null, drop: string|null}>}
 */
export async function loadGatePrefs() {
  const stored = await chrome.storage.local
    .get(['sync-ui.purge', 'sync-ui.drop'])
    .catch(() => ({}));
  const one = key => ['yes', 'no'].includes(stored['sync-ui.' + key])
    ? stored['sync-ui.' + key]
    : null;
  return {purge: one('purge'), drop: one('drop')};
}
