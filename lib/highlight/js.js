'use strict';

const hl = require('./core.js');
const { QUOTES, EXPECT_STYLE, emit, tokensText, wordStyle } = hl;
const { peekIdent, skipWs, readUntilNl, readBlockComment } = hl;
const { readJsNumber, readJsOperator, readString } = hl;
const { readTemplateInterp, styleConstant, stylePascal, styleCall } = hl;

const OPTIONS = {
  js: {},
  mjs: {},
  ts: { ts: true },
  jsx: { jsx: true },
  tsx: { ts: true, jsx: true },
};

const DIGITS = '0123456789';
const IDENT_START = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$';
const OP_CHARS = '=!+-*%>&|^~?:';
const PUNCT_CHARS = '{}()[];,';

const STORAGE = [
  'const',
  'let',
  'var',
  'function',
  'class',
  'extends',
  'static',
  'async',
  'get',
  'set',
  'constructor',
  'new',
  'typeof',
  'instanceof',
  'void',
  'delete',
  'yield',
  'await',
  'import',
  'export',
  'from',
  'as',
  'default',
  'type',
  'interface',
  'implements',
  'enum',
  'namespace',
  'module',
  'declare',
  'abstract',
  'readonly',
  'private',
  'public',
  'protected',
  'override',
  'satisfies',
];

const CONTROL = [
  'if',
  'else',
  'for',
  'while',
  'do',
  'switch',
  'case',
  'break',
  'continue',
  'return',
  'throw',
  'try',
  'catch',
  'finally',
  'with',
  'of',
  'in',
];

const LITERALS = [
  'true',
  'false',
  'null',
  'undefined',
  'NaN',
  'Infinity',
  'this',
  'super',
];

const TYPES = [
  'string',
  'number',
  'boolean',
  'symbol',
  'bigint',
  'object',
  'any',
  'unknown',
  'never',
  'void',
  'keyof',
  'infer',
  'unique',
  'asserts',
  'is',
];

const BUILTINS = [
  'console',
  'Math',
  'JSON',
  'Date',
  'Array',
  'Object',
  'String',
  'Number',
  'Boolean',
  'Map',
  'Set',
  'WeakMap',
  'WeakSet',
  'Promise',
  'Error',
  'RegExp',
  'Symbol',
  'Proxy',
  'Reflect',
  'Intl',
  'Buffer',
  'process',
  'module',
  'exports',
  'require',
  'global',
  'globalThis',
  'window',
  'document',
  'parseInt',
  'parseFloat',
  'isNaN',
  'isFinite',
  'encodeURI',
  'decodeURI',
  'encodeURIComponent',
  'decodeURIComponent',
  'setTimeout',
  'setInterval',
  'clearTimeout',
  'clearInterval',
  'fetch',
  'URL',
  'URLSearchParams',
];

const NEXT_EXPECT = {
  function: 'function',
  class: 'class',
  interface: 'class',
  enum: 'class',
  type: 'type',
};

const typeOverlay = TYPES.filter((word) => STORAGE.includes(word));

const WORD_STYLE = {
  ...wordStyle(CONTROL, 'control'),
  ...wordStyle(LITERALS, 'literal'),
  ...wordStyle(BUILTINS, 'className'),
  ...wordStyle(STORAGE, 'storage'),
  ...wordStyle(typeOverlay, 'type'),
};

const TS_WORD_STYLE = {
  ...WORD_STYLE,
  ...wordStyle(TYPES, 'type'),
};

const plainTail = (out) => tokensText(out).slice(-8);

const styleExpected = ({ expectName }) => EXPECT_STYLE[expectName];

const styleKeyword = ({ word, ts }) => {
  const table = ts ? TS_WORD_STYLE : WORD_STYLE;
  if (!Object.hasOwn(table, word)) return null;
  return table[word];
};

const styleAssign = ({ after, source, k }) => {
  if (after !== '=') return null;
  const k2 = skipWs(source, k + 1);
  const rhs = source.slice(k2, k2 + 8);
  if (rhs.startsWith('async')) return 'function';
  if (rhs.startsWith('function')) return 'function';
  if (source[k2] === '(') return 'function';
  return 'variable';
};

const styleProperty = ({ out }) => {
  const prev = plainTail(out);
  return /\.$/.test(prev) ? 'property' : null;
};

const IDENT_RULES = [
  styleExpected,
  styleKeyword,
  styleConstant,
  stylePascal,
  styleCall,
  styleAssign,
  styleProperty,
];

const identStyle = (ctx) => {
  for (const rule of IDENT_RULES) {
    const style = rule(ctx);
    if (style) return style;
  }
  return 'variable';
};

const readRegex = (source, i) => {
  let j = i + 1;
  const n = source.length;
  while (j < n) {
    if (source[j] === '\\') {
      j += 2;
      continue;
    }
    if (source[j] === '[') {
      j += 1;
      while (j < n && source[j] !== ']') {
        if (source[j] === '\\') j += 1;
        j += 1;
      }
      j += 1;
      continue;
    }
    if (source[j] === '/') {
      j += 1;
      while (j < n && /[a-z]/i.test(source[j])) j += 1;
      break;
    }
    if (source[j] === '\n') break;
    j += 1;
  }
  return { text: source.slice(i, j), end: j };
};

const isRegexContext = (out) => {
  const prev = tokensText(out).trimEnd();
  if (!prev) return true;
  const afterOperator = /[=(:,[?!&|{};]$/.test(prev);
  const afterKeyword = /(?:return|case|throw|=>|typeof|void)$/.test(prev);
  return afterOperator || afterKeyword;
};

const highlightTemplate = (source, i, highlightExpr) => {
  const n = source.length;
  let j = i + 1;
  const parts = [];
  emit(parts, 'template', '`');
  let buf = '';
  const flush = () => {
    if (buf) {
      emit(parts, 'template', buf);
      buf = '';
    }
  };
  while (j < n) {
    if (source[j] === '\\') {
      flush();
      emit(parts, 'escape', source.slice(j, j + 2));
      j += 2;
      continue;
    }
    if (source[j] === '`') {
      flush();
      emit(parts, 'template', '`');
      j += 1;
      break;
    }
    if (source[j] === '$' && source[j + 1] === '{') {
      flush();
      emit(parts, 'interpolation', '${');
      j += 2;
      const interp = readTemplateInterp(source, j);
      const inner = highlightExpr(interp.expr);
      for (const t of inner) parts.push(t);
      j = interp.end;
      if (source[j] === '}') {
        emit(parts, 'interpolation', '}');
        j += 1;
      }
      continue;
    }
    buf += source[j];
    j += 1;
  }
  flush();
  return { tokens: parts, end: j };
};

const isJsxTagStart = (source, i) => {
  if (source[i] !== '<') return false;
  if (i > 0 && /[A-Za-z0-9_$]/.test(source[i - 1])) return false;
  const next = source[i + 1];
  if (next === '>' || next === '/') return true;
  if (!/[A-Za-z_$]/.test(next || '')) return false;
  let j = i + 1;
  while (j < source.length && /[A-Za-z0-9_$.:-]/.test(source[j])) j += 1;
  const after = source[skipWs(source, j)];
  if (after === '>' || after === '/' || after === '{') return true;
  return /[A-Za-z_$]/.test(after || '');
};

const jsxNameStyle = (name) => {
  if (/^[A-Z]/.test(name) || name.includes('.')) return 'className';
  return 'tag';
};

const readJsxName = (source, i) => {
  let j = i;
  while (j < source.length && /[A-Za-z0-9_$.:-]/.test(source[j])) j += 1;
  return { text: source.slice(i, j), end: j };
};

const highlightJsxExpr = (source, i, inner) => {
  const out = [];
  emit(out, 'interpolation', '{');
  const interp = readTemplateInterp(source, i + 1);
  const tokens = inner(interp.expr);
  for (const t of tokens) out.push(t);
  let end = interp.end;
  if (source[end] === '}') {
    emit(out, 'interpolation', '}');
    end += 1;
  }
  return { tokens: out, end };
};

const highlightJsxTagTail = (source, i, inner, out) => {
  const n = source.length;
  let selfClosing = false;
  while (i < n) {
    const ch = source[i];
    if (ch === '>') {
      emit(out, 'punct', '>');
      i += 1;
      break;
    }
    if (ch === '/' && source[i + 1] === '>') {
      emit(out, 'punct', '/>');
      i += 2;
      selfClosing = true;
      break;
    }
    if (/\s/.test(ch)) {
      emit(out, 'plain', ch);
      i += 1;
      continue;
    }
    if (ch === '{') {
      const expr = highlightJsxExpr(source, i, inner);
      for (const t of expr.tokens) out.push(t);
      i = expr.end;
      continue;
    }
    if (QUOTES.includes(ch)) {
      const { text, end } = readString(source, i);
      emit(out, 'string', text);
      i = end;
      continue;
    }
    if (ch === '=') {
      emit(out, 'punct', '=');
      i += 1;
      continue;
    }
    if (/[A-Za-z_$]/.test(ch)) {
      const { text, end } = readJsxName(source, i);
      emit(out, 'attr', text);
      i = end;
      continue;
    }
    emit(out, 'punct', ch);
    i += 1;
  }
  return { end: i, selfClosing };
};

const highlightJsxElement = (source, i, inner) => {
  const out = [];
  const n = source.length;
  emit(out, 'punct', '<');
  i += 1;
  let closing = false;
  if (source[i] === '/') {
    emit(out, 'punct', '/');
    i += 1;
    closing = true;
  }
  const nameRead = readJsxName(source, i);
  const name = nameRead.text;
  if (name) {
    emit(out, jsxNameStyle(name), name);
    i = nameRead.end;
  }
  const tail = highlightJsxTagTail(source, i, inner, out);
  i = tail.end;
  if (closing || tail.selfClosing) return { tokens: out, end: i };
  while (i < n) {
    if (source.startsWith('</', i)) {
      const close = highlightJsxElement(source, i, inner);
      for (const t of close.tokens) out.push(t);
      return { tokens: out, end: close.end };
    }
    if (source[i] === '{') {
      const expr = highlightJsxExpr(source, i, inner);
      for (const t of expr.tokens) out.push(t);
      i = expr.end;
      continue;
    }
    if (source[i] === '<' && isJsxTagStart(source, i)) {
      const child = highlightJsxElement(source, i, inner);
      for (const t of child.tokens) out.push(t);
      i = child.end;
      continue;
    }
    let j = i;
    while (j < n && source[j] !== '<' && source[j] !== '{') j += 1;
    if (j === i) {
      emit(out, 'plain', source[i]);
      i += 1;
      continue;
    }
    emit(out, 'plain', source.slice(i, j));
    i = j;
  }
  return { tokens: out, end: i };
};

const readLineComment = (source, i) => {
  if (source[i + 1] !== '/') return null;
  const { text, end } = readUntilNl(source, i);
  return { end, tokens: [{ text, style: 'comment' }] };
};

const readStarComment = (source, i) => {
  if (source[i + 1] !== '*') return null;
  const { text, end } = readBlockComment(source, i);
  return { end, tokens: [{ text, style: 'comment' }] };
};

const readRegexAt = (source, i, scan) => {
  if (!isRegexContext(scan.out)) return null;
  const { text, end } = readRegex(source, i);
  return { end, tokens: [{ text, style: 'regex' }] };
};

const readOperatorAt = (source, i) => {
  const { text, end } = readJsOperator(source, i);
  const tokens = [{ text, style: 'operator' }];
  return { end, tokens, expectName: null };
};

const readSlashToken = (source, i, scan) =>
  readLineComment(source, i) ||
  readStarComment(source, i) ||
  readRegexAt(source, i, scan) ||
  readOperatorAt(source, i);

const readQuoted = (source, i) => {
  const { text, end } = readString(source, i);
  return { end, tokens: [{ text, style: 'string' }] };
};

const readTemplateAt = (source, i, scan) => {
  const result = highlightTemplate(source, i, scan.inner);
  return { end: result.end, tokens: result.tokens };
};

const readNumberAt = (source, i) => {
  const ch = source[i];
  const next = source[i + 1];
  const dotted = ch === '.' && DIGITS.includes(next || '');
  if (!DIGITS.includes(ch) && !dotted) return null;
  const { text, end } = readJsNumber(source, i);
  return { end, tokens: [{ text, style: 'number' }] };
};

const readPunctAt = (source, i) => {
  const text = source[i];
  return { end: i + 1, tokens: [{ text, style: 'punct' }] };
};

const readDotToken = (source, i) =>
  readNumberAt(source, i) || readPunctAt(source, i);

const readDecorator = (source, i) => {
  let j = i + 1;
  while (j < source.length && /[A-Za-z0-9_$]/.test(source[j])) j += 1;
  const text = source.slice(i, j);
  const tokens = [{ text, style: 'decorator' }];
  return { end: j, tokens, expectName: null };
};

const nextExpectName = (word, expectName) => {
  if (EXPECT_STYLE[expectName]) return null;
  return NEXT_EXPECT[word] ?? null;
};

const readIdentAt = (source, i, scan) => {
  const word = peekIdent(source, i);
  if (!word) return null;
  const end = i + word.length;
  const k = skipWs(source, end);
  const after = source[k];
  const { ts, out } = scan;
  const ctx = { word, ts, after, source, k, out, expectName: scan.expectName };
  const style = identStyle(ctx);
  const tokens = [{ text: word, style }];
  const expectName = nextExpectName(word, scan.expectName);
  return { end, tokens, expectName };
};

const readJsxAt = (source, i, scan) => {
  if (!scan.jsx || !isJsxTagStart(source, i)) return null;
  const node = highlightJsxElement(source, i, scan.inner);
  const tokens = node.tokens;
  const end = node.end;
  return { end, tokens, expectName: null };
};

const readLessToken = (source, i, scan) =>
  readJsxAt(source, i, scan) || readOperatorAt(source, i);

const readPlain = (source, i) => {
  const text = source[i];
  return { end: i + 1, tokens: [{ text, style: 'plain' }] };
};

const CHAR_READER_GROUPS = [
  { chars: '/', reader: readSlashToken },
  { chars: '<', reader: readLessToken },
  { chars: '.', reader: readDotToken },
  { chars: '`', reader: readTemplateAt },
  { chars: QUOTES, reader: readQuoted },
  { chars: '@', reader: readDecorator },
  { chars: DIGITS, reader: readNumberAt },
  { chars: IDENT_START, reader: readIdentAt },
  { chars: OP_CHARS, reader: readOperatorAt },
  { chars: PUNCT_CHARS, reader: readPunctAt },
];

const indexCharReaders = (groups) => {
  const table = Object.create(null);
  for (const group of groups) {
    for (const ch of group.chars) table[ch] = group.reader;
  }
  return table;
};

const CHAR_READERS = indexCharReaders(CHAR_READER_GROUPS);

const readToken = (source, i, scan) => {
  const reader = CHAR_READERS[source[i]] ?? readPlain;
  const result = reader(source, i, scan);
  if (result && result.end > i) return result;
  return readPlain(source, i);
};

const highlightJsFamily = (source, options = {}) => {
  const ts = options.ts === true;
  const jsx = options.jsx === true;
  const inner = (expr) => highlightJsFamily(expr, options);
  const out = [];
  const scan = { ts, jsx, inner, out, expectName: null };
  let i = 0;
  while (i < source.length) {
    const result = readToken(source, i, scan);
    for (const token of result.tokens) out.push(token);
    i = result.end;
    if (Object.hasOwn(result, 'expectName')) {
      scan.expectName = result.expectName;
    }
  }
  return out;
};

const highlight = (source, lang) => {
  const options = OPTIONS[lang] ?? {};
  return highlightJsFamily(source, options);
};

module.exports = {
  langs: ['js', 'mjs', 'ts', 'jsx', 'tsx'],
  aliases: {
    javascript: 'js',
    typescript: 'ts',
    cjs: 'js',
    dts: 'ts',
  },
  highlight,
};
