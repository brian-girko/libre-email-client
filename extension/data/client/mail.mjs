import './components/prompt-view.js';
import {getPref} from './prefs.mjs';
import {createMailApi} from '../../core/rust-imap-client/api.mjs';
import {purgeMailCache} from '../../core/rust-imap-client/cache.mjs';
import {request as bridgeRequest, release as bridgeRelease} from '../../core/ws-to-tls/manager.js';
import {isEncrypted, decryptText, verifyMaster} from '../../crypto.mjs';

const apis = new Map();
const pending = new Map();
// Bumped whenever the caches are cleared so an API that was still being
// created in the background is dropped instead of being stored as live.
let apiGeneration = 0;

const fieldKey = (name, id) => name + '.' + id;
const MASTER_HASH = 'master.hash';
const MASTER_PASS = 'master.pass';

async function requestBridge() {
  const url = await bridgeRequest();
  if (!url) {
    throw new Error('WS bridge is not configured');
  }
  return url;
}

async function askPassword(account) {
  const el = document.getElementById('prompt');
  let pass = null;
  if (el) {
    try {
      pass = await el.ask('Password for ' + (account.label || account.id), {password: true});
    }
    catch {
      pass = null;
    }
  }
  if (!pass) {
    throw new Error('Password is required');
  }
  return pass;
}

// Returns the master password of this browser session, asking for it (and
// checking it against the verifier in local storage) when needed. Returns
// null when there is no master password configured or it was not confirmed;
// without a verifier the prompt can never succeed, so it is never shown.
async function masterPassword() {
  const [cached, res] = await Promise.all([
    chrome.storage.session.get(MASTER_PASS),
    chrome.storage.local.get(MASTER_HASH)
  ]);
  if (cached[MASTER_PASS]) {
    return cached[MASTER_PASS];
  }
  if (!res[MASTER_HASH]) {
    return null;
  }
  const el = document.getElementById('prompt');
  for (let i = 0; el && i < 3; i++) {
    let pass = null;
    try {
      pass = await el.ask(
        i ? 'Wrong master password, try again' : 'Master password to unlock saved passwords',
        {password: true}
      );
    }
    catch {
      return null;
    }
    if (!pass) {
      return null;
    }
    if (await verifyMaster(pass, res[MASTER_HASH])) {
      await chrome.storage.session.set({[MASTER_PASS]: pass});
      return pass;
    }
  }
  return null;
}

async function accountConfig(account) {
  const id = account.id;
  const names = ['imap.host', 'imap.port', 'imap.secure', 'imap.allowSelfSigned', 'user.name', 'user.pass'];
  const keys = names.map(name => fieldKey(name, id));
  const passKey = fieldKey('user.pass', id);
  const [stored, session] = await Promise.all([
    chrome.storage.local.get(keys),
    chrome.storage.session.get(passKey)
  ]);
  const host = stored[fieldKey('imap.host', id)];
  const port = Number(stored[fieldKey('imap.port', id)]);
  const user = stored[fieldKey('user.name', id)];
  if (!host || !port || !user) {
    const missing = [];
    if (!host) {
      missing.push('IMAP host (imap.host)');
    }
    if (!port) {
      missing.push('IMAP port (imap.port)');
    }
    if (!user) {
      missing.push('username (user.name)');
    }
    throw new Error('Account "' + (account.label || id) + '" is not fully configured; set ' + missing.join(' and ') + ' in the account options');
  }
  const storedPass = typeof stored[passKey] === 'string' ? stored[passKey] : '';
  // A plain password entered earlier this session wins: it is known to work
  // and avoids asking for the master password just to decrypt the stored
  // value. The master prompt is only reached when a stored password actually
  // needs decrypting; accounts without a stored password go straight to the
  // per-session account password prompt.
  let pass = session[passKey] || '';
  if (!pass && storedPass) {
    if (isEncrypted(storedPass)) {
      const master = await masterPassword();
      if (master) {
        try {
          pass = await decryptText(storedPass, master);
        }
        catch {
          pass = ''; // stale or corrupted stored value -> ask for the password
        }
      }
    }
    else {
      pass = storedPass;
    }
  }
  if (!pass) {
    pass = await askPassword(account);
    await chrome.storage.session.set({[passKey]: pass});
  }
  return {
    host,
    port,
    secure: stored[fieldKey('imap.secure', id)] !== false,
    allowSelfSigned: !!stored[fieldKey('imap.allowSelfSigned', id)],
    user,
    pass
  };
}

async function create(accountId) {
  const {accounts} = await chrome.storage.local.get('accounts');
  const account = Array.isArray(accounts) ? accounts.find(a => a.id === accountId) : null;
  if (!account) {
    throw new Error('Account not found');
  }
  const cfg = await accountConfig(account);
  const bridgeUrl = await requestBridge();
  const {'mail.debug': debug} = await chrome.storage.local.get({'mail.debug': false});
  const cachePolicy = await getPref('cachePolicy', 'epoch');

  const api = await createMailApi({
    bridgeUrl,
    wasmUrl: chrome.runtime.getURL('core/rust-imap-client/mail_core_bg.wasm'),
    ...cfg,
    accountId,
    cachePolicy,
    debug: !!debug
  });
  try {
    await api.connect();
  }
  catch (e) {
    try {
      await api.close();
    }
    catch {}
    throw e;
  }
  return api;
}

// A dropped IMAP session (servers log out after ~30 idle minutes) surfaces
// as a TLS/io error on the next call. The wrapper rebuilds the session
// under the callers' feet: reads retry once on any error, mutations only
// when the error looks like a connection loss so a failed move is never
// re-run after the fact.
const CONN_ERROR = /peer closed|close_notify|unexpected[ _-]?eof|transport[ _-]?clos|transport[ _-]?error|not connected|connection lost|ws connect failed|ws error|bridge:|io: /i;

function wrap(accountId, api) {
  let real = api;
  let selected = null;
  let reconnecting = null;

  const reconnect = async () => {
    try {
      await real.close();
    }
    catch {}
    try {
      await bridgeRelease();
    }
    catch {}
    real = await create(accountId);
    if (selected) {
      await real.openDir(selected);
    }
  };

  const reconnectOnce = () => {
    if (!reconnecting) {
      reconnecting = reconnect().finally(() => {
        reconnecting = null;
      });
    }
    return reconnecting;
  };

  const retried = async (run, mutates) => {
    try {
      return await run(real);
    }
    catch (e) {
      if (mutates && !CONN_ERROR.test(e?.message ?? String(e))) {
        throw e;
      }
      await reconnectOnce();
      return run(real);
    }
  };

  return {
    connect() {
      return real.connect();
    },
    listDirs() {
      return retried(api => api.listDirs(), false);
    },
    openDir(name) {
      return retried(async api => {
        const status = await api.openDir(name);
        selected = name;
        return status;
      }, false);
    },
    createDir(name) {
      return retried(api => api.createDir(name), true);
    },
    deleteDir(name) {
      return retried(async api => {
        // clear the reopen hint before the attempt: if the delete drops the
        // connection, a reconnect must not try to re-open a folder that may
        // already be gone (that would fail the reconnect itself)
        if (selected === name) {
          selected = null;
        }
        await api.deleteDir(name);
      }, true);
    },
    listFiles(opts) {
      return retried(api => api.listFiles(opts), false);
    },
    listThreads(opts) {
      return retried(api => api.listThreads(opts), false);
    },
    search(opts) {
      return retried(api => api.search(opts), false);
    },
    listDirCounts(onProgress) {
      return retried(api => api.listDirCounts(onProgress), false);
    },
    cacheBackend() {
      return real.cacheBackend();
    },
    clearCache() {
      return retried(api => api.clearCache(), true);
    },
    readFile(uid) {
      // a body that cannot be read (malformed message) is not fixable by a
      // reconnect — only retry on connection-shaped errors so the fail is
      // fast and isolated to this one email
      return retried(api => api.readFile(uid), true);
    },
    setFlags(uids, addFlags, removeFlags) {
      return retried(api => api.setFlags(uids, addFlags, removeFlags), true);
    },
    moveTo(uids, mailbox) {
      return retried(api => api.moveTo(uids, mailbox), true);
    },
    deleteMessages(uids) {
      return retried(api => api.deleteMessages(uids), true);
    },
    idle(opts) {
      return retried(api => api.idle(opts), false);
    },
    async close() {
      try {
        await real.close();
      }
      finally {
        selected = null;
      }
    },
    selectedDir() {
      return real.selectedDir();
    }
  };
}

async function getMailApi(accountId) {
  if (apis.has(accountId)) {
    return apis.get(accountId);
  }
  if (pending.has(accountId)) {
    return pending.get(accountId);
  }
  const generation = apiGeneration;
  const p = create(accountId).then(async api => {
    if (generation !== apiGeneration) {
      try {
        await api.close();
      }
      catch {}
      try {
        await bridgeRelease();
      }
      catch {}
      throw new Error('connection dropped (caches cleared)');
    }
    const client = wrap(accountId, api);
    apis.set(accountId, client);
    return client;
  });
  pending.set(accountId, p);
  const settle = () => {
    if (pending.get(accountId) === p) {
      pending.delete(accountId);
    }
  };
  p.then(settle, settle);
  return p;
}

async function dropMailApi(accountId) {
  const api = apis.get(accountId);
  apis.delete(accountId);
  if (!api) {
    return;
  }
  try {
    await api.close();
  }
  catch {}
  try {
    await bridgeRelease();
  }
  catch {}
}

// "Expire all caches": drop every live session and wipe the persistent mail
// cache (bodies, threads, dirs) for every account. The next interaction
// rebuilds sessions lazily and refetches everything from the server.
async function clearAllCaches() {
  apiGeneration++;
  const ids = [...apis.keys()];
  apis.clear();
  pending.clear();
  await Promise.allSettled(ids.map(id => dropMailApi(id)));
  await purgeMailCache();
}

// Reached from the service worker's "Clear All Caches" context menu.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== 'clear-all-caches') {
    return;
  }
  clearAllCaches()
    .then(() => sendResponse({ok: true}))
    .catch(e => sendResponse({ok: false, error: e?.message || String(e)}));
  return true; // keep the channel open for the async response
});

export {getMailApi, dropMailApi};
