'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { solveTasks } = require('../lib/session/npm/solve.js');
const { TaskItem, taskLines } = require('../lib/review/task.js');

const itemOf = (text) => new TaskItem(taskLines(text, false));

const failing = (at) => [
  `not ok ${at} the tasks tile counts other blocks, case ${at}`,
  '  ---',
  '  error: |-',
  '    Expected values to be strictly equal:',
  '    ',
  `    ${at}   !==   0`,
  '  expected: 0',
  `  actual: ${at}`,
  '  stack: |-',
  `    at run (/repo/lib/f${at % 4}.js:${at}:2)`,
  '    at Test.run (node:internal/test_runner/test:1:1)',
  '  ...',
];

const tap = (count) => {
  const cases = Array.from({ length: count }, (_, at) => failing(at + 1));
  const lines = ['TAP version 13', ...cases.flat(), `1..${count}`];
  return { raw: lines.join('\n'), exit: 1 };
};

const command = 'node bin/reslop.js t -- node scripts/run-tests.js --proc';

test('a failing test is a task of one plain line per field', () => {
  const [text] = solveTasks(tap(1), command, '', '/repo');
  assert.deepEqual(text.split('\n'), [
    'the tasks tile counts other blocks, case 1',
    '- where: lib/f1.js:1',
    '- problem: Expected values to be strictly equal: 1 !== 0' +
      ' (expected 0, actual 1)',
    `- check: \`${command}\` passes`,
  ]);
});

test('each distinct error is a task, the same one is not repeated', () => {
  const texts = solveTasks(tap(3), 'npm t', '', '/repo');
  assert.equal(texts.length, 3);
  const titles = texts.map((text) => itemOf(text).title);
  assert.deepEqual(
    titles,
    [1, 2, 3].map((at) => `the tasks tile counts other blocks, case ${at}`),
  );
  assert.equal(itemOf(texts[1]).value('where'), 'lib/f2.js:2');
  const same = (at) => [
    `not ok ${at} reads case ${at}`,
    '  ---',
    '  error: boom',
    '  stack: |-',
    '    at read (/repo/lib/a.js:3:1)',
    '  ...',
  ];
  const raw = ['TAP version 13', ...same(1), ...same(2), ...same(3), '1..3'];
  const merged = solveTasks(
    { raw: raw.join('\n'), exit: 1 },
    'npm t',
    '',
    '/repo',
  );
  assert.deepEqual(merged, [
    [
      'reads case 1, and 2 more',
      '- where: lib/a.js:3',
      '- problem: boom',
      '- check: `npm t` passes',
    ].join('\n'),
  ]);
});

test('plain output names its error line and long text ends at a word', () => {
  const output = ['building', '  ERROR   in   src/a.ts:3', '  cannot find x'];
  const run = { raw: output.join('\n'), exit: 2 };
  const [text] = solveTasks(run, 'npm run build', output.join('\n'), '/repo');
  assert.deepEqual(text.split('\n'), [
    '`npm run build` fails',
    '- where: src/a.ts:3',
    '- problem: ERROR in src/a.ts:3 cannot find x',
    '- check: `npm run build` passes',
  ]);
  const long = `error: ${'word '.repeat(100)}`;
  const [one] = solveTasks({ raw: long, exit: 1 }, 'x', long, '/repo');
  const item = itemOf(one);
  assert.match(item.value('problem'), /^error: (word )+…$/);
  assert.ok(item.value('problem').length <= 302);
});
