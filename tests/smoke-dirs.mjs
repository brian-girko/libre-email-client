#!/usr/bin/env node
// smoke-dirs.mjs — assertions for the add/delete folder feature. Statically
// checks the wiring in directory-view.js / dirs.mjs / mail.mjs / api.mjs and
// the test server, then replicates the helper semantics (deletable guard,
// nested name join) and asserts them against stub-server-like data.
//
//   node tests/smoke-dirs.mjs

import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const view = await readFile(new URL('../extension/data/client/components/directory-view.js', import.meta.url), 'utf8');
const host = await readFile(new URL('../extension/data/client/dirs.mjs', import.meta.url), 'utf8');
const wrapper = await readFile(new URL('../extension/data/client/mail.mjs', import.meta.url), 'utf8');
const facade = await readFile(new URL('../rust-client/js/api.mjs', import.meta.url), 'utf8');
const deployed = await readFile(new URL('../extension/core/rust-imap-client/api.mjs', import.meta.url), 'utf8');
const server = await readFile(new URL('../server/imap-test-server.mjs', import.meta.url), 'utf8');

// static wiring: directory-view component
assert.ok(view.includes('class="actions"'), 'bottom action bar exists');
assert.ok(view.includes('class="dir-btn add"'), '+ New (top-level) button exists');
assert.ok(view.includes('class="dir-btn add-sub"'), '+ Sub (subfolder) button exists');
assert.ok(view.includes('class="dir-btn delete"'), 'Delete button exists');
assert.ok(view.includes('detail: {parent: null, delimiter: null}'), '+ New always creates a top-level folder');
assert.ok(view.includes('detail: {parent: node.name, delimiter: node.delimiter ?? null}'), '+ Sub creates under the selected folder');
assert.ok(view.includes("new CustomEvent('create-dir'"), 'add buttons emit create-dir');
assert.ok(view.includes('confirm-dialog'), 'delete confirmation dialog exists');
assert.ok(view.includes('#confirmDialog.showModal()'), 'confirm dialog is shown modally');
assert.ok(view.includes("addEventListener('submit'"), 'confirm dialog confirms via submit');
assert.ok(view.includes("addEventListener('close'"), 'Esc/cancel resets the pending delete');
assert.ok(view.includes('#updateActions()'), 'button state follows the selection');

// static wiring: guards
assert.ok(view.includes("node.name.toUpperCase() !== 'INBOX'"), 'INBOX cannot be deleted');
assert.ok(view.includes('!node.children.length'), 'parent folders cannot be deleted');
assert.ok(view.includes('/\\\\Noinferiors/i'), 'Noinferiors folders refuse new subfolders');
assert.ok(view.includes('this.#subButton.disabled = !node || noInferiors'), 'subfolder button follows the selection');
assert.ok(view.includes('this.#addButton.disabled = false'), 'top-level button is always available');
assert.ok(view.includes('node.selectable'), 'non-selectable folders cannot be deleted');

// static wiring: host dirs.mjs
assert.ok(host.includes("el.addEventListener('create-dir'"), 'host listens for create-dir');
assert.ok(host.includes("el.addEventListener('delete-dir'"), 'host listens for delete-dir');
assert.ok(host.includes("getElementById('prompt').ask("), 'folder name asked via prompt-view');
assert.ok(host.includes('parent && delimiter ? parent + delimiter + name : name'), 'nested names join on the delimiter');
assert.ok(host.includes('await api.createDir(full)'), 'create runs through the api');
assert.ok(host.includes('await api.deleteDir(name)'), 'delete runs through the api');
assert.ok(host.includes('await setPref(dirKey(accountId), full)'), 'new folder becomes the selection');
assert.ok(host.includes('await load(accountId)'), 'tree reloads after both actions');

// delete flow: selection moves one up or the stale selection is cleared
assert.ok(view.includes('get selected()'), 'component exposes the current selection');
assert.ok(host.includes('el.selected === name'), 'delete only re-points the pref when the deleted folder was selected');
assert.ok(host.includes('parentName(name, el.dirs)'), 'parent resolved from the folder delimiter');
assert.ok(host.includes('setPref(dirKey(accountId), openable ? parent : null)'), 'pref moves to the parent or is cleared');
assert.ok(host.includes('/\\\\noselect/i'), 'Noselect parents are not restored as the selection');
assert.ok(host.includes("/no such mailbox|nonexistent|does ?not exist|doesn't exist|unknown mailbox/i"), 'already-gone deletes are treated as done');
assert.ok(host.includes('await setPref(dirKey(id), null)'), 'load clears a stale saved selection');
assert.ok(host.includes("d.name.toUpperCase() === 'INBOX'"), 'load falls back to INBOX first');

// static wiring: reconnect wrapper (mutation semantics)
assert.ok(wrapper.includes('createDir(name)'), 'wrapper delegates createDir');
assert.ok(wrapper.includes('api.createDir(name), true'), 'createDir is a mutating op (no blind retry)');
assert.ok(wrapper.includes('deleteDir(name)'), 'wrapper delegates deleteDir');
assert.match(
  wrapper,
  /deleteDir\(name\) \{\s*return retried\(async api => \{[\s\S]*?\}, true\);/,
  'deleteDir is a mutating op'
);
assert.ok(wrapper.includes('if (selected === name)'), 'wrapper drops a deleted open dir');

// static wiring: facade (source and deployed copy)
for (const [label, src] of [['source', facade], ['deployed', deployed]]) {
  assert.ok(src.includes('async createDir(name)'), `facade ${label}: createDir exists`);
  assert.ok(src.includes('async deleteDir(name)'), `facade ${label}: deleteDir exists`);
  assert.ok(src.includes("clientCall('create_mailbox', name)"), `facade ${label}: createDir calls create_mailbox`);
  assert.ok(src.includes("clientCall('delete_mailbox', name)"), `facade ${label}: deleteDir calls delete_mailbox`);
  assert.ok(src.includes('@property {(name: string) => Promise<void>} createDir'), `facade ${label}: typedef documents createDir`);
}

// static wiring: test server
assert.ok(server.includes('C === "CREATE"'), 'test server implements CREATE');
assert.ok(server.includes('C === "DELETE"'), 'test server implements DELETE');
assert.ok(server.includes('ALREADYEXISTS'), 'CREATE rejects existing mailboxes');
assert.ok(server.includes('inferior hierarchical names'), 'DELETE refuses parents with children');
assert.ok(server.includes('const names = [...boxes.keys()].sort()'), 'LIST reflects the dynamic mailbox set');

// replicated semantics --------------------------------------------------------
function deletable(node) {
  return !!node && node.selectable
    && node.name.toUpperCase() !== 'INBOX'
    && !node.children.length;
}

const fullName = (parent, delimiter, name) => parent && delimiter ? parent + delimiter + name : name;

// stub-server-like tree
const nodes = [
  {name: 'INBOX', selectable: true, children: [{}]},
  {name: 'Work', selectable: true, children: [{}, {}]},
  {name: 'Work/Projects', selectable: true, children: []},
  {name: 'Virtual', selectable: false, children: []},
  {name: 'Sparse', selectable: true, children: []},
  {name: 'Ghost', selectable: false, children: []},
];

assert.equal(deletable(nodes[0]), false, 'INBOX not deletable');
assert.equal(deletable(nodes[1]), false, 'parent folder not deletable');
assert.equal(deletable(nodes[2]), true, 'leaf folder deletable');
assert.equal(deletable(nodes[3]), false, 'NoSelect folder not deletable');
assert.equal(deletable(nodes[5]), false, 'synthesized placeholder not deletable');
assert.equal(deletable(null), false, 'no selection not deletable');

assert.equal(fullName('Work', '/', 'Hobbies'), 'Work/Hobbies', 'subfolder joins on the delimiter');
assert.equal(fullName(null, '/', 'Notes'), 'Notes', 'no selection creates top level');
assert.equal(fullName('Work', null, 'Notes'), 'Notes', 'missing delimiter falls back to top level');

// replicated delete-flow semantics (dirs.mjs) ---------------------------------
function parentName(name, dirs) {
  const self = (Array.isArray(dirs) ? dirs : []).find(d => d?.name === name);
  const d = self?.delimiter || null;
  if (!d) {
    return null;
  }
  const base = name.endsWith(d) ? name.slice(0, -d.length) : name;
  const idx = base.lastIndexOf(d);
  return idx > 0 ? base.slice(0, idx) : null;
}

const openable = (parent, dirs) => !!parent && dirs.some(d =>
  d?.name === parent
  && !(Array.isArray(d.attrs) ? d.attrs : []).some(a => /\\noselect/i.test(String(a)))
);

const nextSelection = (deleted, dirs) => {
  const parent = parentName(deleted, dirs);
  return openable(parent, dirs) ? parent : null; // null -> INBOX fallback
};

const dirs1 = [
  {name: 'INBOX', delimiter: '/', attrs: ['\\HasNoChildren']},
  {name: 'Work', delimiter: '/', attrs: ['\\HasChildren']},
  {name: 'Work/Hobbies', delimiter: '/', attrs: ['\\HasNoChildren']},
  {name: 'Notes', delimiter: '/', attrs: ['\\HasNoChildren']},
];
assert.equal(parentName('Work/Hobbies', dirs1), 'Work', 'nested folder resolves to its parent');
assert.equal(parentName('Work', dirs1), null, 'top-level folder has no parent');
assert.equal(parentName('A.B.C', [{name: 'A.B.C', delimiter: '.', attrs: []}]), 'A.B', 'dotted delimiters work');
assert.equal(parentName('Ghost/Sub', dirs1), null, 'unlisted folder has no resolvable parent');
assert.equal(nextSelection('Work/Hobbies', dirs1), 'Work', 'deleting a subfolder selects the parent');
assert.equal(nextSelection('Work', dirs1), null, 'deleting a top-level folder clears the selection');
assert.equal(
  nextSelection('Work/Hobbies', [...dirs1.slice(0, 2), {name: 'Work/Hobbies', delimiter: '/', attrs: []}]),
  'Work',
  'parent attrs considered when re-pointing the selection'
);

// Noselect parent -> not openable -> selection cleared
assert.equal(nextSelection('Virt/Kid', [
  {name: 'INBOX', delimiter: '/', attrs: []},
  {name: 'Virt', delimiter: '/', attrs: ['\\NoSelect']},
  {name: 'Virt/Kid', delimiter: '/', attrs: []},
]), null, 'Noselect parent falls back to clearing the selection');

// stale saved selection: load() falls back to INBOX, then dirs[0]
const pickInitial = (dirs, saved) =>
  dirs.find(d => d.name === saved)
  || dirs.find(d => d.name.toUpperCase() === 'INBOX')
  || dirs[0];
const afterDelete = dirs1.filter(d => d.name !== 'Work/Hobbies');
assert.equal(pickInitial(afterDelete, 'Work/Hobbies').name, 'INBOX', 'deleted saved folder -> INBOX');
assert.equal(pickInitial(dirs1, 'Notes').name, 'Notes', 'live saved folder is restored');
assert.equal(pickInitial(dirs1.filter(d => d.name !== 'INBOX'), null).name, 'Work', 'no INBOX -> first folder');

console.log('smoke-dirs: all assertions passed');
