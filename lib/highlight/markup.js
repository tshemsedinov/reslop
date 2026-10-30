'use strict';

const core = require('./core.js');
const { QUOTES, emit, scanWhile, quotedEnd, blockCommentEnd } = core;
const { stringEnd, wordStyles } = core;

const CSS_NEXT_STYLE = { ':': 'property', '{': 'tag' };
const CSS_NAME = /[A-Za-z0-9_-]/;

const JSON_LITERAL = wordStyles({ literal: ['true', 'false', 'null'] });

// Highlighters that scan characters: HTML tags, CSS rules, and JSON

const colorHtmlTag = (tag) => {
  const out = [];
  let i = 1;
  const take = (style, end) => {
    emit(out, style, tag.slice(i, end));
    i = end;
  };
  emit(out, 'punct', '<');
  if (tag[i] === '/') take('punct', i + 1);
  take('tag', scanWhile(tag, i, /[A-Za-z0-9:-]/));
  while (i < tag.length) {
    const char = tag[i];
    if (char === '>' || (char === '/' && tag[i + 1] === '>')) {
      take('punct', tag.length);
    } else if (/\s/.test(char)) {
      take('plain', i + 1);
    } else if (QUOTES.includes(char)) {
      const close = tag.indexOf(char, i + 1);
      take('string', close < 0 ? tag.length : close + 1);
    } else if (/[A-Za-z_:]/.test(char)) {
      take('attr', scanWhile(tag, i + 1, /[A-Za-z0-9_:.-]/));
    } else {
      take('punct', i + 1);
    }
  }
  return out;
};

const tagEnd = (source, i) => {
  const length = source.length;
  let j = i + 1;
  while (j < length && source[j] !== '>') {
    j = QUOTES.includes(source[j]) ? quotedEnd(source, j) : j + 1;
  }
  return j < length ? j + 1 : j;
};

const paintSpan = (source, i, length, out) => {
  if (source.startsWith('<!--', i)) {
    const close = source.indexOf('-->', i + 4);
    const end = close < 0 ? length : close + 3;
    emit(out, 'comment', source.slice(i, end));
    return end;
  }
  if (source[i] === '<') {
    const end = tagEnd(source, i);
    for (const token of colorHtmlTag(source.slice(i, end))) out.push(token);
    return end;
  }
  const next = source.indexOf('<', i + 1);
  const end = next < 0 ? length : next;
  emit(out, 'plain', source.slice(i, end));
  return end;
};

const highlightHtml = (source) => {
  const out = [];
  const length = source.length;
  let i = 0;
  while (i < length) i = paintSpan(source, i, length, out);
  return out;
};

const highlightCss = (source) => {
  const out = [];
  let i = 0;
  const take = (style, end) => {
    emit(out, style, source.slice(i, end));
    i = end;
  };
  while (i < source.length) {
    const char = source[i];
    if (char === '/' && source[i + 1] === '*') {
      take('comment', blockCommentEnd(source, i));
    } else if (QUOTES.includes(char)) {
      take('string', stringEnd(source, i));
    } else if (char === '@') {
      take('keyword', scanWhile(source, i + 1, /[A-Za-z0-9-]/));
    } else if (char === '#' || char === '.') {
      const style = char === '#' ? 'constant' : 'className';
      take(style, scanWhile(source, i + 1, CSS_NAME));
    } else if (/[0-9]/.test(char)) {
      take('number', scanWhile(source, i, /[0-9.%]/));
    } else if (/[A-Za-z_-]/.test(char)) {
      const end = scanWhile(source, i + 1, CSS_NAME);
      const after = source[scanWhile(source, end, /\s/)];
      take(CSS_NEXT_STYLE[after] ?? 'plain', end);
    } else {
      take(/[{};:,]/.test(char) ? 'punct' : 'plain', i + 1);
    }
  }
  return out;
};

const highlightJson = (source) => {
  const out = [];
  let i = 0;
  const take = (style, end) => {
    emit(out, style, source.slice(i, end));
    i = end;
  };
  while (i < source.length) {
    const char = source[i];
    if (char === '"') {
      const end = stringEnd(source, i);
      const after = source[scanWhile(source, end, /\s/)];
      take(after === ':' ? 'property' : 'string', end);
    } else if (/[0-9-]/.test(char)) {
      take('number', scanWhile(source, i, /[0-9.eE+-]/));
    } else if (/[a-z]/.test(char)) {
      const end = scanWhile(source, i, /[a-z]/);
      take(JSON_LITERAL[source.slice(i, end)] ?? 'plain', end);
    } else {
      take(/[{}[\],:]/.test(char) ? 'punct' : 'plain', i + 1);
    }
  }
  return out;
};

module.exports = [
  { langs: ['html'], aliases: { htm: 'html' }, highlight: highlightHtml },
  { langs: ['css'], highlight: highlightCss },
  { langs: ['json'], highlight: highlightJson },
];
