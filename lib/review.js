'use strict';

const store = require('./review/store.js');
const format = require('./review/format.js');
const templates = require('./review/templates.js');
const storage = require('./review/storage.js');

const { createStore, noteCounts, hasNotes } = store;
const { setFeedback, setCode, addTodo, removeTodo } = store;
const { setTodoText, checkLabel, feedbackKey, applyImportedNotes } = store;
const { parseFrontmatterStatus, serializeReview, parseReview } = format;
const { TEMPLATE_SHOW, rankedTemplates, prefixTemplates } = templates;
const { upsertTemplate, rememberTemplate } = templates;
const { AUTOSAVE_MS, allocateReviewPath, listReviewNames } = storage;
const { latestReviewName, resolveReviewPath } = storage;
const { loadReview, loadTemplates, flushReview } = storage;

module.exports = {
  TEMPLATE_SHOW,
  AUTOSAVE_MS,
  allocateReviewPath,
  listReviewNames,
  latestReviewName,
  parseFrontmatterStatus,
  resolveReviewPath,
  rankedTemplates,
  prefixTemplates,
  upsertTemplate,
  createStore,
  noteCounts,
  hasNotes,
  rememberTemplate,
  setFeedback,
  setCode,
  addTodo,
  removeTodo,
  setTodoText,
  checkLabel,
  feedbackKey,
  applyImportedNotes,
  serializeReview,
  parseReview,
  loadReview,
  loadTemplates,
  flushReview,
};
