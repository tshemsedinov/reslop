'use strict';

const ansi = require('../term/ansi.js');
const { THEME, paint, graphemes, graphemeWidth, visibleWidth, seq, EL } = ansi;
const { fileMatches } = require('../common/find.js');
const primitives = require('./primitives.js');
const { editSpan, MARK_W, markPrefix, fieldWindow } = primitives;

// Inline fields paint their own selection; their spans map pointer positions.
const fieldHit = (editor, x, width, y) => ({
  ...editSpan(x + 1, x + 1, x + width + 1, 0, editor.text),
  editor,
  y,
  scroll: editor.scrollCol,
  live: false,
});

const pieceKind = (index, cursor, lo, hi) => {
  if (index === cursor) return 'caret';
  if (lo >= 0 && index >= lo && index < hi) return 'select';
  return 'plain';
};

const pushPiece = (pieces, kind, ch) => {
  const last = pieces[pieces.length - 1];
  if (last && last.kind === kind) last.text += ch;
  else pieces.push({ kind, text: ch });
};

const fieldPieces = (text, cursor, anchor, scroll, room) => {
  const raw = `${text ?? ''}`;
  const selected = typeof anchor === 'number' && anchor !== cursor;
  const lo = selected ? Math.min(anchor, cursor) : -1;
  const hi = selected ? Math.max(anchor, cursor) : -1;
  const pieces = [];
  let index = 0;
  let col = 0;
  for (const ch of graphemes(raw)) {
    const width = graphemeWidth(ch, col);
    const startCol = col;
    const start = index;
    index += ch.length;
    col += width;
    if (col <= scroll) continue;
    if (startCol >= scroll + room) break;
    const kind = pieceKind(start, cursor, lo, hi);
    pushPiece(pieces, kind, ch);
  }
  const caretAt = visibleWidth(raw.slice(0, Math.min(cursor, raw.length)));
  const atEnd = cursor >= raw.length;
  const caretFits = caretAt >= scroll && caretAt < scroll + room;
  if (atEnd && caretFits) pushPiece(pieces, 'caret', ' ');
  return pieces;
};

const paintField = (text, editor, room, color, tones) => {
  const cursor = editor ? editor.cursor : `${text ?? ''}`.length;
  const anchor = editor ? editor.anchor : null;
  const scroll = editor ? editor.scrollCol : 0;
  const pieces = fieldPieces(text, cursor, anchor, scroll, room);
  let used = 0;
  let out = '';
  for (const piece of pieces) {
    used += visibleWidth(piece.text);
    const tone = tones[piece.kind] ?? tones.plain;
    const painted = paint(piece.text, tone.fg, tone.bg, color);
    out += color ? painted : piece.text;
  }
  const pad = ' '.repeat(Math.max(0, room - used));
  const plain = tones.plain;
  if (!color) return out + pad;
  return out + paint(pad, plain.fg, plain.bg, color);
};

const queryTones = (fgRgb, bgRgb) => ({
  plain: { fg: fgRgb, bg: bgRgb },
  select: { fg: THEME.chromeFg, bg: THEME.checkBg },
  caret: { fg: THEME.searchOnFg, bg: THEME.searchOnBg },
});

const paintPlanFace = (view, face, fgRgb, bgRgb, color) => {
  const editor = view.planEditor;
  if (!editor || !view.planQuery) {
    return paint(face, fgRgb, bgRgb, color, true);
  }
  const room = visibleWidth(face);
  if (room) editor.reveal(room);
  const tones = queryTones(fgRgb, bgRgb);
  return paintField(view.planQuery, editor, room, color, tones);
};

const fieldTones = (fgRgb, bgRgb) => ({
  plain: { fg: fgRgb, bg: bgRgb },
  select: { fg: THEME.searchFg, bg: THEME.searchBg },
  caret: { fg: THEME.searchOnFg, bg: THEME.searchOnBg },
});

// A line typed into the status row, after a lead in the color of a key
const paintPromptLine = (lead, text, editor, width, color, fgRgb) => {
  const room = Math.max(0, width - lead.length);
  if (editor && room) editor.reveal(room);
  const bgRgb = THEME.chromeBg;
  const body = paintField(text, editor, room, color, fieldTones(fgRgb, bgRgb));
  if (!color) return `${lead}${body}`;
  return paint(lead, THEME.warnFg, bgRgb, color, true) + body;
};

const paintImportStatus = (view, width, color) => {
  const { url, editor } = view.import ?? {};
  const text = url ?? '';
  return paintPromptLine(' url ', text, editor, width, color, THEME.chromeFg);
};

const paintFindStatus = (view, width, color) => {
  const find = view.find ?? {};
  const query = find.query ?? '';
  const hits = fileMatches(view.allFiles ?? view.files ?? [], query);
  const miss = query.length > 0 && hits.length === 0;
  const tone = miss ? THEME.errorFg : THEME.chromeFg;
  return paintPromptLine(' /', query, find.editor, width, color, tone);
};

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

module.exports = {
  paintField,
  queryTones,
  paintPlanFace,
  paintImportStatus,
  paintFindStatus,
  fieldHit,
  paintNameEdit,
};
