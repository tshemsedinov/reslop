'use strict';

const path = require('node:path');

const files = require('../files.js');
const { fileEntries, REPO_TODOS_LABEL } = files;
const review = require('../review.js');
const { noteCounts } = review;

const SOURCE_KIND = {
  'github-pr': 'pr',
  'gitlab-mr': 'mr',
};

const relabelStatus = (entries, from, to) => {
  if (!to) return entries;
  return entries.map((entry) => {
    if (entry.status !== from) return entry;
    return { ...entry, status: to };
  });
};

const repoNameOf = (api) => {
  const named = api.options.repoName();
  if (named) return named;
  return path.basename(api.options.top() || api.options.cwd() || '');
};

const todosEntry = (api) => {
  const counts = noteCounts(api.options.notes());
  return {
    path: REPO_TODOS_LABEL,
    kind: 'todos',
    status: 'todos',
    remaining: counts.todo,
    staged: counts.todoDone,
    firstIndex: 0,
    openIndex: 0,
    added: 0,
    removed: 0,
    unstaged: 0,
  };
};

const fileList = (api) => {
  const entries = fileEntries(api.options.items());
  const sourceLabel = api.options.sourceLabel();
  let labeled = relabelStatus(entries, 'commit', api.options.revShort());
  if (sourceLabel) {
    labeled = relabelStatus(entries, 'pr', sourceLabel);
  }
  return [todosEntry(api), ...labeled];
};

const counts = (api) => {
  const next = {
    staged: 0,
    unstaged: 0,
    untracked: 0,
    commit: 0,
    pr: 0,
    todo: 0,
    feedback: 0,
    code: 0,
  };
  for (const item of api.options.items()) {
    if (!Object.hasOwn(next, item.origin)) continue;
    next[item.origin] += 1;
  }
  const note = noteCounts(api.options.notes());
  next.feedback = note.feedback;
  next.todo = note.todo;
  next.code = note.code;
  return next;
};

const viewStatus = (api) => api.options.status() || api.options.busy();

const view = (api) => {
  const { options } = api;
  const composer = options.composer;
  const nav = options.nav;
  const templates = composer.shownTemplates();
  const change = options.change();
  const sourceKind = (change && SOURCE_KIND[change.source]) || '';
  return {
    item: options.current(),
    index: nav.index,
    total: options.items().length,
    scroll: nav.scroll,
    listScroll: nav.listScroll,
    status: viewStatus(api),
    progressFrame: options.progressFrame(),
    layout: options.layout(),
    counts: counts(api),
    selection: nav.selection,
    pane: nav.pane,
    files: fileList(api),
    fileCursor: nav.fileCursor,
    reviewPath: nav.reviewPath,
    branch: options.branch(),
    branches: options.branches(),
    branchCursor: nav.branchCursor,
    repoName: repoNameOf(api),
    revShort: options.revShort() || '',
    sourceLabel: options.sourceLabel() || '',
    sourceKind,
    mode: options.mode(),
    compose: composer.composeView(),
    noteText: composer.idleNoteText(),
    todos: composer.todoTexts(),
    todoFocus: composer.clampedTodoFocus(),
    todoEdit: composer.todoEditView(),
    codeOverlay: composer.codeOverlayView(),
    templates,
    templateIndex: composer.clampedTemplateIndex(templates),
    updateFrom: options.updateFrom(),
    updateTo: options.updateTo(),
    dropName: options.dropName(),
  };
};

const createView = (options) => {
  const api = { options };
  return {
    repoNameOf: () => repoNameOf(api),
    todosEntry: () => todosEntry(api),
    fileList: () => fileList(api),
    counts: () => counts(api),
    viewStatus: () => viewStatus(api),
    view: () => view(api),
  };
};

module.exports = { SOURCE_KIND, relabelStatus, createView };
