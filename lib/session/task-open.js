'use strict';

const { TaskItem, taskLines } = require('../review/task.js');
const location = require('../review/location.js');
const { parseLocations, resolveLocation } = location;
const { showLocation } = require('./unit.js');

// The files a task points at, opened on the files screen; Escape comes back
// to the task. Anything outside the root, and every URL, is named in the
// status line and never opened.

const openFound = (page, found) => {
  const ui = page.ui;
  if (!found.ok) {
    ui.status = found.error;
    return;
  }
  page.closeEditor();
  ui.ops.hold(showLocation(ui, found));
};

// The first location in a `where` or `related` value
const openLocation = (page, text) => {
  const [first] = parseLocations(text);
  openFound(page, resolveLocation(page.ui.root, first));
};

// A feedback note or a code proposal: its file at its line
const openNote = (page) => {
  const row = page.focusedRow();
  if (!row || !(row.quote || row.type === 'code')) return false;
  const { file, newStart } = row.note;
  const found = resolveLocation(page.ui.root, { path: file, line: newStart });
  openFound(page, { ...found, symbol: '' });
  return true;
};

const LINK_KEYS = ['where', 'related'];

// The location on the cursor line of a `where` or `related` field, else
// the first one of that field
const cursorLocations = (editor) => {
  const item = new TaskItem(taskLines(editor.text, false));
  const at = editor.linePos().line;
  const field = item.fields.find(
    (one) => LINK_KEYS.includes(one.key) && at >= one.start && at < one.end,
  );
  if (!field) return '';
  const line = editor.text.split('\n')[at];
  return parseLocations(line).length ? line : field.value;
};

// ctrl+w: a note's diff, the location on the cursor line of the edited
// task, else the task's first `where`
const openFocused = (page) => {
  if (openNote(page)) return;
  const row = page.focusedRow();
  if (!row || row.type !== 'task') return;
  const editor = page.composing() ? page.composer.editor : null;
  const line = editor ? cursorLocations(editor) : '';
  const text = line || row.task.item.value('where');
  if (!parseLocations(text).length) {
    page.ui.status = 'no file to open';
    return;
  }
  openLocation(page, text);
};

module.exports = { openNote, openFocused };
