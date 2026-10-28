'use strict';

const ansi = require('../term/ansi.js');
const { isTasksEntry } = require('../common/files.js');
const { shortAge } = require('../common/format.js');
const primitives = require('./primitives.js');

const { THEME, paint, visibleWidth, trimVisible, seq, EL } = ansi;
const { fill, MARK_PAD, LIST_EDGE, paintCursorList } = primitives;
const { measureColumns, padColumns, paintPathText } = primitives;
const { activeHit, spansFor } = require('../common/find.js');
const { isMultiselect } = require('../common/list-selection.js');
const { ICON_GAP, entryMark, paintIconLead } = require('./icons.js');

const FILE_STATUS_FG = {
  unstaged: THEME.delLineFg,
  staged: THEME.addLineFg,
  untracked: THEME.mutedFg,
  partial: THEME.warnFg,
};

const FILE_COL_ALIGN = {
  add: 'start',
  del: 'start',
  status: 'start',
  n: 'start',
  m: 'end',
  date: 'start',
};

const FILE_DATE_GAP = '   ';

const fileRowFields = (entry) => {
  const n = `${entry.staged ?? 0}`;
  const m = `${entry.remaining ?? 0}`;
  if (isTasksEntry(entry)) {
    return { add: '', del: '', status: '', n, m, date: '' };
  }
  const add = `+${entry.added ?? 0}`;
  const del = `-${entry.removed ?? 0}`;
  const status = entry.status ?? '';
  return { add, del, status, n, m, date: shortAge(entry.date) };
};

const fileRowFg = (entry, selected) => {
  if (isTasksEntry(entry)) return THEME.buttonHotFg;
  const statusFg = FILE_STATUS_FG[entry.status];
  if (statusFg) return statusFg;
  return selected ? THEME.chromeFg : THEME.mutedFg;
};

const fileRowBg = (selected) => (selected ? THEME.buttonBg : THEME.ctxBg);

const paintFileMeta = (parts, fgRgb, bgRgb, color) => {
  const gap = paint('  ', fgRgb, bgRgb, color);
  let out = gap + paint(parts.add, THEME.addLineFg, bgRgb, color);
  out += gap + paint(parts.del, THEME.delLineFg, bgRgb, color);
  out += gap + paint(parts.status, fgRgb, bgRgb, color);
  out += gap + paint(parts.n, fgRgb, bgRgb, color);
  out += paint('/', fgRgb, bgRgb, color);
  return out + paint(parts.m, fgRgb, bgRgb, color);
};

const rowSpans = (entry, path, marks) => {
  if (!marks || !marks.query) return [];
  const hit = marks.hit && marks.hit.index === marks.index ? marks.hit : null;
  return spansFor(path, entry.path ?? '', marks.query, hit);
};

const paintFileRow = (entry, width, color, selected, cols, marks) => {
  const tasks = isTasksEntry(entry);
  const inner = Math.max(1, width - LIST_EDGE);
  const mark = entryMark(entry);
  const icon = `${mark.text}${ICON_GAP}`;
  const prefix = MARK_PAD;
  const parts = padColumns(fileRowFields(entry), cols, FILE_COL_ALIGN);
  const { add, del, status, n, m } = parts;
  const meta = `  ${add}  ${del}  ${status}  ${n}/${m}`;
  const date = cols.date ? `${FILE_DATE_GAP}${parts.date}` : '';
  const lead = prefix + icon;
  const pathW = Math.max(1, inner - visibleWidth(lead + meta + date));
  const path = trimVisible(entry.path, pathW);
  const pad = ' '.repeat(Math.max(0, pathW - visibleWidth(path)));
  const left = `${lead}${path}${pad}`;
  const fgRgb = fileRowFg(entry, selected);
  const bgRgb = fileRowBg(selected);
  const edge = fill(LIST_EDGE, fgRgb, bgRgb, color);
  if (!color) return `${left}${meta}${date}${edge}`;
  const spans = rowSpans(entry, path, marks);
  let out = `${seq(fgRgb, bgRgb)}${EL}`;
  out += paint(prefix, fgRgb, bgRgb, color, tasks);
  out += paintIconLead(mark, fgRgb, bgRgb, color, tasks);
  out += paintPathText(path, fgRgb, bgRgb, color, tasks, spans);
  out += paint(pad, fgRgb, bgRgb, color, tasks);
  if (tasks) out += paint(meta, fgRgb, bgRgb, color, true);
  else out += paintFileMeta(parts, fgRgb, bgRgb, color);
  if (date) {
    out += paint(FILE_DATE_GAP, fgRgb, bgRgb, color);
    out += paint(parts.date, THEME.mutedFg, bgRgb, color);
  }
  return out + edge;
};

const paintBodyFiles = (view, width, color, bodyH, headerLines) => {
  const entries = view.files ?? [];
  const cols = measureColumns(entries, fileRowFields, FILE_COL_ALIGN);
  const cursor = view.fileCursor ?? 0;
  const pane = { width, color, bodyH, headerLines, offset: view.listScroll };
  pane.scroller = 'list';
  const hit = activeHit(entries, view.find);
  const query = view.find && view.find.query ? view.find.query : '';
  const paintRow = (entry, selected, index) => {
    const marks = { query, hit, index };
    const multiple = isMultiselect(view);
    const group =
      multiple && !isTasksEntry(entry) && view.listSelection.includes(index);
    const marked = (selected && !multiple) || group;
    return paintFileRow(entry, width, color, marked, cols, marks);
  };
  return paintCursorList(entries, cursor, pane, paintRow);
};

module.exports = { paintBodyFiles, fileRowFg };
