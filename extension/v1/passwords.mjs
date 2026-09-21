// Shared re-encryption of saved account passwords, used by the options page
// (awaited, so "Saved" reflects the completed work) and by the service
// worker's chrome.storage.onChanged listener (safety net for changes made
// outside the options page). Running both at the same time is safe: a value
// that already decrypts with the new master is left untouched.

import {isEncrypted, decryptText, encryptText} from './crypto.mjs';

const PASS_PREFIX = 'user.pass.';

async function reencryptStoredPasswords(oldMaster, newMaster) {
  const all = await chrome.storage.local.get(null);
  const writes = {};
  for (const [key, value] of Object.entries(all)) {
    if (!key.startsWith(PASS_PREFIX) || typeof value !== 'string' || !value) {
      continue;
    }
    let plain = null;
    if (isEncrypted(value)) {
      if (newMaster) {
        try {
          await decryptText(value, newMaster);
          continue; // already encrypted with the target master
        }
        catch {}
      }
      if (!oldMaster) {
        console.warn('[master] no key to decrypt ' + key + ', leaving it as is');
        continue;
      }
      try {
        plain = await decryptText(value, oldMaster);
      }
      catch (e) {
        console.warn('[master] cannot decrypt ' + key + ', leaving it as is', e);
        continue;
      }
    }
    else {
      plain = value;
    }
    const next = newMaster ? await encryptText(plain, newMaster) : plain;
    if (next !== value) {
      writes[key] = next;
    }
  }
  if (Object.keys(writes).length) {
    await chrome.storage.local.set(writes);
  }
}

export {reencryptStoredPasswords};
