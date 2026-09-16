'use strict';

const files = require('../files.js');
const { isTodosEntry, TODO_FILE } = files;
const review = require('../review.js');
const { addTodo, setTodoText, removeTodo, checkLabel } = review;

const TODO_TYPE_SKIP = [
  'enter',
  'escape',
  'tab',
  'backspace',
  'delete',
  'left',
  'right',
  'up',
  'down',
  'home',
  'end',
  'pageUp',
  'pageDown',
  'j',
  'k',
  'n',
  'p',
  'q',
];

const isTodoTypeKey = (key) => {
  if (!key) return false;
  if (TODO_TYPE_SKIP.includes(key)) return false;
  if (key.startsWith('ctrl-')) return false;
  if (key.startsWith('alt-')) return false;
  return key.charCodeAt(0) >= 32;
};

const listTodos = (api) => {
  const notes = api.options.getNotes();
  if (!notes) return [];
  return notes.todos;
};

const isDraftCompose = (api) => {
  const { state } = api;
  return state.composeKind === 'todo' && state.composeTodoId === null;
};

const todoTexts = (api) => {
  const nav = api.options.nav;
  if (!nav.todoOpen) return [];
  const texts = [];
  const { state } = api;
  const editingTodo = state.composeKind === 'todo';
  const editingId = editingTodo ? state.composeTodoId : null;
  for (const todo of listTodos(api)) {
    const live = editingId === todo.id && state.editor;
    const text = live ? state.editor.text : todo.text;
    texts.push(checkLabel(text, todo.done));
  }
  const draft = isDraftCompose(api) && state.editor ? state.editor.text : '';
  texts.push(checkLabel(draft, false));
  return texts;
};

const todoRowCount = (api) => {
  if (!api.options.nav.todoOpen) return 0;
  return listTodos(api).length + 1;
};

const clampedTodoFocus = (api) => {
  const last = Math.max(0, todoRowCount(api) - 1);
  const focus = api.options.nav.todoFocus;
  if (focus < 0) return 0;
  if (focus > last) return last;
  return focus;
};

const focusedTodo = (api) => {
  if (!api.options.nav.todoOpen) return null;
  const todos = listTodos(api);
  return todos[clampedTodoFocus(api)] ?? null;
};

const moveTodoFocus = (api, delta) => {
  const nav = api.options.nav;
  if (!nav.todoOpen) return;
  const n = todoRowCount(api);
  if (!n) return;
  const next = clampedTodoFocus(api) + delta;
  if (next < 0) nav.todoFocus = 0;
  else if (next >= n) nav.todoFocus = n - 1;
  else nav.todoFocus = next;
};

const openTodoPage = (api) => {
  const nav = api.options.nav;
  nav.todoOpen = true;
  nav.pane = 'diff';
  nav.scroll = 0;
  nav.clearSelection();
  api.options.syncReviewPath();
};

const closeTodoPage = (api) => {
  api.options.nav.todoOpen = false;
  api.options.syncReviewPath();
  api.options.syncFileCursor();
};

const focusTodoPage = (api, todoId) => {
  openTodoPage(api);
  const todos = listTodos(api);
  let focus = 0;
  if (todoId === null) {
    focus = todos.length;
  } else if (todoId !== undefined) {
    const at = todos.findIndex((todo) => todo.id === todoId);
    if (at >= 0) focus = at;
    else if (todos.length) focus = todos.length - 1;
  }
  api.options.nav.todoFocus = focus;
  api.options.nav.scroll = 0;
  return true;
};

const startDraftCompose = (api) => {
  focusTodoPage(api, null);
  api.open('todo', '', null);
};

const editFocusedTodo = (api) => {
  if (!api.options.nav.todoOpen) return;
  const todos = listTodos(api);
  const todo = todos[clampedTodoFocus(api)];
  if (!todo) {
    startDraftCompose(api);
    return;
  }
  api.open('todo', todo.text, todo.id);
};

const editNextTodo = (api) => {
  if (!api.options.nav.todoOpen) return;
  const last = todoRowCount(api) - 1;
  const next = clampedTodoFocus(api) + 1;
  if (next <= last) api.options.nav.todoFocus = next;
  editFocusedTodo(api);
};

const moveTodoCompose = (api, delta) => {
  if (!api.options.nav.todoOpen) return;
  const last = todoRowCount(api) - 1;
  const at = clampedTodoFocus(api);
  let next = at + delta;
  if (next < 0) next = 0;
  if (next > last) next = last;
  if (next === at) return;
  api.commit();
  api.options.flushReview();
  api.close();
  const max = Math.max(0, todoRowCount(api) - 1);
  api.options.nav.todoFocus = Math.min(next, max);
  editFocusedTodo(api);
};

const typeIntoTodo = (api, key) => {
  const nav = api.options.nav;
  if (!nav.todoOpen) return false;
  if (nav.pane !== 'diff') return false;
  if (api.options.getMode() !== 'review') return false;
  if (!isTodoTypeKey(key)) return false;
  editFocusedTodo(api);
  api.state.editor.insert(key);
  api.resetBlink();
  return true;
};

const removeFocusedTodo = (api) => {
  const nav = api.options.nav;
  if (nav.pane !== 'diff' || !nav.todoOpen) return;
  const todos = listTodos(api);
  const todo = todos[clampedTodoFocus(api)];
  if (!todo) return;
  const notes = api.options.getNotes();
  removeTodo(notes, todo.id);
  const left = listTodos(api);
  if (nav.todoFocus >= left.length) {
    nav.todoFocus = Math.max(0, left.length - 1);
  }
  api.options.flushReview(true);
};

const onTodoHit = (api, cursor) => {
  if (!api.options.nav.todoOpen) return;
  const todos = listTodos(api);
  const draft = cursor === todos.length;
  const target = todos[cursor];
  if (!draft && !target) return;
  const { state } = api;
  if (state.composeKind === 'todo') {
    if (draft && state.composeTodoId === null) return;
    if (target && target.id === state.composeTodoId) return;
    api.commit();
    api.close();
  }
  api.options.nav.todoFocus = cursor;
  editFocusedTodo(api);
};

const createTodo = (api) => {
  startDraftCompose(api);
};

const onTodo = (api) => {
  const { options } = api;
  if (options.nav.pane === 'files') {
    const entry = options.fileCursorEntry();
    if (entry && !isTodosEntry(entry)) {
      options.nav.index = entry.openIndex ?? entry.firstIndex;
    }
  }
  createTodo(api);
};

const todoEditView = (api) => {
  const { state } = api;
  if (state.composeKind !== 'todo') return null;
  if (!state.editor) return null;
  return { cursor: state.editor.cursor };
};

const commitTodo = (api, text) => {
  const notes = api.options.getNotes();
  const id = api.state.composeTodoId;
  const todos = notes.todos;
  const prev = id === null ? null : todos.find((entry) => entry.id === id);
  if (prev) {
    setTodoText(notes, id, text);
    return;
  }
  if (!text.trim()) return;
  const todo = addTodo(notes, TODO_FILE, text);
  api.state.composeTodoId = todo.id;
};

const createTodoCompose = (api) => ({
  listTodos: () => listTodos(api),
  isDraftCompose: () => isDraftCompose(api),
  todoTexts: () => todoTexts(api),
  focusedTodo: () => focusedTodo(api),
  clampedTodoFocus: () => clampedTodoFocus(api),
  todoRowCount: () => todoRowCount(api),
  moveTodoFocus: (delta) => moveTodoFocus(api, delta),
  openTodoPage: () => openTodoPage(api),
  closeTodoPage: () => closeTodoPage(api),
  focusTodoPage: (todoId) => focusTodoPage(api, todoId),
  startDraftCompose: () => startDraftCompose(api),
  editFocusedTodo: () => editFocusedTodo(api),
  editNextTodo: () => editNextTodo(api),
  moveTodoCompose: (delta) => moveTodoCompose(api, delta),
  typeIntoTodo: (key) => typeIntoTodo(api, key),
  removeFocusedTodo: () => removeFocusedTodo(api),
  onTodoHit: (cursor) => onTodoHit(api, cursor),
  createTodo: () => createTodo(api),
  onTodo: () => onTodo(api),
  todoEditView: () => todoEditView(api),
  commitTodo: (text) => commitTodo(api, text),
});

module.exports = {
  TODO_TYPE_SKIP,
  isTodoTypeKey,
  createTodoCompose,
};
