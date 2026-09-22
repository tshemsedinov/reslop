'use strict';

const compose = require('./compose.js');
const { COMPOSE_LEAVE } = compose;
const actions = require('./actions.js');
const { CONFIRM_MODE, disabledActions, actionFromKey, applyConfirm } = actions;

const targetHasStaged = (session) => {
  if (session.repo.hasStaged) return session.repo.hasStaged(session.top);
  return session.items.some((item) => item.origin === 'staged');
};

const currentTarget = (ui) => {
  if (ui.pane === 'files') return ui.fileCursorEntry();
  if (ui.pane === 'branches') {
    return ui.branches[ui.branchCursor];
  }
  if (ui.pane === 'commits') {
    const entry = ui.commits.commits[ui.commitCursor];
    const staged = targetHasStaged(ui);
    if (!entry) return { canCommit: staged };
    return { ...entry, canCommit: staged };
  }
  return ui.current();
};

const createDispatcher = (ui) => {
  const handlers = {
    add: ui.changeActions.onAdd,
    unstage: ui.changeActions.onUnstage,
    revert: ui.changeActions.onRevert,
    next: ui.filesPane.onNext,
    prev: ui.filesPane.onPrev,
    layout: ui.filesPane.onLayout,
    files: ui.filesPane.onFiles,
    feedback: ui.composer.onFeedback,
    todo: ui.composer.onTodo,
    code: ui.composer.onCode,
    reload: ui.lifecycle.onReload,
    commit: ui.commits.onCommit,
    amend: ui.commits.onAmend,
    apply: ui.commits.onApply,
    fixup: ui.commits.onFixup,
    branch: ui.gitBranches.onBranch,
    pull: ui.gitBranches.onPull,
    push: ui.gitBranches.onPush,
    newBranch: ui.gitBranches.onNewBranch,
    rebase: ui.gitBranches.onRebaseBranch,
    drop: () => {
      if (ui.pane === 'commits') {
        return void ui.commits.onDropCommit();
      }
      ui.gitBranches.onDropBranch();
    },
    open: ui.filesPane.onOpenFile,
    file: ui.filesPane.onFileScope,
    diff: ui.filesPane.onDiffScope,
    removeTodo: ui.composer.removeFocusedTodo,
    quit: () => ui.onQuit(),
    scrollUp: () => ui.filesPane.onScroll(-1),
    scrollDown: () => ui.filesPane.onScroll(1),
    pageUp: () => ui.filesPane.onScroll(ui.filesPane.scrollStep(-1)),
    pageDown: () => ui.filesPane.onScroll(ui.filesPane.scrollStep(1)),
    halfUp: () => ui.filesPane.onScroll(ui.filesPane.scrollStep(-0.5)),
    halfDown: () => ui.filesPane.onScroll(ui.filesPane.scrollStep(0.5)),
    home: ui.filesPane.onHome,
    end: ui.filesPane.onEnd,
  };

  const dispatch = (action) => {
    if (CONFIRM_MODE.includes(ui.mode)) return;
    if (ui.mode === 'compose') {
      if (!COMPOSE_LEAVE.includes(action)) return;
      const result = ui.composer.saveCompose();
      if (result && result.kind === 'error') return;
    }
    const pane = ui.pane;
    if (pane === 'files') {
      if (action === 'next') return void ui.filesPane.onFileMove(1);
      if (action === 'prev') return void ui.filesPane.onFileMove(-1);
    }
    if (pane === 'branches') {
      if (action === 'next') return void ui.gitBranches.onBranchMove(1);
      if (action === 'prev') return void ui.gitBranches.onBranchMove(-1);
    }
    if (pane === 'commits') {
      if (action === 'next') return void ui.commits.onCommitMove(1);
      if (action === 'prev') return void ui.commits.onCommitMove(-1);
    }
    const hidden = disabledActions(pane, currentTarget(ui));
    if (hidden.includes(action)) return;
    const handler = handlers[action];
    if (!handler) return;
    handler();
  };

  return { dispatch, handlers };
};

const createInput = (ui) => {
  const confirmations = {
    confirmQuit: {
      ready: () => ui.finishQuit('ready'),
      editing: () => ui.finishQuit('editing'),
      cancel: () => ui.cancelQuit(),
    },
    confirmUpdate: {
      accept: ui.updater.accept,
      decline: ui.updater.decline,
    },
    confirmDrop: {
      confirm: () => {
        if (ui.commits.dropName) {
          return void ui.commits.confirmDropCommit();
        }
        ui.gitBranches.confirmDropBranch();
      },
      cancel: () => {
        if (ui.commits.dropName) {
          return void ui.commits.cancelDropCommit();
        }
        ui.gitBranches.cancelDropBranch();
      },
    },
    confirmPush: {
      force: ui.gitBranches.onForcePush,
      cancel: ui.gitBranches.cancelPush,
    },
  };

  const confirmChoice = (key) => {
    const mode = ui.mode;
    if (!CONFIRM_MODE.includes(mode)) return;
    applyConfirm(mode, key, confirmations[mode]);
  };

  const handleKey = (key) => {
    const mode = ui.mode;
    if (CONFIRM_MODE.includes(mode)) return void confirmChoice(key);
    if (mode === 'compose') {
      if (key === 'ctrl-c') return void ui.onQuit();
      const command = ui.composer.handleKey(key);
      return void ui.runComposeCommand(command);
    }
    if (key === 'escape') return void ui.filesPane.onEscape();
    if (ui.composer.typeIntoTodo(key)) return;
    const action = actionFromKey(key, ui.pane, ui.fileScope);
    if (action) ui.dispatch(action);
  };

  const handleEvent = (event) => {
    if (event.type === 'key') return void handleKey(event.key);
    if (event.type !== 'mouse') return;
    ui.pointer.handle(event);
  };

  return { handleEvent, confirmChoice };
};

module.exports = { createDispatcher, createInput };
