'use strict';

const createStore = (reviewPath, templates = []) => ({
  reviewPath,
  dirty: false,
  nextTodoId: 1,
  feedback: new Map(),
  code: new Map(),
  todos: [],
  templates: [...templates],
  status: 'editing',
});

const noteCounts = (store) => {
  const counts = { feedback: 0, todo: 0, todoDone: 0, code: 0 };
  if (!store) return counts;
  for (const todo of store.todos) {
    if (!todo.text.trim()) continue;
    counts.todo += 1;
    if (todo.done) counts.todoDone += 1;
  }
  for (const note of store.feedback.values()) {
    if (note.text.trim()) counts.feedback += 1;
  }
  counts.code = store.code.size;
  return counts;
};

const hasNotes = (store) => {
  const counts = noteCounts(store);
  return counts.feedback > 0 || counts.todo > 0 || counts.code > 0;
};

const setFeedback = (store, key, note) => {
  const text = note.text ?? '';
  const trimmed = text.trim();
  const prev = store.feedback.get(key);
  if (!trimmed) {
    if (!prev) return;
    store.feedback.delete(key);
    store.dirty = true;
    return;
  }
  if (prev && prev.text === text) return;
  store.feedback.set(key, {
    file: note.file,
    oldStart: note.oldStart ?? 0,
    newStart: note.newStart ?? 0,
    blockId: note.blockId ?? 0,
    origin: note.origin ?? '',
    header: note.header ?? '',
    text,
    done: note.done ?? prev?.done ?? false,
  });
  store.dirty = true;
};

const setCode = (store, key, note) => {
  const prev = store.code.get(key);
  if (note.clear) {
    if (!prev) return;
    store.code.delete(key);
    store.dirty = true;
    return;
  }
  const text = note.text ?? '';
  if (prev && prev.text === text) return;
  store.code.set(key, {
    file: note.file,
    oldStart: note.oldStart ?? 0,
    newStart: note.newStart ?? 0,
    blockId: note.blockId ?? 0,
    origin: note.origin ?? '',
    header: note.header ?? '',
    text,
    done: note.done ?? prev?.done ?? false,
  });
  store.dirty = true;
};

const addTodo = (store, file, text = '') => {
  const id = store.nextTodoId;
  store.nextTodoId += 1;
  const todo = { id, file, text, done: false };
  store.todos.push(todo);
  store.dirty = true;
  return todo;
};

const removeTodo = (store, id) => {
  const next = [];
  let found = false;
  for (const todo of store.todos) {
    if (todo.id === id) {
      found = true;
      continue;
    }
    next.push(todo);
  }
  if (!found) return false;
  store.todos = next;
  store.dirty = true;
  return true;
};

const setTodoText = (store, id, text) => {
  const i = store.todos.findIndex((todo) => todo.id === id);
  if (i < 0) return;
  const prev = store.todos[i];
  const trimmed = text.trim();
  if (!trimmed) {
    removeTodo(store, id);
    return;
  }
  if (prev.text === text) return;
  store.todos[i] = { id: prev.id, file: prev.file, text, done: prev.done };
  store.dirty = true;
};

const checkLabel = (text, done) => {
  const mark = done ? 'x' : ' ';
  return `[${mark}] ${text}`;
};

const feedbackKey = (note) => {
  const file = note.file ?? '';
  const oldStart = note.oldStart ?? 0;
  const newStart = note.newStart ?? 0;
  const block = note.blockId ?? 0;
  return `${file}:${oldStart}:${newStart}:${block}`;
};

const applyImportedNotes = (store, imported) => {
  if (!store || !imported) return;
  const feedbacks = imported.feedback ?? [];
  for (const note of feedbacks) {
    const key = feedbackKey(note);
    const prev = store.feedback.get(key);
    const text = prev ? `${prev.text}\n\n${note.text}` : note.text;
    const done = prev ? prev.done && !!note.done : !!note.done;
    setFeedback(store, key, {
      file: note.file,
      oldStart: note.oldStart ?? 0,
      newStart: note.newStart ?? 0,
      blockId: note.blockId ?? 0,
      origin: note.origin ?? '',
      header: note.header ?? '',
      text,
      done,
    });
  }
  const todos = imported.todos ?? [];
  for (const todo of todos) {
    const added = addTodo(store, todo.file || '', todo.text ?? '');
    if (todo.done) added.done = true;
  }
};

const setStatus = (store, status) => {
  if (!store) return;
  store.status = status;
  store.dirty = true;
};

module.exports = {
  createStore,
  noteCounts,
  hasNotes,
  setFeedback,
  setCode,
  addTodo,
  removeTodo,
  setTodoText,
  checkLabel,
  feedbackKey,
  applyImportedNotes,
  setStatus,
};
