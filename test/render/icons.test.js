'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const ansi = require('../../lib/term/ansi.js');
const { visibleWidth, bg, fg, stripAnsi } = ansi;
const render = require('../../lib/render/render.js');
const icons = require('../../lib/render/icons.js');
const { FOLDER, entryIcon } = icons;
const { fileMark, extMark, badgeColors } = icons;

const fileIcon = (rel) => fileMark(rel).text;

const extIcon = (key) => extMark(key).text;

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
});

test('a language shares one tone and every tone has its colors', () => {
  const tone = (rel) => fileMark(rel).tone;
  assert.equal(tone('lib/a.mjs'), tone('a.js'));
  assert.equal(extMark('.tsx').tone, tone('a.ts'));
  assert.equal(tone('a.xml'), tone('a.json'));
  assert.notEqual(tone('a.js'), tone('a.ts'));
  assert.equal(tone('a.md'), '');
  assert.equal(badgeColors(''), null);
  for (const rel of [...NAMES, 'a.mjs', 'a.xml', 'a.cs', 'a.kt', 'a.go']) {
    const mark = fileMark(rel);
    if (!mark.tone) continue;
    const colors = badgeColors(mark.tone);
    assert.ok(colors, `${rel} has no colors for ${mark.tone}`);
    assert.notDeepEqual(colors.fg, colors.bg, rel);
  }
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
