'use strict';

// mail.mjs — the MailApi provider for the client UI.
//
// With the local-first architecture there is exactly one data source: the
// OPFS mirror. The service worker's SyncEngine (core/sync/engine.mjs) owns
// every IMAP connection; this module hands out the page-side facade that
// reads the mirror and routes mutations to the engine.

import {getLocalApi, dropLocalApi, loadSyncSnapshot} from './local-api.mjs';

// Same contract and memoization as before; callers (dirs.mjs, list.mjs,
// jobs.mjs, preview.mjs) keep working unchanged.
export function getMailApi(accountId) {
  if (!accountId) {
    return Promise.reject(new Error('No account selected'));
  }
  return loadSyncSnapshot().then(() => getLocalApi(accountId));
}

export function dropMailApi(accountId) {
  dropLocalApi(accountId);
}
