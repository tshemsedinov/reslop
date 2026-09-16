'use strict';

const files = require('../files.js');
const { isTodosEntry, TODO_FILE } = files;

const LAYOUTS = ['unified', 'mixed', 'side'];

const current = (api) =>
  api.nav.current(api.options.items(), api.options.todoItem());

const clampIndex = (api) => api.nav.clampIndex(api.options.items().length);

const syncReviewPath = (api) => api.nav.syncReviewPath(current(api));

const fileList = (api) => api.options.fileList();

const clampFileCursor = (api) => api.nav.clampFileCursor(fileList(api).length);

const followReviewPath = (api) =>
  api.nav.followReviewPath(fileList(api), current(api));

const syncFileCursor = (api) => {
  if (api.nav.pane === 'files') {
    clampFileCursor(api);
    return;
  }
  followReviewPath(api);
};

const showFiles = (api) => {
  api.nav.pane = 'files';
  api.nav.clearSelection();
  followReviewPath(api);
  api.nav.todoOpen = false;
};

const onEscape = (api) => {
  if (api.nav.pane === 'branches') {
    showFiles(api);
    return;
  }
  if (api.nav.pane === 'files') {
    api.options.onQuit();
    return;
  }
  showFiles(api);
};

const onFiles = (api) => {
  if (api.nav.pane === 'files') {
    if (!api.nav.reviewPath) return;
    api.nav.pane = 'diff';
    api.nav.clearSelection();
    if (api.nav.reviewPath === TODO_FILE) api.composer.openTodoPage();
    return;
  }
  showFiles(api);
};

const onOpenFile = (api) => {
  if (api.nav.pane === 'branches') {
    return void api.options.onCheckoutBranch();
  }
  if (api.nav.pane !== 'files') {
    if (api.nav.todoOpen) api.composer.editFocusedTodo();
    return;
  }
  const list = fileList(api);
  const entry = list[api.nav.fileCursor];
  if (!entry) return;
  if (isTodosEntry(entry)) {
    api.composer.openTodoPage();
    api.options.setStatus('');
    return;
  }
  api.nav.todoOpen = false;
  api.nav.index = entry.openIndex ?? entry.firstIndex;
  api.nav.pane = 'diff';
  api.nav.scroll = 0;
  api.options.setStatus('');
  api.nav.clearSelection();
  syncReviewPath(api);
};

const onFileMove = (api, delta) => {
  const list = fileList(api);
  if (!list.length) {
    api.options.setStatus('nothing to review');
    return;
  }
  const next = Math.min(
    list.length - 1,
    Math.max(0, api.nav.fileCursor + delta),
  );
  if (next === api.nav.fileCursor) return;
  api.nav.fileCursor = next;
  const entry = list[next];
  if (isTodosEntry(entry)) {
    api.nav.reviewPath = TODO_FILE;
  } else {
    api.nav.reviewPath = entry.path;
    api.nav.index = entry.firstIndex;
  }
  api.options.setStatus('');
};

const moveRemaining = (api, step) => {
  const list = api.options.items();
  if (!list.length) {
    api.options.setStatus('nothing to review');
    return;
  }
  const next = api.nav.index + step;
  if (next < 0 || next >= list.length) return;
  api.nav.index = next;
  api.nav.scroll = 0;
  api.options.setStatus('');
  api.nav.clearSelection();
  syncReviewPath(api);
};

const onNext = (api) => {
  if (api.nav.todoOpen) {
    api.composer.closeTodoPage();
    if (api.options.items().length) api.nav.index = 0;
    api.nav.scroll = 0;
    syncReviewPath(api);
    syncFileCursor(api);
    return;
  }
  moveRemaining(api, 1);
};

const onPrev = (api) => {
  if (api.nav.todoOpen) return;
  if (api.nav.index <= 0) {
    api.composer.openTodoPage();
    return;
  }
  moveRemaining(api, -1);
};

const scrollStep = (api, fraction) => {
  const frame = api.options.lastFrame();
  const size = api.options.getSize();
  const fallback = Math.max(1, (size.height ?? 24) - 4);
  const height = Math.max(1, frame?.bodyH ?? fallback);
  const n = Math.max(1, Math.floor(height * Math.abs(fraction)));
  if (fraction < 0) return -n;
  return n;
};

const onScroll = (api, delta) => {
  if (api.nav.pane === 'files') {
    onFileMove(api, delta);
    return;
  }
  if (api.nav.pane === 'branches') {
    api.options.onBranchMove(delta);
    return;
  }
  if (api.nav.todoOpen && api.composer.todoRowCount() > 1) {
    api.composer.moveTodoFocus(delta);
    return;
  }
  const frame = api.options.lastFrame();
  const max = frame ? frame.scrollMax : null;
  const current = max === null ? api.nav.scroll : Math.min(api.nav.scroll, max);
  const moved = current + delta;
  const next = max === null ? moved : Math.min(max, moved);
  api.nav.scroll = Math.max(0, next);
  api.nav.clearSelection();
};

const onJump = (api, toEnd) => {
  if (api.nav.pane === 'files') {
    const list = fileList(api);
    if (!list.length) {
      api.options.setStatus('nothing to review');
      return;
    }
    const target = toEnd ? list.length - 1 : 0;
    onFileMove(api, target - api.nav.fileCursor);
    return;
  }
  if (api.nav.pane === 'branches') {
    const delta = toEnd ? Number.MAX_SAFE_INTEGER : -Number.MAX_SAFE_INTEGER;
    api.options.onBranchMove(delta);
    return;
  }
  if (api.nav.todoOpen && api.composer.todoRowCount() > 0) {
    const last = api.composer.todoRowCount() - 1;
    const target = toEnd ? last : 0;
    const at = api.composer.clampedTodoFocus();
    api.composer.moveTodoFocus(target - at);
    return;
  }
  const frame = api.options.lastFrame();
  const max = frame ? frame.scrollMax : 0;
  api.nav.scroll = toEnd ? max : 0;
  api.nav.clearSelection();
};

const onLayout = (api) => {
  const i = LAYOUTS.indexOf(api.options.layout());
  const next = (i < 0 ? 0 : i + 1) % LAYOUTS.length;
  api.options.setLayout(LAYOUTS[next]);
  const name = LAYOUTS[next] === 'side' ? 'side-by-side' : LAYOUTS[next];
  api.options.setStatus(name);
  api.nav.scroll = 0;
  api.nav.clearSelection();
};

const createFilesPane = (options) => {
  const api = { options, nav: options.nav, composer: options.composer };
  return {
    current: () => current(api),
    clampIndex: () => clampIndex(api),
    syncReviewPath: () => syncReviewPath(api),
    clampFileCursor: () => clampFileCursor(api),
    followReviewPath: () => followReviewPath(api),
    syncFileCursor: () => syncFileCursor(api),
    showFiles: () => showFiles(api),
    onEscape: () => onEscape(api),
    onFiles: () => onFiles(api),
    onOpenFile: () => onOpenFile(api),
    onFileMove: (delta) => onFileMove(api, delta),
    moveRemaining: (step) => moveRemaining(api, step),
    onNext: () => onNext(api),
    onPrev: () => onPrev(api),
    scrollStep: (fraction) => scrollStep(api, fraction),
    onScroll: (delta) => onScroll(api, delta),
    onHome: () => onJump(api, false),
    onEnd: () => onJump(api, true),
    onLayout: () => onLayout(api),
  };
};

module.exports = { LAYOUTS, createFilesPane };
