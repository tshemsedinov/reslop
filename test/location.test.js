'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const location = require('../lib/review/location.js');
const { parseLocations, resolveLocation, symbolLine } = location;
const { tempDir } = require('./helpers.js');

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

test('resolveLocation keeps every location inside the root', () => {
  const root = tempDir('reslop-where-');
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'reslop-out-'));
  try {
    fs.mkdirSync(path.join(root, 'lib'));
    fs.writeFileSync(path.join(root, 'lib', 'a.js'), 'x\n');
    fs.writeFileSync(path.join(outside, 'secret'), 'key\n');
    let linked = true;
    try {
      fs.symlinkSync(outside, path.join(root, 'out'), 'dir');
    } catch {
      linked = false;
    }
    const at = (text) => resolveLocation(root, parseLocations(text)[0]);
    assert.deepEqual(at('lib/a.js:3'), {
      ok: true,
      rel: 'lib/a.js',
      line: 3,
      symbol: '',
    });
    assert.equal(at('lib/../lib/a.js').rel, 'lib/a.js');
    const refused = [
      '../../.ssh/id_rsa',
      'lib/../../x.js',
      '/etc/passwd',
      '~/.ssh/id_rsa',
      'C:\\Windows\\win.ini',
      'file:///etc/passwd',
      'https://example.com/a.js',
    ];
    for (const text of refused) {
      const found = at(text);
      assert.equal(found.ok, false, text);
      assert.match(found.error, /outside the repository|not opened/, text);
    }
    if (linked) {
      const found = at('out/secret');
      assert.equal(found.ok, false);
      assert.match(found.error, /outside the repository/);
    }
    assert.deepEqual(at('lib/missing.js'), {
      ok: false,
      error: 'not found: lib/missing.js',
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
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

test('parseLocations reads a range of lines', () => {
  const [range, one] = parseLocations('a.js:12-15, b.js:7:3');
  assert.deepEqual([range.path, range.line, range.end], ['a.js', 12, 15]);
  assert.deepEqual([one.path, one.line, one.end], ['b.js', 7, 7]);
});
