'use strict';

// Shared credential resolution for background IMAP work (badge, filters).
// The worker cannot prompt for passwords: an account is usable only when its
// password is available in plain form — a session value ("user.pass.<id>")
// typed earlier this session, a stored plain value, or a stored value
// encrypted with a master password that has been confirmed this session
// ("master.pass" in session storage).

import {isEncrypted, decryptText} from '../crypto.mjs';

const MASTER_PASS = 'master.pass';

const fieldKey = (name, id) => name + '.' + id;

// True when a password is stored for the account but only in encrypted form
// and the master password has not been confirmed this session (resolvePassword
// will return null): background work needs the master to be unlocked first.
export async function needsMasterPassword(id) {
  const passKey = fieldKey('user.pass', id);
  const [local, session] = await Promise.all([
    chrome.storage.local.get(passKey),
    chrome.storage.session.get(passKey)
  ]);
  if (session[passKey]) {
    return false; // plain session value: nothing to unlock
  }
  const stored = local[passKey];
  return typeof stored === 'string' && !!stored && isEncrypted(stored);
}

// The stored password for an account, or null when none can be resolved
// without prompting.
export async function resolvePassword(id) {
  const passKey = fieldKey('user.pass', id);
  const [local, session] = await Promise.all([
    chrome.storage.local.get(passKey),
    chrome.storage.session.get(passKey)
  ]);
  if (session[passKey]) {
    return session[passKey];
  }
  const stored = local[passKey];
  if (typeof stored !== 'string' || !stored) {
    return null;
  }
  if (!isEncrypted(stored)) {
    return stored;
  }
  const {[MASTER_PASS]: master} = await chrome.storage.session.get(MASTER_PASS);
  if (!master) {
    return null;
  }
  try {
    return await decryptText(stored, master);
  }
  catch {
    return null;
  }
}