'use strict';

const ansi = require('./ansi.js');

const { ESC, RESET, THEME } = ansi;
const { fg: fgSeq, bg: bgSeq, seq } = ansi;
const { stripAnsi, graphemes, graphemeWidth } = ansi;

const CSI_FINAL = /[@-~]/;
const SGR_RESET = 0;
const SGR_FG = 38;
const SGR_BG = 48;
const SGR_DEFAULT_FG = 39;
const SGR_DEFAULT_BG = 49;
const SGR_TRUECOLOR = 2;

const isRange = (sel) => {
  if (!sel || !sel.start || !sel.end) return false;
  return sel.start.x !== sel.end.x || sel.start.y !== sel.end.y;
};

const ordered = (sel) => {
  const start = sel.start;
  const end = sel.end;
  if (start.y < end.y) return { first: start, last: end };
  if (start.y > end.y) return { first: end, last: start };
  if (start.x <= end.x) return { first: start, last: end };
  return { first: end, last: start };
};

const slicePlain = (plain, fromCol, toCol) => {
  const parts = graphemes(plain);
  let col = 0;
  let out = '';
  for (const ch of parts) {
    const w = graphemeWidth(ch, col);
    const next = col + w;
    if (next > fromCol && col < toCol) out += ch;
    col = next;
    if (col >= toCol) break;
  }
  return out;
};

const lineRange = (rowIndex, sel) => {
  const { first, last } = ordered(sel);
  const y = rowIndex + 1;
  if (y < first.y || y > last.y) return null;
  let from = 0;
  let to = Infinity;
  if (y === first.y) from = first.x - 1;
  if (y === last.y) to = last.x;
  if (to <= from) return null;
  return { from, to };
};

const extractText = (rows, sel) => {
  if (!isRange(sel) || !rows || !rows.length) return '';
  const { first, last } = ordered(sel);
  const lines = [];
  for (let row = first.y - 1; row <= last.y - 1; row++) {
    const range = lineRange(row, sel);
    if (!range) continue;
    const plain = stripAnsi(rows[row] ?? '');
    const chunk = slicePlain(plain, range.from, range.to);
    lines.push(chunk.replace(/\s+$/g, ''));
  }
  return lines.join('\n');
};

const consumeCsi = (line, i) => {
  let j = i + 2;
  while (j < line.length && !CSI_FINAL.test(line[j])) j += 1;
  if (j < line.length) j += 1;
  return j;
};

const parseParams = (body) => {
  if (!body) return [0];
  return body.split(';').map((part) => (part ? parseInt(part, 10) : 0));
};

const applyRgb = (state, field, params, i) => {
  const isTruecolor = params[i + 1] === SGR_TRUECOLOR;
  const hasRgb = isTruecolor && i + 4 < params.length;
  if (!hasRgb) return 1;
  state[field] = [params[i + 2], params[i + 3], params[i + 4]];
  return 5;
};

const SGR = {
  [SGR_RESET]: (state) => {
    state.fg = null;
    state.bg = null;
    return 1;
  },
  [SGR_FG]: (state, params, i) => applyRgb(state, 'fg', params, i),
  [SGR_BG]: (state, params, i) => applyRgb(state, 'bg', params, i),
  [SGR_DEFAULT_FG]: (state) => {
    state.fg = null;
    return 1;
  },
  [SGR_DEFAULT_BG]: (state) => {
    state.bg = null;
    return 1;
  },
};

const applySgr = (params, state) => {
  let i = 0;
  while (i < params.length) {
    const apply = SGR[params[i]];
    i += apply ? apply(state, params, i) : 1;
  }
};

const nextGrapheme = (line, index) => {
  const parts = graphemes(line.slice(index));
  return parts[0] ?? '';
};

const parseCells = (line) => {
  const cells = [];
  const state = { fg: null, bg: null };
  let col = 0;
  let i = 0;
  while (i < line.length) {
    if (line[i] === ESC && line[i + 1] === '[') {
      const n = consumeCsi(line, i);
      if (line[n - 1] === 'm') {
        const body = line.slice(i + 2, n - 1);
        applySgr(parseParams(body), state);
      }
      i = n;
      continue;
    }
    if (line[i] === ESC) {
      i += 1;
      continue;
    }
    const ch = nextGrapheme(line, i);
    if (!ch) break;
    const width = graphemeWidth(ch, col);
    const fg = state.fg;
    const bg = state.bg;
    cells.push({ ch, fg, bg, col, width });
    col += width;
    i += ch.length;
  }
  return cells;
};

const rgbKey = (rgb) => (rgb ? `${rgb[0]},${rgb[1]},${rgb[2]}` : '');

const styleKey = (fg, bg) => `${rgbKey(fg)}|${rgbKey(bg)}`;

const styleSeq = (fg, bg) => {
  if (fg && bg) return RESET + seq(fg, bg);
  if (fg) return RESET + fgSeq(fg);
  if (bg) return RESET + bgSeq(bg);
  return RESET;
};

const overlayRange = (line, fromCol, toCol) => {
  if (toCol <= fromCol) return line;
  const cells = parseCells(line);
  if (!cells.length) return line;
  let out = '';
  let last = null;
  for (const cell of cells) {
    const next = cell.col + cell.width;
    const hit = next > fromCol && cell.col < toCol;
    let fg = cell.fg;
    let bg = cell.bg;
    if (hit) {
      fg = cell.bg ?? THEME.ctxBg;
      bg = cell.fg ?? THEME.ctxFg;
    }
    const key = styleKey(fg, bg);
    if (key !== last) {
      out += styleSeq(fg, bg);
      last = key;
    }
    out += cell.ch;
  }
  return out;
};

const overlayRows = (rows, sel) => {
  if (!isRange(sel)) return rows;
  const next = [];
  for (let i = 0; i < rows.length; i++) {
    const range = lineRange(i, sel);
    if (!range) {
      next.push(rows[i]);
      continue;
    }
    next.push(overlayRange(rows[i], range.from, range.to));
  }
  return next;
};

module.exports = {
  isRange,
  extractText,
  overlayRange,
  overlayRows,
};
