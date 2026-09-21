'use strict';

// Tiny notmuch-like search language for filter rules. The same module serves
// the worker engine (matching) and the options page (save-time validation):
// no chrome APIs, no DOM — plain parse and evaluate.
//
// Grammar, loosest binding first (within one line):
//   query   = or
//   or      = and ("or" and)*
//   and     = not (("and")? not)*      — "and" is implied between adjacent terms
//   not     = "not" not | primary
//   primary = "(" or ")" | field value | value
//
// Lines are alternatives: the query text is split into lines first and each
// line is parsed on its own; the per-line ASTs combine with 'or', so a
// message matches when ANY single line matches. Quotes cannot span lines.
//
// Fields: subject:, from: (alias sender:), to:, body:. A field applies to
// the single value after it — a bare word or a "quoted phrase" (quotes have
// no escapes; the closing " ends the value, and optional whitespace after
// the colon is allowed). A value without a field matches anywhere: subject,
// from, to and body. Keywords are case-insensitive, so is matching ("contains").
// An empty query matches every message.

const FIELDS = ['subject', 'from', 'sender', 'to', 'body'];
const FIELD_ALIASES = {sender: 'from'};

const isSpace = c => /\s/.test(c);
const isSpecial = c => c === '(' || c === ')' || c === '"';

// Token types: '(' ')' | 'and' 'or' 'not' | {type: 'field', name} |
// {type: 'term', field, value} with field null for a bare value.
function tokenize(input) {
  const tokens = [];
  let i = 0;
  while (i < input.length) {
    const c = input[i];
    if (isSpace(c)) {
      i++;
      continue;
    }
    if (c === '(' || c === ')') {
      tokens.push({type: c});
      i++;
      continue;
    }
    if (c === '"') {
      const end = input.indexOf('"', i + 1);
      if (end === -1) {
        throw new Error('unterminated quoted value (missing closing ")');
      }
      tokens.push({type: 'term', field: null, value: input.slice(i + 1, end)});
      i = end + 1;
      continue;
    }
    // bare word: runs until whitespace, a bracket or a quote
    let j = i;
    while (j < input.length && !isSpace(input[j]) && !isSpecial(input[j])) {
      j++;
    }
    const word = input.slice(i, j);
    i = j;
    const lower = word.toLowerCase();
    if (lower === 'and' || lower === 'or' || lower === 'not') {
      tokens.push({type: lower});
      continue;
    }
    // "field:" on its own (value follows as the next token) — a known field
    // becomes a field token, an unknown one (e.g. "is:") is a likely typo
    const name = lower.match(/^([a-z0-9_-]+):$/);
    if (name) {
      if (!FIELDS.includes(name[1])) {
        throw new Error('unknown field "' + word + '" (known: ' + FIELDS.join(', ') + ')');
      }
      tokens.push({type: 'field', name: FIELD_ALIASES[name[1]] || name[1]});
      continue;
    }
    // glued "field:value" — only for the known fields, so URLs ("https://…")
    // and times ("12:30") stay plain values
    const glued = word.match(/^([^:\s]+):(.+)$/);
    if (glued && FIELDS.includes(glued[1].toLowerCase())) {
      const field = glued[1].toLowerCase();
      tokens.push({type: 'term', field: FIELD_ALIASES[field] || field, value: glued[2]});
      continue;
    }
    tokens.push({type: 'term', field: null, value: word});
  }
  return tokens;
}

// Parse one tokenized line with the recursive-descent parser. Returns the
// AST, or null when the line holds no tokens.
function parseTokens(tokens) {
  if (!tokens.length) {
    return null;
  }
  let pos = 0;
  const peek = () => tokens[pos];

  function parsePrimary() {
    const tok = tokens[pos++];
    if (!tok) {
      throw new Error('expected a search term or "("');
    }
    if (tok.type === '(') {
      const node = parseOr();
      if (!peek() || peek().type !== ')') {
        throw new Error('missing ")"');
      }
      pos++;
      return node;
    }
    if (tok.type === 'term') {
      return {type: 'term', field: tok.field, value: tok.value};
    }
    if (tok.type === 'field') {
      // a field applies to the single value that follows it
      const next = peek();
      if (!next || next.type !== 'term' || next.field !== null) {
        throw new Error('missing value after "' + tok.name + ':"');
      }
      pos++;
      return {type: 'term', field: tok.name, value: next.value};
    }
    throw new Error('unexpected "' + tok.type + '"');
  }

  function parseNot() {
    if (peek() && peek().type === 'not') {
      pos++;
      return {type: 'not', node: parseNot()};
    }
    return parsePrimary();
  }

  function parseAnd() {
    let left = parseNot();
    for (;;) {
      const tok = peek();
      if (tok && tok.type === 'and') {
        pos++;
        left = {type: 'and', left, right: parseNot()};
      }
      else if (tok && (tok.type === 'term' || tok.type === 'field' ||
        tok.type === '(' || tok.type === 'not')) {
        // implicit "and" between adjacent terms/groups
        left = {type: 'and', left, right: parseNot()};
      }
      else {
        return left;
      }
    }
  }

  function parseOr() {
    let left = parseAnd();
    while (peek() && peek().type === 'or') {
      pos++;
      left = {type: 'or', left, right: parseAnd()};
    }
    return left;
  }

  const ast = parseOr();
  if (pos < tokens.length) {
    // only an unbalanced ")" can remain here
    throw new Error('unexpected ")"');
  }
  return ast;
}

// Alternative lines of one query: trimmed, empty lines dropped.
function splitLines(input) {
  return String(input ?? '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
}

// Parse a query into an AST, or null for an empty query (matches every
// message). Each line is a separate rule — the ASTs combine with 'or' nodes,
// so a message matches when ANY single line matches (within a line,
// and/or/not apply as usual). Throws a descriptive Error on syntax problems,
// prefixed with the offending line number when several lines are present.
// AST nodes:
//   {type: 'and'|'or', left, right} | {type: 'not', node}
//   {type: 'term', field: 'subject'|'from'|'to'|'body'|null, value}
export function parseQuery(input) {
  const lines = splitLines(String(input ?? ''));
  if (!lines.length) {
    return null;
  }
  let ast = null;
  for (let n = 0; n < lines.length; n++) {
    let lineAst;
    try {
      lineAst = parseTokens(tokenize(lines[n]));
    }
    catch (e) {
      if (lines.length > 1 && e instanceof Error) {
        e.message = 'line ' + (n + 1) + ': ' + e.message;
      }
      throw e;
    }
    if (!lineAst) {
      continue; // whitespace-only line — nothing to match with
    }
    ast = ast ? {type: 'or', left: ast, right: lineAst} : lineAst;
  }
  return ast;
}

// Evaluate an AST against a lazy field provider: getField(field) returns a
// promise of the field's text (or null when unavailable) for 'subject',
// 'from', 'to' and 'body' — and for null (a bare term) their combination.
// Evaluation is async and short-circuits, so expensive fields (to/body) are
// only fetched when a term actually needs them. An empty query (null AST)
// matches every message.
export async function matchesQuery(ast, getField) {
  if (!ast) {
    return true;
  }
  return evalNode(ast, getField);
}

async function evalNode(node, getField) {
  switch (node.type) {
    case 'and':
      return (await evalNode(node.left, getField)) && (await evalNode(node.right, getField));
    case 'or':
      return (await evalNode(node.left, getField)) || (await evalNode(node.right, getField));
    case 'not':
      return !(await evalNode(node.node, getField));
    default: {
      const text = await getField(node.field);
      if (text == null) {
        return false; // field unavailable — a positive term cannot match
      }
      return String(text).toLowerCase().includes(node.value.toLowerCase());
    }
  }
}