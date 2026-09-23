'use strict';

// one RFC 2047 encoded-word decoder for every header path (maildir client,
// IMAP facade, sync): `=?charset?B/Q?...?=` → text. Matched against
// postal-mime's own decoder (core/parser/postal-mime.mjs) so every view —
// list row, search hit, opened message — renders identical header text.
//
// postal-mime tolerates raw spaces inside the token's data part (the spec
// wants `=20`/`_`, real-world headers do carry spaces); the regex therefore
// caps the data segment at the next `?`, not the next space.
//
// One deliberate difference from postal-mime: a token with malformed
// base64 or an unresolvable charset is left untouched instead of silently
// dropped — an undecodable name is more useful than a vanished one.

function qToBytes(data) {
  data = data.replace(/[_\s]/g, ' ');
  const bytes = [];
  const chars = [...data];
  for (let i = 0; i < chars.length; i++) {
    if (chars[i] === '=' && /^[0-9A-Fa-f]{2}$/.test((chars[i + 1] ?? '') + (chars[i + 2] ?? ''))) {
      bytes.push(parseInt(chars[i + 1] + chars[i + 2], 16));
      i += 2;
    }
    else {
      bytes.push(chars[i].codePointAt(0) & 0xff);
    }
  }
  return Uint8Array.from(bytes);
}

function b64ToBytes(data) {
  const bin = atob(data.replace(/\s+/g, ''));
  return Uint8Array.from(bin, c => c.charCodeAt(0));
}

function decodeCharset(charset, bytes) {
  const name = String(charset).trim().toLowerCase();
  try {
    return new TextDecoder(name).decode(bytes);
  }
  catch {
    // common legacy aliases TextDecoder does not accept natively
    const alias = name.replace(/^(?:x-|cs)/, '');
    if (alias !== name) {
      try {
        return new TextDecoder(alias).decode(bytes);
      }
      catch { /* fall through */ }
    }
    if (['latin1', 'l1', 'iso88591', 'cp819'].includes(alias.replace(/[-_]/g, ''))) {
      return new TextDecoder('windows-1252').decode(bytes);
    }
    return new TextDecoder('utf-8', {fatal: false}).decode(bytes);
  }
}

const ENCODED_WORD_RE = /=\?([^?\s]+)\?([QqBb])\?([^?]*)\?=/g;

/**
 * RFC 2047 encoded words → readable text. Idempotent (a string without
 * `=?` is returned unchanged). Unknown charset or malformed data leaves the
 * token untouched, and whitespace between adjacent encoded words — which is
 * not part of the text — is dropped.
 * @param {string|null|undefined} input raw header value (unfolded)
 * @returns {string} decoded text
 */
export function decodeMimeWords(input) {
  const str = String(input ?? '');
  if (!str.includes('=?')) {
    return str;
  }
  const joined = str.replace(/(\?=)[ \t\r\n]+(=\?)/g, '$1$2');
  const out = joined.replace(ENCODED_WORD_RE, (token, charset, enc, data) => {
    try {
      const bytes = enc.toUpperCase() === 'B' ? b64ToBytes(data) : qToBytes(data);
      return decodeCharset(charset, bytes);
    }
    catch {
      return token; // malformed base64 or impossible data: leave untouched
    }
  });
  // collapse runs of newlines/tabs a folded header or decode can leave
  return out.replace(/[ \t\r\n]+/g, ' ').trim();
}
