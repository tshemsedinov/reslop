'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const keys = require('../lib/keys.js');
const { FILES_DISABLED, FILES_TODO_DISABLED, FILES_GIT_DISABLED } = keys;
const { DIFF_DISABLED, TODO_DISABLED, BRANCHES_DISABLED } = keys;
const { decodeChunk, actionFromKey, hitAction, disabledActions } = keys;
const { actionLetter, buttonWord } = keys;
const { layoutButtons } = require('../lib/render.js');

test('decodeChunk maps letters and arrows', () => {
  const keys = decodeChunk('ar').events.map((event) => event.key);
  assert.deepEqual(keys, ['a', 'r']);
  const up = decodeChunk('\x1b[A').events[0];
  assert.equal(up.key, 'up');
  const pending = decodeChunk('\x1b');
  assert.equal(pending.events.length, 0);
  assert.equal(pending.carry, '\x1b');
  const completed = decodeChunk('[A', pending.carry);
  assert.equal(completed.events[0].key, 'up');
  const enter = decodeChunk('\r').events[0];
  assert.equal(enter.key, 'enter');
  const back = decodeChunk('\x7f').events[0];
  assert.equal(back.key, 'backspace');
  const tab = decodeChunk('\t').events[0];
  assert.equal(tab.key, 'tab');
  const save = decodeChunk('\x13').events[0];
  assert.equal(save.key, 'ctrl-s');
  const undo = decodeChunk('\x1a').events[0];
  assert.equal(undo.key, 'ctrl-z');
  const scrollDown = decodeChunk('\x05').events[0];
  assert.equal(scrollDown.key, 'ctrl-e');
  const pageDown = decodeChunk('\x06').events[0];
  assert.equal(pageDown.key, 'ctrl-f');
  const del = decodeChunk('\x1b[3~').events[0];
  assert.equal(del.key, 'delete');
  const pgUp = decodeChunk('\x1b[5~').events[0];
  assert.equal(pgUp.key, 'pageUp');
  const pgDown = decodeChunk('\x1b[6~').events[0];
  assert.equal(pgDown.key, 'pageDown');
  const home = decodeChunk('\x1b[H').events[0];
  assert.equal(home.key, 'home');
  const end = decodeChunk('\x1b[F').events[0];
  assert.equal(end.key, 'end');
  const homeTilde = decodeChunk('\x1b[1~').events[0];
  assert.equal(homeTilde.key, 'home');
  const ss3Home = decodeChunk('\x1bOH').events[0];
  assert.equal(ss3Home.key, 'home');
  const ctrlLeft = decodeChunk('\x1b[1;5D').events[0];
  assert.equal(ctrlLeft.key, 'ctrl-left');
  const ctrlRight = decodeChunk('\x1b[1;5C').events[0];
  assert.equal(ctrlRight.key, 'ctrl-right');
});

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

test('actionFromKey maps aliases and ignores unbound keys', () => {
  assert.equal(actionFromKey('right'), 'next');
  assert.equal(actionFromKey('j'), 'next');
  assert.equal(actionFromKey('left'), 'prev');
  assert.equal(actionFromKey('k'), 'prev');
  assert.equal(actionFromKey('up'), 'scrollUp');
  assert.equal(actionFromKey('down'), 'scrollDown');
  assert.equal(actionFromKey('ctrl-y'), 'scrollUp');
  assert.equal(actionFromKey('ctrl-e'), 'scrollDown');
  assert.equal(actionFromKey('ctrl-b'), 'pageUp');
  assert.equal(actionFromKey('ctrl-f'), 'pageDown');
  assert.equal(actionFromKey('pageUp'), 'pageUp');
  assert.equal(actionFromKey('pageDown'), 'pageDown');
  assert.equal(actionFromKey('home'), 'home');
  assert.equal(actionFromKey('end'), 'end');
  assert.equal(actionFromKey('ctrl-u'), 'halfUp');
  assert.equal(actionFromKey('ctrl-d'), 'halfDown');
  assert.equal(actionFromKey('enter'), 'open');
  assert.equal(actionFromKey('e'), 'code');
  assert.equal(actionFromKey('d'), 'revert');
  assert.equal(actionFromKey('c'), 'commit');
  assert.equal(actionFromKey('l'), 'theme');
  assert.equal(actionFromKey('g'), null);
  assert.equal(actionFromKey('r'), 'reload');
  assert.equal(actionFromKey('backspace'), 'removeTodo');
  assert.equal(actionFromKey('delete'), 'removeTodo');
  assert.equal(actionFromKey('s'), null);
  assert.equal(actionFromKey('h'), null);
  assert.equal(actionFromKey('?'), null);
  assert.equal(actionFromKey('v'), null);
  assert.equal(actionFromKey('p'), 'prev');
  assert.equal(actionFromKey('u'), 'unstage');
  assert.equal(actionFromKey('b'), null);
  assert.equal(actionFromKey('b', 'files'), 'branch');
  assert.equal(actionFromKey('p', 'files'), 'pull');
  assert.equal(actionFromKey('u', 'files'), 'unstage');
  assert.equal(actionFromKey('s', 'files'), 'push');
  assert.equal(actionFromKey('n'), 'next');
  assert.equal(actionFromKey('n', 'branches'), 'newBranch');
  assert.equal(actionFromKey('r', 'branches'), 'rebase');
  assert.equal(actionFromKey('d', 'branches'), 'drop');
  assert.equal(actionFromKey('d'), 'revert');
  assert.equal(actionFromKey('r'), 'reload');
  assert.equal(actionFromKey('r', 'files'), 'reload');
  assert.equal(actionFromKey('escape'), null);
});

test('layoutButtons hitboxes cover labels', () => {
  const layout = layoutButtons(160, false);
  assert.equal(layout.hits[0].id, 'add');
  assert.ok(layout.parts.some((part) => part.action.id === 'reload'));
  assert.ok(!layout.parts.some((part) => part.action.id === 'newBranch'));
  assert.ok(!layout.parts.some((part) => part.action.id === 'files'));
  assert.equal(layout.parts[0].label, 'add');
  assert.equal(layout.parts[0].letter, 'a');
  assert.equal(layout.parts[0].piece, '  add');
  assert.ok(!layout.parts[0].piece.includes('['));
  assert.equal(layout.parts[1].action.id, 'unstage');
  assert.equal(layout.parts[3].action.id, 'commit');
  assert.equal(layout.parts[4].action.id, 'prev');
  assert.equal(layout.parts[5].action.id, 'next');
  assert.equal(hitAction(layout.hits, layout.hits[0].x0), 'add');
  const diff80 = layoutButtons(80, false, DIFF_DISABLED);
  assert.equal(diff80.parts[0].label, 'add');
  assert.ok(!diff80.parts.some((part) => part.action.id === 'reload'));
  assert.ok(!diff80.parts.some((part) => part.action.id === 'commit'));
  const letters = layoutButtons(20, true);
  assert.equal(letters.parts[0].label, 'a');
  assert.equal(letters.parts[0].piece, '  a');
  assert.ok(!letters.parts[0].piece.includes('['));
  const prev = letters.parts.find((part) => part.action.id === 'prev');
  assert.equal(prev.label, '←');
  const off = layoutButtons(160, false, FILES_DISABLED);
  const hitIds = off.hits.map((hit) => hit.id);
  assert.equal(hitIds.includes('layout'), false);
  assert.equal(hitIds.includes('feedback'), false);
  assert.equal(hitIds.includes('code'), false);
  assert.equal(hitIds.includes('add'), true);
  assert.equal(hitIds.includes('reload'), true);
  assert.equal(hitIds.includes('branch'), true);
  assert.equal(hitIds.includes('pull'), true);
  assert.equal(hitIds.includes('push'), true);
  assert.equal(hitIds.includes('newBranch'), false);
  const ids = off.parts.map((part) => part.action.id);
  assert.equal(ids.includes('layout'), false);
  assert.equal(ids.includes('feedback'), false);
  assert.equal(ids.includes('code'), false);
  assert.equal(ids.includes('todo'), true);
  const todo = layoutButtons(160, false, TODO_DISABLED);
  const todoIds = todo.parts.map((part) => part.action.id);
  assert.equal(todoIds.includes('commit'), false);
  assert.equal(todoIds.includes('todo'), false);
  assert.equal(todoIds.includes('open'), false);
  const dim = layoutButtons(160, false, FILES_DISABLED, [], FILES_GIT_DISABLED);
  const dimAdd = dim.parts.find((part) => part.action.id === 'add');
  assert.equal(dimAdd.disabled, true);
  assert.equal(
    dim.hits.find((hit) => hit.id === 'add'),
    undefined,
  );
  assert.ok(dim.parts.some((part) => part.action.id === 'commit'));
  assert.ok(dim.hits.some((hit) => hit.id === 'commit'));
});

test('disabledActions hides add unstage drop on files todos', () => {
  const file = disabledActions('files', { path: 'a.js' });
  assert.equal(file.includes('add'), false);
  assert.equal(file.includes('unstage'), false);
  assert.equal(file.includes('revert'), false);
  const todos = disabledActions('files', { kind: 'todos' });
  assert.deepEqual(todos, FILES_TODO_DISABLED);
  assert.equal(todos.includes('add'), true);
  assert.equal(todos.includes('commit'), false);
  const page = disabledActions('diff', { origin: 'todo' });
  assert.equal(page.includes('add'), true);
  assert.equal(page.includes('commit'), true);
  assert.equal(page.includes('todo'), true);
  const staged = disabledActions('diff', { origin: 'staged' });
  assert.equal(staged.includes('add'), true);
  assert.equal(staged.includes('unstage'), false);
  const unstaged = disabledActions('diff', { origin: 'unstaged' });
  assert.equal(unstaged.includes('add'), false);
  assert.equal(unstaged.includes('unstage'), true);
  assert.equal(unstaged.includes('commit'), true);
  const current = disabledActions('branches', { name: 'feat', current: true });
  assert.equal(current.includes('rebase'), true);
  assert.equal(current.includes('drop'), true);
  const onto = disabledActions('branches', { name: 'main', current: false });
  assert.equal(onto.includes('rebase'), false);
  assert.equal(onto.includes('drop'), false);
  const branchLayout = layoutButtons(
    160,
    false,
    BRANCHES_DISABLED,
    ['newBranch', 'rebase', 'drop'],
    ['rebase', 'drop'],
  );
  assert.ok(branchLayout.parts.some((part) => part.action.id === 'drop'));
  assert.equal(
    branchLayout.hits.find((hit) => hit.id === 'drop'),
    undefined,
  );
});

test('buttonWord is the footer hint including the bound mark', () => {
  assert.equal(actionLetter('next'), '→');
  assert.equal(actionLetter('prev'), '←');
  assert.equal(buttonWord('next'), '→');
  assert.equal(buttonWord('prev'), '←');
  assert.equal(buttonWord('quit'), 'q');
});
