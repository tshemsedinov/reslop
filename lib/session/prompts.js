'use strict';

const { remoteKind, selectChangeSource } = require('../source/source.js');
const { lineKey, lineField } = require('../input/editor.js');
const { isTasksEntry, TASKS_FILE } = require('../common/files.js');
const { fileMatches } = require('../common/find.js');
const { folderOf } = require('../common/folders.js');
const { allFiles } = require('./view.js');

const FIND_PANES = ['files', 'diff'];

const startFind = (ui) => {
  if (ui.mode !== 'review') return;
  if (!FIND_PANES.includes(ui.pane)) return;
  ui.mode = 'find';
  const find = lineField('query');
  find.at = 0;
  ui.nav.find = find;
  ui.status = '';
};

const stopFind = (ui) => {
  ui.mode = 'review';
  ui.nav.find = null;
  ui.status = '';
};

// A match in another folder moves the tree there
const focusMatch = (ui, hit, jump) => {
  const entry = allFiles(ui)[hit.index];
  if (!entry) return;
  const moved = ui.nav.reviewPath !== entry.path;
  ui.nav.folder = folderOf(entry.path);
  ui.nav.folderFocus = false;
  const at = ui.fileList().findIndex((row) => row.path === entry.path);
  ui.nav.fileCursor = Math.max(0, at);
  if (isTasksEntry(entry)) {
    ui.nav.reviewPath = TASKS_FILE;
    return;
  }
  ui.nav.reviewPath = entry.path;
  if (ui.nav.pane !== 'diff') {
    ui.nav.index = entry.firstIndex;
    return;
  }
  if (!moved && !jump) return;
  ui.nav.index = entry.openIndex ?? entry.firstIndex;
  ui.nav.scroll = 0;
  ui.nav.clearSelection();
};

const showHit = (ui, jump) => {
  const state = ui.nav.find;
  if (!state) return;
  const hits = fileMatches(allFiles(ui), state.query);
  if (!hits.length) return;
  const count = hits.length;
  let at = state.at % count;
  if (at < 0) at += count;
  state.at = at;
  focusMatch(ui, hits[at], jump);
};

const moveFind = (ui, delta) => {
  const state = ui.nav.find;
  if (!state.query) return;
  state.at += delta;
  showHit(ui, false);
};

// A find of its own, as on the tasks screen, takes its keys
const onFindKey = (ui, key) => {
  if (ui.nav.find?.onKey) return void ui.nav.find.onKey(key);
  if (!ui.nav.find) {
    ui.mode = 'review';
    return;
  }
  if (key === 'escape' || key === 'enter') return void stopFind(ui);
  if (key === 'backspace' && !ui.nav.find.query) return void stopFind(ui);
  const handled = lineKey(ui.nav.find.editor, key, ui, true);
  if (handled === 'text') {
    ui.nav.find.at = 0;
    showHit(ui, true);
  }
  if (handled) return;
  if (key === 'up') return void moveFind(ui, -1);
  if (key === 'down') moveFind(ui, 1);
};

const changeRepositoryUrl = (change) => {
  if (!change?.url || !change.repository) return '';
  try {
    const url = new URL(change.url);
    return `${url.origin}/${change.repository}`;
  } catch {
    return '';
  }
};

const startImport = (ui) => {
  if (ui.mode !== 'review' || ui.pane !== 'tasks') return;
  ui.composer.tasks.closePlanMenu();
  ui.mode = 'import';
  const defaultUrl = ui.repositoryUrl || changeRepositoryUrl(ui.change);
  ui.nav.import = lineField('url', defaultUrl);
  ui.status = '';
};

const stopImport = (ui) => {
  ui.mode = 'review';
  ui.nav.import = null;
  ui.status = '';
};

const noteImport = (ui, message) => {
  ui.status = message;
  if (ui.uiOpen) ui.paint();
};

const finishImport = (ui, store, loaded) => {
  const imported = loaded && loaded.imported;
  if (!imported || ui.review.store !== store) {
    noteImport(ui, 'import failed');
    return;
  }
  store.applyImportedNotes(imported);
  ui.flushReview();
  noteImport(ui, 'imported');
};

const runImport = (ui, selected) => {
  const kind = remoteKind(selected);
  if (!kind) return Promise.resolve(null);
  const load = ui[kind.option] ?? kind.load;
  const target = kind.target(selected);
  if (!load || !target) return Promise.resolve(null);
  const fetch = ui.fetchImpl ?? globalThis.fetch;
  const options = { cwd: ui.root, token: kind.token(), fetch };
  return Promise.resolve().then(() => load(target, options));
};

const submitImport = (ui) => {
  const state = ui.nav.import;
  const url = state ? state.url.trim() : '';
  const store = ui.review.store;
  stopImport(ui);
  if (!url) return;
  const selected = selectChangeSource([url]);
  if (!remoteKind(selected)) {
    ui.status = 'bad url';
    return;
  }
  ui.status = 'importing';
  const pending = runImport(ui, selected);
  ui.importPromise = pending;
  pending.then(
    (loaded) => finishImport(ui, store, loaded),
    (error) => {
      const message = error instanceof Error ? error.message : '';
      noteImport(ui, message || 'import failed');
    },
  );
};

const onImportKey = (ui, key) => {
  const state = ui.nav.import;
  if (!state) {
    ui.mode = 'review';
    return;
  }
  if (key === 'escape') return void stopImport(ui);
  if (key === 'enter') return void submitImport(ui);
  lineKey(state.editor, key, ui, true);
};

module.exports = {
  startImport,
  stopImport,
  onImportKey,
  FIND_PANES,
  startFind,
  onFindKey,
};
