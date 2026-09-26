'use strict';

const { stateView } = require('./accessors.js');

const { isReadOnlyOrigin } = require('../files.js');
const { isFixupCommit } = require('./actions.js');
const { pickRepoWrite } = require('./ops.js');

const COMMIT_STATUS = {
  commit: 'committed',
  amend: 'amended',
  fixup: 'fixup',
  reword: 'reworded',
};

const isInPlaceCommit = (kind) => kind === 'amend' || kind === 'reword';

const briefCommit = (ui) => ui.commits.commitView !== 'full';

const firstCommitLine = (message) => {
  const text = `${message ?? ''}`;
  const at = text.indexOf('\n');
  if (at < 0) return { line: text, body: '' };
  return { line: text.slice(0, at), body: text.slice(at + 1) };
};

const withCommitBody = (line, body) => {
  if (!body) return line;
  return `${line}\n${body}`;
};

const fixupMessage = (entry) => {
  const subject = `${entry && entry.subject ? entry.subject : ''}`.trim();
  if (!subject) return 'fixup!';
  return `fixup! ${subject}`;
};

const canCommit = (ui) => {
  const caps = ui.capabilities;
  if (!caps.branches) {
    ui.status = 'read only';
    return false;
  }
  for (const item of ui.items) {
    if (isReadOnlyOrigin(item.origin)) {
      ui.status = 'read only';
      return false;
    }
  }
  return true;
};

const hasStagedChanges = (ui) => {
  const repo = ui.repo;
  if (repo.hasStaged) return repo.hasStaged(ui.top);
  for (const item of ui.items) {
    if (item.origin === 'staged') return true;
  }
  return false;
};

const selectedCommit = (api) => {
  const cursor = api.ui.nav.commitCursor;
  return api.state.commits[cursor] ?? null;
};

const clampCommitCursor = (api) => {
  const last = api.state.commits.length - 1;
  const nav = api.ui.nav;
  if (nav.commitCursor > last) nav.commitCursor = Math.max(0, last);
};

const refreshCommitList = (api) => {
  const repo = api.ui.repo;
  if (!repo.listCommits) return;
  try {
    api.state.commits = repo.listCommits(api.ui.top);
  } catch (error) {
    api.ui.status = error.message;
    return;
  }
  clampCommitCursor(api);
};

const refreshAfterWrite = (api, extra = {}) => {
  refreshCommitList(api);
  api.ui.refreshFromRepo({ keepEmpty: true, ...extra });
};

const showCommits = (api) => {
  if (api.ui.mode === 'compose') return;
  if (!canCommit(api.ui)) return;
  const repo = api.ui.repo;
  if (!repo.listCommits) {
    api.ui.status = 'read only';
    return;
  }
  try {
    api.state.commits = repo.listCommits(api.ui.top);
  } catch (error) {
    api.ui.status = error.message;
    return;
  }
  api.ui.nav.commitCursor = 0;
  api.ui.nav.pane = 'commits';
  api.ui.status = '';
  api.ui.nav.clearSelection();
};

const onCommitMove = (api, delta) => {
  if (api.ui.mode === 'compose') return;
  const commits = api.state.commits;
  if (!commits.length) {
    api.ui.status = 'nothing to review';
    return;
  }
  const next = Math.min(
    commits.length - 1,
    Math.max(0, api.ui.nav.commitCursor + delta),
  );
  if (next === api.ui.nav.commitCursor) return;
  api.ui.nav.commitCursor = next;
  api.ui.status = '';
};

const startGitCommit = (api, kind) => {
  const ui = api.ui;
  if (!isInPlaceCommit(kind) && !hasStagedChanges(ui)) {
    ui.mode = 'review';
    ui.composer.state.commitKind = null;
    ui.status = 'nothing to commit';
    return;
  }
  let text = '';
  if (kind === 'fixup') {
    text = fixupMessage(selectedCommit(api));
  }
  if (kind === 'amend') {
    const headAt = api.state.commits.findIndex((entry) => entry.head);
    api.ui.nav.commitCursor = headAt < 0 ? 0 : headAt;
    if (ui.repo.lastMessage) {
      text = ui.repo.lastMessage(ui.top) ?? '';
    }
  }
  ui.composer.state.commitBody = '';
  if (kind === 'reword') {
    const entry = selectedCommit(api);
    if (!entry || !entry.sha) return;
    if (typeof ui.repo.commitMessage === 'function') {
      text = ui.repo.commitMessage(ui.top, entry.sha) ?? '';
    } else {
      text = `${entry.subject ?? ''}`;
    }
    if (briefCommit(ui)) {
      const parts = firstCommitLine(text);
      text = parts.line;
      ui.composer.state.commitBody = parts.body;
    }
  }
  ui.composer.state.commitKind = kind;
  ui.composer.openCompose('commit', text);
  const editor = ui.composer.state.editor;
  if (!editor) return;
  const lineEnd = editor.text.indexOf('\n');
  editor.cursor = lineEnd < 0 ? editor.text.length : lineEnd;
};

const onCommit = (api) => {
  if (api.ui.nav.pane !== 'commits') return void showCommits(api);
  if (!canCommit(api.ui)) return;
  startGitCommit(api, 'commit');
};

const onAmend = (api) => {
  if (api.ui.nav.pane !== 'commits') return;
  if (!canCommit(api.ui)) return;
  startGitCommit(api, 'amend');
};

const onReword = (api) => {
  if (api.ui.nav.pane !== 'commits') return;
  if (!canCommit(api.ui)) return;
  startGitCommit(api, 'reword');
};

const applyFixupNow = (api) => {
  const entry = selectedCommit(api);
  if (!entry || !entry.sha) return;
  const done = 'applied';
  const repo = api.ui.repo;
  if (!repo.applyFixup) {
    api.ui.status = 'read only';
    return;
  }
  const picked = pickRepoWrite(repo, 'applyFixup', api.ui.uiOpen);
  if (picked.async) {
    const run = (top) => picked.write(top, entry.sha);
    const after = () => refreshAfterWrite(api, { doneStatus: done });
    return void api.ui.ops.runBusy('applying', done, run, after);
  }
  const ok = api.ui.ops.runRepo(done, (top) => {
    repo.applyFixup(top, entry.sha);
  });
  if (!ok) return;
  refreshAfterWrite(api);
  if (!api.ui.status) api.ui.status = done;
};

const onApply = (api) => {
  if (api.ui.nav.pane !== 'commits') return;
  if (!canCommit(api.ui)) return;
  const entry = selectedCommit(api);
  if (isFixupCommit(entry)) return void applyFixupNow(api);
  startGitCommit(api, 'amend');
};

const onFixup = (api) => {
  if (api.ui.nav.pane !== 'commits') return;
  if (!canCommit(api.ui)) return;
  startGitCommit(api, 'fixup');
};

const cancelCommit = (api) => {
  api.ui.mode = 'review';
  api.ui.composer.state.commitKind = null;
  api.ui.status = '';
};

const finishAsyncCommit = (api, kind, message, done, write) => {
  const ui = api.ui;
  ui.composer.closeCompose();
  const run = (top) => write(top, kind, message);
  const after = () => refreshAfterWrite(api, { doneStatus: done });
  return void ui.ops.runBusy('committing', done, run, after);
};

const finishSyncCommit = (api, kind, message, done) => {
  const ui = api.ui;
  try {
    ui.repo.commit(ui.top, kind, message);
  } catch (error) {
    ui.status = error.message;
    return;
  }
  ui.composer.closeCompose();
  ui.collection.clearDismissed();
  refreshAfterWrite(api);
  if (!ui.done && !ui.pendingExtras) {
    ui.status = done;
  }
};

const finishReword = (api, message) => {
  const ui = api.ui;
  const entry = selectedCommit(api);
  if (!entry || !entry.sha) {
    ui.status = 'read only';
    return;
  }
  const done = COMMIT_STATUS.reword;
  const repo = ui.repo;
  if (!repo.reword) {
    ui.status = 'read only';
    return;
  }
  const picked = pickRepoWrite(repo, 'reword', ui.uiOpen);
  if (picked.async) {
    ui.composer.closeCompose();
    const run = (top) => picked.write(top, entry.sha, message);
    const after = () => refreshAfterWrite(api, { doneStatus: done });
    return void ui.ops.runBusy('rewording', done, run, after);
  }
  try {
    repo.reword(ui.top, entry.sha, message);
  } catch (error) {
    ui.status = error.message;
    return;
  }
  ui.composer.closeCompose();
  refreshAfterWrite(api);
  if (!ui.status) ui.status = done;
};

const finishGitCommit = (api) => {
  const ui = api.ui;
  const kind = ui.composer.state.commitKind;
  const editor = ui.composer.state.editor;
  let message = editor ? editor.text : '';
  if (kind === 'reword' && briefCommit(ui)) {
    message = withCommitBody(message, ui.composer.state.commitBody);
  }
  if (!message.trim()) {
    ui.status = 'empty commit message';
    return;
  }
  if (!isInPlaceCommit(kind) && !hasStagedChanges(ui)) {
    ui.composer.closeCompose();
    ui.status = 'nothing to commit';
    return;
  }
  if (kind === 'reword') return void finishReword(api, message);
  const done = COMMIT_STATUS[kind] ?? 'committed';
  const uiOpen = ui.uiOpen;
  const picked = pickRepoWrite(ui.repo, 'commit', uiOpen);
  if (picked.async) {
    return void finishAsyncCommit(api, kind, message, done, picked.write);
  }
  finishSyncCommit(api, kind, message, done);
};

const onDropCommit = (api) => {
  if (api.ui.nav.pane !== 'commits') return;
  if (!canCommit(api.ui)) return;
  const entry = selectedCommit(api);
  if (!entry) return;
  api.state.dropName = entry.shortSha || entry.sha;
  api.state.dropSha = entry.sha;
  api.ui.mode = 'confirmDrop';
  api.ui.status = '';
};

const cancelDropCommit = (api) => {
  api.ui.mode = 'review';
  api.state.dropName = '';
  api.state.dropSha = '';
  api.ui.status = '';
};

const dropAsync = (api, sha, done, write) => {
  const run = (top) => write(top, sha);
  const after = () => refreshAfterWrite(api, { doneStatus: done });
  return void api.ui.ops.runBusy('dropping', done, run, after);
};

const confirmDropCommit = (api) => {
  const sha = api.state.dropSha;
  const name = api.state.dropName;
  api.ui.mode = 'review';
  api.state.dropName = '';
  api.state.dropSha = '';
  if (!sha) return;
  const done = `dropped ${name}`;
  const repo = api.ui.repo;
  if (!repo.dropCommit) {
    api.ui.status = 'read only';
    return;
  }
  const uiOpen = api.ui.uiOpen;
  const picked = pickRepoWrite(repo, 'dropCommit', uiOpen);
  if (picked.async) {
    return void dropAsync(api, sha, done, picked.write);
  }
  const ok = api.ui.ops.runRepo(done, (top) => {
    repo.dropCommit(top, sha);
  });
  if (!ok) return;
  refreshAfterWrite(api);
  if (!api.ui.status) api.ui.status = done;
};

const onBrief = (api) => {
  if (api.ui.nav.pane !== 'commits') return;
  const next = api.state.commitView === 'full' ? 'brief' : 'full';
  api.state.commitView = next;
  api.ui.nav.listScroll = 0;
  api.ui.status = next;
};

const reset = (state) => {
  state.commits = [];
  state.dropName = '';
  state.dropSha = '';
  state.commitView = 'brief';
};

const createCommitController = (ui) => {
  const state = {
    commits: [],
    dropName: '',
    dropSha: '',
    commitView: 'brief',
  };
  const api = { ui, state };
  return stateView(
    state,
    {
      reset: () => reset(state),
      canCommit: () => canCommit(ui),
      onCommit: () => onCommit(api),
      onAmend: () => onAmend(api),
      onReword: () => onReword(api),
      onApply: () => onApply(api),
      onFixup: () => onFixup(api),
      onCommitMove: (delta) => onCommitMove(api, delta),
      onBrief: () => onBrief(api),
      cancelCommit: () => cancelCommit(api),
      startGitCommit: (kind) => startGitCommit(api, kind),
      finishGitCommit: () => finishGitCommit(api),
      refresh: () => refreshCommitList(api),
      onDropCommit: () => onDropCommit(api),
      cancelDropCommit: () => cancelDropCommit(api),
      confirmDropCommit: () => confirmDropCommit(api),
    },
    ['commits', 'dropName', 'commitView'],
  );
};

module.exports = {
  COMMIT_STATUS,
  createCommitController,
};
