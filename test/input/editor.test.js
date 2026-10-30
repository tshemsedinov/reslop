'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { Editor, lineKey } = require('../../lib/input/editor.js');
const clipboard = require('../../lib/term/select.js');
const { Composer } = require('../../lib/session/compose.js');

const EDIT_KINDS = [
  'blockTask',
  'code',
  'file',
  'tasks',
  'commit',
  'branch',
  'npm',
  'package',
  'worktree',
];

const composeOf = (kind) => {
  const ui = {
    lastSize: { width: 40, height: 24 },
    commits: { commitView: 'brief' },
    nav: { unitLine: 0 },
  };
  const composer = new Composer(ui);
  ui.composer = composer;
  composer.composeKind = kind;
  composer.editor = new Editor('ab');
  composer.editor.place(1);
  return composer;
};

test('insert and backspace at cursor', () => {
  const editor = new Editor();
  editor.insert('ab');
  assert.equal(editor.text, 'ab');
  assert.equal(editor.cursor, 2);
  editor.move(-1);
  editor.insert('X');
  assert.equal(editor.text, 'aXb');
  editor.backspace();
  assert.equal(editor.text, 'ab');
  assert.equal(editor.cursor, 1);
});

test('ctrl-a selects all text in a line editor', () => {
  const editor = new Editor('hello');
  editor.place(2);
  const ui = { status: '', stdout: {} };
  assert.equal(lineKey(editor, 'ctrl-a', ui, true), 'caret');
  assert.equal(editor.selectedText(), 'hello');
});

test('undo and redo restore text and cursor', () => {
  const editor = new Editor('hi');
  editor.insert('!');
  assert.equal(editor.text, 'hi!');
  editor.undoEdit();
  assert.equal(editor.text, 'hi');
  assert.equal(editor.cursor, 2);
  editor.redoEdit();
  assert.equal(editor.text, 'hi!');
});

test('ctrl-enter and shift-enter insert a newline in input boxes', () => {
  const editor = new Editor('ab');
  editor.place(1);
  const ui = { status: '', stdout: {} };
  assert.equal(lineKey(editor, 'ctrl-enter', ui, true), 'text');
  assert.equal(editor.text, 'a\nb');
  assert.equal(lineKey(editor, 'shift-enter', ui, true), 'text');
  assert.equal(editor.text, 'a\n\nb');
  assert.equal(lineKey(editor, 'ctrl-shift-enter', ui, true), 'text');
  assert.equal(editor.text, 'a\n\n\nb');
});

test('ctrl-enter and shift-enter insert a newline in every editor', () => {
  const chords = ['ctrl-enter', 'shift-enter', 'ctrl-shift-enter', 'alt-enter'];
  for (const kind of EDIT_KINDS) {
    for (const key of chords) {
      const composer = composeOf(kind);
      composer.handleKey(key);
      assert.equal(composer.editor.text, 'a\nb', `${kind} ${key}`);
      assert.equal(composer.composeKind, kind);
    }
  }
});

test('enter inserts a newline at the task cursor and keeps editing', () => {
  const composer = composeOf('tasks');
  const editor = composer.editor;
  composer.handleKey('enter');
  composer.handleKey('enter');
  assert.equal(composer.editor, editor);
  assert.equal(composer.composeKind, 'tasks');
  assert.equal(composer.editor.text, 'a\n\nb');
  assert.equal(composer.editor.cursor, 3);
});

test('newline and line movement', () => {
  const editor = new Editor('ab');
  editor.home();
  editor.end();
  assert.equal(editor.cursor, 2);
  editor.insert('\n');
  editor.insert('cd');
  assert.equal(editor.text, 'ab\ncd');
  editor.moveLine(-1);
  assert.equal(editor.linePos().line, 0);
  editor.moveLine(1);
  assert.equal(editor.linePos().line, 1);
});

test('moveLine with width follows visual wrap', () => {
  const editor = new Editor('hello world');
  editor.home();
  assert.equal(editor.cursor, 0);
  editor.moveLine(1, 8);
  assert.equal(editor.cursor, 6);
  editor.moveLine(-1, 8);
  assert.equal(editor.cursor, 0);
  editor.end();
  editor.moveLine(-1, 8);
  assert.equal(editor.cursor, 5);
  editor.moveLine(1, 8);
  assert.equal(editor.cursor, 11);
  editor.moveLine(-20, 8);
  assert.equal(editor.cursor, 5);
});

test('reveal keeps the cursor column on screen', () => {
  const editor = new Editor('abcdefghijklmnopqrstuvwxyz');
  editor.reveal(10);
  assert.equal(editor.scrollCol, 17);
  editor.move(-1);
  editor.reveal(10);
  assert.equal(editor.scrollCol, 17);
  editor.home();
  editor.reveal(10);
  assert.equal(editor.scrollCol, 0);
});

test('moveWord jumps by identifier', () => {
  const editor = new Editor('hello world.foo');
  editor.home();
  editor.moveWord(1);
  assert.equal(editor.cursor, 5);
  editor.moveWord(1);
  assert.equal(editor.cursor, 11);
  editor.moveWord(1);
  assert.equal(editor.cursor, 15);
  editor.moveWord(1);
  assert.equal(editor.cursor, 15);
  editor.moveWord(-1);
  assert.equal(editor.cursor, 12);
  editor.moveWord(-1);
  assert.equal(editor.cursor, 6);
  editor.moveWord(-1);
  assert.equal(editor.cursor, 0);
});

test('backspaceWord deletes the previous word', () => {
  const editor = new Editor('hello world');
  editor.backspaceWord();
  assert.equal(editor.text, 'hello ');
  assert.equal(editor.cursor, 6);
  editor.backspaceWord();
  assert.equal(editor.text, '');
  assert.equal(editor.cursor, 0);
});

test('copy takes the character under the caret after shift-right', () => {
  const editor = new Editor('hello world');
  editor.place(0);
  editor.move(3, true);
  assert.equal(editor.selectedText(), 'hel');
  assert.equal(editor.copiedText(), 'hell');
  editor.move(-1, true);
  assert.equal(editor.copiedText(), 'hel');
  editor.end();
  editor.move(-2, true);
  assert.equal(editor.copiedText(), 'ld');
  editor.place(0);
  editor.move(11, true);
  assert.equal(editor.copiedText(), 'hello world');
});

test('wordSpan takes the run around an offset, lineSpan the line', () => {
  const editor = new Editor('foo_bar, baz  qux\nnext line');
  assert.deepEqual(editor.wordSpan(0), { lo: 0, hi: 7 });
  assert.deepEqual(editor.wordSpan(7), { lo: 7, hi: 8 });
  assert.deepEqual(editor.wordSpan(9), { lo: 9, hi: 12 });
  assert.deepEqual(editor.wordSpan(12), { lo: 12, hi: 14 });
  assert.deepEqual(editor.wordSpan(17), { lo: 17, hi: 18 });
  assert.deepEqual(editor.wordSpan(19), { lo: 18, hi: 22 });
  assert.deepEqual(editor.wordSpan(26), { lo: 23, hi: 27 });
  assert.deepEqual(new Editor('').wordSpan(0), { lo: 0, hi: 0 });
  assert.deepEqual(editor.lineSpan(3), { lo: 0, hi: 17 });
  assert.deepEqual(editor.lineSpan(17), { lo: 0, hi: 17 });
  assert.deepEqual(editor.lineSpan(18), { lo: 18, hi: 27 });
  assert.deepEqual(new Editor('\nab').lineSpan(0), { lo: 0, hi: 0 });
  editor.selectSpan(editor.wordSpan(9));
  assert.equal(editor.selectedText(), 'baz');
  assert.equal(editor.copiedText(), 'baz');
  editor.selectSpan({ lo: 2, hi: 2 });
  assert.equal(editor.hasSelect(), false);
});

test('a mouse selection copies exactly what it selects', () => {
  const editor = new Editor('hello world');
  editor.place(0);
  editor.anchor = 0;
  editor.cursor = 5;
  assert.equal(editor.copiedText(), 'hello');
  editor.move(2, true);
  assert.equal(editor.copiedText(), 'hello w');
});

test('cut removes what copy takes', (t) => {
  const editor = new Editor('hello world');
  editor.place(0);
  editor.move(5, true);
  const ui = { status: '', stdout: {} };
  const copy = t.mock.method(clipboard, 'copyText', () => true);
  lineKey(editor, 'ctrl-x', ui, true);
  assert.equal(copy.mock.calls[0].arguments[0], 'hello ');
  assert.equal(editor.text, 'world');
});

test('shift movement selects and edits replace the span', () => {
  const editor = new Editor('hello');
  editor.move(-2, true);
  assert.equal(editor.selectedText(), 'lo');
  editor.move(-1);
  assert.equal(editor.cursor, 3);
  assert.equal(editor.anchor, null);
  editor.move(2, true);
  editor.backspace();
  assert.equal(editor.text, 'hel');
  editor.undoEdit();
  assert.equal(editor.text, 'hello');
  assert.equal(editor.selectedText(), 'lo');
  editor.insert('X');
  assert.equal(editor.text, 'helX');
  assert.equal(editor.anchor, null);
  editor.end();
  editor.home(true);
  assert.equal(editor.selectedText(), 'helX');
  editor.place(1);
  assert.equal(editor.cursor, 1);
  assert.equal(editor.anchor, null);
  editor.home(true);
  editor.home();
  assert.equal(editor.cursor, 0);
  assert.equal(editor.anchor, null);
});
