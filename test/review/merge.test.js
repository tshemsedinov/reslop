'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { mergeReview } = require('../../lib/review/merge.js');
const { parseReview, serializeReview } = require('../../lib/review/review.js');

const HEAD = ['---', 'status: partial', '---', '', '## Improvements', ''];

const AGENT_BASE = [
  ...HEAD,
  '- [ ] B1: pool hands out a connection twice',
  '  - check:',
  '    - [ ] no shared connection',
  '    - [ ] tests pass',
  '- [ ] B2: timeout names the pool',
  '',
].join('\n');

const plan = (...items) => [...HEAD, ...items, ''].join('\n');

const item = (text, done = false) => `- [${done ? 'x' : ' '}] ${text}`;

const storeWith = (text) => parseReview(text, '/repo/.plan/x.md');

const texts = (store) => store.tasks.map((task) => [task.text, task.done]);

const find = (store, text) => store.tasks.find((task) => task.text === text);

const taskRows = (store) =>
  store.tasks.map((task) => [task.item.title, task.done]);

test('mergeReview keeps our done change when disk deleted the todo', () => {
  const store = storeWith(plan(item('a'), item('b')));
  store.setTaskDone(find(store, 'a').id, true);
  mergeReview(store, plan(item('b')));
  assert.deepEqual(texts(store), [
    ['a', true],
    ['b', false],
  ]);
});

test('mergeReview takes disk done change for a todo we deleted', () => {
  const store = storeWith(plan(item('a'), item('b')));
  store.removeTask(find(store, 'a').id);
  mergeReview(store, plan(item('a', true), item('b')));
  assert.deepEqual(texts(store), [
    ['a', true],
    ['b', false],
  ]);
});

test('mergeReview drops todos deleted on one side and unchanged', () => {
  const store = storeWith(plan(item('a'), item('b'), item('c')));
  store.removeTask(find(store, 'b').id);
  mergeReview(store, plan(item('b'), item('c')));
  assert.deepEqual(texts(store), [['c', false]]);
});

test('mergeReview puts a disk rename in place of our todo', () => {
  const store = storeWith(plan(item('a'), item('b')));
  const id = find(store, 'a').id;
  mergeReview(store, plan(item('a2'), item('b')));
  assert.deepEqual(texts(store), [
    ['a2', false],
    ['b', false],
  ]);
  assert.equal(store.tasks[0].id, id);
});

test('mergeReview inserts new disk todos next to their neighbours', () => {
  const store = storeWith(plan(item('b')));
  store.addTask('TODOs', 'e', false, 'improvements');
  mergeReview(store, plan(item('a'), item('b'), item('c')));
  assert.deepEqual(
    store.tasks.map((task) => task.text),
    ['a', 'b', 'c', 'e'],
  );
  assert.equal(
    serializeReview(store),
    plan(item('a'), item('b'), item('c'), item('e')),
  );
});

test('an agent result and block survive a human edit elsewhere', () => {
  const store = storeWith(AGENT_BASE);
  const b2 = store.tasks[1];
  store.setTaskText(b2.id, 'B2: timeout message names the pool');
  const theirs = AGENT_BASE.replace(
    '    - [ ] tests pass\n',
    '    - [ ] tests pass\n  - result: ownership moves in one step\n',
  )
    .replace('- [ ] B1:', '- [x] B1:')
    .concat('\n## Verification\n\n- all pool tests pass\n');
  mergeReview(store, theirs);
  const out = serializeReview(store);
  assert.match(out, /- \[x\] B1: pool hands out/);
  assert.match(out, / {2}- result: ownership moves in one step\n/);
  assert.match(out, /- \[ \] B2: timeout message names the pool\n/);
  assert.match(out, /\n\n## Verification\n\n- all pool tests pass\n$/);
});

test('check items ticked on both sides merge item by item', () => {
  const store = storeWith(AGENT_BASE);
  const b1 = store.tasks[0];
  store.editTask(b1.id, (item) => item.setCheck(0, true));
  store.editTask(b1.id, (item) => item.setField('where', '`lib/pool.js`'));
  const theirs = AGENT_BASE.replace('- [ ] tests pass', '- [x] tests pass');
  mergeReview(store, theirs);
  const merged = store.tasks[0];
  assert.deepEqual(
    merged.item.checks.map((check) => check.done),
    [true, true],
  );
  assert.equal(merged.item.value('where'), '`lib/pool.js`');
});

test('a disk change to an untouched plan is taken as written', () => {
  const store = storeWith(AGENT_BASE);
  const ids = store.tasks.map((task) => task.id);
  const theirs = `${AGENT_BASE}\nfree text from an editor\n`;
  mergeReview(store, theirs);
  assert.equal(serializeReview(store), theirs);
  assert.deepEqual(
    store.tasks.map((task) => task.id),
    ids,
  );
});

test('the frontmatter status merges like any other block', () => {
  const store = storeWith(AGENT_BASE);
  store.addTask('TODOs', 'B3: new', false, 'improvements');
  mergeReview(store, AGENT_BASE.replace('status: partial', 'status: done'));
  assert.equal(store.status, 'done');
  assert.equal(store.tasks.length, 3);
});

test('mergeReview keeps tasks of one ID apart when ours move', () => {
  const text = plan(item('f1: alpha'), item('f1: beta'));
  const store = storeWith(text);
  const alpha = store.tasks[0];
  store.moveBlock(alpha.block, 1);
  mergeReview(store, plan(item('f1: alpha', true), item('f1: beta')));
  assert.deepEqual(taskRows(store), [
    ['beta', false],
    ['alpha', true],
  ]);
});

test('mergeReview does not cross tasks of one ID when disk drops one', () => {
  const store = storeWith(plan(item('f1: alpha'), item('f1: beta')));
  store.setTaskDone(store.tasks[1].id, true);
  mergeReview(store, plan(item('f1: beta')));
  assert.deepEqual(taskRows(store), [['beta', true]]);
});

test('mergeReview keeps both new tasks that share an ID', () => {
  const store = storeWith(plan(item('a')));
  store.addTask('', 'f1: mine');
  mergeReview(store, plan(item('a'), item('f1: theirs')));
  const titles = store.tasks.map((task) => task.item.title);
  assert.deepEqual(titles.sort(), ['a', 'mine', 'theirs']);
});

test('mergeReview still follows a task an agent retitled', () => {
  const store = storeWith(plan(item('f1: old'), item('b')));
  store.setTaskDone(store.tasks[1].id, true);
  mergeReview(store, plan(item('f1: new'), item('b')));
  assert.deepEqual(taskRows(store), [
    ['new', false],
    ['b', true],
  ]);
});
