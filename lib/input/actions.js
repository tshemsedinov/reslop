'use strict';

const { TASK_FIELDS } = require('../common/files.js');

// The field menu of the task editor: an action per field, its key the
// field's own letter
const fieldAction = (key) => `field:${key}`;

const fieldEntries = (read) =>
  Object.fromEntries(
    TASK_FIELDS.map((field) => [fieldAction(field.key), read(field)]),
  );

const LIST_PANES = [
  'files',
  'branches',
  'commits',
  'npm',
  'packages',
  'agents',
];

const ACTIONS = {
  add: ['a'],
  unstage: ['u'],
  revert: ['delete'],
  ignore: ['i'],
  commit: ['c'],
  prev: ['left', 'p', 'k'],
  next: ['right', 'n', 'j'],
  layout: ['m'],
  blockTask: [],
  tasks: ['t'],
  code: ['e'],
  branch: ['b'],
  file: ['f'],
  diff: ['d'],
  quit: [],
};
const ACTION_IDS = Object.keys(ACTIONS);

const BRANCH_ACTIONS = {
  newBranch: ['insert'],
  rebase: ['e'],
  drop: ['delete'],
  pull: ['p'],
  push: ['s'],
};

const COMMIT_ACTIONS = {
  newCommit: ['insert'],
  apply: ['p'],
  reword: ['e'],
  updateTime: ['u'],
  drop: ['delete'],
  view: ['v'],
};

const PACKAGE_ACTIONS = {
  packageNew: ['insert'],
  packageDrop: ['delete'],
  packageWanted: ['w'],
  packageLatest: ['l'],
};

const NPM_ACTIONS = {
  npm: ['n'],
  npmEdit: ['e'],
  npmNew: ['insert'],
  npmDrop: ['delete'],
  npmLogs: ['l'],
  npmStop: ['s'],
  npmTask: ['ctrl-t'],
  npmVerbose: ['v'],
  npmRerun: ['r'],
};

const AGENT_ACTIONS = {
  agentSelect: ['a'],
  agentModel: ['m'],
  agentEffort: ['e'],
  agentFast: ['o'],
  agentContext: ['x'],
  agentReview: ['p'],
  agentInstall: ['i'],
  agentAuth: ['l'],
  agentStart: ['s'],
  agentResume: ['s'],
  agentStop: ['s'],
  agentRerun: ['r'],
};

const AGENT_RUN_ONLY = ['agentResume', 'agentStop', 'agentRerun'];
const AGENT_LIST_ACTIONS = Object.fromEntries(
  Object.entries(AGENT_ACTIONS).filter(([id]) => !AGENT_RUN_ONLY.includes(id)),
);

const DASH_TILES = [
  { id: 'files', key: 'f', action: 'dashFiles', footer: true },
  { id: 'diffs', key: 'd', action: 'dashDiffs', footer: true },
  { id: 'tasks', key: 't', action: 'dashTasks', footer: true },
  { id: 'branches', key: 'b', action: 'dashBranches', footer: true },
  { id: 'commits', key: 'c', action: 'dashCommits', footer: true },
  { id: 'run', key: 'r', action: 'dashRun', footer: true },
  { id: 'npm', key: 'n', action: 'dashNpm', footer: true },
  { id: 'agents', key: 'a', action: 'dashAgents', footer: false },
];
const DASH_ACTIONS = {};
const DASH_BLOCKS = {};
const DASH_KEYS = {};
for (const tile of DASH_TILES) {
  if (tile.footer) DASH_ACTIONS[tile.action] = [tile.key];
  DASH_BLOCKS[tile.action] = tile.id;
  DASH_KEYS[tile.key] = tile.action;
}
const DASH_IDS = Object.keys(DASH_ACTIONS);
const WORKTREE_ACTIONS = {
  worktreeNew: ['insert'],
  worktreeDrop: ['delete'],
  worktreeBranch: ['w'],
};
const DASH_ALLOWED = [
  ...Object.keys(DASH_BLOCKS),
  'back',
  'pull',
  'push',
  'quit',
  'theme',
];
const REPOS_ALLOWED = [
  'repoLeft',
  'repoRight',
  'repoUp',
  'repoDown',
  'open',
  'back',
  'worktreeNew',
  'worktreeDrop',
  'quit',
  'theme',
];

const ACTION_HOT = {
  textCut: 'ctrl+x',
  textCopy: 'ctrl+c',
  textPaste: 'ctrl+v',
  textDelete: 'del',
  textSelectAll: 'ctrl+a',
  listSelectAll: '^a',
  revert: 'del',
  open: 'enter',
  prev: '←',
  next: '→',
  drop: 'del',
  worktreeDrop: 'del',
  worktreeBranch: 'w',
  newBranch: 'ins',
  newCommit: 'ins',
  worktreeNew: 'ins',
  blockTask: '^t',
  npmTask: '^t',
  taskUp: 'ctrl+up',
  taskDown: 'ctrl+down',
  taskNudge: 'up/dn',
  taskNew: 'ins',
  blockMenu: '^b',
  taskExpand: 'tab',
  taskDone: '^d',
  taskPriority: '^l',
  taskField: 'tab',
  taskAgent: '^s',
  taskImport: '^i',
  taskFind: '^f',
  taskOpen: '^w',
  taskDrop: '^r',
  ...fieldEntries((field) => field.hot),
  plan: '^p',
  theme: 'l',
  lines: '^l',
  npmNew: 'ins',
  npmDrop: 'del',
  npmStop: 's',
  packageNew: 'ins',
  packageDrop: 'del',
};

const ACTION_LABEL = {
  textCut: 'ctrl+x cut',
  textCopy: 'ctrl+c copy',
  textPaste: 'ctrl+v paste',
  textDelete: 'delete',
  textSelectAll: 'ctrl+a select all',
  listSelectAll: '^all',
  ...DASH_BLOCKS,
  open: 'enter open',
  revert: 'delete',
  taskUp: 'ctrl+up',
  taskDown: 'ctrl+down',
  taskNudge: 'ctrl+up/dn',
  taskNew: 'insert',
  blockMenu: '^block',
  taskDone: '^done',
  taskPriority: '^level',
  taskField: 'tab field',
  taskAgent: '^start',
  taskImport: '^import',
  taskFind: '^find',
  taskOpen: '^where',
  taskDrop: '^remove',
  plan: '^plan',
  theme: 'light',
  lines: '^lines',
  layout: 'mode',
  tasks: 'tasks',
  view: 'view',
  code: 'edit',
  reword: 'edit',
  drop: 'delete',
  newBranch: 'insert',
  newCommit: 'insert',
  updateTime: 'update',
  squash: 'squash',
  worktreeNew: 'insert',
  worktreeDrop: 'delete',
  worktreeBranch: 'worktree',
  blockTask: '^task',
  npmEdit: 'edit',
  npmNew: 'insert',
  npmDrop: 'delete',
  npmLogs: 'cleanup',
  packageNew: 'insert',
  packageDrop: 'delete',
  packageWanted: 'wanted',
  packageLatest: 'latest',
  npmStop: 'stop',
  npmTask: '^task',
  npmVerbose: 'verbose',
  npmRerun: 're-run',
  agentSelect: 'agent',
  agentModel: 'model',
  agentEffort: 'effort',
  agentFast: 'fast mode',
  agentContext: 'context',
  agentReview: 'plan',
  agentInstall: 'install',
  agentAuth: 'login',
  agentStart: 'start',
  agentResume: 'resume',
  agentStop: 'stop',
  agentRerun: 're-run',
  quit: 'q',
  prev: '←',
  next: '→',
};

const DIFF_DISABLED = ['commit', 'branch', 'pull', 'push', 'file', 'diff'];
const UNIT_DISABLED = [...DIFF_DISABLED, 'layout', 'ignore'];
const FILES_DISABLED = ['layout', 'blockTask'];
const FILES_HIDDEN = [
  ...FILES_DISABLED,
  'prev',
  'next',
  'commit',
  'file',
  'diff',
  'tasks',
  'branch',
];
const FILES_GIT_DISABLED = ['add', 'unstage', 'revert', 'ignore'];
const FILES_TASKS_DISABLED = [...FILES_GIT_DISABLED, ...FILES_DISABLED, 'code'];
const TASKS_DISABLED = [
  'add',
  'unstage',
  'revert',
  'ignore',
  'commit',
  'layout',
  'blockTask',
  'tasks',
  'code',
  'branch',
  'file',
  'diff',
  'pull',
  'push',
];
const BRANCHES_DISABLED = [
  'add',
  'unstage',
  'revert',
  'ignore',
  'commit',
  'layout',
  'blockTask',
  'tasks',
  'code',
  'branch',
  'file',
  'diff',
  'prev',
  'next',
];
const COMMITS_DISABLED = BRANCHES_DISABLED.filter((id) => id !== 'commit');
const NPM_DISABLED = [...BRANCHES_DISABLED, 'pull', 'push'];

const isTasksTarget = (item) => {
  if (!item) return false;
  const tasks = item.kind === 'tasks';
  const task = item.origin === 'task';
  return tasks || task;
};

const DIFF_MOVE_IDS = ['add', 'unstage', 'revert'];

const entryHasDiff = (entry) => {
  if (!entry || entry.kind === 'tasks') return false;
  const keys = [
    'added',
    'removed',
    'stagedAdded',
    'stagedRemoved',
    'unstagedAdded',
    'unstagedRemoved',
    'remaining',
  ];
  let total = 0;
  for (const key of keys) total += entry[key] ?? 0;
  return total > 0;
};

const lineHasDiff = (line) => {
  if (!line) return false;
  return line.type === 'add' || line.type === 'del';
};

const withoutMoves = (off, hasDiff) => {
  if (hasDiff) return off;
  const next = off.slice();
  for (const id of DIFF_MOVE_IDS) {
    if (!next.includes(id)) next.push(id);
  }
  return next;
};

const diffGitDisabled = (item) => {
  if (!item || isTasksTarget(item)) return [];
  if (item.origin === 'staged') return ['add'];
  return ['unstage'];
};

const branchGitDisabled = (item) =>
  item && !item.current ? [] : ['rebase', 'drop'];

const isFixupCommit = (item) =>
  `${item && item.subject ? item.subject : ''}`.startsWith('fixup!');

const commitWriteDisabled = (item) => {
  const pending = Boolean(item && item.pending);
  const unstaged = Boolean(item && item.unstagedCurrent);
  const fixup = isFixupCommit(item);
  if (!item || !item.sha) {
    const off = ['reword', 'updateTime', 'fixup', 'drop'];
    if (pending) return ['apply', ...off];
    return ['amend', 'apply', ...off];
  }
  if (unstaged) return fixup ? [] : ['apply'];
  if (fixup) return ['amend'];
  return ['amend', 'apply'];
};

const commitChord = (item) => {
  if (!item || item.pending || !item.sha) return 'commit';
  if (item.head) return 'amend';
  return 'fixup';
};

const commitGitDisabled = (item) => {
  const off = [...commitWriteDisabled(item)];
  if (!isFixupCommit(item)) off.push('apply');
  const chord = commitChord(item);
  const ready = item && item.canCommit === true;
  if (chord === 'amend') return off;
  if (!ready) off.push('commit');
  return off;
};

const filesDisabled = (item) => {
  if (isTasksTarget(item) || item?.kind === 'folder') {
    return FILES_TASKS_DISABLED;
  }
  return withoutMoves(FILES_DISABLED, entryHasDiff(item));
};

const unitDisabled = (item) => {
  const off = [...UNIT_DISABLED, ...diffGitDisabled(item)];
  const onDiff = !item || item.lineDiff !== false;
  return withoutMoves(off, onDiff);
};

const npmDisabled = () => NPM_DISABLED;

const PANE_DISABLED = {
  dashboard: () => [],
  repos: () => [],
  files: filesDisabled,
  unit: unitDisabled,
  branches: (item) => [...BRANCHES_DISABLED, ...branchGitDisabled(item)],
  commits: (item) => [...COMMITS_DISABLED, ...commitWriteDisabled(item)],
  npm: npmDisabled,
  packages: npmDisabled,
  agents: npmDisabled,
  tasks: () => TASKS_DISABLED,
};

const disabledActions = (pane, item) => {
  const disabled = PANE_DISABLED[pane];
  if (disabled) return disabled(item);
  if (isTasksTarget(item)) return TASKS_DISABLED;
  return [...DIFF_DISABLED, ...diffGitDisabled(item)];
};

const HIDDEN_KEYS = {
  l: 'theme',
};

const SCROLL = {
  up: 'scrollUp',
  down: 'scrollDown',
  'ctrl-y': 'scrollUp',
  'ctrl-e': 'scrollDown',
  'ctrl-b': 'pageUp',
  'ctrl-f': 'pageDown',
  'ctrl-u': 'halfUp',
  'ctrl-d': 'halfDown',
  pageUp: 'pageUp',
  pageDown: 'pageDown',
  home: 'home',
  end: 'end',
  enter: 'open',
  backspace: 'removeTask',
  delete: 'removeTask',
};

const keysForActions = (actions) => {
  const keys = {};
  for (const [id, shortcuts] of Object.entries(actions)) {
    for (const key of shortcuts) keys[key] = id;
  }
  return keys;
};

const PANE_ONLY = ['branch', 'file', 'diff'];
// `d` opens the diffs on every screen, so a drop takes Delete
const REVIEW_DROP = { delete: 'revert' };
const DIFF_KEYS = { ...REVIEW_DROP, 'ctrl-t': 'blockTask', 'ctrl-l': 'lines' };
const BRANCH_KEYS = {
  ...keysForActions(BRANCH_ACTIONS),
  w: 'worktreeBranch',
  left: 'treeLeft',
  right: 'treeRight',
};
const COMMIT_KEYS = { ...keysForActions(COMMIT_ACTIONS), s: 'push' };
const NPM_KEYS = {
  e: 'npmEdit',
  insert: 'npmNew',
  delete: 'npmDrop',
  l: 'npmLogs',
};
const SCREEN_KEYS = keysForActions(DASH_ACTIONS);

// The tasks screen always edits its focused block, so letters type there
// and its own actions take keys no text needs
const TASK_KEYS = {
  insert: 'taskNew',
  'ctrl-r': 'taskDrop',
  'ctrl-b': 'blockMenu',
  'ctrl-d': 'taskDone',
  'ctrl-l': 'taskPriority',
  'ctrl-s': 'taskAgent',
  'ctrl-i': 'taskImport',
  'ctrl-p': 'plan',
  'ctrl-f': 'taskFind',
  'ctrl-w': 'taskOpen',
};

const taskKeyAction = (key) =>
  Object.hasOwn(TASK_KEYS, key) ? TASK_KEYS[key] : null;
const PANE_KEYS = {
  dashboard: { ...DASH_KEYS, p: 'pull', s: 'push' },
  files: REVIEW_DROP,
  diff: DIFF_KEYS,
  unit: DIFF_KEYS,
  branches: BRANCH_KEYS,
  commits: COMMIT_KEYS,
  npm: NPM_KEYS,
  packages: keysForActions(PACKAGE_ACTIONS),
  agents: keysForActions(AGENT_LIST_ACTIONS),
  tasks: TASK_KEYS,
  repos: {
    left: 'repoLeft',
    right: 'repoRight',
    up: 'repoUp',
    down: 'repoDown',
    k: 'repoUp',
    j: 'repoDown',
    p: 'repoLeft',
    n: 'repoRight',
    insert: 'worktreeNew',
    delete: 'worktreeDrop',
  },
};

const KEY_TO_ACTION = {
  ...keysForActions(
    Object.fromEntries(
      Object.entries(ACTIONS).filter(([id]) => !PANE_ONLY.includes(id)),
    ),
  ),
  ...SCROLL,
  ...HIDDEN_KEYS,
};

const actionFromKey = (key, pane) => {
  if (pane === 'commits' && key === 'ctrl-e') return null;
  const sideways = key === 'left' || key === 'right';
  if (LIST_PANES.includes(pane) && sideways && pane !== 'branches') {
    return null;
  }
  const paneKeys = PANE_KEYS[pane];
  if (paneKeys && paneKeys[key]) return paneKeys[key];
  if (pane && SCREEN_KEYS[key]) return SCREEN_KEYS[key];
  return KEY_TO_ACTION[key] ?? null;
};

const ACTION_KEYS = {
  squash: ['s'],
  ...DASH_ACTIONS,
  ...AGENT_ACTIONS,
  ...PACKAGE_ACTIONS,
  ...NPM_ACTIONS,
  ...COMMIT_ACTIONS,
  ...BRANCH_ACTIONS,
  ...WORKTREE_ACTIONS,
  ...ACTIONS,
};

const actionKeys = (id) => ACTION_KEYS[id] ?? [];

const actionLetter = (id) => ACTION_HOT[id] ?? actionKeys(id)[0];

const ACTION_CAPTION = {
  open: 'open',
  textCut: 'cut',
  textCopy: 'copy',
  textPaste: 'paste',
  textSelectAll: 'select all',
  ...fieldEntries((field) => `${field.key}: ${field.hint}`),
};

const actionCaption = (id) => ACTION_CAPTION[id] ?? ACTION_LABEL[id] ?? id;

// Where a ctrl key marks its letter in its word, as `^r` the `r` of
// `^import`; -1 when the word does not carry it so
const ctrlLetterAt = (word, mark) => {
  const ctrl = mark?.length === 2 && mark[0] === '^' && word[0] === '^';
  return ctrl ? word.indexOf(mark[1], 1) : -1;
};

// A word that has its key is shown alone
const hasKey = (word, mark) =>
  !mark || word.includes(mark) || ctrlLetterAt(word, mark) > 0;

const buttonWord = (id) => {
  const word = ACTION_LABEL[id] ?? ACTION_HOT[id] ?? id;
  const mark = actionLetter(id);
  if (hasKey(word, mark)) return word;
  return `${mark}${word}`;
};

const YES_NO = [
  { letter: 'y', label: 'y', lead: ' ' },
  { letter: 'n', label: 'n', lead: '/' },
];
const YES_NO_KEYS = { y: 'confirm', n: 'cancel', escape: 'cancel' };
const yesNo = (prefix, keys = YES_NO_KEYS) => ({
  choices: YES_NO,
  prefix,
  keys,
});

const CONFIRM = {
  confirmQuit: yesNo(
    (view) => view.quitWarning || ' exit will terminate subprocesses',
    { ...YES_NO_KEYS, 'ctrl-c': 'cancel' },
  ),
  confirmUpdate: {
    choices: YES_NO,
    prefix: (view) => {
      const from = view.updateFrom ?? '';
      const to = view.updateTo ?? '';
      return ` update reslop ${from} → ${to}?`;
    },
    keys: {
      y: 'accept',
      n: 'decline',
      escape: 'decline',
    },
  },
  confirmAgentInstall: yesNo(
    (view) => ` install ${view.agentInstallPackage ?? ''}?`,
  ),
  confirmAgentAuth: yesNo((view) => ` ${view.agentAuthAsk ?? ''}?`),
  confirmDrop: yesNo((view) => ` drop ${view.dropName ?? ''}?`),
  confirmWorktree: yesNo((view) => ` remove ${view.dropName ?? ''}?`),
  confirmCreateWorktree: yesNo(
    (view) => ` create ${view.worktreeTarget ?? ''}?`,
  ),
  confirmPush: {
    choices: [{ letter: 'f', label: 'force push', lead: ' ' }],
    prefix: ' Need force-push?',
    keys: {
      f: 'force',
      escape: 'cancel',
    },
  },
  confirmCommit: {
    choices: [
      { letter: 'esc', label: 'esc cancel', lead: '  ' },
      { letter: 'u', label: 'update', lead: '  ' },
      { letter: 'c', label: 'commit', lead: '  ' },
      { letter: 'a', label: 'amend', lead: '  ' },
      { letter: 'f', label: 'fixup', lead: '  ' },
    ],
    prefix: ' what do you want to do?',
    keys: {
      esc: 'cancel',
      escape: 'cancel',
      enter: 'update',
      u: 'update',
      c: 'commit',
      a: 'amend',
      f: 'fixup',
    },
  },
};

const CONFIRM_MODE = Object.keys(CONFIRM);

const GROUP_ACTIONS = {
  commits: ['drop', 'updateTime', 'squash'],
  branches: ['drop'],
  files: ['add', 'unstage', 'revert', 'ignore'],
  diff: ['add', 'unstage', 'revert', 'ignore'],
  npm: ['npmDrop'],
};

const groupActions = (pane) => GROUP_ACTIONS[pane] ?? [];

const confirmKey = (mode, key) => {
  const spec = CONFIRM[mode];
  if (!spec) return null;
  const norm = key.length === 1 ? key.toLowerCase() : key;
  return spec.keys[norm] ?? null;
};

const confirmPrefix = (spec, view) => {
  if (typeof spec.prefix === 'function') return spec.prefix(view);
  return spec.prefix ?? '';
};

const promptFromChoices = (choices) =>
  choices.map((choice) => `${choice.lead}${choice.label}`).join('');

module.exports = {
  fieldAction,
  ctrlLetterAt,
  taskKeyAction,
  LIST_PANES,
  DASH_TILES,
  DASH_IDS,
  DASH_BLOCKS,
  DASH_ALLOWED,
  REPOS_ALLOWED,
  ACTIONS,
  ACTION_IDS,
  DIFF_DISABLED,
  UNIT_DISABLED,
  FILES_DISABLED,
  FILES_HIDDEN,
  FILES_GIT_DISABLED,
  FILES_TASKS_DISABLED,
  TASKS_DISABLED,
  BRANCHES_DISABLED,
  COMMITS_DISABLED,
  disabledActions,
  entryHasDiff,
  lineHasDiff,
  withoutMoves,
  diffGitDisabled,
  branchGitDisabled,
  commitGitDisabled,
  isFixupCommit,
  actionFromKey,
  actionLetter,
  actionCaption,
  buttonWord,
  CONFIRM,
  CONFIRM_MODE,
  confirmKey,
  confirmPrefix,
  promptFromChoices,
  groupActions,
};
