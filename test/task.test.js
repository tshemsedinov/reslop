'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { TaskItem, parseTitle } = require('../lib/review/task.js');
const { parseReview } = require('../lib/review/review.js');
const { taskKind, kindFields } = require('../lib/common/files.js');

const B1 = [
  '- [ ] B1 high: Released connection can be assigned to two consumers',
  '  - where: `lib/pool.js` acquire:84, release',
  '  - problem: `release()` resolves a waiter before ownership',
  '    is updated',
  '  - do: hand the connection over under one lock',
  '  - check:',
  '    - [ ] 100 concurrent acquires never share a connection',
  '    - [x] `npm t` passes',
  '  - owner: someone',
  '',
  '  Free text after the fields.',
];

const same = (before, after, changed) => {
  assert.equal(after.length, before.length);
  const diff = [];
  for (let i = 0; i < before.length; i++) {
    if (before[i] !== after[i]) diff.push(i);
  }
  assert.deepEqual(diff, changed);
};

test('parseTitle reads the ID, the priority, and the title', () => {
  const read = (text) => {
    const { id, priority, title } = parseTitle(text);
    return [id, priority, title];
  };
  assert.deepEqual(read('B1 high: Released twice'), [
    'B1',
    'high',
    'Released twice',
  ]);
  assert.deepEqual(read('F1: Parse items'), ['F1', '', 'Parse items']);
  assert.deepEqual(read('f12 lower case'), ['f12', '', 'lower case']);
  assert.deepEqual(read('high: Data loss'), ['', 'high', 'Data loss']);
  assert.deepEqual(read('critical: x'), ['', '', 'critical: x']);
  assert.deepEqual(read('S3 LOW: shout'), ['S3', 'low', 'shout']);
  assert.deepEqual(read('low memory crash'), ['', '', 'low memory crash']);
  assert.deepEqual(read('B2 low memory crash'), ['B2', '', 'low memory crash']);
  assert.deepEqual(read('Timeout names the pool'), [
    '',
    '',
    'Timeout names the pool',
  ]);
  assert.deepEqual(read('F1'), ['F1', '', '']);
});

test('TaskItem reads fields, values, checks, and unknown keys', () => {
  const item = new TaskItem(B1);
  assert.equal(item.id, 'B1');
  assert.equal(item.priority, 'high');
  assert.equal(
    item.title,
    'Released connection can be assigned to two consumers',
  );
  assert.equal(item.done, false);
  assert.deepEqual(
    item.fields.map((field) => field.key),
    ['where', 'problem', 'do', 'check', 'owner'],
  );
  assert.equal(
    item.value('problem'),
    '`release()` resolves a waiter before ownership\nis updated',
  );
  assert.equal(item.value('owner'), 'someone');
  assert.equal(item.value('expected'), '');
  assert.deepEqual(
    item.checks.map((check) => [check.done, check.text]),
    [
      [false, '100 concurrent acquires never share a connection'],
      [true, '`npm t` passes'],
    ],
  );
  assert.equal(item.field('owner').end, 9);
  assert.match(item.text, /Free text after the fields\.$/);
});

test('a one-line task is a complete task without fields', () => {
  const item = new TaskItem(['- [x] Timeout error message names the pool']);
  assert.equal(item.done, true);
  assert.equal(item.id, '');
  assert.deepEqual(item.fields, []);
  assert.deepEqual(item.checks, []);
});

test('setters leave every line they do not own byte-identical', () => {
  const item = new TaskItem(B1);
  same(B1, item.setDone(true), [0]);
  assert.equal(item.setDone(true)[0].slice(0, 6), '- [x] ');
  same(B1, item.setCheck(0, true), [6]);
  assert.equal(
    item.setCheck(0, true)[6],
    '    - [x] 100 concurrent acquires never share a connection',
  );
  same(B1, item.setCheck(1, true), []);
  same(B1, item.setField('where', '`lib/pool.js`'), [1]);
  const replaced = item.setField('problem', 'one line now');
  assert.equal(replaced.length, B1.length - 1);
  assert.equal(replaced[2], '  - problem: one line now');
  assert.deepEqual(replaced.slice(3), B1.slice(4));
});

test('setField puts fields in vocabulary order and drops empty ones', () => {
  const item = new TaskItem(B1);
  const added = item.setField('expected', 'one owner per connection');
  assert.equal(added.length, B1.length + 1);
  assert.equal(added[4], '  - expected: one owner per connection');
  assert.deepEqual(added.slice(0, 4), B1.slice(0, 4));
  assert.deepEqual(added.slice(5), B1.slice(4));
  const result = item.setField('result', 'fixed in abc123\ntests pass');
  assert.deepEqual(result.slice(8, 10), [
    '  - result: fixed in abc123',
    '    tests pass',
  ]);
  const dropped = item.setField('do', '');
  assert.equal(dropped.length, B1.length - 1);
  assert.ok(!dropped.some((line) => line.includes('- do:')));
  const plain = new TaskItem(['- [ ] F1: plain']);
  assert.deepEqual(plain.setField('check', '- [ ] works'), [
    '- [ ] F1: plain',
    '  - check:',
    '    - [ ] works',
  ]);
});

test('setId and setPriority rewrite only the head of the title line', () => {
  const plain = new TaskItem([
    '- [ ] Timeout names the pool',
    '  - where: a.js',
  ]);
  assert.deepEqual(plain.setId('B3'), [
    '- [ ] B3: Timeout names the pool',
    '  - where: a.js',
  ]);
  const item = new TaskItem(B1);
  assert.equal(
    item.setPriority('')[0],
    '- [ ] B1: Released connection can be assigned to two consumers',
  );
  assert.equal(new TaskItem(['- [ ] x']).setPriority('critical')[0], '- [ ] x');
});

test('CRLF tasks keep their line ends through setters', () => {
  const lines = ['- [ ] F1: a\r', '  - check:\r', '    - [ ] b\r'];
  const item = new TaskItem(lines);
  assert.equal(item.value('check'), '- [ ] b');
  assert.deepEqual(item.setCheck(0, true), [
    '- [ ] F1: a\r',
    '  - check:\r',
    '    - [x] b\r',
  ]);
  assert.deepEqual(item.setField('where', 'a.js').slice(1, 2), [
    '  - where: a.js\r',
  ]);
});

test('tasks in custom blocks have no kind', () => {
  const text = [
    '# Plan',
    '',
    '- [ ] before any block',
    '',
    '## Bug Reports and Fixes',
    '',
    '- [ ] crash',
    '',
    '### Pool',
    '',
    '- [ ] still a bug',
    '',
    '## Notes',
    '',
    '- [ ] custom',
  ].join('\n');
  const kinds = parseReview(text, '/x.md').tasks.map((task) => task.kind);
  assert.deepEqual(kinds, ['', 'bugs', 'bugs', '']);
  assert.equal(taskKind({ kind: '' }), '');
  assert.equal(taskKind({ kind: 'backlog' }), 'debt');
});

test('kinds carry suggested fields', () => {
  assert.deepEqual(kindFields('bugs'), [
    'where',
    'problem',
    'expected',
    'check',
  ]);
  assert.deepEqual(kindFields(''), []);
});
