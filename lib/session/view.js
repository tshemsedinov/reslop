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
  const { ui } = api;
  if (ui.repoName) return ui.repoName;
  return path.basename(ui.top || ui.cwd || '');
};

const todosEntry = (counts) => ({
  path: REPO_TODOS_LABEL,
  kind: 'todos',
  status: 'todos',
  remaining: counts.todo,
  staged: counts.todoDone,
  firstIndex: 0,
  openIndex: 0,
  added: 0,
  removed: 0,
  stagedAdded: 0,
  stagedRemoved: 0,
  unstagedAdded: 0,
  unstagedRemoved: 0,
  unstaged: 0,
});

const fileList = (api, notes = noteCounts(api.review.store)) => {
  const entries = fileEntries(api.collection.items);
  const sourceLabel = api.ui.sourceLabel;
  const from = sourceLabel ? 'pr' : 'commit';
  const to = sourceLabel || api.ui.revShort;
  const labeled = relabelStatus(entries, from, to);
  labeled.unshift(todosEntry(notes));
  return labeled;
};

const counts = (api, notes = noteCounts(api.review.store)) => {
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
  for (const item of api.collection.items) {
    if (!Object.hasOwn(next, item.origin)) continue;
    next[item.origin] += 1;
  }
  next.feedback = notes.feedback;
  next.todo = notes.todo;
  next.code = notes.code;
  return next;
};

const viewStatus = (api) => api.ui.status || api.ui.busy;

const view = (api) => {
  const { composer, nav, ui, gitBranches, updater } = api;
  const templates = composer.shownTemplates();
  const change = ui.change;
  const sourceKind = (change && SOURCE_KIND[change.source]) || '';
  const notes = noteCounts(api.review.store);
  return {
    item: ui.current(),
    index: nav.index,
    total: api.collection.items.length,
    scroll: nav.scroll,
    listScroll: nav.listScroll,
    status: viewStatus(api),
    progressFrame: ui.progressFrame,
    layout: ui.layout,
    counts: counts(api, notes),
    selection: nav.selection,
    pane: nav.pane,
    files: fileList(api, notes),
    fileCursor: nav.fileCursor,
    reviewPath: nav.reviewPath,
    branch: ui.branch,
    branches: gitBranches.branches,
    branchCursor: nav.branchCursor,
    repoName: repoNameOf(api),
    revShort: ui.revShort || '',
    sourceLabel: ui.sourceLabel || '',
    sourceKind,
    mode: ui.mode,
    compose: composer.composeView(),
    noteText: composer.idleNoteText(),
    todos: composer.todoTexts(),
    todoFocus: composer.clampedTodoFocus(),
    todoEdit: composer.todoEditView(),
    codeOverlay: composer.codeOverlayView(),
    templates,
    templateIndex: composer.clampedTemplateIndex(templates),
    updateFrom: updater.from,
    updateTo: updater.to,
    dropName: gitBranches.dropName,
  };
};

const createView = (api) => ({
  fileList: () => fileList(api),
  counts: () => counts(api),
  viewStatus: () => viewStatus(api),
  view: () => view(api),
});

module.exports = { SOURCE_KIND, relabelStatus, createView };
