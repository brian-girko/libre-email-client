'use strict';

// compose.mjs — RFC 822 / MIME assembly for locally-composed mail.
//
// buildMessage() turns the compose dialog's fields (from/to/cc/bcc/subject
// plus an HTML body) into the RFC822 bytes the Maildir write takes: one
// multipart/alternative message with a text/plain part and the sanitized
// text/html part, every generated header (Date, Message-ID, MIME-Version,
// Content-Type) spelled so the sync engine's own checks accept the file
// unconditionally — validateMail() needs a proper header block, a parseable
// body and a From address or Date, and the classifier identifies the message
// by its Message-ID when it decides the file is local-born mail to APPEND.
//
// Header rules actually enforced here:
//   - CR/LF never survive into a header value (header-injection defence)
//   - non-ASCII and control characters force an RFC 2047 B-encoded word
//     (=?UTF-8?B?...?=), split into ≤ 45-byte words so folding stays legal
//   - user-typed lines fold at spaces onto ≤ 76-char lines; a single
//     over-long word keeps its own line (the 998-char MUST limit is the
//     only hard one, and IMAP literals carry any line length)
//   - machine-generated headers (Date, Message-ID, MIME-Version,
//     Content-Type) stay unfolded: their content is fixed and folding
//     parameters is its own bug class
//   - To/Cc are re-joined on their separators; display names quote when
//     they carry specials, encode when they leave ASCII
//   - Bcc is accepted and NEVER written: every MUA's stored copy omits it
//     (the recipients ride the SMTP envelope — a delivery this client
//     does not perform, so the value is simply not recorded anywhere)
//
// The two DOM helpers (sanitizeHtml, htmlToPlain) run through DOMParser —
// the whitelist walk is the one place untrusted markup (pasted into the
// compose body) is reduced to what the basic editor itself can produce;
// the preview's sandboxed iframe CSP is the outer defence, this is the
// inner one. They exist for the client page (and its DOM); Node tests
// exercise the pure assembly only.

const CRLF = '\r\n';
const MAX_LINE = 76;   // RFC 5322 SHOULD limit, with headroom for the fold

// ---- RFC 2047 encoded words ----------------------------------------------

const needsEncoding = text => /[^\x20-\x7E]/.test(String(text));

/**
 * One header value as RFC 2047 B-encoded words: `=?UTF-8?B?…?=` chunks of
 * at most 45 input bytes (60 base64 chars), joined by single spaces —
 * foldHeader() then breaks only on those spaces, never inside a word.
 * @param {string} text any header text (assumed non-ASCII or non-printable)
 * @returns {string}
 */
function encodeWords(text) {
  const bytes = new TextEncoder().encode(String(text));
  const words = [];
  for (let off = 0; off < bytes.length; off += 45) {
    const slice = bytes.subarray(off, Math.min(off + 45, bytes.length));
    words.push('=?UTF-8?B?' + b64(slice) + '?=');
  }
  return words.length ? words.join(' ') : '=?UTF-8?B??=';
}

/** base64 of a byte slice, without chunking or padding surprises */
function b64(bytes) {
  let bin = '';
  for (const b of bytes) {
    bin += String.fromCharCode(b);
  }
  return btoa(bin);
}

/**
 * A single header value, ready for folding: CR/LF collapsed to spaces
 * (injection defence), non-ASCII/control content encoded as B-words.
 * @param {string} value raw header text
 * @returns {string}
 */
export function headerValue(value) {
  const text = String(value ?? '').replace(/[\r\n\t]+/g, ' ').trim();
  return needsEncoding(text) ? encodeWords(text) : text;
}

// ---- addresses ------------------------------------------------------------

/**
 * Splits a typed recipient list on commas/semicolons, honoring
 * double-quoted display names ("Doe, John" <j@x> must survive as one
 * entry, backslash escapes included) so a comma inside a name never
 * cuts the list.
 * @param {string} raw free-form recipient line
 * @returns {string[]} trimmed, non-empty entries
 */
function splitAddresses(raw) {
  const out = [];
  let cur = '';
  let quoted = false;
  let escaped = false;
  for (const ch of String(raw ?? '')) {
    if (escaped) {
      cur += ch;
      escaped = false;
    }
    else if (quoted && ch === '\\') {
      cur += ch;
      escaped = true;
    }
    else if (ch === '"') {
      quoted = !quoted;
      cur += ch;
    }
    else if (!quoted && (ch === ',' || ch === ';')) {
      out.push(cur);
      cur = '';
    }
    else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map(s => s.trim()).filter(Boolean);
}

/**
 * Re-joins a user-typed recipient list: quote-aware split, trim, drop
 * empties. A `Name <addr>` pair keeps its shape (the name quotes on
 * specials, encodes on non-ASCII, already-quoted names pass through);
 * a bare address passes through as typed.
 * @param {string} raw free-form recipient line ("a@x, b@y; Name <c@z>")
 * @returns {string} a comma-joined address list, '' when nothing usable
 */
export function addressHeader(raw) {
  const list = splitAddresses(raw).map(one => {
    const m = one.match(/^(.*?)<([^<>]*)>\s*$/);
    if (!m) {
      return one;
    }
    const head = displayNamePart(m[1]);
    return (head ? head + ' ' : '') + '<' + m[2].trim() + '>';
  });
  return list.join(', ');
}

/**
 * A display name's header form: an already well-formed quoted-string
 * passes through as typed, non-ASCII encodes as B-words, anything else
 * quotes when it carries specials and stays bare when atom-safe.
 * @param {string} name display name (may be empty)
 * @returns {string} '' when there is no name at all
 */
function displayNamePart(name) {
  const n = String(name ?? '').trim();
  if (!n) {
    return '';
  }
  if (/^"(?:[^"\\]|\\.)*"$/.test(n)) {
    return n;
  }
  return needsEncoding(n) ? encodeWords(n) : quotedName(n);
}

/**
 * Display names carry specials literally only when atom-safe; everything
 * else is a quoted-string with internal quotes/backslashes escaped.
 * @param {string} name an ASCII display name
 * @returns {string}
 */
function quotedName(name) {
  if (/^[\w .'\-]+$/.test(name)) {
    return name;
  }
  return '"' + name.replace(/([\\"])/g, '\\$1') + '"';
}

/**
 * The From value: `Name <addr>` when a display name exists, else the bare
 * address. Same encode/quote/pass-through rules as recipient names.
 * @param {string} from the sender's address
 * @param {string} [fromName] optional display name
 * @returns {string}
 */
export function fromHeader(from, fromName = '') {
  const addr = String(from ?? '').replace(/[\r\n]+/g, ' ').trim();
  const name = displayNamePart(fromName);
  return name ? name + ' <' + addr + '>' : addr;
}

// ---- folding and generated headers ----------------------------------------

/**
 * Folds one header at spaces onto ≤ MAX_LINE lines; continuation lines
 * start with a single space (RFC 5322 §2.2.3). A word longer than the
 * limit is never split — encoded words stay whole, atoms stay whole.
 * @param {string} name header field name ("Subject")
 * @param {string} value the prepared value
 * @returns {string} possibly multi-line, CRLF-joined
 */
export function foldHeader(name, value) {
  const first = name + ': ' + value;
  if (first.length <= MAX_LINE) {
    return first;
  }
  const lines = [];
  let cur = '';
  for (const word of first.split(' ')) {
    if (cur && (cur + ' ' + word).length > MAX_LINE) {
      lines.push(cur);
      cur = word;
    }
    else {
      cur = cur ? cur + ' ' + word : word;
    }
  }
  if (cur) {
    lines.push(cur);
  }
  return lines.join(CRLF + ' ');
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * RFC 5322 date in the strict `Dow, DD Mon YYYY HH:MM:SS +0000` form,
 * always UTC — a composed message's timestamp must not depend on the
 * writer's locale, and every later reader (postal-mime, the server)
 * parses this shape directly.
 * @param {number} now epoch ms
 * @returns {string}
 */
export function rfc5322Date(now) {
  const d = new Date(now);
  const p2 = n => String(n).padStart(2, '0');
  return `${DAYS[d.getUTCDay()]}, ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ` +
    `${d.getUTCFullYear()} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:` +
    `${p2(d.getUTCSeconds())} +0000`;
}

/**
 * `<compose.<now>.<16-hex>@<host>>` — a generated identity the sync
 * classifier reads back through msgidOf(). The host is the From
 * address's domain when it has one, `local` otherwise; either is valid,
 * the id only has to be globally unique in shape.
 * @param {number} now epoch ms
 * @param {string} from the sender's address
 * @returns {string}
 */
export function makeMessageId(now, from) {
  const rand = [...crypto.getRandomValues(new Uint8Array(8))]
    .map(b => b.toString(16).padStart(2, '0')).join('');
  const at = String(from ?? '').lastIndexOf('@');
  const host = at > -1 ? String(from).slice(at + 1).trim() : 'local';
  return `<compose.${now}.${rand}@${host || 'local'}>`;
}

/** a MIME boundary that cannot occur in either part's content */
function makeBoundary(now) {
  const rand = [...crypto.getRandomValues(new Uint8Array(8))]
    .map(b => b.toString(16).padStart(2, '0')).join('');
  return `----=_compose_${now.toString(36)}.${rand}`;
}

// ---- the message ----------------------------------------------------------

/**
 * Assembles the compose dialog's fields into RFC822 bytes.
 * @param {object} fields
 * @param {string} fields.from sender address (required — validation and
 *   the Message-ID host both key on it)
 * @param {string} [fields.fromName] sender display name
 * @param {string} fields.to recipient line, free-form
 * @param {string} [fields.cc] carbon-copy line, free-form
 * @param {string} [fields.bcc] accepted, never written (see module banner)
 * @param {string} [fields.subject]
 * @param {string} [fields.html] the message body as HTML (expected already
 *   sanitized; sanitizeHtml exists for that)
 * @param {string} [fields.plain] the text/plain body; htmlToPlain(html)
 *   fills it when absent
 * @param {number} [fields.now] epoch ms stamp (Date/Message-ID source)
 * @returns {Uint8Array} RFC822 bytes, CRLF line endings
 */
export function buildMessage(fields = {}) {
  const {
    from, fromName = '', to, cc, subject, html = '', plain,
    now = Date.now()
  } = fields;
  if (!String(from ?? '').trim()) {
    throw new Error('compose: a From address is required');
  }
  const text = typeof plain === 'string' && plain.length ? plain : htmlToPlain(html);
  const boundary = makeBoundary(now);

  // headers: From always; To/Cc/Subject only when their prepared value is
  // non-empty (a bare "To:" line is never worth writing)
  const headers = [foldHeader('From', fromHeader(from, fromName))];
  const toLine = addressHeader(to);
  if (toLine) {
    headers.push(foldHeader('To', toLine));
  }
  const ccLine = addressHeader(cc);
  if (ccLine) {
    headers.push(foldHeader('Cc', ccLine));
  }
  const subjectLine = headerValue(subject);
  if (subjectLine) {
    headers.push(foldHeader('Subject', subjectLine));
  }
  headers.push(
    'Date: ' + rfc5322Date(now),
    'Message-ID: ' + makeMessageId(now, from),
    'MIME-Version: 1.0',
    'Content-Type: multipart/alternative; boundary="' + boundary + '"'
  );

  const body = [
    'This is a multi-part message in MIME format.',
    '--' + boundary,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    text,
    '--' + boundary,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    html,
    '--' + boundary + '--'
  ].join(CRLF) + CRLF;

  return new TextEncoder().encode(headers.join(CRLF) + CRLF + CRLF + body);
}

// ---- DOM helpers (browser only — the client page's document) --------------

// what the basic editor itself can produce (execCommand output) plus the
// block shapes pasted content degrades into; everything else unwraps to
// its text. Images drop entirely: the editor offers no upload and remote
// pings have no place leaving this machine.
const ALLOWED_TAGS = new Set([
  'A', 'B', 'STRONG', 'I', 'EM', 'U', 'UL', 'OL', 'LI',
  'P', 'DIV', 'BR', 'BLOCKQUOTE'
]);
// subtrees removed whole — unwrapping these would leak their content as
// visible text or smuggle active markup
const DROP_TAGS = new Set([
  'SCRIPT', 'STYLE', 'HEAD', 'TITLE', 'META', 'LINK', 'OBJECT', 'EMBED',
  'IFRAME', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'MATH'
]);

/**
 * Reduces editor markup to the whitelist: every disallowed element
 * unwraps to its text (script/style/svg/… drop whole), allowed elements
 * rebuild clean, and the only surviving attribute is an anchor href —
 * accepted when it parses to http/https/mailto, dropped otherwise.
 * @param {string} html editor body markup
 * @returns {string} sanitized markup
 */
export function sanitizeHtml(html) {
  const doc = new DOMParser().parseFromString(String(html ?? ''), 'text/html');
  return cleanChildren(doc.body, []).join('');
}

/**
 * The text/plain alternative: block elements break lines, ul items
 * bullet, ol items number (per-list counters), anchors keep their text,
 * and everything else contributes plain text. Excess blank lines
 * collapse to one gap.
 * @param {string} html the (sanitized) body markup
 * @returns {string}
 */
export function htmlToPlain(html) {
  const doc = new DOMParser().parseFromString(String(html ?? ''), 'text/html');
  const out = [];
  plainChildren(doc.body, out, []);
  return out.join('')
    .replace(/\u00A0/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ---- sanitizer walk ---------------------------------------------------------

function cleanChildren(node, out) {
  for (const child of node.childNodes) {
    if (child.nodeType === 3) {           // text
      out.push(escapeText(child.nodeValue));
    }
    else if (child.nodeType === 1) {      // element
      const tag = child.tagName;
      if (DROP_TAGS.has(tag)) {
        continue;
      }
      if (!ALLOWED_TAGS.has(tag)) {
        cleanChildren(child, out);       // unwrap: keep the text, lose the tag
        continue;
      }
      if (tag === 'BR') {
        out.push('<br>');
        continue;
      }
      out.push('<' + tag.toLowerCase());
      if (tag === 'A') {
        const href = safeUrl(child.getAttribute('href'));
        if (href) {
          out.push(' href="' + escapeText(href) + '"');
        }
      }
      out.push('>');
      cleanChildren(child, out);
      out.push('</' + tag.toLowerCase() + '>');
    }
    // comments and everything else: dropped
  }
  return out;
}

function safeUrl(value) {
  // only absolute http/https/mailto links survive: relative URLs have no
  // base inside a message file and javascript:/data: have no place in one
  const raw = String(value ?? '').trim();
  if (!/^(?:https?|mailto):/i.test(raw)) {
    return null;
  }
  try {
    return new URL(raw).href;
  }
  catch {
    return null;
  }
}

function escapeText(text) {
  return String(text ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

// ---- plain-text walk -------------------------------------------------------

const PLAIN_BLOCK = new Set([
  'ADDRESS', 'BLOCKQUOTE', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'P', 'PRE', 'LI', 'UL', 'OL', 'TABLE', 'TR'
]);

function plainChildren(node, out, lists) {
  for (const child of node.childNodes) {
    if (child.nodeType === 3) {
      out.push(child.nodeValue);
    }
    else if (child.nodeType === 1) {
      if (child.tagName === 'BR') {
        out.push('\n');
        continue;
      }
      const block = PLAIN_BLOCK.has(child.tagName);
      if (block) {
        out.push('\n');
      }
      if (child.tagName === 'LI') {
        // marker from the nearest enclosing list; an orphan li bullets
        out.push(lists.length && lists[lists.length - 1].ordered
          ? ++lists[lists.length - 1].n + '. '
          : '- ');
        plainChildren(child, out, lists);
      }
      else {
        if (child.tagName === 'OL' || child.tagName === 'UL') {
          lists.push({ordered: child.tagName === 'OL', n: 0});
          plainChildren(child, out, lists);
          lists.pop();
        }
        else {
          plainChildren(child, out, lists);
        }
      }
      if (block) {
        out.push('\n');
      }
    }
  }
}
