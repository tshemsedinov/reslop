'use strict';

const compose = require('./compose.js');
const { COMPOSE_LEAVE } = compose;
const actions = require('./actions.js');
const { CONFIRM_MODE, disabledActions, actionFromKey, applyConfirm } = actions;

const createDispatcher = (options) => {
  const handlers = {
    add: options.changeActions.onAdd,
    unstage: options.changeActions.onUnstage,
    revert: options.changeActions.onRevert,
    next: options.onNext,
    prev: options.onPrev,
    layout: options.onLayout,
    files: options.onFiles,
    feedback: options.composer.onFeedback,
    todo: options.composer.onTodo,
    code: options.composer.onCode,
    reload: options.onReload,
    commit: options.commits.onCommit,
    branch: options.gitBranches.onBranch,
    pull: options.gitBranches.onPull,
    push: options.gitBranches.onPush,
    newBranch: options.gitBranches.onNewBranch,
    rebase: options.gitBranches.onRebaseBranch,
    drop: options.gitBranches.onDropBranch,
    open: options.onOpenFile,
    removeTodo: options.composer.removeFocusedTodo,
    quit: options.onQuit,
    scrollUp: () => options.onScroll(-1),
    scrollDown: () => options.onScroll(1),
    pageUp: () => options.onScroll(options.scrollStep(-1)),
    pageDown: () => options.onScroll(options.scrollStep(1)),
    halfUp: () => options.onScroll(options.scrollStep(-0.5)),
    halfDown: () => options.onScroll(options.scrollStep(0.5)),
    home: options.onHome,
    end: options.onEnd,
  };

  const dispatch = (action) => {
    if (CONFIRM_MODE.includes(options.getMode())) return;
    if (options.getMode() === 'compose') {
      if (!COMPOSE_LEAVE.includes(action)) return;
      const result = options.composer.saveCompose();
      if (result && result.kind === 'error') return;
    }
    const pane = options.getPane();
    if (pane === 'files') {
      if (action === 'next') return void options.onFileMove(1);
      if (action === 'prev') return void options.onFileMove(-1);
    }
    if (pane === 'branches') {
      if (action === 'next') return void options.onBranchMove(1);
      if (action === 'prev') return void options.onBranchMove(-1);
    }
    const hidden = disabledActions(pane, options.currentTarget());
    if (hidden.includes(action)) return;
    const handler = handlers[action];
    if (!handler) return;
    handler();
  };

  return { dispatch, handlers };
};

const createInput = (options) => {
  const confirmations = {
    confirmQuit: options.quit,
    confirmCommit: options.commit,
    confirmUpdate: options.update,
    confirmDrop: options.drop,
    confirmPush: options.push,
  };

  const confirmChoice = (key) => {
    const mode = options.getMode();
    if (!CONFIRM_MODE.includes(mode)) return;
    applyConfirm(mode, key, confirmations[mode]);
  };

  const handleKey = (key) => {
    const mode = options.getMode();
    if (CONFIRM_MODE.includes(mode)) return void confirmChoice(key);
    if (mode === 'compose') {
      if (key === 'ctrl-c') return void options.onQuit();
      const command = options.composer.handleKey(key);
      return void options.runComposeCommand(command);
    }
    if (key === 'escape') return void options.onEscape();
    if (options.composer.typeIntoTodo(key)) return;
    const action = actionFromKey(key, options.getPane());
    if (action) options.dispatch(action);
  };

  const handleEvent = (event) => {
    if (event.type === 'key') return void handleKey(event.key);
    if (event.type !== 'mouse') return;
    options.pointer.handle(event);
  };

  return { handleEvent, confirmChoice };
};

module.exports = { createDispatcher, createInput };
