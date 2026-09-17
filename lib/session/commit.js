'use strict';

const { isReadOnlyOrigin } = require('./origins.js');
const { pickRepoWrite } = require('./ops.js');

const COMMIT_STATUS = {
  commit: 'committed',
  amend: 'amended',
  fixup: 'fixup',
};

const canCommit = (options) => {
  const caps = options.capabilities();
  if (!caps.branches) {
    options.setStatus('read only');
    return false;
  }
  for (const item of options.getItems()) {
    if (isReadOnlyOrigin(item.origin)) {
      options.setStatus('read only');
      return false;
    }
  }
  return true;
};

const hasStagedChanges = (options) => {
  const repo = options.repo();
  if (repo.hasStaged) return repo.hasStaged(options.top());
  for (const item of options.getItems()) {
    if (item.origin === 'staged') return true;
  }
  return false;
};

const onCommit = (options) => {
  if (!canCommit(options)) return;
  options.setMode('confirmCommit');
  options.setStatus('');
};

const cancelCommit = (options) => {
  options.setMode('review');
  options.composer.state.commitKind = null;
  options.setStatus('');
};

const startGitCommit = (options, kind) => {
  if (kind !== 'amend' && !hasStagedChanges(options)) {
    options.setMode('review');
    options.composer.state.commitKind = null;
    options.setStatus('nothing to commit');
    return;
  }
  options.composer.state.commitKind = kind;
  let text = '';
  if (kind === 'fixup') text = 'HEAD';
  if (kind === 'amend' && options.repo().lastMessage) {
    text = options.repo().lastMessage(options.top()) ?? '';
  }
  options.composer.openCompose('commit', text);
};

const finishAsyncCommit = (options, kind, message, done, write) => {
  const composer = options.composer;
  composer.closeCompose();
  const run = (top) => write(top, kind, message);
  const after = () => {
    options.collection.clearDismissed();
    options.refreshFromRepo({ doneStatus: done });
  };
  return void options.runner.runBusy('committing', done, run, after);
};

const finishSyncCommit = (options, kind, message, done) => {
  try {
    options.repo().commit(options.top(), kind, message);
  } catch (error) {
    options.setStatus(error.message);
    return;
  }
  options.composer.closeCompose();
  options.collection.clearDismissed();
  options.refreshFromRepo();
  if (!options.isDone() && !options.pendingExtras()) {
    options.setStatus(done);
  }
};

const finishGitCommit = (options) => {
  const kind = options.composer.state.commitKind;
  const editor = options.composer.state.editor;
  const message = editor ? editor.text : '';
  if (kind !== 'fixup' && !message.trim()) {
    options.setStatus('empty commit message');
    return;
  }
  if (kind !== 'amend' && !hasStagedChanges(options)) {
    options.composer.closeCompose();
    options.setStatus('nothing to commit');
    return;
  }
  const done = COMMIT_STATUS[kind] ?? 'committed';
  const uiOpen = options.uiOpen();
  const picked = pickRepoWrite(options.repo(), 'commit', uiOpen);
  if (picked.async) {
    finishAsyncCommit(options, kind, message, done, picked.write);
    return;
  }
  finishSyncCommit(options, kind, message, done);
};

const createCommitController = (options) => ({
  canCommit: () => canCommit(options),
  onCommit: () => onCommit(options),
  cancelCommit: () => cancelCommit(options),
  startGitCommit: (kind) => startGitCommit(options, kind),
  finishGitCommit: () => finishGitCommit(options),
});

module.exports = {
  COMMIT_STATUS,
  createCommitController,
};
