'use strict';

const ansi = require('../ansi.js');
const files = require('../files.js');
const primitives = require('./primitives.js');

const { isTodosEntry } = files;
const { THEME, paint, visibleWidth, truncateVisible, seq, EL } = ansi;
const { fill, padVisible, FILE_MARK, paneResult, paintCursorList } = primitives;

const FILE_STATUS_FG = {
  unstaged: 'delLineFg',
  staged: 'addLineFg',
  untracked: 'mutedFg',
  partial: 'warnFg',
};

const FILE_COL_KEYS = ['add', 'del', 'status', 'n', 'm'];

const FILE_COL_ALIGN = {
  add: 'start',
  del: 'start',
  status: 'start',
  n: 'start',
  m: 'end',
};

const signedCount = (sign, n) => `${sign}${n ?? 0}`;

const fileRowFields = (entry) => {
  if (isTodosEntry(entry)) {
    const n = `${entry.staged ?? 0}`;
    const m = `${entry.remaining ?? 0}`;
    return { add: '', del: '', status: '', n, m };
  }
  const { added, removed, staged, remaining } = entry;
  const add = signedCount('+', added);
  const del = signedCount('-', removed);
  const status = entry.status ?? '';
  const n = `${staged ?? 0}`;
  const m = `${remaining ?? 0}`;
  return { add, del, status, n, m };
};

const fileColumns = (files) => {
  const widths = {};
  for (const key of FILE_COL_KEYS) widths[key] = 0;
  for (const entry of files) {
    const fields = fileRowFields(entry);
    for (const key of FILE_COL_KEYS) {
      const w = visibleWidth(fields[key]);
      if (w > widths[key]) widths[key] = w;
    }
  }
  return widths;
};

const fileRowFg = (status, selected) => {
  const statusFg = FILE_STATUS_FG[status];
  if (statusFg) return THEME[statusFg];
  if (selected) return THEME.chromeFg;
  return THEME.mutedFg;
};

const fileRowParts = (entry, cols) => {
  const fields = fileRowFields(entry);
  const parts = {};
  for (const key of FILE_COL_KEYS) {
    const width = cols?.[key] ?? visibleWidth(fields[key]);
    const align = FILE_COL_ALIGN[key];
    parts[key] = padVisible(fields[key], width, align);
  }
  return parts;
};

const joinFileSuffix = (parts) => {
  const { add, del, status, n, m } = parts;
  return `  ${add}  ${del}  ${status}  ${n}/${m}`;
};

const paintFileSuffix = (parts, fgRgb, bgRgb, color) => {
  const { add, del, status, n, m } = parts;
  const gap = paint('  ', fgRgb, bgRgb, color);
  const addText = paint(add, THEME.addLineFg, bgRgb, color);
  const delText = paint(del, THEME.delLineFg, bgRgb, color);
  const statusText = paint(status, fgRgb, bgRgb, color);
  const nText = paint(n, fgRgb, bgRgb, color);
  const slash = paint('/', fgRgb, bgRgb, color);
  const mText = paint(m, fgRgb, bgRgb, color);
  const counts = addText + gap + delText;
  const meta = statusText + gap + nText + slash + mText;
  return gap + counts + gap + meta;
};

const paintTodosRow = (entry, width, color, selected, cols) => {
  const inner = Math.max(1, width - 1);
  const mark = selected ? FILE_MARK : ' ';
  const prefix = ` ${mark} `;
  const parts = fileRowParts(entry, cols);
  const suffix = joinFileSuffix(parts);
  const pathW = Math.max(1, inner - visibleWidth(prefix + suffix));
  const clipped = truncateVisible(entry.path, pathW);
  const pad = Math.max(0, pathW - visibleWidth(clipped));
  const left = `${prefix}${clipped}${' '.repeat(pad)}`;
  const fgRgb = THEME.buttonHotFg;
  const bgRgb = selected ? THEME.buttonBg : THEME.ctxBg;
  const edge = fill(1, fgRgb, bgRgb, color);
  if (!color) return `${left}${suffix}${edge}`;
  let out = `${seq(fgRgb, bgRgb)}${EL}`;
  out += paint(left, fgRgb, bgRgb, color, true);
  out += paint(suffix, fgRgb, bgRgb, color, true);
  return out + edge;
};

const paintFileRow = (entry, width, color, selected, cols) => {
  if (isTodosEntry(entry)) {
    return paintTodosRow(entry, width, color, selected, cols);
  }
  const inner = Math.max(1, width - 1);
  const mark = selected ? FILE_MARK : ' ';
  const prefix = ` ${mark} `;
  const parts = fileRowParts(entry, cols);
  const suffix = joinFileSuffix(parts);
  const pathW = Math.max(1, inner - visibleWidth(prefix + suffix));
  const { path, status } = entry;
  const clipped = truncateVisible(path, pathW);
  const pad = Math.max(0, pathW - visibleWidth(clipped));
  const left = `${prefix}${clipped}${' '.repeat(pad)}`;
  const fgRgb = fileRowFg(status, selected);
  const bgRgb = selected ? THEME.buttonBg : THEME.ctxBg;
  const edge = fill(1, fgRgb, bgRgb, color);
  if (!color) return `${left}${suffix}${edge}`;
  let out = `${seq(fgRgb, bgRgb)}${EL}`;
  out += paint(left, fgRgb, bgRgb, color);
  out += paintFileSuffix(parts, fgRgb, bgRgb, color);
  return out + edge;
};

const paintBodyFiles = (view, width, color, bodyH, headerLines) => {
  const files = view.files ?? [];
  const cols = fileColumns(files);
  const cursor = view.fileCursor ?? 0;
  const paintRow = (entry, rowWidth, rowColor, selected) =>
    paintFileRow(entry, rowWidth, rowColor, selected, cols);
  const painted = paintCursorList(
    files,
    cursor,
    width,
    color,
    bodyH,
    headerLines,
    paintRow,
    null,
    view.listScroll,
  );
  return paneResult({
    body: painted.body,
    fileHits: painted.fileHits,
    todoOwners: [],
    cursor: painted.cursor,
    splitBody: false,
    listScroll: painted.offset,
  });
};

module.exports = { paintBodyFiles };
