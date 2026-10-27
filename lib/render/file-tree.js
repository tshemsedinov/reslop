'use strict';

const ansi = require('../term/ansi.js');
const { isTasksEntry } = require('../common/files.js');
const { baseName } = require('../common/folders.js');
const { num, size } = require('../common/format.js');
const primitives = require('./primitives.js');
const { mixRgb } = require('./log.js');
const { fileRowFg } = require('./files.js');

const { THEME, paint, visibleWidth, trimVisible, seq, EL } = ansi;
const { fill, MARK_PAD, LIST_EDGE, paintCursorList } = primitives;
const { paintBodyFill } = primitives;
const { measureColumns, padColumns, paintPathText } = primitives;
const { paneResult, placeHits } = primitives;
const { activeHit, spansFor } = require('../common/find.js');
const { isMultiselect } = require('../common/list-selection.js');

const TREE_SHARE = 0.3;
const TREE_INDENT = '  ';
const NAME_MIN = 8;
const COL_GAP = '  ';
const TREE_GAP = ' ';
const IDLE_PICK = 0.5;
const NOTE_LIFT = 0.25;

const FILE_COL_ALIGN = {
  add: 'start',
  del: 'start',
  n: 'start',
  m: 'end',
  size: 'start',
  lines: 'start',
};

const FOLDER_COL_ALIGN = {
  files: 'start',
  size: 'start',
  lines: 'start',
};

const filesSplit = (width) => {
  const leftW = Math.max(1, Math.floor(width * TREE_SHARE));
  return { leftW, rightW: Math.max(1, width - leftW) };
};

// The focused panel shows its selection lighter than the other one
const pickBg = (active, panelBg) => {
  if (active) return THEME.checkBg;
  return mixRgb(THEME.checkBg, panelBg, IDLE_PICK);
};

const statFields = (bytes, lines, known) => ({
  size: known ? size(bytes) : '',
  lines: known ? num(lines) : '',
});

const fileRowFields = (entry) => {
  const n = `${entry.staged ?? 0}`;
  const m = `${entry.remaining ?? 0}`;
  const known = entry.bytes !== undefined;
  const stats = statFields(entry.bytes, entry.lines, known);
  if (isTasksEntry(entry)) return { add: '', del: '', n, m, ...stats };
  const add = `+${entry.added ?? 0}`;
  const del = `-${entry.removed ?? 0}`;
  return { add, del, n, m, ...stats };
};

const fileRowBg = (look) => {
  if (look.selected) return pickBg(look.active, THEME.ctxBg);
  return THEME.ctxBg;
};

const statsText = (parts, cols) => {
  let text = '';
  if (cols.size) text += COL_GAP + parts.size;
  if (cols.lines) text += COL_GAP + parts.lines;
  return text;
};

const paintStats = (parts, cols, bgRgb, color) => {
  const muted = (text) => paint(text, THEME.mutedFg, bgRgb, color);
  let out = '';
  if (cols.size) out += muted(COL_GAP);
  if (cols.size) out += paint(parts.size, THEME.chromeFg, bgRgb, color);
  if (cols.lines) out += muted(COL_GAP + parts.lines);
  return out;
};

const paintFileMeta = (parts, cols, fgRgb, bgRgb, color) => {
  const gap = paint(COL_GAP, fgRgb, bgRgb, color);
  let out = gap + paint(parts.add, THEME.addLineFg, bgRgb, color);
  out += gap + paint(parts.del, THEME.delLineFg, bgRgb, color);
  out += gap + paint(parts.n, fgRgb, bgRgb, color);
  out += paint('/', fgRgb, bgRgb, color);
  out += paint(parts.m, fgRgb, bgRgb, color);
  return out + paintStats(parts, cols, bgRgb, color);
};

// The search matches the whole path, the row shows the name
const rowSpans = (entry, name, marks) => {
  if (!marks || !marks.query) return [];
  const full = entry.path ?? '';
  const own = baseName(full);
  const skip = full.length - own.length;
  const hit = marks.hit && marks.hit.path === full ? marks.hit : null;
  if (!hit || hit.start < skip) return spansFor(name, own, marks.query, null);
  const start = hit.start - skip;
  const local = { ...hit, path: own, start, end: hit.end - skip };
  return spansFor(name, own, marks.query, local);
};

const paintFileRow = (entry, width, color, cols, marks, look) => {
  const tasks = isTasksEntry(entry);
  const inner = Math.max(1, width - LIST_EDGE);
  const prefix = MARK_PAD;
  const parts = padColumns(fileRowFields(entry), cols, FILE_COL_ALIGN);
  const { add, del, n, m } = parts;
  const meta = `${COL_GAP}${add}${COL_GAP}${del}${COL_GAP}${n}/${m}`;
  const stats = statsText(parts, cols);
  const nameW = Math.max(1, inner - visibleWidth(prefix + meta + stats));
  const name = trimVisible(baseName(entry.path), nameW);
  const pad = ' '.repeat(Math.max(0, nameW - visibleWidth(name)));
  const left = `${prefix}${name}${pad}`;
  const fgRgb = fileRowFg(entry, look.selected);
  const bgRgb = fileRowBg(look);
  const edge = fill(LIST_EDGE, fgRgb, bgRgb, color);
  if (!color) return `${left}${meta}${stats}${edge}`;
  const spans = rowSpans(entry, name, marks);
  let out = `${seq(fgRgb, bgRgb)}${EL}`;
  out += paint(prefix, fgRgb, bgRgb, color, tasks);
  out += paintPathText(name, fgRgb, bgRgb, color, tasks, spans);
  out += paint(pad, fgRgb, bgRgb, color, tasks);
  if (tasks) out += paint(meta + stats, fgRgb, bgRgb, color, true);
  else out += paintFileMeta(parts, cols, fgRgb, bgRgb, color);
  return out + edge;
};

const paintFileList = (view, width, color, bodyH, headerLines) => {
  const entries = view.files ?? [];
  const cols = measureColumns(entries, fileRowFields, FILE_COL_ALIGN);
  const cursor = view.fileCursor ?? 0;
  const pane = { width, color, bodyH, headerLines, offset: view.listScroll };
  const hit = activeHit(view.allFiles ?? entries, view.find);
  const query = view.find && view.find.query ? view.find.query : '';
  const active = view.folderFocus !== true;
  const multiple = active && isMultiselect(view);
  const paintRow = (entry, selected, index) => {
    const marks = { query, hit };
    const group =
      multiple && !isTasksEntry(entry) && view.listSelection.includes(index);
    const marked = (selected && !multiple) || group;
    const look = { selected: marked, active };
    return paintFileRow(entry, width, color, cols, marks, look);
  };
  return paintCursorList(entries, cursor, pane, paintRow);
};

const folderFields = (row) => ({
  files: `${row.files}`,
  size: row.sized ? size(row.bytes).replaceAll(' ', '') : '',
  lines: row.sized ? num(row.lines) : '',
});

const folderMeta = (parts, keys) =>
  keys.map((key) => `${TREE_GAP}${parts[key]}`).join('');

// A narrow tree drops the columns from the right before the names get short
const folderKeys = (cols, room) => {
  const keys = Object.keys(FOLDER_COL_ALIGN).filter((key) => cols[key]);
  const widthOf = (list) =>
    list.reduce((sum, key) => sum + TREE_GAP.length + cols[key], 0);
  while (keys.length && room - widthOf(keys) < NAME_MIN) keys.pop();
  return keys;
};

const folderFg = (key, selected) => {
  if (key !== 'size') return THEME.mutedFg;
  return selected ? THEME.buttonHotFg : THEME.chromeFg;
};

// The root names the repository in a grey just off the row background
const rootNote = (row, repo) =>
  row.depth === 0 && repo ? ` ${repo} repository` : '';

const paintFolderRow = (row, width, color, cols, look) => {
  const inner = Math.max(1, width - LIST_EDGE);
  const prefix = MARK_PAD;
  const parts = padColumns(folderFields(row), cols, FOLDER_COL_ALIGN);
  const keys = folderKeys(cols, inner - visibleWidth(prefix));
  const meta = folderMeta(parts, keys);
  const nameW = Math.max(1, inner - visibleWidth(prefix + meta));
  const label = `${TREE_INDENT.repeat(row.depth)}${row.name}`;
  const name = trimVisible(label, nameW);
  const noteW = nameW - visibleWidth(name);
  const note = noteW > 0 ? trimVisible(rootNote(row, look.repo), noteW) : '';
  const pad = ' '.repeat(Math.max(0, noteW - visibleWidth(note)));
  const panelBg = THEME.buttonBg;
  const bgRgb = look.selected ? pickBg(look.active, panelBg) : panelBg;
  const edge = fill(LIST_EDGE, THEME.mutedFg, bgRgb, color);
  if (!color) return `${prefix}${name}${note}${pad}${meta}${edge}`;
  const nameFg = look.selected ? THEME.buttonHotFg : THEME.shaFg;
  let out = `${seq(THEME.mutedFg, bgRgb)}${EL}`;
  out += paint(prefix, THEME.chromeFg, bgRgb, color);
  out += paint(name, nameFg, bgRgb, color, look.selected && look.active);
  const noteFg = mixRgb(bgRgb, THEME.chromeFg, NOTE_LIFT);
  out += paint(note, noteFg, bgRgb, color);
  out += paint(pad, THEME.mutedFg, bgRgb, color);
  for (const key of keys) {
    out += paint(TREE_GAP, THEME.mutedFg, bgRgb, color);
    out += paint(parts[key], folderFg(key, look.selected), bgRgb, color);
  }
  return out + edge;
};

const folderFill = (width, color) =>
  fill(width, THEME.chromeFg, THEME.buttonBg, color);

const paintFolderList = (view, width, color, bodyH, headerLines) => {
  const rows = view.folders ?? [];
  const cols = measureColumns(rows, folderFields, FOLDER_COL_ALIGN);
  const cursor = Math.max(0, view.folderCursor ?? 0);
  const pane = {
    width,
    color,
    bodyH,
    headerLines,
    offset: view.folderScroll,
    blank: folderFill(width, color),
  };
  const active = view.folderFocus === true;
  const repo = view.repoName ?? '';
  const paintRow = (row, selected) =>
    paintFolderRow(row, width, color, cols, { selected, active, repo });
  return paintCursorList(rows, cursor, pane, paintRow);
};

const joinFiles = (left, right, split, color, bodyH) => {
  const { leftW, rightW } = split;
  const blankL = folderFill(leftW, color);
  const blankR = paintBodyFill(rightW, color, 'files');
  const count = Math.max(left.body.length, right.body.length, bodyH);
  const body = [];
  for (let i = 0; i < count; i++) {
    body.push(`${left.body[i] ?? blankL}${right.body[i] ?? blankR}`);
  }
  const folderHits = placeHits(left.fileHits, 0, leftW, 'tree');
  const fileHits = [
    ...folderHits.map((hit) => ({ ...hit, folder: true })),
    ...placeHits(right.fileHits, leftW, rightW),
  ];
  const joined = paneResult({ body, fileHits, listScroll: right.listScroll });
  joined.folderScroll = left.listScroll;
  return joined;
};

// The folder tree on the left, the files of its selected folder on the right
const paintBodyFileTree = (view, width, color, bodyH, headerLines) => {
  const split = filesSplit(width);
  const { leftW, rightW } = split;
  const left = paintFolderList(view, leftW, color, bodyH, headerLines);
  const right = paintFileList(view, rightW, color, bodyH, headerLines);
  return joinFiles(left, right, split, color, bodyH);
};

module.exports = { paintBodyFileTree };
