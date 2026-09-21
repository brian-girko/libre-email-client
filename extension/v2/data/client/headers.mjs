/**
 * headers.mjs — cheap per-message header extraction for the maildir client.
 *
 * The maildir filenames carry uid + flags only; subject/from/date/threading
 * metadata lives in the message headers. Instead of a full postal-mime parse
 * per message, this module reads the first slice of the file (well beyond
 * the usual stack of Received/DKIM headers, capped like snapshot.mjs does)
 * and parses the RFC822 header block directly: unfolding, RFC 2047
 * encoded-word decoding, and the specific fields the UI and the local
 * threader need.
 *
 * The header slice never parses bodies — that (full postal-mime) happens
 * lazily in preview.mjs and search.mjs only.
 */

const HEADER_SCAN_BYTES = 65536; // header stacks can exceed 8KB on real mail
const decoder = new TextDecoder('utf-8', {fatal: false});

const MBOX_SENTINEL_RE = /^From \S+( .*)?\n/; // mbox wrapper line

/**
 * Parse the header block of raw RFC822 bytes into a flat map of
 * lowercased-name -> string value (folded lines joined with " ").
 * @param {Uint8Array} slice first bytes of the message
 * @returns {Map<string, string>}
 */
export function parseHeaderBlock(bytes) {
  let text = decoder.decode(bytes).replace(/\r\n/g, '\n');
  const mbox = MBOX_SENTINEL_RE.exec(text);
  if (mbox) {
    text = text.slice(mbox[0].length);
  }
  const blank = text.indexOf('\n\n');
  const head = blank >= 0 ? text.slice(0, blank) : text;
  const headers = new Map();
  let last = null;
  for (const line of head.split('\n')) {
    if (!line) {
      continue;
    }
    if (/^[ \t]/.test(line)) {
      if (last) {
        headers.set(last, headers.get(last) + ' ' + line.trim());
      }
      continue;
    }
    const sep = line.indexOf(':');
    if (sep <= 0) {
      last = null;
      continue;
    }
    const name = line.slice(0, sep).trim().toLowerCase();
    if (!/^[a-z0-9-]+$/.test(name)) {
      last = null;
      continue;
    }
    last = name;
    headers.set(name, line.slice(sep + 1).trim());
  }
  return headers;
}

// ---- RFC 2047 encoded-word decoding -----------------------------------------

function qDecode(charset, data) {
  const bytes = Uint8Array.from(data.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g,
    (_, h) => String.fromCharCode(parseInt(h, 16))), c => c.charCodeAt(0));
  return decodeCharset(charset, bytes);
}

function b64Decode(charset, data) {
  const bin = atob(data);
  const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
  return decodeCharset(charset, bytes);
}

function decodeCharset(charset, bytes) {
  try {
    return new TextDecoder(String(charset).toLowerCase()).decode(bytes).trim();
  }
  catch {
    return new TextDecoder('utf-8', {fatal: false}).decode(bytes).trim();
  }
}

/** RFC 2047 encoded words ("=?charset?B/Q?...?=") → readable text */
export function decodeMimeWords(input) {
  const str = String(input ?? '');
  if (!str.includes('=?')) {
    return str;
  }
  // whitespace between adjacent encoded words is not part of the text
  const joined = str.replace(/(\?=)[ \t\r\n]+(=\?)/g, '$1$2');
  return joined.replace(/=\?([^?\s]+)\?([BbQq])\?([^?\s]*)\?=/g, (token, charset, enc, data) => {
    try {
      return enc.toUpperCase() === 'B' ? b64Decode(charset, data) : qDecode(charset, data);
    }
    catch {
      return token; // unknown charset or malformed: leave untouched
    }
  }).replace(/\s+/g, ' ').trim();
}

/**
 * Header block → the small metadata shape the list view rows use:
 *   {subject, from, date, messageId, references, inReplyTo}
 * `from` is the display string ("Name <addr>" / bare addr), same shape IMAP
 * ENVELOPE rows rendered in the old client.
 */
export function messageMeta(bytes) {
  const headers = parseHeaderBlock(bytes);
  const subject = decodeMimeWords(headers.get('subject')) || null;
  const from = decodeMimeWords(headers.get('from')) || null;
  const date = headers.get('date') || null;
  const messageId = headers.get('message-id')?.trim() || null;
  const references = headers.get('references') || null;
  const inReplyTo = headers.get('in-reply-to')?.trim() || null;
  return {subject, from, date, messageId, references, inReplyTo};
}
