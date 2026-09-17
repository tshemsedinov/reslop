'use strict';

const wrap = require('../wrap.js');
const { cursorInWrap, wrapDoc } = wrap;
const render = require('../render.js');
const { noteInnerWidth, codeInnerWidth, todoBodyWidth } = render;
const { Editor } = require('../editor.js');
const files = require('../files.js');
const { itemPath, isTodoItem } = files;
const { blockAddText } = require('../diff.js');
const items = require('./items.js');
const { itemFeedKey, canEditCode } = items;
const { isReadOnlyOrigin } = require('./origins.js');
const review = require('../review.js');
const { setFeedback, setCode, checkLabel, rememberTemplate } = review;
const { createTemplatePick } = require('./templates.js');
const { createTodoCompose } = require('./todos.js');

const COMPOSE_EDITS = ['backspace', 'delete', 'ctrl-z', 'ctrl-y'];
const COMPOSE_LEAVE = ['next', 'prev', 'todo'];

const KIND = {
  feedback: {
    enter: 'save',
    tab: 'template',
    escape: 'save',
    move: 'note',
    command: null,
    view: 'note',
  },
  code: {
    enter: 'newline',
    tab: 'insert-tab',
    escape: 'save',
    move: 'code',
    command: null,
    view: 'code',
  },
  todo: {
    enter: 'edit-next',
    tab: 'template',
    escape: 'save',
    move: 'todo',
    command: null,
    view: 'todo',
  },
  commit: {
    enter: 'save',
    tab: 'template',
    escape: 'cancel',
    move: 'note',
    command: 'commit',
    view: 'note',
  },
  branch: {
    enter: 'save',
    tab: 'template',
    escape: 'cancel',
    move: 'note',
    command: 'branch',
    view: 'note',
  },
};

const initialState = () => ({
  editor: null,
  composeKind: null,
  commitKind: null,
  composeTodoId: null,
  composeBaseline: '',
  templateIndex: -1,
  templateFocus: false,
  blinkOn: true,
  fileDirty: false,
});

const reset = (state) => {
  Object.assign(state, initialState());
};

const resetBlink = (api) => {
  api.state.blinkOn = true;
  api.restartBlink();
};

const tickBlink = (api) => {
  if (!api.state.composeKind) return;
  api.state.blinkOn = !api.state.blinkOn;
  api.ui.draw();
};

const viewSize = (api) => api.ui.lastSize ?? api.ui.getSize();

const afterClose = (api) => {
  api.ui.clampIndex();
  api.ui.syncReviewPath();
  api.ui.syncFileCursor();
};

const openCompose = (api, kind, text, todoId) => {
  const { state, ui, nav } = api;
  ui.mode = 'compose';
  state.composeKind = kind;
  state.composeTodoId = todoId ?? null;
  state.composeBaseline = text;
  state.editor = new Editor(text);
  state.templateIndex = -1;
  state.templateFocus = false;
  ui.status = '';
  nav.clearSelection();
  resetBlink(api);
};

const closeCompose = (api) => {
  const { state, ui } = api;
  ui.mode = 'review';
  state.editor = null;
  state.composeKind = null;
  state.commitKind = null;
  state.composeTodoId = null;
  state.composeBaseline = '';
  state.templateIndex = -1;
  state.templateFocus = false;
  afterClose(api);
};

const itemNote = (item, text) => {
  const hunk = item.hunk;
  return {
    file: itemPath(item),
    oldStart: hunk ? hunk.oldStart : 0,
    newStart: hunk ? hunk.newStart : 0,
    blockId: item.blockId ?? 0,
    origin: item.origin,
    header: hunk ? hunk.header : '',
    text,
  };
};

const writesCodeFile = (api, item) => {
  if (!canEditCode(item)) return false;
  const caps = api.ui.capabilities;
  if (!caps || caps.changes !== true) return false;
  if (isReadOnlyOrigin(item.origin)) return false;
  const repo = api.ui.repo;
  return !!(repo && typeof repo.edit === 'function');
};

const commitFeedback = (api, text) => {
  const item = api.ui.current();
  if (!item || isTodoItem(item)) return;
  const notes = api.review.store;
  setFeedback(notes, itemFeedKey(item), itemNote(item, text));
};

const dropCodeNote = (api, item, text) => {
  const notes = api.review.store;
  if (!notes) return;
  const key = itemFeedKey(item);
  if (!notes.code.has(key)) return;
  setCode(notes, key, { ...itemNote(item, text), clear: true });
};

const saveCodeNote = (api, item, text) => {
  const original = blockAddText(item.hunk, item.blockId);
  const notes = api.review.store;
  const key = itemFeedKey(item);
  const note = itemNote(item, text);
  if (text === original) {
    setCode(notes, key, { ...note, clear: true });
    return;
  }
  setCode(notes, key, note);
};

const saveCodeFile = (api, item, text) => {
  const original = blockAddText(item.hunk, item.blockId);
  if (text === original) {
    dropCodeNote(api, item, text);
    return true;
  }
  try {
    api.ui.repo.edit(api.ui.top, item, text);
  } catch (error) {
    api.ui.status = error.message;
    return false;
  }
  dropCodeNote(api, item, text);
  api.state.fileDirty = true;
  return true;
};

const commitCode = (api, text) => {
  const item = api.ui.current();
  if (!canEditCode(item)) return true;
  if (writesCodeFile(api, item)) return saveCodeFile(api, item, text);
  saveCodeNote(api, item, text);
  return true;
};

const commitCompose = (api) => {
  const { state } = api;
  if (!state.composeKind || !state.editor) return true;
  const text = state.editor.text;
  if (state.composeKind === 'feedback') {
    if (api.review.store) commitFeedback(api, text);
    return true;
  }
  if (state.composeKind === 'todo') {
    api.todos.commitTodo(text);
    return true;
  }
  if (state.composeKind === 'code') return commitCode(api, text);
  return true;
};

const saveCompose = (api, extra) => {
  const opts = extra ?? {};
  const spec = KIND[api.state.composeKind];
  if (spec && spec.command) return { kind: spec.command };
  const kind = api.state.composeKind;
  const baseline = api.state.composeBaseline;
  const result = commitCompose(api);
  if (result === false) return { kind: 'error' };
  const reload = api.state.fileDirty === true;
  if (kind === 'feedback') {
    const notes = api.review.store;
    const editor = api.state.editor;
    const next = editor ? editor.text : '';
    if (notes) rememberTemplate(notes, baseline, next);
  }
  api.ui.flushReview();
  closeCompose(api);
  if (reload && typeof api.ui.reloadAfterChange === 'function') {
    api.ui.reloadAfterChange();
  }
  api.ui.status = 'saved';
  if (opts.editNext === true) api.todos.editNextTodo();
  return { kind: 'saved' };
};

const autosave = (api) => {
  const { state } = api;
  const spec = KIND[state.composeKind];
  const text = state.editor ? state.editor.text : '';
  const editingCode = state.composeKind === 'code';
  const composing = state.composeKind !== null;
  const reviewKind = composing && (!spec || !spec.command);
  const liveItem = api.ui.current ? api.ui.current() : null;
  const fileEdit = editingCode && writesCodeFile(api, liveItem);
  if (reviewKind && !fileEdit && (editingCode || text.trim())) {
    commitCompose(api);
  }
  const notes = api.review.store;
  if (notes && notes.dirty) api.ui.flushReview();
};

const composeView = (api) => {
  const { state } = api;
  if (!state.composeKind || !state.editor) return null;
  const spec = KIND[state.composeKind];
  if (!spec || spec.view !== 'note') return null;
  const kind = state.composeKind;
  const text = state.editor.text;
  const cursor = state.editor.cursor;
  return { kind, text, cursor };
};

const liveCodeText = (api) => {
  const item = api.ui.current();
  if (!canEditCode(item)) return null;
  const { state } = api;
  if (state.composeKind === 'code' && state.editor) return state.editor.text;
  if (writesCodeFile(api, item)) return null;
  const notes = api.review.store;
  if (!notes) return null;
  const note = notes.code.get(itemFeedKey(item));
  if (!note) return null;
  return note.text;
};

const codeOverlayView = (api) => {
  const text = liveCodeText(api);
  if (text === null) return null;
  const editing = api.state.composeKind === 'code';
  const editor = api.state.editor;
  const cursor = editing && editor ? editor.cursor : null;
  return { text, keepEmpty: editing, cursor };
};

const idleNoteText = (api) => {
  const notes = api.review.store;
  if (!notes) return '';
  if (api.state.composeKind) return '';
  const item = api.ui.current();
  if (!item || isTodoItem(item)) return '';
  const note = notes.feedback.get(itemFeedKey(item));
  if (!note || !note.text.trim()) return '';
  return checkLabel(note.text, note.done);
};

const composeTab = (api) => {
  const spec = KIND[api.state.composeKind];
  if (spec && spec.tab === 'insert-tab') {
    api.state.editor.insert('\t');
    return null;
  }
  return api.templates.applyTemplate();
};

const moveTemplateLine = (api, delta, shown, width) => {
  const { state } = api;
  if (state.templateFocus) {
    let next = state.templateIndex + delta;
    if (next < 0) next = 0;
    if (next >= shown.length) next = shown.length - 1;
    if (next === state.templateIndex) {
      state.templateFocus = false;
      return true;
    }
    api.templates.focusTemplate(next, false);
    return true;
  }
  const pos = cursorInWrap(state.editor.text, state.editor.cursor, width);
  const last = wrapDoc(state.editor.text, width).length - 1;
  if (delta < 0 && pos.row === 0) {
    api.templates.focusTemplate(shown.length - 1, false);
    return true;
  }
  if (delta > 0 && pos.row === last) {
    api.templates.focusTemplate(0, false);
    return true;
  }
  return false;
};

const moveNoteLine = (api, delta) => {
  const size = viewSize(api);
  const width = noteInnerWidth(size.width);
  const shown = api.templates.shownTemplates();
  const feedback = api.state.composeKind === 'feedback';
  if (shown.length && feedback) {
    if (moveTemplateLine(api, delta, shown, width)) return;
  }
  api.state.editor.moveLine(delta, width);
};

const moveComposeLine = (api, delta) => {
  const spec = KIND[api.state.composeKind];
  const move = spec ? spec.move : 'note';
  if (move === 'todo') {
    const size = viewSize(api);
    const inner = todoBodyWidth(size.width);
    api.todos.moveTodoCompose(delta, inner);
    return;
  }
  if (move === 'code') {
    const size = viewSize(api);
    const inner = codeInnerWidth(size.width, api.ui.layout);
    api.state.editor.moveLine(delta, inner);
    return;
  }
  moveNoteLine(api, delta);
};

const composePageStep = (api) => {
  const frame = api.ui.lastFrame ?? null;
  const size = viewSize(api);
  const fallback = Math.max(1, (size.height ?? 24) - 4);
  return Math.max(1, frame?.bodyH ?? fallback);
};

const jumpComposeTemplates = (api, toEnd) => {
  if (!api.state.templateFocus) return false;
  const shown = api.templates.shownTemplates();
  if (!shown.length) return false;
  const index = toEnd ? shown.length - 1 : 0;
  api.templates.focusTemplate(index, false);
  return true;
};

const composeHome = (api) => {
  if (jumpComposeTemplates(api, false)) return;
  api.state.editor.home();
};

const composeEnd = (api) => {
  if (jumpComposeTemplates(api, true)) return;
  api.state.editor.end();
};

const moveComposePage = (api, dir) => {
  const step = composePageStep(api) * dir;
  moveComposeLine(api, step);
};

const onFeedback = (api) => {
  if (api.nav.pane === 'files') {
    api.ui.status = 'not a diff block';
    return;
  }
  const item = api.ui.current();
  if (!item || isTodoItem(item)) {
    api.ui.status = 'not a diff block';
    return;
  }
  const notes = api.review.store;
  const prev = notes.feedback.get(itemFeedKey(item));
  const text = prev ? prev.text : '';
  openCompose(api, 'feedback', text);
};

const onCode = (api) => {
  if (api.nav.pane === 'files') {
    api.ui.status = 'not a diff block';
    return;
  }
  const item = api.ui.current();
  if (!canEditCode(item)) {
    api.ui.status = 'not a diff block';
    return;
  }
  const original = blockAddText(item.hunk, item.blockId);
  const notes = api.review.store;
  const prev = writesCodeFile(api, item)
    ? null
    : notes.code.get(itemFeedKey(item));
  const text = prev ? prev.text : original;
  openCompose(api, 'code', text);
};

const enterCompose = (api) => {
  const { state } = api;
  if (state.templateFocus && state.composeKind === 'feedback') {
    return api.templates.selectTemplate(state.templateIndex);
  }
  const spec = KIND[state.composeKind];
  if (spec && spec.enter === 'newline') {
    state.editor.insert('\n');
    resetBlink(api);
    return null;
  }
  if (spec && spec.enter === 'edit-next') {
    return saveCompose(api, { editNext: true });
  }
  return saveCompose(api);
};

const leaveCompose = (api, key) => {
  const spec = KIND[api.state.composeKind];
  if (spec && spec.escape === 'cancel' && key === 'escape') {
    closeCompose(api);
    api.ui.status = '';
    return null;
  }
  return saveCompose(api);
};

const COMPOSE_SPECIAL = {
  backspace: (api) => api.state.editor.backspace(),
  delete: (api) => api.state.editor.delete(),
  left: (api) => api.state.editor.move(-1),
  right: (api) => api.state.editor.move(1),
  'ctrl-left': (api) => api.state.editor.moveWord(-1),
  'ctrl-right': (api) => api.state.editor.moveWord(1),
  up: (api) => moveComposeLine(api, -1),
  down: (api) => moveComposeLine(api, 1),
  home: (api) => composeHome(api),
  end: (api) => composeEnd(api),
  pageUp: (api) => moveComposePage(api, -1),
  pageDown: (api) => moveComposePage(api, 1),
  'ctrl-a': (api) => api.state.editor.home(),
  'ctrl-e': (api) => api.state.editor.end(),
  'ctrl-z': (api) => api.state.editor.undoEdit(),
  'ctrl-y': (api) => api.state.editor.redoEdit(),
  tab: (api) => composeTab(api),
};

const handleKey = (api, key) => {
  if (key === 'enter') return enterCompose(api);
  if (key === 'escape' || key === 'ctrl-s') return leaveCompose(api, key);
  const special = COMPOSE_SPECIAL[key];
  if (special) {
    const result = special(api);
    if (COMPOSE_EDITS.includes(key)) api.templates.clearTemplatePick();
    resetBlink(api);
    return result ?? null;
  }
  if (!key.length) return null;
  if (key.startsWith('ctrl-') || key.startsWith('alt-')) return null;
  if (key.charCodeAt(0) >= 32) {
    api.templates.clearTemplatePick();
    api.state.editor.insert(key);
    resetBlink(api);
  }
  return null;
};

const composerMethods = (api) => ({
  reset: () => reset(api.state),
  openCompose: (kind, text, todoId) => openCompose(api, kind, text, todoId),
  closeCompose: () => closeCompose(api),
  commitCompose: () => commitCompose(api),
  saveCompose: (opts) => saveCompose(api, opts),
  autosave: () => autosave(api),
  composeView: () => composeView(api),
  codeOverlayView: () => codeOverlayView(api),
  idleNoteText: () => idleNoteText(api),
  resetBlink: () => resetBlink(api),
  tickBlink: () => tickBlink(api),
  onFeedback: () => onFeedback(api),
  onCode: () => onCode(api),
  handleKey: (key) => handleKey(api, key),
});

const createComposer = ({ nav, review, ui, restartBlink }) => {
  const state = initialState();
  const api = { nav, review, ui, restartBlink, state };
  api.open = (kind, text, todoId) => openCompose(api, kind, text, todoId);
  api.close = () => closeCompose(api);
  api.commit = () => commitCompose(api);
  api.save = (opts) => saveCompose(api, opts);
  api.resetBlink = () => resetBlink(api);
  api.templates = createTemplatePick(api);
  api.todos = createTodoCompose(api);
  const composer = {
    state,
    ...composerMethods(api),
    ...api.todos,
    ...api.templates,
  };
  return composer;
};

module.exports = {
  COMPOSE_EDITS,
  COMPOSE_LEAVE,
  KIND,
  createComposer,
};
