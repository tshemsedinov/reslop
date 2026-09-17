'use strict';

const { isReadOnlyOrigin } = require('./origins.js');
const { pickRepoWrite } = require('./ops.js');

const COMMIT_STATUS = {
  commit: 'committed',
  amend: 'amended',
  fixup: 'fixup',
};

const canCommit = (api) => {
  const caps = api.options.capabilities();
  if (!caps.branches) {
    api.options.setStatus('read only');
    return false;
  }
  for (const item of api.options.getItems()) {
    if (isReadOnlyOrigin(item.origin)) {
      api.options.setStatus('read only');
      return false;
    }
  }
  return true;
};

const hasStagedChanges = (api) => {
  const repo = api.options.repo();
  if (repo.hasStaged) return repo.hasStaged(api.options.top());
  for (const item of api.options.getItems()) {
    if (item.origin === 'staged') return true;
  }
  return false;
};

const onCommit = (api) => {
  if (!canCommit(api)) return;
  api.options.setMode('confirmCommit');
  api.options.setStatus('');
};

const cancelCommit = (api) => {
  api.options.setMode('review');
  api.options.composer.state.commitKind = null;
  api.options.setStatus('');
};

const startGitCommit = (api, kind) => {
  if (kind !== 'amend' && !hasStagedChanges(api)) {
    api.options.setMode('review');
    api.options.composer.state.commitKind = null;
    api.options.setStatus('nothing to commit');
    return;
  }
  api.options.composer.state.commitKind = kind;
  let text = '';
  if (kind === 'fixup') text = 'HEAD';
  if (kind === 'amend' && api.options.repo().lastMessage) {
    text = api.options.repo().lastMessage(api.options.top()) ?? '';
  }
  api.options.composer.openCompose('commit', text);
};

const finishAsyncCommit = (api, kind, message, done, write) => {
  const composer = api.options.composer;
  composer.closeCompose();
  const run = (top) => write(top, kind, message);
  const after = () => {
    api.options.collection.clearDismissed();
    api.options.refreshFromRepo({ doneStatus: done });
  };
  return void api.options.runner.runBusy('committing', done, run, after);
};

const finishSyncCommit = (api, kind, message, done) => {
  try {
    api.options.repo().commit(api.options.top(), kind, message);
  } catch (error) {
    api.options.setStatus(error.message);
    return;
  }
  api.options.composer.closeCompose();
  api.options.collection.clearDismissed();
  api.options.refreshFromRepo();
  if (!api.options.isDone() && !api.options.pendingExtras()) {
    api.options.setStatus(done);
  }
};

const finishGitCommit = (api) => {
  const kind = api.options.composer.state.commitKind;
  const editor = api.options.composer.state.editor;
  const message = editor ? editor.text : '';
  if (kind !== 'fixup' && !message.trim()) {
    api.options.setStatus('empty commit message');
    return;
  }
  if (kind !== 'amend' && !hasStagedChanges(api)) {
    api.options.composer.closeCompose();
    api.options.setStatus('nothing to commit');
    return;
  }
  const done = COMMIT_STATUS[kind] ?? 'committed';
  const uiOpen = api.options.uiOpen();
  const picked = pickRepoWrite(api.options.repo(), 'commit', uiOpen);
  if (picked.async) {
    finishAsyncCommit(api, kind, message, done, picked.write);
    return;
  }
  finishSyncCommit(api, kind, message, done);
};

const createCommitController = (options) => {
  const api = { options };
  return {
    canCommit: () => canCommit(api),
    onCommit: () => onCommit(api),
    cancelCommit: () => cancelCommit(api),
    startGitCommit: (kind) => startGitCommit(api, kind),
    finishGitCommit: () => finishGitCommit(api),
  };
};

module.exports = {
  COMMIT_STATUS,
  createCommitController,
};
