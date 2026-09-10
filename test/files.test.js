'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { fileEntries, fileStatus, itemPath } = require('../lib/files.js');

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
  assert.equal(entries[0].firstIndex, 0);
  assert.equal(entries[1].path, 'b.js');
  assert.equal(entries[1].status, 'staged');
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
