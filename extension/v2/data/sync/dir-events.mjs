// dir-events.mjs — the writer-notification bridge between MaildirStore
// dir-level changes and cross-page listeners.
//
// The extension is the only writer of the granted directory during a sync
// run, so the WRITER is the change source: instead of the client polling
// the disk, every writer context that holds a MaildirStore attaches this
// broadcast — the store's onDirsChanged hook (maildir.mjs) fires at the
// moment a dir is created or removed ('account', 'created', 'removed',
// 'reset') and the event crosses pages over runtime messaging:
//
//   sync-dirs-update {accountId, slug, kind, folder}
//
// No dir listing travels: the client derives the view from its own reads
// (the tree reconciles in place; the open folder reads through the
// differential list cache). Fire-and-forget delivery, like the other sync
// broadcasts — no responder required, failures are swallowed (the next
// mid-run 'sync-refresh' re-converges everything anyway).
//
// Users: offscreen.mjs (every engine session's store) and the sync panel
// filter runs (they write stores from a page context). The mail client
// leaves mirrorsChanged as its own-edit path — its store needs no bridge.

'use strict';

/**
 * Installs the listener notification on a MaildirStore.
 * @param {MaildirStore} store this writer's store
 * @param {{accountId?: string|null, slug?: string|null}} scope identity
 *   the receiving pages bind against (account id and directory slug)
 * @returns {MaildirStore} the same store, for call-site brevity
 */
export function attachDirsBroadcast(store, {accountId = null, slug = null} = {}) {
  store.onDirsChanged = (kind, folder) => {
    try {
      chrome.runtime.sendMessage({
        type: 'sync-dirs-update',
        accountId: accountId ?? null,
        slug: slug ?? null,
        kind: kind || 'created',
        folder: folder ?? null
      }).catch(() => {});
    }
    catch {}
  };
  return store;
}
