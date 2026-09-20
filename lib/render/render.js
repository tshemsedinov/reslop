'use strict';

const chrome = require('./chrome.js');
const notes = require('./notes.js');
const diff = require('./diff.js');
const present = require('./present.js');
const { renderFrame } = require('./frame.js');

const { QUIT_PROMPT, PUSH_PROMPT } = chrome;
const { updatePrompt, dropPrompt } = chrome;
const { formatBusyStatus, headerText, layoutButtons } = chrome;
const { DEL_CHAR_BG, ADD_CHAR_BG, paintDiffLine, codeInnerWidth } = diff;
const { todoInnerWidth, todoBodyWidth, noteInnerWidth } = notes;
const { presentCursor, presentRows } = present;

module.exports = {
  QUIT_PROMPT,
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
