'use strict';

const fs = require('node:fs');
const path = require('node:path');

const render = require('./render.js');
const keys = require('./keys.js');
const review = require('./review.js');
const wrap = require('./wrap.js');
const { extractText, isRange } = require('./select.js');
const { copyText } = require('./clipboard.js');
const { fileEntries, itemPath } = require('./files.js');
const { Editor } = require('./editor.js');
const { refreshIndexPatches } = require('./diff.js');

const { renderFrame, presentRows, presentCursor } = render;
const { noteInnerWidth, todoInnerWidth } = render;
const { QUIT_FINISH, QUIT_CONTINUE } = render;
const { actionFromKey, hitAction, decodeChunk } = keys;
const { FILES_DISABLED } = keys;
const { cursorInWrap, wrapDoc, wrapMove } = wrap;
const { AUTOSAVE_MS, listReviewNames, loadTemplates } = review;
const { resolveReviewPath, loadReview, createStore } = review;
const { noteCounts, hasNotes, setFeedback, addTodo } = review;
const { applyImportedNotes } = review;
const { setTodoText, removeTodo, flushReview, mergeTodos } = review;
const { feedbackKey, checkLabel, rankedTemplates } = review;
const { prefixTemplates, TEMPLATE_SHOW, rememberTemplate } = review;

const LAYOUTS = ['unified', 'mixed', 'side'];
const READ_ONLY_ORIGINS = ['commit', 'pr'];
const ENTER_TERM = '\x1b[?1049h\x1b[?25l\x1b[?7l\x1b[?1002h\x1b[?1006h';
const LEAVE_TERM =
  '\x1b[?1006l\x1b[?1002l\x1b[?7h\x1b[0 q\x1b[?12l\x1b[?25h\x1b[?1049l';
const CURSOR_BLINK_MS = 500;

const systemNow = () => new Date();

const isReadOnlyOrigin = (origin) => READ_ONLY_ORIGINS.includes(origin);

const relabelStatus = (entries, from, to) => {
  if (!to) return entries;
  return entries.map((entry) => {
    if (entry.status !== from) return entry;
    return { ...entry, status: to };
  });
};

const depChangeKey = (item) => {
  const change = item.dep && item.dep.change;
  if (!change) return '';
  return `${change.section}/${change.name}`;
};

const needsReload = (item) => item.reload === true;

const itemKey = (item) => {
  if (!item || !item.file) return '';
  const rel = itemPath(item);
  if (item.origin === 'todo') return `todo:${rel}`;
  const origin = item.origin ?? '';
  const depId = depChangeKey(item);
  if (depId) return `${origin}:${rel}:dep:${depId}`;
  if (!item.hunk) {
    const block = item.blockId ?? '-';
    return `${origin}:${rel}:file:${block}`;
  }
  const oldStart = item.hunk.oldStart;
  const newStart = item.hunk.newStart;
  const block = item.blockId ?? '-';
  return `${origin}:${rel}:${oldStart}:${newStart}:${block}`;
};

const itemFeedKey = (item) => {
  if (!item || !item.file || item.origin === 'todo') return '';
  const hunk = item.hunk;
  const depId = depChangeKey(item);
  const file = depId ? `${itemPath(item)}#${depId}` : itemPath(item);
  const oldStart = hunk ? hunk.oldStart : 0;
  const newStart = hunk ? hunk.newStart : 0;
  const blockId = item.blockId ?? 0;
  return feedbackKey({ file, oldStart, newStart, blockId });
};

const sameCursor = (a, b) => {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return a.x === b.x && a.y === b.y;
};

const QUIT_CONFIRM = {
  [QUIT_FINISH]: (session) => session.finishQuit('ready'),
  [QUIT_CONTINUE]: (session) => session.finishQuit('editing'),
  'ctrl-c': (session) => session.finishQuit('ready'),
  escape: (session) => session.cancelQuit(),
};

const COMPOSE_EDITS = ['backspace', 'delete', 'ctrl-z', 'ctrl-y'];

const COMPOSE_SPECIAL = {
  backspace: (session) => session.editor.backspace(),
  delete: (session) => session.editor.delete(),
  left: (session) => session.editor.move(-1),
  right: (session) => session.editor.move(1),
  up: (session) => session.moveComposeLine(-1),
  down: (session) => session.moveComposeLine(1),
  home: (session) => session.editor.home(),
  end: (session) => session.editor.end(),
  'ctrl-a': (session) => session.editor.home(),
  'ctrl-e': (session) => session.editor.end(),
  'ctrl-z': (session) => session.editor.undoEdit(),
  'ctrl-y': (session) => session.editor.redoEdit(),
  tab: (session) => session.applyTemplate(),
};

const HANDLERS = {
  add: (session) => session.onAdd(),
  unstage: (session) => session.onUnstage(),
  revert: (session) => session.onRevert(),
  next: (session) => session.onNext(),
  prev: (session) => session.onPrev(),
  layout: (session) => session.onLayout(),
  files: (session) => session.onFiles(),
  feedback: (session) => session.onFeedback(),
  todo: (session) => session.onTodo(),
  open: (session) => session.onOpenFile(),
  removeTodo: (session) => session.removeFocusedTodo(),
  quit: (session) => session.onQuit(),
  scrollUp: (session) => session.onScroll(-1),
  scrollDown: (session) => session.onScroll(1),
  pageUp: (session) => session.onScroll(session.scrollStep(-1)),
  pageDown: (session) => session.onScroll(session.scrollStep(1)),
  halfUp: (session) => session.onScroll(session.scrollStep(-0.5)),
  halfDown: (session) => session.onScroll(session.scrollStep(0.5)),
};

const KEY_MODE = {
  confirmQuit: (session, key) => session.onConfirmQuit(key),
  compose: (session, key) => session.handleComposeKey(key),
};

const MOUSE_KIND = {
  wheelUp: (session) => session.onScroll(-1),
  wheelDown: (session) => session.onScroll(1),
  press: (session, event) => session.onMousePress(event),
  drag: (session, event) => session.onMouseDrag(event),
  release: (session, event) => session.onMouseRelease(event),
};

const RELEASE_HITS = [
  {
    match: (session) => session.pane === 'files',
    hits: (frame) => frame?.fileHits,
    onHit: (session, hit) => {
      session.fileCursor = hit.cursor;
      session.onOpenFile();
    },
  },
  {
    match: (session) => session.pane === 'diff',
    hits: (frame) => frame?.todoHits,
    onHit: (session, hit) => session.onTodoHit(hit.cursor),
  },
  {
    match: (session) => session.mode === 'compose',
    hits: (frame) => frame?.templateHits,
    onHit: (session, hit) => session.selectTemplate(hit.cursor),
  },
];

class Session {
  assignOptions(options) {
    this.repo = options.repo;
    this.cwd = options.cwd;
    this.paths = options.paths ?? [];
    this.stdin = options.stdin ?? null;
    this.stdout = options.stdout;
    this.color = options.color ?? true;
    this.copyText = options.copyText ?? copyText;
    const termSize = () => {
      const width = this.stdout.columns ?? 80;
      const height = this.stdout.rows ?? 24;
      return { width, height };
    };
    this.getSize = options.getSize ?? termSize;
    this.pane = options.startPane ?? 'files';
    this.rev = options.rev ?? null;
    this.revShort = '';
    this.sourceLabel = options.sourceLabel ?? '';
    this.repoName = options.repoName ?? '';
    this.change = options.change ?? null;
    this.readdirSync = options.readdirSync ?? fs.readdirSync;
    this.readFileSync = options.readFileSync ?? fs.readFileSync;
    this.writeFileSync = options.writeFileSync ?? fs.writeFileSync;
    this.mkdirSync = options.mkdirSync ?? fs.mkdirSync;
    this.now = options.now ?? systemNow;
    this.forceNewReview = options.newReview === true;
    this.audit = options.audit === true;
    this.outdatedMap = options.outdatedMap;
    this.auditMap = options.auditMap;
    this.setInterval = options.setInterval ?? setInterval;
    this.clearInterval = options.clearInterval ?? clearInterval;
  }

  resetState() {
    this.items = [];
    this.dismissed = new Set();
    this.top = this.cwd;
    this.index = 0;
    this.fileCursor = 0;
    this.reviewPath = null;
    this.scroll = 0;
    this.status = '';
    this.layout = 'unified';
    this.done = false;
    this.exitCode = 0;
    this.carry = '';
    this.lastFrame = null;
    this.lastPresentedCursor = null;
    this.lastSize = null;
    this.selection = null;
    this.mouseAnchor = null;
    this.pendingClick = null;
    this.abortController = null;
    this.notes = null;
    this.didResumeReview = false;
    this.importedRemoteNotes = false;
    this.mode = 'review';
    this.editor = null;
    this.composeKind = null;
    this.composeTodoId = null;
    this.composeBaseline = '';
    this.todoFocus = 0;
    this.todoDraftFile = null;
    this.templateIndex = -1;
    this.templateFocus = false;
    this.saveTimer = null;
    this.blinkTimer = null;
    this.blinkOn = true;
  }

  constructor(options) {
    this.assignOptions(options);
    this.resetState();
  }

  load() {
    const here = itemKey(this.items[this.index]);
    const commit = this.rev;
    const audit = this.audit;
    const outdatedMap = this.outdatedMap;
    const auditMap = this.auditMap;
    const options = { commit, audit, outdatedMap, auditMap };
    const loaded = this.repo.load(this.cwd, this.paths, options);
    this.top = loaded.top ?? this.cwd;
    const items = loaded.items;
    this.items = items.filter((item) => !this.dismissed.has(itemKey(item)));
    if (loaded.rev) {
      this.rev = loaded.rev;
    }
    if (loaded.revShort) {
      this.revShort = loaded.revShort;
    } else if (this.rev && !this.revShort) {
      this.revShort = this.rev.slice(0, 7);
    }
    if (loaded.sourceLabel) this.sourceLabel = loaded.sourceLabel;
    if (loaded.change) this.change = loaded.change;
    const repository = this.change ? this.change.repository : '';
    if (!this.repoName && repository) this.repoName = repository;
    if (!this.notes) this.initReview();
    const imported = loaded.imported;
    if (imported && !this.didResumeReview && !this.importedRemoteNotes) {
      applyImportedNotes(this.notes, imported);
      this.importedRemoteNotes = true;
    }
    this.injectTodos();
    if (here) {
      const idx = this.items.findIndex((item) => itemKey(item) === here);
      if (idx >= 0) this.index = idx;
    }
    this.clampIndex();
    this.syncReviewPath();
    this.syncFileCursor();
  }

  initReview() {
    const names = listReviewNames(this.top, this.readdirSync);
    const templates = loadTemplates(this.top, this.readFileSync);
    const resolved = resolveReviewPath(this.top, this.now(), names, {
      forceNew: this.forceNewReview,
      readFileSync: this.readFileSync,
    });
    if (resolved.resume) {
      this.notes = loadReview(
        resolved.reviewPath,
        templates,
        this.readFileSync,
      );
      this.didResumeReview = true;
      return;
    }
    this.notes = createStore(resolved.reviewPath, templates);
  }

  injectTodos() {
    const todos = this.notes ? this.notes.todos : [];
    const extra = this.todoDraftFile ? [this.todoDraftFile] : [];
    this.items = mergeTodos(this.items, todos, extra);
  }

  clampIndex() {
    if (!this.items.length) {
      this.index = 0;
      return;
    }
    if (this.index < 0) this.index = 0;
    if (this.index >= this.items.length) {
      this.index = this.items.length - 1;
    }
  }

  fileList() {
    const entries = fileEntries(this.items);
    if (this.sourceLabel) {
      return relabelStatus(entries, 'pr', this.sourceLabel);
    }
    return relabelStatus(entries, 'commit', this.revShort);
  }

  syncReviewPath() {
    if (this.pane !== 'diff') return;
    const item = this.current();
    this.reviewPath = item ? itemPath(item) : null;
  }

  clampFileCursor() {
    const files = this.fileList();
    if (!files.length) {
      this.fileCursor = 0;
      return;
    }
    if (this.fileCursor >= files.length) {
      this.fileCursor = files.length - 1;
    }
  }

  followReviewPath() {
    const files = this.fileList();
    if (!files.length) {
      this.fileCursor = 0;
      return;
    }
    const here = this.reviewPath;
    const idx = files.findIndex((entry) => entry.path === here);
    if (idx >= 0) {
      this.fileCursor = idx;
      return;
    }
    this.clampFileCursor();
  }

  syncFileCursor() {
    if (this.pane === 'files') {
      this.clampFileCursor();
      return;
    }
    this.followReviewPath();
  }

  counts() {
    const counts = {
      staged: 0,
      unstaged: 0,
      untracked: 0,
      commit: 0,
      pr: 0,
      todo: 0,
      feedback: 0,
    };
    for (const item of this.items) {
      if (!Object.hasOwn(counts, item.origin)) continue;
      counts[item.origin] += 1;
    }
    const notes = noteCounts(this.notes);
    counts.feedback = notes.feedback;
    counts.todo = notes.todo;
    return counts;
  }

  view() {
    const templates = this.shownTemplates();
    const change = this.change;
    const isGithubPr = change && change.source === 'github-pr';
    const repoName = this.repoName || path.basename(this.top || this.cwd || '');
    return {
      item: this.current(),
      index: this.index,
      total: this.items.length,
      scroll: this.scroll,
      status: this.status,
      layout: this.layout,
      counts: this.counts(),
      selection: this.selection,
      pane: this.pane,
      files: this.fileList(),
      fileCursor: this.fileCursor,
      reviewPath: this.reviewPath,
      repoName,
      revShort: this.revShort || '',
      sourceLabel: this.sourceLabel || '',
      sourceKind: isGithubPr ? 'pr' : '',
      mode: this.mode,
      compose: this.composeView(),
      noteText: this.idleNoteText(),
      todos: this.todoTexts(),
      todoFocus: this.clampedTodoFocus(),
      todoEdit: this.todoEditView(),
      templates,
      templateIndex: this.clampedTemplateIndex(templates),
    };
  }

  draw() {
    const size = this.getSize();
    const resized =
      !this.lastSize ||
      this.lastSize.width !== size.width ||
      this.lastSize.height !== size.height;
    const frame = renderFrame(this.view(), {
      width: size.width,
      height: size.height,
      color: this.color,
    });
    const composing = this.mode === 'compose';
    const cursor = composing && this.blinkOn ? frame.cursor : null;
    if (!resized && this.lastFrame && this.lastFrame.text === frame.text) {
      if (sameCursor(this.lastPresentedCursor, cursor)) return;
      this.lastPresentedCursor = cursor;
      this.stdout.write(presentCursor(cursor));
      return;
    }
    this.lastSize = size;
    this.lastFrame = frame;
    this.lastPresentedCursor = cursor;
    this.stdout.write(presentRows(frame.rows, { clear: resized, cursor }));
  }

  dispatch(action) {
    if (this.mode === 'confirmQuit') return;
    if (this.mode === 'compose') {
      if (action !== 'next' && action !== 'prev' && action !== 'todo') {
        return;
      }
      this.commitCompose();
      this.closeCompose();
    }
    if (this.pane === 'files') {
      if (action === 'next') return void this.onFileMove(1);
      if (action === 'prev') return void this.onFileMove(-1);
      if (FILES_DISABLED.includes(action)) return;
    }
    const handler = HANDLERS[action];
    if (!handler) return;
    handler(this);
  }

  current() {
    return this.items[this.index] ?? null;
  }

  reloadAfterChange() {
    const here = this.index;
    this.load();
    if (!this.items.length) {
      if (hasNotes(this.notes)) this.flushReview();
      this.done = true;
      this.exitCode = 0;
      this.status = 'nothing to review';
      return;
    }
    this.index = here;
    this.clampIndex();
    this.syncReviewPath();
    this.syncFileCursor();
    this.scroll = 0;
    this.clearSelection();
  }

  clearSelection() {
    this.selection = null;
    this.mouseAnchor = null;
    this.dragging = false;
    this.pendingClick = null;
  }

  applyGit(item, label, write, after) {
    try {
      write(this.top, item);
      this.status = label;
      after();
    } catch (error) {
      this.status = error.message;
    }
  }

  keepOrigin(item, origin) {
    item.origin = origin;
    if (!item.dep) refreshIndexPatches(this.items, item);
    this.clearSelection();
    this.syncReviewPath();
    this.syncFileCursor();
  }

  activeDiffItem() {
    const item = this.current();
    if (!item) return null;
    if (item.origin === 'todo') {
      this.status = 'not a diff block';
      return null;
    }
    return item;
  }

  fileCursorEntry() {
    const files = this.fileList();
    return files[this.fileCursor] ?? null;
  }

  fileActionItems() {
    const entry = this.fileCursorEntry();
    if (!entry) return [];
    const rel = entry.path;
    const items = [];
    for (const item of this.items) {
      if (item.origin === 'todo') continue;
      if (itemPath(item) !== rel) continue;
      items.push(item);
    }
    return items;
  }

  guardFileGit(items) {
    if (!items.length) return false;
    const first = items[0];
    if (isReadOnlyOrigin(first.origin)) {
      this.status = 'read only';
      return false;
    }
    return true;
  }

  applyFileGit(items, label, write, afterItem) {
    try {
      for (const item of items) {
        write(this.top, item);
        afterItem(item);
      }
      this.status = label;
      return true;
    } catch (error) {
      this.status = error.message;
      return false;
    }
  }

  selectNextFileAfter(rel) {
    const files = this.fileList();
    if (!files.length) {
      this.fileCursor = 0;
      this.reviewPath = null;
      return;
    }
    const idx = files.findIndex((entry) => entry.path === rel);
    let at = idx < 0 ? this.fileCursor : idx + 1;
    if (at >= files.length) at = files.length - 1;
    const entry = files[at];
    this.fileCursor = at;
    this.reviewPath = entry.path;
    this.index = entry.firstIndex;
  }

  onFileAdd() {
    const items = this.fileActionItems();
    if (!this.guardFileGit(items)) return;
    const rel = itemPath(items[0]);
    const targets = items.filter((item) => item.origin !== 'staged');
    if (!targets.length) {
      this.status = 'already staged';
      this.selectNextFileAfter(rel);
      return;
    }
    const proposed = targets.some((item) => needsReload(item));
    const ok = this.applyFileGit(
      targets,
      'staged',
      (top, current) => this.repo.add(top, current),
      (item) => this.keepOrigin(item, 'staged'),
    );
    if (ok && proposed) this.reloadAfterChange();
    if (ok) this.selectNextFileAfter(rel);
  }

  onFileUnstage() {
    const items = this.fileActionItems();
    if (!this.guardFileGit(items)) return;
    const rel = itemPath(items[0]);
    const targets = items.filter((item) => item.origin === 'staged');
    if (!targets.length) {
      this.status = 'not staged';
      this.selectNextFileAfter(rel);
      return;
    }
    const ok = this.applyFileGit(
      targets,
      'unstaged',
      (top, current) => this.repo.unstage(top, current),
      (item) => {
        const origin = item.file.isNew === true ? 'untracked' : 'unstaged';
        this.keepOrigin(item, origin);
      },
    );
    if (ok) this.selectNextFileAfter(rel);
  }

  onFileRevert() {
    const items = this.fileActionItems();
    if (!this.guardFileGit(items)) return;
    const rel = itemPath(items[0]);
    for (const item of items) {
      if (needsReload(item)) this.dismissed.add(itemKey(item));
    }
    let ok = false;
    try {
      this.repo.revertFile(this.top, rel, items);
      this.status = 'reverted';
      ok = true;
    } catch (error) {
      this.status = error.message;
    }
    this.reloadAfterChange();
    if (ok) this.selectNextFileAfter(rel);
  }

  onAdd() {
    if (this.pane === 'files') return void this.onFileAdd();
    const item = this.activeDiffItem();
    if (!item) return;
    if (isReadOnlyOrigin(item.origin)) {
      this.status = 'read only';
      return;
    }
    if (item.origin === 'staged') {
      this.status = 'already staged';
      return;
    }
    this.applyGit(
      item,
      'staged',
      (top, current) => this.repo.add(top, current),
      () => {
        if (needsReload(item)) {
          this.reloadAfterChange();
          return;
        }
        this.keepOrigin(item, 'staged');
      },
    );
  }

  onUnstage() {
    if (this.pane === 'files') return void this.onFileUnstage();
    const item = this.activeDiffItem();
    if (!item) return;
    if (isReadOnlyOrigin(item.origin)) {
      this.status = 'read only';
      return;
    }
    if (item.origin !== 'staged') {
      this.status = 'not staged';
      return;
    }
    const origin = item.file.isNew === true ? 'untracked' : 'unstaged';
    this.applyGit(
      item,
      'unstaged',
      (top, current) => this.repo.unstage(top, current),
      () => this.keepOrigin(item, origin),
    );
  }

  onRevert() {
    if (this.pane === 'files') return void this.onFileRevert();
    const item = this.activeDiffItem();
    if (!item) return;
    if (isReadOnlyOrigin(item.origin)) {
      this.status = 'read only';
      return;
    }
    this.applyGit(
      item,
      'reverted',
      (top, current) => this.repo.revert(top, current),
      () => {
        if (needsReload(item)) this.dismissed.add(itemKey(item));
        this.reloadAfterChange();
      },
    );
  }

  moveRemaining(step) {
    if (!this.items.length) {
      this.status = 'nothing to review';
      return;
    }
    const next = this.index + step;
    if (next < 0) {
      this.status = 'first block';
      return;
    }
    if (next >= this.items.length) {
      this.status = 'last block';
      return;
    }
    this.index = next;
    this.scroll = 0;
    this.status = '';
    this.clearSelection();
    this.syncReviewPath();
  }

  onNext() {
    this.moveRemaining(1);
  }

  onPrev() {
    this.moveRemaining(-1);
  }

  onQuit() {
    if (this.mode === 'compose') {
      this.commitCompose();
      this.closeCompose();
    }
    if (hasNotes(this.notes)) {
      this.mode = 'confirmQuit';
      this.status = '';
      return;
    }
    this.done = true;
    this.exitCode = 0;
  }

  finishQuit(status) {
    if (this.notes) {
      this.notes.status = status;
      this.notes.dirty = true;
    }
    this.flushReview();
    this.done = true;
    this.exitCode = 0;
  }

  cancelQuit() {
    this.mode = 'review';
    this.status = '';
  }

  onConfirmQuit(key) {
    const quitKey = key.length === 1 ? key.toLowerCase() : key;
    const handler = QUIT_CONFIRM[quitKey];
    if (handler) handler(this);
  }

  onFeedback() {
    if (this.pane === 'files') {
      this.status = 'not a diff block';
      return;
    }
    const item = this.current();
    if (!item || item.origin === 'todo') {
      this.status = 'not a diff block';
      return;
    }
    const prev = this.notes.feedback.get(itemFeedKey(item));
    const text = prev ? prev.text : '';
    this.openCompose('feedback', text);
  }

  todoFile() {
    if (this.pane === 'files') {
      const entry = this.fileCursorEntry();
      return entry ? entry.path : '';
    }
    const item = this.current();
    return item ? itemPath(item) : '';
  }

  onTodo() {
    const file = this.todoFile();
    if (!file) return;
    this.createTodo(file);
  }

  todoPageIndex(file) {
    return this.items.findIndex(
      (item) => item.origin === 'todo' && itemPath(item) === file,
    );
  }

  focusTodoPage(file, todoId) {
    const idx = this.todoPageIndex(file);
    if (idx < 0) return false;
    this.index = idx;
    const todos = this.fileTodos(file);
    let focus = 0;
    if (todoId === null) {
      focus = todos.length;
    } else if (todoId !== undefined) {
      const at = todos.findIndex((todo) => todo.id === todoId);
      if (at >= 0) focus = at;
      else if (todos.length) focus = todos.length - 1;
    }
    this.todoFocus = focus;
    this.scroll = 0;
    return true;
  }

  isDraftCompose() {
    return (
      this.mode === 'compose' &&
      this.composeKind === 'todo' &&
      this.composeTodoId === null
    );
  }

  startDraftCompose(file) {
    this.todoDraftFile = file;
    this.injectTodos();
    this.focusTodoPage(file, null);
    this.syncReviewPath();
    this.openCompose('todo', '', null);
  }

  editFocusedTodo() {
    const item = this.current();
    if (!item || item.origin !== 'todo') return;
    const todos = this.fileTodos(itemPath(item));
    const focus = this.clampedTodoFocus();
    const todo = todos[focus];
    if (!todo) {
      this.startDraftCompose(itemPath(item));
      return;
    }
    this.openCompose('todo', todo.text, todo.id);
  }

  removeFocusedTodo() {
    if (this.pane === 'files') return;
    const item = this.current();
    if (!item || item.origin !== 'todo') return;
    const file = itemPath(item);
    const todos = this.fileTodos(file);
    const focus = this.clampedTodoFocus();
    const todo = todos[focus];
    if (!todo) return;
    removeTodo(this.notes, todo.id);
    this.injectTodos();
    const left = this.fileTodos(file);
    if (!left.length) {
      this.clampIndex();
    } else if (this.todoFocus >= left.length) {
      this.todoFocus = left.length - 1;
    }
    this.syncReviewPath();
    this.syncFileCursor();
    this.flushReview(true);
  }

  onTodoHit(cursor) {
    const item = this.current();
    if (!item || item.origin !== 'todo') return;
    const todos = this.fileTodos(itemPath(item));
    const draft = cursor === todos.length;
    const target = todos[cursor];
    if (!draft && !target) return;
    if (this.mode === 'compose' && this.composeKind === 'todo') {
      if (draft && this.composeTodoId === null) return;
      if (target && target.id === this.composeTodoId) return;
      this.commitCompose();
      this.closeCompose();
    }
    this.todoFocus = cursor;
    this.editFocusedTodo();
  }

  createTodo(file) {
    if (!file) return;
    this.pane = 'diff';
    this.scroll = 0;
    this.clearSelection();
    this.startDraftCompose(file);
  }

  openCompose(kind, text, todoId) {
    this.mode = 'compose';
    this.composeKind = kind;
    this.composeTodoId = todoId ?? null;
    this.composeBaseline = text;
    this.editor = new Editor(text);
    this.templateIndex = -1;
    this.templateFocus = false;
    this.status = '';
    this.clearSelection();
    this.resetBlink();
  }

  commitCompose() {
    if (this.mode !== 'compose' || !this.editor || !this.notes) return;
    const text = this.editor.text;
    if (this.composeKind === 'feedback') {
      const item = this.current();
      if (!item || item.origin === 'todo') return;
      const hunk = item.hunk;
      setFeedback(this.notes, itemFeedKey(item), {
        file: itemPath(item),
        oldStart: hunk ? hunk.oldStart : 0,
        newStart: hunk ? hunk.newStart : 0,
        blockId: item.blockId ?? 0,
        origin: item.origin,
        header: hunk ? hunk.header : '',
        text,
      });
      return;
    }
    if (this.composeKind === 'todo') this.commitTodo(text);
  }

  commitTodo(text) {
    const id = this.composeTodoId;
    const todos = this.notes.todos;
    const prev = id === null ? null : todos.find((entry) => entry.id === id);
    const current = this.current();
    const file = prev ? prev.file : itemPath(current) || this.todoDraftFile;
    if (prev) {
      setTodoText(this.notes, id, text);
    } else if (text.trim() && file) {
      const todo = addTodo(this.notes, file, text);
      this.composeTodoId = todo.id;
    }
    this.injectTodos();
    if (this.focusTodoPage(file, this.composeTodoId)) return;
    const hunkIdx = this.items.findIndex(
      (item) => item.origin !== 'todo' && itemPath(item) === file,
    );
    if (hunkIdx >= 0) {
      this.index = hunkIdx;
    } else if (this.index >= this.items.length) {
      this.index = Math.max(0, this.items.length - 1);
    }
  }

  closeCompose() {
    this.mode = 'review';
    this.editor = null;
    this.composeKind = null;
    this.composeTodoId = null;
    this.composeBaseline = '';
    this.templateIndex = -1;
    this.templateFocus = false;
    this.todoDraftFile = null;
    this.injectTodos();
    this.clampIndex();
    this.syncReviewPath();
    this.syncFileCursor();
  }

  shownTemplates() {
    if (!this.notes) return [];
    if (this.mode === 'compose' && this.composeKind !== 'feedback') return [];
    const ranked = rankedTemplates(this.notes.templates);
    const editing = this.mode === 'compose' && this.editor;
    const typed = editing ? this.editor.text : '';
    const exact = ranked.some((entry) => entry.text === typed);
    if (exact) return [];
    const matched = prefixTemplates(ranked, typed);
    return matched.slice(0, TEMPLATE_SHOW);
  }

  clampedTemplateIndex(shown) {
    if (!shown.length) return -1;
    if (this.templateIndex >= shown.length) return shown.length - 1;
    return this.templateIndex;
  }

  clearTemplatePick() {
    this.templateIndex = -1;
    this.templateFocus = false;
  }

  focusTemplate(index, apply) {
    const shown = this.shownTemplates();
    if (!shown.length) return;
    let i = index;
    if (i < 0) i = shown.length - 1;
    if (i >= shown.length) i = 0;
    this.templateIndex = i;
    this.templateFocus = true;
    if (apply) this.editor.replace(shown[i].text);
  }

  applyTemplate() {
    if (this.composeKind !== 'feedback') return;
    const index = this.templateFocus ? this.templateIndex : 0;
    this.selectTemplate(index);
  }

  selectTemplate(index) {
    const shown = this.shownTemplates();
    if (!shown.length) return;
    this.focusTemplate(index, true);
    this.saveCompose();
  }

  composeView() {
    if (this.mode !== 'compose' || !this.editor) return null;
    if (this.composeKind !== 'feedback') return null;
    const kind = this.composeKind;
    const text = this.editor.text;
    const cursor = this.editor.cursor;
    return { kind, text, cursor };
  }

  todoEditView() {
    if (this.mode !== 'compose' || this.composeKind !== 'todo') return null;
    if (!this.editor) return null;
    return { cursor: this.editor.cursor };
  }

  fileTodos(rel) {
    if (!this.notes || !rel) return [];
    const todos = [];
    for (const todo of this.notes.todos) {
      if (todo.file !== rel) continue;
      todos.push(todo);
    }
    return todos;
  }

  todoTexts() {
    const item = this.current();
    if (!item || item.origin !== 'todo') return [];
    const texts = [];
    const editingTodo = this.mode === 'compose' && this.composeKind === 'todo';
    const editingId = editingTodo ? this.composeTodoId : null;
    for (const todo of this.fileTodos(itemPath(item))) {
      const live = editingId === todo.id && this.editor;
      const text = live ? this.editor.text : todo.text;
      texts.push(checkLabel(text, todo.done));
    }
    const draft = this.isDraftCompose() && this.editor ? this.editor.text : '';
    texts.push(checkLabel(draft, false));
    return texts;
  }

  focusedTodo() {
    const item = this.current();
    if (!item || item.origin !== 'todo') return null;
    const todos = this.fileTodos(itemPath(item));
    return todos[this.clampedTodoFocus()] ?? null;
  }

  clampedTodoFocus() {
    const last = Math.max(0, this.todoRowCount() - 1);
    if (this.todoFocus < 0) return 0;
    if (this.todoFocus > last) return last;
    return this.todoFocus;
  }

  todoRowCount() {
    const item = this.current();
    if (!item || item.origin !== 'todo') return 0;
    return this.fileTodos(itemPath(item)).length + 1;
  }

  moveTodoFocus(delta) {
    const item = this.current();
    if (!item || item.origin !== 'todo') return;
    const n = this.todoRowCount();
    if (!n) return;
    const next = this.clampedTodoFocus() + delta;
    if (next < 0) this.todoFocus = 0;
    else if (next >= n) this.todoFocus = n - 1;
    else this.todoFocus = next;
  }

  idleNoteText() {
    if (!this.notes) return '';
    if (this.mode === 'compose') return '';
    const item = this.current();
    if (!item || item.origin === 'todo') return '';
    const note = this.notes.feedback.get(itemFeedKey(item));
    if (!note || !note.text.trim()) return '';
    return checkLabel(note.text, note.done);
  }

  flushReview(force) {
    if (!this.notes) return false;
    try {
      const writeFileSync = this.writeFileSync;
      const mkdirSync = this.mkdirSync;
      const io = { writeFileSync, mkdirSync, force: force === true };
      return flushReview(this.notes, io);
    } catch (error) {
      this.status = error.message;
      return false;
    }
  }

  saveCompose() {
    this.commitCompose();
    if (this.composeKind === 'feedback') {
      const next = this.editor ? this.editor.text : '';
      rememberTemplate(this.notes, this.composeBaseline, next);
    }
    this.flushReview();
    this.closeCompose();
    this.status = 'saved';
  }

  autosave() {
    const text = this.editor ? this.editor.text : '';
    if (this.mode === 'compose' && text.trim()) this.commitCompose();
    if (this.notes && this.notes.dirty) this.flushReview();
  }

  moveTodoLine(delta, inner) {
    const todo = this.focusedTodo();
    const done = todo ? todo.done === true : false;
    const label = checkLabel(this.editor.text, done);
    const prefix = checkLabel('', done).length;
    const col = this.editor.wantCol;
    const at = prefix + this.editor.cursor;
    const moved = wrapMove(label, at, inner, delta, col);
    const next = moved.cursor - prefix;
    const max = this.editor.text.length;
    this.editor.wantCol = moved.col;
    if (next < 0) this.editor.cursor = 0;
    else if (next > max) this.editor.cursor = max;
    else this.editor.cursor = next;
  }

  moveComposeLine(delta) {
    const size = this.lastSize ?? this.getSize();
    if (this.composeKind === 'todo') {
      this.moveTodoLine(delta, todoInnerWidth(size.width));
      return;
    }
    const width = noteInnerWidth(size.width);
    const shown = this.shownTemplates();
    if (shown.length && this.composeKind === 'feedback') {
      if (this.templateFocus) {
        const next = this.templateIndex + delta;
        if (next < 0 || next >= shown.length) {
          this.templateFocus = false;
          return;
        }
        this.focusTemplate(next, false);
        return;
      }
      const pos = cursorInWrap(this.editor.text, this.editor.cursor, width);
      const last = wrapDoc(this.editor.text, width).length - 1;
      if (delta < 0 && pos.row === 0) {
        this.focusTemplate(shown.length - 1, false);
        return;
      }
      if (delta > 0 && pos.row === last) {
        this.focusTemplate(0, false);
        return;
      }
    }
    this.editor.moveLine(delta, width);
  }

  resetBlink() {
    this.blinkOn = true;
    if (this.blinkTimer === null) return;
    this.clearInterval(this.blinkTimer);
    this.blinkTimer = this.setInterval(() => this.tickBlink(), CURSOR_BLINK_MS);
  }

  tickBlink() {
    if (this.mode !== 'compose') return;
    this.blinkOn = !this.blinkOn;
    this.draw();
  }

  handleComposeKey(key) {
    if (key === 'ctrl-c') {
      this.onQuit();
      return;
    }
    if (key === 'enter') {
      if (this.templateFocus && this.composeKind === 'feedback') {
        this.selectTemplate(this.templateIndex);
        return;
      }
      this.saveCompose();
      return;
    }
    if (key === 'escape' || key === 'ctrl-s') {
      this.saveCompose();
      return;
    }
    const special = COMPOSE_SPECIAL[key];
    if (special) {
      special(this);
      if (COMPOSE_EDITS.includes(key)) this.clearTemplatePick();
      this.resetBlink();
      return;
    }
    if (!key.length) return;
    if (key.charCodeAt(0) >= 32) {
      this.clearTemplatePick();
      this.editor.insert(key);
      this.resetBlink();
    }
  }

  showFiles() {
    this.pane = 'files';
    this.clearSelection();
    this.followReviewPath();
  }

  onEscape() {
    if (this.pane === 'files') {
      this.onQuit();
      return;
    }
    this.showFiles();
  }

  onFiles() {
    if (this.pane === 'files') {
      if (!this.reviewPath) return;
      this.pane = 'diff';
      this.clearSelection();
      return;
    }
    this.showFiles();
  }

  onOpenFile() {
    if (this.pane !== 'files') {
      const item = this.current();
      if (item && item.origin === 'todo') this.editFocusedTodo();
      return;
    }
    const files = this.fileList();
    const entry = files[this.fileCursor];
    if (!entry) return;
    this.index = entry.firstIndex;
    this.pane = 'diff';
    this.scroll = 0;
    this.status = '';
    this.clearSelection();
    this.syncReviewPath();
  }

  onFileMove(delta) {
    const files = this.fileList();
    if (!files.length) {
      this.status = 'nothing to review';
      return;
    }
    const next = Math.min(
      files.length - 1,
      Math.max(0, this.fileCursor + delta),
    );
    if (next === this.fileCursor) {
      this.status = next <= 0 ? 'first file' : 'last file';
      return;
    }
    this.fileCursor = next;
    const entry = files[next];
    this.reviewPath = entry.path;
    this.index = entry.firstIndex;
    this.status = '';
  }

  scrollStep(fraction) {
    const bodyH = this.lastFrame?.bodyH;
    const size = this.lastSize ?? this.getSize();
    const fallback = Math.max(1, (size.height ?? 24) - 4);
    const height = Math.max(1, bodyH ?? fallback);
    const n = Math.max(1, Math.floor(height * Math.abs(fraction)));
    if (fraction < 0) return -n;
    return n;
  }

  onScroll(delta) {
    if (this.pane === 'files') {
      this.onFileMove(delta);
      return;
    }
    const item = this.current();
    if (item && item.origin === 'todo' && this.todoRowCount() > 1) {
      this.moveTodoFocus(delta);
      return;
    }
    this.scroll = Math.max(0, this.scroll + delta);
    this.clearSelection();
  }

  onLayout() {
    const i = LAYOUTS.indexOf(this.layout);
    const next = (i < 0 ? 0 : i + 1) % LAYOUTS.length;
    this.layout = LAYOUTS[next];
    this.status = this.layout === 'side' ? 'side-by-side' : this.layout;
    this.scroll = 0;
    this.clearSelection();
  }

  mouseCell(event) {
    const size = this.lastSize ?? this.getSize();
    const x = Math.min(Math.max(1, event.x), size.width);
    const y = Math.min(Math.max(1, event.y), size.height);
    return { x, y };
  }

  onMousePress(event) {
    const cell = this.mouseCell(event);
    this.mouseAnchor = cell;
    this.pendingClick = null;
    this.selection = null;
    if (this.lastFrame && cell.y === this.lastFrame.height) {
      this.pendingClick = hitAction(this.lastFrame.buttons, cell.x - 1);
    }
  }

  onMouseDrag(event) {
    if (!this.mouseAnchor) return;
    this.pendingClick = null;
    this.selection = {
      start: this.mouseAnchor,
      end: this.mouseCell(event),
    };
  }

  clickButton(cell, clickId) {
    if (!clickId || !this.lastFrame || isRange(this.selection)) return false;
    const id = hitAction(this.lastFrame.buttons, cell.x - 1);
    if (id === clickId && cell.y === this.lastFrame.height) {
      this.dispatch(id);
    }
    this.selection = null;
    return true;
  }

  clickHit(hits, cell, onHit) {
    if (!hits || isRange(this.selection)) return false;
    const hit = hits.find((row) => row.y === cell.y);
    if (!hit) return false;
    onHit(hit);
    this.selection = null;
    return true;
  }

  copySelection() {
    if (!isRange(this.selection) || !this.lastFrame) return;
    const text = extractText(this.lastFrame.rows, this.selection);
    if (!text) return;
    const ok = this.copyText(text, this.stdout);
    this.status = ok ? 'copied' : 'copy failed';
  }

  onMouseRelease(event) {
    const cell = this.mouseCell(event);
    if (this.mouseAnchor) {
      this.selection = { start: this.mouseAnchor, end: cell };
    }
    const clickId = this.pendingClick;
    this.pendingClick = null;
    this.mouseAnchor = null;
    if (this.clickButton(cell, clickId)) return;
    const frame = this.lastFrame;
    for (const target of RELEASE_HITS) {
      if (!target.match(this)) continue;
      const hits = target.hits(frame);
      const opened = this.clickHit(hits, cell, (hit) => {
        target.onHit(this, hit);
      });
      if (opened) return;
    }
    this.copySelection();
  }

  handleEvent(event) {
    if (event.type === 'key') {
      const mode = KEY_MODE[this.mode];
      if (mode) {
        mode(this, event.key);
        return;
      }
      if (event.key === 'escape') {
        this.onEscape();
        return;
      }
      const action = actionFromKey(event.key);
      if (action) this.dispatch(action);
      return;
    }
    if (event.type !== 'mouse') return;
    const kind = event.kind;
    const wheel = kind === 'wheelUp' || kind === 'wheelDown';
    if (!wheel && event.btn !== 0 && event.btn !== undefined) return;
    const handler = MOUSE_KIND[kind];
    if (handler) handler(this, event);
  }

  pushInput(text) {
    const decoded = decodeChunk(text, this.carry);
    this.carry = decoded.carry;
    for (const event of decoded.events) {
      this.handleEvent(event);
      if (this.done) return;
    }
    if (this.carry === '\x1b') {
      this.carry = '';
      this.handleEvent({ type: 'key', key: 'escape' });
    }
  }

  enterTerm() {
    if (this.stdin && this.stdin.setRawMode) this.stdin.setRawMode(true);
    if (this.stdin) this.stdin.resume();
    this.stdout.write(ENTER_TERM);
  }

  leaveTerm() {
    this.stdout.write(LEAVE_TERM);
    if (this.stdin && this.stdin.setRawMode) this.stdin.setRawMode(false);
  }

  async startUi() {
    this.enterTerm();
    try {
      this.draw();
      await this.readLoop();
    } finally {
      this.leaveTerm();
    }
    return this.exitCode;
  }

  readLoop() {
    return new Promise((resolve) => {
      this.abortController = new AbortController();
      const { signal } = this.abortController;
      const finish = () => {
        if (this.saveTimer !== null) {
          this.clearInterval(this.saveTimer);
          this.saveTimer = null;
        }
        if (this.blinkTimer !== null) {
          this.clearInterval(this.blinkTimer);
          this.blinkTimer = null;
        }
        this.abortController.abort();
        resolve();
      };
      const onData = (chunk) => {
        this.pushInput(chunk.toString('utf8'));
        if (this.done) {
          finish();
          return;
        }
        this.draw();
      };
      this.saveTimer = this.setInterval(() => this.autosave(), AUTOSAVE_MS);
      this.blinkTimer = this.setInterval(
        () => this.tickBlink(),
        CURSOR_BLINK_MS,
      );
      this.stdin.on('data', (chunk) => onData(chunk), { signal });
      process.on('SIGWINCH', () => this.draw(), { signal });
    });
  }
}

module.exports = {
  LEAVE_TERM,
  Session,
};
