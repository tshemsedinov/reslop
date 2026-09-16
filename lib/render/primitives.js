'use strict';

const ansi = require('../ansi.js');

const { THEME, paint, visibleWidth, truncateVisible, seq, EL, RESET } = ansi;

const GUTTER_W = 2;
const FILE_MARK = '▶';
const FILE_LIST_PAD = 1;
const CHECK_DONE = 'xX';
const LIST_PANES = ['files', 'branches'];
const CHECK_TOKEN = /\[([ xX])\]/;
const CHECK_LEAD = /^\[[ xX]\] /;

const fill = (width, fgRgb, bgRgb, color) =>
  paint(' '.repeat(Math.max(0, width)), fgRgb, bgRgb, color);

const paintBar = (text, width, fgRgb, bgRgb, color) => {
  const clipped = truncateVisible(text, width);
  const pad = Math.max(0, width - visibleWidth(clipped));
  const filled = clipped + ' '.repeat(pad);
  if (!color) return filled;
  return `${seq(fgRgb, bgRgb)}${EL}${filled}${RESET}`;
};

const splitCheck = (text) => {
  const match = CHECK_TOKEN.exec(text);
  if (!match) return null;
  const start = match.index;
  const token = match[0];
  const before = text.slice(0, start);
  const mark = match[1];
  const after = text.slice(start + token.length);
  return { before, mark, token, after };
};

const paintCheckBar = (text, width, fgRgb, bgRgb, color) => {
  const clipped = truncateVisible(text, width);
  const parts = color ? splitCheck(clipped) : null;
  if (!parts) return paintBar(text, width, fgRgb, bgRgb, color);
  const pad = Math.max(0, width - visibleWidth(clipped));
  const done = CHECK_DONE.includes(parts.mark);
  const chipFg = done ? THEME.checkDoneFg : THEME.checkFg;
  const chipBg = done ? THEME.checkDoneBg : THEME.checkBg;
  const after = `${parts.after}${' '.repeat(pad)}`;
  let out = `${seq(fgRgb, bgRgb)}${EL}`;
  if (parts.before) out += paint(parts.before, fgRgb, bgRgb, color);
  out += paint(parts.token, chipFg, chipBg, color);
  if (after) out += paint(after, fgRgb, bgRgb, color);
  return out;
};

const padVisible = (text, width, align) => {
  const n = Math.max(0, width - visibleWidth(text));
  const gap = ' '.repeat(n);
  if (align === 'end') return `${text}${gap}`;
  return `${gap}${text}`;
};

const splitWidths = (width) => {
  const inner = Math.max(0, width - 1);
  const leftW = Math.floor(inner / 2);
  return { leftW, rightW: inner - leftW };
};

const paintSplitRule = (color) =>
  fill(1, THEME.splitGutterFg, THEME.splitGutterBg, color);

const paintSplitBlank = (width, color) => {
  const { leftW, rightW } = splitWidths(width);
  return (
    fill(leftW, THEME.ctxFg, THEME.ctxBg, color) +
    paintSplitRule(color) +
    fill(rightW, THEME.ctxFg, THEME.ctxBg, color)
  );
};

const paintBodyFill = (width, color, kind) => {
  if (kind === 'files') {
    const inner = Math.max(1, width - 1);
    const main = fill(inner, THEME.ctxFg, THEME.ctxBg, color);
    const edge = fill(1, THEME.ctxFg, THEME.ctxBg, color);
    return main + edge;
  }
  if (kind === 'split') return paintSplitBlank(width, color);
  return fill(width, THEME.ctxFg, THEME.ctxBg, color);
};

const windowRows = (rows, focus, cap) => {
  if (rows.length <= cap) return { rows, offset: 0 };
  let start = focus - cap + 1;
  if (start < 0) start = 0;
  if (start + cap > rows.length) start = rows.length - cap;
  return { rows: rows.slice(start, start + cap), offset: start };
};

const paintCursorList = (
  items,
  cursor,
  width,
  color,
  bodyH,
  headerLines,
  paintRow,
  tail,
) => {
  const pad = bodyH >= FILE_LIST_PAD * 2 + 1 ? FILE_LIST_PAD : 0;
  const listH = bodyH - pad * 2;
  const extra = tail ? 1 : 0;
  const last = items.length + extra - 1;
  const focus = extra ? last : cursor;
  const start = focus >= listH ? focus - listH + 1 : 0;
  const blank = paintBodyFill(width, color, 'files');
  const body = [];
  const fileHits = [];
  let textCursor = null;
  if (pad) body.push(blank);
  for (let i = 0; i < listH; i++) {
    const idx = start + i;
    if (tail && idx === items.length) {
      body.push(tail.row);
      if (tail.cursor) {
        textCursor = { x: tail.cursor.x, row: body.length - 1 };
      }
      continue;
    }
    const entry = items[idx];
    if (!entry) break;
    const selected = extra ? false : idx === cursor;
    body.push(paintRow(entry, width, color, selected));
    const y = headerLines + pad + i + 1;
    fileHits.push({ y, cursor: idx });
  }
  if (pad) body.push(blank);
  return { body, fileHits, cursor: textCursor };
};

const branchLabel = (name) => {
  const branch = `${name ?? ''}`.trim();
  if (!branch) return '';
  return `[${branch}]`;
};

const splitBracketName = (label) => {
  const text = `${label ?? ''}`;
  const open = text.startsWith('[') ? '[' : '';
  const rest = open ? text.slice(1) : text;
  const close = rest.endsWith(']') ? ']' : '';
  const name = close ? rest.slice(0, -1) : rest;
  return { open, name, close };
};

const paintBracketName = (label, nameFg, wrapFg, bgRgb, color, nameBold) => {
  const { open, name, close } = splitBracketName(label);
  return (
    paint(open, wrapFg, bgRgb, color, true) +
    paint(name, nameFg, bgRgb, color, nameBold) +
    paint(close, wrapFg, bgRgb, color, true)
  );
};

const paneResult = (fields) => ({
  body: fields.body,
  fileHits: fields.fileHits,
  todoOwners: fields.todoOwners,
  cursor: fields.cursor ?? null,
  splitBody: fields.splitBody === true,
});

module.exports = {
  GUTTER_W,
  FILE_MARK,
  LIST_PANES,
  CHECK_LEAD,
  fill,
  paintBar,
  paintCheckBar,
  padVisible,
  splitWidths,
  paintSplitRule,
  paintBodyFill,
  windowRows,
  paintCursorList,
  branchLabel,
  paintBracketName,
  paneResult,
};
