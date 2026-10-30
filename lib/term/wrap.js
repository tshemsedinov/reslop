'use strict';

const { clamp } = require('../common/utilities.js');
const { graphemes, graphemeWidth, visibleWidth } = require('./ansi.js');

const wrapPlain = (text, width) => {
  if (width <= 0) return [''];
  if (visibleWidth(text) <= width) return [text];
  const parts = graphemes(text);
  const rows = [];
  let start = 0;
  let col = 0;
  let lastBreak = -1;
  let i = 0;
  while (i < parts.length) {
    const char = parts[i];
    const cellWidth = graphemeWidth(char, col);
    if (col + cellWidth > width && col > 0) {
      const end = lastBreak >= start ? lastBreak + 1 : i;
      rows.push(parts.slice(start, end).join(''));
      start = end;
      i = end;
      col = 0;
      lastBreak = -1;
      continue;
    }
    col += cellWidth;
    if (char === ' ' || char === '\t') lastBreak = i;
    i += 1;
  }
  rows.push(parts.slice(start).join(''));
  return rows;
};

const wrapDoc = (text, width) => {
  const rows = [];
  let offset = 0;
  for (const part of text.split('\n')) {
    let start = offset;
    for (const text of wrapPlain(part, width)) {
      rows.push({ start, text });
      start += text.length;
    }
    offset += part.length + 1;
  }
  return rows;
};

const wrapMultiline = (text, width) =>
  wrapDoc(text, width).map((row) => row.text);

const cursorInRows = (rows, text, cursor) => {
  const clamped = clamp(cursor, 0, text.length);
  let row = rows.length - 1;
  for (let i = 0; i < rows.length - 1; i++) {
    if (clamped < rows[i + 1].start) {
      row = i;
      break;
    }
  }
  const line = rows[row];
  const take = clamp(clamped - line.start, 0, line.text.length);
  return { row, col: visibleWidth(line.text.slice(0, take)) };
};

const cursorInWrap = (text, cursor, width) =>
  cursorInRows(wrapDoc(text, width), text, cursor);

const colIndex = (text, col) => {
  let used = 0;
  let index = 0;
  for (const char of graphemes(text)) {
    const width = graphemeWidth(char, used);
    if (used + width > col) break;
    used += width;
    index += char.length;
  }
  return index;
};

const indexAtRow = (start, text, col) => {
  if (col <= 0) return start;
  return start + colIndex(`${text ?? ''}`, col);
};

const indexAtWrapCol = (row, col, limit) => {
  const position = row.start + colIndex(row.text, col);
  if (position < limit) return position;
  if (position <= row.start) return row.start;
  const parts = graphemes(row.text);
  return position - parts[parts.length - 1].length;
};

const wrapMove = (text, cursor, width, delta, wantCol) => {
  const rows = wrapDoc(text, width);
  const position = cursorInRows(rows, text, cursor);
  const next = Math.min(Math.max(position.row + delta, 0), rows.length - 1);
  const col = wantCol ?? position.col;
  if (next === position.row) return { cursor, col };
  const limit = next + 1 < rows.length ? rows[next + 1].start : text.length + 1;
  return { cursor: indexAtWrapCol(rows[next], col, limit), col };
};

module.exports = {
  wrapPlain,
  wrapDoc,
  wrapMultiline,
  cursorInWrap,
  indexAtRow,
  wrapMove,
};
