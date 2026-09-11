'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const files = require('../lib/files.js');
const { fileEntries, fileStatus, itemPath } = files;

const item = (name, origin, indexHint) => ({
  origin,
  file: { newPath: name, oldPath: name },
  blockId: indexHint,
});

test('fileEntries groups blocks by path', () => {
  const items = [
    item('a.js', 'unstaged', 0),
    item('a.js', 'unstaged', 1),
    item('b.js', 'staged', 0),
    item('c.js', 'untracked', 0),
  ];
  const entries = fileEntries(items);
  assert.equal(entries.length, 3);
  assert.equal(entries[0].path, 'a.js');
  assert.equal(entries[0].remaining, 2);
  assert.equal(entries[0].status, 'unstaged');
  assert.equal(entries[0].unstaged, 2);
  assert.equal(entries[0].staged, 0);
  assert.equal(entries[0].firstIndex, 0);
  assert.equal(entries[1].path, 'b.js');
  assert.equal(entries[1].status, 'staged');
  assert.equal(entries[1].staged, 1);
  assert.equal(entries[2].path, 'c.js');
  assert.equal(entries[2].status, 'untracked');
  assert.equal(itemPath(items[0]), 'a.js');
});

test('fileStatus joins mixed origins', () => {
  assert.equal(fileStatus(['unstaged', 'staged']), 'partial');
  assert.equal(fileStatus(['staged', 'unstaged']), 'partial');
  assert.equal(fileStatus(['todo']), 'todo');
  assert.equal(fileStatus(['todo', 'unstaged']), 'unstaged');
});

test('fileEntries counts lines and mixed staged blocks', () => {
  const hunk = {
    lines: [
      { type: 'del', text: 'x', blockId: 0 },
      { type: 'add', text: 'y', blockId: 0 },
      { type: 'ctx', text: 'z', blockId: null },
      { type: 'add', text: 'w', blockId: 1 },
      { type: 'del', text: 'v', blockId: 1 },
      { type: 'del', text: 'u', blockId: 1 },
    ],
  };
  const unstaged = item('mix.js', 'unstaged', 0);
  unstaged.hunk = hunk;
  const staged = item('mix.js', 'staged', 1);
  staged.hunk = hunk;
  const entries = fileEntries([unstaged, staged]);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].status, 'partial');
  assert.equal(entries[0].staged, 1);
  assert.equal(entries[0].unstaged, 1);
  assert.equal(entries[0].added, 2);
  assert.equal(entries[0].removed, 3);
  assert.equal(entries[0].remaining, 2);
});
