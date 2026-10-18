'use strict';

const path = require('node:path');
const { fileEntries, fileTotals } = require('../common/files.js');
const { listedCommits } = require('./commit.js');
const { lineHasDiff } = require('../input/actions.js');
const { noteCounts } = require('../review/review.js');
const { unitLines, itemsForPath, mergeEditRows } = require('../diff/diff.js');
const unit = require('./unit.js');
const { cmpEn } = require('../common/utilities.js');

const relabelStatus = (entries, from, to) => {
  if (!to) return entries;
  return entries.map((entry) => {
    if (entry.status !== from) return entry;
    return { ...entry, status: to };
  });
};

const repoNameOf = (ui) => {
  if (ui.repoName) return ui.repoName;
  return path.basename(ui.root || '');
};

const blankEntry = (rel) => ({
  path: rel,
  origins: [],
  firstIndex: 0,
  openIndex: 0,
  remaining: 0,
  added: 0,
  removed: 0,
  stagedAdded: 0,
  stagedRemoved: 0,
  unstagedAdded: 0,
  unstagedRemoved: 0,
  staged: 0,
  unstaged: 0,
  date: '',
  status: '',
});

const mergeUnitFiles = (entries, names) => {
  const have = new Set();
  for (const entry of entries) have.add(entry.path);
  const extra = [];
  for (const rel of names) {
    if (!rel || have.has(rel)) continue;
    extra.push(blankEntry(rel));
  }
  const merged = [...entries, ...extra];
  merged.sort((left, right) => cmpEn(left.path, right.path));
  return merged;
};

const fileList = (ui) => {
  const entries = fileEntries(ui.collection.items);
  const sourceLabel = ui.sourceLabel;
  const from = sourceLabel ? 'pr' : 'commit';
  const to = sourceLabel || ui.revShort;
  const labeled = relabelStatus(entries, from, to);
  if (ui.nav.fileScope !== 'file') return labeled;
  return mergeUnitFiles(labeled, ui.reads.names);
};

const counts = (ui, notes = noteCounts(ui.review.store)) => {
  const next = {
    staged: 0,
    unstaged: 0,
    untracked: 0,
    commit: 0,
    pr: 0,
    tasks: 0,
    tasksDone: 0,
    feedback: 0,
    code: 0,
  };
  for (const item of ui.collection.items) {
    if (!Object.hasOwn(next, item.origin)) continue;
    next[item.origin] += 1;
  }
  next.feedback = notes.feedback;
  next.tasks = notes.tasks;
  next.tasksDone = notes.tasksDone;
  next.code = notes.code;
  return next;
};

const viewStatus = (ui) => {
  if (ui.status || ui.busy) return ui.status || ui.busy;
  if (ui.nav.pane === 'tasks' && ui.mode === 'compose') {
    return 'Enter: new line; Esc: save and exit editing';
  }
  return '';
};

const unitBodyLines = (ui) => {
  if (ui.nav.pane !== 'unit') return [];
  const rel = ui.nav.reviewPath;
  const group = itemsForPath(ui.collection.items, rel);
  const live = ui.composer.liveFileText();
  if (live !== null) {
    const base = ui.composer.fileEditRows;
    if (base && base.length) return mergeEditRows(base, live);
    return mergeEditRows(unitLines(live, group), live);
  }
  return unitLines(unit.fileText(ui, rel), group);
};

const pendingLines = (items, rev, revShort) => {
  if (rev || revShort) return null;
  for (const item of items) {
    if (item.origin === 'commit' || item.origin === 'pr') return null;
  }
  return fileTotals(fileEntries(items));
};

const commitRows = (ui) => {
  const rows = listedCommits(ui.commits.commits);
  const lines = pendingLines(ui.collection.items, ui.rev, ui.revShort);
  if (!lines) return rows;
  rows[0] = {
    ...rows[0],
    added: lines.added,
    removed: lines.removed,
    stagedAdded: lines.stagedAdded,
    unstagedAdded: lines.unstagedAdded,
    stagedRemoved: lines.stagedRemoved,
    unstagedRemoved: lines.unstagedRemoved,
  };
  return rows;
};

const navView = (ui) => {
  const { nav } = ui;
  return {
    item: ui.current(),
    index: nav.index,
    total: ui.collection.items.length,
    scroll: nav.scroll,
    listScroll: nav.listScroll,
    selection: nav.selection,
    contextMenu: nav.contextMenu,
    pane: nav.pane,
    fileScope: nav.fileScope,
    fileCursor: nav.fileCursor,
    find: nav.find,
    import: nav.import,
    reviewPath: nav.reviewPath,
    unitLine: nav.unitLine,
    branchCursor: nav.branchCursor,
    commitCursor: nav.commitCursor,
    packagesCursor: nav.packagesCursor,
  };
};

const dropNameOf = (ui) => {
  const { packages, gitBranches, commits, npm, worktrees } = ui;
  const name = packages.dropName || gitBranches.dropName;
  return name || commits.dropName || npm.dropName || worktrees.dropName;
};

// One tile looks selected: the one under the cursor while the worktrees have
// the focus, else the worktree that is shown
const treesView = (ui) => {
  const model = ui.trees.view();
  const picked = ui.worktrees.focused() ? model.cursor : model.current;
  return { ...model, cursor: picked < 0 ? model.cursor : picked };
};

const paneTrees = (ui, pane) => {
  if (pane !== 'branches' || !ui.worktrees.hasPanels()) return null;
  return treesView(ui);
};

const repoView = (ui) => {
  const { change, updater } = ui;
  return {
    status: viewStatus(ui),
    progressFrame: ui.progressFrame,
    layout: ui.layout,
    lineNumbers: ui.lineNumbers === true,
    counts: counts(ui, noteCounts(ui.review.store)),
    files: fileList(ui),
    unitLines: unitBodyLines(ui),
    branch: ui.branch,
    branches: ui.gitBranches.branches,
    commits: commitRows(ui),
    commitView: ui.commits.commitView,
    quitWarning: ui.quitWarning || '',
    repoName: repoNameOf(ui),
    rev: ui.rev || '',
    revShort: ui.revShort || '',
    sourceLabel: ui.sourceLabel || '',
    sourceKind: (change && change.source) || '',
    mode: ui.mode,
    updateFrom: updater.from,
    updateTo: updater.to,
    dropName: dropNameOf(ui),
    worktreeTarget: ui.worktrees.branchTarget,
  };
};

const composeView = (composer) => {
  const templates = composer.templates.shownTemplates();
  return {
    compose: composer.composeView(),
    noteText: composer.idleNoteText(),
    codeOverlay: composer.codeOverlayView(),
    templates,
    templateIndex: composer.templates.clampedTemplateIndex(templates),
  };
};

const screenView = (ui) => {
  const { pane } = ui.nav;
  return {
    dashboard: pane === 'dashboard' ? ui.dashboard.view() : null,
    packages: pane === 'packages' ? ui.dashboard.packagesView() : null,
    repos: pane === 'repos' ? ui.workspace.view() : null,
    trees: paneTrees(ui, pane),
    treeFocus: ui.worktrees.focused(),
  };
};

const view = (ui) => {
  const { pane } = ui.nav;
  return {
    ...navView(ui),
    ...repoView(ui),
    ...ui.npm.view(pane === 'npm'),
    ...ui.agents.view(pane === 'agents'),
    ...composeView(ui.composer),
    ...ui.composer.tasks.view(pane === 'tasks'),
    ...screenView(ui),
  };
};

const commitTarget = (ui) => {
  const entry = listedCommits(ui.commits.commits)[ui.commitCursor];
  const canCommit = ui.commits.staged;
  const unstagedCurrent = !ui.rev && !ui.revShort;
  return { ...entry, canCommit, unstagedCurrent };
};

const unitTarget = (ui) => {
  const item = ui.current();
  const lines = unitBodyLines(ui);
  if (!lines.length) return item;
  const line = lines[ui.nav.unitLine] ?? null;
  const lineDiff = lineHasDiff(line);
  if (!item) return { lineDiff };
  return { ...item, lineDiff };
};

// The entry an action of each pane works on
const PANE_TARGET = {
  files: (ui) => ui.fileCursorEntry(),
  branches: (ui) => ui.branches[ui.branchCursor],
  commits: commitTarget,
  unit: unitTarget,
};

const currentTarget = (ui) => {
  const target = PANE_TARGET[ui.pane];
  return target ? target(ui) : ui.current();
};

module.exports = { fileList, counts, unitBodyLines, currentTarget, view };
