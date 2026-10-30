'use strict';

const { isReadOnlyOrigin, selectableRow } = require('../common/files.js');
const { saveUiPrefs } = require('./prefs.js');
const { isFixupCommit } = require('../input/actions.js');
const commits = require('../render/commits.js');
const { commitLine, commitText, splitMessage } = commits;

const COMMIT_STATUS = {
  commit: 'committed',
  amend: 'amended',
  fixup: 'fixup',
  reword: 'reworded',
  squash: 'squashed',
};

const IN_PLACE_COMMIT = ['amend', 'reword', 'squash'];
const SUBJECT_COMMIT = ['amend', 'reword'];

const isInPlaceCommit = (kind) => IN_PLACE_COMMIT.includes(kind);

const PENDING_COMMIT = {
  pending: true,
  subject: 'uncommitted changes',
  sha: '',
  shortSha: '',
  author: '',
  email: '',
  date: '',
  when: '',
  refs: '',
  body: '',
  head: false,
};

const listedCommits = (commits) => [PENDING_COMMIT].concat(commits ?? []);

const joinMessage = (line, rest) => (rest ? `${line}\n${rest}` : line);

const tidyCommitMessage = (message) => {
  const lines = `${message ?? ''}`.split('\n').map((line) => line.trim());
  while (lines.length && lines[0] === '') lines.shift();
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n');
};

const fixupMessage = (entry) => {
  const subject = commitLine(entry).trim();
  if (!subject) return 'fixup!';
  return `fixup! ${subject}`;
};

const squashText = (rows) => {
  const oldestFirst = [...rows].reverse();
  const messages = oldestFirst
    .map((entry) => commitText(entry).trim())
    .filter(Boolean);
  return messages.join('\n\n');
};

const hasStagedChanges = async (ui) => {
  const repo = ui.repo;
  if (repo.hasStaged) return repo.hasStaged(ui.top);
  return ui.items.some((item) => item.origin === 'staged');
};

const COMMIT_MESSAGE = {
  fixup: (controller) => fixupMessage(controller.selected()),
  amend: (controller) => controller.amendMessage(),
  reword: (controller) => controller.rewordMessage(),
  squash: (controller) => controller.squashMessage(),
};

const CHOOSE_COMMIT = {
  update: (controller) => controller.onUpdate(),
  amend: (controller) => controller.onAmend(),
  fixup: (controller) => controller.onFixup(),
  commit: (controller) => controller.start('commit'),
};

class CommitController {
  constructor(ui) {
    this.ui = ui;
    this.reset();
  }

  reset() {
    this.commits = [];
    this.staged = false;
    this.dropName = '';
    this.dropSha = '';
    this.dropShas = [];
    this.squashShas = [];
    this.commitView = 'brief';
  }

  get brief() {
    return this.commitView !== 'full';
  }

  canCommit() {
    const ui = this.ui;
    const readOnly =
      !ui.capabilities.branches ||
      ui.items.some((item) => isReadOnlyOrigin(item.origin));
    if (readOnly) ui.status = 'read only';
    return !readOnly;
  }

  canWrite() {
    return this.ui.nav.pane === 'commits' && this.canCommit();
  }

  selected() {
    return listedCommits(this.commits)[this.ui.nav.commitCursor] ?? null;
  }

  selectedRows() {
    const eligible = (entry) => selectableRow('commits', entry, this.ui);
    return this.ui.nav.selectedRows(listedCommits(this.commits), eligible);
  }

  async loadCommits() {
    const ui = this.ui;
    try {
      const reads = [ui.repo.listCommits(ui.top), hasStagedChanges(ui)];
      [this.commits, this.staged] = await Promise.all(reads);
      return true;
    } catch (error) {
      ui.status = error.message;
      return false;
    }
  }

  async refresh() {
    if (!this.ui.repo.listCommits) return;
    const loaded = await this.loadCommits();
    if (!loaded) return;
    const last = listedCommits(this.commits).length - 1;
    const nav = this.ui.nav;
    if (nav.commitCursor > last) nav.commitCursor = Math.max(0, last);
  }

  reload() {
    const ui = this.ui;
    return ui.ops.track(this.refresh().then(() => ui.paint()));
  }

  refreshAfterWrite(extra = {}) {
    this.ui.ops.hold(this.refresh());
    this.ui.refreshFromRepo({ keepEmpty: true, ...extra });
  }

  indexForView() {
    const ui = this.ui;
    if (this.staged) return 0;
    const list = listedCommits(this.commits);
    const want = `${ui.rev ?? ''}`;
    const short = `${ui.revShort ?? ''}`;
    if (!want && !short) return 0;
    for (let i = 0; i < list.length; i++) {
      const entry = list[i];
      if (entry.pending) continue;
      const sha = `${entry.sha ?? ''}`;
      const brief = `${entry.shortSha ?? ''}`;
      if (want && sha === want) return i;
      if (short && (brief === short || sha.startsWith(short))) return i;
    }
    return 0;
  }

  show() {
    const ui = this.ui;
    if (ui.mode === 'compose') return;
    if (!ui.repo.listCommits) {
      ui.status = 'read only';
      return;
    }
    ui.ops.hold(this.open());
  }

  async open() {
    const ui = this.ui;
    const loaded = await this.loadCommits();
    if (!loaded) return;
    const nav = ui.nav;
    nav.commitCursor = this.indexForView();
    nav.openList('commits');
    ui.status = '';
  }

  onCommitMove(delta, extend = false) {
    const nav = this.ui.nav;
    if (this.ui.mode === 'compose') return;
    nav.moveList(delta, listedCommits(this.commits).length, extend);
    this.ui.status = '';
  }

  async stagedFor(kind) {
    if (isInPlaceCommit(kind)) return true;
    return hasStagedChanges(this.ui);
  }

  async amendMessage() {
    const ui = this.ui;
    const headAt = this.commits.findIndex((entry) => entry.head);
    const at = headAt < 0 ? 0 : headAt;
    ui.nav.commitCursor = this.commits.length ? at + 1 : 0;
    if (!ui.repo.lastMessage) return '';
    const last = await ui.repo.lastMessage(ui.top);
    return last ?? '';
  }

  async rewordMessage() {
    const ui = this.ui;
    const entry = this.selected();
    if (!entry || !entry.sha) return null;
    if (!ui.repo.commitMessage) return commitText(entry);
    const message = await ui.repo.commitMessage(ui.top, entry.sha);
    return message ?? '';
  }

  async messageFor(kind) {
    const message = COMMIT_MESSAGE[kind];
    if (message) return message(this);
    this.ui.nav.commitCursor = 0;
    return '';
  }

  start(kind) {
    this.ui.ops.hold(this.compose(kind));
  }

  async compose(kind) {
    const ui = this.ui;
    const composer = ui.composer;
    const staged = await this.stagedFor(kind);
    if (!staged) {
      ui.mode = 'review';
      composer.commitKind = null;
      ui.status = 'nothing to commit';
      return;
    }
    let text = await this.messageFor(kind);
    if (text === null) return;
    composer.commitBody = '';
    if (SUBJECT_COMMIT.includes(kind) && this.brief) {
      const parts = splitMessage(text);
      composer.commitBody = parts.rest;
      text = parts.line;
    }
    composer.commitKind = kind;
    ui.composer.openCompose('commit', text);
    const editor = composer.editor;
    const lineEnd = editor.text.indexOf('\n');
    editor.cursor = lineEnd < 0 ? editor.text.length : lineEnd;
  }

  onInsert() {
    const entry = this.selected();
    if (!entry || entry.pending || !entry.sha) {
      if (this.canCommit()) this.start('commit');
      return;
    }
    if (!this.canWrite()) return;
    this.ui.status = '';
    this.ui.mode = 'confirmCommit';
  }

  chooseCommit(kind) {
    this.ui.mode = 'review';
    const choose = CHOOSE_COMMIT[kind] ?? CHOOSE_COMMIT.commit;
    choose(this);
  }

  onUpdate() {
    if (!this.canWrite()) return;
    const entry = this.selected();
    if (!entry || !entry.sha) return;
    this.ui.ops.hold(this.update(entry));
  }

  async update(entry) {
    const staged = await hasStagedChanges(this.ui);
    if (!staged) {
      this.ui.status = 'nothing to commit';
      return;
    }
    if (!this.ui.repo.updateCommit) {
      this.ui.status = 'read only';
      return;
    }
    const after = (extra) => this.refreshAfterWrite(extra);
    this.ui.ops.runWrite(
      'updateCommit',
      [entry.sha],
      'updating',
      'updated',
      after,
    );
  }

  cancelCommitChoice() {
    this.ui.mode = 'review';
  }

  onCommit() {
    if (this.ui.nav.pane === 'commits') return;
    this.show();
  }

  onShowDiff() {
    const ui = this.ui;
    if (ui.mode === 'compose') return;
    const entry = this.selected();
    if (!entry) return;
    const viewingCommit = Boolean(ui.rev || ui.revShort);
    if (entry.pending && !viewingCommit) return void this.onInsert();
    const sha = entry.pending ? '' : entry.sha || '';
    ui.rev = sha;
    ui.revShort = sha ? entry.shortSha || '' : '';
    const afterLoad = () => {
      const nav = ui.nav;
      nav.tasksOpen = false;
      nav.scroll = 0;
      nav.index = 0;
      nav.pane = ui.items.length ? 'diff' : 'files';
      ui.syncReviewPath();
      ui.syncFileCursor();
      ui.status = '';
    };
    ui.refreshFromRepo({ keepEmpty: true, afterLoad });
  }

  onAmend() {
    if (this.canWrite()) this.start('amend');
  }

  onReword() {
    if (!this.canWrite()) return;
    this.start('reword');
  }

  onUpdateTime() {
    if (!this.canWrite()) return;
    const rows = this.selectedRows().filter((entry) => entry.sha);
    if (!rows.length) return;
    if (!this.ui.repo.updateCommitTimes) {
      this.ui.status = 'read only';
      return;
    }
    const shas = rows.map((entry) => entry.sha);
    const after = (extra) => this.refreshAfterWrite(extra);
    this.ui.ops.runWrite(
      'updateCommitTimes',
      [shas],
      'updating time',
      'updated',
      after,
    );
  }

  onFixup() {
    if (this.canWrite()) this.start('fixup');
  }

  onApply() {
    if (!this.canWrite()) return;
    const entry = this.selected();
    if (!isFixupCommit(entry) || !entry.sha) return;
    if (!this.ui.repo.applyFixup) {
      this.ui.status = 'read only';
      return;
    }
    const after = (extra) => this.refreshAfterWrite(extra);
    this.ui.ops.runWrite(
      'applyFixup',
      [entry.sha],
      'applying',
      'applied',
      after,
    );
  }

  submit(kind, done, run, settle = null) {
    this.ui.composer.closeCompose();
    const after = () => {
      if (settle) settle();
      this.refreshAfterWrite({ doneStatus: done });
    };
    this.ui.ops.runBusy(kind, done, run, after);
  }

  finishReword(message) {
    const ui = this.ui;
    const entry = this.selected();
    if (!entry || !entry.sha || !ui.repo.reword) {
      ui.status = 'read only';
      return;
    }
    const done = COMMIT_STATUS.reword;
    const run = (top) => ui.repo.reword(top, entry.sha, message);
    this.submit('rewording', done, run);
  }

  finishGitCommit() {
    const ui = this.ui;
    const composer = ui.composer;
    const kind = composer.commitKind;
    let message = composer.editor ? composer.editor.text : '';
    if (isInPlaceCommit(kind) && this.brief) {
      message = joinMessage(message, composer.commitBody);
    }
    message = tidyCommitMessage(message);
    if (!message.trim()) {
      ui.status = 'empty commit message';
      return;
    }
    ui.ops.hold(this.send(kind, message));
  }

  async send(kind, message) {
    const ui = this.ui;
    const staged = await this.stagedFor(kind);
    if (!staged) {
      ui.composer.closeCompose();
      ui.status = 'nothing to commit';
      return;
    }
    if (kind === 'reword') return void this.finishReword(message);
    if (kind === 'squash') return void this.finishSquash(message);
    const done = COMMIT_STATUS[kind] ?? 'committed';
    const run = (top) => ui.repo.commit(top, kind, message);
    const settle = () => ui.collection.clearDismissed();
    this.submit('committing', done, run, settle);
  }

  squashMessage() {
    const shas = this.squashShas;
    const rows = this.commits.filter((entry) => shas.includes(entry.sha));
    return squashText(rows);
  }

  onSquash() {
    if (!this.canWrite()) return;
    const rows = this.selectedRows().filter((entry) => entry.sha);
    if (rows.length < 2) return;
    if (!this.ui.repo.squashCommits) {
      this.ui.status = 'read only';
      return;
    }
    this.squashShas = rows.map((entry) => entry.sha);
    const list = listedCommits(this.commits);
    const oldest = rows.at(-1);
    const at = list.findIndex((entry) => entry.sha === oldest.sha);
    if (at >= 0) this.ui.nav.commitCursor = at;
    this.start('squash');
  }

  finishSquash(message) {
    const ui = this.ui;
    const shas = this.squashShas;
    this.squashShas = [];
    if (shas.length < 2 || !ui.repo.squashCommits) {
      ui.status = 'read only';
      return;
    }
    const done = COMMIT_STATUS.squash;
    const run = (top) => ui.repo.squashCommits(top, shas, message);
    this.submit('squashing', done, run);
  }

  onDropCommit() {
    if (!this.canWrite()) return;
    const rows = this.selectedRows().filter((entry) => entry.sha);
    if (!rows.length) return;
    this.dropShas = rows.map((entry) => entry.sha);
    this.dropName = rows.map((entry) => entry.shortSha || entry.sha).join(', ');
    this.dropSha = rows[0].sha;
    this.ui.mode = 'confirmDrop';
    this.ui.status = '';
  }

  cancelDropCommit() {
    this.ui.mode = 'review';
    this.dropName = '';
    this.dropSha = '';
    this.dropShas = [];
    this.ui.status = '';
  }

  confirmDropCommit() {
    const shas = this.dropShas;
    const sha = this.dropSha;
    const done = `dropped ${this.dropName}`;
    this.ui.mode = 'review';
    this.dropName = '';
    this.dropSha = '';
    this.dropShas = [];
    if (!sha) return;
    const method = shas.length > 1 ? 'dropCommits' : 'dropCommit';
    if (!this.ui.repo[method]) {
      this.ui.status = 'read only';
      return;
    }
    const after = (extra) => this.refreshAfterWrite(extra);
    const target = shas.length > 1 ? shas : sha;
    this.ui.ops.runWrite(method, [target], 'dropping', done, after);
  }

  onView() {
    if (this.ui.nav.pane !== 'commits') return;
    this.commitView = this.brief ? 'full' : 'brief';
    this.ui.nav.listScroll = 0;
    this.ui.status = this.commitView;
    const root = this.ui.root;
    saveUiPrefs(root, { commitView: this.commitView });
  }
}

module.exports = { listedCommits, CommitController };
