#!/usr/bin/env node
// smoke-search.mjs — assertions for the IMAP search feature: buildCriteria
// semantics (plain text, prefixes, dates, escaping) and static wiring across
// wasm export / facade / UI / test server.
//
//   node tests/smoke-search.mjs

import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const {buildCriteria} = await import('../extension/core/rust-imap-client/api.mjs');

// --- criteria builder -------------------------------------------------------
assert.equal(buildCriteria(''), '', 'empty input -> empty criteria');
assert.equal(buildCriteria('   '), '', 'whitespace -> empty criteria');
assert.equal(buildCriteria('sprint'), 'TEXT "sprint"', 'plain text -> TEXT');
assert.equal(
  buildCriteria('alice bob'),
  'TEXT "alice" TEXT "bob"',
  'two terms ANDed as two TEXT keys'
);
assert.equal(buildCriteria('from:dana'), 'FROM "dana"', 'from: prefix');
assert.equal(buildCriteria('TO:dana@x.com'), 'TO "dana@x.com"', 'to: prefix, case-insensitive key');
assert.equal(buildCriteria('subject:sprint'), 'SUBJECT "sprint"', 'subject: prefix');
assert.equal(buildCriteria('body:friday'), 'BODY "friday"', 'body: prefix');
assert.equal(
  buildCriteria('from:dana sprint'),
  'FROM "dana" TEXT "sprint"',
  'prefix + plain term combined (AND)'
);
assert.equal(
  buildCriteria('SINCE:2026-09-07'),
  'SINCE 7-Sep-2026',
  'since: converts to IMAP date format'
);
assert.equal(
  buildCriteria('before:2026-09-08'),
  'BEFORE 8-Sep-2026',
  'before: converts to IMAP date format'
);
assert.equal(
  buildCriteria('before:2026-09-08'),
  'BEFORE 8-Sep-2026',
  'before: converts to IMAP date format'
);
assert.equal(
  buildCriteria('say "hi"'),
  'TEXT "say" TEXT "\\"hi\\""',
  'double quotes escaped for the wire'
);
assert.equal(buildCriteria('back\\slash'), 'TEXT "back\\\\slash"', 'backslash escaped');

// --- static wiring ----------------------------------------------------------
const lib = await readFile(new URL('../rust-client/src/lib.rs', import.meta.url), 'utf8');
const api = await readFile(new URL('../rust-client/js/api.mjs', import.meta.url), 'utf8');
const list = await readFile(new URL('../extension/data/client/list.mjs', import.meta.url), 'utf8');
const indexHtml = await readFile(new URL('../extension/data/client/index.html', import.meta.url), 'utf8');
const indexMjs = await readFile(new URL('../extension/data/client/index.mjs', import.meta.url), 'utf8');
const server = await readFile(new URL('../server/imap-test-server.mjs', import.meta.url), 'utf8');

assert.ok(lib.includes('pub async fn search_threads'), 'wasm exports search_threads');
assert.ok(lib.includes('uid_search(criteria)'), 'wasm uses uid_search');
assert.ok(lib.includes('fn fetch_thread_batch_uids'), 'wasm fetches by UID set');
assert.ok(lib.includes('group_threads(msgs)'), 'wasm threads the results');

assert.ok(api.includes('export function buildCriteria'), 'buildCriteria is exported');
assert.ok(api.includes("async search({dir, query, allFolders}"), 'facade exposes search()');
assert.ok(api.includes("clientCall('search_threads'"), 'facade calls the wasm export');
assert.ok(api.includes('allFolders'), 'facade supports all-folder scope');

assert.ok(list.includes('async function runSearch('), 'list.mjs has a search runner');
assert.ok(list.includes('async function clearSearch('), 'list.mjs can clear the search');
assert.ok(list.includes('el.setPager(null)'), 'pager hidden in search mode');
assert.ok(list.includes('search = null;'), 'folder change invalidates the search');

assert.ok(indexHtml.includes('id="mail-search"'), 'search input sits on the accounts row');
assert.ok(indexHtml.includes('id="search-clear"'), 'clear button exists');
assert.ok(indexMjs.includes("runSearch("), 'index.mjs runs the search');
assert.ok(indexMjs.includes("clearSearch()"), 'index.mjs clears the search');
assert.ok(indexMjs.includes("searchScope("), 'scope detection (all: prefix)');

assert.ok(server.includes('function handleSearch('), 'test server implements SEARCH');
assert.ok(server.includes('=== "SEARCH"'), 'server routes SEARCH');
assert.ok(server.includes('UID SEARCH') || server.includes('C === "UID" && (args[0] || "").toUpperCase() === "SEARCH"'), 'server routes UID SEARCH');

console.log('smoke-search: all assertions passed');
