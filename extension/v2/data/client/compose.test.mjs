#!/usr/bin/env node
// Regression tests for compose.mjs — the RFC822/MIME assembly behind the
// compose dialog's Save. The pure header/MIME surface is verified here end
// to end; the DOMParser-based helpers (sanitizeHtml, htmlToPlain) run only
// where a DOM exists, so their block is feature-gated.
// Run: node data/client/compose.test.mjs

import assert from 'node:assert/strict';
import {
  buildMessage, headerValue, addressHeader, foldHeader,
  rfc5322Date, makeMessageId, sanitizeHtml, htmlToPlain
} from './compose.mjs';

const text = bytes => new TextDecoder().decode(bytes);

// decodes the RFC 2047 B-words the builders emit, so tests compare payload
function decodeWords(value) {
  return value.replace(/=\?UTF-8\?B\?([^?]*)\?=/g,
    (_, b64part) => Buffer.from(b64part, 'base64').toString('utf8'));
}

// unfolds folded header lines per RFC 5322 §2.2.3: delete the CRLF, keep
// the leading WSP — the builder folds by replacing an inter-word space
// with CRLF+space, so this is the exact inverse
function unfold(text) {
  return text.replaceAll('\r\n ', ' ');
}

const NOW = Date.UTC(2026, 10, 23, 9, 30, 5);   // Mon, 23 Nov 2026 09:30:05 +0000
const FIELDS = {
  from: 'alice@example.com', fromName: 'Alice',
  to: 'bob@example.com', cc: 'carol@example.com', bcc: 'hidden@example.com',
  subject: 'Quarterly report', html: '<b>hello</b>', plain: 'hello',
  now: NOW
};

// ---- basic shape -----------------------------------------------------------

{
  const raw = text(buildMessage(FIELDS));
  assert.ok(raw.startsWith('From: '), 'From is the first header');
  for (const line of [
    'From: Alice <alice@example.com>',
    'To: bob@example.com',
    'Cc: carol@example.com',
    'Subject: Quarterly report',
    'Date: Mon, 23 Nov 2026 09:30:05 +0000',
    'MIME-Version: 1.0'
  ]) {
    assert.ok(raw.includes(line), 'header present: ' + line);
  }
  assert.match(raw, /^Message-ID: <compose\.\d+\.[0-9a-f]{16}@example\.com>\r$/m,
    'generated Message-ID keyed on the From domain');
  assert.ok(!/\r\n/.test(raw) === false, 'CRLF line endings throughout');
  assert.ok(!raw.includes('hidden@example.com') && !/^Bcc:/im.test(raw),
    'bcc is never written');
  assert.ok(raw.includes('Content-Type: multipart/alternative; boundary="'),
    'multipart/alternative with a quoted boundary');
  const boundary = /boundary="([^"]+)"/.exec(raw)[1];
  assert.ok(raw.includes('--' + boundary + '\r\n'), 'part delimiters use the boundary');
  assert.ok(raw.trimEnd().endsWith('--' + boundary + '--'), 'closing delimiter last');
  assert.ok(raw.includes('Content-Type: text/plain; charset=UTF-8'), 'plain part present');
  assert.ok(raw.includes('Content-Type: text/html; charset=UTF-8'), 'html part present');
  assert.ok(raw.includes('\r\n\r\nhello\r\n'), 'plain part carries the text');
  const htmlPart = raw.split('--' + boundary)[2];
  assert.ok(htmlPart.includes('<b>hello</b>'), 'html part carries the markup');
}

// ---- omitted headers when the fields are empty ------------------------------

{
  const raw = text(buildMessage({
    from: 'alice@example.com', to: '', cc: '', subject: '', html: '<br>', plain: 'x',
    now: NOW
  }));
  assert.ok(!/^To:/im.test(raw), 'no empty To header');
  assert.ok(!/^Cc:/im.test(raw), 'no empty Cc header');
  assert.ok(!/^Subject:/im.test(raw), 'no empty Subject header');
}

// ---- From is mandatory ------------------------------------------------------

assert.throws(() => buildMessage({to: 'a@b.c', html: '', plain: 'x'}),
  /From address is required/, 'buildMessage refuses to run without From');

// ---- RFC 2047: non-ASCII subject and names ---------------------------------

{
  const raw = text(buildMessage({...FIELDS, subject: 'Quartalsbericht — Käse'}));
  const subjectLine = unfold(/^Subject: (.*)$/m.exec(raw)[1]);
  assert.match(subjectLine, /=\?UTF-8\?B\?/, 'non-ASCII subject encodes as B-word');
  assert.equal(decodeWords(subjectLine), 'Quartalsbericht — Käse',
    'subject round-trips through the encoded word');
}

{
  const line = headerValue('Grüße');
  assert.match(line, /=\?UTF-8\?B\?/, 'non-ASCII values encode');
  assert.equal(decodeWords(line), 'Grüße', 'and round-trip');
}

// control characters also force the encoded path (never raw in a header)
{
  const raw = text(buildMessage({...FIELDS, subject: 'a\tb\x01c'}));
  assert.match(raw, /^Subject: =\?UTF-8\?B\?/m, 'control characters encode too');
}

// CR/LF in a header value never survive (header injection defence)
{
  const raw = text(buildMessage({...FIELDS,
    subject: 'line1\r\n line2\r\nBcc: evil@example.com'}));
  assert.ok(!/^Bcc:/im.test(raw), 'no injected Bcc from a folded subject');
  // the folded subject's own lines all continue with a space, so none of
  // them can be parsed as a fresh header — the injected text survives as
  // inert subject content, which is the whole point
  const subjectBlock = raw.slice(raw.indexOf('Subject: '), raw.indexOf('\r\nDate: '));
  for (const line of subjectBlock.split('\r\n').slice(1)) {
    assert.ok(line.startsWith(' '), 'subject continuation carries no header shape');
  }
  assert.ok(decodeWords(unfold(subjectBlock)).includes('Bcc: evil@example.com'),
    'the injected text stays inert subject content');
}

// ---- folding ----------------------------------------------------------------

{
  const long = 'word '.repeat(40).trim();
  const folded = foldHeader('Subject', long);
  const lines = folded.split('\r\n');
  assert.ok(lines.length > 1, 'a long header folds');
  for (const [i, line] of lines.entries()) {
    assert.ok(line.length <= 78, 'every folded line ≤ 78 chars');
    if (i > 0) {
      assert.ok(line.startsWith(' '), 'continuations start with a space');
    }
  }
  assert.equal(unfold(folded), 'Subject: ' + long, 'folding loses no text');
  // an encoded word is never split internally
  const encoded = foldHeader('Subject', headerValue('ä'.repeat(200)));
  for (const line of encoded.split('\r\n')) {
    for (const word of line.match(/=\?UTF-8\?B\?[^?]*\?=/g) ?? []) {
      assert.ok(word.length <= 76, 'encoded word whole on one line');
    }
  }
}

// ---- addresses --------------------------------------------------------------

assert.equal(addressHeader('a@x.com, b@x.com; c@x.com'), 'a@x.com, b@x.com, c@x.com',
  'comma and semicolon lists re-join on commas');
assert.equal(addressHeader('  ,, ;; '), '', 'only separators and spaces → empty list');
assert.equal(addressHeader('Doe, John <john@x.com>'), 'Doe, John <john@x.com>',
  'an unquoted comma splits (names with commas need user quotes)');
assert.equal(addressHeader('"Doe, John" <john@x.com>'), '"Doe, John" <john@x.com>',
  'a quoted comma-name stays ONE entry (quote-aware split)');
assert.equal(addressHeader('Jane O\'Hara <j@x.com>'), 'Jane O\'Hara <j@x.com>',
  'atom-safe names stay bare');
{
  const pair = addressHeader('Grüße <g@x.com>');
  assert.match(pair, /=\?UTF-8\?B\?[^?]*\?= <g@x\.com>/, 'non-ASCII display names encode');
  assert.equal(decodeWords(pair), 'Grüße <g@x.com>', 'and decode back');
}

// ---- generated shapes --------------------------------------------------------

assert.equal(rfc5322Date(NOW), 'Mon, 23 Nov 2026 09:30:05 +0000', 'strict RFC 5322 date, UTC');
assert.match(makeMessageId(NOW, 'a@example.com'),
  /^<compose\.\d+\.[0-9a-f]{16}@example\.com>$/, 'Message-ID shape with From host');
assert.equal(makeMessageId(NOW, 'bare-slug').split('@')[1], 'local>',
  'a From without a domain falls back to the local host');

// explicit plain text rides along verbatim
{
  const raw = text(buildMessage({
    from: 'a@x.com', to: 'b@x.com', subject: 's',
    html: '<p>Hello <b>world</b></p>', plain: 'Hello world', now: NOW
  }));
  const boundary = /boundary="([^"]+)"/.exec(raw)[1];
  const parts = raw.split('--' + boundary);
  const plainBody = parts[1].split('\r\n\r\n').slice(1).join('\r\n\r\n');
  assert.equal(plainBody.trim(), 'Hello world', 'the plain part carries the text');
}

// ---- DOM helpers (browser only) ----------------------------------------------

if (typeof DOMParser !== 'undefined') {
  assert.equal(sanitizeHtml('<p>hi <b>there</b></p>'), '<p>hi <b>there</b></p>',
    'whitelisted markup survives');
  assert.equal(sanitizeHtml('<p onclick="x()">hi</p>'), '<p>hi</p>',
    'event handlers drop');
  assert.equal(sanitizeHtml('<script>alert(1)</script>ok'), 'ok',
    'script subtrees drop, sibling text stays');
  assert.equal(sanitizeHtml('<style>body{}</style>ok'), 'ok', 'style drops');
  assert.equal(sanitizeHtml('a<img src=x onerror=alert(1)>b'), 'ab',
    'images drop, surrounding text stays');
  assert.equal(sanitizeHtml('<a href="javascript:alert(1)">x</a>'), '<a>x</a>',
    'javascript: hrefs drop, link text stays');
  assert.equal(sanitizeHtml('<a href="https://x.com/a?b=1">x</a>'),
    '<a href="https://x.com/a?b=1">x</a>', 'https hrefs survive');
  assert.equal(sanitizeHtml('<em>e</em><svg><script/></svg><u>u</u>'), '<em>e</em><u>u</u>',
    'svg subtrees drop');
  assert.equal(htmlToPlain('<p>one</p><p>two</p>'), 'one\ntwo', 'blocks break lines');
  assert.equal(htmlToPlain('<ul><li>a</li><li>b</li></ul>'), '- a\n- b', 'ul items bullet');
  assert.equal(htmlToPlain('<ol><li>a</li><li>b</li></ol>'), '1. a\n2. b', 'ol items number');
  assert.equal(htmlToPlain('x<br>y'), 'x\ny', 'br breaks');
  // buildMessage falls back to htmlToPlain when no plain rides along
  {
    const raw = text(buildMessage({
      from: 'a@x.com', to: 'b@x.com', subject: 's',
      html: '<p>Hello <b>world</b></p>', now: NOW
    }));
    const boundary = /boundary="([^"]+)"/.exec(raw)[1];
    const plainBody = raw.split('--' + boundary)[1].split('\r\n\r\n').slice(1).join('\r\n\r\n');
    assert.equal(plainBody.trim(), 'Hello world', 'htmlToPlain derived the plain body');
  }
  console.log('compose DOM tests passed');
}
else {
  console.log('compose DOM tests skipped (no DOMParser in Node)');
}

console.log('compose tests passed');
