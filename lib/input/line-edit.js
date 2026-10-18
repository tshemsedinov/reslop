'use strict';

const { Editor } = require('./editor.js');
const { isTextKey, isNewlineKey } = require('./keys.js');
const clipboard = require('../term/clipboard.js');

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

const LINE_OP = {
  ...EDIT_OP,
  'ctrl-x': cutLine,
  'ctrl-v': (editor, ui, multiline) => pasteLine(editor, multiline),
};

const END_OP = {
  home: (editor) => editor.home(),
  end: (editor) => editor.end(),
  'shift-home': (editor) => editor.home(true),
  'shift-end': (editor) => editor.end(true),
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

const lineField = (name, text = '') => {
  const editor = new Editor(text);
  return {
    editor,
    get [name]() {
      return editor.text;
    },
  };
};

module.exports = { EDIT_OP, copyLine, cutLine, lineKey, lineField };
