'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const keys = require('../lib/input/keys.js');
const { decodeChunk, hitAction } = keys;
const actions = require('../lib/input/actions.js');
const { FILES_DISABLED, FILES_HIDDEN } = actions;
const { FILES_TASKS_DISABLED, FILES_GIT_DISABLED } = actions;
const { DIFF_DISABLED, TASKS_DISABLED, BRANCHES_DISABLED } = actions;
const { COMMITS_DISABLED, UNIT_DISABLED } = actions;
const { actionFromKey, disabledActions, DASH_IDS } = actions;
const { layoutButtons } = require('../lib/render/render.js');

const KEY_SEQUENCES = [
  ['\x1b[A', 'up'],
  ['\r', 'enter'],
  ['\n', 'ctrl-enter'],
  ['\x7f', 'backspace'],
  ['\x1b[127;5u', 'ctrl-backspace'],
  ['\t', 'tab'],
  ['\x1b[Z', 'shift-tab'],
  ['\x13', 'ctrl-s'],
  ['\x1a', 'ctrl-z'],
  ['\x05', 'ctrl-e'],
  ['\x06', 'ctrl-f'],
  ['\x1bOP', 'f1'],
  ['\x1b[15~', 'f5'],
  ['\x1b[24~', 'f12'],
  ['\x1b[2~', 'insert'],
  ['\x1b[3~', 'delete'],
  ['\x1b[5~', 'pageUp'],
  ['\x1b[6~', 'pageDown'],
  ['\x1b[H', 'home'],
  ['\x1b[F', 'end'],
  ['\x1b[1~', 'home'],
  ['\x1bOH', 'home'],
  ['\x1b[1;5D', 'ctrl-left'],
  ['\x1b[1;5C', 'ctrl-right'],
  ['\x1b[1;5A', 'ctrl-up'],
  ['\x1b[1;5B', 'ctrl-down'],
  ['\x1b[1;2D', 'shift-left'],
  ['\x1b[1;2C', 'shift-right'],
  ['\x1b[1;6D', 'ctrl-shift-left'],
  ['\x1b[1;2H', 'shift-home'],
  ['\x1b[1;2F', 'shift-end'],
  ['\x1b[13;2u', 'shift-enter'],
  ['\x1b[13;5u', 'ctrl-enter'],
  ['\x1b[13;6u', 'ctrl-shift-enter'],
  ['\x1b[13u', 'enter'],
  ['\x1b[27;2;13~', 'shift-enter'],
  ['\x1b[27;5;13~', 'ctrl-enter'],
  ['\x1b[27;6;13~', 'ctrl-shift-enter'],
  ['\x1b[13~', 'f3'],
  ['\x1b[9;2u', 'shift-tab'],
  ['\x1b[27;2;9~', 'shift-tab'],
  ['\x1b[27;2;35~', '#'],
  ['\x1b[35u', '#'],
  ['\x1b[2;2~', 'insert'],
  ['\x1b[105;5u', 'ctrl-i'],
  ['\x1b[27;5;105~', 'ctrl-i'],
  ['\t', 'tab'],
];

test('decodeChunk maps letters, control codes, and escape sequences', () => {
  const keys = decodeChunk('ar').events.map((event) => event.key);
  assert.deepEqual(keys, ['a', 'r']);
  for (const [text, key] of KEY_SEQUENCES) {
    assert.deepEqual(decodeChunk(text).events, [{ type: 'key', key }], key);
  }
});

test('decodeChunk carries a split sequence to the next chunk', () => {
  const pending = decodeChunk('\x1b');
  assert.equal(pending.events.length, 0);
  assert.equal(pending.carry, '\x1b');
  const completed = decodeChunk('[A', pending.carry);
  assert.equal(completed.events[0].key, 'up');
});

test('decodeChunk distinguishes legacy Alt+Enter from Return', () => {
  for (const text of ['\x1b\r', '\x1b\n', '\x1b[13;3u', '\x1b[27;3;13~']) {
    assert.deepEqual(decodeChunk(text).events, [
      { type: 'key', key: 'alt-enter' },
    ]);
  }
  assert.equal(decodeChunk('\r').events[0].key, 'enter');
});

test('decodeChunk keeps shortcuts and typing in xterm modifier mode', () => {
  const keys = (text) => decodeChunk(text).events.map((event) => event.key);
  for (const letter of ['a', 'c', 'v', 'x', 's', 'y', 'z']) {
    const code = letter.charCodeAt(0);
    assert.deepEqual(keys(`\x1b[27;5;${code}~`), [`ctrl-${letter}`]);
  }
  assert.deepEqual(keys('\x1b[27;2;65~\x1b[27;2;33~'), ['A', '!']);
  assert.deepEqual(keys('\x1b[27;2;9~'), ['shift-tab']);
  assert.deepEqual(keys('\x1b[27;5;127~'), ['ctrl-backspace']);
});

test('decodeChunk maps kitty reports of plain keys', () => {
  const keys = (text) => decodeChunk(text).events.map((event) => event.key);
  assert.deepEqual(keys('\x1b[27u'), ['escape']);
  assert.deepEqual(keys('\x1b[9u'), ['tab']);
  assert.deepEqual(keys('\x1b[9;2u'), ['shift-tab']);
  assert.deepEqual(keys('\x1b[99;5u'), ['ctrl-c']);
  assert.deepEqual(keys('\x1b[115;5u'), ['ctrl-s']);
  assert.deepEqual(keys('\x1b[104;5u'), ['backspace']);
  assert.deepEqual(keys('\x1b[106;5u'), ['ctrl-enter']);
});

// The keys of the tasks screen as kitty, xterm, GNOME Terminal, Windows
// Terminal, iTerm2, and tmux send them
test('decodeChunk parses SGR mouse press', () => {
  const event = decodeChunk('\x1b[<0;4;12M').events[0];
  assert.equal(event.type, 'mouse');
  assert.equal(event.button, 0);
  assert.equal(event.x, 4);
  assert.equal(event.y, 12);
  assert.equal(event.press, true);
  assert.equal(event.kind, 'press');
});

test('decodeChunk parses SGR mouse drag and release', () => {
  const drag = decodeChunk('\x1b[<32;10;5M').events[0];
  assert.equal(drag.kind, 'drag');
  assert.equal(drag.btn, 0);
  const up = decodeChunk('\x1b[<0;10;5m').events[0];
  assert.equal(up.kind, 'release');
  assert.equal(up.press, false);
});

test('decodeChunk reports mouse motion without a pressed button', () => {
  const event = decodeChunk('\x1b[<35;10;5M').events[0];
  assert.equal(event.kind, 'move');
  assert.equal(event.btn, 3);
  const shifted = decodeChunk('\x1b[<39;10;5M').events[0];
  assert.equal(shifted.kind, 'move');
});

// [key, pane, action]; undefined is the pane of the default bindings
const KEY_ACTIONS = [
  ['ctrl-c', undefined, null],
  ['right', undefined, 'next'],
  ['j', undefined, 'next'],
  ['left', undefined, 'prev'],
  ['k', undefined, 'prev'],
  ['up', undefined, 'scrollUp'],
  ['down', undefined, 'scrollDown'],
  ['ctrl-y', undefined, 'scrollUp'],
  ['ctrl-e', undefined, 'scrollDown'],
  ['ctrl-b', undefined, 'pageUp'],
  ['ctrl-f', undefined, 'pageDown'],
  ['pageUp', undefined, 'pageUp'],
  ['pageDown', undefined, 'pageDown'],
  ['home', undefined, 'home'],
  ['end', undefined, 'end'],
  ['ctrl-u', undefined, 'halfUp'],
  ['ctrl-d', undefined, 'halfDown'],
  ['enter', undefined, 'open'],
  ['e', undefined, 'code'],
  ['c', undefined, 'commit'],
  ['l', undefined, 'theme'],
  ['x', undefined, null],
  [' ', undefined, null],
  ['g', undefined, null],
  ['r', undefined, null],
  ['backspace', undefined, 'removeTask'],
  ['delete', undefined, 'removeTask'],
  ['s', undefined, null],
  ['h', undefined, null],
  ['?', undefined, null],
  ['v', undefined, null],
  ['p', undefined, 'prev'],
  ['u', undefined, 'unstage'],
  ['b', undefined, null],
  ['b', 'files', 'dashBranches'],
  ['p', 'files', 'prev'],
  ['u', 'files', 'unstage'],
  ['u', 'unit', 'unstage'],
  ['f', 'files', 'dashFiles'],
  ['f', 'diff', 'dashFiles'],
  ['delete', 'files', 'revert'],
  ['delete', 'diff', 'revert'],
  ['delete', 'unit', 'revert'],
  ['d', 'files', 'dashDiffs'],
  ['d', 'diff', 'dashDiffs'],
  ['f', 'diff', 'dashFiles'],
  ['left', 'unit', 'prev'],
  ['right', 'unit', 'next'],
  ['s', 'files', null],
  ['n', undefined, 'next'],
  ['n', 'branches', 'dashNpm'],
  ['insert', 'branches', 'newBranch'],
  ['e', 'branches', 'rebase'],
  ['r', 'branches', 'dashRun'],
  ['d', 'branches', 'dashDiffs'],
  ['delete', 'branches', 'drop'],
  ['p', 'branches', 'pull'],
  ['s', 'branches', 'push'],
  ['left', 'branches', 'treeLeft'],
  ['right', 'branches', 'treeRight'],
  ['left', 'commits', null],
  ['j', 'branches', 'next'],
  ['k', 'branches', 'prev'],
  ['up', 'branches', 'scrollUp'],
  ['down', 'branches', 'scrollDown'],
  ['a', 'commits', 'add'],
  ['p', 'commits', 'apply'],
  ['e', 'commits', 'reword'],
  ['ctrl-e', 'commits', null],
  ['u', 'commits', 'updateTime'],
  ['x', 'commits', null],
  ['r', 'commits', 'dashRun'],
  ['f', 'commits', 'dashFiles'],
  ['d', 'commits', 'dashDiffs'],
  ['delete', 'commits', 'drop'],
  ['c', 'commits', 'dashCommits'],
  ['insert', 'commits', 'newCommit'],
  ['s', 'commits', 'push'],
  ['v', 'commits', 'view'],
  ['m', 'commits', 'layout'],
  ['m', undefined, 'layout'],
  ['right', 'commits', null],
  ['left', 'files', null],
  ['right', 'files', null],
  ['n', 'files', 'dashNpm'],
  ['t', 'files', 'dashTasks'],
  ['c', 'files', 'dashCommits'],
  ['e', 'npm', 'npmEdit'],
  ['insert', 'npm', 'npmNew'],
  ['ctrl-t', 'diff', 'blockTask'],
  ['ctrl-t', 'unit', 'blockTask'],
  ['q', 'files', null],
  ['e', 'files', 'code'],
  ['e', 'diff', 'code'],
  ['m', 'diff', 'layout'],
  ['ctrl-l', 'diff', 'lines'],
  ['ctrl-l', 'unit', 'lines'],
  ['l', 'diff', 'theme'],
  ['p', 'dashboard', 'pull'],
  ['s', 'dashboard', 'push'],
  ['f1', 'diff', null],
  ['f12', undefined, null],
  ['n', 'npm', 'dashNpm'],
  ['d', 'npm', 'dashDiffs'],
  ['delete', 'npm', 'npmDrop'],
  ['l', 'npm', 'npmLogs'],
  ['insert', 'packages', 'packageNew'],
  ['delete', 'packages', 'packageDrop'],
  ['w', 'packages', 'packageWanted'],
  ['l', 'packages', 'packageLatest'],
  ['c', 'npm', 'dashCommits'],
  ['ctrl-r', 'tasks', 'taskDrop'],
  ['ctrl-i', 'tasks', 'taskImport'],
  ['tab', 'tasks', null],
  ['insert', 'tasks', 'taskNew'],
  ['ctrl-b', 'tasks', 'blockMenu'],
  ['ctrl-l', 'tasks', 'taskPriority'],
  ['ctrl-d', 'tasks', 'taskDone'],
  ['ctrl-p', 'tasks', 'plan'],
  ['j', 'files', 'next'],
  ['k', 'files', 'prev'],
  ['a', 'files', 'add'],
  ['a', 'diff', 'add'],
  ['a', 'unit', 'add'],
  ['a', 'dashboard', 'dashAgents'],
  ['a', 'npm', 'add'],
  ['m', 'agents', 'agentModel'],
  ['e', 'agents', 'agentEffort'],
  ['a', 'agents', 'agentSelect'],
  ['o', 'agents', 'agentFast'],
  ['x', 'agents', 'agentContext'],
  ['p', 'agents', 'agentReview'],
  ['c', 'agents', 'dashCommits'],
  ['r', 'agents', 'dashRun'],
  ['l', 'agents', 'agentAuth'],
  ['g', 'agents', null],
  ['s', 'agents', 'agentStart'],
  ['enter', 'agents', 'open'],
  ['i', 'agents', 'agentInstall'],
  ['i', 'files', 'ignore'],
  ['r', 'files', 'dashRun'],
  ['escape', undefined, null],
];

test('actionFromKey maps aliases and ignores unbound keys', () => {
  for (const [key, pane, action] of KEY_ACTIONS) {
    assert.equal(actionFromKey(key, pane), action, `${key} on ${pane}`);
  }
});

test('button words and letters name the bound keys', () => {
  assert.equal(actions.buttonWord('newBranch'), 'insert');
  assert.equal(actions.buttonWord('npmNew'), 'insert');
  assert.equal(actions.actionLetter('newCommit'), 'ins');
  assert.equal(actions.buttonWord('lines'), '^lines');
  assert.equal(actions.buttonWord('revert'), 'delete');
  assert.equal(actions.buttonWord('listSelectAll'), '^all');
  assert.equal(actions.buttonWord('npmTask'), '^task');
  assert.equal(actions.actionLetter('blockTask'), '^t');
  assert.equal(actions.buttonWord('blockTask'), '^task');
  assert.equal(actions.buttonWord('packageWanted'), 'wanted');
  assert.equal(actions.buttonWord('packageLatest'), 'latest');
  const dashOff = disabledActions('dashboard', null);
  assert.equal(dashOff.includes('pull'), false);
  assert.equal(dashOff.includes('push'), false);
});

test('layoutButtons hitboxes cover labels', () => {
  const layout = layoutButtons(160);
  assert.equal(layout.hits[0].id, 'add');
  assert.ok(!layout.parts.some((part) => part.id === 'reload'));
  assert.ok(!layout.parts.some((part) => part.id === 'newBranch'));
  assert.ok(!layout.parts.some((part) => part.id === 'files'));
  assert.equal(layout.parts[0].label, 'add');
  assert.equal(layout.parts[0].letter, 'a');
  assert.equal(layout.parts[0].piece, ' add');
  assert.equal(layout.parts[1].piece, '  unstage');
  assert.ok(!layout.parts[0].piece.includes('['));
  assert.equal(layout.parts[1].id, 'unstage');
  assert.equal(layout.parts[3].id, 'ignore');
  assert.equal(layout.parts[4].id, 'commit');
  assert.equal(layout.parts[5].id, 'prev');
  assert.equal(layout.parts[6].id, 'next');
  assert.equal(hitAction(layout.hits, layout.hits[0].x0), 'add');
  const diff80 = layoutButtons(80, { hidden: DIFF_DISABLED });
  assert.equal(diff80.parts[0].label, 'add');
  assert.ok(!diff80.parts.some((part) => part.id === 'reload'));
  assert.ok(!diff80.parts.some((part) => part.id === 'commit'));
  const letters = layoutButtons(20, { compact: true });
  assert.equal(letters.parts[0].label, 'a');
  assert.equal(letters.parts[0].piece, ' a');
  assert.ok(!letters.parts[0].piece.includes('['));
  const prev = letters.parts.find((part) => part.id === 'prev');
  assert.equal(prev.label, '←');
  const off = layoutButtons(160, { hidden: FILES_DISABLED });
  const hitIds = off.hits.map((hit) => hit.id);
  assert.equal(hitIds.includes('layout'), false);
  assert.equal(hitIds.includes('blockTask'), false);
  assert.equal(hitIds.includes('code'), true);
  assert.equal(hitIds.includes('add'), true);
  assert.equal(hitIds.includes('reload'), false);
  assert.equal(hitIds.includes('branch'), true);
  assert.equal(hitIds.includes('pull'), false);
  assert.equal(hitIds.includes('push'), false);
  assert.equal(hitIds.includes('newBranch'), false);
  const ids = off.parts.map((part) => part.id);
  assert.equal(ids.includes('layout'), false);
  assert.equal(ids.includes('blockTask'), false);
  assert.equal(ids.includes('code'), true);
  assert.equal(ids.includes('tasks'), true);
  const filesHint = layoutButtons(160, {
    hidden: FILES_HIDDEN,
    extra: [
      'dashFiles',
      'dashTasks',
      'dashBranches',
      'dashNpm',
      'dashRun',
      'dashCommits',
    ],
  });
  const filesIds = filesHint.parts.map((part) => part.id);
  assert.deepEqual(filesIds, [
    'dashFiles',
    'dashTasks',
    'dashBranches',
    'dashNpm',
    'dashRun',
    'dashCommits',
    'add',
    'unstage',
    'revert',
    'ignore',
    'code',
  ]);
  assert.ok(!filesIds.includes('diff'));
  assert.ok(!filesIds.includes('pull'));
  assert.ok(!filesIds.includes('push'));
  assert.ok(!filesIds.includes('prev'));
  assert.ok(!filesIds.includes('next'));
  const todo = layoutButtons(160, { hidden: TASKS_DISABLED });
  const todoIds = todo.parts.map((part) => part.id);
  assert.equal(todoIds.includes('commit'), false);
  assert.equal(todoIds.includes('tasks'), false);
  assert.equal(todoIds.includes('open'), false);
  const dim = layoutButtons(160, {
    hidden: FILES_HIDDEN,
    extra: ['commit', 'pull', 'push'],
    disabled: FILES_GIT_DISABLED,
  });
  const dimAdd = dim.parts.find((part) => part.id === 'add');
  assert.equal(dimAdd.disabled, true);
  assert.equal(
    dim.hits.find((hit) => hit.id === 'add'),
    undefined,
  );
  assert.ok(dim.parts.some((part) => part.id === 'commit'));
  assert.ok(dim.hits.some((hit) => hit.id === 'commit'));
});

test('disabledActions hides add unstage drop ignore on files todos', () => {
  const file = disabledActions('files', { path: 'a.js', remaining: 1 });
  assert.equal(file.includes('add'), false);
  assert.equal(file.includes('unstage'), false);
  assert.equal(file.includes('revert'), false);
  assert.equal(file.includes('ignore'), false);
  assert.equal(file.includes('pull'), false);
  assert.equal(file.includes('push'), false);
  const todos = disabledActions('files', { kind: 'tasks' });
  assert.deepEqual(todos, FILES_TASKS_DISABLED);
  assert.equal(todos.includes('add'), true);
  assert.equal(todos.includes('commit'), false);
  const page = disabledActions('diff', { origin: 'task' });
  assert.equal(page.includes('add'), true);
  assert.equal(page.includes('commit'), true);
  assert.equal(page.includes('tasks'), true);
  const staged = disabledActions('diff', { origin: 'staged' });
  assert.equal(staged.includes('add'), true);
  assert.equal(staged.includes('unstage'), false);
  const unstaged = disabledActions('diff', { origin: 'unstaged' });
  assert.equal(unstaged.includes('add'), false);
  assert.equal(unstaged.includes('unstage'), true);
  assert.equal(unstaged.includes('commit'), true);
  const unitView = disabledActions('unit', { origin: 'unstaged' });
  assert.equal(unitView.includes('layout'), true);
  assert.equal(unitView.includes('file'), true);
  assert.equal(unitView.includes('diff'), true);
  assert.equal(unitView.includes('unstage'), true);
  assert.equal(unitView.includes('add'), false);
  assert.equal(unitView.includes('feedback'), false);
  const quiet = disabledActions('files', { path: 'a.js', remaining: 0 });
  assert.equal(quiet.includes('add'), true);
  assert.equal(quiet.includes('unstage'), true);
  assert.equal(quiet.includes('revert'), true);
  assert.equal(quiet.includes('ignore'), false);
  const quietLine = disabledActions('unit', {
    origin: 'unstaged',
    lineDiff: false,
  });
  assert.equal(quietLine.includes('add'), true);
  assert.equal(quietLine.includes('revert'), true);
  assert.equal(quietLine.includes('unstage'), true);
  assert.ok(UNIT_DISABLED.includes('file'));
  assert.ok(UNIT_DISABLED.includes('diff'));
  const current = disabledActions('branches', { name: 'feat', current: true });
  assert.equal(current.includes('rebase'), true);
  assert.equal(current.includes('drop'), true);
  assert.equal(current.includes('pull'), false);
  assert.equal(current.includes('push'), false);
  assert.equal(current.includes('prev'), true);
  assert.equal(current.includes('next'), true);
  const onto = disabledActions('branches', { name: 'main', current: false });
  assert.equal(onto.includes('rebase'), false);
  assert.equal(onto.includes('drop'), false);
  assert.equal(onto.includes('pull'), false);
  assert.equal(onto.includes('push'), false);
  const branchIds = ['newBranch', 'rebase', 'drop', 'pull', 'push'];
  const branchLayout = layoutButtons(160, {
    hidden: BRANCHES_DISABLED,
    extra: branchIds,
    disabled: ['rebase', 'drop'],
  });
  assert.ok(branchLayout.parts.some((part) => part.id === 'drop'));
  assert.ok(branchLayout.parts.some((part) => part.id === 'pull'));
  assert.ok(branchLayout.hits.some((hit) => hit.id === 'pull'));
  assert.ok(branchLayout.hits.some((hit) => hit.id === 'push'));
  assert.ok(!branchLayout.parts.some((part) => part.id === 'prev'));
  assert.ok(!branchLayout.parts.some((part) => part.id === 'next'));
  assert.equal(
    branchLayout.hits.find((hit) => hit.id === 'drop'),
    undefined,
  );
  const ontoLayout = layoutButtons(160, {
    hidden: BRANCHES_DISABLED,
    extra: branchIds,
    disabled: ['pull', 'push'],
  });
  assert.ok(ontoLayout.parts.some((part) => part.id === 'pull'));
  assert.ok(ontoLayout.parts.some((part) => part.id === 'push'));
  assert.equal(
    ontoLayout.hits.find((hit) => hit.id === 'pull'),
    undefined,
  );
  assert.equal(
    ontoLayout.hits.find((hit) => hit.id === 'push'),
    undefined,
  );
  assert.ok(ontoLayout.hits.some((hit) => hit.id === 'rebase'));
  assert.ok(ontoLayout.hits.some((hit) => hit.id === 'drop'));
  const commitIds = ['amend', 'apply', 'reword', 'fixup', 'drop', 'view'];
  const head = { sha: 'aaa', canCommit: true, unstagedCurrent: true };
  const commitOff = disabledActions('commits', head);
  assert.equal(commitOff.includes('amend'), false);
  const viewed = { sha: 'aaa', canCommit: true };
  assert.equal(disabledActions('commits', viewed).includes('amend'), true);
  const pending = { pending: true, sha: '', canCommit: true };
  const pendingOff = disabledActions('commits', pending);
  assert.equal(pendingOff.includes('amend'), false);
  assert.equal(pendingOff.includes('apply'), true);
  assert.equal(pendingOff.includes('reword'), true);
  assert.equal(pendingOff.includes('drop'), true);
  assert.equal(disabledActions('commits', viewed).includes('apply'), true);
  assert.equal(commitOff.includes('apply'), true);
  assert.equal(commitOff.includes('reword'), false);
  assert.equal(commitOff.includes('commit'), false);
  assert.equal(commitOff.includes('pull'), false);
  assert.equal(commitOff.includes('push'), false);
  assert.equal(commitOff.includes('prev'), true);
  assert.equal(commitOff.includes('layout'), true);
  const emptyOff = disabledActions('commits', { canCommit: true });
  assert.equal(emptyOff.includes('amend'), true);
  assert.equal(emptyOff.includes('apply'), true);
  assert.equal(emptyOff.includes('reword'), true);
  assert.equal(emptyOff.includes('commit'), false);
  const fixup = { sha: 'aaa', subject: 'fixup! init', canCommit: true };
  const fixupDim = actions.commitGitDisabled(fixup);
  assert.equal(fixupDim.includes('apply'), false);
  const headDim = actions.commitGitDisabled(head);
  assert.equal(headDim.includes('apply'), true);
  assert.equal(headDim.includes('newCommit'), false);
  const quietPending = { pending: true, sha: '', canCommit: false };
  const quietOlder = { sha: 'bbb', canCommit: false };
  const pendingDim = actions.commitGitDisabled(quietPending);
  const olderDim = actions.commitGitDisabled(quietOlder);
  assert.equal(pendingDim.includes('newCommit'), false);
  assert.equal(olderDim.includes('newCommit'), false);
  const commitLayout = layoutButtons(160, {
    hidden: COMMITS_DISABLED,
    extra: commitIds,
    disabled: ['commit', 'fixup', 'apply'],
  });
  assert.ok(commitLayout.parts.some((part) => part.id === 'commit'));
  assert.ok(commitLayout.parts.some((part) => part.id === 'amend'));
  assert.ok(commitLayout.parts.some((part) => part.id === 'apply'));
  assert.ok(commitLayout.parts.some((part) => part.id === 'reword'));
  assert.ok(commitLayout.parts.some((part) => part.id === 'drop'));
  const view = commitLayout.parts.find((part) => part.id === 'view');
  assert.equal(view.label, 'view');
  const edited = commitLayout.parts.find((part) => part.id === 'reword');
  assert.equal(edited.label, 'edit');
  const removed = commitLayout.parts.find((part) => part.id === 'drop');
  assert.equal(removed.label, 'delete');
  assert.equal(removed.letter, 'del');
  assert.ok(commitLayout.hits.some((hit) => hit.id === 'view'));
  assert.ok(!commitLayout.parts.some((part) => part.id === 'pull'));
  assert.ok(!commitLayout.parts.some((part) => part.id === 'push'));
  assert.ok(!commitLayout.parts.some((part) => part.id === 'prev'));
  assert.ok(!commitLayout.parts.some((part) => part.id === 'layout'));
  assert.equal(
    commitLayout.hits.find((hit) => hit.id === 'commit'),
    undefined,
  );
  assert.equal(
    commitLayout.hits.find((hit) => hit.id === 'apply'),
    undefined,
  );
  assert.ok(commitLayout.hits.some((hit) => hit.id === 'amend'));
});

test('footer pins screen keys right and shrinks them first', () => {
  const options = {
    extra: ['add', 'unstage', 'revert', 'ignore', 'code'],
    backId: 'back',
    globals: DASH_IDS,
    tail: false,
    after: ['pull', 'push'],
  };
  const wide = layoutButtons(160, options);
  const push = wide.hits.find((hit) => hit.id === 'push');
  const add = wide.parts.find((part) => part.id === 'add');
  const files = wide.parts.find((part) => part.id === 'dashFiles');
  assert.equal(add.label, 'add');
  assert.equal(files.label, 'files');
  assert.equal(push.x1, 159);
  const narrow = layoutButtons(72, options);
  const shortFiles = narrow.parts.find((part) => part.id === 'dashFiles');
  const kept = narrow.parts.find((part) => part.id === 'add');
  assert.equal(kept.label, 'add');
  assert.equal(shortFiles.label, 'f');
  const filesHit = narrow.hits.find((hit) => hit.id === 'dashFiles');
  const addHit = narrow.hits.find((hit) => hit.id === 'add');
  assert.ok(filesHit.x0 > addHit.x1);
});
