'use strict';

const { mapLang } = require('./detect.js');

const SQUOTE = '\x27';
const QUOTES = `${SQUOTE}"`;
const ANY_QUOTE = `${QUOTES}\``;
const BASH_QUOTE = `${SQUOTE}\``;

const emit = (out, style, text) => {
  if (!text) return;
  out.push({ text, style: style || 'plain' });
};

const tokensText = (out) => {
  let s = '';
  for (const t of out) s += t.text;
  return s;
};

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

const OP3 = ['===', '!==', '>>>', '**=', '&&=', '||=', '??='];

const OP2 = [
  '==',
  '!=',
  '<=',
  '>=',
  '&&',
  '||',
  '??',
  '=>',
  '++',
  '--',
  '<<',
  '>>',
  '**',
  '+=',
  '-=',
  '*=',
  '/=',
  '%=',
  '&=',
  '|=',
  '^=',
];

const BASH_KEYWORDS = [
  'if',
  'then',
  'else',
  'elif',
  'fi',
  'for',
  'while',
  'until',
  'do',
  'done',
  'case',
  'esac',
  'function',
  'select',
  'in',
  'time',
  'coproc',
];

const BASH_BUILTINS = [
  'echo',
  'printf',
  'cd',
  'pwd',
  'exit',
  'export',
  'source',
  'alias',
  'unalias',
  'local',
  'declare',
  'typeset',
  'readonly',
  'unset',
  'shift',
  'read',
  'test',
  'true',
  'false',
  'exec',
  'eval',
  'set',
  'trap',
  'wait',
  'kill',
  'type',
  'command',
  'builtin',
  'return',
  'break',
  'continue',
  'pushd',
  'popd',
  'dirs',
  'getopts',
  'mapfile',
  'readarray',
  'let',
  'umask',
  'ulimit',
  'fg',
  'bg',
  'jobs',
  'hash',
  'help',
  'enable',
  'caller',
  'bind',
  'compgen',
  'complete',
];

const LOG_DATETIME_RE = new RegExp(
  '^(\\d{4}-\\d{2}-\\d{2}[T ]\\d{2}:\\d{2}:\\d{2}' +
    '(?:\\.\\d+)?(?:Z|[+-]\\d{2}:?\\d{2})?)',
);

const LOG_TAG_STYLE = Object.assign(Object.create(null), {
  error: 'logError',
  err: 'logError',
  warn: 'logWarn',
  warning: 'logWarn',
  info: 'logInfo',
  debug: 'logDebug',
  log: 'plain',
});

const JSON_LITERAL = Object.assign(Object.create(null), {
  true: 'literal',
  false: 'literal',
  null: 'literal',
});

const CSS_NEXT_STYLE = Object.assign(Object.create(null), {
  ':': 'property',
  '{': 'tag',
});

const EXPECT_STYLE = Object.assign(Object.create(null), {
  function: 'function',
  class: 'className',
  type: 'className',
});

const NEXT_EXPECT = {
  function: 'function',
  class: 'class',
  interface: 'class',
  enum: 'class',
  type: 'type',
};

const wordStyle = (words, style) => {
  const table = Object.create(null);
  for (const word of words) table[word] = style;
  return table;
};

const BASH_WORD_STYLE = Object.assign(
  Object.create(null),
  wordStyle(BASH_KEYWORDS, 'control'),
  wordStyle(BASH_BUILTINS, 'function'),
);

const typeOverlay = TYPES.filter((word) => STORAGE.includes(word));

const WORD_STYLE = Object.assign(
  Object.create(null),
  wordStyle(CONTROL, 'control'),
  wordStyle(LITERALS, 'literal'),
  wordStyle(BUILTINS, 'className'),
  wordStyle(STORAGE, 'storage'),
  wordStyle(typeOverlay, 'type'),
);

const TS_WORD_STYLE = Object.assign(
  Object.create(null),
  WORD_STYLE,
  wordStyle(TYPES, 'type'),
);

const peekIdent = (source, i) => {
  if (!/[A-Za-z_$]/.test(source[i] || '')) return null;
  let j = i + 1;
  while (j < source.length && /[A-Za-z0-9_$]/.test(source[j])) j += 1;
  return source.slice(i, j);
};

const skipWs = (source, i) => {
  while (i < source.length && /\s/.test(source[i])) i += 1;
  return i;
};

const readUntilNl = (source, i) => {
  let j = i;
  const n = source.length;
  while (j < n && source[j] !== '\n') j += 1;
  return { text: source.slice(i, j), end: j };
};

const readBlockComment = (source, i) => {
  let j = i + 2;
  const n = source.length;
  while (j < n && !(source[j] === '*' && source[j + 1] === '/')) {
    j += 1;
  }
  j = Math.min(j + 2, n);
  return { text: source.slice(i, j), end: j };
};

const skipQuoted = (source, j) => {
  const q = source[j];
  j += 1;
  const n = source.length;
  while (j < n && source[j] !== q) {
    if (source[j] === '\\') j += 1;
    j += 1;
  }
  j += 1;
  return j;
};

const readJsNumber = (source, i) => {
  const n = source.length;
  let j = i;
  if (source.startsWith('0x', i) || source.startsWith('0X', i)) {
    j += 2;
    while (j < n && /[0-9a-fA-F_]/.test(source[j])) j += 1;
  } else if (source.startsWith('0b', i) || source.startsWith('0B', i)) {
    j += 2;
    while (j < n && /[01_]/.test(source[j])) j += 1;
  } else if (source.startsWith('0o', i) || source.startsWith('0O', i)) {
    j += 2;
    while (j < n && /[0-7_]/.test(source[j])) j += 1;
  } else {
    while (j < n && /[0-9_n.]/.test(source[j])) j += 1;
    if ('eE'.includes(source[j])) {
      j += 1;
      if ('+-'.includes(source[j])) j += 1;
      while (j < n && /[0-9_]/.test(source[j])) j += 1;
    }
  }
  return { text: source.slice(i, j), end: j };
};

const readJsOperator = (source, i) => {
  const two = source.slice(i, i + 2);
  const three = source.slice(i, i + 3);
  let j = i + 1;
  if (OP3.includes(three)) j = i + 3;
  else if (OP2.includes(two)) j = i + 2;
  return { text: source.slice(i, j), end: j };
};

const plainTail = (out) => tokensText(out).slice(-8);

const styleExpected = ({ expectName }) => EXPECT_STYLE[expectName];

const styleKeyword = ({ word, ts }) => {
  const table = ts ? TS_WORD_STYLE : WORD_STYLE;
  if (!Object.hasOwn(table, word)) return null;
  return table[word];
};

const styleConstant = ({ word }) =>
  /^[A-Z][A-Z0-9_]+$/.test(word) ? 'constant' : null;

const stylePascal = ({ word }) => (/^[A-Z]/.test(word) ? 'className' : null);

const styleCall = ({ after }) => (after === '(' ? 'function' : null);

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

const styleVariable = () => 'variable';

const IDENT_RULES = [
  styleExpected,
  styleKeyword,
  styleConstant,
  stylePascal,
  styleCall,
  styleAssign,
  styleProperty,
  styleVariable,
];

const identStyle = (ctx) => {
  for (const rule of IDENT_RULES) {
    const style = rule(ctx);
    if (style) return style;
  }
  return 'plain';
};

const readString = (source, i) => {
  const q = source[i];
  let j = i + 1;
  const n = source.length;
  while (j < n) {
    if (source[j] === '\\') {
      j += 2;
      continue;
    }
    if (source[j] === q) {
      j += 1;
      break;
    }
    if (source[j] === '\n') break;
    j += 1;
  }
  return { text: source.slice(i, j), end: j };
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

const readTemplateInterp = (source, j) => {
  let depth = 1;
  const start = j;
  const n = source.length;
  while (j < n && depth > 0) {
    if (ANY_QUOTE.includes(source[j])) {
      j = skipQuoted(source, j);
      continue;
    }
    if (source[j] === '{') depth += 1;
    if (source[j] === '}') {
      depth -= 1;
      if (depth === 0) break;
    }
    j += 1;
  }
  return { expr: source.slice(start, j), end: j };
};

const isRegexContext = (out) => {
  const prev = tokensText(out).trimEnd();
  if (!prev) return true;
  const afterOperator = /[=(:,[?!&|{};]$/.test(prev);
  const afterKeyword = /(?:return|case|throw|=>|typeof|void)$/.test(prev);
  return afterOperator || afterKeyword;
};

class JsHighlighter {
  highlightJsFamily(source, ts = false) {
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

      if (ch === '`') {
        const r = this.highlightTemplate(source, i);
        for (const t of r.tokens) out.push(t);
        i = r.end;
        continue;
      }

      if (QUOTES.includes(ch)) {
        const { text, end } = readString(source, i);
        emit(out, 'string', text);
        i = end;
        continue;
      }

      if (ch === '/' && isRegexContext(out)) {
        const { text, end } = readRegex(source, i);
        emit(out, 'regex', text);
        i = end;
        continue;
      }

      if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(next || ''))) {
        const { text, end } = readJsNumber(source, i);
        emit(out, 'number', text);
        i = end;
        continue;
      }

      if (ch === '@') {
        let j = i + 1;
        while (j < n && /[A-Za-z0-9_$]/.test(source[j])) j += 1;
        emit(out, 'decorator', source.slice(i, j));
        i = j;
        expectName = null;
        continue;
      }

      if (/[A-Za-z_$]/.test(ch)) {
        const word = peekIdent(source, i);
        const end = i + word.length;
        const k = skipWs(source, end);
        const after = source[k];
        const ctx = { word, ts, after, source, k, out, expectName };
        emit(out, identStyle(ctx), word);
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
  }

  highlightTemplate(source, i) {
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
        const inner = this.highlightJsFamily(interp.expr, false);
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
  }
}

const jsHighlighter = new JsHighlighter();

const highlightJsFamily = (source, ts = false) =>
  jsHighlighter.highlightJsFamily(source, ts);

const highlightJson = (source) => {
  const out = [];
  let i = 0;
  const n = source.length;
  while (i < n) {
    const ch = source[i];
    if (ch === '"') {
      const { text, end } = readString(source, i);
      let k = end;
      while (k < n && /\s/.test(source[k])) k += 1;
      const kind = source[k] === ':' ? 'property' : 'string';
      emit(out, kind, text);
      i = end;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < n && /[0-9.eE+-]/.test(source[j])) j += 1;
      emit(out, 'number', source.slice(i, j));
      i = j;
      continue;
    }
    if (/[a-z]/.test(ch)) {
      let j = i;
      while (j < n && /[a-z]/.test(source[j])) j += 1;
      const word = source.slice(i, j);
      emit(out, JSON_LITERAL[word] ?? 'plain', word);
      i = j;
      continue;
    }
    if (/[{}[\],:]/.test(ch)) {
      emit(out, 'punct', ch);
      i += 1;
      continue;
    }
    emit(out, 'plain', ch);
    i += 1;
  }
  return out;
};

const cssWordStyle = (next) => CSS_NEXT_STYLE[next] ?? 'plain';

const highlightCss = (source) => {
  const out = [];
  let i = 0;
  const n = source.length;
  while (i < n) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === '/' && next === '*') {
      const { text, end } = readBlockComment(source, i);
      emit(out, 'comment', text);
      i = end;
      continue;
    }
    if (QUOTES.includes(ch)) {
      const { text, end } = readString(source, i);
      emit(out, 'string', text);
      i = end;
      continue;
    }
    if (ch === '@') {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9-]/.test(source[j])) j += 1;
      emit(out, 'keyword', source.slice(i, j));
      i = j;
      continue;
    }
    if ('#.'.includes(ch)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_-]/.test(source[j])) j += 1;
      const kind = ch === '#' ? 'constant' : 'className';
      emit(out, kind, source.slice(i, j));
      i = j;
      continue;
    }
    if (/[0-9]/.test(ch)) {
      let j = i;
      while (j < n && /[0-9.%]/.test(source[j])) j += 1;
      emit(out, 'number', source.slice(i, j));
      i = j;
      continue;
    }
    if (/[A-Za-z_-]/.test(ch)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_-]/.test(source[j])) j += 1;
      const word = source.slice(i, j);
      let k = j;
      while (k < n && /\s/.test(source[k])) k += 1;
      emit(out, cssWordStyle(source[k]), word);
      i = j;
      continue;
    }
    if (/[{};:,]/.test(ch)) {
      emit(out, 'punct', ch);
      i += 1;
      continue;
    }
    emit(out, 'plain', ch);
    i += 1;
  }
  return out;
};

const colorHtmlTag = (tag) => {
  const out = [];
  let i = 1;
  const n = tag.length;
  emit(out, 'punct', '<');
  if (tag[i] === '/') {
    emit(out, 'punct', '/');
    i += 1;
  }
  let j = i;
  while (j < n && /[A-Za-z0-9:-]/.test(tag[j])) j += 1;
  emit(out, 'tag', tag.slice(i, j));
  i = j;
  while (i < n) {
    if (tag[i] === '>' || (tag[i] === '/' && tag[i + 1] === '>')) {
      emit(out, 'punct', tag.slice(i));
      break;
    }
    if (/\s/.test(tag[i])) {
      emit(out, 'plain', tag[i]);
      i += 1;
      continue;
    }
    if (tag[i] === '"' || tag[i] === SQUOTE) {
      const q = tag[i];
      let k = i + 1;
      while (k < n && tag[k] !== q) k += 1;
      k = Math.min(k + 1, n);
      emit(out, 'string', tag.slice(i, k));
      i = k;
      continue;
    }
    if (/[A-Za-z_:]/.test(tag[i])) {
      let k = i + 1;
      while (k < n && /[A-Za-z0-9_:.-]/.test(tag[k])) k += 1;
      emit(out, 'attr', tag.slice(i, k));
      i = k;
      continue;
    }
    emit(out, 'punct', tag[i]);
    i += 1;
  }
  return out;
};

const highlightHtml = (source) => {
  const out = [];
  let i = 0;
  const n = source.length;
  while (i < n) {
    if (source.startsWith('<!--', i)) {
      let j = source.indexOf('-->', i + 4);
      j = j === -1 ? n : j + 3;
      emit(out, 'comment', source.slice(i, j));
      i = j;
      continue;
    }
    if (source[i] === '<') {
      let j = i + 1;
      while (j < n && source[j] !== '>') {
        if (source[j] === '"' || source[j] === SQUOTE) {
          j = skipQuoted(source, j);
          continue;
        }
        j += 1;
      }
      if (j < n) j += 1;
      for (const t of colorHtmlTag(source.slice(i, j))) out.push(t);
      i = j;
      continue;
    }
    let j = i + 1;
    while (j < n && source[j] !== '<' && !source.startsWith('<!--', j)) {
      j += 1;
    }
    emit(out, 'plain', source.slice(i, j));
    i = j;
  }
  return out;
};

const splitCsv = (line) => {
  const cells = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (inQ && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else {
        inQ = !inQ;
        cur += ch;
      }
      continue;
    }
    if (ch === ',' && !inQ) {
      cells.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  cells.push(cur);
  return cells;
};

const highlightCsvCell = (cell, row, col) => {
  if (row === 0) return { text: cell, style: 'function' };
  const num = /^-?\d+(\.\d+)?$/.test(cell.trim());
  if (num) return { text: cell, style: 'number' };
  if (col % 2 === 0) return { text: cell, style: 'string' };
  return { text: cell, style: 'variable' };
};

const highlightCsvLine = (line, row) => {
  if (!line) return [];
  const cells = splitCsv(line);
  const out = [];
  for (let col = 0; col < cells.length; col += 1) {
    if (col) emit(out, 'punct', ',');
    const cell = highlightCsvCell(cells[col], row, col);
    emit(out, cell.style, cell.text);
  }
  return out;
};

const highlightCsv = (source) => {
  const lines = source.split(/\r?\n/);
  const out = [];
  for (let row = 0; row < lines.length; row += 1) {
    if (row) emit(out, 'plain', '\n');
    for (const t of highlightCsvLine(lines[row], row === 0 ? 1 : row)) {
      out.push(t);
    }
  }
  return out;
};

const readBashVar = (source, i) => {
  if (source[i + 1] === '{') {
    let j = i + 2;
    while (j < source.length && source[j] !== '}') j += 1;
    if (j < source.length) j += 1;
    return { text: source.slice(i, j), end: j };
  }
  if (/[0-9#?$!*@-]/.test(source[i + 1] || '')) {
    return { text: source.slice(i, i + 2), end: i + 2 };
  }
  let j = i + 1;
  while (j < source.length && /[A-Za-z0-9_]/.test(source[j])) j += 1;
  if (j === i + 1) return { text: '$', end: i + 1 };
  return { text: source.slice(i, j), end: j };
};

const takeQuoted = (source, i) => {
  const q = source[i];
  let j = i + 1;
  const n = source.length;
  while (j < n && source[j] !== q) j += 1;
  if (j < n) j += 1;
  return { text: source.slice(i, j), end: j };
};

const takeBashDouble = (source, i, out) => {
  let j = i + 1;
  let chunk = '"';
  const n = source.length;
  while (j < n && source[j] !== '"') {
    if (source[j] === '\\' && j + 1 < n) {
      chunk += source.slice(j, j + 2);
      j += 2;
      continue;
    }
    if (source[j] === '$') {
      emit(out, 'string', chunk);
      chunk = '';
      const { text, end } = readBashVar(source, j);
      emit(out, 'variable', text);
      j = end;
      continue;
    }
    chunk += source[j];
    j += 1;
  }
  if (j < n) {
    chunk += '"';
    j += 1;
  }
  if (chunk) emit(out, 'string', chunk);
  return j;
};

const bashWordStyle = (word, nextCh) => {
  const known = BASH_WORD_STYLE[word];
  if (known) return known;
  if (nextCh === '=') return 'variable';
  return 'plain';
};

const bashOpLen = (ch, next) => ('|&><'.includes(ch) && next === ch ? 2 : 1);

const highlightBash = (source) => {
  const out = [];
  let i = 0;
  const n = source.length;
  while (i < n) {
    const ch = source[i];
    const next = source[i + 1];

    if (ch === '#' && (i === 0 || /\s/.test(source[i - 1]))) {
      const { text, end } = readUntilNl(source, i);
      emit(out, 'comment', text);
      i = end;
      continue;
    }

    if (BASH_QUOTE.includes(ch)) {
      const { text, end } = takeQuoted(source, i);
      emit(out, 'string', text);
      i = end;
      continue;
    }

    if (ch === '"') {
      i = takeBashDouble(source, i, out);
      continue;
    }

    if (ch === '$') {
      const { text, end } = readBashVar(source, i);
      emit(out, 'variable', text);
      i = end;
      continue;
    }

    if (ch === '-' && /[A-Za-z0-9]/.test(next || '')) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_-]/.test(source[j])) j += 1;
      emit(out, 'attr', source.slice(i, j));
      i = j;
      continue;
    }

    if (/[A-Za-z_]/.test(ch)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_]/.test(source[j])) j += 1;
      const word = source.slice(i, j);
      emit(out, bashWordStyle(word, source[j]), word);
      i = j;
      continue;
    }

    if (/[0-9]/.test(ch)) {
      let j = i + 1;
      while (j < n && /[0-9]/.test(source[j])) j += 1;
      emit(out, 'number', source.slice(i, j));
      i = j;
      continue;
    }

    if ('|&;<>(){}'.includes(ch)) {
      const j = i + bashOpLen(ch, next);
      emit(out, 'operator', source.slice(i, j));
      i = j;
      continue;
    }

    emit(out, 'plain', ch);
    i += 1;
  }
  return out;
};

const highlightLogLine = (line) => {
  if (!line) return [];
  const out = [];
  let rest = line;
  const dm = rest.match(LOG_DATETIME_RE);
  if (dm) {
    emit(out, 'logDate', dm[1]);
    rest = rest.slice(dm[1].length);
  }
  const tag = rest.match(/^(\s*)(\[[^\]]+\])/);
  if (tag) {
    emit(out, 'plain', tag[1]);
    const name = tag[2].replace(/^\[|\]$/g, '').toLowerCase();
    emit(out, LOG_TAG_STYLE[name] || 'plain', tag[2]);
    rest = rest.slice(tag[0].length);
  }
  if (rest.includes('\t')) {
    const parts = rest.split('\t');
    for (let i = 0; i < parts.length; i += 1) {
      if (i) emit(out, 'plain', '\t');
      emit(out, `logCol${i}`, parts[i]);
    }
    return out;
  }
  if (rest) emit(out, 'logCol0', rest);
  return out;
};

const highlightLog = (source) => {
  const lines = source.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (i) emit(out, 'plain', '\n');
    for (const t of highlightLogLine(lines[i])) out.push(t);
  }
  return out;
};

const highlightDotLine = (line) => {
  if (!line) return [];
  const out = [];
  const t = line.trimStart();
  if (t.startsWith('#') || t.startsWith(';')) {
    emit(out, 'comment', line);
    return out;
  }
  if (t.startsWith('!')) {
    const lead = line.slice(0, line.length - t.length);
    emit(out, 'plain', lead);
    emit(out, 'operator', '!');
    emit(out, 'plain', t.slice(1));
    return out;
  }
  const eq = line.match(/^(\s*)([A-Za-z_][A-Za-z0-9_.-]*)(\s*=\s*)(.*)$/);
  if (eq) {
    emit(out, 'plain', eq[1]);
    emit(out, 'variable', eq[2]);
    emit(out, 'operator', eq[3]);
    emit(out, 'string', eq[4]);
    return out;
  }
  emit(out, 'plain', line);
  return out;
};

const highlightDot = (source) => {
  const lines = source.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (i) emit(out, 'plain', '\n');
    for (const t of highlightDotLine(lines[i])) out.push(t);
  }
  return out;
};

const highlightTxtLine = (line) => {
  if (!line) return [];
  const out = [];
  const re = /(https?:\/\/[^\s<>"']+|www\.[^\s<>"']+)/g;
  let last = 0;
  let m = re.exec(line);
  while (m !== null) {
    if (m.index > last) emit(out, 'plain', line.slice(last, m.index));
    emit(out, 'string', m[0]);
    last = m.index + m[0].length;
    m = re.exec(line);
  }
  if (last < line.length) emit(out, 'plain', line.slice(last));
  if (!out.length) emit(out, 'plain', line);
  return out;
};

const highlightTxt = (source) => {
  const lines = source.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (i) emit(out, 'plain', '\n');
    for (const t of highlightTxtLine(lines[i])) out.push(t);
  }
  return out;
};

const highlightJs = (source) => highlightJsFamily(source, false);
const highlightTs = (source) => highlightJsFamily(source, true);

const HIGHLIGHTERS = {
  js: highlightJs,
  mjs: highlightJs,
  ts: highlightTs,
  json: highlightJson,
  css: highlightCss,
  html: highlightHtml,
  csv: highlightCsv,
  bash: highlightBash,
  sh: highlightBash,
  shell: highlightBash,
  zsh: highlightBash,
  log: highlightLog,
  dot: highlightDot,
  txt: highlightTxt,
  py: highlightTxt,
  md: highlightTxt,
};

const tokenize = (lang, source) => {
  const text = source ?? '';
  const key = lang === 'dts' ? 'ts' : mapLang(lang);
  const fn = HIGHLIGHTERS[key] || highlightTxt;
  return fn(text);
};

const overlayTokens = (tokens, spans) => {
  const syn = tokens && tokens.length ? tokens : [{ text: '', style: 'plain' }];
  const diff =
    spans && spans.length ? spans : [{ text: tokensText(syn), changed: false }];
  const pieces = [];
  let tokenIndex = 0;
  let spanIndex = 0;
  let tokenOff = 0;
  let spanOff = 0;
  while (tokenIndex < syn.length && spanIndex < diff.length) {
    const token = syn[tokenIndex];
    const span = diff[spanIndex];
    const tokenText = token.text ?? '';
    const spanText = span.text ?? '';
    const tokenLeft = tokenText.length - tokenOff;
    const spanLeft = spanText.length - spanOff;
    const n = Math.min(tokenLeft, spanLeft);
    if (n > 0) {
      const name = typeof token.style === 'string' ? token.style : 'plain';
      pieces.push({
        text: tokenText.slice(tokenOff, tokenOff + n),
        style: name || 'plain',
        changed: span.changed === true,
      });
    }
    tokenOff += n;
    spanOff += n;
    if (tokenOff >= tokenText.length) {
      tokenIndex += 1;
      tokenOff = 0;
    }
    if (spanOff >= spanText.length) {
      spanIndex += 1;
      spanOff = 0;
    }
  }
  while (spanIndex < diff.length) {
    const span = diff[spanIndex];
    const text = (span.text ?? '').slice(spanOff);
    if (text) {
      pieces.push({ text, style: 'plain', changed: span.changed === true });
    }
    spanIndex += 1;
    spanOff = 0;
  }
  return pieces;
};

module.exports = {
  tokenize,
  overlayTokens,
  tokensText,
  HIGHLIGHTERS,
};
