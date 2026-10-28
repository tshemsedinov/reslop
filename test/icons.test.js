'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const ansi = require('../lib/term/ansi.js');
const { visibleWidth, bg, fg, stripAnsi } = ansi;
const render = require('../lib/render/render.js');
const icons = require('../lib/render/icons.js');
const { FOLDER, fileIcon, extIcon, entryIcon, iconText } = icons;
const { fileMark, extMark, badgeColors } = icons;

const NAMES = [
  'a.js',
  'a.ts',
  'a.json',
  'a.md',
  'a.py',
  'a.java',
  'a.yml',
  'a.png',
  'package.json',
  'Dockerfile',
  '.gitignore',
  '.env',
  'LICENSE',
  'Makefile',
  'a.wasm',
  'notes',
  'a.sql',
  'a.rs',
  'lib/a.css',
];

test('file and folder icons take two columns', () => {
  assert.equal(FOLDER, '📁');
  assert.equal(visibleWidth(FOLDER), 2);
  for (const name of NAMES) {
    assert.equal(visibleWidth(fileIcon(name)), 2, name);
  }
  assert.equal(fileIcon('a.js'), 'js');
  assert.equal(fileIcon('lib/a.mjs'), 'js');
  assert.equal(fileIcon('a.ts'), 'ts');
  assert.equal(fileIcon('a.json'), '{}');
  assert.equal(fileIcon('package.json'), '📦');
  assert.equal(extIcon('.js'), 'js');
  assert.equal(extIcon('.md'), fileIcon('a.md'));
  assert.equal(extIcon('(none)'), fileIcon('notes'));
  assert.equal(visibleWidth(extIcon('.yml')), 2);
  assert.equal(visibleWidth(extIcon('.java')), 2);
  assert.equal(entryIcon({ kind: 'tasks', path: 'TODOs' }), '📋');
  assert.equal(visibleWidth(iconText({ path: 'a.js' })), 3);
  assert.equal(fileMark('a.js').tone, 'yellow');
  assert.equal(fileMark('lib/a.mjs').tone, 'yellow');
  assert.equal(fileMark('a.ts').tone, 'blue');
  assert.equal(extMark('.tsx').tone, 'blue');
  assert.equal(fileMark('a.json').tone, 'orange');
  assert.equal(fileMark('a.xml').tone, 'orange');
  assert.equal(fileMark('a.cs').tone, 'purple');
  assert.equal(fileMark('a.kt').tone, 'magenta');
  assert.equal(fileMark('a.go').tone, 'cyan');
  assert.equal(fileMark('a.md').tone, '');
  assert.equal(badgeColors('yellow').fg[0], 10);
  assert.equal(badgeColors(''), null);
});

test('letter icons paint on a colored chip', () => {
  const entry = (path, status, staged) => ({
    path,
    status,
    remaining: 1,
    staged,
    firstIndex: staged,
  });
  const files = [
    entry('a.js', 'unstaged', 0),
    entry('b.ts', 'staged', 1),
    entry('c.md', 'untracked', 0),
  ];
  const frame = render.renderFrame(
    {
      pane: 'files',
      files,
      fileCursor: 0,
      repoName: 'demo',
      counts: {},
      status: '',
      scroll: 0,
    },
    { width: 80, height: 10, color: true },
  );
  const row = (name) =>
    frame.rows.find((line) => stripAnsi(line).includes(name));
  const js = row('js a.js');
  const ts = row('ts b.ts');
  const md = row('c.md');
  const yellow = badgeColors('yellow');
  const blue = badgeColors('blue');
  assert.ok(js.includes(bg(yellow.bg)));
  assert.ok(js.includes(fg(yellow.fg)));
  assert.ok(ts.includes(bg(blue.bg)));
  assert.ok(ts.includes(fg(blue.fg)));
  assert.equal(md.includes(bg(yellow.bg)), false);
  assert.equal(md.includes(bg(blue.bg)), false);
});
