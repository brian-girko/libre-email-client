// data/sync/disk.mjs — the storage-root gate. The service worker cannot
// resolve the root handle, so this module is the real checkpoint (shared by
// the data/client gate): it decides between the extension's own browser
// storage ('opfs', the default — always granted, no permission flow) and the
// user-chosen external directory ('external' — the persisted IndexedDB
// handle), confirming the access is still in place and bouncing back to the
// picker when the external handle is gone or its permission was revoked.
// Actual read/write proof is the probe (data/sync/root-handle.mjs), which
// runs right before a handle is handed off — a page never trusts a bare
// queryPermission.

'use strict';

import {
  MODE_EXTERNAL,
  getStorageMode,
  opfsRoot,
  ownedRootHandle,
  clearRootHandle,
  verifyRoot
} from './root-handle.mjs';

function backToPicker() {
  location.replace(chrome.runtime.getURL('data/picker/index.html'));
}

// Offscreen-safe variant of boot(): same checks, no navigation (an
// offscreen document cannot redirect anywhere useful) — the caller gets a
// verdict instead and the client surfaces a link to the picker. The raw
// permission value ('granted'|'prompt'|'denied', or the trivial 'granted'
// verdict in opfs mode) rides along so the calling side can tell a real
// lapse from a context-quirk verdict.
export async function bootSilent() {
  try {
    if ((await getStorageMode()) !== MODE_EXTERNAL) {
      const handle = await opfsRoot();
      console.log('[sync] opfs root resolved (browser storage)');
      return {ok: true, raw: 'granted', reason: null, name: '(browser storage)', handle};
    }
    const {handle, name} = await ownedRootHandle();
    if (!handle || !(handle instanceof FileSystemDirectoryHandle)) {
      console.log('[sync] access check: no stored handle');
      return {ok: false, raw: null, reason: 'no-handle', name};
    }
    const raw = await handle.queryPermission({mode: 'readwrite'});
    console.log(`[sync] queryPermission → "${raw}" (name: ${name || '?'})`);
    return {
      ok: raw === 'granted',
      raw,
      reason: raw === 'granted' ? null : 'need-regrant',
      name,
      handle
    };
  }
  catch (e) {
    console.log('[sync] access check failed:', e?.message || e);
    return {ok: false, raw: null, reason: 'no-handle', error: e?.message || String(e)};
  }
}

export async function boot() {
  try {
    if ((await getStorageMode()) !== MODE_EXTERNAL) {
      const handle = await opfsRoot();
      await verifyRoot(handle);
      return handle;
    }
    const {handle, name} = await ownedRootHandle();
    if (!handle || !(handle instanceof FileSystemDirectoryHandle)) {
      await clearRootHandle();
      return backToPicker();
    }
    if ((await handle.queryPermission({mode: 'readwrite'})) !== 'granted') {
      console.log('[sync] access needs a re-grant for ' + (name || 'the directory'));
      return backToPicker();
    }
    console.log('[sync] access confirmed for ' + (name || 'the directory'));
    return handle;
  }
  catch (e) {
    console.log('[sync] access check failed — returning to the picker:', e?.message || e);
    return backToPicker();
  }
}
