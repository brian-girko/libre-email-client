/* global runtime */
'use strict';

const args = new URLSearchParams(location.search);

// Why the worker opened this page (icon click with setup incomplete):
// 'no-account' — no account configured yet; 'no-native' — connection runs
// over the local native client and it is not usable. Drives the jump below
// to the first step that needs the user's attention.
const reason = args.get('reason') || '';
document.body.dataset.reason = reason;

// OS detection
let os = 'windows';
if (/Mac/i.test(navigator.platform)) {
  os = 'mac';
}
else if (/Linux/i.test(navigator.platform)) {
  os = 'linux';
}
document.body.dataset.os = (os === 'mac' || os === 'linux') ? 'linux' : 'windows';

if (['Lin', 'Win', 'Mac'].includes(navigator.platform.substr(0, 3)) === false) {
  alert('Sorry! The "native client" only supports the following operating systems at the moment:\n\nWindows, Mac, and Linux');
}

// Disable BunJS on unsupported platforms
if (os === 'windows') {
  document.querySelector('option[value="org.webextension.bun"]').disabled = true;
}

// Step navigation
async function showStep(step) {
  document.body.dataset.step = step;
  document.querySelectorAll('.step').forEach(s => s.hidden = true);
  document.getElementById('step-' + step).hidden = false;

  // Update progress dots
  const dots = document.querySelectorAll('.dot');
  dots.forEach((d, i) => d.classList.toggle('active', i < step));

  // On step 2b (local native), auto-check native client
  if (step === '2b') {
    checkNativeOnEntry();
  }

  // On step 3, pre-fill form from existing account
  if (String(step) === '3') {
    await prefillAccount();
    await checkMasterStatus();
  }
}

// The account the form is currently editing (null when the form starts empty)
let editingId = null;

// Mode selection
document.querySelectorAll('.card').forEach(card => {
  card.addEventListener('click', () => {
    document.body.dataset.mode = card.dataset.mode;
    showStep(card.dataset.mode === 'remote' ? '2a' : '2b');
  });
});

// Describes what will happen to the password on save, based on whether a
// master password is configured and whether the stored one is encrypted.
async function setPassNote(storedPass) {
  const noteEl = document.getElementById('pass-note');
  const {isEncrypted} = await import('/tools/crypto.mjs');
  const encrypted = !!storedPass && isEncrypted(storedPass);

  if (await readMasterHash()) {
    noteEl.textContent = encrypted
      ? 'Password is stored encrypted with your master password. Leave empty to keep it, or type a new one — it is stored encrypted too.'
      : 'The password will be stored encrypted with your master password.';
  }
  else {
    noteEl.textContent = encrypted
      ? 'Password is stored encrypted. Leave empty to keep the current password.'
      : 'Without a master password the password is stored as plain text.';
  }
}

// Pre-fill account form from existing primary account
async function prefillAccount() {
  try {
    const {accounts} = await chrome.storage.local.get({accounts: []});
    const list = Array.isArray(accounts) ? accounts : [];
    const primary = list.find(a => a.primary) || list[0];

    if (!primary) {
      editingId = null;
      await setPassNote('');
      return;
    }

    editingId = primary.id;
    const res = await chrome.storage.local.get([
      'imap.host.' + primary.id,
      'imap.port.' + primary.id,
      'imap.secure.' + primary.id,
      'imap.allowSelfSigned.' + primary.id,
      'user.name.' + primary.id,
      'user.pass.' + primary.id
    ]);

    document.getElementById('f-label').value = primary.label || '';
    document.getElementById('f-host').value = res['imap.host.' + primary.id] || '';
    document.getElementById('f-port').value = res['imap.port.' + primary.id] || '';

    // Same fallback as the options page: an account whose TLS flag was never
    // stored keeps the checkbox default (TLS on) instead of showing unchecked.
    const secureEl = document.getElementById('f-secure');
    const selfSignedEl = document.getElementById('f-allow-self-signed');
    secureEl.checked = res['imap.secure.' + primary.id] === undefined
      ? secureEl.defaultChecked
      : !!res['imap.secure.' + primary.id];
    selfSignedEl.checked = !!res['imap.allowSelfSigned.' + primary.id];
    updateSecureDependentFields();
    document.getElementById('f-name').value = res['user.name.' + primary.id] || '';

    // An encrypted password can't be shown as plain text — leave the field
    // empty so saving keeps whatever is already stored.
    const storedPass = res['user.pass.' + primary.id] || '';
    const {isEncrypted} = await import('/tools/crypto.mjs');
    document.getElementById('f-pass').value = (storedPass && isEncrypted(storedPass)) ? '' : storedPass;
    await setPassNote(storedPass);

    // Re-validate after pre-filling
    validateForm();
  }
  catch (e) {
    console.error('[prefill] failed:', e);
  }
}

// One-shot native client probe (version cmd over the native messaging
// host). Resolves a boolean and never throws.
async function nativeInstalled() {
  try {
    const {runtime: savedRuntime} = await chrome.storage.local.get({runtime: 'com.add0n.node'});
    const response = await new Promise(resolve => {
      chrome.runtime.sendNativeMessage(savedRuntime, {cmd: 'version'}, r => resolve(r));
    });
    return !!(response && (response.version || response));
  }
  catch {
    return false;
  }
}

// Native client detection on step 2b entry
async function checkNativeOnEntry() {
  const statusEl = document.getElementById('native-status');
  const installEl = document.getElementById('install-steps');
  const checkBtn = document.querySelector('[data-cmd="check"]');
  const nextBtn = document.querySelector('#step-2b [data-cmd="next"]');

  // Reset UI
  statusEl.textContent = 'Checking native client...';
  statusEl.className = '';
  installEl.hidden = true;
  checkBtn.hidden = true;
  nextBtn.disabled = true;

  // Detect native client
  const installed = await nativeInstalled();

  if (installed) {
    // Native client is available — show ready message
    statusEl.textContent = 'Native client is ready.';
    statusEl.className = 'success';
    installEl.hidden = true;
    checkBtn.hidden = true;
    nextBtn.disabled = false;
  }
  else {
    // Native client not available — show install steps
    statusEl.textContent = 'Native client not found. Please install it below.';
    statusEl.className = 'error';
    installEl.hidden = false;
    checkBtn.hidden = false;
    nextBtn.disabled = true;
  }
}

// Bridge check
async function checkBridge() {
  const status = document.getElementById('bridge-status');
  status.className = '';
  status.textContent = 'Checking bridge...';

  const {['ws.url']: url} = await chrome.storage.local.get('ws.url');
  if (!url) {
    status.className = 'error';
    status.textContent = 'No bridge URL configured. Set it in the options page.';
    return;
  }

  try {
    const ws = new WebSocket(url);
    const result = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Connection timed out')), 5000);
      ws.onopen = () => {
        ws.send(JSON.stringify({op: 'open', host: 'localhost', port: 1, secure: false}));
      };
      ws.onmessage = (e) => {
        clearTimeout(timeout);
        try {
          resolve(JSON.parse(e.data));
        }
        catch {
          resolve({op: 'unknown'});
        }
        ws.close();
      };
      ws.onerror = () => {
        clearTimeout(timeout);
        reject(new Error('Cannot connect to bridge'));
      };
    });

    if (result.op === 'ready' || result.op === 'error') {
      status.className = 'success';
      status.textContent = 'Bridge is working! (responded with: ' + result.op + ')';
    }
    else {
      status.className = 'error';
      status.textContent = 'Bridge responded with unexpected format.';
    }
  }
  catch (e) {
    status.className = 'error';
    status.textContent = 'Bridge check failed: ' + e.message;
  }
}

// Sample bridge
function showSampleBridge() {
  const div = document.getElementById('sample-code');
  div.hidden = !div.hidden;
}

// The real bridge script (core/ws-to-tls/ws-to-tls.js) — fetched from the
// extension's own resources, cached after the first load. Same pattern as
// core/native/ws-bridge-client.mjs.
let bridgeScriptPromise = null;
function loadBridgeScript() {
  if (!bridgeScriptPromise) {
    bridgeScriptPromise = fetch(chrome.runtime.getURL('core/ws-to-tls/ws-to-tls.js'))
      .then(res => {
        if (!res.ok) {
          throw new Error('failed to load core/ws-to-tls/ws-to-tls.js: ' + res.status);
        }
        return res.text();
      });
  }
  return bridgeScriptPromise;
}

// Download the real bridge script
async function downloadSampleBridge() {
  const status = document.getElementById('bridge-status');
  try {
    const code = await loadBridgeScript();
    const blob = new Blob([code], {type: 'text/javascript'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'ws-to-tls.js';
    a.click();
    URL.revokeObjectURL(url);
  }
  catch (e) {
    status.className = 'error';
    status.textContent = 'Cannot load the bridge script: ' + e.message;
  }
}

// Copy the real bridge script to the clipboard
async function copySampleBridge() {
  const status = document.getElementById('bridge-status');
  const btn = document.querySelector('[data-cmd="copy-bridge"]');
  try {
    const code = await loadBridgeScript();
    await navigator.clipboard.writeText(code);
    status.className = 'success';
    status.textContent = 'Bridge script copied to clipboard.';
    if (btn) {
      const old = btn.value;
      btn.value = 'Copied!';
      setTimeout(() => { btn.value = old; }, 1500);
    }
  }
  catch (e) {
    status.className = 'error';
    status.textContent = 'Cannot copy the bridge script: ' + e.message;
  }
}

// Native client download
function downloadNativeClient() {
  const repo = runtime.value === 'com.add0n.node' ? 'native-client' : 'native-client-bunjs';

  const next = () => {
    const req = new XMLHttpRequest();
    req.open('GET', 'https://api.github.com/repos/andy-portmen/' + repo + '/releases/latest');
    req.responseType = 'json';
    req.onload = () => {
      chrome.downloads.download({
        filename: os + '.zip',
        url: req.response.assets.filter(a => a.name === os + '.zip')[0].browser_download_url
      });
    };
    req.onerror = () => {
      alert('Cannot fetch release info. Please download manually from GitHub.');
    };
    req.send();
  };

  if (chrome.downloads) {
    next();
  }
  else {
    chrome.permissions.request({permissions: ['downloads']}, granted => {
      if (granted) {
        next();
      }
      else {
        alert('Download permission denied. Please download manually.');
      }
    });
  }
}

// Native connection check (manual button on step 2b)
function checkNativeConnection() {
  chrome.runtime.sendNativeMessage(runtime.value, {cmd: 'version'}, response => {
    const statusEl = document.getElementById('native-status');
    const nextBtn = document.querySelector('#step-2b [data-cmd="next"]');

    if (response) {
      const version = response.version || JSON.stringify(response);
      statusEl.textContent = 'Native client is ready (version: ' + version + ').';
      statusEl.className = 'success';
      document.getElementById('install-steps').hidden = true;
      nextBtn.disabled = false;
    }
    else {
      const e = chrome.runtime.lastError;
      statusEl.textContent = 'Native client not found. ' + (e?.message || 'Please install it first.');
      statusEl.className = 'error';
      document.getElementById('install-steps').hidden = false;
      nextBtn.disabled = true;
    }
  });
}

// Account form validation
function validateForm() {
  const host = document.getElementById('f-host').value.trim();
  const port = Number(document.getElementById('f-port').value);
  const name = document.getElementById('f-name').value.trim();
  const errorEl = document.getElementById('form-error');
  const finishBtn = document.querySelector('#step-3 [data-cmd="finish"]');

  if (!host) {
    errorEl.textContent = 'Host is required.';
    finishBtn.disabled = true;
    return false;
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    errorEl.textContent = 'Port must be an integer between 1 and 65535.';
    finishBtn.disabled = true;
    return false;
  }
  if (!name) {
    errorEl.textContent = 'Name is required.';
    finishBtn.disabled = true;
    return false;
  }

  errorEl.textContent = '';
  finishBtn.disabled = false;
  return true;
}

// Parent/child like the options page: accepting self-signed certificates only
// makes sense on a TLS connection, so unchecking TLS disables and clears the
// second checkbox.
function updateSecureDependentFields() {
  const secure = document.getElementById('f-secure');
  const selfSigned = document.getElementById('f-allow-self-signed');
  selfSigned.disabled = !secure.checked;
  if (!secure.checked) {
    selfSigned.checked = false;
  }
}

document.getElementById('f-secure').addEventListener('change', updateSecureDependentFields);

// Reads the master password verifier. The storage key is the literal string
// 'master.hash', so it has to be read by that name — destructuring it into a
// differently-named variable comes back undefined.
async function readMasterHash() {
  const res = await chrome.storage.local.get('master.hash');
  return res['master.hash'] || '';
}

// Save the account. The account keeps the id the form was pre-filled with, so
// finishing edits the existing account instead of creating a duplicate.
async function saveAccount() {
  const label = document.getElementById('f-label').value.trim() || 'Account';
  const host = document.getElementById('f-host').value.trim();
  const port = Number(document.getElementById('f-port').value);
  const name = document.getElementById('f-name').value.trim();
  const pass = document.getElementById('f-pass').value;
  const master = document.getElementById('f-master').value;

  const id = editingId || (Math.random() + 1).toString(36).substring(7);
  const {accounts} = await chrome.storage.local.get({accounts: []});
  const list = Array.isArray(accounts) ? accounts : [];

  let account = list.find(a => a.id === id);
  if (!account) {
    account = {id, label, primary: true, order: list.length};
    list.push(account);
  }
  account.label = label;

  const writes = {
    accounts: list,
    ['imap.host.' + id]: host,
    ['imap.port.' + id]: port,
    ['imap.secure.' + id]: document.getElementById('f-secure').checked,
    ['imap.allowSelfSigned.' + id]: document.getElementById('f-allow-self-signed').checked,
    ['user.name.' + id]: name
  };

  // An empty password field means "keep what is already stored", so only write
  // when the user actually typed one.
  if (pass) {
    const configured = await readMasterHash();
    if (configured) {
      // A master password is already set: the session holds the only copy we
      // can encrypt with, so reuse it (falling back to plain text when this
      // page was opened before the master was confirmed).
      const {encryptText} = await import('/tools/crypto.mjs');
      const session = (await chrome.storage.session.get('master.pass'))['master.pass'] || '';
      writes['user.pass.' + id] = session ? await encryptText(pass, session) : pass;
    }
    else if (master) {
      // First master password: keep the verifier for later and encrypt with it.
      const {encryptText, hashMaster} = await import('/tools/crypto.mjs');
      writes['master.hash'] = await hashMaster(master);
      writes['user.pass.' + id] = await encryptText(pass, master);
    }
    else {
      // No master password configured — stored as plain text.
      writes['user.pass.' + id] = pass;
    }
  }

  await chrome.storage.local.set(writes);
  // the saved account becomes the one this form edits: a retry (a cancelled
  // master-password prompt, a failed save) must UPDATE it, not mint a
  // second account with a fresh random id
  editingId = id;
  return id;
}

// Auto-sync after a saved account: load the fresh record (decrypting the
// password just-in-time — a master-password prompt appears here when needed,
// window stays open until the job is accepted), then submit it through the
// regular chain, exactly like the options page does. An unresolvable
// password (cancelled/wrong master) skips the sync without closing: a stale
// first sync is worse than a click on Sync now later.
// Returns true when the sync job was accepted.
async function startAutoSync(id, formPass) {
  const promptEl = document.getElementById('prompt');
  const {loadAccounts} = await import('/data/sync/client/accounts.mjs');
  let account = null;
  if (formPass) {
    // The form's plain password is authoritative and fresh; the record is
    // only reloaded for metadata (id/name/slug) — no decryption round-trip.
    account = (await loadAccounts(promptEl, {decrypt: false}).catch(() => []))
      .find(a => a.id === id) || null;
    if (account) account.pass = formPass;
  }
  else {
    // Field left empty = keep the stored password, whatever that is; this is
    // the one path that may prompt for the master password.
    account = (await loadAccounts(promptEl, {decrypt: true}).catch(e => {
      console.error('[welcome] account load failed:', e?.message || e);
      return [];
    })).find(a => a.id === id) || null;
  }
  if (!account || !account.pass) {
    console.error('[welcome] auto-sync skipped: no usable password for', id);
    return false;
  }
  try {
    const res = await chrome.runtime.sendMessage({
      type: 'sync-request',
      rid: 'auto-' + Date.now().toString(36),
      kind: 'sync',
      account
    });
    if (!res?.ok) {
      console.error('[welcome] auto-sync not accepted:',
        res?.error || 'engine did not answer');
      return false;
    }
    return true;
  }
  catch (e) {
    console.error('[welcome] auto-sync failed:', e?.message || e);
    return false;
  }
}

// Form input listeners
['f-host', 'f-port', 'f-name'].forEach(id => {
  document.getElementById(id).addEventListener('input', validateForm);
});

// Check master password status. The whole section is hidden when a master
// password already exists — there is nothing left to configure here.
async function checkMasterStatus() {
  const section = document.querySelector('#step-3 .master-section');
  const configured = await readMasterHash();
  section.hidden = !!configured;
}

// Click handler
document.addEventListener('click', async ({target}) => {
  const cmd = target.dataset.cmd;
  if (!cmd) return;

  if (cmd === 'back') {
    const step = document.body.dataset.step;
    if (step === '2a' || step === '2b') {
      showStep('1');
    }
    else if (step === '3') {
      showStep(document.body.dataset.mode === 'remote' ? '2a' : '2b');
    }
  }
  else if (cmd === 'next') {
    const step = document.body.dataset.step;
    if (step === '2a' || step === '2b') {
      showStep('3');
    }
  }
  else if (cmd === 'finish') {
    if (validateForm()) {
      // the Finish button: disabled while the save + sync-start runs
      target.disabled = true;
      let started = false;
      try {
        const id = await saveAccount();
        started = await startAutoSync(id,
          document.getElementById('f-pass').value);
      }
      catch (e) {
        console.error('[welcome] finish failed:', e?.message || e);
        document.getElementById('form-error').textContent =
          'Saving the account failed — try again.';
        target.disabled = false;
        return;
      }
      if (started) {
        window.close();
      }
      else {
        // leave the wizard open with feedback: the user can retry Finish or
        // start the sync later from the client
        document.getElementById('form-error').textContent =
          'Account saved, but the first sync could not start. Press Finish to retry, or Sync now in the mail client.';
        target.disabled = false;
      }
    }
  }
  else if (cmd === 'check-bridge') {
    checkBridge();
  }
  else if (cmd === 'sample-bridge') {
    showSampleBridge();
  }
  else if (cmd === 'download-bridge') {
    downloadSampleBridge();
  }
  else if (cmd === 'copy-bridge') {
    copySampleBridge();
  }
  else if (cmd === 'download') {
    downloadNativeClient();
  }
  else if (cmd === 'check') {
    checkNativeConnection();
  }
  else if (cmd === 'options') {
    chrome.runtime.openOptionsPage();
  }
});

// Runtime preference
runtime.addEventListener('change', () => chrome.storage.local.set({
  'runtime': runtime.value
}));

chrome.storage.local.get({runtime: 'com.add0n.node'}, prefs => {
  runtime.value = prefs.runtime;
});

// Setup-gate routing: the worker opens this page with ?reason= when the
// icon click cannot go to the mail client. Jump straight to the step that
// needs the user's attention — the back button always leads to the start.
(async () => {
  if (reason === 'no-native') {
    // native client mode without a usable native client: install steps
    document.body.dataset.mode = 'local';
    showStep('2b');
  }
  else if (reason === 'no-account') {
    const {'ws.mode': wsMode, 'ws.url': wsUrl} = await chrome.storage.local.get({
      'ws.mode': '',
      'ws.url': ''
    });
    if (wsMode === 'external' && wsUrl) {
      // the remote bridge is saved — only the account setup is missing
      document.body.dataset.mode = 'remote';
      showStep('3');
    }
    else if (wsMode === 'external') {
      // remote chosen, but the bridge is not saved yet
      document.body.dataset.mode = 'remote';
      showStep('2a');
    }
    else if (await nativeInstalled()) {
      // native client usable — only the account setup is missing
      document.body.dataset.mode = 'local';
      showStep('3');
    }
    // otherwise nothing is configured yet: the wizard starts at step 1
  }
})();

// Interface management: respond to the worker's exists check and
// send a focus message so the worker can focus this tab.
chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (msg?.cmd === 'exists' && msg.type === 'welcome') {
    respond({ok: true});
    chrome.runtime.sendMessage({cmd: 'focus', type: 'welcome'});
    return false;
  }
  return false;
});

// URL message parameter
if (args.has('msg')) {
  alert(args.get('msg'));
}
