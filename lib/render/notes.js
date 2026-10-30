'use strict';

const { clamp } = require('../common/utilities.js');
const ansi = require('../term/ansi.js');
const wrap = require('../term/wrap.js');
const { wrapMultiline, wrapDoc, wrapPlain, cursorInWrap } = wrap;
const { isListPane, paneResult, editSpan } = require('./primitives.js');
const { THEME, paint, visibleWidth, truncateVisible, seq, EL, RESET } = ansi;
const { codeFg, trimVisible } = ansi;
const { tokenize } = require('../highlight/highlight.js');
const { parseTitle } = require('../review/task.js');

const INPUT_MAX = 4;
const NOTE_MAX = 4;
const NOTE_PAD = 1;
const CHECK_DONE = 'xX';
const CHECK_TOKEN = /\[([ xX])\]/;
const CHECK_LEAD = /^\[[ xX]\] /;
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

const todoEdit = (todo, edit, rowStart, width, indent = 0) => {
  const pos = cursorInWrap(todo.body, edit.cursor ?? 0, todo.bodyW);
  const x = pos.col + todo.lead + indent + 2;
  const cursor = { x, row: rowStart + pos.row };
  const x0 = todo.lead + indent + 1;
  const doc = wrapDoc(todo.body, todo.bodyW);
  const hits = doc.map((piece, line) => ({
    row: rowStart + line,
    ...editSpan(x0, x0 + 1, width + 1, piece.start, piece.text),
  }));
  return { cursor, hits };
};

const TEXT_INDENT = '  ';

const paintBlockHead = (title, width, color, aside = '', look = {}) => {
  const fgRgb = look.fgRgb ?? THEME.taskHeadFg;
  const bgRgb = look.bgRgb ?? THEME.taskHeadBg;
  const room = Math.max(0, width - visibleWidth(aside) - 2);
  const head = trimVisible(` ${title}`, room);
  const gap = ' '.repeat(
    Math.max(1, width - visibleWidth(head) - visibleWidth(aside) - 1),
  );
  return paintBar(`${head}${gap}${aside}`, width, fgRgb, bgRgb, color);
};

const paintTitle = (row, width, color, selected) => {
  const bgRgb = selected ? THEME.buttonBg : THEME.ctxBg;
  const text = trimVisible(` ${row.text}`, width);
  const pad = ' '.repeat(Math.max(0, width - visibleWidth(text)));
  const bar = color ? `${seq(THEME.chromeFg, bgRgb)}${EL}` : '';
  return (
    bar +
    paint(text, THEME.chromeFg, bgRgb, color, true) +
    paint(pad, THEME.chromeFg, bgRgb, color)
  );
};

const paintBlockGap = (width, color) =>
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

// The ID and priority as written, `f1: ` or `B1 high: `; a priority is
// yellow wherever a task shows it
const headPieces = (row, fgRgb) => {
  const head = row.head ?? '';
  if (!head) return [];
  const at = row.priority ? head.toLowerCase().indexOf(row.priority) : -1;
  if (at < 0) return [{ text: head, fg: fgRgb }];
  const end = at + row.priority.length;
  return [
    { text: head.slice(0, at), fg: fgRgb },
    { text: head.slice(at, end), fg: THEME.warnFg },
    { text: head.slice(end), fg: fgRgb },
  ];
};

const MIN_TITLE = 12;

// What a closed task hides, dim after its title: `  (where, check: 1/2)`,
// the checks green once all are done
const hiddenText = (row) => {
  const parts = row.hidden ? [...row.hidden] : [];
  if (row.checks) parts.push(row.checks);
  return parts.length ? `  (${parts.join(', ')})` : '';
};

const hiddenPieces = (row, room) => {
  const full = hiddenText(row);
  if (!full || room < 4) return [];
  const text = trimVisible(full, room);
  const at = row.complete ? text.indexOf(row.checks) : -1;
  if (at < 0) return [{ text, fg: THEME.mutedFg }];
  const end = at + row.checks.length;
  return [
    { text: text.slice(0, at), fg: THEME.mutedFg },
    { text: text.slice(at, end), fg: THEME.addLineFg },
    { text: text.slice(end), fg: THEME.mutedFg },
  ];
};

// A task row: checkbox, ID, priority, title, then what it hides or a note
const paintTaskRow = (row, width, color, selected) => {
  const { fgRgb, bgRgb } = rowColors(selected);
  const mark = row.done ? 'x' : ' ';
  const chip = checkChip(mark, fgRgb, bgRgb, !color);
  const aside = row.aside ? ` ${row.aside} ` : ' ';
  const room = Math.max(1, width - 5 - visibleWidth(aside));
  const textFg = row.done ? THEME.mutedFg : THEME.chromeFg;
  const head = headPieces(row, textFg);
  const used = head.reduce((sum, piece) => sum + visibleWidth(piece.text), 0);
  // A long title gives way to what the task hides, down to a few words
  const free = Math.max(0, room - used);
  const hides = row.note ? 0 : visibleWidth(hiddenText(row));
  const titleRoom = Math.max(Math.min(MIN_TITLE, free), free - hides);
  const title = trimVisible(row.title, titleRoom);
  const left = Math.max(0, room - used - visibleWidth(title));
  const note = row.note ? truncateVisible(`   ${row.note}`, left) : '';
  const hidden = note ? [] : hiddenPieces(row, left);
  const tail = note ? [{ text: note, fg: THEME.mutedFg }] : hidden;
  const tailW = tail.reduce((sum, piece) => sum + visibleWidth(piece.text), 0);
  const gap = ' '.repeat(Math.max(0, left - tailW));
  let out = color ? `${seq(fgRgb, bgRgb)}${EL}` : '';
  out += paint(' ', fgRgb, bgRgb, color);
  out += paint(`[${mark}]`, chip.fgRgb, chip.bgRgb, color);
  out += paint(' ', fgRgb, bgRgb, color);
  const rest = [...head, { text: title, fg: textFg }, ...tail];
  rest.push({ text: gap, fg: textFg });
  rest.push({ text: aside, fg: THEME.mutedFg });
  return out + paintPieces(rest, Math.max(0, width - 5), bgRgb, color);
};

// The box of a row's own checkbox, after the one-column lead
const ROW_BOX = { x0: 1, x1: 4 };

const tokenizeFence = (row) => {
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

// Fences repaint on every key; their tokens are kept until the text changes
const FENCE_CACHE = new Map();
const FENCE_KEEP = 64;

const fenceLines = (row) => {
  const key = `${row.lang}\0${row.text}`;
  const known = FENCE_CACHE.get(key);
  if (known) return known;
  const out = tokenizeFence(row);
  if (FENCE_CACHE.size >= FENCE_KEEP) FENCE_CACHE.clear();
  FENCE_CACHE.set(key, out);
  return out;
};

// A line of code wraps where its text would in the editor, so it stays in
// place when it is edited
const wrapTokens = (tokens, width) => {
  const rows = wrapPlain(tokens.map((token) => token.text).join(''), width);
  if (rows.length < 2) return [tokens];
  const out = [];
  let rest = tokens.slice();
  for (const row of rows) {
    const line = [];
    let need = row.length;
    while (need > 0 && rest.length) {
      const [token, ...more] = rest;
      const take = token.text.slice(0, need);
      line.push({ ...token, text: take });
      need -= take.length;
      const left = token.text.slice(take.length);
      rest = left ? [{ ...token, text: left }, ...more] : more;
    }
    out.push(line);
  }
  return out;
};

const paintTextRows = (row, width, color, selected) => {
  const { fgRgb, bgRgb } = rowColors(selected);
  const inner = Math.max(1, todoInnerWidth(width) - TEXT_INDENT.length);
  if (row.lang === undefined || row.lang === null) {
    return wrapMultiline(row.text, inner).map((line) =>
      paintBar(` ${TEXT_INDENT}${line}`, width, fgRgb, bgRgb, color),
    );
  }
  return fenceLines(row)
    .flatMap((tokens) => wrapTokens(tokens, inner))
    .map((tokens) => {
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

// The edited block keeps the place its row has: text under the indent of
// text, a deeper heading under its own
const labelIndent = (row) => {
  if (row.shape === 'text') return TEXT_INDENT.length;
  if (row.shape === 'heading') return 2 * Math.max(0, (row.level ?? 2) - 2);
  return 0;
};

// A heading keeps the room of its count, as when it is not edited
const asideRoom = (row) => (row.aside ? visibleWidth(row.aside) + 1 : 0);

const labelParts = (row, width) => {
  const room = todoInnerWidth(width) - labelIndent(row) - asideRoom(row);
  return todoParts(row.text, Math.max(1, room));
};

// The wrap width of the edited block, for Up and Down to move by
const labelBodyWidth = (row, width) => labelParts(row, width).bodyW;

// A field line of a task's text: `- where: lib/a.js`
const FIELD_LINE = /^- ([a-z][a-z0-9_-]*):/;

// The colors in a task's text: its priority yellow, the names of its
// fields blue and their values green, lines under a field among them
const taskTones = (body) => {
  const tones = [];
  let at = 0;
  let inField = false;
  body.split('\n').forEach((line, index) => {
    const field = index ? FIELD_LINE.exec(line) : null;
    if (!index) {
      const { head, priority } = parseTitle(line);
      const from = priority ? head.toLowerCase().indexOf(priority) : -1;
      if (from >= 0) {
        const end = at + from + priority.length;
        tones.push({ start: at + from, end, fg: THEME.warnFg });
      }
    } else if (field) {
      const key = at + 2;
      const end = key + field[1].length;
      tones.push({ start: key, end, fg: THEME.shaFg });
      tones.push({
        start: end + 1,
        end: at + line.length,
        fg: THEME.addLineFg,
      });
      inField = true;
    } else if (inField && /^\s/.test(line)) {
      tones.push({ start: at, end: at + line.length, fg: THEME.addLineFg });
    } else {
      inField = false;
    }
    at += line.length + 1;
  });
  return tones;
};

// A piece of wrapped text cut where its colors change
const tonedPieces = (piece, tones, fgRgb) => {
  const end = piece.start + piece.text.length;
  const cut = (from, to) =>
    piece.text.slice(from - piece.start, to - piece.start);
  const out = [];
  let at = piece.start;
  for (const tone of tones) {
    if (tone.end <= at || tone.start >= end) continue;
    const from = Math.max(at, tone.start);
    const to = Math.min(end, tone.end);
    if (from > at) out.push({ text: cut(at, from), fg: fgRgb });
    out.push({ text: cut(from, to), fg: tone.fg });
    at = to;
  }
  if (at < end) out.push({ text: cut(at, end), fg: fgRgb });
  return out;
};

// A task as its text, the way the editor shows it, in its colors
const paintTaskText = (row, width, color, look) => {
  const { fgRgb, bgRgb } = look;
  const todo = labelParts(row, width);
  const mark = row.text.slice(0, todo.lead);
  const hang = ' '.repeat(todo.lead);
  const tones = taskTones(todo.body);
  return wrapDoc(todo.body, todo.bodyW).map((piece, index) => {
    const pieces = tonedPieces(piece, tones, fgRgb);
    if (index || !mark) {
      const lead = ` ${index ? hang : mark}`;
      return paintPieces(
        [{ text: lead, fg: fgRgb }, ...pieces],
        width,
        bgRgb,
        color,
      );
    }
    const box = CHECK_TOKEN.exec(mark);
    const chip = checkChip(box ? box[1] : ' ', fgRgb, bgRgb, !color);
    let out = color ? `${seq(fgRgb, bgRgb)}${EL}` : '';
    out += paint(' ', fgRgb, bgRgb, color);
    out += paint(mark.trimEnd(), chip.fgRgb, chip.bgRgb, color);
    const rest = [{ text: ' ', fg: fgRgb }, ...pieces];
    const used = 1 + visibleWidth(mark.trimEnd());
    return out + paintPieces(rest, Math.max(0, width - used), bgRgb, color);
  });
};

const paintLabelRows = (row, width, color, selected) => {
  if (row.shape === 'task') {
    return paintTaskText(row, width, color, rowColors(selected));
  }
  const { fgRgb, bgRgb } = rowColors(selected);
  const lead = ` ${' '.repeat(labelIndent(row))}`;
  const lines = wrapTodoItem(row.text, labelParts(row, width));
  return lines.map((line, index) => {
    let text = `${lead}${line}`;
    if (row.aside && !index) {
      const gap = width - visibleWidth(text) - visibleWidth(row.aside) - 1;
      text += `${' '.repeat(Math.max(1, gap))}${row.aside}`;
    }
    return paintCheckBar(text, width, fgRgb, bgRgb, color, true);
  });
};

// A `#` title is bold text; a block is a bar; a preview of a block the
// file does not have yet is a dim bar
const paintHeadingRow = (row, width, color, selected) => {
  if (row.level === 1) return [paintTitle(row, width, color, selected)];
  let look = selected ? { fgRgb: THEME.chromeFg, bgRgb: THEME.buttonBg } : {};
  if (row.preview) look = { fgRgb: THEME.mutedFg };
  const depth = Math.max(0, (row.level ?? 2) - 2);
  const hides = row.folded && row.hidden ? `  ${row.hidden}` : '';
  const text = `${'  '.repeat(depth)}${row.text}${hides}`;
  return [paintBlockHead(text, width, color, row.aside ?? '', look)];
};

// The first lines of a folded block of text, dim under its heading
const peekLines = (row, width, color) =>
  (row.peek ?? []).map((text) => ({
    line: paintPieces(
      [
        {
          text: trimVisible(` ${TEXT_INDENT}${text}`, width - 1),
          fg: THEME.mutedFg,
        },
      ],
      width,
      THEME.ctxBg,
      color,
    ),
  }));

// What a folded block hides, dim under its heading while it is edited
const paintHidden = (text, width, color) =>
  paintPieces(
    [{ text: `   ${text}`, fg: THEME.mutedFg }],
    width,
    THEME.ctxBg,
    color,
  );

const plainLines = (lines, box) =>
  lines.map((line, index) => ({ line, check: index === 0 && box }));

// The painted lines of a row, each with the click box it has, if any
const paintRow = (row, width, color, selected) => {
  if (row.type === 'heading') {
    const head = plainLines(
      paintHeadingRow(row, width, color, selected),
      false,
    );
    return [...head, ...peekLines(row, width, color)];
  }
  if (row.type === 'task') {
    return [
      { line: paintTaskRow(row, width, color, selected), check: ROW_BOX },
    ];
  }
  if (row.type === 'text') {
    return plainLines(paintTextRows(row, width, color, selected), false);
  }
  const lines = paintLabelRows(row, width, color, selected);
  const box = CHECK_LEAD.test(row.text ?? '') && ROW_BOX;
  const out = plainLines(lines, box);
  if (row.hidden) out.push({ line: paintHidden(row.hidden, width, color) });
  return [...out, ...peekLines(row, width, color)];
};

const paintBodyTodo = (view, width, color) => {
  const focus = view.tasksFocus ?? 0;
  const rows = view.taskRows ?? [];
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
    if ((row.type === 'heading' || row.gap) && body.length) {
      push(paintBlockGap(width, color), null, false);
    }
    const rowStart = body.length;
    for (const { line, check } of paintRow(row, width, color, selected)) {
      push(line, owner, check);
    }
    if (view.taskEdit && selected && row.type === 'label') {
      const indent = labelIndent(row);
      const todo = labelParts(row, width);
      const edit = todoEdit(todo, view.taskEdit, rowStart, width, indent);
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
  labelBodyWidth,
  noteInnerWidth,
  paintNotePanel,
  paintBodyTodo,
};
