'use strict';

const { emit, highlightLines, wordStyles } = require('./core.js');

// Highlighters that go line by line: plain text, logs, CSV, and dotfiles

const URL_RE = /https?:\/\/[^\s<>"']+|www\.[^\s<>"']+/g;

const LOG_DATETIME_RE = new RegExp(
  '^(\\d{4}-\\d{2}-\\d{2}[T ]\\d{2}:\\d{2}:\\d{2}' +
    '(?:\\.\\d+)?(?:Z|[+-]\\d{2}:?\\d{2})?)',
);

const LOG_TAG_RE = /^(\s*)(\[[^\]]+\])/;

const LOG_TAG_STYLE = wordStyles({
  logError: ['error', 'err'],
  logWarn: ['warn', 'warning'],
  logInfo: ['info'],
  logDebug: ['debug'],
});

const ASSIGN_RE = /^(\s*)([A-Za-z_][A-Za-z0-9_.-]*)(\s*=\s*)(.*)$/;

const highlightTxtLine = (line) => {
  const out = [];
  let last = 0;
  for (const match of line.matchAll(URL_RE)) {
    emit(out, 'plain', line.slice(last, match.index));
    emit(out, 'string', match[0]);
    last = match.index + match[0].length;
  }
  emit(out, 'plain', line.slice(last));
  return out;
};

const highlightLogLine = (line) => {
  const out = [];
  let rest = line;
  const date = LOG_DATETIME_RE.exec(rest);
  if (date) {
    emit(out, 'logDate', date[1]);
    rest = rest.slice(date[1].length);
  }
  const tag = LOG_TAG_RE.exec(rest);
  if (tag) {
    emit(out, 'plain', tag[1]);
    const name = tag[2].slice(1, -1).toLowerCase();
    emit(out, LOG_TAG_STYLE[name] || 'plain', tag[2]);
    rest = rest.slice(tag[0].length);
  }
  const columns = rest.split('\t');
  for (let i = 0; i < columns.length; i += 1) {
    if (i) emit(out, 'plain', '\t');
    emit(out, `logCol${i}`, columns[i]);
  }
  return out;
};

const splitCsv = (line) => {
  const cells = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"' && inQuotes && line[i + 1] === '"') {
      current += '"';
      i += 1;
    } else if (char === '"') {
      inQuotes = !inQuotes;
      current += char;
    } else if (char === ',' && !inQuotes) {
      cells.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  cells.push(current);
  return cells;
};

const cellStyle = (cell, col) => {
  if (/^-?\d+(\.\d+)?$/.test(cell.trim())) return 'number';
  return col % 2 === 0 ? 'string' : 'variable';
};

const highlightCsvLine = (line) => {
  const cells = splitCsv(line);
  const out = [];
  for (let col = 0; col < cells.length; col += 1) {
    if (col) emit(out, 'punct', ',');
    emit(out, cellStyle(cells[col], col), cells[col]);
  }
  return out;
};

const highlightDotLine = (line) => {
  const out = [];
  const trimmed = line.trimStart();
  if (trimmed.startsWith('#') || trimmed.startsWith(';')) {
    emit(out, 'comment', line);
    return out;
  }
  if (trimmed.startsWith('!')) {
    emit(out, 'plain', line.slice(0, line.length - trimmed.length));
    emit(out, 'operator', '!');
    emit(out, 'plain', trimmed.slice(1));
    return out;
  }
  const assign = ASSIGN_RE.exec(line);
  if (!assign) {
    emit(out, 'plain', line);
    return out;
  }
  emit(out, 'plain', assign[1]);
  emit(out, 'variable', assign[2]);
  emit(out, 'operator', assign[3]);
  emit(out, 'string', assign[4]);
  return out;
};

module.exports = [
  {
    langs: ['txt', 'py', 'md'],
    aliases: { text: 'txt', plain: 'txt', markdown: 'md', python: 'py' },
    highlight: highlightLines(highlightTxtLine),
  },
  {
    langs: ['log'],
    highlight: highlightLines(highlightLogLine),
  },
  {
    langs: ['csv'],
    highlight: highlightLines(highlightCsvLine, /\r?\n/),
  },
  {
    langs: ['dot'],
    aliases: {
      env: 'dot',
      ini: 'dot',
      conf: 'dot',
      cfg: 'dot',
      yaml: 'dot',
      yml: 'dot',
      toml: 'dot',
    },
    highlight: highlightLines(highlightDotLine),
  },
];
