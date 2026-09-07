'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const diff = require('../lib/diff.js');
const { parseDiff, splitHunk, formatPatch, flattenBlock } = diff;
const { itemsFromFiles } = diff;

const SAMPLE = `diff --git a/n.js b/n.js
index 1111111..2222222 100644
--- a/n.js
+++ b/n.js
@@ -1,7 +1,7 @@
 keep
-AAA
+aaa
 keep
-BBB
+bbb
 keep
`;

test('parseDiff reads hunks and paths', () => {
  const files = parseDiff(SAMPLE);
  assert.equal(files.length, 1);
  assert.equal(files[0].oldPath, 'n.js');
  assert.equal(files[0].newPath, 'n.js');
  assert.equal(files[0].hunks.length, 1);
  assert.equal(files[0].hunks[0].lines.length, 7);
});

test('splitHunk makes two blocks around context', () => {
  const hunk = parseDiff(SAMPLE)[0].hunks[0];
  const split = splitHunk(hunk);
  assert.equal(split.blocks.length, 2);
  const ids = split.hunk.lines.map((line) => line.blockId);
  assert.deepEqual(ids, [null, 0, 0, null, 1, 1, null]);
});

test('formatPatch keeps only the focused block as a change', () => {
  const file = parseDiff(SAMPLE)[0];
  const split = splitHunk(file.hunks[0]);
  const patch = formatPatch(file, split.hunk, 0, 'old');
  assert.match(patch, /^-AAA/m);
  assert.match(patch, /^\+aaa/m);
  assert.match(patch, /^ BBB/m);
  assert.doesNotMatch(patch, /^-BBB/m);
  assert.doesNotMatch(patch, /^\+bbb/m);
});

test('flattenBlock new-side context keeps added other blocks', () => {
  const file = parseDiff(SAMPLE)[0];
  const split = splitHunk(file.hunks[0]);
  const lines = flattenBlock(split.hunk, 0, 'new');
  const types = lines.map((line) => `${line.type}:${line.text}`);
  assert.ok(types.includes('ctx:bbb'));
  assert.ok(!types.includes('del:BBB'));
});

test('formatPatch mixed sides uses staged new context', () => {
  const file = parseDiff(SAMPLE)[0];
  const split = splitHunk(file.hunks[0]);
  const sides = Object.assign(Object.create(null), { 0: 'new', 1: 'old' });
  const patch = formatPatch(file, split.hunk, 1, sides);
  assert.match(patch, /^-BBB/m);
  assert.match(patch, /^\+bbb/m);
  assert.match(patch, /^ aaa/m);
  assert.doesNotMatch(patch, /^-AAA/m);
});

test('itemsFromFiles staged index patch uses new-side context', () => {
  const files = parseDiff(SAMPLE);
  const staged = itemsFromFiles(files, 'staged');
  const unstaged = itemsFromFiles(files, 'unstaged');
  assert.match(staged[0].patchAdd, /^ bbb/m);
  assert.doesNotMatch(staged[0].patchAdd, /^-BBB/m);
  assert.match(unstaged[0].patchAdd, /^ BBB/m);
  assert.doesNotMatch(unstaged[0].patchAdd, /^\+bbb/m);
});
