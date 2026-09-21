// query.mjs — the options-page filter query language, parser + matcher.
//
// The grammar (documented in data/options/index.html, filter editor hint):
//   terms      subject: from: sender: to: body:
//              a bare word matches anywhere (subject, from, to and body)
//              values are case-insensitive "contains"; a quoted phrase
//              ("two words") is one term
//   combinators and (implied between adjacent terms), or, not, parentheses
//   lines      one line per rule — a message matches when ANY line matches
//
// This module is deliberately dependency-free and UI-free: it is one of two
// pieces of data/sync/filters/ (see index.mjs for the store proxy), importable
// from anywhere without dragging the sync engine along.
//
// Precedence (loosest to tightest): or < and < not < atoms. "and" binds
// tighter than "or", so  a or b c  reads  a or (b and c) — same shape the
// mail client's old mirror search used.

'use strict';

// token kinds: WORD (bare or after a field prefix), LPAREN, RPAREN,
// AND, OR, NOT, EOF
const FIELD_RE = /^(subject|from|sender|to|body):(.*)$/i;

const FIELDS = new Set(['subject', 'from', 'sender', 'to', 'body']);

/**
 * Tokenizes one rule line.
 * @param {string} line
 * @returns {Array<{kind: string, field: string|null, value: string,
 *                  raw: string}>}
 */
function tokenize(line) {
  const tokens = [];
  const n = line.length;
  let i = 0;
  /** line[i] === '"' → one quoted phrase (unterminated tolerantly ends the line) */
  function readQuoted() {
    const end = line.indexOf('"', i + 1);
    const value = end < 0 ? line.slice(i + 1) : line.slice(i + 1, end);
    const raw = line.slice(i, end < 0 ? n : end + 1);
    i = end < 0 ? n : end + 1;
    return {value, raw};
  }
  /** bare word up to whitespace or a paren */
  function readWord() {
    const start = i;
    while (i < n && !/[\s()]/.test(line[i])) {
      i++;
    }
    return {value: line.slice(start, i), raw: line.slice(start, i)};
  }
  while (i < n) {
    const ch = line[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === '(') {
      tokens.push({kind: 'LPAREN', field: null, value: '', raw: '('});
      i++;
      continue;
    }
    if (ch === ')') {
      tokens.push({kind: 'RPAREN', field: null, value: '', raw: ')'});
      i++;
      continue;
    }
    if (ch === '"') {
      const {value, raw} = readQuoted();
      tokens.push({kind: 'WORD', field: null, value, raw});
      continue;
    }
    // field prefix — "from:x@y", `from: "DDD"` (the options examples spell
    // a space after the colon) and from:"DDD" all read as one term
    const m = FIELD_RE.exec(line.slice(i));
    if (m) {
      let k = i + m[1].length + 1;   // past "field:"
      while (k < n && /\s/.test(line[k])) {
        k++;
      }
      if (k < n && line[k] === '"') {
        i = k;
        const {value, raw} = readQuoted();
        tokens.push({kind: 'WORD', field: m[1].toLowerCase(), value, raw});
        continue;
      }
      if (k < n && !/[\s()]/.test(line[k])) {
        const start = k;
        while (k < n && !/[\s()]/.test(line[k])) {
          k++;
        }
        const value = line.slice(start, k);
        tokens.push({kind: 'WORD', field: m[1].toLowerCase(), value, raw: value});
        i = k;
        continue;
      }
      // no value after the prefix ("from:" at end of line): fall through
      // and treat the whole "from:" as a bare word
    }
    const {value, raw} = readWord();
    const lower = value.toLowerCase();
    if (lower === 'and') {
      tokens.push({kind: 'AND', field: null, value: '', raw});
    }
    else if (lower === 'or') {
      tokens.push({kind: 'OR', field: null, value: '', raw});
    }
    else if (lower === 'not') {
      tokens.push({kind: 'NOT', field: null, value: '', raw});
    }
    else {
      tokens.push({kind: 'WORD', field: null, value, raw});
    }
  }
  return tokens;
}

/** does the term's needle occur in the haystack (case-insensitive contains) */
function contains(hay, needle) {
  return String(hay ?? '').toLowerCase().includes(String(needle).toLowerCase());
}

/**
 * Evaluates one atom against the parsed message fields.
 * @param {{field: string|null, value: string}} token
 * @param {{subject?: string, from?: string, to?: string, bodyText?: string}} msg
 */
function atomMatches(token, msg) {
  if (token.field === null) {
    // bare word: anywhere — subject, from, to and body
    return [msg.subject, msg.from, msg.to, msg.bodyText].some(v => contains(v, token.value));
  }
  switch (token.field) {
    case 'subject':
      return contains(msg.subject, token.value);
    case 'from':
    case 'sender':
      return contains(msg.from, token.value);
    case 'to':
      return contains(msg.to, token.value);
    case 'body':
      return contains(msg.bodyText, token.value);
    default:
      return false;
  }
}

/**
 * Recursive-descent evaluator over the token stream.
 * orExpr  := andExpr ('or' andExpr)*
 * andExpr := notExpr (('and')? notExpr)*     — 'and' implied between
 *                                            — adjacent atoms
 * notExpr := 'not' notExpr | atom
 * atom    := WORD | '(' orExpr ')'
 */
function makeParser(tokens) {
  let pos = 0;
  const peek = () => tokens[pos] ?? {kind: 'EOF'};
  const next = () => tokens[pos++] ?? {kind: 'EOF'};

  function orExpr() {
    let left = andExpr();
    while (peek().kind === 'OR') {
      next();
      const right = andExpr();
      const l = left, r = right;
      left = msg => l(msg) || r(msg);
    }
    return left;
  }

  function andExpr() {
    let left = notExpr();
    for (;;) {
      const t = peek();
      if (t.kind === 'AND') {
        next();
        const right = notExpr();
        const l = left, r = right;
        left = msg => l(msg) && r(msg);
      }
      else if (t.kind === 'WORD' || t.kind === 'LPAREN' || t.kind === 'NOT') {
        // implied and
        const right = notExpr();
        const l = left, r = right;
        left = msg => l(msg) && r(msg);
      }
      else {
        break;
      }
    }
    return left;
  }

  function notExpr() {
    if (peek().kind === 'NOT') {
      next();
      const inner = notExpr();
      return msg => !inner(msg);
    }
    return atom();
  }

  function atom() {
    const t = next();
    if (t.kind === 'LPAREN') {
      const inner = orExpr();
      if (peek().kind === 'RPAREN') {
        next();
      }
      return inner;
    }
    if (t.kind === 'WORD') {
      return msg => atomMatches(t, msg);
    }
    // stray operator / unmatched paren: an atom that never matches keeps
    // the line well-formed (the whole term is simply dead weight)
    return () => false;
  }

  return orExpr;
}

/** an empty parsed line matches nothing (the options page says so too) */
const FALSE = () => false;

// distinct lines come from the (small, stable) options-page config, so a
// plain memo keeps repeat matches allocation-free
const LINE_CACHE = new Map();

/**
 * Parses one rule line into a reusable matcher (memoized).
 * @param {string} line
 * @returns {(msg: {subject?, from?, to?, bodyText?}) => boolean}
 */
export function compileLine(line) {
  const key = String(line ?? '');
  let fn = LINE_CACHE.get(key);
  if (!fn) {
    const tokens = tokenize(key);
    // makeParser(tokens)() builds the closure tree in one pass (consuming
    // the token stream) and returns the ROOT matcher — a closure binding
    // only the message argument, reusable across messages
    fn = tokens.length ? makeParser(tokens)() : FALSE;
    LINE_CACHE.set(key, fn);
  }
  return fn;
}

/**
 * Splits a filter's query into its per-line rules (lines act as OR).
 * Blank lines and pure-whitespace lines are dropped.
 * @param {string} query
 * @returns {string[]}
 */
export function queryLines(query) {
  return String(query ?? '')
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean);
}

/**
 * Matches a message against one filter's full query (any line wins) and
 * reports the per-line verdicts — the debugging output the sync panel
 * prints for every candidate message.
 * @param {string} query
 * @param {{subject?, from?, to?, bodyText?}} msg parsed message fields
 * @returns {{matched: boolean, lines: Array<{n: number, rule: string,
 *            hit: boolean}>}}
 */
export function filterMatches(query, msg) {
  const lines = queryLines(query).map((rule, i) => ({n: i + 1, rule, hit: false}));
  let matched = false;
  for (const entry of lines) {
    try {
      entry.hit = compileLine(entry.rule)(msg);
    }
    catch {
      entry.hit = false;   // a broken line can never match
    }
    if (entry.hit) {
      matched = true;
    }
  }
  return {matched, lines};
}
