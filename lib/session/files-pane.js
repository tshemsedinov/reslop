'use strict';

const files = require('../files.js');
const { isTodosEntry, TODO_FILE } = files;

const LAYOUTS = ['unified', 'mixed', 'side'];

const current = (options) =>
  options.nav.current(options.items(), options.todoItem());

const clampIndex = (options) => options.nav.clampIndex(options.items().length);

const syncReviewPath = (options) =>
  options.nav.syncReviewPath(current(options));

const clampFileCursor = (options) =>
  options.nav.clampFileCursor(options.fileList().length);

const followReviewPath = (options) =>
  options.nav.followReviewPath(options.fileList(), current(options));

const syncFileCursor = (options) => {
  if (options.nav.pane === 'files') {
    clampFileCursor(options);
    return;
  }
  followReviewPath(options);
};

const showFiles = (options) => {
  options.nav.pane = 'files';
  options.nav.clearSelection();
  followReviewPath(options);
  options.nav.todoOpen = false;
};

const onEscape = (options) => {
  if (options.nav.pane === 'branches') {
    showFiles(options);
    return;
  }
  if (options.nav.pane === 'files') {
    options.onQuit();
    return;
  }
  showFiles(options);
};

const onFiles = (options) => {
  if (options.nav.pane === 'files') {
    if (!options.nav.reviewPath) return;
    options.nav.pane = 'diff';
    options.nav.clearSelection();
    if (options.nav.reviewPath === TODO_FILE) options.composer.openTodoPage();
    return;
  }
  showFiles(options);
};

const onOpenFile = (options) => {
  if (options.nav.pane === 'branches') {
    return void options.onCheckoutBranch();
  }
  if (options.nav.pane !== 'files') {
    if (options.nav.todoOpen) options.composer.editFocusedTodo();
    return;
  }
  const list = options.fileList();
  const entry = list[options.nav.fileCursor];
  if (!entry) return;
  if (isTodosEntry(entry)) {
    options.composer.openTodoPage();
    options.setStatus('');
    return;
  }
  options.nav.todoOpen = false;
  options.nav.index = entry.openIndex ?? entry.firstIndex;
  options.nav.pane = 'diff';
  options.nav.scroll = 0;
  options.setStatus('');
  options.nav.clearSelection();
  syncReviewPath(options);
};

const onFileMove = (options, delta) => {
  const list = options.fileList();
  if (!list.length) {
    options.setStatus('nothing to review');
    return;
  }
  const next = Math.min(
    list.length - 1,
    Math.max(0, options.nav.fileCursor + delta),
  );
  if (next === options.nav.fileCursor) return;
  options.nav.fileCursor = next;
  const entry = list[next];
  if (isTodosEntry(entry)) {
    options.nav.reviewPath = TODO_FILE;
  } else {
    options.nav.reviewPath = entry.path;
    options.nav.index = entry.firstIndex;
  }
  options.setStatus('');
};

const moveRemaining = (options, step) => {
  const list = options.items();
  if (!list.length) {
    options.setStatus('nothing to review');
    return;
  }
  const next = options.nav.index + step;
  if (next < 0 || next >= list.length) return;
  options.nav.index = next;
  options.nav.scroll = 0;
  options.setStatus('');
  options.nav.clearSelection();
  syncReviewPath(options);
};

const onNext = (options) => {
  if (options.nav.todoOpen) {
    options.composer.closeTodoPage();
    if (options.items().length) options.nav.index = 0;
    options.nav.scroll = 0;
    syncReviewPath(options);
    syncFileCursor(options);
    return;
  }
  moveRemaining(options, 1);
};

const onPrev = (options) => {
  if (options.nav.todoOpen) return;
  if (options.nav.index <= 0) {
    options.composer.openTodoPage();
    return;
  }
  moveRemaining(options, -1);
};

const scrollStep = (options, fraction) => {
  const frame = options.lastFrame();
  const size = options.getSize();
  const fallback = Math.max(1, (size.height ?? 24) - 4);
  const height = Math.max(1, frame?.bodyH ?? fallback);
  const n = Math.max(1, Math.floor(height * Math.abs(fraction)));
  if (fraction < 0) return -n;
  return n;
};

const onScroll = (options, delta) => {
  if (options.nav.pane === 'files') {
    onFileMove(options, delta);
    return;
  }
  if (options.nav.pane === 'branches') {
    options.onBranchMove(delta);
    return;
  }
  if (options.nav.todoOpen && options.composer.todoRowCount() > 1) {
    options.composer.moveTodoFocus(delta);
    return;
  }
  const frame = options.lastFrame();
  const max = frame ? frame.scrollMax : null;
  const current =
    max === null ? options.nav.scroll : Math.min(options.nav.scroll, max);
  const moved = current + delta;
  const next = max === null ? moved : Math.min(max, moved);
  options.nav.scroll = Math.max(0, next);
  options.nav.clearSelection();
};

const onJump = (options, toEnd) => {
  if (options.nav.pane === 'files') {
    const list = options.fileList();
    if (!list.length) {
      options.setStatus('nothing to review');
      return;
    }
    const target = toEnd ? list.length - 1 : 0;
    onFileMove(options, target - options.nav.fileCursor);
    return;
  }
  if (options.nav.pane === 'branches') {
    const delta = toEnd ? Number.MAX_SAFE_INTEGER : -Number.MAX_SAFE_INTEGER;
    options.onBranchMove(delta);
    return;
  }
  if (options.nav.todoOpen && options.composer.todoRowCount() > 0) {
    const last = options.composer.todoRowCount() - 1;
    const target = toEnd ? last : 0;
    const at = options.composer.clampedTodoFocus();
    options.composer.moveTodoFocus(target - at);
    return;
  }
  const frame = options.lastFrame();
  const max = frame ? frame.scrollMax : 0;
  options.nav.scroll = toEnd ? max : 0;
  options.nav.clearSelection();
};

const onLayout = (options) => {
  const i = LAYOUTS.indexOf(options.layout());
  const next = (i < 0 ? 0 : i + 1) % LAYOUTS.length;
  options.setLayout(LAYOUTS[next]);
  const name = LAYOUTS[next] === 'side' ? 'side-by-side' : LAYOUTS[next];
  options.setStatus(name);
  options.nav.scroll = 0;
  options.nav.clearSelection();
};

const createFilesPane = (options) => ({
  current: () => current(options),
  clampIndex: () => clampIndex(options),
  syncReviewPath: () => syncReviewPath(options),
  clampFileCursor: () => clampFileCursor(options),
  followReviewPath: () => followReviewPath(options),
  syncFileCursor: () => syncFileCursor(options),
  showFiles: () => showFiles(options),
  onEscape: () => onEscape(options),
  onFiles: () => onFiles(options),
  onOpenFile: () => onOpenFile(options),
  onFileMove: (delta) => onFileMove(options, delta),
  moveRemaining: (step) => moveRemaining(options, step),
  onNext: () => onNext(options),
  onPrev: () => onPrev(options),
  scrollStep: (fraction) => scrollStep(options, fraction),
  onScroll: (delta) => onScroll(options, delta),
  onHome: () => onJump(options, false),
  onEnd: () => onJump(options, true),
  onLayout: () => onLayout(options),
});

module.exports = { LAYOUTS, createFilesPane };
