'use strict';

const chrome = require('./render/chrome.js');
const notes = require('./render/notes.js');
const diff = require('./render/diff.js');
const present = require('./render/present.js');
const { renderFrame } = require('./render/frame.js');

const { QUIT_PROMPT, COMMIT_PROMPT, PUSH_PROMPT } = chrome;
const { updatePrompt, dropPrompt } = chrome;
const { formatBusyStatus, headerText, layoutButtons } = chrome;
const { DEL_CHAR_BG, ADD_CHAR_BG, paintDiffLine, codeInnerWidth } = diff;
const { todoInnerWidth, todoBodyWidth, noteInnerWidth } = notes;
const { presentCursor, presentRows } = present;

module.exports = {
  QUIT_PROMPT,
  COMMIT_PROMPT,
  PUSH_PROMPT,
  updatePrompt,
  dropPrompt,
  DEL_CHAR_BG,
  ADD_CHAR_BG,
  paintDiffLine,
  headerText,
  layoutButtons,
  todoInnerWidth,
  todoBodyWidth,
  noteInnerWidth,
  codeInnerWidth,
  formatBusyStatus,
  renderFrame,
  presentCursor,
  presentRows,
};
