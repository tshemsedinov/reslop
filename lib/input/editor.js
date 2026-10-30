'use strict';

const { clamp } = require('../common/utilities.js');
const { graphemes, visibleWidth } = require('../term/ansi.js');
const { wrapMove } = require('../term/wrap.js');
const { isTextKey, isNewlineKey } = require('./keys.js');
const clipboard = require('../term/select.js');

const UNDO_CAP = 100;

const WORD_RE = /[\p{L}\p{N}_]/u;

const EDIT_OP = {
  left: (editor) => editor.move(-1),
  right: (editor) => editor.move(1),
  'shift-left': (editor) => editor.move(-1, true),
  'shift-right': (editor) => editor.move(1, true),
  'ctrl-left': (editor) => editor.moveWord(-1),
  'ctrl-right': (editor) => editor.moveWord(1),
  'ctrl-shift-left': (editor) => editor.moveWord(-1, true),
  'ctrl-shift-right': (editor) => editor.moveWord(1, true),
  backspace: (editor) => editor.backspace(),
  'ctrl-backspace': (editor) => editor.backspaceWord(),
  delete: (editor) => editor.delete(),
};

const END_OP = {
  home: (editor) => editor.home(),
  end: (editor) => editor.end(),
  'shift-home': (editor) => editor.home(true),
  'shift-end': (editor) => editor.end(true),
};

const MENU_ROWS = 8;

const graphemeIndex = (text, cursor) => {
  const parts = graphemes(text);
  let position = 0;
  let i = 0;
  while (i < parts.length && position + parts[i].length <= cursor) {
    position += parts[i].length;
    i += 1;
  }
  return { parts, i, position };
};

const offsetAt = (parts, count) => {
  let position = 0;
  for (let i = 0; i < count; i++) position += parts[i].length;
  return position;
};

const isWordChar = (ch) => WORD_RE.test(ch);

const isSeparator = (ch) => !isWordChar(ch);

const charKind = (ch) => {
  if (ch === '\n') return 'line';
  if (isWordChar(ch)) return 'word';
  return /^\s+$/.test(ch) ? 'space' : 'mark';
};

const skipWhile = (parts, at, dir, pred) => {
  if (dir > 0) {
    while (at < parts.length && pred(parts[at])) at += 1;
    return at;
  }
  while (at > 0 && pred(parts[at - 1])) at -= 1;
  return at;
};

const wordIndex = (parts, at, dir) => {
  const ahead = dir > 0 ? parts[at] : parts[at - 1];
  const inWord = ahead !== undefined && isWordChar(ahead);
  const start = inWord ? at : skipWhile(parts, at, dir, isSeparator);
  return skipWhile(parts, start, dir, isWordChar);
};

const copyLine = (editor, ui) => {
  const text = editor.copiedText();
  if (!text) return;
  const ok = clipboard.copyText(text, ui.stdout);
  ui.status = ok ? 'copied' : 'copy failed';
};

const cutLine = (editor, ui) => {
  if (!editor.hasSelect()) return;
  copyLine(editor, ui);
  editor.removeCopied();
};

// A field of one line takes pasted lines joined, a box of many keeps them
const pasteLine = (editor, multiline) => {
  const raw = `${clipboard.pasteText() ?? ''}`.replaceAll('\r', '');
  const text = multiline ? raw : raw.replaceAll('\n', '');
  if (text) editor.insert(text);
};

const LINE_OP = {
  ...EDIT_OP,
  'ctrl-x': cutLine,
  'ctrl-v': (editor, ui, multiline) => pasteLine(editor, multiline),
};

const LINE_ENDS = { ...LINE_OP, ...END_OP };

const lineKey = (editor, key, ui, ends, multiline = false) => {
  if (key === 'ctrl-a') {
    editor.selectAll();
    return 'caret';
  }
  if (key === 'ctrl-c') {
    copyLine(editor, ui);
    return 'caret';
  }
  if (isNewlineKey(key)) {
    editor.insert('\n');
    return 'text';
  }
  const op = (ends ? LINE_ENDS : LINE_OP)[key];
  if (!op && !isTextKey(key)) return null;
  const before = editor.text;
  if (op) op(editor, ui, multiline);
  else editor.insert(key);
  return editor.text === before ? 'caret' : 'text';
};

const menuRows = (bodyH, fraction = 1) => {
  const height = Math.min(bodyH > 0 ? bodyH : MENU_ROWS, MENU_ROWS);
  return Math.max(1, Math.floor(height * fraction));
};

const pickDelta = (key, page, half) => {
  const steps = {
    up: -1,
    down: 1,
    pageUp: -page,
    pageDown: page,
    'ctrl-b': -page,
    'ctrl-f': page,
    'ctrl-u': -half,
    'ctrl-d': half,
    home: -Infinity,
    end: Infinity,
  };
  return Object.hasOwn(steps, key) ? steps[key] : 0;
};

class Editor {
  constructor(text = '') {
    this.text = text;
    this.cursor = text.length;
    this.undo = [];
    this.redo = [];
    this.wantCol = null;
    this.scrollCol = 0;
    this.anchor = null;
    this.keyed = false;
  }

  snapshot() {
    return { text: this.text, cursor: this.cursor, anchor: this.anchor };
  }

  restore(snap) {
    this.text = snap.text;
    this.cursor = snap.cursor;
    this.anchor = snap.anchor;
    this.keyed = false;
  }

  hasSelect() {
    return this.anchor !== null && this.anchor !== this.cursor;
  }

  span() {
    if (!this.hasSelect()) return { lo: this.cursor, hi: this.cursor };
    const lo = Math.min(this.anchor, this.cursor);
    const hi = Math.max(this.anchor, this.cursor);
    return { lo, hi };
  }

  // The run of letters, of spaces, or of marks that the offset is in
  wordSpan(offset) {
    const parts = graphemes(this.text);
    if (!parts.length) return { lo: 0, hi: 0 };
    const starts = [];
    let position = 0;
    for (const part of parts) {
      starts.push(position);
      position += part.length;
    }
    let at = starts.findLastIndex((start) => start <= offset);
    at = Math.max(0, at);
    const kind = charKind(parts[at]);
    let from = at;
    let to = at;
    while (from > 0 && charKind(parts[from - 1]) === kind) from -= 1;
    while (to < parts.length - 1 && charKind(parts[to + 1]) === kind) to += 1;
    return { lo: starts[from], hi: starts[to] + parts[to].length };
  }

  // The line of the text that the offset is in, without its line break
  lineSpan(offset) {
    const text = this.text;
    const lo = offset > 0 ? text.lastIndexOf('\n', offset - 1) + 1 : 0;
    const end = text.indexOf('\n', offset);
    return { lo, hi: end < 0 ? text.length : end };
  }

  selectSpan({ lo, hi }) {
    this.wantCol = null;
    this.cursor = hi;
    this.anchor = lo === hi ? null : lo;
    this.keyed = false;
  }

  selectedText() {
    const { lo, hi } = this.span();
    return this.text.slice(lo, hi);
  }

  // Shift-arrows select forward up to the caret and the caret shows the
  // next character, so copy and cut take it too. A mouse selection does not.
  copySpan() {
    const { lo, hi } = this.span();
    if (!this.keyed || !this.hasSelect() || this.cursor < this.anchor) {
      return { lo, hi };
    }
    const { parts, i } = graphemeIndex(this.text, hi);
    const next = parts[i] ?? '';
    return { lo, hi: hi + next.length };
  }

  copiedText() {
    const { lo, hi } = this.copySpan();
    return this.text.slice(lo, hi);
  }

  removeCopied() {
    if (!this.hasSelect()) return false;
    const { lo, hi } = this.copySpan();
    this.edit(this.text.slice(0, lo) + this.text.slice(hi), lo);
    return true;
  }

  beginSelect() {
    if (this.anchor !== null) return;
    this.anchor = this.cursor;
    this.keyed = true;
  }

  clearSelect() {
    this.anchor = null;
    this.keyed = false;
  }

  selectAll() {
    this.wantCol = null;
    this.anchor = 0;
    this.cursor = this.text.length;
    this.keyed = false;
  }

  collapse(delta) {
    const { lo, hi } = this.span();
    this.clearSelect();
    this.cursor = delta < 0 ? lo : hi;
  }

  removeSpan() {
    if (!this.hasSelect()) return false;
    const { lo, hi } = this.span();
    this.edit(this.text.slice(0, lo) + this.text.slice(hi), lo);
    return true;
  }

  edit(nextText, nextCursor) {
    this.undo.push(this.snapshot());
    if (this.undo.length > UNDO_CAP) this.undo.shift();
    this.redo = [];
    this.text = nextText;
    this.cursor = nextCursor;
    this.clearSelect();
  }

  insert(chunk) {
    this.wantCol = null;
    const { lo, hi } = this.span();
    const next = this.text.slice(0, lo) + chunk + this.text.slice(hi);
    this.edit(next, lo + chunk.length);
  }

  replace(text) {
    this.wantCol = null;
    this.edit(text, text.length);
  }

  place(offset) {
    this.wantCol = null;
    this.clearSelect();
    this.cursor = clamp(offset, 0, this.text.length);
  }

  backspace() {
    this.wantCol = null;
    if (this.removeSpan()) return;
    const { parts, i, position } = graphemeIndex(this.text, this.cursor);
    if (i === 0) return;
    const size = parts[i - 1].length;
    const next =
      this.text.slice(0, position - size) + this.text.slice(position);
    this.edit(next, this.cursor - size);
  }

  backspaceWord() {
    this.wantCol = null;
    if (this.removeSpan()) return;
    const { parts, i } = graphemeIndex(this.text, this.cursor);
    const start = offsetAt(parts, wordIndex(parts, i, -1));
    if (start === this.cursor) return;
    this.edit(this.text.slice(0, start) + this.text.slice(this.cursor), start);
  }

  delete() {
    this.wantCol = null;
    if (this.removeSpan()) return;
    const { parts, i, position } = graphemeIndex(this.text, this.cursor);
    if (i >= parts.length) return;
    const size = parts[i].length;
    const next =
      this.text.slice(0, position) + this.text.slice(position + size);
    this.edit(next, this.cursor);
  }

  move(delta, extend) {
    this.wantCol = null;
    if (!extend && this.hasSelect()) return void this.collapse(delta);
    if (extend) this.beginSelect();
    const { parts, i } = graphemeIndex(this.text, this.cursor);
    const next = i + delta;
    if (next < 0 || next > parts.length) return;
    this.cursor = offsetAt(parts, next);
  }

  moveWord(delta, extend) {
    this.wantCol = null;
    if (!extend && this.hasSelect()) return void this.collapse(delta);
    if (extend) this.beginSelect();
    const dir = delta < 0 ? -1 : 1;
    const { parts, i } = graphemeIndex(this.text, this.cursor);
    this.cursor = offsetAt(parts, wordIndex(parts, i, dir));
  }

  linePos() {
    const before = this.text.slice(0, this.cursor);
    const line = before.split('\n').length - 1;
    const col = before.length - before.lastIndexOf('\n') - 1;
    return { line, col };
  }

  visibleLineCol() {
    const { col, line } = this.linePos();
    const row = this.text.split('\n')[line];
    return visibleWidth(row.slice(0, col));
  }

  reveal(width) {
    const col = this.visibleLineCol();
    const room = Math.max(1, width);
    if (col < this.scrollCol) this.scrollCol = col;
    if (col >= this.scrollCol + room) this.scrollCol = col - room + 1;
  }

  moveLine(delta, width, extend) {
    if (extend) this.beginSelect();
    else this.clearSelect();
    if (width !== undefined) {
      const { text, cursor, wantCol } = this;
      const moved = wrapMove(text, cursor, width, delta, wantCol);
      this.wantCol = moved.col;
      this.cursor = moved.cursor;
      return;
    }
    const rows = this.text.split('\n');
    const { line, col } = this.linePos();
    const next = clamp(line + delta, 0, rows.length - 1);
    if (next === line) return;
    let cursor = 0;
    for (let i = 0; i < next; i++) cursor += rows[i].length + 1;
    this.cursor = cursor + Math.min(col, rows[next].length);
  }

  home(extend) {
    this.wantCol = null;
    if (extend) this.beginSelect();
    else this.clearSelect();
    this.cursor -= this.linePos().col;
  }

  end(extend) {
    this.wantCol = null;
    if (extend) this.beginSelect();
    else this.clearSelect();
    const { line, col } = this.linePos();
    this.cursor += this.text.split('\n')[line].length - col;
  }

  undoEdit() {
    if (!this.undo.length) return;
    this.wantCol = null;
    this.redo.push(this.snapshot());
    this.restore(this.undo.pop());
  }

  redoEdit() {
    if (!this.redo.length) return;
    this.wantCol = null;
    this.undo.push(this.snapshot());
    this.restore(this.redo.pop());
  }
}

const lineField = (name, text = '') => {
  const editor = new Editor(text);
  return {
    editor,
    get [name]() {
      return editor.text;
    },
  };
};

class MenuPick {
  constructor(field, cursor) {
    this.field = field;
    this.cursor = cursor;
    this.scroll = 0;
    this.editor = new Editor('');
  }

  get query() {
    return this.editor.text;
  }

  filter(items) {
    const query = this.query.trim().toLowerCase();
    if (!query) return items;
    return items.filter((name) => name.toLowerCase().includes(query));
  }

  touch() {
    this.cursor = 0;
    this.scroll = 0;
  }

  move(delta, items, isOff) {
    const last = items.length - 1;
    const step = delta < 0 ? -1 : 1;
    const goal = clamp(this.cursor + delta, 0, last);
    let cursor = this.cursor;
    for (let next = cursor; next !== goal;) {
      next += step;
      if (!isOff(items[next])) cursor = next;
    }
    if (isOff(items[cursor])) {
      let scan = goal;
      while (scan >= 0 && scan <= last && isOff(items[scan])) scan += step;
      if (scan >= 0 && scan <= last) cursor = scan;
    }
    this.cursor = cursor;
  }
}

module.exports = {
  EDIT_OP,
  copyLine,
  cutLine,
  lineKey,
  menuRows,
  pickDelta,
  Editor,
  lineField,
  MenuPick,
};
