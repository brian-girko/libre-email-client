'use strict';

// First-run setup gate for the background service worker.
//
// The extension needs one of two things to reach IMAP servers:
//   1. a remote ws -> TCP/TLS bridge server ('ws.mode' = 'external'),
//   2. or the native messaging client (com.add0n.node), which hosts the
//      built-in bridge ('ws.mode' = 'native', the default).
//
// When neither is available on start-up, a popup window offers the user both
// paths. Everything the gate needs is already configured:
//   - detectNativeClient() from core/native/native-client.mjs probes the
//     native host with a full boot + ping round trip (no throwaway state),
//   - the ws.mode/ws.url storage keys are the ones core/ws-to-tls/manager.js
//     reads on every request().
//
// When to open the window:
//   - 'ws.mode' = 'external' with a valid URL  -> configured, stay silent.
//     The stored URL is trusted; if the server goes away later the mail
//     client surfaces the connection error.
//   - 'ws.mode' = 'native' -> never trusted, always probed: the native
//     client can be uninstalled at any time and there is no flag that could
//     go stale. The probe is cheap (one boot + ping, ~ms when installed).
//     Only a failed probe opens the setup window.
//   - 'setup.done' = true -> the user dismissed the window (or completed the
//     external setup); the gate stays silent until the options page resets
//     the key. Deliberately skipped probe results do not count as done —
//     'setup.done' is set only by the setup page itself.

import {detectNativeClient} from '/core/native/native-client.mjs';

const SETUP_URL = '/data/setup/index.html';

// The toolbar icon must read blue for as long as the setup is unfinished:
// blue already means "mail could not be checked" elsewhere (badge.mjs), so
// the same color language is reused here. badge.mjs paints the icon through
// its own doCheck() guard too — this one covers the moment the gate itself
// discovers the unfinished setup (e.g. the badge counter is disabled).
const BLUE_ICON = Object.fromEntries(
  [16, 32, 48, 64, 128, 256].map(size => [size, `/data/icons/blue/${size}.png`])
);

let windowId = null;

async function setBlueIcon() {
  try {
    await chrome.action.setIcon({path: BLUE_ICON});
  }
  catch {
    // icon may be gone while the worker shuts down
  }
}

async function isReady() {
  const prefs = await chrome.storage.local.get({
    'ws.mode': 'native',
    'ws.url': '',
    'setup.done': false
  });
  if (prefs['setup.done']) {
    return true;
  }
  if (prefs['ws.mode'] === 'external' && /^wss?:\/\//.test(prefs['ws.url'])) {
    return true;
  }
  // native mode (and every unknown mode): prove the client is actually there
  return (await detectNativeClient()).installed;
}

// The gate's verdict, exported for the badge: iconState() in badge.mjs paints
// gray for "zero unread, everything checked", which reads as "all good" —
// wrong while the setup is unfinished. doCheck() consults this before every
// repaint and keeps the icon blue instead. Cheap when silent (one storage
// read; the native probe only runs in native mode, ~ms when installed).
async function setupIncomplete() {
  return !(await isReady());
}

// One gate run at a time: the worker start-up and onInstalled can fire close
// together (and the native probe takes up to 15 s), so without this guard
// two concurrent isReady() runs could both see "not ready" and both try to
// open the window. The promise is shared, later callers just await it; a
// failed run clears the flag so a later start-up may retry.
let running = null;

// Centers the popup over the last focused browser window. There is no
// "centered" shortcut in chrome.windows.create and no screen object in a
// service worker, so the browser window's own bounds are the reference
// (undefined top/left when none is found — Chrome picks a spot itself).
async function showWindow() {
  if (windowId !== null) {
    // the popup is already open; focus it instead of stacking a second one
    chrome.windows.update(windowId, {focused: true}).catch(() => {
      windowId = null;
    });
    return;
  }
  const width = 640;
  const height = 700;
  const ref = await chrome.windows.getLastFocused({populate: false}).catch(() => null);
  const options = {url: SETUP_URL, type: 'popup', width, height};
  if (ref && Number.isFinite(ref.width) && Number.isFinite(ref.height)) {
    options.top = Math.max(0, Math.round(ref.top + (ref.height - height) / 2));
    options.left = Math.max(0, Math.round(ref.left + (ref.width - width) / 2));
  }
  await chrome.windows.create(options).then(win => {
    windowId = win?.id ?? null;
  }).catch(() => {});
}

// A closed setup window clears the id so a later start-up may open a fresh
// one; also keeps the focus logic above from chasing a dead window id.
chrome.windows.onRemoved.addListener(id => {
  if (id === windowId) {
    windowId = null;
  }
});

// A completed setup (external URL saved and tested, or native client
// verified) opens the client page; the setup page cannot close its own
// chrome window, so it reports through the runtime channel instead.
chrome.runtime.onMessage.addListener(msg => {
  if (msg?.cmd === 'setup-done') {
    chrome.tabs.create({url: '/data/client/index.html'});
  }
});

// Checked from the worker start-up and from onInstalled. Concurrent calls
// share one run: the first caller executes the check and (maybe) opens the
// window, everyone else awaits the same promise and returns.
async function maybeShowSetup() {
  if (running) {
    return running;
  }
  running = (async () => {
    try {
      if (await isReady()) {
        return;
      }
      // unfinished setup: blue icon until the gate passes, then open setup
      await setBlueIcon();
      showWindow();
    }
    catch (e) {
      console.warn('[setup] gate failed', e);
    }
    finally {
      running = null;
    }
  })();
  return running;
}

// The client's folder pane asks to re-open the setup window ("Run Setup" on
// its error screen). The gate check is skipped on purpose: the user asked
// for the window, not for another probe that might silently refuse it. The
// single-window guard in showWindow() still applies, so a second click just
// focuses the open popup.
// 'open-options': the client forwards its "add or fix the account" offer
// here because it may want the options page to replace the client page
// entirely (closeClient below).
// With no account configured the client page has nothing left to do once
// setup/options opens (the client sets closeClient only in that case, so an
// account-holder keeps their page): the sender's tab is closed, the same
// channel that opens the client on 'setup-done' brings it back afterwards.
function closeClientIfRequested(sender, cmd) {
  if (cmd?.closeClient && sender?.tab?.id != null) {
    chrome.tabs.remove(sender.tab.id).catch(() => {});
  }
}

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.cmd === 'open-setup') {
    showWindow();
    closeClientIfRequested(sender, msg);
  }
  else if (msg?.cmd === 'open-options') {
    chrome.runtime.openOptionsPage().catch(() => {});
    closeClientIfRequested(sender, msg);
  }
});

export {maybeShowSetup, setupIncomplete};
