'use strict';

const { clamp } = require('../common/utilities.js');
const ansi = require('../term/ansi.js');
const { wrapMultiline, wrapDoc, cursorInWrap } = require('../term/wrap.js');
const { isListPane, paneResult, editSpan } = require('./primitives.js');
const { THEME, paint, visibleWidth, truncateVisible, seq, EL, RESET } = ansi;
const { codeFg } = ansi;
const { tokenize } = require('../highlight/highlight.js');

const INPUT_MAX = 4;
const NOTE_MAX = 4;
const NOTE_PAD = 1;
const CHECK_DONE = 'xX';
const CHECK_TOKEN = /\[([ xX])\]/;
const CHECK_LEAD = /^\[[ xX]\] /;
const TODO_LEAD_W = '[ ] '.length;
const NO_NOTE = { rows: [], cursor: null, templateHits: [], editHits: [] };

const paintBar = (text, width, fgRgb, bgRgb, color) => {
  const clipped = truncateVisible(text, width);
  const pad = Math.max(0, width - visibleWidth(clipped));
  const filled = clipped + ' '.repeat(pad);
  if (!color) return filled;
  return `${seq(fgRgb, bgRgb)}${EL}${filled}${RESET}`;
};

const checkChip = (mark, fg, bg, plain) => {
  let fgRgb = fg;
  let bgRgb = bg;
  const done = CHECK_DONE.includes(mark);
  if (!plain && done) {
    fgRgb = THEME.checkDoneFg;
    bgRgb = THEME.checkDoneBg;
  } else if (!plain) {
    fgRgb = THEME.checkFg;
    bgRgb = THEME.checkBg;
  }
  return { fgRgb, bgRgb };
};

const paintCheckBar = (text, width, fgRgb, bgRgb, color, plain = false) => {
  const clipped = truncateVisible(text, width);
  const match = color ? CHECK_TOKEN.exec(clipped) : null;
  if (!match) return paintBar(text, width, fgRgb, bgRgb, color);
  const token = match[0];
  const pad = Math.max(0, width - visibleWidth(clipped));
  const before = clipped.slice(0, match.index);
  const after = clipped.slice(match.index + token.length) + ' '.repeat(pad);
  const chip = checkChip(match[1], fgRgb, bgRgb, plain);
  let out = `${seq(fgRgb, bgRgb)}${EL}`;
  out += paint(before, fgRgb, bgRgb, color);
  out += paint(token, chip.fgRgb, chip.bgRgb, color);
  return out + paint(after, fgRgb, bgRgb, color);
};

const windowRows = (rows, focus, cap) => {
  if (rows.length <= cap) return { rows, offset: 0 };
  const start = clamp(focus - cap + 1, 0, rows.length - cap);
  return { rows: rows.slice(start, start + cap), offset: start };
};

const todoInnerWidth = (width) => Math.max(1, width - 2);

const todoBodyWidth = (width) =>
  Math.max(1, todoInnerWidth(width) - TODO_LEAD_W);

const noteInnerWidth = (width) => Math.max(1, width - NOTE_PAD * 2);

const todoParts = (text, inner) => {
  const match = CHECK_LEAD.exec(text);
  const lead = match ? match[0].length : 0;
  return { lead, body: text.slice(lead), bodyW: Math.max(1, inner - lead) };
};

const wrapTodoItem = (text, todo) => {
  const mark = text.slice(0, todo.lead);
  const hang = ' '.repeat(todo.lead);
  const lines = wrapMultiline(todo.body, todo.bodyW);
  return lines.map((line, index) => `${index ? hang : mark}${line}`);
};

const todoEdit = (todo, edit, rowStart, width) => {
  const pos = cursorInWrap(todo.body, edit.cursor ?? 0, todo.bodyW);
  const cursor = { x: pos.col + todo.lead + 2, row: rowStart + pos.row };
  const x0 = todo.lead + 1;
  const doc = wrapDoc(todo.body, todo.bodyW);
  const hits = doc.map((piece, line) => ({
    row: rowStart + line,
    ...editSpan(x0, x0 + 1, width + 1, piece.start, piece.text),
  }));
  return { cursor, hits };
};

const taskLists = (view) => {
  const sections = view.taskSections;
  if (sections && sections.length) return sections;
  const tasks = view.tasks ?? [];
  const texts = !tasks.length && view.noteText ? [view.noteText] : tasks;
  return [{ title: '', texts }];
};

// A view with plain labels instead of rows: a title per section, a label
// per task
const labelRows = (view) => {
  const rows = [];
  for (const section of taskLists(view)) {
    if (section.title) {
      rows.push({ type: 'heading', text: section.title, focus: false });
    }
    for (const text of section.texts) rows.push({ type: 'label', text });
  }
  return rows;
};

const PRIORITY_FG = {
  critical: () => THEME.errorFg,
  high: () => THEME.warnFg,
  low: () => THEME.mutedFg,
};

const TEXT_INDENT = '  ';

const paintSectionHead = (title, width, color, aside = '', look = {}) => {
  const fgRgb = look.fgRgb ?? THEME.taskHeadFg;
  const bgRgb = look.bgRgb ?? THEME.taskHeadBg;
  const room = Math.max(0, width - visibleWidth(aside) - 2);
  const head = truncateVisible(` ${title}`, room);
  const gap = ' '.repeat(
    Math.max(1, width - visibleWidth(head) - visibleWidth(aside) - 1),
  );
  return paintBar(`${head}${gap}${aside}`, width, fgRgb, bgRgb, color);
};

const paintSectionGap = (width, color) =>
  paintBar('', width, THEME.ctxFg, THEME.ctxBg, color);

const paintPieces = (pieces, width, bgRgb, color) => {
  let out = color ? `${seq(THEME.chromeFg, bgRgb)}${EL}` : '';
  let used = 0;
  for (const piece of pieces) {
    if (used >= width) break;
    const text = truncateVisible(piece.text, width - used);
    out += paint(text, piece.fg, bgRgb, color);
    used += visibleWidth(text);
  }
  const pad = ' '.repeat(Math.max(0, width - used));
  return out + paint(pad, THEME.chromeFg, bgRgb, color);
};

const rowColors = (selected) => ({
  fgRgb: selected ? THEME.chromeFg : THEME.mutedFg,
  bgRgb: selected ? THEME.buttonBg : THEME.ctxBg,
});

// A collapsed task: checkbox, ID, priority, title, and `check n/m`
const paintTaskRow = (row, width, color, selected) => {
  const { fgRgb, bgRgb } = rowColors(selected);
  const mark = row.done ? 'x' : ' ';
  const chip = checkChip(mark, fgRgb, bgRgb, !color);
  const aside = row.aside ? ` ${row.aside}` : '';
  const room = Math.max(1, width - 5 - visibleWidth(aside));
  const head = [];
  if (row.id) head.push({ text: `${row.id} `, fg: fgRgb });
  if (row.priority) {
    const tone = PRIORITY_FG[row.priority];
    head.push({ text: `${row.priority} `, fg: tone ? tone() : fgRgb });
  }
  const used = head.reduce((sum, piece) => sum + visibleWidth(piece.text), 0);
  const title = truncateVisible(row.title, Math.max(0, room - used));
  const gap = ' '.repeat(Math.max(0, room - used - visibleWidth(title)));
  let out = color ? `${seq(fgRgb, bgRgb)}${EL}` : '';
  out += paint(' ', fgRgb, bgRgb, color);
  out += paint(`[${mark}]`, chip.fgRgb, chip.bgRgb, color);
  out += paint(' ', fgRgb, bgRgb, color);
  const rest = [...head, { text: title + gap, fg: fgRgb }];
  rest.push({ text: aside, fg: THEME.mutedFg });
  return out + paintPieces(rest, Math.max(0, width - 5), bgRgb, color);
};

const DETAIL_LEAD = 5;
const KEY_W = 12;
const VALUE_X = DETAIL_LEAD + KEY_W;

const detailTone = (detail) => {
  if (detail.kind === 'ghost' || detail.kind === 'text') return THEME.mutedFg;
  if (detail.key === 'result') return THEME.addLineFg;
  return THEME.chromeFg;
};

// The lines of one field, check, or line of free text under a task
const paintDetail = (detail, width, color, look) => {
  const { bgRgb } = look;
  const room = Math.max(1, width - VALUE_X);
  const key = (detail.key ?? '').padEnd(KEY_W);
  const lead = [
    { text: ' '.repeat(DETAIL_LEAD), fg: THEME.mutedFg },
    { text: key, fg: THEME.mutedFg },
  ];
  if (detail.kind === 'check') {
    const mark = detail.done ? 'x' : ' ';
    const chip = checkChip(mark, look.fgRgb, bgRgb, !color);
    const text = truncateVisible(detail.text, Math.max(0, room - 4));
    let out = paintPieces(lead, VALUE_X, bgRgb, color);
    out += paint(`[${mark}]`, chip.fgRgb, chip.bgRgb, color);
    const rest = [{ text: ` ${text}`, fg: look.fgRgb }];
    return [
      out + paintPieces(rest, Math.max(0, width - VALUE_X - 3), bgRgb, color),
    ];
  }
  const value = detail.kind === 'ghost' ? `░ ${detail.text}` : detail.text;
  const fg = detailTone(detail);
  return wrapMultiline(value, room).map((line, index) => {
    const head = index ? [{ text: ' '.repeat(VALUE_X), fg }] : lead;
    return paintPieces([...head, { text: line, fg }], width, bgRgb, color);
  });
};

const checkBox = (sub) => ({ sub, x0: VALUE_X, x1: VALUE_X + 3 });

// A task's fields, checks, and free text, one entry per painted line; the
// check lines carry their own click box
const paintDetails = (row, width, color, selected) => {
  const out = [];
  const details = row.details ?? [];
  for (let i = 0; i < details.length; i++) {
    const detail = details[i];
    const own = selected && row.sub === detail.sub && detail.kind === 'check';
    const look = rowColors(own || (selected && row.sub === undefined));
    const lines = paintDetail(detail, width, color, look);
    for (let line = 0; line < lines.length; line++) {
      const box = detail.kind === 'check' && line === 0;
      out.push({ line: lines[line], check: box && checkBox(detail.sub) });
    }
  }
  return out;
};

const fenceLines = (row) => {
  const lines = row.text.split('\n');
  const open = lines[0];
  const close = lines.length > 1 ? lines[lines.length - 1] : '';
  const inner = lines.slice(1, close.trim() ? -1 : undefined);
  const tokens = tokenize(row.lang, inner.join('\n'));
  const out = [[{ text: open, style: 'punct' }]];
  let line = [];
  for (const token of tokens) {
    const parts = (token.text ?? '').split('\n');
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) {
        out.push(line);
        line = [];
      }
      if (parts[i]) line.push({ text: parts[i], style: token.style });
    }
  }
  if (inner.length) out.push(line);
  if (close.trim()) out.push([{ text: close, style: 'punct' }]);
  return out;
};

const paintTextRows = (row, width, color, selected) => {
  const { fgRgb, bgRgb } = rowColors(selected);
  const inner = Math.max(1, width - 1 - TEXT_INDENT.length);
  if (row.lang === undefined || row.lang === null) {
    return wrapMultiline(row.text, inner).map((line) =>
      paintBar(` ${TEXT_INDENT}${line}`, width, fgRgb, bgRgb, color),
    );
  }
  return fenceLines(row).map((tokens) => {
    const pieces = [{ text: ` ${TEXT_INDENT}`, fg: fgRgb }];
    for (const token of tokens) {
      pieces.push({
        text: token.text,
        fg: color ? codeFg(token.style) : fgRgb,
      });
    }
    return paintPieces(pieces, width, bgRgb, color);
  });
};

const paintLabelRows = (text, width, color, selected) => {
  const { fgRgb, bgRgb } = rowColors(selected);
  const todo = todoParts(text, todoInnerWidth(width));
  return wrapTodoItem(text, todo).map((line) =>
    paintCheckBar(` ${line}`, width, fgRgb, bgRgb, color, true),
  );
};

const paintHeadingRow = (row, width, color, selected) => {
  const look = selected ? { fgRgb: THEME.chromeFg, bgRgb: THEME.buttonBg } : {};
  const depth = Math.max(0, (row.level ?? 2) - 2);
  const mark = row.folded ? '▸ ' : '';
  const text = `${'  '.repeat(depth)}${mark}${row.text}`;
  return [paintSectionHead(text, width, color, row.aside ?? '', look)];
};

const plainLines = (lines, check) =>
  lines.map((line, index) => ({ line, check: index === 0 && check }));

// The painted lines of a row, each with the click box it has, if any
const paintRow = (row, width, color, selected) => {
  if (row.type === 'heading') {
    return plainLines(paintHeadingRow(row, width, color, selected), false);
  }
  if (row.type === 'task') {
    const own = selected && row.sub === undefined;
    const head = paintTaskRow(row, width, color, own);
    const details = paintDetails(row, width, color, selected);
    return [{ line: head, check: true }, ...details];
  }
  if (row.type === 'text') {
    return plainLines(paintTextRows(row, width, color, selected), false);
  }
  const lines = paintLabelRows(row.text, width, color, selected);
  const ghosts = paintDetails(row, width, color, false);
  return [...plainLines(lines, CHECK_LEAD.test(row.text ?? '')), ...ghosts];
};

const paintBodyTodo = (view, width, color) => {
  const focus = view.tasksFocus ?? 0;
  const rows = view.taskRows ?? labelRows(view);
  const body = [];
  const taskOwners = [];
  const taskChecks = [];
  const push = (line, owner, check) => {
    body.push(line);
    taskOwners.push(owner);
    taskChecks.push(check);
  };
  let editHits = [];
  let cursor = null;
  let index = 0;
  for (const row of rows) {
    const focusable = row.focus !== false;
    const owner = focusable ? index : null;
    const selected = focusable && index === focus;
    if (row.type === 'heading' && body.length) {
      push(paintSectionGap(width, color), null, false);
    }
    const rowStart = body.length;
    for (const { line, check } of paintRow(row, width, color, selected)) {
      push(line, owner, check);
    }
    if (view.taskEdit && selected && row.type === 'label') {
      const todo = todoParts(row.text, todoInnerWidth(width));
      const edit = todoEdit(todo, view.taskEdit, rowStart, width);
      cursor = edit.cursor;
      editHits = edit.hits;
    }
    if (focusable) index += 1;
  }
  return paneResult({ body, editHits, taskOwners, taskChecks, cursor });
};

const noteLine = (text, width) =>
  `${' '.repeat(NOTE_PAD)}${truncateVisible(text, noteInnerWidth(width))}`;

const paintComposeNote = (view, width, color, cap) => {
  const inner = noteInnerWidth(width);
  const { compose } = view;
  const doc = wrapDoc(compose.text ?? '', inner);
  const { row, col } = cursorInWrap(compose.text, compose.cursor ?? 0, inner);
  const shown = windowRows(doc, row, INPUT_MAX);
  const templates = view.templates ?? [];
  const room = Math.max(0, cap - shown.rows.length);
  const count = Math.min(templates.length, room);
  const focus = view.templateIndex ?? -1;
  const rows = [];
  const templateHits = [];
  for (let i = 0; i < count; i++) {
    const selected = i === focus;
    const fgRgb = selected ? THEME.chromeFg : THEME.mutedFg;
    const bgRgb = selected ? THEME.buttonBg : THEME.noteBg;
    const line = noteLine(templates[i].text ?? '', width);
    rows.push(paintBar(line, width, fgRgb, bgRgb, color));
    templateHits.push({ row: i, cursor: i });
  }
  const editHits = [];
  for (const piece of shown.rows) {
    const span = editSpan(1, NOTE_PAD + 1, width + 1, piece.start, piece.text);
    editHits.push({ row: rows.length, ...span });
    const line = noteLine(piece.text, width);
    rows.push(paintBar(line, width, THEME.chromeFg, THEME.noteBg, color));
  }
  const cursor = { x: NOTE_PAD + col + 1, row: count + row - shown.offset };
  return { rows, cursor, templateHits, editHits };
};

const paintIdleNote = (view, width, color) => {
  if (!view.noteText) return NO_NOTE;
  const note = `feedback: ${view.noteText}`;
  const wrapped = wrapMultiline(note, noteInnerWidth(width));
  const rows = wrapped.slice(0, NOTE_MAX).map((text) => {
    const line = noteLine(text, width);
    return paintCheckBar(line, width, THEME.chromeFg, THEME.noteBg, color);
  });
  return { rows, cursor: null, templateHits: [], editHits: [] };
};

const paintNotePanel = (view, width, color, cap) => {
  if (view.compose?.kind === 'feedback') {
    return paintComposeNote(view, width, color, cap);
  }
  if (isListPane(view.pane)) return NO_NOTE;
  return paintIdleNote(view, width, color);
};

module.exports = {
  todoBodyWidth,
  noteInnerWidth,
  paintNotePanel,
  paintBodyTodo,
};
