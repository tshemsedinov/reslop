'use strict';

const ASYNC_WITHOUT_UI = ['pull', 'push'];

const pickRepoWrite = (repo, name, uiOpen) => {
  const asyncFn = repo[`${name}Async`];
  const allowAsync = uiOpen === true || ASYNC_WITHOUT_UI.includes(name);
  if (allowAsync && typeof asyncFn === 'function') {
    return {
      async: true,
      write: (top, ...args) => asyncFn(top, ...args),
    };
  }
  const syncFn = repo[name];
  return {
    async: false,
    write: (top, ...args) => syncFn(top, ...args),
  };
};

const createOpsRunner = (options) => {
  const state = {
    gitBusy: false,
    busy: '',
  };

  const reset = () => {
    state.gitBusy = false;
    state.busy = '';
  };

  const setBusy = (kind) => {
    state.busy = kind;
    options.startProgress();
  };

  const clearBusy = () => {
    state.busy = '';
    options.stopProgress();
  };

  const runRepo = (label, write) => {
    try {
      write(options.top());
      options.setStatus(label);
      return true;
    } catch (error) {
      options.setStatus(error.message);
      return false;
    }
  };

  const finishBusy = (done, after) => {
    if (options.isDone()) {
      options.paint();
      return;
    }
    if (options.getMode() === 'confirmPush') {
      options.paint();
      return;
    }
    if (!options.getStatus() && after) after();
    if (!options.getStatus() && !state.busy) options.setStatus(done);
    options.paint();
  };

  const runBusy = async (kind, done, write, after) => {
    if (state.gitBusy) return;
    state.gitBusy = true;
    options.setStatus('');
    options.resetProgressFrame();
    setBusy(kind);
    options.paint();
    try {
      await write(options.top());
    } catch (error) {
      if (error.rejected && kind !== 'force pushing') {
        options.setMode('confirmPush');
      } else {
        options.setStatus(error.message);
      }
    } finally {
      clearBusy();
      state.gitBusy = false;
    }
    finishBusy(done, after);
  };

  return {
    get gitBusy() {
      return state.gitBusy;
    },
    set gitBusy(value) {
      state.gitBusy = value;
    },
    get busy() {
      return state.busy;
    },
    set busy(value) {
      state.busy = value;
    },
    reset,
    setBusy,
    clearBusy,
    runRepo,
    runBusy,
  };
};

module.exports = { ASYNC_WITHOUT_UI, pickRepoWrite, createOpsRunner };
