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

const selectedCommit = (api) => {
  const cursor = api.options.nav.commitCursor;
  return api.state.commits[cursor] ?? null;
};

const clampCommitCursor = (api) => {
  const last = api.state.commits.length - 1;
  const nav = api.options.nav;
  if (nav.commitCursor > last) nav.commitCursor = Math.max(0, last);
};

const refreshCommitList = (api) => {
  const repo = api.options.repo();
  if (!repo.listCommits) return;
  try {
    api.state.commits = repo.listCommits(api.options.top());
  } catch (error) {
    api.options.setStatus(error.message);
    return;
  }
  clampCommitCursor(api);
};

const refreshAfterWrite = (api, extra = {}) => {
  refreshCommitList(api);
  api.options.refreshFromRepo({ keepEmpty: true, ...extra });
};

const showCommits = (api) => {
  if (api.options.getMode() === 'compose') return;
  if (!canCommit(api.options)) return;
  const repo = api.options.repo();
  if (!repo.listCommits) {
    api.options.setStatus('read only');
    return;
  }
  try {
    api.state.commits = repo.listCommits(api.options.top());
  } catch (error) {
    api.options.setStatus(error.message);
    return;
  }
  api.options.nav.commitCursor = 0;
  api.options.nav.pane = 'commits';
  api.options.setStatus('');
  api.options.nav.clearSelection();
};

const onCommitMove = (api, delta) => {
  const commits = api.state.commits;
  if (!commits.length) {
    api.options.setStatus('nothing to review');
    return;
  }
  const next = Math.min(
    commits.length - 1,
    Math.max(0, api.options.nav.commitCursor + delta),
  );
  if (next === api.options.nav.commitCursor) return;
  api.options.nav.commitCursor = next;
  api.options.setStatus('');
};

const startGitCommit = (api, kind) => {
  const options = api.options;
  if (kind !== 'amend' && !hasStagedChanges(options)) {
    options.setMode('review');
    options.composer.state.commitKind = null;
    options.setStatus('nothing to commit');
    return;
  }
  options.composer.state.commitKind = kind;
  let text = '';
  if (kind === 'fixup') {
    const entry = selectedCommit(api);
    text = entry ? entry.shortSha || entry.sha : 'HEAD';
  }
  if (kind === 'amend' && options.repo().lastMessage) {
    text = options.repo().lastMessage(options.top()) ?? '';
  }
  options.composer.openCompose('commit', text);
};

const onCommit = (api) => {
  if (api.options.nav.pane !== 'commits') return void showCommits(api);
  if (!canCommit(api.options)) return;
  startGitCommit(api, 'commit');
};

const onAmend = (api) => {
  if (api.options.nav.pane !== 'commits') return;
  if (!canCommit(api.options)) return;
  startGitCommit(api, 'amend');
};

const onFixup = (api) => {
  if (api.options.nav.pane !== 'commits') return;
  if (!canCommit(api.options)) return;
  startGitCommit(api, 'fixup');
};

const cancelCommit = (api) => {
  api.options.setMode('review');
  api.options.composer.state.commitKind = null;
  api.options.setStatus('');
};

const finishAsyncCommit = (api, kind, message, done, write) => {
  const options = api.options;
  options.composer.closeCompose();
  const run = (top) => write(top, kind, message);
  const after = () => refreshAfterWrite(api, { doneStatus: done });
  return void options.runner.runBusy('committing', done, run, after);
};

const finishSyncCommit = (api, kind, message, done) => {
  const options = api.options;
  try {
    options.repo().commit(options.top(), kind, message);
  } catch (error) {
    options.setStatus(error.message);
    return;
  }
  options.composer.closeCompose();
  options.collection.clearDismissed();
  refreshAfterWrite(api);
  if (!options.isDone() && !options.pendingExtras()) {
    options.setStatus(done);
  }
};

const finishGitCommit = (api) => {
  const options = api.options;
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
    finishAsyncCommit(api, kind, message, done, picked.write);
    return;
  }
  finishSyncCommit(api, kind, message, done);
};

const onDropCommit = (api) => {
  if (api.options.nav.pane !== 'commits') return;
  if (!canCommit(api.options)) return;
  const entry = selectedCommit(api);
  if (!entry) return;
  api.state.dropName = entry.shortSha || entry.sha;
  api.state.dropSha = entry.sha;
  api.options.setMode('confirmDrop');
  api.options.setStatus('');
};

const cancelDropCommit = (api) => {
  api.options.setMode('review');
  api.state.dropName = '';
  api.state.dropSha = '';
  api.options.setStatus('');
};

const dropAsync = (api, sha, done, write) => {
  const run = (top) => write(top, sha);
  const after = () => refreshAfterWrite(api, { doneStatus: done });
  return void api.options.runner.runBusy('dropping', done, run, after);
};

const confirmDropCommit = (api) => {
  const sha = api.state.dropSha;
  const name = api.state.dropName;
  api.options.setMode('review');
  api.state.dropName = '';
  api.state.dropSha = '';
  if (!sha) return;
  const done = `dropped ${name}`;
  const repo = api.options.repo();
  if (!repo.dropCommit) {
    api.options.setStatus('read only');
    return;
  }
  const uiOpen = api.options.uiOpen();
  const picked = pickRepoWrite(repo, 'dropCommit', uiOpen);
  if (picked.async) {
    dropAsync(api, sha, done, picked.write);
    return;
  }
  const ok = api.options.runner.runRepo(done, (top) => {
    repo.dropCommit(top, sha);
  });
  if (!ok) return;
  refreshAfterWrite(api);
  if (!api.options.getStatus()) api.options.setStatus(done);
};

const reset = (state) => {
  state.commits = [];
  state.dropName = '';
  state.dropSha = '';
};

const createCommitController = (options) => {
  const state = {
    commits: [],
    dropName: '',
    dropSha: '',
  };
  const api = { options, state };
  return {
    get commits() {
      return state.commits;
    },
    set commits(value) {
      state.commits = value;
    },
    get dropName() {
      return state.dropName;
    },
    set dropName(value) {
      state.dropName = value;
    },
    reset: () => reset(state),
    canCommit: () => canCommit(options),
    onCommit: () => onCommit(api),
    onAmend: () => onAmend(api),
    onFixup: () => onFixup(api),
    onCommitMove: (delta) => onCommitMove(api, delta),
    cancelCommit: () => cancelCommit(api),
    startGitCommit: (kind) => startGitCommit(api, kind),
    finishGitCommit: () => finishGitCommit(api),
    onDropCommit: () => onDropCommit(api),
    cancelDropCommit: () => cancelDropCommit(api),
    confirmDropCommit: () => confirmDropCommit(api),
  };
};

module.exports = {
  COMMIT_STATUS,
  createCommitController,
};
