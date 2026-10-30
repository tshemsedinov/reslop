'use strict';

const { COMPOSE_LEAVE } = require('./compose.js');
const actions = require('../input/actions.js');
const { LIST_PANES, DASH_BLOCKS, DASH_ALLOWED, CONFIRM_MODE } = actions;
const { REPOS_ALLOWED, disabledActions, actionFromKey, confirmKey } = actions;
const { groupActions, taskKeyAction } = actions;
const { onCommand } = require('./change-actions.js');
const filesPane = require('./files-pane.js');
const { handlePointer, handleContextKey } = require('./pointer.js');
const prompts = require('./prompts.js');
const { FIND_PANES, startFind, onFindKey, startImport, stopImport } = prompts;
const { onImportKey } = prompts;
const taskActions = require('./task-actions.js');
const { openFocused, toggleDone, startTaskFind } = taskActions;
const { priorityMenu, groupMenu, toggleBlockMenu } = taskActions;
const { currentTarget, treeShown } = require('./view.js');
const clipboard = require('../term/select.js');
const { extractText } = clipboard;
const { isTextKey } = require('../input/keys.js');

const DASH_HANDLERS = {};
for (const id in DASH_BLOCKS) {
  const block = DASH_BLOCKS[id];
  DASH_HANDLERS[id] = (ui) => ui.dashboard.open(block);
}

// The keys of a branch do the same to the selected tile of the worktrees
const TREE_ACTIONS = {
  newBranch: 'worktreeNew',
  drop: 'worktreeDrop',
};
const TREE_OFF = ['rebase', 'commit'];

// The task actions that read the edited text before it is written back,
// or open a pop-up at its cursor
const TASK_LIVE = [
  'taskDone',
  'taskOpen',
  'taskPriority',
  'taskGroup',
  'taskField',
];

const CONFIRMATIONS = {
  confirmQuit: {
    confirm: (ui) => ui.confirmQuit(),
    cancel: (ui) => ui.cancelQuit(),
  },
  confirmUpdate: {
    accept: (ui) => ui.updater.accept(),
    decline: (ui) => ui.updater.decline(),
  },
  confirmAgentInstall: {
    confirm: (ui) => ui.agents.confirmInstall(),
    cancel: (ui) => ui.agents.cancelInstall(),
  },
  confirmAgentAuth: {
    confirm: (ui) => ui.agents.confirmAuth(),
    cancel: (ui) => ui.agents.cancelAuth(),
  },
  confirmDrop: {
    confirm: (ui) => {
      if (ui.composer.tasks.dropName) {
        return void ui.composer.tasks.confirmDrop();
      }
      if (ui.packages.dropName) return void ui.packages.confirmDrop();
      if (ui.npm.dropName) return void ui.npm.confirmDrop();
      if (ui.commits.dropName) return void ui.commits.confirmDropCommit();
      ui.gitBranches.confirmDropBranch();
    },
    cancel: (ui) => {
      if (ui.composer.tasks.dropName) {
        return void ui.composer.tasks.cancelDrop();
      }
      if (ui.packages.dropName) return void ui.packages.cancelDrop();
      if (ui.npm.dropName) return void ui.npm.cancelDrop();
      if (ui.commits.dropName) return void ui.commits.cancelDropCommit();
      ui.gitBranches.cancelDropBranch();
    },
  },
  confirmWorktree: {
    confirm: (ui) => ui.worktrees.confirmDrop(),
    cancel: (ui) => ui.worktrees.cancelDrop(),
  },
  confirmCreateWorktree: {
    confirm: (ui) => ui.worktrees.confirmBranch(),
    cancel: (ui) => ui.worktrees.cancelBranch(),
  },
  confirmPush: {
    force: (ui) => ui.gitBranches.onForcePush(),
    cancel: (ui) => ui.gitBranches.cancelPush(),
  },
  confirmCommit: {
    update: (ui) => ui.commits.chooseCommit('update'),
    commit: (ui) => ui.commits.chooseCommit('commit'),
    amend: (ui) => ui.commits.chooseCommit('amend'),
    fixup: (ui) => ui.commits.chooseCommit('fixup'),
    cancel: (ui) => ui.commits.cancelCommitChoice(),
  },
};

const NPM_VIEW_KEYS = {
  escape: (ui) => ui.npm.closeView(),
  s: (ui) => {
    if (ui.npm.viewedRunning()) ui.npm.stop();
  },
  'ctrl-t': (ui) => {
    if (!ui.npm.viewedRunning()) ui.npm.solve();
  },
  r: (ui) => ui.npm.rerun(),
  v: (ui) => ui.npm.toggleVerbose(),
  e: () => {},
  i: () => {},
};

const NPM_LIST_KEYS = {
  'ctrl-up': (ui) => ui.npm.reorder(-1),
  'ctrl-down': (ui) => ui.npm.reorder(1),
  up: (ui) => ui.npm.move(-1),
  down: (ui) => ui.npm.move(1),
  right: (ui) => ui.npm.focusRuns(),
  left: (ui) => ui.npm.focusCommands(),
  tab: (ui) => ui.npm.toggleFocus(),
  'shift-tab': (ui) => ui.npm.toggleFocus(),
};

const AGENT_VIEW_KEYS = {
  escape: (ui) => ui.agents.closeView(),
  s: (ui) => ui.agents.stop(),
  r: (ui) => ui.agents.rerun(),
  e: () => {},
  m: () => {},
  a: () => {},
  o: () => {},
  x: () => {},
  t: () => {},
  f: () => {},
};

const AGENT_LIST_KEYS = {
  right: (ui) => ui.agents.focusRuns(),
  left: (ui) => ui.agents.focusCli(),
  tab: (ui) => ui.agents.toggleFocus(),
  'shift-tab': (ui) => ui.agents.toggleFocus(),
};

const FILES_KEYS = {
  left: filesPane.focusFolders,
  right: filesPane.focusFiles,
  tab: filesPane.toggleFolderFocus,
  'shift-tab': filesPane.toggleFolderFocus,
};

// The keys the task text box leaves to the screen: it types everything else
const TASK_LEAVES = ['escape', 'tab', 'shift-tab'];

// On the fast mode switch the space flips it and the arrows pick a side
const FAST_KEYS = {
  ' ': (ui) => ui.agents.toggleFast(),
  left: (ui) => ui.agents.setFast('on'),
  right: (ui) => ui.agents.setFast('off'),
};

// The modes that take every key for themselves
const MODE_KEYS = {
  compose: (ui, key) => ui.runComposeCommand(ui.composer.handleKey(key)),
  find: onFindKey,
  import: onImportKey,
};

const scrollBy = (fraction) => (ui) =>
  filesPane.onScroll(ui, filesPane.scrollStep(ui, fraction));

const HANDLERS = {
  add: (ui) => onCommand(ui, 'add'),
  unstage: (ui) => onCommand(ui, 'unstage'),
  revert: (ui) => onCommand(ui, 'revert'),
  listSelectAll: filesPane.onSelectAll,
  ignore: (ui) => onCommand(ui, 'ignore'),
  next: filesPane.onNext,
  prev: filesPane.onPrev,
  layout: filesPane.onLayout,
  lines: filesPane.onLineNumbers,
  theme: filesPane.onTheme,
  files: filesPane.onFiles,
  open: (ui) => {
    if (ui.pane === 'repos') return void ui.workspace.openSelected();
    filesPane.onOpenFile(ui);
  },
  file: filesPane.onFileScope,
  diff: filesPane.onDiffScope,
  back: filesPane.onEscape,
  home: filesPane.onHome,
  end: filesPane.onEnd,
  scrollUp: (ui) => filesPane.onScroll(ui, -1),
  scrollDown: (ui) => filesPane.onScroll(ui, 1),
  pageUp: scrollBy(-1),
  pageDown: scrollBy(1),
  halfUp: scrollBy(-0.5),
  halfDown: scrollBy(0.5),
  blockTask: (ui) => ui.composer.onBlockTask(),
  code: (ui) => ui.composer.onCode(),
  tasks: (ui) => ui.composer.tasks.onTasks(),
  removeTask: (ui) => {
    if (ui.pane === 'npm') return void ui.npm.askDrop();
    if (ui.pane === 'packages') return;
    ui.composer.tasks.removeFocusedTask();
  },
  reload: (ui) => ui.lifecycle.onReload(),
  commit: (ui) => ui.commits.onCommit(),
  newCommit: (ui) => ui.commits.onInsert(),
  amend: (ui) => ui.commits.onAmend(),
  reword: (ui) => ui.commits.onReword(),
  updateTime: (ui) => ui.commits.onUpdateTime(),
  squash: (ui) => ui.commits.onSquash(),
  apply: (ui) => ui.commits.onApply(),
  fixup: (ui) => ui.commits.onFixup(),
  view: (ui) => ui.commits.onView(),
  branch: (ui) => ui.gitBranches.onBranch(),
  pull: (ui) => ui.gitBranches.onPull(),
  push: (ui) => ui.gitBranches.onPush(),
  newBranch: (ui) => ui.gitBranches.onNewBranch(),
  rebase: (ui) => ui.gitBranches.onRebaseBranch(),
  drop: (ui) => {
    if (ui.pane === 'commits') return void ui.commits.onDropCommit();
    ui.gitBranches.onDropBranch();
  },
  taskNew: (ui) => ui.composer.tasks.insertBelow(),
  blockMenu: (ui) => toggleBlockMenu(ui.composer.tasks),
  taskExpand: (ui) => ui.composer.tasks.toggleExpand(),
  taskDone: (ui) => toggleDone(ui.composer.tasks),
  taskField: (ui) => ui.composer.tasks.fieldFromFocus(),
  taskAgent: (ui) => ui.composer.tasks.toAgents(),
  taskImport: (ui) => startImport(ui),
  taskFind: (ui) => startTaskFind(ui.composer.tasks),
  taskOpen: (ui) => openFocused(ui.composer.tasks),
  taskDrop: (ui) => ui.composer.tasks.removeFocusedTask(),
  taskPriority: (ui) => priorityMenu(ui.composer.tasks),
  taskGroup: (ui) => groupMenu(ui.composer.tasks),
  taskUp: (ui) => ui.composer.tasks.moveIssue(-1),
  taskDown: (ui) => ui.composer.tasks.moveIssue(1),
  plan: (ui) => ui.composer.tasks.togglePlanMenu(),
  npm: (ui) => ui.npm.open(),
  npmEdit: (ui) => ui.npm.edit(),
  npmNew: (ui) => ui.npm.create(),
  npmDrop: (ui) => ui.npm.askDrop(),
  packageNew: (ui) => ui.packages.create(),
  packageDrop: (ui) => ui.packages.askDrop(),
  packageWanted: (ui) => ui.packages.updateWanted(),
  packageLatest: (ui) => ui.packages.updateLatest(),
  npmLogs: (ui) => ui.npm.askLogs(),
  npmStop: (ui) => ui.npm.stop(),
  npmTask: (ui) => ui.npm.solve(),
  npmVerbose: (ui) => ui.npm.toggleVerbose(),
  npmRerun: (ui) => ui.npm.rerun(),
  agentSelect: (ui) => ui.agents.openPick('agent'),
  agentModel: (ui) => ui.agents.openPick('model'),
  agentEffort: (ui) => ui.agents.openPick('effort'),
  agentFast: (ui) => ui.agents.toggleFast(),
  agentContext: (ui) => ui.agents.openPick('context'),
  agentReview: (ui) => ui.agents.openPick('plan'),
  agentInstall: (ui) => ui.agents.proposeInstall(),
  agentAuth: (ui) => ui.agents.proposeAuth(),
  agentStart: (ui) => ui.agents.startSelected(),
  agentResume: (ui) => ui.agents.startSelected(),
  agentStop: (ui) => ui.agents.stop(),
  agentRerun: (ui) => ui.agents.rerun(),
  quit: (ui) => ui.onQuit(),
  treeLeft: (ui) => ui.worktrees.moveTree(-1),
  treeRight: (ui) => ui.worktrees.moveTree(1),
  worktreeNew: (ui) => ui.worktrees.onAdd(),
  worktreeDrop: (ui) => ui.worktrees.onDrop(),
  worktreeBranch: (ui) => ui.worktrees.onBranch(),
  repoLeft: (ui) => ui.workspace.move(-1, 0),
  repoRight: (ui) => ui.workspace.move(1, 0),
  repoUp: (ui) => ui.workspace.move(0, -1),
  repoDown: (ui) => ui.workspace.move(0, 1),
  ...DASH_HANDLERS,
};

const forSelection = (ui, action) => {
  if (!ui.worktrees.focused()) return action;
  if (TREE_OFF.includes(action)) return null;
  return TREE_ACTIONS[action] ?? action;
};

const dispatchAction = (ui, picked) => {
  const action = forSelection(ui, picked);
  if (!action) return;
  if (CONFIRM_MODE.includes(ui.mode)) return;
  if (ui.mode === 'import') stopImport(ui);
  const taskEdit = ui.mode === 'compose' && ui.pane === 'tasks';
  if (action === 'lines' && (ui.pane === 'diff' || ui.pane === 'unit')) {
    return void filesPane.onLineNumbers(ui);
  }
  if (ui.mode === 'compose' && !taskEdit) {
    if (!COMPOSE_LEAVE.includes(action)) return;
    const after = () => dispatchAction(ui, action);
    const result = ui.composer.saveCompose({ after });
    if (result.kind === 'saving') return;
  }
  const pane = ui.pane;
  const multiple = ui.nav.multiselect;
  if (multiple) {
    const off = {
      commits: ['newCommit', 'apply', 'reword', 'amend', 'fixup', 'open'],
      branches: ['newBranch', 'rebase', 'worktreeBranch', 'open', 'push'],
      packages: ['packageNew'],
      files: ['code', 'open'],
      diff: ['blockTask', 'code', 'layout', 'lines', 'open'],
      npm: ['npmEdit', 'npmNew', 'open'],
      agents: [
        'open',
        'agentStart',
        'agentResume',
        'agentStop',
        'agentInstall',
        'agentFast',
      ],
    };
    if (off[pane]?.includes(action)) return;
  }
  if (pane === 'repos' && !REPOS_ALLOWED.includes(action)) return;
  if (pane === 'dashboard' && !DASH_ALLOWED.includes(action)) return;
  if (LIST_PANES.includes(pane) && (action === 'next' || action === 'prev')) {
    return void filesPane.onScroll(ui, action === 'next' ? 1 : -1);
  }
  const groupAction = multiple && groupActions(pane).includes(action);
  const disabled = disabledActions(pane, currentTarget(ui)).includes(action);
  if (!groupAction && disabled) return;
  const handler = HANDLERS[action];
  if (!handler) return;
  if (taskEdit && !TASK_LIVE.includes(action)) ui.composer.tasks.closeEditor();
  handler(ui);
};

const confirmChoice = (ui, key) => {
  const handlers = CONFIRMATIONS[ui.mode];
  const action = handlers ? confirmKey(ui.mode, key) : null;
  if (action && handlers[action]) handlers[action](ui);
};

const filesKey = (ui, key) => {
  if (ui.pane !== 'files' || !treeShown(ui)) return null;
  return Object.hasOwn(FILES_KEYS, key) ? FILES_KEYS[key] : null;
};

const npmKey = (ui, key) => {
  if (ui.pane !== 'npm') return null;
  if (ui.npm.viewing) {
    if (Object.hasOwn(NPM_VIEW_KEYS, key)) return NPM_VIEW_KEYS[key];
    if (key === 'up' || key === 'down') return NPM_LIST_KEYS[key];
    return null;
  }
  return Object.hasOwn(NPM_LIST_KEYS, key) ? NPM_LIST_KEYS[key] : null;
};

const typingTask = (ui, key) => {
  const { agents } = ui;
  if (agents.viewing || agents.focus !== 'cli') return false;
  return agents.currentField() === 'task' && !TASK_LEAVES.includes(key);
};

const onFastSwitch = (ui, key) => {
  const { agents } = ui;
  if (agents.viewing || agents.focus !== 'cli') return false;
  return agents.currentField() === 'fast' && Object.hasOwn(FAST_KEYS, key);
};

const agentKey = (ui, key) => {
  if (ui.pane !== 'agents') return null;
  if (ui.agents.pick) return () => ui.agents.onPickKey(key);
  if (typingTask(ui, key)) return () => ui.agents.onTaskKey(key);
  if (onFastSwitch(ui, key)) return FAST_KEYS[key];
  const keys = ui.agents.viewing ? AGENT_VIEW_KEYS : AGENT_LIST_KEYS;
  return Object.hasOwn(keys, key) ? keys[key] : null;
};

// The tasks screen always edits its focused block: its own keys come first,
// Escape writes the block and leaves, and a letter never runs an action
const onTasksKey = (ui, key) => {
  if (ui.pane !== 'tasks' || !['review', 'compose'].includes(ui.mode)) {
    return false;
  }
  const tasks = ui.composer.tasks;
  const action = taskKeyAction(key);
  if (action) {
    ui.dispatch(action);
    return true;
  }
  if (key === 'escape') {
    tasks.closeEditor();
    filesPane.onEscape(ui);
    return true;
  }
  if (tasks.onKey(key)) return true;
  return ui.mode === 'review' && isTextKey(key);
};

const planMenuKey = (ui, key) => {
  if (!ui.composer.tasks.planOpen || ui.pane !== 'tasks') return false;
  ui.composer.tasks.onPlanKey(key);
  return true;
};

const handleKey = (ui, key) => {
  ui.nav.editDrag = null;
  ui.nav.listDrag = null;
  if (CONFIRM_MODE.includes(ui.mode)) return void confirmChoice(ui, key);
  if (handleContextKey(ui, key)) return;
  if (planMenuKey(ui, key)) return;
  if (onTasksKey(ui, key)) return;
  if (ui.pane === 'tasks' && (key === 'ctrl-up' || key === 'ctrl-down')) {
    if (ui.mode === 'import') stopImport(ui);
    const delta = key === 'ctrl-up' ? -1 : 1;
    return void ui.composer.tasks.moveIssue(delta);
  }
  if (key === 'ctrl-l' && (ui.pane === 'diff' || ui.pane === 'unit')) {
    return void filesPane.onLineNumbers(ui);
  }
  const modeKey = MODE_KEYS[ui.mode];
  if (modeKey) return void modeKey(ui, key);
  const rangePanes = [
    'commits',
    'branches',
    'packages',
    'files',
    'diff',
    'npm',
    'agents',
  ];
  const agentList =
    ui.pane !== 'agents' ||
    (ui.agents.focus === 'runs' && !ui.agents.viewing && !ui.agents.pick);
  const npmList = ui.pane !== 'npm' || !ui.npm.viewing;
  if (rangePanes.includes(ui.pane) && agentList && npmList) {
    const hunk =
      ui.pane === 'diff' ? { 'shift-left': -1, 'shift-right': 1 } : {};
    const rangeKeys = {
      'shift-up': -1,
      'shift-down': 1,
      'shift-home': -Number.MAX_SAFE_INTEGER,
      'shift-end': Number.MAX_SAFE_INTEGER,
      ...hunk,
    };
    if (Object.hasOwn(rangeKeys, key)) {
      return void filesPane.onScroll(ui, rangeKeys[key], true);
    }
    if (key === 'ctrl-a') return void filesPane.onSelectAll(ui);
    if (ui.pane === 'commits' && key === 's' && ui.nav.multiselect) {
      return void ui.dispatch('squash');
    }
  }
  if (key === '/' && FIND_PANES.includes(ui.pane)) return void startFind(ui);
  const onFilesKey = filesKey(ui, key);
  if (onFilesKey) return void onFilesKey(ui);
  const onNpmKey = npmKey(ui, key);
  if (onNpmKey) return void onNpmKey(ui);
  const onAgentKey = agentKey(ui, key);
  if (onAgentKey) return void onAgentKey(ui);
  if (key === 'ctrl-c') {
    const text = extractText(ui.lastFrame?.rows, ui.nav.selection);
    if (clipboard.copyText(text, ui.stdout)) ui.status = 'copied';
    return;
  }
  if (key === 'escape') return void filesPane.onEscape(ui);
  const action = actionFromKey(key, ui.pane);
  if (action) ui.dispatch(action);
};

// Before and after each event the tasks screen has its block in the editor
const handleEvent = (ui, event) => {
  const tasks = ui.composer.tasks;
  tasks.settle();
  if (event.type === 'key') handleKey(ui, event.key);
  else if (event.type === 'mouse') handlePointer(ui, event);
  tasks.settle();
};

module.exports = { dispatchAction, confirmChoice, handleEvent };
