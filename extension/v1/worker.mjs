import './context.mjs';
import './badge.mjs';
import './filters.mjs';
import './core/sync/engine.mjs'; // SyncEngine: mirror sync + messages (sync-now, mirror-*)
import {reencryptStoredPasswords} from './passwords.mjs';
import {maybeShowSetup} from './data/setup/bridge.mjs';

// First-run gate: when no external ws server is configured and the native
// client is unreachable, offer the setup popup (see data/setup/bridge.mjs).
// Runs on every worker start-up; the 'setup.done' flag keeps it silent after
// the first dismissal or completed setup.
maybeShowSetup();

chrome.runtime.onInstalled.addListener(() => {
  maybeShowSetup();
});

// Master password changes are detected through chrome.storage.onChanged: the
// options page stores the new master in chrome.storage.session ('master.pass')
// and this listener re-encrypts every saved account password in local storage.
// change.oldValue is the master the passwords are currently encrypted with
// (empty when they are plain text), change.newValue the master to encrypt with
// (empty when the master password was removed). The options page re-encrypts
// as well; reencryptStoredPasswords is idempotent so both can run at once.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'session' || !('master.pass' in changes)) {
    return;
  }
  const {oldValue, newValue} = changes['master.pass'];
  reencryptStoredPasswords(oldValue || '', newValue || '')
    .catch(e => console.warn('[master] re-encryption failed', e));
});

// The client tab is found through the runtime channel, not by a stored tab id
// or a URL query (which needs the "tabs" permission): the action click
// broadcasts a ping to every extension page and the live client answers;
// right afterwards the client asks to be brought up itself, and that message
// carries sender.tab — the tab id the worker needs to focus it.
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.cmd !== 'up' || !sender.tab) {
    return;
  }
  const {id} = sender.tab;
  (async () => {
    const tab = await chrome.tabs.get(id).catch(() => null);
    if (!tab) {
      return;
    }
    // already the active tab of a focused window -> refresh the open folder
    if (tab.active && (await chrome.windows.get(tab.windowId)).focused) {
      chrome.tabs.sendMessage(id, {type: 'refresh-dir'}).catch(() => {});
      return;
    }
    await chrome.tabs.update(id, {active: true});
    await chrome.windows.update(tab.windowId, {focused: true});
  })();
});

chrome.action.onClicked.addListener(async () => {
  // a rejection ("Could not establish connection") means no live client;
  // a live client answers and already asked to be brought up itself
  const live = await chrome.runtime.sendMessage({cmd: 'client-ping'}).catch(() => null);
  if (live) {
    return;
  }
  await chrome.tabs.create({url: '/data/client/index.html'});
});
