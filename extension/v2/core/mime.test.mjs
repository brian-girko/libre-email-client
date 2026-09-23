#!/usr/bin/env node
// Regression test for the RFC 2047 shared decoder (core/mime.mjs), plus the
// end-to-end list-view metadata path (data/client/headers.mjs messageMeta).
// Run: node core/mime.test.mjs

import assert from 'node:assert/strict';
import {decodeMimeWords} from './mime.mjs';
import {messageMeta} from '../data/client/headers.mjs';

// A sender whose Q-encoded display name carries RAW spaces (illegal per
// RFC 2047 but real-world; postal-mime tolerates it). This used to render
// the raw token in the mail list because the data segment regex capped at
// the next space.
const BUG_CASE = 'From: =?utf-8?Q?Agenda Bimtek Lembaga PUSDIKNAS?= <seminardiklat854@gmail.com>\r\n' +
  'Subject: Tanggal\r\nDate: Wed, 23 Sep 2026 05:00:00 +0000\r\nMessage-Id: <1@x>\r\n\r\nbody';

// 1. the bug case, string-level
assert.equal(
  decodeMimeWords('=?utf-8?Q?Agenda Bimtek Lembaga PUSDIKNAS?= <seminardiklat854@gmail.com>'),
  'Agenda Bimtek Lembaga PUSDIKNAS <seminardiklat854@gmail.com>',
);

// 1b. the bug case, full messageMeta parse
{
  const meta = messageMeta(new TextEncoder().encode(BUG_CASE));
  assert.equal(meta.from, 'Agenda Bimtek Lembaga PUSDIKNAS <seminardiklat854@gmail.com>');
  assert.equal(meta.subject, 'Tanggal');
}

// 2. spec-conformant Q token (underscores), decoded
assert.equal(decodeMimeWords('=?utf-8?Q?Agenda_Bimtek_Lembaga_PUSDIKNAS?='), 'Agenda Bimtek Lembaga PUSDIKNAS');

// 3. Q token with =XX escapes; whitespace between adjacent encoded words is
//    insignificant (RFC 2047 §6.2) and is dropped — same as postal-mime
assert.equal(decodeMimeWords('=?iso-8859-1?Q?caf=E9?= =?iso-8859-1?Q?au_lait?='), 'caféau lait');

// 4. B token, UTF-8 payload
assert.equal(decodeMimeWords('=?utf-8?B?4KSV4KS+4KS54KSo4KSk?='), 'काहनत');

// 5. plain headers pass through unchanged; decoding is idempotent
assert.equal(decodeMimeWords('Agenda <a@b>'), 'Agenda <a@b>');
assert.equal(decodeMimeWords('Agenda Bimtek Lembaga PUSDIKNAS'), 'Agenda Bimtek Lembaga PUSDIKNAS');

// 6. malformed base64 leaves the token untouched
assert.equal(decodeMimeWords('=?utf-8?B?!!!!!?='), '=?utf-8?B?!!!!!?=');

// 7. unknown charset falls back to utf-8 instead of failing the whole header
assert.equal(decodeMimeWords('=?x-unknown?Q?hello?='), 'hello');

// 8. null/undefined tolerated
assert.equal(decodeMimeWords(null), '');
assert.equal(decodeMimeWords(undefined), '');

console.log('mime tests: all passed');
