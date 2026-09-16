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

const STATE_FIELDS = [
  'editor',
  'composeKind',
  'commitKind',
  'composeTodoId',
  'composeBaseline',
  'templateIndex',
  'templateFocus',
  'blinkOn',
];

const initialState = () => ({
  editor: null,
  composeKind: null,
  commitKind: null,
  composeTodoId: null,
  composeBaseline: '',
  templateIndex: -1,
  templateFocus: false,
  blinkOn: true,
});

const attachState = (target, state) => {
  for (const key of STATE_FIELDS) {
    Object.defineProperty(target, key, {
      configurable: true,
      enumerable: true,
      get: () => state[key],
      set: (value) => {
        state[key] = value;
      },
    });
  }
};

const reset = (state) => {
  const next = initialState();
  for (const key of STATE_FIELDS) state[key] = next[key];
};

const resetBlink = (api) => {
  api.state.blinkOn = true;
  api.options.restartBlink();
};

const tickBlink = (api) => {
  if (!api.state.composeKind) return;
  api.state.blinkOn = !api.state.blinkOn;
  api.options.draw();
};

const openCompose = (api, kind, text, todoId) => {
  const { state, options } = api;
  options.setMode('compose');
  state.composeKind = kind;
  state.composeTodoId = todoId ?? null;
  state.composeBaseline = text;
  state.editor = new Editor(text);
  state.templateIndex = -1;
  state.templateFocus = false;
  options.setStatus('');
  options.nav.clearSelection();
  resetBlink(api);
};

const closeCompose = (api) => {
  const { state, options } = api;
  options.setMode('review');
  state.editor = null;
  state.composeKind = null;
  state.commitKind = null;
  state.composeTodoId = null;
  state.composeBaseline = '';
  state.templateIndex = -1;
  state.templateFocus = false;
  options.afterClose();
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

const commitFeedback = (api, text) => {
  const item = api.options.currentItem();
  if (!item || isTodoItem(item)) return;
  const notes = api.options.getNotes();
  setFeedback(notes, itemFeedKey(item), itemNote(item, text));
};

const commitCode = (api, text) => {
  const item = api.options.currentItem();
  if (!canEditCode(item)) return;
  const original = blockAddText(item.hunk, item.blockId);
  const notes = api.options.getNotes();
  const key = itemFeedKey(item);
  const note = itemNote(item, text);
  if (text === original) {
    setCode(notes, key, { ...note, clear: true });
    return;
  }
  setCode(notes, key, note);
};

const commitCompose = (api) => {
  const { state, options } = api;
  if (!state.composeKind || !state.editor || !options.getNotes()) return;
  const text = state.editor.text;
  if (state.composeKind === 'feedback') commitFeedback(api, text);
  if (state.composeKind === 'todo') api.todos.commitTodo(text);
  if (state.composeKind === 'code') commitCode(api, text);
};

const saveCompose = (api, extra) => {
  const opts = extra ?? {};
  const spec = KIND[api.state.composeKind];
  if (spec && spec.command) return { kind: spec.command };
  const kind = api.state.composeKind;
  const baseline = api.state.composeBaseline;
  commitCompose(api);
  if (kind === 'feedback') {
    const notes = api.options.getNotes();
    const editor = api.state.editor;
    const next = editor ? editor.text : '';
    if (notes) rememberTemplate(notes, baseline, next);
  }
  api.options.flushReview();
  closeCompose(api);
  api.options.setStatus('saved');
  if (opts.editNext === true) api.todos.editNextTodo();
  return { kind: 'saved' };
};

const autosave = (api) => {
  const { state, options } = api;
  const spec = KIND[state.composeKind];
  const text = state.editor ? state.editor.text : '';
  const editingCode = state.composeKind === 'code';
  const composing = state.composeKind !== null;
  const reviewKind = composing && (!spec || !spec.command);
  if (reviewKind && (editingCode || text.trim())) commitCompose(api);
  const notes = options.getNotes();
  if (notes && notes.dirty) options.flushReview();
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
  const item = api.options.currentItem();
  if (!canEditCode(item)) return null;
  const { state } = api;
  if (state.composeKind === 'code' && state.editor) return state.editor.text;
  const notes = api.options.getNotes();
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
  const notes = api.options.getNotes();
  if (!notes) return '';
  if (api.state.composeKind) return '';
  const item = api.options.currentItem();
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
  const size = api.options.getViewSize();
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
    const size = api.options.getViewSize();
    const inner = todoBodyWidth(size.width);
    api.todos.moveTodoCompose(delta, inner);
    return;
  }
  if (move === 'code') {
    const size = api.options.getViewSize();
    const inner = codeInnerWidth(size.width, api.options.getLayout());
    api.state.editor.moveLine(delta, inner);
    return;
  }
  moveNoteLine(api, delta);
};

const composePageStep = (api) => {
  const frame = api.options.lastFrame ? api.options.lastFrame() : null;
  const size = api.options.getViewSize();
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
  if (api.options.nav.pane === 'files') {
    api.options.setStatus('not a diff block');
    return;
  }
  const item = api.options.currentItem();
  if (!item || isTodoItem(item)) {
    api.options.setStatus('not a diff block');
    return;
  }
  const notes = api.options.getNotes();
  const prev = notes.feedback.get(itemFeedKey(item));
  const text = prev ? prev.text : '';
  openCompose(api, 'feedback', text);
};

const onCode = (api) => {
  if (api.options.nav.pane === 'files') {
    api.options.setStatus('not a diff block');
    return;
  }
  const item = api.options.currentItem();
  if (!canEditCode(item)) {
    api.options.setStatus('not a diff block');
    return;
  }
  const notes = api.options.getNotes();
  const prev = notes.code.get(itemFeedKey(item));
  const original = blockAddText(item.hunk, item.blockId);
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
    api.options.setStatus('');
    return null;
  }
  return saveCompose(api);
};

const COMPOSE_SPECIAL = {
  backspace: (api) => api.state.editor.backspace(),
  delete: (api) => api.state.editor.delete(),
  left: (api) => api.state.editor.move(-1),
  right: (api) => api.state.editor.move(1),
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
  commitCode: (text) => commitCode(api, text),
  saveCompose: (opts) => saveCompose(api, opts),
  autosave: () => autosave(api),
  composeView: () => composeView(api),
  liveCodeText: () => liveCodeText(api),
  codeOverlayView: () => codeOverlayView(api),
  idleNoteText: () => idleNoteText(api),
  composeTab: () => composeTab(api),
  moveComposeLine: (delta) => moveComposeLine(api, delta),
  resetBlink: () => resetBlink(api),
  tickBlink: () => tickBlink(api),
  onFeedback: () => onFeedback(api),
  onCode: () => onCode(api),
  handleKey: (key) => handleKey(api, key),
});

const createComposer = (options) => {
  const state = initialState();
  const api = { options, state };
  api.open = (kind, text, todoId) => openCompose(api, kind, text, todoId);
  api.close = () => closeCompose(api);
  api.commit = () => commitCompose(api);
  api.save = (opts) => saveCompose(api, opts);
  api.resetBlink = () => resetBlink(api);
  api.templates = createTemplatePick(api);
  api.todos = createTodoCompose(api);
  const composer = {
    ...composerMethods(api),
    ...api.todos,
    ...api.templates,
  };
  attachState(composer, state);
  return composer;
};

module.exports = {
  COMPOSE_EDITS,
  COMPOSE_LEAVE,
  KIND,
  createComposer,
};
