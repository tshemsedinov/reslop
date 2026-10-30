'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const location = require('../lib/review/location.js');
const { parseLocations, symbolLine } = location;

const shape = (found) =>
  found.map((one) => one.url ?? `${one.path}|${one.line}|${one.symbol}`);

test('parseLocations reads paths, lines, symbols, and URLs', () => {
  assert.deepEqual(shape(parseLocations('`lib/pool.js` acquire:84, release')), [
    'lib/pool.js|0|',
  ]);
  assert.deepEqual(
    shape(
      parseLocations(
        'lib/session/terminal.js#readLoop, test/a.test.js:12; `b.md:3:1`',
      ),
    ),
    ['lib/session/terminal.js|0|readLoop', 'test/a.test.js|12|', 'b.md|3|'],
  );
  assert.deepEqual(
    shape(parseLocations('specs/s.md#task-item, https://x.dev/i/86, #86 F1')),
    ['specs/s.md|0|task-item', 'https://x.dev/i/86'],
  );
  assert.deepEqual(shape(parseLocations('file:///etc/passwd')), [
    'file:///etc/passwd',
  ]);
  assert.deepEqual(parseLocations('other task IDs, F2'), []);
});

test('symbolLine finds a symbol, a dotted path, or a heading anchor', () => {
  const code = [
    'class TaskPage {',
    '  view() {}',
    '  rows() {',
    '  }',
    '}',
    'const rows = 1;',
  ].join('\n');
  assert.equal(symbolLine(code, 'TaskPage'), 0);
  assert.equal(symbolLine(code, 'TaskPage.rows'), 2);
  assert.equal(symbolLine(code, 'missing'), -1);
  const doc = '# Spec\n\n## Task item\n\n### Plan menu\n';
  assert.equal(symbolLine(doc, 'task-item'), 2);
  assert.equal(symbolLine(doc, 'plan-menu'), 4);
});
