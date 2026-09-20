'use strict';

const files = require('../files.js');
const { listPath, isTodosEntry } = files;
const diff = require('../diff.js');
const { unitLines, itemsForPath, blockLineIndex } = diff;
const { hunkLineRange, sameHunk, hunkKey } = diff;
const { fileOffset, splitEditor, mergeEditRows, fileLineIndex } = diff;

const fileText = (options, rel) => {
  if (!rel) return '';
  const repo = options.repo();
  if (repo && typeof repo.fileText === 'function') {
    return repo.fileText(options.top(), rel, options.rev());
  }
  return '';
};

const pathItems = (options, rel) => itemsForPath(options.items(), rel);

const linesFor = (options, rel) => {
  const overlay = options.liveFileText();
  const text = overlay === null ? fileText(options, rel) : overlay;
  const group = pathItems(options, rel);
  const base = options.editRows ? options.editRows() : null;
  if (overlay !== null && base && base.length) {
    return mergeEditRows(base, splitEditor(text));
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

const frameBodyH = (frame, options) => {
  if (frame && frame.bodyH) return frame.bodyH;
  const size = options && options.getSize ? options.getSize() : null;
  const height = size && size.height ? size.height : 24;
  return Math.max(1, height - 4);
};

const ensureRangeVisible = (nav, firstLine, lastLine, frame, options) => {
  const bodyH = frameBodyH(frame, options);
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

const jumpToItem = (options, item) => {
  const nav = options.nav;
  const rel = nav.reviewPath;
  const lines = linesFor(options, rel);
  const items = options.items();
  const idx = items.indexOf(item);
  if (idx >= 0) nav.index = idx;
  const range = hunkLineRange(lines, item);
  nav.unitLine = range.start;
  ensureRangeVisible(nav, range.start, range.end, options.lastFrame(), options);
};

const viewLine = (nav, length) => {
  if (!length) return 0;
  const top = Math.max(0, (nav.scroll ?? 0) - 1);
  return Math.min(top, length - 1);
};

const moveUnitBlock = (options, step) => {
  const nav = options.nav;
  const rel = nav.reviewPath;
  if (!rel) return;
  const items = options.items();
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
    options.setStatus('not a diff block');
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
  jumpToItem(options, item);
  options.setStatus('');
  nav.clearSelection();
};

const openUnitFile = (options, entry) => {
  if (!entry || isTodosEntry(entry)) return;
  const nav = options.nav;
  nav.reviewPath = entry.path;
  nav.todoOpen = false;
  nav.pane = 'unit';
  nav.scroll = 0;
  nav.unitLine = 0;
  nav.clearSelection();
  const items = options.items();
  const group = pathItems(options, entry.path);
  if (group.length) {
    const want = items[entry.openIndex] ?? items[entry.firstIndex] ?? group[0];
    const item = group.includes(want) ? want : group[0];
    jumpToItem(options, item);
  } else {
    nav.unitLine = 0;
  }
  options.setStatus('');
};

const setFileScope = (options, next) => {
  if (options.nav.pane !== 'files') return;
  if (options.nav.fileScope === next) return;
  options.nav.fileScope = next;
  options.nav.restoreFileCursor(options.fileList());
  options.setStatus(next === 'file' ? 'file scope' : 'diff mode');
};

const editCursor = (options) => {
  const rel = options.nav.reviewPath;
  const text = fileText(options, rel);
  const group = pathItems(options, rel);
  const lines = unitLines(text, group);
  const items = options.items();
  const item = items[options.nav.index];
  const atBlock = item && listPath(item) === rel;
  const at = atBlock
    ? blockLineIndex(lines, item)
    : viewLine(options.nav, lines.length);
  return {
    text,
    cursor: fileOffset(lines, at),
    rows: lines,
  };
};

module.exports = {
  fileText,
  linesFor,
  moveUnitBlock,
  openUnitFile,
  setFileScope,
  editCursor,
  ensureVisible,
  followFileCursor,
};
