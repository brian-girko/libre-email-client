'use strict';

import {
  isEncrypted,
  encryptText,
  decryptText,
  hashMaster,
  verifyMaster
} from '/tools/crypto.mjs';
import {reencryptStoredPasswords} from '/tools/passwords.mjs';
import {detectNativeClient} from '/core/native/native-client.mjs';
import {
  MODE_EXTERNAL,
  getStorageMode,
  ownedRootHandle,
  persistRootHandle,
  clearRootHandle
} from '/data/sync/root-handle.mjs';
import '/data/components/prompt-view.js';
import './components/text-viewer.js';
import {initTheme} from '/data/client/theme.mjs';

const MASTER_HASH = 'master.hash';
const MASTER_PASS = 'master.pass';

initTheme();

const selectEl = document.getElementById('account-select');
const storageOpfsEl = document.getElementById('f-storage-opfs');
const storageExternalEl = document.getElementById('f-storage-external');
const storageStatusEl = document.getElementById('storage-status');
const pickStorageBtn = document.getElementById('pick-storage');
const grantStorageBtn = document.getElementById('grant-storage');
const forgetStorageBtn = document.getElementById('forget-storage');
const wsNativeEl = document.getElementById('f-ws-native');
const wsExternalEl = document.getElementById('f-ws-external');
const wsUrlEl = document.getElementById('f-ws-url');
const wsDebugEl = document.getElementById('f-ws-debug');
const mailDebugEl = document.getElementById('f-mail-debug');
const badgeDebugEl = document.getElementById('f-badge-debug');
const offscreenDebugEl = document.getElementById('f-offscreen-debug');
const bridgeDebugEl = document.getElementById('f-bridge-debug');
const schedulerDebugEl = document.getElementById('f-scheduler-debug');
const pageSizeEl = document.getElementById('f-page-size');
const flaggedTopEl = document.getElementById('f-flagged-top');
const syncPrefetchEl = document.getElementById('f-sync-prefetch');
const badgeEnabledEl = document.getElementById('f-badge-enabled');
const badgeMaxAgeEl = document.getElementById('f-badge-max-age');
const pickerAutoOpenEl = document.getElementById('f-picker-auto-open');
const syncAutoEnabledEl = document.getElementById('f-sync-auto-enabled');
const syncFullEnabledEl = document.getElementById('f-sync-full-enabled');
const syncFullIntervalEl = document.getElementById('f-sync-full-interval');
const syncDirtyEnabledEl = document.getElementById('f-sync-dirty-enabled');
const syncDirtyDelayEl = document.getElementById('f-sync-dirty-delay');
const syncIdleEnabledEl = document.getElementById('f-sync-idle-enabled');
const checkBadgeBtn = document.getElementById('check-badge');
const badgeStatusEl = document.getElementById('badge-status');
const saveGlobalBtn = document.getElementById('save-global');
const globalSavedEl = document.getElementById('global-saved');
let globalFlashTimer = null;
let initialStorageMode = 'opfs';

// ---- Storage root: browser storage (default) or a user-chosen directory ----

// minutes; 0 disables the age limit (badge counts all unread mail)
const BADGE_MAX_AGES = [0, 15, 30, 60, 120, 360, 720];

const masterEl = document.getElementById('f-master');
const saveMasterBtn = document.getElementById('save-master');
const clearMasterBtn = document.getElementById('clear-master');
const masterSavedEl = document.getElementById('master-saved');
const promptEl = document.getElementById('prompt');
let masterFlashTimer = null;

const formEl = document.getElementById('account-form');
const addBtn = document.getElementById('add-account');
const deleteBtn = document.getElementById('delete-account');
const savedEl = document.getElementById('saved');

const tabsEl = document.getElementById('tabs');
const TAB_NAMES = ['global', 'accounts', 'actions', 'filters'];

// tabs: vertical list beside the panels on wide screens, horizontal row on top
// when narrow; the active tab is mirrored to the url hash so reloads and
// deep links (#global / #accounts) land on the right tab
function selectTab(name, focus = false) {
  if (!TAB_NAMES.includes(name)) {
    name = 'global';
  }
  for (const tab of TAB_NAMES) {
    const active = tab === name;
    const btn = document.getElementById('tab-' + tab);
    btn.setAttribute('aria-selected', String(active));
    btn.tabIndex = active ? 0 : -1;
    document.getElementById('panel-' + tab).hidden = !active;
    if (active && focus) {
      btn.focus();
    }
  }
  if (location.hash !== '#' + name) {
    history.replaceState(null, '', '#' + name);
  }
}

tabsEl.addEventListener('click', e => {
  const btn = e.target.closest('[role="tab"]');
  if (btn) {
    selectTab(btn.id.slice(4));
  }
});

tabsEl.addEventListener('keydown', e => {
  const current = TAB_NAMES.indexOf((document.activeElement?.id || '').slice(4));
  let next = null;
  if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
    next = (current + 1) % TAB_NAMES.length;
  }
  else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
    next = (current - 1 + TAB_NAMES.length) % TAB_NAMES.length;
  }
  else if (e.key === 'Home') {
    next = 0;
  }
  else if (e.key === 'End') {
    next = TAB_NAMES.length - 1;
  }
  if (next != null) {
    e.preventDefault();
    selectTab(TAB_NAMES[next], true);
  }
});

selectTab(location.hash.slice(1) || 'global');

const FIELDS = {
  'imap.host': document.getElementById('f-host'),
  'imap.port': document.getElementById('f-port'),
  'imap.secure': document.getElementById('f-secure'),
  'imap.allowSelfSigned': document.getElementById('f-allow-self-signed'),
  'user.name': document.getElementById('f-name'),
  'user.pass': document.getElementById('f-pass'),
  'email.displayMode': document.getElementById('f-remote'),
  'email.badge': document.getElementById('f-badge'),
  'email.badgeMode': document.getElementById('f-badge-mode'),
  'email.badgeFolder': document.getElementById('f-badge-folder'),
  'email.badgeQuery': document.getElementById('f-badge-query')
};

let accounts = [];
let draft = null;
let selectedId = null;
let flashTimer = null;
let passDirty = false;

const key = (name, id) => name + '.' + id;
const byOrder = (a, b) => a.order - b.order;
const uid = () => (Math.random() + 1).toString(36).substring(7);
const allAccounts = () => draft ? [...accounts, draft] : accounts;

async function masterVerifier() {
  const res = await chrome.storage.local.get(MASTER_HASH);
  return res[MASTER_HASH] || '';
}

async function sessionMaster() {
  const res = await chrome.storage.session.get(MASTER_PASS);
  return res[MASTER_PASS] || '';
}

async function askMaster(message) {
  if (!promptEl) {
    return null;
  }
  try {
    return await promptEl.ask(message, {password: true});
  }
  catch {
    return null;
  }
}

// Returns the master password for this browser session, asking for it (and
// checking it against the stored verifier) when it is not known yet. Returns
// null when there is no master password or the user did not confirm it.
async function ensureMaster() {
  const cached = await sessionMaster();
  if (cached) {
    return cached;
  }
  const verifier = await masterVerifier();
  if (!verifier) {
    return null;
  }
  for (let i = 0; i < 3; i++) {
    const master = await askMaster(i ? 'Wrong master password, try again' : 'Enter your master password');
    if (!master) {
      return null;
    }
    if (await verifyMaster(master, verifier)) {
      await chrome.storage.session.set({[MASTER_PASS]: master});
      return master;
    }
  }
  return null;
}

// Changing or removing a configured master password always requires the
// current one, even when it is already known in this session.
async function confirmCurrentMaster() {
  const verifier = await masterVerifier();
  if (!verifier) {
    return null;
  }
  for (let i = 0; i < 3; i++) {
    const master = await askMaster(i ? 'Wrong master password, try again' : 'Enter your current master password');
    if (!master) {
      return null;
    }
    if (await verifyMaster(master, verifier)) {
      await chrome.storage.session.set({[MASTER_PASS]: master});
      return master;
    }
  }
  return null;
}

// Loads an account's stored password for display. Returns the decrypted (or
// plain) value and whether anything is stored at all; an encrypted value that
// cannot be shown (master not available in this session) stays hidden but is
// reported as stored so the form does not suggest the field is empty.
async function loadPasswordState(id) {
  const res = await chrome.storage.local.get(key('user.pass', id));
  const value = res[key('user.pass', id)];
  if (typeof value !== 'string' || !value) {
    return {value: '', stored: false};
  }
  if (!isEncrypted(value)) {
    return {value, stored: true};
  }
  const master = await sessionMaster();
  if (master) {
    try {
      return {value: await decryptText(value, master), stored: true};
    }
    catch {
      return {value: '', stored: true};
    }
  }
  return {value: '', stored: true};
}

function render() {
  selectEl.textContent = '';
  for (const account of allAccounts().sort(byOrder)) {
    const option = document.createElement('option');
    option.value = account.id;
    let text = account.label || 'Unnamed account';
    if (account.primary) {
      text += ' (primary)';
    }
    if (draft && account.id === draft.id) {
      text += ' (unsaved)';
    }
    option.textContent = text;
    selectEl.append(option);
  }
  selectEl.value = selectedId;
  deleteBtn.disabled = !selectedId;
  renderFilterAccounts();
}

async function loadAccounts() {
  const res = await chrome.storage.local.get('accounts');
  accounts = Array.isArray(res.accounts) ? res.accounts : [];
}

function emptyAccount(order, primary) {
  return {id: uid(), label: 'Account ' + (accounts.length + 1), primary, order};
}

async function select(id) {
  const account = allAccounts().find(a => a.id === id);
  if (!account) {
    return;
  }
  selectedId = id;
  document.getElementById('f-label').value = account.label || '';
  document.getElementById('f-primary').checked = !!account.primary;

  const keys = Object.keys(FIELDS).map(name => key(name, id));
  const legacyRemoteKey = key('email.showRemoteContent', id);
  const res = await chrome.storage.local.get([...keys, legacyRemoteKey]);
  for (const [name, input] of Object.entries(FIELDS)) {
    if (name === 'user.pass') {
      continue; // loaded separately, may need decryption
    }
    const value = res[key(name, id)];
    if (input.type === 'checkbox') {
      input.checked = value === undefined ? input.defaultChecked : !!value;
    }
    else if (name === 'email.displayMode') {
      input.value = ['remote', 'block', 'text'].includes(value)
        ? value
        : (res[legacyRemoteKey] ? 'remote' : 'block');
    }
    else if (name === 'email.badgeMode') {
      input.value = ['folder', 'query'].includes(value) ? value : 'folder';
    }
    else {
      input.value = value == null ? '' : value;
    }
  }
  const passInput = FIELDS['user.pass'];
  const passState = await loadPasswordState(id);
  passInput.value = passState.value;
  passInput.placeholder = !passState.stored || passState.value
    ? ''
    : 'Stored (encrypted) — not shown until the master password is confirmed';
  passDirty = false;
  render();
  updateSecureDependentFields();
  updateBadgeFields();
}

function updateBadgeFields() {
  const query = FIELDS['email.badgeQuery'];
  const isQuery = FIELDS['email.badgeMode'].value === 'query';
  query.disabled = !isQuery;
}

FIELDS['email.badgeMode'].addEventListener('change', updateBadgeFields);

function updateSecureDependentFields() {
  const secure = FIELDS['imap.secure'];
  const selfSigned = FIELDS['imap.allowSelfSigned'];
  selfSigned.disabled = !secure.checked;
  if (!secure.checked) {
    selfSigned.checked = false;
  }
}

FIELDS['imap.secure'].addEventListener('change', updateSecureDependentFields);

// only rewrite the password on save when the user actually touched the field;
// an undecryptable (master not in session) value must not be wiped
FIELDS['user.pass'].addEventListener('input', () => {
  passDirty = true;
});

function flash(message = 'Saved', error = false) {
  savedEl.textContent = message;
  savedEl.className = error ? 'error' : '';
  savedEl.hidden = false;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => {
    savedEl.hidden = true;
  }, 1500);
}

document.getElementById('f-primary').addEventListener('change', e => {
  const account = allAccounts().find(a => a.id === selectedId);
  if (!account) {
    e.target.checked = false;
    return;
  }
  if (e.target.checked) {
    for (const a of allAccounts()) {
      a.primary = a.id === account.id;
    }
  }
  else {
    account.primary = false;
  }
  render();
});

selectEl.addEventListener('change', () => {
  select(selectEl.value);
});

formEl.addEventListener('submit', async e => {
  e.preventDefault();
  const account = allAccounts().find(a => a.id === selectedId);
  if (!account) {
    return;
  }
  const host = FIELDS['imap.host'].value.trim();
  const port = Number(FIELDS['imap.port'].value);
  const name = FIELDS['user.name'].value.trim();
  if (!host || !port || !name) {
    flash('Host, port and user name are required', true);
    return;
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    flash('Port must be an integer between 1 and 65535', true);
    return;
  }
  account.label = document.getElementById('f-label').value.trim() || 'Account';
  account.primary = document.getElementById('f-primary').checked;
  const writes = {};
  for (const [field, input] of Object.entries(FIELDS)) {
    if (field === 'user.pass') {
      continue; // handled below, may need encryption
    }
    const id = key(field, selectedId);
    if (input.type === 'checkbox') {
      writes[id] = input.checked;
    }
    else if (field === 'imap.port') {
      writes[id] = Number(input.value) || '';
    }
    else if (field === 'email.displayMode') {
      writes[id] = ['remote', 'block', 'text'].includes(input.value) ? input.value : 'block';
    }
    else if (field === 'email.badgeMode') {
      writes[id] = ['folder', 'query'].includes(input.value) ? input.value : 'folder';
    }
    else {
      writes[id] = input.value.trim();
    }
  }
  if (passDirty) {
    const pass = FIELDS['user.pass'].value;
    if (pass && await masterVerifier()) {
      const master = await ensureMaster();
      if (!master) {
        flash('Master password required to update the password', true);
        return;
      }
      writes[key('user.pass', selectedId)] = await encryptText(pass, master);
    }
    else {
      writes[key('user.pass', selectedId)] = pass;
    }
  }
  if (draft && draft.id === account.id) {
    account.order = accounts.reduce((max, a) => Math.max(max, a.order), -1) + 1;
    accounts.push(account);
    draft = null;
  }
  writes.accounts = accounts;
  await chrome.storage.local.set(writes);
  await chrome.storage.local.remove(key('email.showRemoteContent', selectedId));
  if (passDirty) {
    // the client prefers the per-session plain password over the stored one;
    // drop it so the freshly saved password is picked up right away
    await chrome.storage.session.remove(key('user.pass', selectedId));
  }
  flash();
  render();
});

addBtn.addEventListener('click', async () => {
  if (draft) {
    flash('Save the current new account first', true);
    return;
  }
  draft = emptyAccount(-1, accounts.length === 0);
  await select(draft.id);
});

deleteBtn.addEventListener('click', async () => {
  const account = allAccounts().find(a => a.id === selectedId);
  if (!account) {
    return;
  }
  if (!confirm('Delete account "' + (account.label || 'Unnamed account') + '"?')) {
    return;
  }
  if (draft && draft.id === selectedId) {
    draft = null;
  }
  else {
    await chrome.storage.local.remove([...Object.keys(FIELDS), 'email.showRemoteContent'].map(name => key(name, selectedId)));
    // engine-discovered state the worker stamps outside the FIELDS set
    await chrome.storage.local.remove('sync.delimiter.' + selectedId);
    await chrome.storage.session.remove(key('user.pass', selectedId));
    accounts = accounts.filter(a => a.id !== selectedId);
  }
  allAccounts().sort(byOrder).forEach((a, i) => {
    a.order = i;
  });
  if (allAccounts().length && !allAccounts().some(a => a.primary)) {
    allAccounts()[0].primary = true;
  }
  if (!draft) {
    await chrome.storage.local.set({accounts});
  }
  selectedId = null;
  render();
  const next = allAccounts()[0];
  if (next) {
    await select(next.id);
  }
});

function wsMode() {
  return wsExternalEl.checked ? 'external' : 'native';
}

function updateWsUrlState() {
  wsUrlEl.disabled = !wsExternalEl.checked;
}

function flashGlobal(message = 'Saved', error = false) {
  globalSavedEl.textContent = message;
  globalSavedEl.className = error ? 'error' : '';
  globalSavedEl.hidden = false;
  clearTimeout(globalFlashTimer);
  globalFlashTimer = setTimeout(() => {
    globalSavedEl.hidden = true;
  }, 1500);
}

async function loadGlobalPrefs() {
  const res = await chrome.storage.local.get({
    'storage.mode': 'opfs',
    'ws.mode': 'native',
    'ws.url': '',
    'ws.debug': false,
    'mail.debug': false,
    'badge.debug': false,
    'offscreen.debug': false,
    'bridge.debug': false,
    'scheduler.debug': false,
    'ui.mailPageSize': 50,
    'ui.mailFlaggedTop': false,
    'mail.syncPrefetch': 'all',
    'badge.enabled': true,
    'badge.maxAge': 0,
    'picker.autoOpen': true,
    'sync.auto.enabled': true,
    'sync.auto.fullEnabled': true,
    'sync.auto.fullInterval': 900,
    'sync.auto.dirtyEnabled': true,
    'sync.auto.dirtyDelay': 60,
    'sync.auto.idleEnabled': true
  });
  storageOpfsEl.checked = res['storage.mode'] !== MODE_EXTERNAL;
  storageExternalEl.checked = res['storage.mode'] === MODE_EXTERNAL;
  initialStorageMode = storageOpfsEl.checked ? 'opfs' : MODE_EXTERNAL;
  wsExternalEl.checked = res['ws.mode'] === 'external';
  wsNativeEl.checked = !wsExternalEl.checked;
  wsNativeEl.checked = !wsExternalEl.checked;
  wsUrlEl.value = res['ws.url'] || '';
  wsDebugEl.checked = !!res['ws.debug'];
  mailDebugEl.checked = !!res['mail.debug'];
  badgeDebugEl.checked = !!res['badge.debug'];
  offscreenDebugEl.checked = !!res['offscreen.debug'];
  bridgeDebugEl.checked = !!res['bridge.debug'];
  schedulerDebugEl.checked = !!res['scheduler.debug'];
  pageSizeEl.value = res['ui.mailPageSize'];
  flaggedTopEl.checked = !!res['ui.mailFlaggedTop'];
  syncPrefetchEl.value = ['all', 200, 50, 20].map(String).includes(String(res['mail.syncPrefetch']))
    ? String(res['mail.syncPrefetch'])
    : 'all';
  badgeEnabledEl.checked = res['badge.enabled'] !== false;
  badgeMaxAgeEl.value = BADGE_MAX_AGES.includes(Number(res['badge.maxAge']))
    ? String(Number(res['badge.maxAge']))
    : '0';
  pickerAutoOpenEl.checked = res['picker.autoOpen'] !== false;
  syncAutoEnabledEl.checked = res['sync.auto.enabled'] !== false;
  syncFullEnabledEl.checked = res['sync.auto.fullEnabled'] !== false;
  syncFullIntervalEl.value =
    Math.max(5, Math.round(Number(res['sync.auto.fullInterval']) / 60) || 15);
  syncDirtyEnabledEl.checked = res['sync.auto.dirtyEnabled'] !== false;
  syncDirtyDelayEl.value = Math.max(10, Number(res['sync.auto.dirtyDelay']) || 60);
  syncIdleEnabledEl.checked = res['sync.auto.idleEnabled'] !== false;
  updateSyncAutoUi();
  updateWsUrlState();
  updateStorageUi(); // async status line: no await, it lands when the query returns
}

for (const el of [wsNativeEl, wsExternalEl]) {
  el.addEventListener('change', updateWsUrlState);
}

// disables the interval inputs whose checkbox is unchecked; the master
// switch greys out the two sub-switches and inputs as a whole
function updateSyncAutoUi() {
  const master = syncAutoEnabledEl.checked;
  syncFullEnabledEl.disabled = !master;
  syncDirtyEnabledEl.disabled = !master;
  syncIdleEnabledEl.disabled = !master;
  syncFullIntervalEl.disabled = !master || !syncFullEnabledEl.checked;
  syncDirtyDelayEl.disabled = !master || !syncDirtyEnabledEl.checked;
}

syncAutoEnabledEl.addEventListener('change', updateSyncAutoUi);
syncFullEnabledEl.addEventListener('change', updateSyncAutoUi);
syncDirtyEnabledEl.addEventListener('change', updateSyncAutoUi);
syncIdleEnabledEl.addEventListener('change', updateSyncAutoUi);

saveGlobalBtn.addEventListener('click', async () => {
  const url = wsUrlEl.value.trim();
  const mode = wsMode();
  const nextStorageMode = storageMode();
  if (nextStorageMode === MODE_EXTERNAL && !(await externalStorageReady())) {
    flashGlobal('Pick a usable directory or switch back to browser storage', true);
    return;
  }
  if (mode === 'external' && !/^wss?:\/\//.test(url)) {
    flashGlobal('Enter a valid ws:// or wss:// URL', true);
    return;
  }
  if (mode === 'external') {
    // host permission patterns only accept http(s); ws -> http, wss -> https
    const origin = new URL(url.replace(/^ws/i, 'http')).origin;
    const granted = await chrome.permissions.request({
      origins: [origin + '/*']
    });
    if (!granted) {
      flashGlobal('Permission for ' + origin + ' denied', true);
      return;
    }
  }
  const pageSize = pageSizeEl.value.trim() === '' ? 50 : Number(pageSizeEl.value);
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 500) {
    flashGlobal('Emails per page must be an integer between 1 and 500', true);
    return;
  }
  const syncFullInterval = (syncFullIntervalEl.value.trim() === '' ? 15 : Number(syncFullIntervalEl.value)) * 60;
  if (!Number.isInteger(syncFullInterval) || syncFullInterval < 300) {
    flashGlobal('Full sync interval must be at least 5 minutes', true);
    return;
  }
  const syncDirtyDelay = syncDirtyDelayEl.value.trim() === '' ? 60 : Number(syncDirtyDelayEl.value);
  if (!Number.isInteger(syncDirtyDelay) || syncDirtyDelay < 10) {
    flashGlobal('Dirty sync delay must be at least 10 seconds', true);
    return;
  }
  await chrome.storage.local.set({
    'storage.mode': nextStorageMode,
    'ws.mode': mode,
    'ws.url': url,
    'ws.debug': wsDebugEl.checked,
    'mail.debug': mailDebugEl.checked,
    'badge.debug': badgeDebugEl.checked,
    'offscreen.debug': offscreenDebugEl.checked,
    'bridge.debug': bridgeDebugEl.checked,
    'scheduler.debug': schedulerDebugEl.checked,
    'ui.mailPageSize': pageSize,
    'ui.mailFlaggedTop': flaggedTopEl.checked,
    'mail.syncPrefetch': ['all', 200, 50, 20].map(String).includes(syncPrefetchEl.value)
      ? (syncPrefetchEl.value === 'all' ? 'all' : Number(syncPrefetchEl.value))
      : 'all',
    'badge.enabled': badgeEnabledEl.checked,
    'badge.maxAge': BADGE_MAX_AGES.includes(Number(badgeMaxAgeEl.value))
      ? Number(badgeMaxAgeEl.value)
      : 0,
    'picker.autoOpen': pickerAutoOpenEl.checked,
    'sync.auto.enabled': syncAutoEnabledEl.checked,
    'sync.auto.fullEnabled': syncFullEnabledEl.checked,
    'sync.auto.fullInterval': syncFullInterval,
    'sync.auto.dirtyEnabled': syncDirtyEnabledEl.checked,
    'sync.auto.dirtyDelay': syncDirtyDelay,
    'sync.auto.idleEnabled': syncIdleEnabledEl.checked
  });
  // Clients gate the root through data/sync/disk.mjs on every call, but the
  // pages themselves hold stale state under a mode whose gate now answers
  // differently: a reload makes the change effective everywhere at once.
  if (nextStorageMode !== initialStorageMode) {
    flashGlobal('Saved — reloading…');
    setTimeout(() => location.reload(), 600);
    return;
  }
  flashGlobal();
});

// ---- Storage root ------------------------------------------------------------

function storageMode() {
  return storageExternalEl.checked ? MODE_EXTERNAL : 'opfs';
}

// Light check of the external handle for the status line: a permission query
// and the stored name only — no write probe (the gate re-probes at boot).
// OPFS mode needs nothing: the handle is always there and always writable.
async function updateStorageUi() {
  const external = storageMode() === MODE_EXTERNAL;
  pickStorageBtn.disabled = !external;
  grantStorageBtn.hidden = true;
  forgetStorageBtn.hidden = true;
  if (!external) {
    storageStatusEl.textContent = 'Mail will be stored in browser storage (the extension private storage) — nothing to pick or re-grant.';
    return;
  }
  const {handle, name} = await ownedRootHandle();
  if (!handle || !(handle instanceof FileSystemDirectoryHandle)) {
    storageStatusEl.textContent = 'No directory picked yet.';
    return;
  }
  const state = await handle.queryPermission({mode: 'readwrite'});
  forgetStorageBtn.hidden = false;
  if (state === 'prompt') {
    grantStorageBtn.hidden = false;
    storageStatusEl.textContent = 'Picked: ' + (name || 'the directory') + ' — access needs to be re-granted.';
  }
  else if (state === 'granted') {
    storageStatusEl.textContent = 'Picked: ' + (name || 'the directory') + ' — access confirmed.';
  }
  else {
    storageStatusEl.textContent = 'Picked: ' + (name || 'the directory') + ' — permission denied, pick the directory again.';
  }
}

for (const el of [storageOpfsEl, storageExternalEl]) {
  el.addEventListener('change', updateStorageUi);
}

pickStorageBtn.addEventListener('click', async () => {
  try {
    const handle = await window.showDirectoryPicker({mode: 'readwrite'});
    await persistRootHandle(handle, handle.name);
    await updateStorageUi();
  }
  catch (e) {
    if (e?.name !== 'AbortError') {
      storageStatusEl.textContent = 'Directory pick failed: ' + (e?.message || String(e));
    }
  }
});

grantStorageBtn.addEventListener('click', async () => {
  try {
    const {handle, name} = await ownedRootHandle();
    if (!handle) {
      return await updateStorageUi();
    }
    const result = await handle.requestPermission({mode: 'readwrite'});
    storageStatusEl.textContent = result === 'granted'
      ? 'Access granted for ' + (name || 'the directory') + '.'
      : 'Permission denied for ' + (name || 'the directory') + '.';
    await updateStorageUi();
  }
  catch (e) {
    storageStatusEl.textContent = 'Permission request failed: ' + (e?.message || String(e));
  }
});

forgetStorageBtn.addEventListener('click', async () => {
  await clearRootHandle();
  await updateStorageUi();
});

// A custom directory is the mode's only requirement: switching to it without
// a picked directory (or with a lapsed permission) blocks the save, since the
// handle can only be acquired through this page's or the picker's gesture.
function externalStorageReady() {
  if (storageMode() !== MODE_EXTERNAL) {
    return true;
  }
  return (async () => {
    const {handle} = await ownedRootHandle();
    if (!handle || !(handle instanceof FileSystemDirectoryHandle)) {
      storageStatusEl.textContent = 'Pick a custom directory first (or switch back to browser storage).';
      return false;
    }
    return (await handle.queryPermission({mode: 'readwrite'})) === 'granted';
  })();
}

// ---- Preferences backup: export / import chrome.storage.local ----

// The whole extension state lives in chrome.storage.local (accounts, per-
// account fields, ui.* prefs, ws/badge settings and action overrides).
// Exports wrap it in a versioned envelope; imports either merge (overwrite
// the keys present in the file) or replace (clear storage first), and reload
// the page afterwards so every panel re-reads the new values.

const EXPORT_APP = 'libre-email-client';
const EXPORT_KIND = 'preferences';
const EXPORT_VERSION = 1;
const PASSWORD_PREFIX = 'user.pass.';

const exportPrefsBtn = document.getElementById('export-prefs');
const importPrefsBtn = document.getElementById('import-prefs');
const importFileEl = document.getElementById('import-file');
const choiceDialog = document.getElementById('choice-dialog');
const choiceMessage = document.getElementById('choice-message');
const choiceButtons = document.getElementById('choice-buttons');

let choicePending = null;

// Ask the user to pick one of the given {label, value} buttons. Resolves
// with the chosen value, or null when the dialog is dismissed (Esc).
function askChoice(message, buttons) {
  return new Promise(resolve => {
    if (choicePending) {
      resolve(null);
      return;
    }
    choiceMessage.textContent = message;
    choiceButtons.replaceChildren(...buttons.map(({label, value}) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      button.addEventListener('click', () => settleChoice(value));
      return button;
    }));
    choicePending = resolve;
    choiceDialog.showModal();
    choiceButtons.querySelector('button')?.focus();
  });
}

function settleChoice(result) {
  const resolve = choicePending;
  if (!resolve) {
    return;
  }
  choicePending = null;
  if (choiceDialog.open) {
    choiceDialog.close();
  }
  resolve(result);
}

choiceDialog.addEventListener('cancel', e => {
  e.preventDefault();
  settleChoice(null);
});

choiceDialog.addEventListener('close', () => {
  if (choicePending) {
    settleChoice(null);
  }
});

exportPrefsBtn.addEventListener('click', async () => {
  const all = await chrome.storage.local.get(null);
  // With a master password the stored passwords are encrypted, so a full
  // export is safe. Without one they are plain text: ask first. The master
  // hash is useless without the passwords, so it follows them.
  let includePasswords = 'master.hash' in all;
  if (!includePasswords) {
    const choice = await askChoice(
      'No master password is configured, so account passwords would be exported as plain text. Include them?',
      [
        {label: 'Include passwords', value: 'yes'},
        {label: 'Skip passwords', value: 'no'}
      ]
    );
    if (choice === null) {
      return;
    }
    includePasswords = choice === 'yes';
  }
  const data = {};
  for (const [name, value] of Object.entries(all)) {
    if (!includePasswords && (name === 'master.hash' || name.startsWith(PASSWORD_PREFIX))) {
      continue;
    }
    data[name] = value;
  }
  const payload = {
    app: EXPORT_APP,
    kind: EXPORT_KIND,
    version: EXPORT_VERSION,
    exported: new Date().toISOString(),
    data
  };
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], {type: 'application/json'}));
  const link = document.createElement('a');
  link.href = url;
  link.download = EXPORT_APP + '-preferences-' + stamp + '.json';
  link.click();
  URL.revokeObjectURL(url);
  flashGlobal('Exported ' + Object.keys(data).length + ' settings');
});

importPrefsBtn.addEventListener('click', () => {
  importFileEl.click();
});

importFileEl.addEventListener('change', async () => {
  const file = importFileEl.files?.[0];
  importFileEl.value = ''; // allow re-picking the same file later
  if (!file) {
    return;
  }
  let payload;
  try {
    payload = JSON.parse(await file.text());
  }
  catch {
    flashGlobal('Import failed: the file is not valid JSON', true);
    return;
  }
  if (!payload || typeof payload !== 'object' || payload.app !== EXPORT_APP
    || payload.kind !== EXPORT_KIND || payload.version !== EXPORT_VERSION
    || !payload.data || typeof payload.data !== 'object' || Array.isArray(payload.data)) {
    flashGlobal('Import failed: not a preferences export of this extension', true);
    return;
  }
  const choice = await askChoice(
    'Import ' + Object.keys(payload.data).length + ' settings from "' + file.name + '"?',
    [
      {label: 'Merge with current settings', value: 'merge'},
      {label: 'Replace everything', value: 'replace'}
    ]
  );
  if (choice === null) {
    return;
  }
  if (choice === 'replace') {
    await chrome.storage.local.clear();
  }
  await chrome.storage.local.set(payload.data);
  // reload so every tab/panel and cached pref re-reads the new values
  location.reload();
});

// ---- Badge counter: status of the worker's last check + manual trigger ----

function renderBadgeStatus(result) {
  if (result === undefined) {
    badgeStatusEl.textContent = 'Not checked yet.';
    return;
  }
  if (!result) {
    badgeStatusEl.textContent = '';
    return;
  }
  const cut = (text, max) => {
    const s = String(text || '').replace(/\s+/g, ' ').trim();
    return s.length > max ? s.slice(0, max - 1) + '…' : s;
  };
  const lines = [];
  for (const a of result.accounts) {
    if (a.error) {
      lines.push(a.label + ': ' + a.detail);
    }
    else if (a.count > 0) {
      lines.push(a.label + ': ' + a.count + (a.detail ? ' (' + a.detail + ')' : ''));
      for (const s of (a.subjects || [])) {
        lines.push(s.subject ? cut(s.subject, 60) : '(no subject)');
      }
      if (a.more > 0) {
        lines.push('… +' + a.more + ' more');
      }
    }
    else {
      lines.push(a.label + ': 0');
    }
  }
  const when = new Date(result.time).toLocaleTimeString();
  badgeStatusEl.textContent = 'Last check ' + when + ' — ' + result.total + ' new' +
    (lines.length ? '\n' + lines.join('\n') : '\nNo badge-enabled accounts.');
}

async function refreshBadgeStatus() {
  // badge.last lives in storage.local so it also answers after a restart
  const {['badge.last']: last} = await chrome.storage.local.get('badge.last');
  renderBadgeStatus(last);
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && 'badge.last' in changes) {
    renderBadgeStatus(changes['badge.last'].newValue);
  }
});

checkBadgeBtn.addEventListener('click', async () => {
  if (!badgeEnabledEl.checked) {
    badgeStatusEl.textContent = 'Badge counter is disabled.';
    return;
  }
  badgeStatusEl.textContent = 'Syncing + checking…';
  try {
    const response = await chrome.runtime.sendMessage({type: 'badge-check'});
    if (response?.ok && response.result) {
      renderBadgeStatus(response.result);
    }
    else {
      badgeStatusEl.textContent = 'Check failed: ' + (response?.error || 'no response');
    }
  }
  catch (e) {
    badgeStatusEl.textContent = 'Check failed: ' + (e?.message || String(e));
  }
});

// ---- Actions tab: override Spam/Archive/Trash with a native "save to disk" ----

const ACTIONS = ['spam', 'archive', 'trash'];
const ACTION_LABELS = {spam: 'Spam', archive: 'Archive', trash: 'Trash'};
const actionEls = Object.fromEntries(ACTIONS.map(action => [action, {
  enabled: document.getElementById('f-' + action + '-enabled'),
  path: document.getElementById('f-' + action + '-path'),
  remove: document.getElementById('f-' + action + '-delete')
}]));
const nativeStatusEl = document.getElementById('native-status');
const checkNativeBtn = document.getElementById('check-native');
const saveActionsBtn = document.getElementById('save-actions');
const actionsSavedEl = document.getElementById('actions-saved');
let actionsFlashTimer = null;
let nativeInstalled = false;

const overrideKey = (action, name) => 'override.' + action + '.' + name;

function isAbsolutePath(p) {
  return /^\/|^[A-Za-z]:[\\/]/.test(p);
}

// Every control stays disabled until the probe confirms the native host;
// the enable checkbox gates the path and the delete checkbox in turn.
function updateActionInputs() {
  for (const action of ACTIONS) {
    const {enabled, path, remove} = actionEls[action];
    enabled.disabled = !nativeInstalled;
    const on = nativeInstalled && enabled.checked;
    path.disabled = !on;
    remove.disabled = !on;
  }
  saveActionsBtn.disabled = !nativeInstalled;
}

function flashActions(message = 'Saved', error = false) {
  actionsSavedEl.textContent = message;
  actionsSavedEl.className = error ? 'error' : '';
  actionsSavedEl.hidden = false;
  clearTimeout(actionsFlashTimer);
  actionsFlashTimer = setTimeout(() => {
    actionsSavedEl.hidden = true;
  }, 2000);
}

async function loadActionsPrefs() {
  const defaults = {};
  for (const action of ACTIONS) {
    defaults[overrideKey(action, 'enabled')] = false;
    defaults[overrideKey(action, 'path')] = '';
    defaults[overrideKey(action, 'delete')] = false;
  }
  const res = await chrome.storage.local.get(defaults);
  for (const action of ACTIONS) {
    const {enabled, path, remove} = actionEls[action];
    enabled.checked = !!res[overrideKey(action, 'enabled')];
    path.value = res[overrideKey(action, 'path')] || '';
    remove.checked = !!res[overrideKey(action, 'delete')];
    enabled.addEventListener('change', updateActionInputs);
  }
  updateActionInputs();
}

async function probeNative() {
  nativeStatusEl.textContent = 'Checking for the native client…';
  nativeStatusEl.classList.remove('error');
  let state;
  try {
    state = await detectNativeClient();
  }
  catch (e) {
    state = {installed: false, error: e?.message || String(e)};
  }
  nativeInstalled = state.installed;
  nativeStatusEl.textContent = state.installed
    ? 'Native client detected — Spam, Archive and Trash can save raw emails to a local directory.'
    : 'Native client not available: ' + state.error;
  nativeStatusEl.classList.toggle('error', !state.installed);
  updateActionInputs();
}

checkNativeBtn.addEventListener('click', () => {
  probeNative();
});

saveActionsBtn.addEventListener('click', async () => {
  const writes = {};
  for (const action of ACTIONS) {
    const {enabled, path, remove} = actionEls[action];
    const value = path.value.trim();
    if (enabled.checked) {
      if (!value) {
        flashActions('Destination directory for ' + ACTION_LABELS[action] + ' is required', true);
        return;
      }
      if (!isAbsolutePath(value)) {
        flashActions('Destination for ' + ACTION_LABELS[action] + ' must be an absolute path', true);
        return;
      }
    }
    writes[overrideKey(action, 'enabled')] = enabled.checked;
    writes[overrideKey(action, 'path')] = value;
    writes[overrideKey(action, 'delete')] = enabled.checked && remove.checked;
  }
  await chrome.storage.local.set(writes);
  flashActions();
});

// ---- Filters tab: editing, storage and ordering of filter rules ----

// A filter is {id, enabled, accountId('' = all), query, folder, createFolder,
// description}. This page only writes the list to chrome.storage.local
// ('filters') and lets the user reorder it with up/down buttons;
// matching/moving is the background worker's job.

const ffInputs = {
  account: document.getElementById('ff-account'),
  enabled: document.getElementById('ff-enabled'),
  query: document.getElementById('ff-query'),
  folder: document.getElementById('ff-folder'),
  createFolder: document.getElementById('ff-create-folder'),
  description: document.getElementById('ff-description')
};
const filterEditorEl = document.getElementById('filter-editor');
const filterFormEl = document.getElementById('filter-form');
const filterListEl = document.getElementById('filter-list');
const filterListEmptyEl = document.getElementById('filter-list-empty');
const addFilterBtn = document.getElementById('add-filter');
const cancelFilterBtn = document.getElementById('cancel-filter');
const filterSavedEl = document.getElementById('filter-saved');

let filters = [];
let editingFilter = null; // filter object being edited, or null
let filtersFlashTimer = null;

function renderFilterAccounts() {
  const selectEl = ffInputs.account;
  selectEl.textContent = '';
  const all = document.createElement('option');
  all.value = '';
  all.textContent = 'All accounts';
  selectEl.append(all);
  for (const account of allAccounts().sort(byOrder)) {
    const option = document.createElement('option');
    option.value = account.id;
    option.textContent = account.label || 'Unnamed account';
    selectEl.append(option);
  }
}

// One-line summary of the rule: multi-line queries (line-per-rule, lines act
// as OR) render their lines joined with " | ". A user-entered description
// takes over the row text; without one the fallback says where the query
// moves the mail. The generated rule → target string stays available as
// the row's tooltip either way.
function describeFilter(filter) {
  const rule = typeof filter.query !== 'string'
    ? 'old format — edit and save again'
    : (filter.query.split(/\r?\n/).map(line => line.trim()).filter(Boolean).join(' | ') || 'every message');
  const tip = rule + ' → move to ' + filter.folder;
  const text = filter.description || "Your query moves to '" + filter.folder + "' (remote folder)";
  return {text, tip};
}

// The filter's folder is the raw SERVER folder name (matched against the
// sync snapshot and moved by the engine as-is), but the editor hint has
// users type '/'-separated paths. The engine reports each account's real
// hierarchy delimiter after every survey ('sync.delimiter.<id>', stamped
// by the service worker), so typed separators are mapped onto it here —
// 'Work/Projects' lands as 'Work.Projects' on '.'-delimiter servers.
// Without a known delimiter (all-accounts filters, never-synced accounts)
// the input is stored exactly as typed.
async function accountDelimiter(accountId) {
  if (!accountId) {
    return null;
  }
  const res = await chrome.storage.local.get('sync.delimiter.' + accountId)
    .catch(() => ({}));
  return res['sync.delimiter.' + accountId] || null;
}

function normalizeFolderPath(path, delimiter) {
  if (!delimiter || delimiter === '/') {
    return path;
  }
  return path.split('/').join(delimiter);
}

// Rows are reordered with the up/down buttons; the array order is the
// evaluation order (first match wins), so every swap rewrites the 'filters'
// array and persists it immediately. Out-of-range moves are a no-op.
async function moveFilter(id, offset) {
  const index = filters.findIndex(f => f.id === id);
  const swap = index + offset;
  if (index < 0 || swap < 0 || swap >= filters.length) {
    return;
  }
  [filters[index], filters[swap]] = [filters[swap], filters[index]];
  await persistFilters();
  renderFilterList();
}

function renderFilterList() {
  filterListEl.textContent = '';
  filterListEmptyEl.hidden = filters.length > 0;
  for (const filter of filters) {
    const row = document.createElement('div');
    row.className = 'filter-row' + (filter.enabled ? '' : ' disabled');

    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.title = 'Enabled';
    toggle.checked = !!filter.enabled;
    toggle.addEventListener('change', async () => {
      filter.enabled = toggle.checked;
      await persistFilters();
      renderFilterList();
    });

    const summary = document.createElement('p');
    summary.className = 'summary';
    const target = filter.accountId
      ? (allAccounts().find(a => a.id === filter.accountId)?.label || 'Missing account')
      : 'All accounts';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = target;
    const {text, tip} = describeFilter(filter);
    summary.title = tip;
    const desc = document.createElement('span');
    desc.className = 'desc';
    desc.textContent = ' — ' + text;
    summary.append(name, desc);

    const index = filters.indexOf(filter);

    const up = document.createElement('button');
    up.type = 'button';
    up.className = 'move';
    up.textContent = '↑';
    up.title = 'Move up';
    up.disabled = index === 0;
    up.addEventListener('click', () => moveFilter(filter.id, -1));

    const down = document.createElement('button');
    down.type = 'button';
    down.className = 'move';
    down.textContent = '↓';
    down.title = 'Move down';
    down.disabled = index === filters.length - 1;
    down.addEventListener('click', () => moveFilter(filter.id, 1));

    const edit = document.createElement('button');
    edit.type = 'button';
    edit.textContent = 'Edit';
    edit.addEventListener('click', () => openFilterEditor(filter));

    const del = document.createElement('button');
    del.type = 'button';
    del.textContent = 'Delete';
    del.addEventListener('click', async () => {
      if (!confirm('Delete this filter?')) {
        return;
      }
      filters = filters.filter(f => f.id !== filter.id);
      if (editingFilter === filter) {
        closeFilterEditor();
      }
      await persistFilters();
      renderFilterList();
    });

    row.append(toggle, summary, up, down, edit, del);
    filterListEl.append(row);
  }
}

function openFilterEditor(filter) {
  editingFilter = filter;
  renderFilterAccounts();
  ffInputs.enabled.checked = filter.enabled !== false;
  // legacy filters (old format) open with an empty query
  ffInputs.query.value = typeof filter.query === 'string' ? filter.query : '';
  ffInputs.folder.value = filter.folder || '';
  ffInputs.createFolder.checked = !!filter.createFolder;
  ffInputs.description.value = filter.description || '';
  ffInputs.account.value = '';
  for (const option of ffInputs.account.options) {
    if (option.value === (filter.accountId || '')) {
      ffInputs.account.value = option.value;
      break;
    }
  }
  filterEditorEl.hidden = false;
  ffInputs.query.focus();
}

function closeFilterEditor() {
  editingFilter = null;
  filterEditorEl.hidden = true;
}

async function persistFilters() {
  await chrome.storage.local.set({filters});
}

function flashFilter(message = 'Saved', error = false) {
  filterSavedEl.textContent = message;
  filterSavedEl.className = error ? 'error' : '';
  filterSavedEl.hidden = false;
  clearTimeout(filtersFlashTimer);
  filtersFlashTimer = setTimeout(() => {
    filterSavedEl.hidden = true;
  }, 2000);
}

addFilterBtn.addEventListener('click', () => {
  openFilterEditor({id: uid(), enabled: true, accountId: '', query: '', folder: '', createFolder: false});
});

cancelFilterBtn.addEventListener('click', closeFilterEditor);

filterFormEl.addEventListener('submit', async e => {
  e.preventDefault();
  if (!editingFilter) {
    return;
  }
  const folder = ffInputs.folder.value.trim();
  if (!folder) {
    flashFilter('Destination folder is required', true);
    return;
  }
  editingFilter.query = ffInputs.query.value;
  editingFilter.folder =
    normalizeFolderPath(folder, await accountDelimiter(ffInputs.account.value));
  editingFilter.createFolder = ffInputs.createFolder.checked;
  editingFilter.description = ffInputs.description.value.trim();
  editingFilter.accountId = ffInputs.account.value;
  editingFilter.enabled = ffInputs.enabled.checked;

  if (!filters.some(f => f.id === editingFilter.id)) {
    filters.push(editingFilter);
  }
  await persistFilters();
  closeFilterEditor();
  renderFilterList();
  flashFilter();
});

async function loadFiltersPrefs() {
  const res = await chrome.storage.local.get({filters: []});
  filters = Array.isArray(res.filters) ? res.filters : [];
}

function flashMaster(message = 'Saved', error = false) {
  masterSavedEl.textContent = message;
  masterSavedEl.className = error ? 'error' : '';
  masterSavedEl.hidden = false;
  clearTimeout(masterFlashTimer);
  masterFlashTimer = setTimeout(() => {
    masterSavedEl.hidden = true;
  }, 2500);
}

async function updateMasterState() {
  const configured = !!(await masterVerifier());
  masterEl.placeholder = configured
    ? 'Configured — type a new password to change it, clear to remove'
    : 'Not configured';
  clearMasterBtn.disabled = !configured;
}

// Drops the master password (session value first, so the service worker's
// storage.onChanged listener decrypts with the old master, then the verifier)
// and decrypts all saved account passwords back to plain text.
async function removeMasterPassword(current) {
  await chrome.storage.session.remove(MASTER_PASS);
  await chrome.storage.local.remove(MASTER_HASH);
  await reencryptStoredPasswords(current, '');
}

// Setting/changing: the session value is written first so the service
// worker's storage.onChanged listener starts re-encrypting in parallel; the
// page then re-encrypts as well (the shared helper is idempotent) before the
// verifier in local storage is confirmed, so "Saved" reflects completed work.
// Removing: the session value is dropped first so the listener decrypts
// everything with the old master, then the verifier is deleted.
saveMasterBtn.addEventListener('click', async () => {
  const next = masterEl.value;
  const verifier = await masterVerifier();
  if (!next && !verifier) {
    flashMaster('Nothing to save', true);
    return;
  }
  let current = null;
  if (verifier) {
    current = await confirmCurrentMaster();
    if (!current) {
      flashMaster('Enter the current master password to continue', true);
      return;
    }
  }
  if (next && next === current) {
    await reencryptStoredPasswords(current, next); // heal any stragglers
    flashMaster('Unchanged');
    masterEl.value = '';
    updateMasterState();
    return;
  }
  if (next) {
    await chrome.storage.session.set({[MASTER_PASS]: next});
    await chrome.storage.local.set({[MASTER_HASH]: await hashMaster(next)});
    await reencryptStoredPasswords(current || '', next);
    flashMaster('Saved — passwords re-encrypted');
  }
  else {
    await removeMasterPassword(current);
    flashMaster('Saved — passwords decrypted');
  }
  masterEl.value = '';
  updateMasterState();
});

clearMasterBtn.addEventListener('click', async () => {
  const verifier = await masterVerifier();
  if (!verifier) {
    flashMaster('No master password configured', true);
    return;
  }
  const current = await confirmCurrentMaster();
  if (!current) {
    flashMaster('Enter the current master password to continue', true);
    return;
  }
  await removeMasterPassword(current);
  flashMaster('Removed — passwords decrypted');
  updateMasterState();
});

(async () => {
  await loadGlobalPrefs();
  await loadActionsPrefs();
  await probeNative();
  await updateMasterState();
  await refreshBadgeStatus();
  await loadFiltersPrefs();
  await loadAccounts();
  if (accounts.length === 0) {
    draft = emptyAccount(0, true);
    await select(draft.id);
  }
  else {
    const primary = accounts.find(a => a.primary) || accounts[0];
    await select(primary.id);
  }
  renderFilterList();
})();
