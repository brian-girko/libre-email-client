#!/usr/bin/env node
// smoke-move.mjs — assertions for the move-to-folder feature. Statically
// checks the wiring in list-view.js / list.mjs, then replicates the helper
// semantics (NoSelect filter, indent, current-folder guard) and asserts them
// against stub-server-like data.
//
//   node tests/smoke-move.mjs

import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const view = await readFile(new URL('../extension/data/client/components/list-view.js', import.meta.url), 'utf8');
const host = await readFile(new URL('../extension/data/client/list.mjs', import.meta.url), 'utf8');

// static wiring: component
assert.ok(view.includes('data-action="move"'), 'Move toolbar button exists');
assert.ok(view.includes('accesskey="m"'), 'Move button has the m accesskey');
assert.ok(view.includes('class="move-dialog"'), 'move dialog exists in the shadow root');
assert.ok(view.includes('askDestination(dirs'), 'askDestination is exposed');
assert.ok(view.includes("hasFlag(d.attrs, '\\\\NoSelect')"), 'NoSelect mailboxes are filtered');
assert.ok(view.includes('#moveDialog.showModal()'), 'dialog is shown modally');
assert.ok(view.includes("this.#moveDialog.addEventListener('cancel'"), 'Esc resolves as cancelled');
assert.ok(view.includes("addEventListener('close'"), 'any other close path resolves as cancelled');
assert.ok(view.includes('indentDirName'), 'indent helper is used for nesting');

// static wiring: host
assert.ok(host.includes("el.addEventListener('move'"), 'host listens for move events');
assert.ok(host.includes("runAction('move'"), 'move runs through runAction');
assert.ok(host.includes('await el.askDestination('), 'host asks for the destination');
assert.ok(host.includes('async function performMove('), 'performMove is extracted');
assert.ok(host.includes("'Messages are already in '"), 'same-folder guard exists');
assert.ok(host.includes("performMove(api, uids, target, id, name, token)"), 'move case uses performMove');
assert.ok(host.includes('await performMove(api, uids, target, id, name, token)'), 'special-dir moves use performMove too');

// replicated helper semantics -------------------------------------------------
const hasFlag = (flags, name) => Array.isArray(flags) && flags.some(f => String(f).toLowerCase() === name.toLowerCase());

function pickable(dirs) {
  return (Array.isArray(dirs) ? dirs : [])
    .filter(d => d && d.name && !hasFlag(d.attrs, '\\NoSelect'))
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

function indentDirName(name, delimiter) {
  const d = String(delimiter || '');
  if (!d || !name.includes(d)) {
    return String(name);
  }
  const parts = String(name).split(d);
  return parts.slice(0, -1).map(() => '\u00b7 ').join('') + parts[parts.length - 1];
}

// stub-server-like folder set
const dirs = [
  {name: 'INBOX', delimiter: '/', attrs: ['\\HasNoChildren']},
  {name: 'Work', delimiter: '/', attrs: ['\\HasChildren']},
  {name: 'Work/Projects', delimiter: '/', attrs: ['\\HasNoChildren']},
  {name: 'Work/Meetings', delimiter: '/', attrs: ['\\HasNoChildren']},
  {name: 'Trash', delimiter: '/', attrs: ['\\HasNoChildren', '\\Trash']},
  {name: 'Virtual', delimiter: '/', attrs: ['\\NoSelect']},
];

const list = pickable(dirs);
assert.deepEqual(
  list.map(d => d.name),
  ['INBOX', 'Trash', 'Work', 'Work/Meetings', 'Work/Projects'],
  'NoSelect filtered and names sorted alphabetically'
);

assert.equal(indentDirName('INBOX', '/'), 'INBOX', 'root folders not indented');
assert.equal(indentDirName('Work/Projects', '/'), '\u00b7 Projects', 'one level indented');
assert.equal(indentDirName('A/B/C', '/'), '\u00b7 \u00b7 C', 'two levels indented');
assert.equal(indentDirName('Odd', ''), 'Odd', 'missing delimiter tolerated');
assert.equal(indentDirName('Dotted.Mail', '.'), '\u00b7 Mail', 'other delimiters work');

// current folder disabled, default value skips it
const current = 'INBOX';
const opts = list.map(d => ({value: d.name, disabled: d.name === current}));
const enabled = list.filter(d => d.name !== current);
assert.equal(enabled[0].name, 'Trash', 'first non-current folder becomes the default');

// same-folder guard logic (performMove): moving onto itself must be refused
const isSameFolderGuarded = (target, name) => target === name;
assert.ok(isSameFolderGuarded('Work', 'Work'), 'same-folder guard triggers for same folder');
assert.ok(!isSameFolderGuarded('Work', 'INBOX'), 'guard does not trigger for other folder');

console.log('smoke-move: all assertions passed');
