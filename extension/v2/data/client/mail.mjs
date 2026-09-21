'use strict';

// mail.mjs — the MailApi provider for the client UI.
//
// There is exactly one data source: the Maildir tree on the granted
// directory handle (local-api.mjs). accountId is the account slug directory
// under the root; calls are memoized per account like the old engine-era
// provider.

import {getLocalApi, dropLocalApi} from './local-api.mjs';

// Same contract and memoization as before; callers (dirs.mjs, list.mjs,
// jobs.mjs, preview.mjs) keep working unchanged.
export function getMailApi(accountId) {
  if (!accountId) {
    return Promise.reject(new Error('No account selected'));
  }
  return getLocalApi(accountId);
}

export function dropMailApi(accountId) {
  dropLocalApi(accountId);
}
