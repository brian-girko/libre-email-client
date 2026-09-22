// data/explorer/index.js — standalone tab page that browses the storage root
// of the extension (data/explorer). The root comes from the shared storage
// plumbing of data/sync/root-handle.mjs: the extension's own origin-private
// storage (OPFS, the default) or the external directory handle the picker
// interface (data/picker) granted and persisted.
//
// The page is deliberately independent: it imports nothing from the mail
// client, sync client, options or picker interfaces (the shared theme
// plumbing of data/client is the one exception). It is a list view —
// directories first, then files, with a clickable breadcrumb. A single
// click only selects an entry (Ctrl/Cmd+click toggles, Shift+click
// ranges, Space toggles the focused row); a double click opens it —
// directories are entered, files are downloaded. The toolbar offers
// download, delete and rename for the selection plus always-available
// new-folder and import actions. Write access is requested lazily on the
// first mutating action.

'use strict';

import {initTheme} from '/data/client/theme.mjs';
import {
  MODE_EXTERNAL,
  getStorageMode,
  opfsRoot,
  ownedRootHandle
} from '../sync/root-handle.mjs';

const shell = document.getElementById('shell');
const listing = document.getElementById('listing');
const breadcrumb = document.getElementById('breadcrumb');
const statusEl = document.getElementById('status');

const gate = document.getElementById('gate');
const gateStatus = document.getElementById('gate-status');
const gateRoot = document.getElementById('gate-root');
const grantBtn = document.getElementById('grant');

const toolbar = document.getElementById('toolbar');
const downloadBtn = document.getElementById('download-btn');
const renameBtn = document.getElementById('rename-btn');
const deleteBtn = document.getElementById('delete-btn');
const newFolderBtn = document.getElementById('new-folder-btn');
const newFolderForm = document.getElementById('new-folder-form');
const newFolderName = document.getElementById('new-folder-name');
const newFolderCreate = document.getElementById('new-folder-create');
const newFolderCancel = document.getElementById('new-folder-cancel');
const importBtn = document.getElementById('import-btn');
const importInput = document.getElementById('import-input');

const e2msg = e => e?.message || String(e);

// The icons come from images/directory.svg and images/file.svg, inlined here
// so the rows need no network requests and can inherit the text color.
const DIR_SVG = '<svg viewBox="0 0 36 36" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path fill="currentColor" d="M30,9H16.42L14.11,5.82A2,2,0,0,0,12.49,5H6A2,2,0,0,0,4,7V29a2,2,0,0,0,2,2H30a2,2,0,0,0,2-2V11A2,2,0,0,0,30,9Zm0,20H6V13h7.31a2,2,0,0,0,2-2H6V7h6.49l2.61,3.59a1,1,0,0,0,.81.41H30Z"/></svg>';
const FILE_SVG = '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M19 9V17.8C19 18.9201 19 19.4802 18.782 19.908C18.5903 20.2843 18.2843 20.5903 17.908 20.782C17.4802 21 16.9201 21 15.8 21H8.2C7.07989 21 6.51984 21 6.09202 20.782C5.71569 20.5903 5.40973 20.2843 5.21799 19.908C5 19.4802 5 18.9201 5 17.8V6.2C5 5.07989 5 4.51984 5.21799 4.09202C5.40973 3.71569 5.71569 3.40973 6.09202 3.21799C6.51984 3 7.0799 3 8.2 3H13M19 9L13 3M19 9H14C13.4477 9 13 8.55228 13 8V3" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function iconSpan(svg) {
  const icon = document.createElement('span');
  icon.className = 'icon';
  icon.innerHTML = svg;
  return icon;
}

// The current traversal state: an array of directory handles from the root
// to the displayed directory, plus the display name of the root.
let rootName = '';
let path = []; // [dirHandle, ...], empty = root itself

// Selection state: names of the selected entries within the current
// directory, the listed entries themselves, and the shift-range anchor.
let selection = new Set();
let currentEntries = [];
let anchorIndex = -1;

function setGateStatus(text, ok) {
  gateStatus.textContent = text;
  gateStatus.className = ok ? 'ok' : 'bad';
}

function setStatus(text, cls) {
  statusEl.textContent = text;
  statusEl.className = cls || '';
}

function sizeText(size) {
  if (size < 1024) {
    return size + ' B';
  }
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = size;
  let unit = 'KB';
  for (let i = 0; i < units.length; i++) {
    value /= 1024;
    unit = units[i];
    if (value < 1024) {
      break;
    }
  }
  return value.toFixed(1) + ' ' + unit;
}

// ---- gated boot ------------------------------------------------------------
//
// Access checks run without the write probe: the picker verifies the handle
// before the visit, and the explorer reads without write access until the
// first mutating toolbar action. A lapsed permission shows the
// single-gesture re-grant button here.

async function resolveRoot() {
  const mode = await getStorageMode();
  if (mode !== MODE_EXTERNAL) {
    // OPFS: the handle is always granted
    return {handle: await opfsRoot(), name: 'browser storage'};
  }
  const {handle, name} = await ownedRootHandle();
  if (!handle || !(handle instanceof FileSystemDirectoryHandle)) {
    return {error: 'no-root'};
  }
  const state = await handle.queryPermission({mode: 'read'});
  if (state === 'granted') {
    return {handle, name: name || 'the directory'};
  }
  if (state === 'prompt') {
    return {handle, name: name || 'the directory', needsGrant: true};
  }
  return {error: 'denied'};
}

function showGate(text, ok) {
  gate.hidden = false;
  shell.hidden = true;
  setGateStatus(text, ok);
}

async function bootGate() {
  grantBtn.hidden = true;
  let state;
  try {
    state = await resolveRoot();
  }
  catch (e) {
    return showGate('Storage check failed: ' + e2msg(e), false);
  }
  if (state.error === 'no-root') {
    return showGate('No directory access granted yet — grant it in the picker interface first, or switch to internal storage in the options.', false);
  }
  if (state.error === 'denied') {
    return showGate('Permission denied for ' + (state.name || 'the directory') + '. Re-grant it in the picker interface.', false);
  }
  if (state.needsGrant) {
    gateRoot.textContent = state.name || '';
    gateRoot.hidden = !state.name;
    grantBtn.hidden = false;
    return showGate('Access needs to be re-granted for ' + (state.name || 'the directory') + '.', false);
  }
  start(state);
}

function start({handle, name}) {
  gate.hidden = true;
  shell.hidden = false;
  rootName = name;
  path = [handle];
  render();
}

grantBtn.addEventListener('click', async () => {
  grantBtn.disabled = true;
  try {
    const {handle, name} = await ownedRootHandle();
    if (!handle) {
      return showGate('No directory access granted yet — grant it in the picker interface first.', false);
    }
    const result = await handle.requestPermission({mode: 'read'});
    if (result !== 'granted') {
      return showGate('Permission denied for ' + (name || 'the directory') + '.', false);
    }
    start({handle, name});
  }
  catch (e) {
    showGate('Permission request failed: ' + e2msg(e), false);
  }
  finally {
    grantBtn.disabled = false;
  }
});

// ---- write access ----------------------------------------------------------
//
// Deleting, renaming, importing and creating folders need readwrite. OPFS
// grants it implicitly; for an external directory the browser prompt fires
// from the toolbar gesture that triggered the action.

async function ensureWriteAccess() {
  if (await getStorageMode() !== MODE_EXTERNAL) {
    return true;
  }
  const {handle} = await ownedRootHandle();
  if (!handle) {
    return false;
  }
  if (await handle.queryPermission({mode: 'readwrite'}) === 'granted') {
    return true;
  }
  return await handle.requestPermission({mode: 'readwrite'}) === 'granted';
}

// ---- the listing -----------------------------------------------------------

function currentDir() {
  return path[path.length - 1];
}

function currentName() {
  return rootName;
}

function resetSelection() {
  selection = new Set();
  anchorIndex = -1;
}

// The last crumb is plain text (the current directory, nothing to click);
// every earlier crumb is a clickable button that jumps back to that level.
function renderBreadcrumb() {
  breadcrumb.textContent = '';
  for (let i = 0; i < path.length; i++) {
    if (i) {
      const sep = document.createElement('span');
      sep.className = 'sep';
      sep.textContent = '/';
      breadcrumb.append(sep);
    }
    if (i === path.length - 1) {
      const here = document.createElement('span');
      here.className = 'here';
      here.textContent = i === 0 ? currentName() : path[i].name;
      breadcrumb.append(here);
      continue;
    }
    const label = i === 0 ? currentName() : path[i].name;
    const crumb = document.createElement('button');
    crumb.type = 'button';
    crumb.textContent = label;
    crumb.addEventListener('click', () => {
      resetSelection();
      path = path.slice(0, i + 1);
      render();
    });
    breadcrumb.append(crumb);
  }
}

function selectedEntries() {
  return currentEntries.filter(e => selection.has(e.name));
}

function syncSelectionClasses() {
  for (const row of listing.children) {
    row.classList.toggle('selected', selection.has(row.dataset.name));
  }
  updateToolbar();
}

function updateToolbar() {
  const count = selection.size;
  downloadBtn.disabled = !count;
  deleteBtn.disabled = !count;
  renameBtn.disabled = count !== 1;
}

function selectOnly(entry) {
  selection = new Set([entry.name]);
  anchorIndex = currentEntries.indexOf(entry);
  syncSelectionClasses();
}

function toggleSelect(entry) {
  if (selection.has(entry.name)) {
    selection.delete(entry.name);
  }
  else {
    selection.add(entry.name);
  }
  anchorIndex = currentEntries.indexOf(entry);
  syncSelectionClasses();
}

function rangeSelect(entry) {
  const to = currentEntries.indexOf(entry);
  if (to < 0 || anchorIndex < 0) {
    return selectOnly(entry);
  }
  const [from, end] = anchorIndex <= to ? [anchorIndex, to] : [to, anchorIndex];
  selection = new Set();
  for (let i = from; i <= end; i++) {
    selection.add(currentEntries[i].name);
  }
  syncSelectionClasses();
}

function enterDirectory(entry) {
  resetSelection();
  path = [...path, entry.handle];
  render();
}

function onRowClick(entry, e) {
  if (e.shiftKey) {
    return rangeSelect(entry);
  }
  if (e.ctrlKey || e.metaKey) {
    return toggleSelect(entry);
  }
  selectOnly(entry);
}

// Double-click opens: a directory is entered, a file is downloaded.
function onRowDblclick(entry) {
  if (entry.kind === 'directory') {
    return enterDirectory(entry);
  }
  downloadEntry(entry);
}

function onRowKeydown(entry, e) {
  if (e.key === 'Enter') {
    e.preventDefault();
    if (entry.kind === 'directory') {
      enterDirectory(entry);
    }
    else {
      downloadEntry(entry);
    }
  }
  else if (e.key === ' ') {
    e.preventDefault();
    toggleSelect(entry);
  }
}

async function listCurrent() {
  const entries = [];
  for await (const entry of currentDir().values()) {
    if (entry.name.startsWith('.')) {
      continue; // the tree's own probes and flags are not the user's files
    }
    entries.push({name: entry.name, kind: entry.kind, handle: entry});
  }
  entries.sort((a, b) => {
    if (a.kind !== b.kind) {
      return a.kind === 'directory' ? -1 : 1;
    }
    return a.name.localeCompare(b.name, undefined, {numeric: true});
  });
  return entries;
}

function renderRows(entries) {
  listing.textContent = '';
  if (path.length > 1) {
    const up = document.createElement('li');
    up.className = 'up';
    const icon = document.createElement('span');
    icon.className = 'icon';
    icon.textContent = '\u2191';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = '.. (parent directory)';
    up.append(icon, name);
    up.addEventListener('click', () => {
      resetSelection();
      path = path.slice(0, -1);
      render();
    });
    listing.append(up);
  }
  if (!entries.length) {
    const empty = document.createElement('li');
    const icon = document.createElement('span');
    icon.className = 'icon';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = path.length > 1 ? '' : '(empty directory)';
    empty.append(icon, name);
    empty.style.cursor = 'default';
    listing.append(empty);
    return;
  }
  for (const entry of entries) {
    const row = document.createElement('li');
    entry.row = row;
    row.dataset.name = entry.name;
    const icon = iconSpan(entry.kind === 'directory' ? DIR_SVG : FILE_SVG);
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = entry.name;
    const size = document.createElement('span');
    size.className = 'size';
    size.textContent = entry.kind === 'directory' ? '' : '…';
    if (entry.kind !== 'directory') {
      sizeTextLater(entry, size);
    }
    row.append(icon, name, size);
    row.tabIndex = 0;
    row.addEventListener('click', e => onRowClick(entry, e));
    row.addEventListener('dblclick', () => onRowDblclick(entry));
    row.addEventListener('keydown', e => onRowKeydown(entry, e));
    listing.append(row);
  }
}

// Sizes load lazily per row: OPFS lists can be huge and getFile() is a real
// syscall per file.
async function sizeTextLater(entry, node) {
  try {
    const file = await entry.handle.getFile();
    node.textContent = sizeText(file.size);
  }
  catch {
    node.textContent = '';
  }
}

let renderSeq = 0;

async function render() {
  const seq = ++renderSeq;
  renderBreadcrumb();
  listing.textContent = '';
  setStatus('Loading…', '');
  let entries;
  try {
    entries = await listCurrent();
  }
  catch (e) {
    resetSelection();
    updateToolbar();
    return setStatus('Could not read directory: ' + e2msg(e), 'bad');
  }
  if (seq !== renderSeq) {
    return; // the user navigated on while this listing ran
  }
  currentEntries = entries;
  const names = new Set(entries.map(e => e.name));
  for (const name of [...selection]) {
    if (!names.has(name)) {
      selection.delete(name);
    }
  }
  const dirs = entries.filter(e => e.kind === 'directory').length;
  renderRows(entries);
  syncSelectionClasses();
  setStatus(entries.length
    ? dirs + ' folders, ' + (entries.length - dirs) + ' files — single-click to select, double-click opens (folders) or downloads (files)'
    : 'empty directory', 'ok');
}

// ---- toolbar actions -------------------------------------------------------

function confirmList(names, question) {
  return window.confirm(question + '\n\n' + names.join('\n'));
}

async function deleteSelected() {
  const entries = selectedEntries();
  if (!entries.length) {
    return;
  }
  if (!await ensureWriteAccess()) {
    return setStatus('Write permission denied for the storage root.', 'bad');
  }
  const names = entries.map(e => e.name);
  if (!confirmList(names, 'Delete ' + (names.length > 1 ? names.length + ' items?' : '“' + names[0] + '”?') + ' This cannot be undone.')) {
    return;
  }
  const dir = currentDir();
  let failed = 0;
  for (const entry of entries) {
    try {
      await dir.removeEntry(entry.name, {recursive: true});
      selection.delete(entry.name);
    }
    catch (e) {
      failed++;
      setStatus('Could not delete ' + entry.name + ': ' + e2msg(e), 'bad');
    }
  }
  anchorIndex = -1;
  await render();
  if (!failed) {
    setStatus('Deleted ' + names.length + ' item' + (names.length > 1 ? 's' : ''), 'ok');
  }
}

async function downloadEntry(entry) {
  try {
    const file = await entry.handle.getFile();
    const url = URL.createObjectURL(file);
    const a = document.createElement('a');
    a.href = url;
    a.download = entry.name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    return true;
  }
  catch (e) {
    setStatus('Could not download ' + entry.name + ': ' + e2msg(e), 'bad');
    return false;
  }
}

async function downloadSelected() {
  const entries = selectedEntries();
  if (!entries.length) {
    return;
  }
  const files = entries.filter(e => e.kind === 'file');
  const skipped = entries.length - files.length;
  if (!files.length) {
    return setStatus('Nothing to download — folders are skipped, select files instead.', '');
  }
  let ok = 0;
  for (const entry of files) {
    if (await downloadEntry(entry)) {
      ok++;
      await new Promise(r => setTimeout(r, 250)); // pace the browser's download queue
    }
  }
  setStatus('Downloaded ' + ok + ' file' + (ok === 1 ? '' : 's') +
    (skipped ? ' — ' + skipped + ' folder' + (skipped > 1 ? 's' : '') + ' skipped' : ''), ok ? 'ok' : 'bad');
}

function startRename(entry) {
  const row = entry.row;
  if (!row) {
    return;
  }
  const nameEl = row.querySelector('.name');
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'rename-input';
  input.value = entry.name;
  nameEl.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = async commit => {
    if (done) {
      return;
    }
    done = true;
    const newName = input.value.trim();
    if (commit && newName && newName !== entry.name) {
      try {
        if (typeof entry.handle.move !== 'function') {
          throw new Error('this browser does not support renaming');
        }
        await entry.handle.move(newName);
        selection.delete(entry.name);
        selection.add(newName);
        anchorIndex = -1;
        await render();
        return setStatus('Renamed to ' + newName, 'ok');
      }
      catch (e) {
        setStatus('Rename failed: ' + e2msg(e), 'bad');
      }
    }
    render();
  };
  for (const event of ['click', 'keydown']) {
    input.addEventListener(event, e => e.stopPropagation());
  }
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      finish(true);
    }
    else if (e.key === 'Escape') {
      finish(false);
    }
  });
  input.addEventListener('blur', () => finish(false));
}

function hideNewFolderForm() {
  newFolderForm.hidden = true;
  newFolderBtn.hidden = false;
  newFolderName.value = '';
}

async function createNewFolder() {
  const name = newFolderName.value.trim();
  if (!name) {
    return;
  }
  if (!await ensureWriteAccess()) {
    return setStatus('Write permission denied for the storage root.', 'bad');
  }
  try {
    await currentDir().getDirectoryHandle(name, {create: true});
    hideNewFolderForm();
    await render();
    setStatus('Created folder ' + name, 'ok');
  }
  catch (e) {
    setStatus('Could not create folder: ' + e2msg(e), 'bad');
  }
}

async function importFiles(files) {
  if (!files.length) {
    return;
  }
  if (!await ensureWriteAccess()) {
    return setStatus('Write permission denied for the storage root.', 'bad');
  }
  const dir = currentDir();
  const conflicts = [];
  for (const file of files) {
    try {
      await dir.getFileHandle(file.name);
      conflicts.push(file.name);
    }
    catch {}
  }
  if (conflicts.length && !confirmList(conflicts, 'Overwrite existing ' + (conflicts.length > 1 ? conflicts.length + ' files?' : 'file?'))) {
    return setStatus('Import cancelled.', '');
  }
  let ok = 0;
  for (const file of files) {
    try {
      const handle = await dir.getFileHandle(file.name, {create: true});
      const writable = await handle.createWritable();
      await writable.write(file);
      await writable.close();
      ok++;
    }
    catch (e) {
      setStatus('Could not import ' + file.name + ': ' + e2msg(e), 'bad');
    }
  }
  await render();
  if (ok) {
    setStatus('Imported ' + ok + ' file' + (ok > 1 ? 's' : '') +
      (conflicts.length ? ' (' + conflicts.length + ' overwritten)' : ''), 'ok');
  }
}

deleteBtn.addEventListener('click', deleteSelected);
downloadBtn.addEventListener('click', downloadSelected);
renameBtn.addEventListener('click', () => {
  const entries = selectedEntries();
  if (entries.length === 1) {
    startRename(entries[0]);
  }
});

newFolderBtn.addEventListener('click', () => {
  newFolderForm.hidden = false;
  newFolderBtn.hidden = true;
  newFolderName.focus();
});
newFolderCancel.addEventListener('click', hideNewFolderForm);
newFolderForm.addEventListener('submit', e => {
  e.preventDefault();
  createNewFolder();
});
newFolderName.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    hideNewFolderForm();
  }
});

importBtn.addEventListener('click', () => importInput.click());
importInput.addEventListener('change', () => {
  const files = [...importInput.files];
  importInput.value = '';
  importFiles(files);
});

// ---- boot ------------------------------------------------------------------

initTheme();
bootGate();
