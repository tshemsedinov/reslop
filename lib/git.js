'use strict';

const { capabilitiesFor, attachCapabilities } = require('./capabilities.js');
const read = require('./git/read.js');
const changes = require('./git/changes.js');
const branches = require('./git/branches.js');
const dependencies = require('./git/dependencies.js');

const load = (cwd, paths = [], options = {}) => {
  const snapshot = read.readSnapshot(cwd, paths, options);
  return dependencies.finishLoad(snapshot, { ...options, paths });
};

const loadAsync = async (cwd, paths = [], options = {}) => {
  const snapshot = await read.readSnapshotAsync(cwd, paths, options);
  return dependencies.finishLoad(snapshot, {
    ...options,
    paths,
    deferExtras: true,
  });
};

const addItem = (top, item) => {
  if (dependencies.handles(item)) return dependencies.addItem(top, item);
  return changes.addItem(top, item);
};

const addItemAsync = async (top, item) => {
  if (dependencies.handles(item)) {
    await dependencies.addItemAsync(top, item);
    return;
  }
  addItem(top, item);
};

const unstageItem = (top, item) => {
  if (dependencies.handles(item)) return dependencies.unstageItem(top, item);
  return changes.unstageItem(top, item);
};

const revertItem = (top, item) => {
  if (item.origin === 'commit') return;
  if (dependencies.handles(item)) {
    dependencies.revertDepItem(top, item);
    return;
  }
  changes.revertItem(top, item);
};

const revertFile = (top, rel, items) => {
  if (dependencies.relatedFiles(items).length) {
    return dependencies.revertFile(top, rel, items);
  }
  return changes.revertFile(top, rel, items);
};

const createGitRepo = () =>
  attachCapabilities(
    {
      load,
      loadAsync,
      loadExtras: dependencies.loadExtras,
      toplevel: read.toplevel,
      resolveRev: read.resolveRev,
      add: addItem,
      addAsync: addItemAsync,
      unstage: unstageItem,
      revert: revertItem,
      revertFile,
      commit: branches.commitChanges,
      commitAsync: branches.commitChangesAsync,
      hasStaged: branches.hasStaged,
      lastMessage: branches.lastMessage,
      listBranches: branches.listBranches,
      currentBranch: read.currentBranch,
      checkout: branches.checkoutBranch,
      checkoutAsync: branches.checkoutBranchAsync,
      createBranch: branches.createBranch,
      createBranchAsync: branches.createBranchAsync,
      rebase: branches.rebaseBranch,
      rebaseAsync: branches.rebaseBranchAsync,
      drop: branches.dropBranch,
      dropAsync: branches.dropBranchAsync,
      pull: branches.pullChanges,
      pullAsync: branches.pullChangesAsync,
      push: branches.pushChanges,
      pushAsync: branches.pushChangesAsync,
    },
    capabilitiesFor('local'),
  );

module.exports = {
  load,
  loadAsync,
  loadExtras: dependencies.loadExtras,
  addItem,
  unstageItem,
  revertItem,
  commitChanges: branches.commitChanges,
  commitChangesAsync: branches.commitChangesAsync,
  hasStaged: branches.hasStaged,
  currentBranch: read.currentBranch,
  lastMessage: branches.lastMessage,
  listBranches: branches.listBranches,
  checkoutBranch: branches.checkoutBranch,
  checkoutBranchAsync: branches.checkoutBranchAsync,
  createBranch: branches.createBranch,
  createBranchAsync: branches.createBranchAsync,
  rebaseBranch: branches.rebaseBranch,
  rebaseBranchAsync: branches.rebaseBranchAsync,
  dropBranch: branches.dropBranch,
  dropBranchAsync: branches.dropBranchAsync,
  pullChanges: branches.pullChanges,
  pullChangesAsync: branches.pullChangesAsync,
  pushChanges: branches.pushChanges,
  pushChangesAsync: branches.pushChangesAsync,
  createGitRepo,
};
