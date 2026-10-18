'use strict';

const { THEME, paint } = require('../term/ansi.js');
const { paintSegments } = require('./tiles.js');
const { paintNameEdit } = require('./name-edit.js');
const { npmContent } = require('./dashboard/blocks.js');
const primitives = require('./primitives.js');
const { MARK_W, markPrefix, paintCursorList, listPad } = primitives;

const TILE = { key: 'n', title: 'npm' };
const TAIL = 1;

const paintMarginRow = (line, width, color, selected) => {
  const bg = selected ? THEME.buttonBg : THEME.ctxBg;
  const fg = selected ? THEME.chromeFg : THEME.mutedFg;
  const inner = Math.max(1, width - MARK_W - TAIL);
  const body = paintSegments(line, inner, bg, color);
  const prefix = markPrefix(selected);
  const tail = ' '.repeat(TAIL);
  if (!color) return `${prefix}${body}${tail}`;
  return paint(prefix, fg, bg, color) + body + paint(tail, fg, bg, color);
};

const paintBodyPackages = (view, width, color, bodyH, headerLines) => {
  const ctx = { frame: view.progressFrame ?? 0 };
  const inner = Math.max(1, width - MARK_W - TAIL);
  const content = npmContent(view.packages, inner, null, ctx, TILE);
  const headed = Boolean(content.titleLine) && content.lines.length > 0;
  const rows = headed ? content.lines.slice(1) : content.lines;
  const reserved = headed ? 1 : 0;
  const last = Math.max(0, rows.length - 1);
  const cursor = Math.min(view.packagesCursor ?? 0, last);
  const pane = {
    width,
    color,
    bodyH: Math.max(1, bodyH - reserved),
    headerLines: headerLines + reserved,
    offset: view.listScroll,
  };
  const paintRow = (line, selected) =>
    paintMarginRow(line, width, color, selected);
  const editing = view.compose && view.compose.kind === 'package';
  let extra = null;
  if (editing) {
    const painted = paintNameEdit(view.compose, width, color, {
      tail: TAIL,
      clearLine: false,
    });
    const at = 'index';
    extra = { ...painted, at, index: cursor };
  }
  const painted = paintCursorList(rows, cursor, pane, paintRow, extra);
  if (!headed) return painted;
  const head = paintMarginRow(content.lines[0], width, color, false);
  const body = painted.body.slice();
  const pad = listPad(pane.bodyH);
  body.splice(pad, 0, head);
  const nudge = (point) => {
    if (!point || point.row < pad) return point;
    return { ...point, row: point.row + 1 };
  };
  return {
    ...painted,
    body,
    editHits: painted.editHits.map(nudge),
    cursor: nudge(painted.cursor),
  };
};

module.exports = { paintBodyPackages };
