'use strict';

const ansi = require('../term/ansi.js');
const primitives = require('./primitives.js');

const { THEME, paint, visibleWidth, seq, EL } = ansi;
const { MARK_W, markPrefix, editSpan, fieldWindow } = primitives;

// The row where a name is typed: of a new branch, worktree or package
const paintNameEdit = (compose, width, color, options = {}) => {
  const { tail = 0, clearLine = true } = options;
  const prefix = markPrefix(true);
  const rest = Math.max(1, width - MARK_W - tail);
  const text = `${compose.text ?? ''}`.replaceAll('\n', ' ');
  const win = fieldWindow(text, compose.cursor, compose.scrollCol, rest);
  const gap = ' '.repeat(Math.max(0, rest - visibleWidth(win.text)));
  const end = `${gap}${' '.repeat(tail)}`;
  const fgRgb = THEME.chromeFg;
  const bgRgb = THEME.buttonBg;
  let row = `${prefix}${win.text}${end}`;
  if (color) {
    row = clearLine ? `${seq(fgRgb, bgRgb)}${EL}` : '';
    row += paint(prefix, fgRgb, bgRgb, color);
    row += paint(win.text, THEME.buttonHotFg, bgRgb, color);
    row += paint(end, fgRgb, bgRgb, color);
  }
  const textX = MARK_W + 1;
  const edit = editSpan(1, textX, textX + rest, 0, text);
  const cursor = { x: textX + win.col, scroll: win.scroll };
  return { row, cursor, edits: [{ ...edit, scroll: win.scroll }] };
};

module.exports = { paintNameEdit };
