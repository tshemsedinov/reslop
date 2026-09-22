'use strict';

const ACTIONS = {
  add: ['a'],
  unstage: ['u'],
  revert: ['d'],
  commit: ['c'],
  prev: ['left', 'p', 'k'],
  next: ['right', 'n', 'j'],
  layout: ['m'],
  feedback: ['f'],
  todo: ['t'],
  code: ['e'],
  branch: ['b'],
  file: ['f'],
  diff: ['d'],
  quit: ['q', 'ctrl-c'],
};
const ACTION_IDS = Object.keys(ACTIONS);

const BRANCH_ACTIONS = {
  newBranch: ['n'],
  rebase: ['r'],
  drop: ['d'],
  pull: ['p'],
  push: ['s'],
};

const COMMIT_ACTIONS = {
  amend: ['a'],
  apply: ['a'],
  fixup: ['f'],
  drop: ['d'],
  pull: ['p'],
  push: ['s'],
};

const ACTION_HOT = {
  prev: '←',
  next: '→',
};

const ACTION_LABEL = {
  revert: 'drop',
  layout: 'mode',
  code: 'edit',
  newBranch: 'new',
  quit: 'q',
  prev: '←',
  next: '→',
};

const DIFF_DISABLED = ['commit', 'branch', 'pull', 'push', 'file', 'diff'];
const UNIT_DISABLED = [...DIFF_DISABLED, 'layout'];
const FILES_DISABLED = ['layout', 'feedback', 'code'];
const FILES_HIDDEN = [
  ...FILES_DISABLED,
  'prev',
  'next',
  'commit',
  'file',
  'diff',
];
const FILES_GIT_DISABLED = ['add', 'unstage', 'revert'];
const FILES_TODO_DISABLED = [...FILES_GIT_DISABLED, ...FILES_DISABLED];
const TODO_DISABLED = [
  'add',
  'unstage',
  'revert',
  'commit',
  'layout',
  'feedback',
  'todo',
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
  'commit',
  'layout',
  'feedback',
  'todo',
  'code',
  'branch',
  'file',
  'diff',
  'prev',
  'next',
];
const COMMITS_DISABLED = [
  'add',
  'unstage',
  'revert',
  'layout',
  'feedback',
  'todo',
  'code',
  'branch',
  'file',
  'diff',
  'prev',
  'next',
];

const isTodosTarget = (item) =>
  !!(item && (item.kind === 'todos' || item.origin === 'todo'));

const diffGitDisabled = (item) => {
  if (!item || isTodosTarget(item)) return [];
  if (item.origin === 'staged') return ['add'];
  return ['unstage'];
};

const BRANCH_REMOTE = ['pull', 'push'];

const branchGitDisabled = (item) => {
  const off = item && !item.current ? [] : ['rebase', 'drop'];
  if (!item || !item.current) return [...off, ...BRANCH_REMOTE];
  return off;
};

const isFixupCommit = (item) =>
  `${item && item.subject ? item.subject : ''}`.startsWith('fixup!');

const commitWriteDisabled = (item) => {
  if (!item || !item.sha) return ['amend', 'apply', 'fixup', 'drop'];
  return [];
};

const commitGitDisabled = (item) => {
  const off = [...commitWriteDisabled(item)];
  if (!isFixupCommit(item)) off.push('apply');
  if (item && item.canCommit === true) return off;
  return [...off, 'commit', 'fixup'];
};

const disabledActions = (pane, item) => {
  const onTodos = isTodosTarget(item);
  if (pane === 'files') return onTodos ? FILES_TODO_DISABLED : FILES_DISABLED;
  if (pane === 'unit') return [...UNIT_DISABLED, ...diffGitDisabled(item)];
  if (pane === 'branches') {
    return [...BRANCHES_DISABLED, ...branchGitDisabled(item)];
  }
  if (pane === 'commits') {
    return [...COMMITS_DISABLED, ...commitWriteDisabled(item)];
  }
  if (onTodos) return TODO_DISABLED;
  return [...DIFF_DISABLED, ...diffGitDisabled(item)];
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
  backspace: 'removeTodo',
  delete: 'removeTodo',
};

const KEY_TO_ACTION = {};
const PANE_ONLY = ['branch', 'file', 'diff'];
const FILES_KEYS = {};
for (const key of ACTIONS.branch) FILES_KEYS[key] = 'branch';
for (const id of BRANCH_REMOTE) {
  for (const key of BRANCH_ACTIONS[id]) FILES_KEYS[key] = id;
}
const BRANCH_KEYS = {};
for (const id of Object.keys(BRANCH_ACTIONS)) {
  for (const key of BRANCH_ACTIONS[id]) BRANCH_KEYS[key] = id;
}
const COMMIT_KEYS = {};
for (const id of Object.keys(COMMIT_ACTIONS)) {
  for (const key of COMMIT_ACTIONS[id]) COMMIT_KEYS[key] = id;
}
const PANE_KEYS = {
  files: FILES_KEYS,
  branches: BRANCH_KEYS,
  commits: COMMIT_KEYS,
};

for (const id of ACTION_IDS) {
  if (PANE_ONLY.includes(id)) continue;
  for (const key of ACTIONS[id]) KEY_TO_ACTION[key] = id;
}

for (const key of Object.keys(SCROLL)) KEY_TO_ACTION[key] = SCROLL[key];

const actionFromKey = (key, pane, fileScope) => {
  const listPane =
    pane === 'files' || pane === 'branches' || pane === 'commits';
  if (listPane && (key === 'left' || key === 'right')) return null;
  const paneKeys = PANE_KEYS[pane];
  if (paneKeys && paneKeys[key]) return paneKeys[key];
  if (pane === 'files') {
    if (key === 'f' && fileScope !== 'file') return 'file';
    if (key === 'd' && fileScope === 'file') return 'diff';
  }
  return KEY_TO_ACTION[key] ?? null;
};

const actionKeys = (id) =>
  ACTIONS[id] ?? BRANCH_ACTIONS[id] ?? COMMIT_ACTIONS[id] ?? [];

const actionHot = (id) => ACTION_HOT[id] ?? actionKeys(id)[0];

const actionLetter = actionHot;

const buttonWord = (id) => {
  const word = ACTION_LABEL[id] ?? ACTION_HOT[id] ?? id;
  const mark = actionLetter(id);
  if (word.includes(mark)) return word;
  return `${mark}${word}`;
};

const YES_NO = [
  { letter: 'y', label: 'y', lead: ' ' },
  { letter: 'n', label: 'n', lead: '/' },
];

const CONFIRM = {
  confirmQuit: {
    choices: [
      { letter: 'f', label: 'finish as ready', lead: ' ' },
      { letter: 'c', label: 'continue next time', lead: '  ' },
    ],
    keys: {
      f: 'ready',
      c: 'editing',
      'ctrl-c': 'ready',
      escape: 'cancel',
    },
  },
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
  confirmDrop: {
    choices: YES_NO,
    prefix: (view) => ` drop ${view.dropName ?? ''}?`,
    keys: {
      y: 'confirm',
      n: 'cancel',
      escape: 'cancel',
    },
  },
  confirmPush: {
    choices: [{ letter: 'f', label: 'force push', lead: ' ' }],
    prefix: ' Need force-push?',
    keys: {
      f: 'force',
      escape: 'cancel',
    },
  },
};

const CONFIRM_MODE = Object.keys(CONFIRM);

const confirmKey = (mode, key) => {
  const spec = CONFIRM[mode];
  if (!spec) return null;
  const norm = key.length === 1 ? key.toLowerCase() : key;
  return spec.keys[norm] ?? null;
};

const applyConfirm = (mode, key, handlers) => {
  const action = confirmKey(mode, key);
  if (!action) return;
  const handler = handlers[action];
  if (handler) handler();
};

const confirmPrefix = (spec, view) => {
  if (typeof spec.prefix === 'function') return spec.prefix(view);
  return spec.prefix ?? '';
};

const promptFromChoices = (choices) =>
  choices.map((choice) => `${choice.lead}${choice.label}`).join('');

module.exports = {
  ACTIONS,
  ACTION_IDS,
  BRANCH_ACTIONS,
  COMMIT_ACTIONS,
  ACTION_HOT,
  ACTION_LABEL,
  DIFF_DISABLED,
  UNIT_DISABLED,
  FILES_DISABLED,
  FILES_HIDDEN,
  FILES_GIT_DISABLED,
  FILES_TODO_DISABLED,
  TODO_DISABLED,
  BRANCHES_DISABLED,
  COMMITS_DISABLED,
  SCROLL,
  PANE_ONLY,
  disabledActions,
  diffGitDisabled,
  branchGitDisabled,
  commitGitDisabled,
  isFixupCommit,
  actionFromKey,
  actionKeys,
  actionHot,
  actionLetter,
  buttonWord,
  CONFIRM,
  CONFIRM_MODE,
  confirmKey,
  applyConfirm,
  confirmPrefix,
  promptFromChoices,
};
