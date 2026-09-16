'use strict';

const render = require('./render.js');
const keys = require('./keys.js');
const review = require('./review.js');
const { copyText } = require('./clipboard.js');
const files = require('./files.js');
const { makeTodoItem } = files;
const { renderFrame } = render;
const { decodeChunk } = keys;
const { AUTOSAVE_MS, hasNotes } = review;
const capabilities = require('./capabilities.js');
const { sessionCapabilities, createReviewStorage } = capabilities;
const { createTerminal, LEAVE_TERM } = require('./session/terminal.js');
const { createLoadCoordinator } = require('./session/load.js');
const items = require('./session/items.js');
const { createItemCollection } = items;
const { createNavigation } = require('./session/navigation.js');
const { createReviewController } = require('./session/review.js');
const { createUpdateCoordinator } = require('./session/update.js');
const { createProgress } = require('./session/progress.js');
const { createComposer } = require('./session/compose.js');
const { createOpsRunner } = require('./session/ops.js');
const { createChangeActions } = require('./session/change-actions.js');
const { createCommitController } = require('./session/commit.js');
const { createBranchController } = require('./session/branches.js');
const accessors = require('./session/accessors.js');
const { bindAccessors, bindGetters, bindAlias } = accessors;
const { createView } = require('./session/view.js');
const { createFilesPane } = require('./session/files-pane.js');
const { createLifecycle } = require('./session/lifecycle.js');
const { createPointer } = require('./session/pointer.js');
const { createDispatcher, createInput } = require('./session/dispatch.js');

const CURSOR_BLINK_MS = 500;
const PROGRESS_MS = 80;

const systemNow = () => new Date();

const NAV_FIELDS = [
  'pane',
  'index',
  'fileCursor',
  'branchCursor',
  'scroll',
  'reviewPath',
  'selection',
  'mouseAnchor',
  'pendingClick',
  'dragging',
  'todoOpen',
  'todoFocus',
];

const COMPOSER_FIELDS = [
  'editor',
  'composeKind',
  'commitKind',
  'composeTodoId',
  'composeBaseline',
  'templateIndex',
  'templateFocus',
  'blinkOn',
];

const assignOptions = (session, options) => {
  session.repo = options.repo;
  session.cwd = options.cwd;
  session.paths = options.paths ?? [];
  session.stdin = options.stdin ?? null;
  session.stdout = options.stdout;
  session.proc = options.proc ?? process;
  session.color = options.color ?? true;
  session.copyText = options.copyText ?? copyText;
  const termSize = () => {
    const width = session.stdout.columns ?? 80;
    const height = session.stdout.rows ?? 24;
    return { width, height };
  };
  session.getSize = options.getSize ?? termSize;
  session.rev = options.rev ?? null;
  session.revShort = '';
  session.sourceLabel = options.sourceLabel ?? '';
  session.repoName = options.repoName ?? '';
  session.change = options.change ?? null;
  session.now = options.now ?? systemNow;
  session.forceNewReview = options.newReview === true;
  session.readOnly = options.readOnly === true;
  session.capabilities = sessionCapabilities(options);
  const storage = options.reviewStorage ?? createReviewStorage(options);
  session.reviewStorage = storage;
  session.readdirSync = storage.readdirSync;
  session.readFileSync = storage.readFileSync;
  session.writeFileSync = storage.writeFileSync;
  session.mkdirSync = storage.mkdirSync;
  session.audit = options.audit === true;
  session.outdatedMap = options.outdatedMap;
  session.auditMap = options.auditMap;
  session.setInterval = options.setInterval ?? setInterval;
  session.clearInterval = options.clearInterval ?? clearInterval;
  session.updateOpts = options.update;
  session.term = createTerminal({
    stdin: session.stdin,
    stdout: session.stdout,
    proc: session.proc,
    setInterval: session.setInterval,
    clearInterval: session.clearInterval,
  });
  session.loader = createLoadCoordinator();
  session.collection = createItemCollection();
  session.nav = createNavigation({
    startPane: options.startPane ?? 'files',
  });
  session.review = createReviewController({ storage });
  session.progress = createProgress(
    session.term,
    () => session.tickProgress(),
    PROGRESS_MS,
  );
};

const assignUpdater = (session) => {
  session.updater = createUpdateCoordinator({
    updateOpts: () => session.updateOpts,
    didLoad: () => session.loader.didLoad,
    getMode: () => session.mode,
    setMode: (mode) => {
      session.mode = mode;
    },
    isDone: () => session.done,
    uiOpen: () => session.uiOpen,
    paint: () => session.paint(),
    setStatus: (value) => {
      session.status = value;
    },
    startInstallProgress: () => {
      session.progressFrame = 0;
      session.progress.start('install');
    },
    stopInstallProgress: () => session.progress.stop('install'),
  });
};

const assignComposer = (session) => {
  session.composer = createComposer({
    getNotes: () => session.notes,
    currentItem: () => session.current(),
    nav: session.nav,
    flushReview: (force) => session.flushReview(force),
    setStatus: (value) => {
      session.status = value;
    },
    setMode: (mode) => {
      session.mode = mode;
    },
    getMode: () => session.mode,
    draw: () => session.draw(),
    restartBlink: () => {
      if (!session.term.hasTimer('blink')) return;
      session.term.restartTimer(
        'blink',
        () => session.tickBlink(),
        CURSOR_BLINK_MS,
      );
    },
    getViewSize: () => session.lastSize ?? session.getSize(),
    getLayout: () => session.layout,
    fileCursorEntry: () => session.changeActions.fileCursorEntry(),
    afterClose: () => {
      session.clampIndex();
      session.syncReviewPath();
      session.syncFileCursor();
    },
    syncReviewPath: () => session.syncReviewPath(),
    syncFileCursor: () => session.syncFileCursor(),
  });
};

const assignControllers = (session) => {
  const setStatus = (value) => {
    session.status = value;
  };
  const setMode = (mode) => {
    session.mode = mode;
  };
  session.ops = createOpsRunner({
    top: () => session.top,
    isDone: () => session.done,
    getMode: () => session.mode,
    setMode,
    getStatus: () => session.status,
    setStatus,
    paint: () => session.paint(),
    startProgress: () => session.startProgress(),
    stopProgress: () => session.stopProgress(),
    resetProgressFrame: () => {
      session.progressFrame = 0;
    },
  });
  session.changeActions = createChangeActions({
    repo: () => session.repo,
    top: () => session.top,
    capabilities: () => session.capabilities,
    uiOpen: () => session.uiOpen,
    collection: session.collection,
    getItems: () => session.items,
    currentItem: () => session.current(),
    nav: session.nav,
    fileList: () => session.fileList(),
    runBusy: (kind, done, write, after) =>
      session.ops.runBusy(kind, done, write, after),
    reloadAfterChange: (afterLoad) => session.reloadAfterChange(afterLoad),
    setStatus,
    syncReviewPath: () => session.syncReviewPath(),
    syncFileCursor: () => session.syncFileCursor(),
  });
  session.commits = createCommitController({
    repo: () => session.repo,
    top: () => session.top,
    capabilities: () => session.capabilities,
    getItems: () => session.items,
    uiOpen: () => session.uiOpen,
    composer: session.composer,
    collection: session.collection,
    runner: session.ops,
    refreshFromRepo: (opts) => session.refreshFromRepo(opts),
    setMode,
    setStatus,
    isDone: () => session.done,
    pendingExtras: () => session.pendingExtras,
  });
  session.gitBranches = createBranchController({
    repo: () => session.repo,
    top: () => session.top,
    capabilities: () => session.capabilities,
    uiOpen: () => session.uiOpen,
    composer: session.composer,
    nav: session.nav,
    runner: session.ops,
    canCommit: () => session.commits.canCommit(),
    refreshFromRepo: (opts) => session.refreshFromRepo(opts),
    showFiles: () => session.showFiles(),
    getMode: () => session.mode,
    setMode,
    getStatus: () => session.status,
    setStatus,
  });
};

const bindSessionAccessors = (session) => {
  bindAccessors(session, session.nav, NAV_FIELDS);
  bindAccessors(session, session.composer, COMPOSER_FIELDS);
  bindAccessors(session, session.loader, ['pendingExtras', 'loadPromise']);
  bindAccessors(session, session.collection, ['items']);
  bindGetters(session, session.collection, ['dismissed']);
  bindAccessors(session, session.updater, ['installPromise']);
  bindAccessors(session, session.ops, ['gitBusy', 'busy']);
  bindAccessors(session, session.gitBranches, ['branches', 'dropName']);
  bindGetters(session, session.term, ['lastFrame', 'lastSize']);
  bindAlias(session, 'loadGen', () => session.loader.gen);
  bindAlias(
    session,
    'didLoad',
    () => session.loader.didLoad,
    (value) => {
      session.loader.didLoad = value;
      if (value) session.updater.maybePrompt();
    },
  );
  bindAlias(session, 'notes', () => session.review.store);
  bindAlias(session, 'didResumeReview', () => session.review.didResume);
  bindAlias(
    session,
    'importedRemoteNotes',
    () => session.review.importedRemote,
  );
  bindAlias(
    session,
    'updateOffer',
    () => session.updater.offer,
    (value) => {
      session.updater.offer = value;
    },
  );
  bindAlias(session, 'updateFrom', () => session.updater.from);
  bindAlias(session, 'updateTo', () => session.updater.to);
  bindAlias(session, 'updatePromise', () => session.updater.checkPromise);
};

const bindViewer = (session) => {
  session.viewer = createView({
    nav: session.nav,
    composer: session.composer,
    notes: () => session.notes,
    items: () => session.items,
    current: () => session.current(),
    repoName: () => session.repoName,
    top: () => session.top,
    cwd: () => session.cwd,
    sourceLabel: () => session.sourceLabel,
    revShort: () => session.revShort,
    status: () => session.status,
    busy: () => session.busy,
    progressFrame: () => session.progressFrame,
    layout: () => session.layout,
    branch: () => session.branch,
    branches: () => session.branches,
    change: () => session.change,
    mode: () => session.mode,
    updateFrom: () => session.updateFrom,
    updateTo: () => session.updateTo,
    dropName: () => session.dropName,
  });
};

const bindFilesPane = (session) => {
  session.filesPane = createFilesPane({
    nav: session.nav,
    composer: session.composer,
    items: () => session.items,
    todoItem: () => session.todoItem,
    fileList: () => session.fileList(),
    setStatus: (value) => {
      session.status = value;
    },
    onQuit: () => session.onQuit(),
    onCheckoutBranch: () => session.gitBranches.onCheckoutBranch(),
    onBranchMove: (delta) => session.gitBranches.onBranchMove(delta),
    layout: () => session.layout,
    setLayout: (value) => {
      session.layout = value;
    },
    lastFrame: () => session.lastFrame,
    getSize: () => session.lastSize ?? session.getSize(),
  });
};

const bindLifecycle = (session) => {
  session.lifecycle = createLifecycle({
    loader: session.loader,
    collection: session.collection,
    review: session.review,
    nav: session.nav,
    repo: () => session.repo,
    cwd: () => session.cwd,
    paths: () => session.paths,
    rev: () => session.rev,
    setRev: (value) => {
      session.rev = value;
    },
    revShort: () => session.revShort,
    setRevShort: (value) => {
      session.revShort = value;
    },
    audit: () => session.audit,
    outdatedMap: () => session.outdatedMap,
    auditMap: () => session.auditMap,
    items: () => session.items,
    notes: () => session.notes,
    current: () => session.current(),
    isDone: () => session.done,
    setDone: (value) => {
      session.done = value;
    },
    setExitCode: (value) => {
      session.exitCode = value;
    },
    setStatus: (value) => {
      session.status = value;
    },
    status: () => session.status,
    busy: () => session.busy,
    setBusy: (kind) => session.ops.setBusy(kind),
    clearBusy: () => session.ops.clearBusy(),
    stopProgress: () => session.stopProgress(),
    resetProgressFrame: () => {
      session.progressFrame = 0;
    },
    paint: () => session.paint(),
    setLoadError: (error) => {
      session.loadError = error;
    },
    loadError: () => session.loadError,
    setEmptyReview: (value) => {
      session.emptyReview = value;
    },
    finishReadLoop: () => session.finishReadLoop,
    flushReview: (force) => session.flushReview(force),
    initReview: () => session.initReview(),
    setTop: (value) => {
      session.top = value;
    },
    setSourceLabel: (value) => {
      session.sourceLabel = value;
    },
    setChange: (value) => {
      session.change = value;
    },
    change: () => session.change,
    setBranch: (value) => {
      session.branch = value;
    },
    repoName: () => session.repoName,
    setRepoName: (value) => {
      session.repoName = value;
    },
    setDidLoad: (value) => {
      session.didLoad = value;
    },
    didLoad: () => session.didLoad,
    setPendingExtras: (value) => {
      session.pendingExtras = value;
    },
    pendingExtras: () => session.pendingExtras,
    loadPromise: () => session.loadPromise,
    setLoadPromise: (value) => {
      session.loadPromise = value;
    },
    uiOpen: () => session.uiOpen,
    ensureRepo: () => session.ensureRepo(),
    clampIndex: () => session.clampIndex(),
    syncReviewPath: () => session.syncReviewPath(),
    syncFileCursor: () => session.syncFileCursor(),
  });
};

const bindDispatch = (session) => {
  const filesPane = session.filesPane;
  session.dispatcher = createDispatcher({
    getMode: () => session.mode,
    getPane: () => session.pane,
    currentTarget: () => {
      if (session.pane === 'files') return session.fileCursorEntry();
      if (session.pane === 'branches') {
        return session.branches[session.branchCursor];
      }
      return session.current();
    },
    composer: session.composer,
    changeActions: session.changeActions,
    commits: session.commits,
    gitBranches: session.gitBranches,
    onFileMove: (delta) => filesPane.onFileMove(delta),
    onBranchMove: (delta) => session.gitBranches.onBranchMove(delta),
    onNext: () => filesPane.onNext(),
    onPrev: () => filesPane.onPrev(),
    onOpenFile: () => filesPane.onOpenFile(),
    onFiles: () => filesPane.onFiles(),
    onEscape: () => filesPane.onEscape(),
    onQuit: () => session.onQuit(),
    onLayout: () => filesPane.onLayout(),
    onReload: () => session.lifecycle.onReload(),
    onScroll: (delta) => filesPane.onScroll(delta),
    scrollStep: (fraction) => filesPane.scrollStep(fraction),
  });
  session.pointer = createPointer({
    nav: session.nav,
    getSize: () => session.lastSize ?? session.getSize(),
    lastFrame: () => session.lastFrame,
    copyText: (text, stdout) => session.copyText(text, stdout),
    stdout: () => session.stdout,
    setStatus: (value) => {
      session.status = value;
    },
    dispatch: (action) => session.dispatcher.dispatch(action),
    getPane: () => session.pane,
    getMode: () => session.mode,
    onBranch: () => session.gitBranches.onBranch(),
    onOpenFile: () => filesPane.onOpenFile(),
    onCheckoutBranch: () => session.gitBranches.onCheckoutBranch(),
    onTodoHit: (cursor) => session.composer.onTodoHit(cursor),
    selectTemplate: (index) => session.selectTemplate(index),
    onScroll: (delta) => filesPane.onScroll(delta),
  });
  session.input = createInput({
    getMode: () => session.mode,
    getPane: () => session.pane,
    composer: session.composer,
    pointer: session.pointer,
    dispatch: (action) => session.dispatcher.dispatch(action),
    onEscape: () => filesPane.onEscape(),
    onQuit: () => session.onQuit(),
    runComposeCommand: (result) => session.runComposeCommand(result),
    quit: {
      ready: () => session.finishQuit('ready'),
      editing: () => session.finishQuit('editing'),
      cancel: () => session.cancelQuit(),
    },
    commit: {
      commit: () => session.commits.startGitCommit('commit'),
      amend: () => session.commits.startGitCommit('amend'),
      fixup: () => session.commits.startGitCommit('fixup'),
      cancel: () => session.commits.cancelCommit(),
    },
    update: {
      accept: () => session.updater.accept(),
      decline: () => session.updater.decline(),
    },
    drop: {
      confirm: () => session.gitBranches.confirmDropBranch(),
      cancel: () => session.gitBranches.cancelDropBranch(),
    },
    push: {
      force: () => session.gitBranches.onForcePush(),
      cancel: () => session.gitBranches.cancelPush(),
    },
  });
};

const composeSession = (session, options) => {
  assignOptions(session, options);
  assignUpdater(session);
  assignComposer(session);
  assignControllers(session);
  bindSessionAccessors(session);
  bindViewer(session);
  bindFilesPane(session);
  bindLifecycle(session);
  bindDispatch(session);
};

class Session {
  constructor(options) {
    composeSession(this, options);
    this.resetState();
  }

  resetState() {
    if (this.collection) this.collection.reset();
    if (this.nav) this.nav.reset();
    if (this.review) this.review.reset();
    if (this.composer) this.composer.reset();
    if (this.ops) this.ops.reset();
    if (this.gitBranches) this.gitBranches.reset();
    this.top = this.cwd;
    this.branch = '';
    this.status = '';
    this.layout = 'unified';
    this.done = false;
    this.exitCode = 0;
    this.mode = 'review';
    this.todoItem = makeTodoItem();
    this.progressFrame = 0;
    this.emptyReview = false;
    this.loadError = null;
    this.uiOpen = false;
    this.finishReadLoop = null;
    if (this.term) this.term.resetCache();
    if (this.loader) this.loader.reset();
    if (this.updater) this.updater.reset();
    if (this.progress) this.progress.clear();
  }

  ensureRepo() {
    if (!this.repo.toplevel) return;
    this.top = this.repo.toplevel(this.cwd);
  }

  load() {
    this.lifecycle.load();
  }

  loadReady() {
    return this.lifecycle.loadReady();
  }

  openLoad() {
    return this.lifecycle.openLoad();
  }

  refreshFromRepo(options) {
    return this.lifecycle.refreshFromRepo(options);
  }

  reloadAfterChange(afterLoad) {
    this.lifecycle.reloadAfterChange(afterLoad);
  }

  applyLoaded(loaded) {
    return this.lifecycle.applyLoaded(loaded);
  }

  paint() {
    if (!this.uiOpen) return;
    this.draw();
  }

  draw() {
    if (this.term.disposed) return;
    const size = this.getSize();
    const frame = renderFrame(this.view(), {
      width: size.width,
      height: size.height,
      color: this.color,
    });
    const composing = this.mode === 'compose';
    const cursor = composing && this.blinkOn ? frame.cursor : null;
    this.term.paint(frame, size, cursor);
  }

  view() {
    return this.viewer.view();
  }

  fileList() {
    return this.viewer.fileList();
  }

  counts() {
    return this.viewer.counts();
  }

  viewStatus() {
    return this.viewer.viewStatus();
  }

  current() {
    return this.nav.current(this.items, this.todoItem);
  }

  fileCursorEntry() {
    return this.changeActions.fileCursorEntry();
  }

  clampIndex() {
    this.filesPane.clampIndex();
  }

  syncReviewPath() {
    this.filesPane.syncReviewPath();
  }

  syncFileCursor() {
    this.filesPane.syncFileCursor();
  }

  showFiles() {
    this.filesPane.showFiles();
  }

  dispatch(action) {
    this.dispatcher.dispatch(action);
  }

  handleEvent(event) {
    this.input.handleEvent(event);
  }

  pushInput(text) {
    const decoded = decodeChunk(text, this.term.carry);
    this.term.carry = decoded.carry;
    for (const event of decoded.events) {
      this.handleEvent(event);
      if (this.done) return;
    }
    if (this.term.carry === '\x1b') {
      this.term.carry = '';
      this.handleEvent({ type: 'key', key: 'escape' });
    }
  }

  initReview() {
    this.review.init(this.top, this.now(), {
      forceNew: this.forceNewReview,
    });
  }

  flushReview(force) {
    const result = this.review.flush(force === true);
    if (!result.ok) {
      this.status = result.error.message;
      return false;
    }
    return result.wrote;
  }

  runComposeCommand(result) {
    if (!result) return;
    if (result.kind === 'commit') this.commits.finishGitCommit();
    if (result.kind === 'branch') this.gitBranches.finishCreateBranch();
  }

  selectTemplate(index) {
    this.runComposeCommand(this.composer.selectTemplate(index));
  }

  idleNoteText() {
    return this.composer.idleNoteText();
  }

  shownTemplates() {
    return this.composer.shownTemplates();
  }

  startDraftCompose() {
    this.composer.startDraftCompose();
  }

  tickBlink() {
    this.composer.tickBlink();
  }

  autosave() {
    this.composer.autosave();
  }

  onQuit() {
    if (this.mode === 'compose') {
      this.composer.commitCompose();
      this.composer.closeCompose();
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
    const result = this.review.finishQuit(status);
    if (!result.ok) this.status = result.error.message;
    this.done = true;
    this.exitCode = 0;
  }

  cancelQuit() {
    this.mode = 'review';
    this.status = '';
  }

  startProgress() {
    this.progress.start('busy');
  }

  stopProgress() {
    this.progress.stop('busy');
  }

  tickProgress() {
    this.progressFrame += 1;
    this.paint();
  }

  openUpdate() {
    return this.updater.open();
  }

  async startUi() {
    const empty = !this.items.length;
    const notes = this.notes && hasNotes(this.notes);
    if (this.didLoad && empty && !notes) {
      this.emptyReview = true;
      return 0;
    }
    this.uiOpen = true;
    this.term.enter();
    try {
      this.openLoad();
      this.openUpdate();
      this.draw();
      await this.readLoop();
    } finally {
      this.uiOpen = false;
      this.term.close();
      this.loader.abort();
      if (this.installPromise) {
        try {
          await this.installPromise;
        } catch {
          // ignore install errors after the UI closes
        }
      }
    }
    return this.exitCode;
  }

  readLoop() {
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        this.term.stopListening();
        this.progress.clear();
        this.term.clearTimers();
        this.finishReadLoop = null;
        resolve();
      };
      this.finishReadLoop = finish;
      if (this.done) {
        finish();
        return;
      }
      const onData = (chunk) => {
        this.pushInput(chunk.toString('utf8'));
        if (this.done) {
          finish();
          return;
        }
        this.draw();
      };
      this.term.startListening({
        onData,
        onResize: () => this.draw(),
      });
      this.term.startTimer('save', () => this.autosave(), AUTOSAVE_MS);
      this.term.startTimer('blink', () => this.tickBlink(), CURSOR_BLINK_MS);
    });
  }
}

module.exports = {
  LEAVE_TERM,
  Session,
};
