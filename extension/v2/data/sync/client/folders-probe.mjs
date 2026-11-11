'use strict';

// folders-probe.mjs — one-shot server folder list for pages that configure
// an account's ignore list BEFORE any sync exists: the welcome wizard's
// step 4 and the options page's "Edit ignored folders" editor. The offscreen
// engine is deliberately NOT involved — the IMAP facade
// (data/sync/offscreen/client.mjs) is importable from any extension page
// (its own README quick start shows the page-side bridge round-trip), so a
// probe is a plain page-local session: bridge acquire, createClient,
// folders(), close, release. The offscreen document works exactly like
// before and never hears about probes.
//
// The bridge ref uses its OWN key ('folders-probe') — bridge refs are a Set
// of keys, so a probe can never collide with (or release) a sync run's
// 'sync' ref. External mode answers the url directly and the release is a
// harmless no-op. Nothing here reads or writes storage; the caller owns
// both the account fields and the ignore list.
//
// The derived hierarchy delimiter is broadcast like a run's summary would
// be (sync-delimiter → sync.delimiter.<id>): a pre-sync probe stamps the
// account early, so the very first sync already seeds its MaildirStore
// with the server's spelling.

import {createClient} from '../offscreen/client.mjs';

const REF_KEY = 'folders-probe';
const CAP_MS = 60 * 1000;

/** one capped await: a wedged bridge stream must fail the probe, not hang it */
function capped(promise, label, cap = CAP_MS) {
  let timer;
  const capPromise = new Promise((_, reject) => {
    timer = setTimeout(() =>
      reject(new Error(`${label} timed out after ${Math.round(cap / 1000)}s`)),
    cap);
  });
  return Promise.race([promise, capPromise]).finally(() => clearTimeout(timer));
}

/**
 * Lists the server's mailboxes for the given connection fields.
 * @param {object} account {host, port, secure, allowSelfSigned, user, pass,
 *   [id]} — plain form values; `id` (when present) only receives the
 *   early sync-delimiter stamp.
 * @returns {Promise<{ok: true, folders: Array<{name, delimiter, attrs}>,
 *   delimiter: string|null} | {ok: false, error: string}>} — never throws
 */
export async function fetchFolders(account) {
  if (!account || typeof account !== 'object' ||
      !account.host || !account.user || !account.pass) {
    return {ok: false, error: 'an account with host, user and pass is required'};
  }
  let bridge = null;
  let mail = null;
  try {
    bridge = await capped(
      chrome.runtime.sendMessage({type: 'bridge-acquire', key: REF_KEY}),
      'acquiring the bridge', 30 * 1000);
    if (!bridge?.ok || !bridge.url) {
      return {ok: false, error: bridge?.error ||
        'no ws->tls bridge available (check the welcome wizard / options page)'};
    }
    mail = createClient({
      host: account.host,
      port: account.port,
      secure: account.secure,
      allowSelfSigned: account.allowSelfSigned,
      user: account.user,
      pass: account.pass,
      bridgeUrl: bridge.url
    });
    const folders = (await capped(mail.folders(), 'listing the folders'))
      .map(f => ({
        name: String(f?.name ?? ''),
        delimiter: f?.delimiter || '/',
        attrs: Array.isArray(f?.attrs) ? f.attrs : []
      }))
      .filter(f => f.name);
    // the account's hierarchy delimiter: INBOX's when present, else the
    // first folder's — the same rule the sync engine applies
    const inbox = folders.find(f => f.name.toUpperCase() === 'INBOX');
    const delimiter =
      (inbox ?? folders.find(f => f.delimiter))?.delimiter ?? null;
    if (account.id && delimiter) {
      chrome.runtime.sendMessage({
        type: 'sync-delimiter',
        accountId: account.id,
        delimiter
      }).catch(() => {});
    }
    return {ok: true, folders, delimiter};
  }
  catch (e) {
    return {ok: false, error: e?.message || String(e)};
  }
  finally {
    if (mail) {
      try {
        // the facade caps its own teardown close (10 s) — a plain await
        // cannot hang past that
        await mail.close();
      }
      catch {}
    }
    if (bridge?.ok) {
      chrome.runtime.sendMessage({type: 'bridge-release', key: REF_KEY})
        .catch(() => {});
    }
  }
}
