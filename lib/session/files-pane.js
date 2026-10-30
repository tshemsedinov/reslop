'use strict';

const { THEME_NAMES, setTheme, themeName } = require('../term/ansi.js');
const files = require('../common/files.js');
const { isTasksEntry, TASKS_FILE, listPath, selectableRow } = files;
const { logViewRows } = require('../render/log.js');
const { openUnitFile, moveUnitBlock } = require('./unit.js');
const { LIST_PANES } = require('../input/actions.js');
const { saveUiPrefs, LAYOUT_LABEL } = require('./prefs.js');
const view = require('./view.js');
const { allFiles, folderAt, folderRows, folderFocused, listRows } = view;
const { folderOf } = require('../common/paths.js');
const { clamp } = require('../common/utilities.js');

const LAYOUTS = ['unified', 'mixed', 'side'];

const fileCursorEntry = (ui) => ui.fileList()[ui.nav.fileCursor] ?? null;

const clampIndex = (ui) => ui.nav.clampIndex(ui.items.length);

const syncReviewPath = (ui) => ui.nav.syncReviewPath(ui.current());

const clampFileCursor = (ui) => ui.nav.clampFileCursor(ui.fileList().length);

// The tree follows the reviewed file to its folder
const followReviewPath = (ui) => {
  const rel = ui.nav.reviewPath;
  if (rel && allFiles(ui).some((entry) => entry.path === rel)) {
    ui.nav.folder = folderOf(rel);
  }
  ui.nav.followReviewPath(ui.fileList(), ui.current());
};

const syncFileCursor = (ui) => {
  if (ui.nav.pane === 'files') return void clampFileCursor(ui);
  followReviewPath(ui);
};

const showFiles = (ui) => {
  const nav = ui.nav;
  const listed = nav.pane !== 'files' && LIST_PANES.includes(nav.pane);
  const held = nav.tasksOpen === true || listed;
  nav.openList('files');
  followReviewPath(ui);
  nav.folderFocus = false;
  nav.tasksOpen = false;
  if (held) ui.lifecycle.catchUpWatch();
};

const viewingCommit = (ui) => !ui.change && Boolean(ui.rev || ui.revShort);

const releaseCommit = (ui) => {
  if (!viewingCommit(ui)) return;
  ui.rev = '';
  ui.revShort = '';
  ui.refreshFromRepo({ keepEmpty: true });
};

const showDashboard = (ui) => {
  const nav = ui.nav;
  const held = nav.pane !== 'dashboard';
  nav.pane = 'dashboard';
  nav.tasksOpen = false;
  nav.scroll = 0;
  nav.clearSelection();
  ui.status = '';
  releaseCommit(ui);
  if (held) ui.lifecycle.catchUpWatch();
  ui.dashboard.enter();
};

const returnsHome = (ui) => {
  if (!ui.dashboardHome) return false;
  const { pane, tasksOpen } = ui.nav;
  return LIST_PANES.includes(pane) || tasksOpen === true;
};

// Escape goes back the way the pane was entered
const leavePane = (ui) => {
  const commitDiff = ui.nav.pane === 'diff' && viewingCommit(ui);
  if (returnsHome(ui) || (ui.dashboardHome && commitDiff)) {
    return void showDashboard(ui);
  }
  if (ui.nav.pane === 'files') return void ui.onQuit();
  showFiles(ui);
};

// A pane that has a menu or a log open closes that first
const PANE_ESCAPE = {
  agents: (ui) => {
    if (ui.agents.pick) return void ui.agents.closePick();
    if (ui.agents.viewing) return void ui.agents.closeView();
    leavePane(ui);
  },
  npm: (ui) => {
    if (ui.npm.viewing) return void ui.npm.closeView();
    leavePane(ui);
  },
  repos: (ui) => ui.onQuit(),
  unit: (ui) => {
    if (!ui.nav.backToTasks) return void leavePane(ui);
    ui.nav.backToTasks = false;
    ui.composer.tasks.openTasksPage();
  },
  dashboard: (ui) => {
    if (ui.workspaceRoot) return void ui.workspace.show();
    ui.onQuit();
  },
};

const onEscape = (ui) => (PANE_ESCAPE[ui.nav.pane] ?? leavePane)(ui);

const onFiles = (ui) => {
  if (ui.nav.pane === 'files') {
    if (!ui.nav.reviewPath) return;
    if (ui.nav.fileScope === 'file') {
      const list = ui.fileList();
      const entry = list[ui.nav.fileCursor];
      if (entry && !isTasksEntry(entry)) openUnitFile(ui, entry);
      return;
    }
    ui.nav.pane = 'diff';
    return void ui.nav.clearSelection();
  }
  showFiles(ui);
};

// Both panels keep their selection, the arrows move the focused one
const focusFolders = (ui) => {
  if (ui.nav.folderFocus) return;
  ui.nav.clearListPick();
  ui.nav.folderFocus = true;
  ui.status = '';
};

const focusFiles = (ui) => {
  ui.nav.folderFocus = false;
  ui.status = '';
};

const toggleFolderFocus = (ui) => {
  if (ui.nav.folderFocus) focusFiles(ui);
  else focusFolders(ui);
};

const openFileEntry = (ui) => {
  if (folderFocused(ui)) return void focusFiles(ui);
  const list = ui.fileList();
  const entry = list[ui.nav.fileCursor];
  if (!entry) return;
  if (isTasksEntry(entry)) {
    ui.composer.tasks.openTasksPage();
    ui.status = '';
    return;
  }
  ui.nav.tasksOpen = false;
  ui.nav.index = entry.openIndex ?? entry.firstIndex;
  if (ui.nav.fileScope === 'file') {
    return void openUnitFile(ui, entry);
  }
  ui.nav.pane = 'diff';
  ui.nav.scroll = 0;
  ui.status = '';
  ui.nav.clearSelection();
  syncReviewPath(ui);
};

const openBranch = (ui) => {
  if (ui.worktrees.focused()) {
    return void ui.ops.hold(ui.worktrees.enterSelected());
  }
  ui.gitBranches.onCheckoutBranch();
};

const PANE_OPEN = {
  files: openFileEntry,
  packages: () => {},
  branches: openBranch,
  commits: (ui) => ui.commits.onShowDiff(),
  npm: (ui) => ui.npm.run(),
  agents: (ui) => ui.agents.enter(),
};

const onOpenFile = (ui) => {
  const open = PANE_OPEN[ui.nav.pane];
  if (open) return void open(ui);
  if (ui.nav.tasksOpen) ui.composer.tasks.editFocusedTask();
};

const placeChosenFile = (ui) => {
  const entry = ui.fileList()[ui.nav.fileCursor];
  if (!entry) return;
  if (isTasksEntry(entry)) {
    ui.nav.reviewPath = TASKS_FILE;
    return;
  }
  ui.nav.reviewPath = entry.path;
  ui.nav.index = entry.firstIndex;
};

// The file a switch between all files and the changes stays on: the one
// under the cursor of the list, else the one reviewed
const cursorPath = (ui) => {
  const entry = ui.nav.pane === 'files' ? fileCursorEntry(ui) : null;
  return entry && !isTasksEntry(entry) ? entry.path : ui.nav.reviewPath;
};

const applyFileScope = (ui, next, quiet, rel) => {
  const nav = ui.nav;
  nav.fileScope = next;
  if (rel) nav.reviewPath = rel;
  followReviewPath(ui);
  const entry = fileCursorEntry(ui);
  // A file without changes is not in the changes: the cursor's file is
  if (entry && (entry.path !== rel || entry.firstIndex !== undefined)) {
    placeChosenFile(ui);
  }
  const label = next === 'file' ? 'file scope' : 'diff mode';
  ui.status = quiet ? '' : label;
};

const listScope = async (ui, quiet, rel) => {
  await ui.reads.loadNames();
  applyFileScope(ui, 'file', quiet, rel);
};

const setFileScope = (ui, next, quiet = false, rel = cursorPath(ui)) => {
  if (ui.nav.pane !== 'files' || ui.nav.fileScope === next) return;
  if (next === 'file') return void ui.ops.hold(listScope(ui, quiet, rel));
  applyFileScope(ui, next, quiet, rel);
};

const pickFolder = (ui, key) => {
  const nav = ui.nav;
  nav.folder = key;
  nav.fileCursor = 0;
  nav.resetListScroll('files');
  nav.clearListPick();
  if (ui.fileList().length) placeChosenFile(ui);
  else nav.reviewPath = null;
  ui.status = '';
};

const moveFolder = (ui, delta) => {
  const rows = folderRows(ui);
  const at = rows.findIndex((row) => row.key === folderAt(ui));
  const next = clamp(at + delta, 0, rows.length - 1);
  if (next !== at) pickFolder(ui, rows[next].key);
};

const onFileMove = (ui, delta, extend = false) => {
  if (folderFocused(ui)) return void moveFolder(ui, delta);
  const list = ui.fileList();
  if (!list.length) {
    ui.status = 'nothing to review';
    return;
  }
  const before = ui.nav.fileCursor;
  ui.nav.moveList(delta, list.length, extend);
  if (!extend && ui.nav.fileCursor === before) return;
  placeChosenFile(ui);
  ui.status = '';
};

// The tree and the worktree tiles give the focus to the list they stand by
const onSelectAll = (ui) => {
  const nav = ui.nav;
  if (folderFocused(ui)) focusFiles(ui);
  if (nav.pane === 'branches') nav.treeFocus = false;
  const eligible = (entry) => selectableRow(nav.pane, entry, ui);
  if (nav.selectAll(listRows(ui), eligible)) ui.status = '';
};

// A file opens on its first unstaged block, on the first one if all staged
const entryIndex = (list, first) => {
  const rel = listPath(list[first]);
  for (let i = first; i < list.length && listPath(list[i]) === rel; i++) {
    if (list[i].origin === 'unstaged') return i;
  }
  return first;
};

const moveRemaining = (ui, step, extend = false) => {
  const list = ui.items;
  if (!list.length) {
    ui.status = 'nothing to review';
    return;
  }
  if (extend) {
    ui.nav.moveList(step, list.length, true);
    ui.nav.scroll = 0;
    ui.status = '';
    return void syncReviewPath(ui);
  }
  const at = ui.nav.index;
  let next = at + step;
  if (next < 0 || next >= list.length) return;
  if (step > 0 && listPath(list[next]) !== listPath(list[at])) {
    next = entryIndex(list, next);
  }
  ui.nav.index = next;
  ui.nav.scroll = 0;
  ui.status = '';
  ui.nav.clearSelection();
  syncReviewPath(ui);
};

const onNext = (ui) => {
  if (ui.nav.pane === 'unit') return void moveUnitBlock(ui, 1);
  if (ui.nav.pane === 'tasks') return void ui.composer.tasks.moveTaskFocus(1);
  moveRemaining(ui, 1);
};

const onPrev = (ui) => {
  if (ui.nav.pane === 'unit') return void moveUnitBlock(ui, -1);
  if (ui.nav.pane === 'tasks') return void ui.composer.tasks.moveTaskFocus(-1);
  moveRemaining(ui, -1);
};

const scrollStep = (ui, fraction) => {
  const frame = ui.lastFrame;
  const size = ui.lastSize ?? ui.getSize();
  const rows = size.height ?? 24;
  const fallback = Math.max(1, rows - 4);
  const bodyH = frame?.bodyH ?? fallback;
  const viewing = ui.nav.pane === 'npm' && ui.npm.viewing;
  const agentLog = ui.nav.pane === 'agents' && ui.agents.viewing;
  const viewRows = viewing || agentLog ? logViewRows(bodyH) : bodyH;
  const height = Math.max(1, viewRows);
  const span = Math.floor(height * Math.abs(fraction));
  const lines = Math.max(1, span);
  if (fraction < 0) return -lines;
  return lines;
};

const movePackages = (ui, delta, extend) => {
  ui.nav.moveList(delta, ui.dashboard.packageCount(), extend);
  ui.status = '';
};

const PANE_MOVE = {
  dashboard: () => {},
  files: (ui, delta, extend) => onFileMove(ui, delta, extend),
  branches: (ui, delta, extend) => ui.gitBranches.onBranchMove(delta, extend),
  commits: (ui, delta, extend) => ui.commits.onCommitMove(delta, extend),
  npm: (ui, delta, extend) => ui.npm.move(delta, extend),
  agents: (ui, delta, extend) => ui.agents.move(delta, extend),
  packages: movePackages,
};

// Dragging the thumb of a list carries its cursor along with its rows
const onListBar = (ui, target, from, start) => {
  const nav = ui.nav;
  const delta = start - from;
  if (!delta) return;
  if (target === 'folders') {
    moveFolder(ui, delta);
    nav.folderScroll = start;
    return;
  }
  const move = PANE_MOVE[nav.pane];
  if (!move) return;
  if (nav.pane === 'files') nav.folderFocus = false;
  if (nav.pane === 'branches') nav.treeFocus = false;
  move(ui, delta, false);
  nav.listScroll = start;
};

const onScroll = (ui, delta, extend = false) => {
  if (ui.composer.tasks.planOpen && ui.nav.pane === 'tasks') {
    const step = delta < 0 ? -1 : 1;
    return void ui.composer.tasks.movePlan(step);
  }
  if (extend && ui.nav.pane === 'diff') {
    return void moveRemaining(ui, delta, true);
  }
  const move = PANE_MOVE[ui.nav.pane];
  if (move) return void move(ui, delta, extend);
  if (ui.nav.tasksOpen && ui.composer.tasks.taskRowCount() > 1) {
    return void ui.composer.tasks.moveTaskFocus(delta);
  }
  const frame = ui.lastFrame;
  const max = frame ? frame.scrollMax : null;
  const scroll = ui.nav.scroll;
  const current = max === null ? scroll : Math.min(scroll, max);
  const moved = current + delta;
  const next = max === null ? moved : Math.min(max, moved);
  ui.nav.scroll = Math.max(0, next);
  ui.nav.clearSelection();
};

const onJump = (ui, toEnd) => {
  if (ui.nav.pane === 'dashboard') return;
  if (LIST_PANES.includes(ui.nav.pane)) {
    const delta = toEnd ? Number.MAX_SAFE_INTEGER : -Number.MAX_SAFE_INTEGER;
    return void onScroll(ui, delta);
  }
  if (ui.nav.tasksOpen && ui.composer.tasks.taskRowCount() > 0) {
    const last = ui.composer.tasks.taskRowCount() - 1;
    const target = toEnd ? last : 0;
    const at = ui.composer.tasks.clampedTaskFocus();
    return void ui.composer.tasks.moveTaskFocus(target - at);
  }
  const frame = ui.lastFrame;
  const max = frame ? frame.scrollMax : 0;
  ui.nav.scroll = toEnd ? max : 0;
  ui.nav.clearSelection();
};

const onLayout = (ui) => {
  const i = LAYOUTS.indexOf(ui.layout);
  const next = (i < 0 ? 0 : i + 1) % LAYOUTS.length;
  ui.layout = LAYOUTS[next];
  ui.status = LAYOUT_LABEL[ui.layout] || ui.layout;
  ui.nav.scroll = 0;
  ui.nav.clearSelection();
  saveUiPrefs(ui.root, { layout: ui.layout });
};

const saveLineNumbers = (ui) => {
  const lineNumbers = ui.lineNumbers === true;
  saveUiPrefs(ui.root, { lineNumbers });
};

const onLineNumbers = (ui) => {
  ui.lineNumbers = ui.lineNumbers !== true;
  ui.status = ui.lineNumbers ? 'line numbers' : 'no line numbers';
  saveLineNumbers(ui);
  ui.composer.syncCodeScroll();
};

const onTheme = (ui) => {
  const i = THEME_NAMES.indexOf(themeName());
  const theme = THEME_NAMES[(i + 1) % THEME_NAMES.length];
  setTheme(theme);
  ui.status = theme;
  saveUiPrefs(ui.root, { theme });
};

const onHome = (ui) => onJump(ui, false);
const onEnd = (ui) => onJump(ui, true);
const onFileScope = (ui) => setFileScope(ui, 'file');
const onDiffScope = (ui) => setFileScope(ui, 'diff');

module.exports = {
  fileCursorEntry,
  clampIndex,
  syncReviewPath,
  syncFileCursor,
  showFiles,
  onEscape,
  onFiles,
  focusFolders,
  focusFiles,
  toggleFolderFocus,
  onOpenFile,
  placeChosenFile,
  cursorPath,
  setFileScope,
  pickFolder,
  onSelectAll,
  onNext,
  onPrev,
  scrollStep,
  onListBar,
  onScroll,
  onLayout,
  onLineNumbers,
  onTheme,
  onHome,
  onEnd,
  onFileScope,
  onDiffScope,
};
