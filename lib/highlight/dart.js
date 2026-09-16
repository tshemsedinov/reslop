'use strict';

const hl = require('./core.js');
const { SQUOTE, QUOTES, EXPECT_STYLE, emit, wordStyle } = hl;
const { peekIdent, skipWs, readUntilNl, readBlockComment } = hl;
const { readJsNumber, readJsOperator, readTemplateInterp } = hl;
const { styleConstant, stylePascal, styleCall } = hl;

const STORAGE = [
  'abstract',
  'as',
  'base',
  'class',
  'const',
  'covariant',
  'deferred',
  'enum',
  'export',
  'extends',
  'extension',
  'external',
  'factory',
  'final',
  'get',
  'hide',
  'implements',
  'import',
  'interface',
  'late',
  'library',
  'mixin',
  'on',
  'operator',
  'part',
  'required',
  'sealed',
  'set',
  'show',
  'static',
  'typedef',
  'var',
  'with',
];

const CONTROL = [
  'assert',
  'async',
  'await',
  'break',
  'case',
  'catch',
  'continue',
  'default',
  'do',
  'else',
  'for',
  'if',
  'in',
  'is',
  'new',
  'rethrow',
  'return',
  'switch',
  'sync',
  'throw',
  'try',
  'when',
  'while',
  'yield',
];

const LITERALS = ['true', 'false', 'null', 'this', 'super'];

const TYPES = ['void', 'dynamic', 'Never', 'int', 'double', 'num', 'bool'];

const NEXT_EXPECT = {
  class: 'class',
  mixin: 'class',
  enum: 'class',
  extension: 'class',
  typedef: 'type',
};

const WORD_STYLE = {
  ...wordStyle(CONTROL, 'control'),
  ...wordStyle(LITERALS, 'literal'),
  ...wordStyle(STORAGE, 'storage'),
  ...wordStyle(TYPES, 'type'),
};

const dartStringOpen = (source, i) => {
  let at = i;
  const raw = source[i] === 'r';
  if (raw) at = i + 1;
  let quote = '';
  const triple = SQUOTE.repeat(3);
  const dtriple = '"'.repeat(3);
  if (source.startsWith(triple, at) || source.startsWith(dtriple, at)) {
    quote = source.slice(at, at + 3);
  } else if (QUOTES.includes(source[at] || '')) {
    quote = source[at];
  }
  if (!quote) return null;
  return { raw, quote, body: at + quote.length };
};

const dartIdentStyle = (ctx) => {
  const known = WORD_STYLE[ctx.word];
  if (known) return known;
  if (EXPECT_STYLE[ctx.expectName]) return EXPECT_STYLE[ctx.expectName];
  if (styleConstant(ctx)) return 'constant';
  if (stylePascal(ctx)) return 'className';
  if (styleCall(ctx)) return 'function';
  return 'variable';
};

const highlightDartString = (source, i, inner) => {
  const open = dartStringOpen(source, i);
  const n = source.length;
  const parts = [];
  emit(parts, 'string', source.slice(i, open.body));
  let j = open.body;
  let buf = '';
  const flush = () => {
    if (!buf) return;
    emit(parts, 'string', buf);
    buf = '';
  };
  const quote = open.quote;
  while (j < n) {
    if (!open.raw && source[j] === '\\') {
      flush();
      emit(parts, 'escape', source.slice(j, j + 2));
      j += 2;
      continue;
    }
    if (source.startsWith(quote, j)) {
      flush();
      emit(parts, 'string', quote);
      j += quote.length;
      break;
    }
    if (!open.raw && source[j] === '$') {
      const next = source[j + 1];
      if (next === '{') {
        flush();
        emit(parts, 'interpolation', '${');
        j += 2;
        const interp = readTemplateInterp(source, j);
        for (const t of inner(interp.expr)) parts.push(t);
        j = interp.end;
        if (source[j] === '}') {
          emit(parts, 'interpolation', '}');
          j += 1;
        }
        continue;
      }
      if (/[A-Za-z_$]/.test(next || '')) {
        flush();
        const ident = peekIdent(source, j + 1);
        emit(parts, 'interpolation', `$${ident}`);
        j += 1 + ident.length;
        continue;
      }
    }
    if (quote.length === 1 && source[j] === '\n') break;
    buf += source[j];
    j += 1;
  }
  flush();
  return { tokens: parts, end: j };
};

const highlight = (source) => {
  const inner = (expr) => highlight(expr);
  const out = [];
  let i = 0;
  const n = source.length;
  let expectName = null;
  while (i < n) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === '/' && next === '/') {
      const { text, end } = readUntilNl(source, i);
      emit(out, 'comment', text);
      i = end;
      continue;
    }
    if (ch === '/' && next === '*') {
      const { text, end } = readBlockComment(source, i);
      emit(out, 'comment', text);
      i = end;
      continue;
    }
    if (dartStringOpen(source, i)) {
      const node = highlightDartString(source, i, inner);
      for (const t of node.tokens) out.push(t);
      i = node.end;
      expectName = null;
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(next || ''))) {
      const { text, end } = readJsNumber(source, i);
      emit(out, 'number', text);
      i = end;
      continue;
    }
    if (ch === '@' || ch === '#') {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_$]/.test(source[j])) j += 1;
      const kind = ch === '@' ? 'decorator' : 'constant';
      emit(out, kind, source.slice(i, j));
      i = j;
      expectName = null;
      continue;
    }
    if (/[A-Za-z_$]/.test(ch)) {
      const word = peekIdent(source, i);
      const end = i + word.length;
      const k = skipWs(source, end);
      const after = source[k];
      const ctx = { word, after, expectName };
      emit(out, dartIdentStyle(ctx), word);
      if (EXPECT_STYLE[expectName]) expectName = null;
      else expectName = NEXT_EXPECT[word] ?? null;
      i = end;
      continue;
    }
    if (/[=<>!+\-*/%&|^~?:]/.test(ch)) {
      const { text, end } = readJsOperator(source, i);
      emit(out, 'operator', text);
      i = end;
      expectName = null;
      continue;
    }
    if (/[{}()[\];,.]/.test(ch)) {
      emit(out, 'punct', ch);
      i += 1;
      continue;
    }
    emit(out, 'plain', ch);
    i += 1;
  }
  return out;
};

module.exports = { langs: ['dart'], highlight };
