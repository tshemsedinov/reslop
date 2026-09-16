'use strict';

const compose = require('./compose.js');
const { COMPOSE_LEAVE } = compose;
const actions = require('./actions.js');
const { CONFIRM_MODE, disabledActions, actionFromKey, applyConfirm } = actions;

const createDispatcher = (options) => {
  const handlers = {
    add: () => options.changeActions.onAdd(),
    unstage: () => options.changeActions.onUnstage(),
    revert: () => options.changeActions.onRevert(),
    next: () => options.onNext(),
    prev: () => options.onPrev(),
    layout: () => options.onLayout(),
    files: () => options.onFiles(),
    feedback: () => options.composer.onFeedback(),
    todo: () => options.composer.onTodo(),
    code: () => options.composer.onCode(),
    reload: () => options.onReload(),
    commit: () => options.commits.onCommit(),
    branch: () => options.gitBranches.onBranch(),
    pull: () => options.gitBranches.onPull(),
    push: () => options.gitBranches.onPush(),
    newBranch: () => options.gitBranches.onNewBranch(),
    rebase: () => options.gitBranches.onRebaseBranch(),
    drop: () => options.gitBranches.onDropBranch(),
    open: () => options.onOpenFile(),
    removeTodo: () => options.composer.removeFocusedTodo(),
    quit: () => options.onQuit(),
    scrollUp: () => options.onScroll(-1),
    scrollDown: () => options.onScroll(1),
    pageUp: () => options.onScroll(options.scrollStep(-1)),
    pageDown: () => options.onScroll(options.scrollStep(1)),
    halfUp: () => options.onScroll(options.scrollStep(-0.5)),
    halfDown: () => options.onScroll(options.scrollStep(0.5)),
    home: () => options.onHome(),
    end: () => options.onEnd(),
  };

  const dispatch = (action) => {
    if (CONFIRM_MODE.includes(options.getMode())) return;
    if (options.getMode() === 'compose') {
      if (!COMPOSE_LEAVE.includes(action)) return;
      options.composer.commitCompose();
      options.composer.closeCompose();
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
  const KEY_MODE = {
    confirmQuit: (key) => applyConfirm('confirmQuit', key, options.quit),
    confirmCommit: (key) => applyConfirm('confirmCommit', key, options.commit),
    confirmUpdate: (key) => applyConfirm('confirmUpdate', key, options.update),
    confirmDrop: (key) => applyConfirm('confirmDrop', key, options.drop),
    confirmPush: (key) => applyConfirm('confirmPush', key, options.push),
    compose: (key) => {
      if (key === 'ctrl-c') {
        options.onQuit();
        return;
      }
      options.runComposeCommand(options.composer.handleKey(key));
    },
  };

  const handleEvent = (event) => {
    if (event.type === 'key') {
      const mode = KEY_MODE[options.getMode()];
      if (mode) {
        mode(event.key);
        return;
      }
      if (event.key === 'escape') {
        options.onEscape();
        return;
      }
      if (options.composer.typeIntoTodo(event.key)) return;
      const action = actionFromKey(event.key, options.getPane());
      if (action) options.dispatch(action);
      return;
    }
    if (event.type !== 'mouse') return;
    options.pointer.handle(event);
  };

  const confirmChoice = (key) => {
    const mode = options.getMode();
    if (!CONFIRM_MODE.includes(mode)) return;
    KEY_MODE[mode](key);
  };

  return { handleEvent, confirmChoice };
};

module.exports = { createDispatcher, createInput };
