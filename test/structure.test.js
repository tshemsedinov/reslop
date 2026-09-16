'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const LIB = path.join(__dirname, '../lib');
const MAX_FILE = 1000;
const MAX_FN = 100;
const MAX_SESSION = 500;
const CONTROL = new Set([
  'if',
  'for',
  'while',
  'switch',
  'catch',
  'with',
  'else',
  'try',
  'finally',
  'do',
]);

const SQUOTE = '\x27';
const DQUOTE = '\x22';
const TICK = '\x60';

const walkJs = (dir, out = []) => {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkJs(full, out);
      continue;
    }
    if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
};

const splitLines = (text) => {
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  return lines;
};

const identBefore = (text, end) => {
  let i = end;
  while (i > 0 && /\s/.test(text[i - 1])) i -= 1;
  if (i === 0) return { name: '', end: i };
  if (!/[\w$]/.test(text[i - 1])) return { name: '', end: i };
  let start = i;
  while (start > 0 && /[\w$]/.test(text[start - 1])) start -= 1;
  return { name: text.slice(start, i), end: start };
};

const skipSpace = (text, i) => {
  while (i > 0 && /\s/.test(text[i - 1])) i -= 1;
  return i;
};

const matchParen = (text, close) => {
  let depth = 0;
  for (let i = close; i >= 0; i--) {
    const ch = text[i];
    if (ch === ')') depth += 1;
    if (ch === '(') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
};

const isFunctionBrace = (text, braceAt) => {
  const i = skipSpace(text, braceAt);
  if (i >= 2 && text.slice(i - 2, i) === '=>') return true;
  if (i === 0 || text[i - 1] !== ')') return false;
  const open = matchParen(text, i - 1);
  if (open < 0) return false;
  const head = identBefore(text, open);
  if (!head.name) return false;
  if (CONTROL.has(head.name)) return false;
  return true;
};

const isClassBrace = (text, braceAt) => {
  const head = identBefore(text, skipSpace(text, braceAt));
  if (!head.name) return false;
  const before = identBefore(text, head.end);
  if (before.name === 'class') return { name: head.name };
  if (head.name === 'class') return { name: '' };
  return null;
};

const scanText = (text) => {
  const lines = splitLines(text);
  const functions = [];
  const classes = [];
  let line = 1;
  let inStr = null;
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;
  const stack = [];

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === '\n') {
      line += 1;
      inLineComment = false;
      escaped = false;
      continue;
    }
    if (inLineComment) continue;
    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        i += 1;
      }
      continue;
    }
    if (inStr) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === SQUOTE || ch === DQUOTE || ch === TICK) {
      inStr = ch;
      continue;
    }
    if (ch === '/' && next === '/') {
      inLineComment = true;
      i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      inBlockComment = true;
      i += 1;
      continue;
    }
    if (ch === '{') {
      const cls = isClassBrace(text, i);
      if (cls) {
        stack.push({ kind: 'class', name: cls.name, start: line });
      } else if (isFunctionBrace(text, i)) {
        stack.push({ kind: 'fn', name: '', start: line });
      } else {
        stack.push({ kind: 'block', name: '', start: line });
      }
      continue;
    }
    if (ch === '}') {
      const top = stack.pop();
      if (!top) continue;
      if (top.kind === 'fn') functions.push({ start: top.start, end: line });
      if (top.kind === 'class') {
        classes.push({ name: top.name, start: top.start, end: line });
      }
    }
  }
  return { lines: lines.length, functions, classes };
};

const rel = (file) => path.relative(path.join(__dirname, '..'), file);

test('lib files stay under structural limits', () => {
  const files = walkJs(LIB);
  const errors = [];
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    const scanned = scanText(text);
    const name = rel(file);
    if (scanned.lines > MAX_FILE) {
      errors.push(`${name}: ${scanned.lines} lines (max ${MAX_FILE})`);
    }
    for (const fn of scanned.functions) {
      const span = fn.end - fn.start + 1;
      if (span > MAX_FN) {
        errors.push(`${name}:${fn.start}-${fn.end}: function ${span} lines`);
      }
    }
    for (const cls of scanned.classes) {
      if (cls.name !== 'Session') continue;
      const span = cls.end - cls.start + 1;
      if (span > MAX_SESSION) {
        errors.push(
          `${name}: Session class ${span} lines (max ${MAX_SESSION})`,
        );
      }
    }
  }
  assert.equal(errors.join('\n'), '');
});

test('extracted session modules do not import Session', () => {
  const dir = path.join(LIB, 'session');
  const files = walkJs(dir);
  const hits = [];
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    if (/require\('\.\.\/session\.js'\)/.test(text)) hits.push(rel(file));
    if (/require\('\.\/session\.js'\)/.test(text)) hits.push(rel(file));
  }
  assert.deepEqual(hits, []);
});
