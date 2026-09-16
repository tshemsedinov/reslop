'use strict';

const files = require('../files.js');
const { itemPath, isTodoItem, isTodosEntry } = files;
const { bindAccessors } = require('./accessors.js');

const STATE_FIELDS = [
  'pane',
  'index',
  'fileCursor',
  'branchCursor',
  'scroll',
  'listScroll',
  'reviewPath',
  'selection',
  'mouseAnchor',
  'pendingClick',
  'dragging',
  'todoOpen',
  'todoFocus',
];

const initialState = (options = {}) => ({
  pane: options.startPane ?? 'files',
  index: 0,
  fileCursor: 0,
  branchCursor: 0,
  scroll: 0,
  listScroll: 0,
  reviewPath: null,
  selection: null,
  mouseAnchor: null,
  pendingClick: null,
  dragging: false,
  todoOpen: false,
  todoFocus: 0,
});

const reset = (state, startPane) => {
  state.pane = startPane ?? state.pane;
  state.index = 0;
  state.fileCursor = 0;
  state.branchCursor = 0;
  state.scroll = 0;
  state.listScroll = 0;
  state.reviewPath = null;
  state.selection = null;
  state.mouseAnchor = null;
  state.pendingClick = null;
  state.dragging = false;
  state.todoOpen = false;
  state.todoFocus = 0;
};

const clampIndex = (state, length) => {
  if (!length) {
    state.index = 0;
    return;
  }
  if (state.index < 0) state.index = 0;
  if (state.index >= length) state.index = length - 1;
};

const current = (state, items, todoItem) => {
  if (state.todoOpen) return todoItem;
  return items[state.index] ?? null;
};

const syncReviewPath = (state, item) => {
  if (state.pane !== 'diff') return;
  state.reviewPath = item ? itemPath(item) : null;
};

const clampFileCursor = (state, length) => {
  if (!length) {
    state.fileCursor = 0;
    return;
  }
  if (state.fileCursor >= length) state.fileCursor = length - 1;
};

const followReviewPath = (state, fileList, item) => {
  if (!fileList.length) {
    state.fileCursor = 0;
    return;
  }
  let idx = fileList.findIndex(
    (entry) => !isTodosEntry(entry) && entry.path === state.reviewPath,
  );
  if (isTodoItem(item)) {
    idx = fileList.findIndex((entry) => isTodosEntry(entry));
  }
  if (idx >= 0) {
    state.fileCursor = idx;
    return;
  }
  clampFileCursor(state, fileList.length);
};

const clearSelection = (state) => {
  state.selection = null;
  state.mouseAnchor = null;
  state.dragging = false;
  state.pendingClick = null;
};

const selectItem = (state, index) => {
  state.index = index;
  state.scroll = 0;
};

const createNavigation = (options = {}) => {
  const state = initialState(options);
  const nav = {
    reset: (startPane) => reset(state, startPane),
    clampIndex: (length) => clampIndex(state, length),
    current: (items, todoItem) => current(state, items, todoItem),
    syncReviewPath: (item) => syncReviewPath(state, item),
    clampFileCursor: (length) => clampFileCursor(state, length),
    followReviewPath: (list, item) => followReviewPath(state, list, item),
    clearSelection: () => clearSelection(state),
    selectItem: (index) => selectItem(state, index),
  };
  bindAccessors(nav, state, STATE_FIELDS);
  return nav;
};

module.exports = { createNavigation };
