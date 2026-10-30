'use strict';

const core = require('./core.js');
const { QUOTES, IDENT_START, IDENT_CHAR, EXPECT_STYLE } = core;
const { words, emit, wordStyles, appendNode, scanWhile } = core;
const { lineEnd, blockCommentEnd, stringEnd, numberEnd, operatorEnd } = core;
const { pushInterpolation, highlightInterpolated, nameStyle } = core;

const OPTIONS = {
  js: {},
  mjs: {},
  ts: { ts: true },
  jsx: { jsx: true },
  tsx: { ts: true, jsx: true },
};

const OP_CHARS = '=!+-*%>&|^~?:/<';
const PUNCT_CHARS = '{}()[];,.';
const DIGITS = '0123456789';
const JSX_NAME = /[A-Za-z0-9_$.:-]/;
const JSX_TEXT = /[^<{]/;
const REGEX_AFTER_OP = /[=(:,[?!&|{};]$/;
const REGEX_AFTER_WORD = /(?:return|case|throw|=>|typeof|void)$/;

const TEMPLATE = {
  style: 'template',
  quote: '`',
  raw: false,
  multiline: true,
  dollarIdent: false,
};

const STORAGE = words(`
  const let var function class extends static async get set constructor new
  typeof instanceof void delete yield await import export from as default
  type interface implements enum namespace module declare abstract readonly
  private public protected override satisfies
`);

const CONTROL = words(`
  if else for while do switch case break continue return throw try catch
  finally with of in
`);

const LITERALS = words('true false null undefined NaN Infinity this super');

const TYPES = words(`
  string number boolean symbol bigint object any unknown never void keyof
  infer unique asserts is
`);

const BUILTINS = words(`
  console Math JSON Date Array Object String Number Boolean Map Set WeakMap
  WeakSet Promise Error RegExp Symbol Proxy Reflect Intl Buffer process module
  exports require global globalThis window document parseInt parseFloat isNaN
  isFinite encodeURI decodeURI encodeURIComponent decodeURIComponent
  setTimeout setInterval clearTimeout clearInterval fetch URL URLSearchParams
`);

const NEXT_EXPECT = wordStyles({
  function: ['function'],
  class: ['class', 'interface', 'enum'],
  type: ['type'],
});

const wordTable = (type) => {
  const groups = { control: CONTROL, literal: LITERALS, storage: STORAGE };
  return wordStyles({ ...groups, className: BUILTINS, type });
};

const WORD_STYLE = wordTable(TYPES.filter((word) => STORAGE.includes(word)));
const TS_WORD_STYLE = wordTable(TYPES);

const tailText = (out, size) => {
  let text = '';
  for (let i = out.length - 1; i >= 0; i--) {
    text = out[i].text + text;
    if (text.trimEnd().length >= size) break;
  }
  return text;
};

const isRegexContext = (out) => {
  const prev = tailText(out, 6).trimEnd();
  return !prev || REGEX_AFTER_OP.test(prev) || REGEX_AFTER_WORD.test(prev);
};

const assignStyle = (source, index) => {
  const rhs = scanWhile(source, index + 1, /\s/);
  if (source.startsWith('async', rhs)) return 'function';
  if (source.startsWith('function', rhs)) return 'function';
  return source[rhs] === '(' ? 'function' : 'variable';
};

const trailStyle = (source, index, out) => {
  if (source[index] === '=') return assignStyle(source, index);
  return tailText(out, 1).endsWith('.') ? 'property' : 'variable';
};

const regexEnd = (source, i) => {
  let j = i + 1;
  const length = source.length;
  while (j < length) {
    if (source[j] === '\\') {
      j += 2;
      continue;
    }
    if (source[j] === '[') {
      j += 1;
      while (j < length && source[j] !== ']') {
        if (source[j] === '\\') j += 1;
        j += 1;
      }
      j += 1;
      continue;
    }
    if (source[j] === '/') return scanWhile(source, j + 1, /[a-z]/i);
    if (source[j] === '\n') break;
    j += 1;
  }
  return j;
};

const isJsxTagStart = (source, i) => {
  if (i > 0 && IDENT_CHAR.test(source[i - 1])) return false;
  const next = source[i + 1];
  if (next === '>' || next === '/') return true;
  if (!IDENT_START.test(next || '')) return false;
  const nameEnd = scanWhile(source, i + 1, JSX_NAME);
  const after = source[scanWhile(source, nameEnd, /\s/)];
  if (after === '>' || after === '/' || after === '{') return true;
  return IDENT_START.test(after || '');
};

const jsxNameStyle = (name) => {
  if (/^[A-Z]/.test(name) || name.includes('.')) return 'className';
  return 'tag';
};

const pushJsxExpr = (out, source, i, inner) => {
  emit(out, 'interpolation', '{');
  return pushInterpolation(out, source, i + 1, inner);
};

const highlightJsxTagTail = (source, start, inner, out) => {
  let i = start;
  const take = (style, end) => {
    emit(out, style, source.slice(i, end));
    i = end;
  };
  while (i < source.length) {
    const char = source[i];
    if (char === '>') {
      take('punct', i + 1);
      return { end: i, selfClosing: false };
    }
    if (char === '/' && source[i + 1] === '>') {
      take('punct', i + 2);
      return { end: i, selfClosing: true };
    }
    if (char === '{') {
      i = pushJsxExpr(out, source, i, inner);
    } else if (QUOTES.includes(char)) {
      take('string', stringEnd(source, i));
    } else if (IDENT_START.test(char)) {
      take('attr', scanWhile(source, i, JSX_NAME));
    } else if (/\s/.test(char)) {
      take('plain', i + 1);
    } else {
      take('punct', i + 1);
    }
  }
  return { end: i, selfClosing: false };
};

const highlightJsxElement = (source, start, inner) => {
  const tokens = [];
  let i = start + 1;
  emit(tokens, 'punct', '<');
  const closing = source[i] === '/';
  if (closing) {
    emit(tokens, 'punct', '/');
    i += 1;
  }
  const nameEnd = scanWhile(source, i, JSX_NAME);
  const name = source.slice(i, nameEnd);
  emit(tokens, jsxNameStyle(name), name);
  const tail = highlightJsxTagTail(source, nameEnd, inner, tokens);
  i = tail.end;
  if (closing || tail.selfClosing) return { tokens, end: i };
  while (i < source.length) {
    if (source.startsWith('</', i)) {
      const end = appendNode(tokens, highlightJsxElement(source, i, inner));
      return { tokens, end };
    }
    if (source[i] === '{') {
      i = pushJsxExpr(tokens, source, i, inner);
    } else if (source[i] === '<' && isJsxTagStart(source, i)) {
      i = appendNode(tokens, highlightJsxElement(source, i, inner));
    } else {
      const end = source[i] === '<' ? i + 1 : scanWhile(source, i, JSX_TEXT);
      emit(tokens, 'plain', source.slice(i, end));
      i = end;
    }
  }
  return { tokens, end: i };
};

const startsNumber = (char, next) => {
  const dotted = char === '.' && DIGITS.includes(next || '');
  return dotted || DIGITS.includes(char);
};

const highlightJsFamily = (source, options) => {
  const table = options.ts ? TS_WORD_STYLE : WORD_STYLE;
  const inner = (expr) => highlightJsFamily(expr, options);
  const out = [];
  let i = 0;
  let expectName = null;
  const take = (style, end) => {
    emit(out, style, source.slice(i, end));
    i = end;
  };
  while (i < source.length) {
    const char = source[i];
    const next = source[i + 1];
    if (char === '/' && next === '/') {
      take('comment', lineEnd(source, i));
    } else if (char === '/' && next === '*') {
      take('comment', blockCommentEnd(source, i));
    } else if (char === '/' && isRegexContext(out)) {
      take('regex', regexEnd(source, i));
    } else if (char === '<' && options.jsx && isJsxTagStart(source, i)) {
      i = appendNode(out, highlightJsxElement(source, i, inner));
      expectName = null;
    } else if (char === '`') {
      const node = highlightInterpolated(source, i, i + 1, TEMPLATE, inner);
      i = appendNode(out, node);
    } else if (QUOTES.includes(char)) {
      take('string', stringEnd(source, i));
    } else if (char === '@') {
      take('decorator', scanWhile(source, i + 1, IDENT_CHAR));
      expectName = null;
    } else if (startsNumber(char, next)) {
      take('number', numberEnd(source, i));
    } else if (IDENT_START.test(char)) {
      const end = scanWhile(source, i + 1, IDENT_CHAR);
      const word = source.slice(i, end);
      const index = scanWhile(source, end, /\s/);
      const style =
        EXPECT_STYLE[expectName] ||
        table[word] ||
        nameStyle(word, source[index]) ||
        trailStyle(source, index, out);
      const nextExpect = NEXT_EXPECT[word] ?? null;
      take(style, end);
      expectName = EXPECT_STYLE[expectName] ? null : nextExpect;
    } else if (OP_CHARS.includes(char)) {
      take('operator', operatorEnd(source, i));
      expectName = null;
    } else {
      take(PUNCT_CHARS.includes(char) ? 'punct' : 'plain', i + 1);
    }
  }
  return out;
};

const highlight = (source, lang) => highlightJsFamily(source, OPTIONS[lang]);

module.exports = {
  highlight,
  langs: ['js', 'mjs', 'ts', 'jsx', 'tsx'],
  aliases: {
    javascript: 'js',
    typescript: 'ts',
    cjs: 'js',
    dts: 'ts',
  },
};
