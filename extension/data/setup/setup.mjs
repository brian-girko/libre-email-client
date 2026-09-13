'use strict';

// Setup popup logic, page by page.
//
// Step 1 asks only for the connection mode (native client vs remote ws
// server). Step 2 then shows the UI that matches the choice:
//   - external: URL entry plus a real end-to-end test — open the WebSocket,
//     send the {op:'open', host, port} dial frame of the ws-to-tls protocol
//     and require the {op:'ready'} control reply. Only a server that can
//     actually tunnel TCP counts as working.
//   - native: the OS decides. Windows/macOS/Linux get the matching release
//     zip from the GitHub API (the releases ship source zips with install
//     scripts, not binaries — the guide explains the script run). Any other
//     platform disables the option: no native messaging host exists there,
//     so a remote ws server is the only path. "I've installed it" re-probes
//     with detectNativeClient(), the same full boot + ping round trip the
//     background worker uses.
//
// Persistence differs by mode on purpose: an external server URL is stored
// once and trusted afterwards, but the native client is never marked "done"
// here — the worker re-probes it on every start-up, so an uninstall is
// noticed without a stored flag going stale.

import {detectNativeClient} from '/core/native/native-client.mjs';

const RELEASE_API = 'https://api.github.com/repos/andy-portmen/native-client/releases/latest';
const RELEASES_PAGE = 'https://github.com/andy-portmen/native-client/releases';

const els = {
  progress: document.getElementById('progress'),
  stepMode: document.getElementById('step-mode'),
  stepExternal: document.getElementById('step-external'),
  stepNative: document.getElementById('step-native'),
  next: document.getElementById('next'),
  skip: document.getElementById('skip'),
  backExternal: document.getElementById('back-external'),
  backNative: document.getElementById('back-native'),
  wsUrl: document.getElementById('f-ws-url'),
  testHost: document.getElementById('f-test-host'),
  testPort: document.getElementById('f-test-port'),
  testWs: document.getElementById('test-ws'),
  wsStatus: document.getElementById('ws-status'),
  downloadSample: document.getElementById('download-sample'),
  nativeStatus: document.getElementById('native-status'),
  nativeBox: document.getElementById('native-box'),
  nativeRelease: document.getElementById('native-release'),
  nativeDownload: document.getElementById('native-download'),
  nativeOs: document.getElementById('native-os'),
  checkNative: document.getElementById('check-native'),
  guides: {
    windows: document.getElementById('guide-windows'),
    linux: document.getElementById('guide-linux'),
    mac: document.getElementById('guide-mac')
  }
};

const modeInputs = document.querySelectorAll('input[name="setup-mode"]');

// ---- step navigation ------------------------------------------------------

function show(step) {
  els.stepMode.hidden = step !== 'mode';
  els.stepExternal.hidden = step !== 'external';
  els.stepNative.hidden = step !== 'native';
  els.progress.textContent = step === 'mode'
    ? 'Step 1 of 2 · Connection mode'
    : 'Step 2 of 2 · ' + (step === 'external' ? 'Remote WS server' : 'Native client');
}

modeInputs.forEach(input => {
  input.addEventListener('change', () => {
    els.next.disabled = !document.querySelector('input[name="setup-mode"]:checked');
  });
});

els.next.addEventListener('click', () => {
  const mode = document.querySelector('input[name="setup-mode"]:checked')?.value;
  if (mode === 'external') {
    show('external');
  }
  else if (mode === 'native') {
    show('native');
    initNativeStep();
  }
});

els.backExternal.addEventListener('click', () => show('mode'));
els.backNative.addEventListener('click', () => show('mode'));

// Remembering the dismissal is the point of 'setup.done': the worker's gate
// never re-opens the window until the options page resets the key. Choosing
// the native path does NOT set it — the worker probes the client itself.
els.skip.addEventListener('click', async () => {
  await chrome.storage.local.set({'setup.done': true});
  finish();
});

// ---- finish helpers -------------------------------------------------------

// Marks the gate done and hands control back to the worker: it closes this
// window (the popup cannot close its own chrome window) and opens the client.
function finish() {
  chrome.runtime.sendMessage({cmd: 'setup-done'}).finally(() => window.close());
}

// Saves the external-server configuration. Mirrors the options page: the
// origin permission is requested before anything is stored. This is the only
// place that persists a completed setup — external URLs are stored once and
// trusted by the worker's gate from then on.
async function saveExternal(url) {
  const origin = new URL(url.replace(/^ws/i, 'http')).origin;
  const granted = await chrome.permissions.request({
    origins: [origin + '/*']
  });
  if (!granted) {
    throw new Error('Permission for ' + origin + ' denied');
  }
  await chrome.storage.local.set({
    'ws.mode': 'external',
    'ws.url': url,
    'setup.done': true
  });
}

// ---- step 2a: remote ws server --------------------------------------------

// One full dial through the server: WS open -> {op:'open'} -> {op:'ready'}.
// Resolves on ready, rejects with a user-facing message on anything else.
// A timeout guards against servers that accept the socket but never answer.
function testBridge(url, host, port) {
  return new Promise((resolve, reject) => {
    let sock;
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Timed out waiting for the bridge reply'));
    }, 15000);
    const cleanup = () => {
      clearTimeout(timer);
      try {
        sock?.close();
      }
      catch {
        // already closed
      }
    };
    try {
      sock = new WebSocket(url);
    }
    catch (e) {
      clearTimeout(timer);
      reject(new Error('Invalid WebSocket URL: ' + (e?.message || e)));
      return;
    }
    sock.addEventListener('open', () => {
      sock.send(JSON.stringify({op: 'open', host, port, secure: false}));
    });
    sock.addEventListener('message', ev => {
      if (typeof ev.data !== 'string') {
        return; // binary frames are tunnel payload, not control
      }
      let msg;
      try {
        msg = JSON.parse(ev.data);
      }
      catch {
        return;
      }
      if (msg.op === 'ready') {
        cleanup();
        resolve();
      }
      else if (msg.op === 'error') {
        cleanup();
        reject(new Error(msg.message || 'The server refused the dial request'));
      }
    });
    sock.addEventListener('error', () => {
      cleanup();
      reject(new Error('Could not connect to ' + url));
    });
  });
}

function flashWs(message, kind = '') {
  els.wsStatus.textContent = message;
  els.wsStatus.className = 'status' + (kind ? ' ' + kind : '');
}

// Offers the sample bridge script as a download. The packaged copy in
// core/ws-to-tls/ is the single source of truth (kept in sync with the
// server/ directory); fetching it and re-wrapping in a Blob lets the user
// save it anywhere Node.js runs, independent of this browser.
els.downloadSample.addEventListener('click', async () => {
  try {
    const url = chrome.runtime.getURL('core/ws-to-tls/ws-to-tls.js');
    const source = await (await fetch(url)).text();
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([source], {type: 'text/javascript'}));
    link.download = 'ws-to-tls.js';
    link.click();
    URL.revokeObjectURL(link.href);
  }
  catch (e) {
    flashWs('Could not prepare the sample server: ' + (e?.message || e), 'error');
  }
});

els.testWs.addEventListener('click', async () => {
  const url = els.wsUrl.value.trim();
  const host = els.testHost.value.trim();
  const port = Number(els.testPort.value);
  if (!/^wss?:\/\//.test(url)) {
    flashWs('Enter a valid ws:// or wss:// URL', 'error');
    return;
  }
  if (!host) {
    flashWs('Enter a test target host', 'error');
    return;
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    flashWs('Enter a test target port between 1 and 65535', 'error');
    return;
  }
  els.testWs.disabled = true;
  flashWs('Testing ' + host + ':' + port + ' through the server…');
  try {
    // permission first: without the origin grant the saved URL would fail
    // later even though the test succeeded
    await saveExternal(url);
    await testBridge(url, host, port);
    flashWs('Success — the server dialed ' + host + ':' + port, 'ok');
    finish();
  }
  catch (e) {
    // a failed test leaves nothing behind; the user retries or goes back
    await chrome.storage.local.set({'ws.mode': 'native', 'ws.url': ''}).catch(() => {});
    flashWs(e?.message || String(e), 'error');
  }
  finally {
    els.testWs.disabled = false;
  }
});

// ---- step 2b: native client -----------------------------------------------

// Best-effort platform detection. userAgentData.platform is the modern
// source; the UA string covers browsers without it. Returns 'windows',
// 'mac', 'linux' or '' for anything unsupported (ChromeOS, Android, ...).
function detectOs() {
  const platform = (navigator.userAgentData?.platform ||
    navigator.platform || '').toLowerCase();
  if (platform.startsWith('win')) {
    return 'windows';
  }
  if (platform.startsWith('mac')) {
    return 'mac';
  }
  // the native client only ships x64/arm64 Linux builds; ARM Chromebooks
  // report linux too, but a Linux release zip is still the right guess
  if (platform.includes('linux') || platform.includes('cros')) {
    return 'linux';
  }
  return '';
}

function flashNative(message, kind = '') {
  els.nativeStatus.textContent = message;
  els.nativeStatus.className = 'hint' + (kind ? ' ' + kind : '');
  // the status line sits below the install instructions and starts hidden,
  // so the first thing the user reads is the download + how to install;
  // it only appears once there is an actual probe result to report
  els.nativeStatus.hidden = false;
}

// Fetches the latest release and wires the download link to this OS. Any
// failure (offline, API rate limit) falls back to the releases page link.
async function loadRelease(os) {
  els.nativeOs.textContent = os;
  try {
    const res = await fetch(RELEASE_API, {headers: {Accept: 'application/vnd.github+json'}});
    if (!res.ok) {
      throw new Error('GitHub API returned ' + res.status);
    }
    const release = await res.json();
    const asset = (release.assets || []).find(a => a.name === os + '.zip');
    if (!asset) {
      throw new Error('no ' + os + '.zip asset in ' + (release.tag_name || 'latest'));
    }
    els.nativeDownload.href = asset.browser_download_url;
    els.nativeRelease.textContent = 'Latest release: ' + (release.tag_name || 'unknown') +
      ' — download, extract and run the install script:';
    els.nativeRelease.hidden = false;
    els.nativeDownload.hidden = false;
  }
  catch (e) {
    els.nativeRelease.textContent =
      'Could not load the latest release (' + (e?.message || 'network error') + '). ' +
      'Grab it manually from the releases page.';
    els.nativeDownload.href = RELEASES_PAGE;
    els.nativeDownload.removeAttribute('download');
    els.nativeRelease.hidden = false;
    els.nativeDownload.hidden = false;
  }
}

// The probe is the contract: detectNativeClient() boots the host, runs one
// sandbox script and pings through the post-message wrapper — exactly what
// ws-to-tls needs later, so success here predicts a working bridge. No
// 'setup.done' is written: the worker re-probes on every start-up.
async function checkNative(thenFinish) {
  flashNative('Checking for the native client…');
  const probe = await detectNativeClient();
  if (probe.installed) {
    await chrome.storage.local.set({'ws.mode': 'native', 'ws.url': ''});
    flashNative('Native client is available.', 'ok');
    if (thenFinish) {
      finish();
    }
    return true;
  }
  flashNative('Native client is not available (' + probe.error + '). ' +
    'Install it below, then check again.', 'error');
  return false;
}

els.checkNative.addEventListener('click', () => {
  els.checkNative.disabled = true;
  checkNative(true).finally(() => {
    els.checkNative.disabled = false;
  });
});

// Built once per visit to the native step; guarded so going Back and forth
// does not stack duplicate GitHub fetches.
let nativeStepReady = false;

async function initNativeStep() {
  const os = detectOs();
  if (!os) {
    els.nativeBox.hidden = true;
    flashNative(
      'The native client is not supported on this platform. Please run a ' +
      'TCP/WS server manually instead (go back and pick "Remote WS server").', 'error');
    return;
  }
  if (!nativeStepReady) {
    nativeStepReady = true;
    const guides = {windows: 'windows', mac: 'mac', linux: 'linux'};
    for (const [name, node] of Object.entries(els.guides)) {
      node.hidden = name !== guides[os];
    }
    await loadRelease(os);
  }
  // The worker only opens this window when the probe failed at start-up, but
  // the user may have installed the client since then. The probe runs last on
  // purpose: the download link and install instructions are on screen first,
  // so the "not available" status does not distract from following them.
  await checkNative(false);
}

// ---- init -----------------------------------------------------------------

(async () => {
  // prefill the test target from the first saved account, else a public
  // DNS-over-TLS endpoint as a neutral reachable TCP host
  const {accounts} = await chrome.storage.local.get({accounts: []});
  const perAccount = accounts.length
    ? await chrome.storage.local.get([
        accounts[0].id + '.imap.host',
        accounts[0].id + '.imap.port'
      ])
    : {};
  els.testHost.value = perAccount[accounts[0]?.id + '.imap.host'] || 'imap.gmail.com';
  els.testPort.value = perAccount[accounts[0]?.id + '.imap.port'] || 993;
  show('mode');
})();
