'use strict';

const { listPath, isTasksEntry } = require('../common/files.js');
const diff = require('../diff/diff.js');
const { unitLines, itemsForPath, blockLineIndex } = diff;
const { hunkLineRange, sameHunk, hunkKey } = diff;
const { fileOffset, splitEditor, mergeEditRows, fileLineIndex } = diff;

const fileText = (ui, rel) => ui.reads.textOf(rel);

const pathItems = (ui, rel) => itemsForPath(ui.items ?? [], rel);

const linesFor = (ui, rel, overlay, base) => {
  const live = ui.composer.liveFileText();
  const shown = overlay === undefined ? live : overlay;
  const seed = base === undefined ? null : base;
  const text = shown === null ? fileText(ui, rel) : shown;
  const group = pathItems(ui, rel);
  if (shown !== null && seed && seed.length) {
    return mergeEditRows(seed, splitEditor(text));
  }
  return unitLines(text, group);
};

const BODY_SHIFT = 1;

const clampUnitLine = (nav, length) => {
  if (!length) {
    nav.unitLine = 0;
    return;
  }
  if (nav.unitLine < 0) nav.unitLine = 0;
  if (nav.unitLine >= length) nav.unitLine = length - 1;
};

const CONTEXT = 1;

const frameBodyH = (frame, ui) => {
  if (frame && frame.bodyH) return frame.bodyH;
  const size = ui?.lastSize ?? ui?.getSize?.();
  const height = size && size.height ? size.height : 24;
  return Math.max(1, height - 4);
};

const ensureRangeVisible = (nav, firstLine, lastLine, frame, ui) => {
  const bodyH = frameBodyH(frame, ui);
  const diffFirst = firstLine + BODY_SHIFT;
  const diffLast = lastLine + BODY_SHIFT;
  const diffSpan = diffLast - diffFirst + 1;
  let first = diffFirst;
  let last = diffLast;
  if (diffSpan <= bodyH) {
    const padFirst = Math.max(0, firstLine - CONTEXT) + BODY_SHIFT;
    const padLast = lastLine + CONTEXT + BODY_SHIFT;
    if (padLast - padFirst + 1 <= bodyH) {
      first = padFirst;
      last = padLast;
    }
  }
  const span = last - first + 1;
  let scroll = nav.scroll ?? 0;
  if (span > bodyH) {
    scroll = first;
  } else {
    if (first < scroll) scroll = first;
    const viewLast = scroll + bodyH - 1;
    if (last > viewLast) scroll = last - bodyH + 1;
  }
  nav.scroll = Math.max(0, scroll);
};

const ensureVisible = (nav, length, frame) => {
  clampUnitLine(nav, length);
  ensureRangeVisible(nav, nav.unitLine, nav.unitLine, frame);
};

const followFileCursor = (nav, editor, frame, rows) => {
  if (!editor) return;
  const fileLine = editor.linePos().line;
  if (rows && rows.length) {
    nav.unitLine = fileLineIndex(rows, fileLine);
    ensureVisible(nav, rows.length, frame);
    return;
  }
  const length = `${editor.text}`.split('\n').length;
  nav.unitLine = fileLine;
  ensureVisible(nav, length, frame);
};

const jumpToItem = (ui, item) => {
  const nav = ui.nav;
  const rel = nav.reviewPath;
  const lines = linesFor(ui, rel);
  const items = ui.items ?? [];
  const idx = items.indexOf(item);
  if (idx >= 0) nav.index = idx;
  const range = hunkLineRange(lines, item);
  nav.unitLine = range.start;
  ensureRangeVisible(nav, range.start, range.end, ui.lastFrame, ui);
};

const viewLine = (nav, length) => {
  if (!length) return 0;
  const top = Math.max(0, (nav.scroll ?? 0) - 1);
  return Math.min(top, length - 1);
};

const moveUnitBlock = (ui, step) => {
  const nav = ui.nav;
  const rel = nav.reviewPath;
  if (!rel) return;
  const items = ui.items ?? [];
  const indexes = [];
  const seen = new Set();
  for (let i = 0; i < items.length; i++) {
    if (listPath(items[i]) !== rel) continue;
    const key = hunkKey(items[i]);
    if (seen.has(key)) continue;
    seen.add(key);
    indexes.push(i);
  }
  if (!indexes.length) {
    ui.status = 'not a diff block';
    return;
  }
  let at = -1;
  const current = items[nav.index];
  for (let i = 0; i < indexes.length; i++) {
    if (!sameHunk(items[indexes[i]], current)) continue;
    at = i;
    break;
  }
  if (at < 0) at = step > 0 ? -1 : 0;
  const next = at + step;
  if (next < 0 || next >= indexes.length) return;
  const item = items[indexes[next]];
  jumpToItem(ui, item);
  ui.status = '';
  nav.clearSelection();
};

const showFile = async (ui, entry) => {
  await ui.reads.loadText(entry.path);
  const nav = ui.nav;
  nav.reviewPath = entry.path;
  nav.tasksOpen = false;
  nav.pane = 'unit';
  nav.scroll = 0;
  nav.unitLine = 0;
  nav.clearSelection();
  const items = ui.items ?? [];
  const group = pathItems(ui, entry.path);
  if (group.length) {
    const want = items[entry.openIndex] ?? items[entry.firstIndex] ?? group[0];
    const item = group.includes(want) ? want : group[0];
    jumpToItem(ui, item);
  } else {
    nav.unitLine = 0;
  }
  ui.status = '';
};

const openUnitFile = (ui, entry) => {
  if (!entry || isTasksEntry(entry)) return;
  ui.ops.hold(showFile(ui, entry));
};

const applyFileScope = (ui, next, quiet) => {
  ui.nav.fileScope = next;
  ui.nav.restoreFileCursor(ui.fileList());
  const label = next === 'file' ? 'file scope' : 'diff mode';
  ui.status = quiet ? '' : label;
};

const listScope = async (ui, quiet) => {
  await ui.reads.loadNames();
  applyFileScope(ui, 'file', quiet);
};

const setFileScope = (ui, next, quiet = false) => {
  if (ui.nav.pane !== 'files') return;
  if (ui.nav.fileScope === next) return;
  if (next === 'file') return void ui.ops.hold(listScope(ui, quiet));
  applyFileScope(ui, next, quiet);
};

const editCursor = (ui) => {
  const rel = ui.nav.reviewPath;
  const text = fileText(ui, rel);
  const group = pathItems(ui, rel);
  const lines = unitLines(text, group);
  const items = ui.items ?? [];
  const item = items[ui.nav.index];
  const atBlock = item && listPath(item) === rel;
  const at = atBlock
    ? blockLineIndex(lines, item)
    : viewLine(ui.nav, lines.length);
  const cursor = fileOffset(lines, at);
  const rows = lines;
  return { text, cursor, rows };
};

module.exports = {
  fileText,
  linesFor,
  moveUnitBlock,
  openUnitFile,
  showFile,
  setFileScope,
  editCursor,
  followFileCursor,
};
