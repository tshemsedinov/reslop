'use strict';

const { TaskItem, taskLines } = require('../review/task.js');
const { isEditable } = require('./task-rows.js');

// The keys that act on the edited block of the tasks screen: ctrl+d ticks,
// and Backspace drops the block once there is no text left for it

// Ticks or clears the check on the cursor line of a task's text
const tickCheckLine = (editor) => {
  const item = new TaskItem(taskLines(editor.text, false));
  const at = editor.linePos().line;
  const index = item.checks.findIndex((check) => check.line === at);
  if (index < 0) return false;
  const lines = item.setCheck(index, !item.checks[index].done);
  editor.edit(new TaskItem(lines).text, editor.cursor);
  return true;
};

// ctrl+d marks the edited task done or not; on a check line it ticks the
// check in the text
const toggleDone = (page) => {
  const editor = page.composing() ? page.composer.editor : null;
  if (editor && tickCheckLine(editor)) return;
  page.closeEditor();
  page.toggleFocusedTask();
};

// Backspace in an empty block drops it and goes on at the end of the
// block above; a heading with blocks under it asks first
const dropBlock = (page) => {
  const editor = page.composer.editor;
  const row = page.focusedRow();
  if (!editor || !row || editor.text) return false;
  page.composer.dropEditor();
  if (row.draft) return true;
  if (!isEditable(row) || !row.block) return false;
  const at = page.clampedTaskFocus();
  page.removeFocusedTask();
  page.ui.status = '';
  if (page.rowAt(at)?.block !== row.block) {
    page.nav.tasksFocus = Math.max(0, at - 1);
  }
  page.enterAt = 'end';
  return true;
};

module.exports = { dropBlock, toggleDone };
