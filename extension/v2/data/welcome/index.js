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

  // Update progress dots by numbered level ('2a'/'2b' both sit on level 2) —
  // the old i < step compared against the literal string, so step 2 never
  // lit a dot at all
  const level = String(step).startsWith('2') ? 2 : Number(step);
  const dots = document.querySelectorAll('.dot');
  dots.forEach((d, i) => d.classList.toggle('active', i < level));

  // On step 2a (remote bridge), load and check the configured server URL
  if (step === '2a') {
    await onBridgeStepEnter();
  }

  // On step 2b (local native), auto-check native client
  if (step === '2b') {
    // Entering the local path switches the connection mode to the built-in
    // bridge: worker.mjs reads 'ws.mode' per ask, so a Remote URL saved
    // earlier must not keep driving syncs. The URL itself stays stored —
    // returning to the remote card re-verifies it in one click.
    chrome.storage.local.set({'ws.mode': 'native'});
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

// Step-2a bridge configuration: the server URL lives in the input box, is
// verified against the ws -> TCP dial protocol and saved right here — no
// detour through the options page.
const wsUrlEl = document.getElementById('f-ws-url');
const bridgeStatusEl = document.getElementById('bridge-status');
const bridgeNoteEl = document.getElementById('bridge-note');

// The URL that was last probed AND saved, or null while the input holds
// something not (yet) verified. Next on step 2a stays locked until the
// field matches this, so what is saved is always what was probed.
let bridgeVerified = null;
// one check at a time: the Verify button and the step-entry auto-check
// share the status line and the buttons
let verifying = false;

// One-line helpers; an empty message resets (and un-classes) the line
function setBridgeStatus(message, cls = '') {
  bridgeStatusEl.textContent = message;
  bridgeStatusEl.className = cls;
}

function setBridgeNote(message, cls = '') {
  bridgeNoteEl.textContent = message;
  bridgeNoteEl.className = cls;
  bridgeNoteEl.hidden = !message;
}

// Lock the step: the saved-vs-probed invariant is gone, Next closes
function clearBridgeVerified() {
  bridgeVerified = null;
  document.querySelector('#step-2a [data-cmd="next"]').disabled = true;
  setBridgeNote('');
}

// Host permission patterns only accept http(s): ws -> http, wss -> https —
// the same origin mapping the options page uses. Returns the origin, or
// null when the URL is not a parseable ws(s):// one.
function bridgeOrigin(url) {
  if (!/^wss?:\/\//i.test(url)) {
    return null;
  }
  try {
    return new URL(url.replace(/^ws/i, 'http')).origin;
  }
  catch {
    return null;
  }
}

// True when the origin permission for this URL is already granted, so a
// probe can run without any prompt. (async: an unparseable stored URL
// becomes a rejection, not a crash)
async function wsOriginGranted(url) {
  const origin = new URL(String(url).replace(/^ws/i, 'http')).origin;
  return chrome.permissions.contains({origins: [origin + '/*']});
}

// One dial-protocol probe: open the socket and send the dummy
// {op:'open', host:'localhost', port:1} control frame; resolve the server's
// first text reply. A protocol-speaking server answers {op:'ready'} or
// {op:'error'} — see core/ws-to-tls/ws-to-tls.js; anything else, a socket
// failure, an early close or the 5s timeout rejects. The socket is closed
// on every path.
function probeBridge(url, cap = 5000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let timer = null;
    let done = false;
    const finish = (fn, arg) => {
      if (done) {
        return;
      }
      done = true;
      clearTimeout(timer);
      try {
        ws.close();
      }
      catch {
        // the socket already died on its own
      }
      fn(arg);
    };

    timer = setTimeout(() =>
      finish(() => reject(new Error('Connection timed out'))), cap);

    ws.onopen = () => {
      ws.send(JSON.stringify({op: 'open', host: 'localhost', port: 1, secure: false}));
    };
    ws.onmessage = (e) => {
      let result = {op: 'unknown'};
      try {
        result = JSON.parse(e.data);
      }
      catch {
        // not JSON: handled by the caller as an unexpected format
      }
      finish(() => resolve(result));
    };
    // a socket that dies without replying (refused connects land on the
    // error event first) must fail now instead of hanging into the cap
    ws.onclose = () =>
      finish(() => reject(new Error('Connection closed before the bridge answered')));
    ws.onerror = () =>
      finish(() => reject(new Error('Cannot connect to bridge')));
  });
}

// The shared check body: probe the URL and, on a protocol answer, persist
// 'ws.mode' + 'ws.url' and unlock Next. worker.mjs answers bridge-acquire
// with the URL only when the mode is 'external', so both keys ride along.
// The host permission (when still missing) is the caller's job: the button
// path requests it inside its own user gesture, and the entry path only
// reaches here when the permission already stands.
async function runBridgeCheck(url) {
  const nextBtn = document.querySelector('#step-2a [data-cmd="next"]');
  setBridgeStatus('Checking bridge...', '');
  setBridgeNote('');

  let result;
  try {
    result = await probeBridge(url);
  }
  catch (e) {
    setBridgeStatus('Bridge check failed: ' + (e?.message || e), 'error');
    return false;
  }

  if (result && (result.op === 'ready' || result.op === 'error')) {
    // Either answer proves the server speaks the dial protocol: 'ready'
    // accepted the (dummy) dial, 'error' is the protocol's own refusal —
    // the sample bridge rejects the localhost:1 probe dial that way.
    setBridgeStatus(result.op === 'error'
      ? 'Bridge is working! It refused the dummy dial with a protocol error, as expected.'
      : 'Bridge is working! (responded with: ' + result.op + ')', 'success');
    await chrome.storage.local.set({
      'ws.mode': 'external',
      'ws.url': url
    });
    bridgeVerified = url;
    nextBtn.disabled = false;
    setBridgeNote('Saved — the extension will use this server for IMAP connections.', 'success');
    return true;
  }
  setBridgeStatus('Bridge responded with unexpected format.', 'error');
  return false;
}

// Verify & Save (the step-2a button): validate the typed URL, request the
// origin host permission — this must happen here, inside the click gesture —
// then probe and persist. Returns whether Next is unlocked.
async function verifyAndSaveBridge() {
  if (verifying) {
    return false;
  }
  const url = wsUrlEl.value.trim();
  const btn = document.querySelector('#step-2a [data-cmd="check-bridge"]');

  // A typed-but-unverified URL must never leave Next enabled, whatever the
  // earlier state was.
  clearBridgeVerified();

  if (!url) {
    setBridgeStatus('Enter the bridge server URL.', 'error');
    return false;
  }
  const origin = bridgeOrigin(url);
  if (!origin) {
    setBridgeStatus('Enter a valid ws:// or wss:// URL', 'error');
    return false;
  }

  verifying = true;
  btn.disabled = true;
  try {
    const granted = await chrome.permissions.request({
      origins: [origin + '/*']
    });
    if (!granted) {
      setBridgeStatus('Permission for ' + origin + ' denied', 'error');
      return false;
    }
    return await runBridgeCheck(url);
  }
  catch (e) {
    setBridgeStatus('Bridge check failed: ' + (e?.message || e), 'error');
    return false;
  }
  finally {
    verifying = false;
    btn.disabled = false;
  }
}

// Step-2a entry: load the stored URL into the input, then re-check it
// automatically when the origin permission already stands — the probe is
// silent, but an ungranted origin must not pop the permission prompt
// outside a user gesture, so those cases report and wait for the button.
async function onBridgeStepEnter() {
  if (verifying) {
    return;
  }
  clearBridgeVerified();
  wsUrlEl.value = '';

  const {'ws.mode': wsMode, 'ws.url': wsUrl} = await chrome.storage.local.get({
    'ws.mode': '',
    'ws.url': ''
  });
  const url = String(wsUrl || '').trim();
  if (!url || !bridgeOrigin(url)) {
    setBridgeStatus('', '');
    return;
  }
  wsUrlEl.value = url;

  const granted = await wsOriginGranted(url).catch(() => false);
  if (granted && wsMode === 'external') {
    // the stored URL still stands chrome-side: re-probe it quietly so the
    // step reflects the server's current state, not the last session's
    if (await runBridgeCheck(url).catch(() => false)) {
      return;
    }
    // stored server stopped answering: runBridgeCheck left the failure in
    // the status line — only add the note pointing at the button
    setBridgeNote('Bridge URL loaded from settings — press Verify & Save to check and save it.', '');
    return;
  }
  setBridgeStatus('', '');
  setBridgeNote(granted
    ? 'Bridge URL loaded from settings — press Verify & Save to check and save it.'
    : 'Bridge URL loaded from settings — press Verify & Save to grant access and check the server.', '');
}

// Any input change invalidates what was probed: re-lock Next until the new
// URL verifies again. Typing the verified URL back (undo, a stray space
// trimmed) restores its state, since the field then holds exactly the
// probed-and-saved value.
wsUrlEl.addEventListener('input', () => {
  if (wsUrlEl.value.trim() === bridgeVerified) {
    return;
  }
  clearBridgeVerified();
  setBridgeNote('Press Verify & Save to check and store this URL.', '');
});

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
    setBridgeNote('Cannot load the bridge script: ' + e.message, 'error');
  }
}

// Copy the real bridge script to the clipboard
async function copySampleBridge() {
  const btn = document.querySelector('[data-cmd="copy-bridge"]');
  try {
    const code = await loadBridgeScript();
    await navigator.clipboard.writeText(code);
    // the note line, not #bridge-status: the verification result must stay
    setBridgeNote('Bridge script copied to clipboard.', 'success');
    if (btn) {
      const old = btn.value;
      btn.value = 'Copied!';
      setTimeout(() => { btn.value = old; }, 1500);
    }
  }
  catch (e) {
    setBridgeNote('Cannot copy the bridge script: ' + e.message, 'error');
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
    verifyAndSaveBridge();
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
