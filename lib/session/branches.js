'use strict';

const { pickRepoWrite } = require('./ops.js');
const { confirmKey } = require('./actions.js');

const selectedBranch = (api) => {
  const cursor = api.options.nav.branchCursor;
  return api.state.branches[cursor];
};

const refreshBranchList = (api) => {
  const repo = api.options.repo();
  if (!repo.listBranches) return;
  try {
    api.state.branches = repo.listBranches(api.options.top());
  } catch (error) {
    api.options.setStatus(error.message);
    return;
  }
  const last = api.state.branches.length - 1;
  const nav = api.options.nav;
  if (nav.branchCursor > last) nav.branchCursor = Math.max(0, last);
};

const onBranch = (api) => {
  if (api.options.getMode() === 'compose') return;
  if (!api.options.canCommit()) return;
  const repo = api.options.repo();
  const caps = api.options.capabilities();
  if (!caps.branches || !repo.listBranches) {
    api.options.setStatus('read only');
    return;
  }
  try {
    api.state.branches = repo.listBranches(api.options.top());
  } catch (error) {
    api.options.setStatus(error.message);
    return;
  }
  const current = api.state.branches.findIndex((entry) => entry.current);
  api.options.nav.branchCursor = current < 0 ? 0 : current;
  api.options.nav.pane = 'branches';
  api.options.setStatus('');
  api.options.nav.clearSelection();
};

const onBranchMove = (api, delta) => {
  const branches = api.state.branches;
  if (!branches.length) {
    api.options.setStatus('nothing to review');
    return;
  }
  const next = Math.min(
    branches.length - 1,
    Math.max(0, api.options.nav.branchCursor + delta),
  );
  if (next === api.options.nav.branchCursor) return;
  api.options.nav.branchCursor = next;
  api.options.setStatus('');
};

const checkoutAsync = (api, name, done) => {
  api.options.showFiles();
  const picked = pickRepoWrite(api.options.repo(), 'checkout', true);
  const write = (top) => picked.write(top, name);
  const after = () =>
    api.options.refreshFromRepo({ keepEmpty: true, doneStatus: done });
  return void api.options.runner.runBusy('checking out', done, write, after);
};

const onCheckoutBranch = (api) => {
  if (!api.options.canCommit()) return;
  const entry = selectedBranch(api);
  if (!entry) return;
  if (entry.current) {
    api.options.showFiles();
    return;
  }
  const name = entry.name;
  const done = `checked out ${name}`;
  const uiOpen = api.options.uiOpen();
  const picked = pickRepoWrite(api.options.repo(), 'checkout', uiOpen);
  if (picked.async) {
    checkoutAsync(api, name, done);
    return;
  }
  const ok = api.options.runner.runRepo(done, (top) => {
    api.options.repo().checkout(top, name);
  });
  if (!ok) return;
  api.options.showFiles();
  api.options.refreshFromRepo({ keepEmpty: true });
  if (!api.options.getStatus()) api.options.setStatus(done);
};

const rebaseAsync = (api, onto, done) => {
  const picked = pickRepoWrite(api.options.repo(), 'rebase', true);
  const write = (top) => picked.write(top, onto);
  const after = () => {
    refreshBranchList(api);
    api.options.refreshFromRepo({ keepEmpty: true, doneStatus: done });
  };
  return void api.options.runner.runBusy('rebasing', done, write, after);
};

const onRebaseBranch = (api) => {
  if (api.options.nav.pane !== 'branches') return;
  if (!api.options.canCommit()) return;
  const entry = selectedBranch(api);
  if (!entry || entry.current) return;
  const onto = entry.name;
  const done = `rebased onto ${onto}`;
  const uiOpen = api.options.uiOpen();
  const picked = pickRepoWrite(api.options.repo(), 'rebase', uiOpen);
  if (picked.async) {
    rebaseAsync(api, onto, done);
    return;
  }
  const ok = api.options.runner.runRepo(done, (top) => {
    api.options.repo().rebase(top, onto);
  });
  if (!ok) return;
  refreshBranchList(api);
  api.options.refreshFromRepo({ keepEmpty: true });
  if (!api.options.getStatus()) api.options.setStatus(done);
};

const onDropBranch = (api) => {
  if (api.options.nav.pane !== 'branches') return;
  if (!api.options.canCommit()) return;
  const entry = selectedBranch(api);
  if (!entry || entry.current) return;
  api.state.dropName = entry.name;
  api.options.setMode('confirmDrop');
  api.options.setStatus('');
};

const cancelDropBranch = (api) => {
  api.options.setMode('review');
  api.state.dropName = '';
  api.options.setStatus('');
};

const dropAsync = (api, name, done) => {
  const picked = pickRepoWrite(api.options.repo(), 'drop', true);
  const write = (top) => picked.write(top, name);
  const after = () => {
    refreshBranchList(api);
    api.options.refreshFromRepo({ keepEmpty: true, doneStatus: done });
  };
  return void api.options.runner.runBusy('dropping', done, write, after);
};

const confirmDropBranch = (api) => {
  const name = api.state.dropName;
  api.options.setMode('review');
  api.state.dropName = '';
  if (!name) return;
  const done = `dropped ${name}`;
  const uiOpen = api.options.uiOpen();
  const picked = pickRepoWrite(api.options.repo(), 'drop', uiOpen);
  if (picked.async) {
    dropAsync(api, name, done);
    return;
  }
  const ok = api.options.runner.runRepo(done, (top) => {
    api.options.repo().drop(top, name);
  });
  if (!ok) return;
  refreshBranchList(api);
  api.options.refreshFromRepo({ keepEmpty: true });
  if (!api.options.getStatus()) api.options.setStatus(done);
};

const onConfirmDrop = (api, key) => {
  const action = confirmKey('confirmDrop', key);
  if (action === 'confirm') confirmDropBranch(api);
  if (action === 'cancel') cancelDropBranch(api);
};

const onNewBranch = (api) => {
  if (api.options.nav.pane !== 'branches') return;
  if (!api.options.canCommit()) return;
  api.options.composer.openCompose('branch', '');
};

const createAsync = (api, name, done) => {
  api.options.composer.closeCompose();
  api.options.showFiles();
  const picked = pickRepoWrite(api.options.repo(), 'createBranch', true);
  const write = (top) => picked.write(top, name);
  const after = () =>
    api.options.refreshFromRepo({ keepEmpty: true, doneStatus: done });
  return void api.options.runner.runBusy('creating branch', done, write, after);
};

const finishCreateBranch = (api) => {
  const editor = api.options.composer.editor;
  const name = editor ? editor.text.trim() : '';
  if (!name) {
    api.options.setStatus('empty branch name');
    return;
  }
  const done = `created ${name}`;
  const uiOpen = api.options.uiOpen();
  const picked = pickRepoWrite(api.options.repo(), 'createBranch', uiOpen);
  if (picked.async) {
    createAsync(api, name, done);
    return;
  }
  const ok = api.options.runner.runRepo(done, (top) => {
    api.options.repo().createBranch(top, name);
  });
  if (!ok) return;
  api.options.composer.closeCompose();
  api.options.showFiles();
  api.options.refreshFromRepo({ keepEmpty: true });
  if (!api.options.getStatus()) api.options.setStatus(done);
};

const onPull = (api) => {
  if (!api.options.canCommit()) return;
  const repo = api.options.repo();
  const picked = pickRepoWrite(repo, 'pull', api.options.uiOpen());
  if (picked.async) {
    const after = () => api.options.refreshFromRepo({ keepEmpty: true });
    const write = (top) => picked.write(top);
    return void api.options.runner.runBusy('pulling', 'pulled', write, after);
  }
  const ok = api.options.runner.runRepo('pulled', (top) => {
    repo.pull(top);
  });
  if (!ok) return;
  api.options.refreshFromRepo({ keepEmpty: true });
  if (!api.options.getStatus()) api.options.setStatus('pulled');
};

const startPush = (api, force) => {
  if (!api.options.canCommit()) return;
  const done = force ? 'force pushed' : 'pushed';
  const kind = force ? 'force pushing' : 'pushing';
  const repo = api.options.repo();
  const picked = pickRepoWrite(repo, 'push', api.options.uiOpen());
  if (picked.async) {
    const write = (top) => picked.write(top, force);
    return void api.options.runner.runBusy(kind, done, write);
  }
  try {
    repo.push(api.options.top(), force);
  } catch (error) {
    if (error.rejected && !force) {
      api.options.setMode('confirmPush');
      api.options.setStatus('');
      return;
    }
    api.options.setStatus(error.message);
    return;
  }
  api.options.setStatus(done);
};

const onPush = (api) => startPush(api, false);

const onForcePush = (api) => {
  api.options.setMode('review');
  startPush(api, true);
};

const cancelPush = (api) => {
  api.options.setMode('review');
  api.options.setStatus('');
};

const onConfirmPush = (api, key) => {
  const action = confirmKey('confirmPush', key);
  if (action === 'force') onForcePush(api);
  if (action === 'cancel') cancelPush(api);
};

const reset = (state) => {
  state.branches = [];
  state.dropName = '';
};

const createBranchController = (options) => {
  const state = {
    branches: [],
    dropName: '',
  };
  const api = { options, state };
  return {
    get branches() {
      return state.branches;
    },
    set branches(value) {
      state.branches = value;
    },
    get dropName() {
      return state.dropName;
    },
    set dropName(value) {
      state.dropName = value;
    },
    reset: () => reset(state),
    onBranch: () => onBranch(api),
    onBranchMove: (delta) => onBranchMove(api, delta),
    onCheckoutBranch: () => onCheckoutBranch(api),
    refreshBranchList: () => refreshBranchList(api),
    onRebaseBranch: () => onRebaseBranch(api),
    onDropBranch: () => onDropBranch(api),
    onConfirmDrop: (key) => onConfirmDrop(api, key),
    cancelDropBranch: () => cancelDropBranch(api),
    confirmDropBranch: () => confirmDropBranch(api),
    onNewBranch: () => onNewBranch(api),
    finishCreateBranch: () => finishCreateBranch(api),
    onPull: () => onPull(api),
    onPush: () => onPush(api),
    onForcePush: () => onForcePush(api),
    cancelPush: () => cancelPush(api),
    onConfirmPush: (key) => onConfirmPush(api, key),
    startPush: (force) => startPush(api, force),
  };
};

module.exports = { createBranchController };
