'use strict';

const ansi = require('../ansi.js');
const { overlayRows } = require('../select.js');
const primitives = require('./primitives.js');
const chrome = require('./chrome.js');
const files = require('./files.js');
const branches = require('./branches.js');
const notes = require('./notes.js');
const diff = require('./diff.js');

const { RESET } = ansi;
const { LIST_PANES, paintBodyFill, paneResult } = primitives;
const { paintHeader, paintButtons, paintStatusLine } = chrome;
const { layoutButtons, statusBranchHit } = chrome;
const { hiddenActions, dimFooterActions, extraFooterActions } = chrome;
const { paintNotePanel, paintBodyTodo } = notes;
const { paintBodyFiles } = files;
const { paintBodyBranches } = branches;
const { paintBodyDiff } = diff;

const bodyKind = (view) => {
  const pane = view.pane ?? 'diff';
  if (pane === 'files' || pane === 'branches') return pane;
  if (!view.item) return 'empty';
  if (view.item.origin === 'todo') return 'todo';
  return 'diff';
};

const paintBodyEmpty = () =>
  paneResult({
    body: [],
    fileHits: [],
    todoOwners: [],
    cursor: null,
    splitBody: false,
  });

const BODY_PAINT = {
  files: paintBodyFiles,
  branches: paintBodyBranches,
  empty: paintBodyEmpty,
  todo: paintBodyTodo,
  diff: paintBodyDiff,
};

const paintFrameBody = (view, width, color, bodyH, headerLines) => {
  const paint = BODY_PAINT[bodyKind(view)];
  return paint(view, width, color, bodyH, headerLines);
};

const frameNotes = (view, width, height, color) => {
  const notesCap = Math.max(0, height - 4);
  const notesWanted = paintNotePanel(view, width, color, notesCap);
  const noteRows = notesWanted.rows.slice(0, notesCap);
  let noteCursor = notesWanted.cursor;
  if (noteCursor && noteCursor.row >= noteRows.length) noteCursor = null;
  const chrome = 3 + noteRows.length;
  const bodyH = Math.max(1, height - chrome);
  return { notesWanted, noteRows, noteCursor, bodyH };
};

const bodyFillKind = (listPane, splitBody) => {
  if (listPane) return 'files';
  if (splitBody) return 'split';
  return 'plain';
};

const mapBodyCursor = (cursor, shift, scroll, headerLines, shown) => {
  if (!cursor) return null;
  const row = cursor.row + shift;
  if (row < scroll || row >= scroll + shown) return null;
  return {
    x: cursor.x,
    y: headerLines + (row - scroll) + 1,
  };
};

const windowBody = (view, width, color, bodyH, headerLines, paintedBody) => {
  const sourceBody = paintedBody.body;
  const sourceOwners = paintedBody.todoOwners;
  const splitBody = paintedBody.splitBody === true;
  const pane = view.pane ?? 'diff';
  const listPane = LIST_PANES.includes(pane);
  const fillKind = bodyFillKind(listPane, splitBody);
  const filler = paintBodyFill(width, color, fillKind);
  const body = [];
  const todoOwners = [];
  let shift = 0;
  if (!listPane && sourceBody.length > 0) {
    body.push(filler);
    if (sourceOwners.length) todoOwners.push(null);
    shift = 1;
  }
  for (const row of sourceBody) body.push(row);
  for (const owner of sourceOwners) todoOwners.push(owner);
  const scrollRaw = view.scroll ?? 0;
  const scrollMax = Math.max(0, body.length - bodyH);
  const scroll = listPane ? 0 : Math.min(scrollRaw, scrollMax);
  const slice = [];
  const end = Math.min(body.length, scroll + bodyH);
  for (let i = scroll; i < end; i++) slice.push(body[i]);
  const todoHits = [];
  for (let i = 0; i < slice.length; i++) {
    const owner = todoOwners[scroll + i];
    if (owner === undefined || owner === null) continue;
    todoHits.push({ y: headerLines + i + 1, cursor: owner });
  }
  const cursor = mapBodyCursor(
    paintedBody.cursor,
    shift,
    scroll,
    headerLines,
    slice.length,
  );
  while (slice.length < bodyH) {
    slice.push(filler);
  }
  return {
    slice,
    scroll,
    scrollMax,
    listScroll: paintedBody.listScroll ?? 0,
    todoHits,
    fileHits: paintedBody.fileHits,
    cursor,
  };
};

const notePointerHits = (notesWanted, noteRows, noteCursor, bodyH) => {
  let cursor = null;
  if (noteCursor) {
    cursor = { x: noteCursor.x, y: 2 + bodyH + noteCursor.row };
  }
  const templateHits = [];
  for (const hit of notesWanted.templateHits ?? []) {
    if (hit.row >= noteRows.length) continue;
    templateHits.push({ y: 2 + bodyH + hit.row, cursor: hit.cursor });
  }
  return { cursor, templateHits };
};

const stackFrame = (view, width, color, rows, layout, windowed, notes) => {
  for (const row of windowed.slice) rows.push(row);
  for (const row of notes.noteRows) rows.push(row);
  const status = view.status ?? '';
  rows.push(paintStatusLine(view, status, width, color));
  rows.push(paintButtons(layout, width, color));
  return overlayRows(rows, view.selection);
};

const frameResult = (
  text,
  painted,
  layout,
  windowed,
  hits,
  bodyH,
  statusHits,
) => {
  const fileHits = windowed.fileHits;
  const todoHits = windowed.todoHits;
  const templateHits = hits.templateHits;
  const footerY = painted.length;
  const scroll = windowed.scroll;
  const scrollMax = windowed.scrollMax;
  const listScroll = windowed.listScroll;
  const cursor = hits.cursor ?? windowed.cursor;
  return {
    text,
    rows: painted,
    buttons: layout.hits,
    fileHits,
    todoHits,
    templateHits,
    statusHits,
    footerY,
    height: painted.length,
    scroll,
    scrollMax,
    listScroll,
    cursor,
    bodyH,
  };
};

const renderFrame = (view, options = {}) => {
  const width = Math.max(20, options.width ?? 80);
  const height = Math.max(6, options.height ?? 24);
  const color = options.color ?? true;
  const rows = [paintHeader(view, width, color)];
  const extra = extraFooterActions(view);
  const hidden = hiddenActions(view);
  const dimmed = dimFooterActions(view);
  const layout = layoutButtons(width, false, hidden, extra, dimmed);
  const notes = frameNotes(view, width, height, color);
  const headerLines = rows.length;
  const bodyH = notes.bodyH;
  const paintedBody = paintFrameBody(view, width, color, bodyH, headerLines);
  const windowed = windowBody(
    view,
    width,
    color,
    bodyH,
    headerLines,
    paintedBody,
  );
  const painted = stackFrame(view, width, color, rows, layout, windowed, notes);
  const text = painted.map((row) => (color ? row + RESET : row)).join('\n');
  const hits = notePointerHits(
    notes.notesWanted,
    notes.noteRows,
    notes.noteCursor,
    bodyH,
  );
  const statusY = painted.length - 1;
  const branchHit = statusBranchHit(view, width, statusY);
  const statusHits = branchHit ? [branchHit] : [];
  return frameResult(text, painted, layout, windowed, hits, bodyH, statusHits);
};

module.exports = { BODY_PAINT, renderFrame };
