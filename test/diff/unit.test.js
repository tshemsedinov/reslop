'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const diff = require('../../lib/diff/diff.js');
const { unitLines, blockLineIndex, blockLineRange, fileOffset } = diff;
const { itemsForPath, mergeEditRows } = diff;

const item = (blockId, lines, newStart = 1) => ({
  origin: 'unstaged',
  file: { newPath: 'a.js', oldPath: 'a.js' },
  blockId,
  hunk: {
    oldStart: 1,
    oldCount: lines.filter((line) => line.type !== 'add').length,
    newStart,
    newCount: lines.filter((line) => line.type !== 'del').length,
    header: '',
    lines,
  },
});

test('unitLines overlays del and add onto the file', () => {
  const hunk = item(0, [
    { type: 'ctx', text: 'keep', noNl: false, blockId: null },
    { type: 'del', text: 'old', noNl: false, blockId: 0 },
    { type: 'add', text: 'new', noNl: false, blockId: 0 },
    { type: 'ctx', text: 'tail', noNl: false, blockId: null },
  ]);
  const lines = unitLines('keep\nnew\ntail\n', [hunk]);
  const types = lines.map((line) => `${line.type}:${line.text}`);
  assert.deepEqual(types, ['ctx:keep', 'del:old', 'add:new', 'ctx:tail']);
  assert.equal(blockLineIndex(lines, hunk), 1);
  assert.deepEqual(blockLineRange(lines, hunk), { start: 1, end: 2 });
  assert.equal(fileOffset(lines, 2), 5);
});

test('unitLines paints a shared hunk once per block', () => {
  const lines = [
    { type: 'del', text: 'a', noNl: false, blockId: 0 },
    { type: 'add', text: 'A', noNl: false, blockId: 0 },
    { type: 'ctx', text: 'mid', noNl: false, blockId: null },
    { type: 'del', text: 'c', noNl: false, blockId: 1 },
    { type: 'add', text: 'C', noNl: false, blockId: 1 },
  ];
  const hunk = {
    oldStart: 1,
    oldCount: 3,
    newStart: 1,
    newCount: 3,
    header: '@@ -1,3 +1,3 @@',
    lines,
  };
  const file = { newPath: 'a.js', oldPath: 'a.js' };
  const first = { origin: 'unstaged', file, hunk, blockId: 0 };
  const second = { origin: 'unstaged', file, hunk, blockId: 1 };
  const painted = unitLines('A\nmid\nC\n', [first, second, first]);
  const types = painted.map((line) => `${line.type}:${line.text}`);
  assert.deepEqual(types, ['del:a', 'add:A', 'ctx:mid', 'del:c', 'add:C']);
  assert.equal(painted[0].item, first);
  assert.equal(painted[1].item, first);
  assert.equal(painted[3].item, second);
  assert.equal(painted[4].item, second);
});

test('unitLines reads an empty file hunk once', () => {
  const lines = [
    { type: 'add', text: 'A', noNl: false, blockId: 0 },
    { type: 'add', text: 'C', noNl: false, blockId: 0 },
  ];
  const hunk = {
    oldStart: 0,
    oldCount: 0,
    newStart: 1,
    newCount: 2,
    header: '',
    lines,
  };
  const file = { newPath: 'a.js', oldPath: 'a.js' };
  const first = { origin: 'unstaged', file, hunk, blockId: 0 };
  const painted = unitLines('', [first, { ...first }]);
  const types = painted.map((line) => `${line.type}:${line.text}`);
  assert.deepEqual(types, ['add:A', 'add:C']);
});

test('itemsForPath keeps one file', () => {
  const a = item(0, [{ type: 'add', text: 'a', noNl: false, blockId: 0 }]);
  const b = {
    ...item(0, [{ type: 'add', text: 'b', noNl: false, blockId: 0 }]),
    file: { newPath: 'b.js', oldPath: 'b.js' },
  };
  assert.deepEqual(itemsForPath([a, b], 'a.js'), [a]);
});

test('unitLines without hunks is the file', () => {
  const lines = unitLines('one\ntwo\n', []);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].type, 'ctx');
  assert.equal(lines[1].text, 'two');
});

test('unitLines uses hunk adds when the file is empty', () => {
  const hunk = item(0, [{ type: 'add', text: 'new', noNl: false, blockId: 0 }]);
  const lines = unitLines('', [hunk]);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].type, 'add');
  assert.equal(lines[0].text, 'new');
});

test('mergeEditRows keeps dels and turns inserts into ctx', () => {
  const hunk = item(0, [
    { type: 'del', text: 'old', noNl: false, blockId: 0 },
    { type: 'add', text: 'new', noNl: false, blockId: 0 },
  ]);
  const base = unitLines('new\ntail\n', [hunk]);
  const inserted = mergeEditRows(base, 'new\nextra\ntail');
  const types = inserted.map((line) => `${line.type}:${line.text}`);
  assert.deepEqual(types, ['del:old', 'add:new', 'ctx:extra', 'ctx:tail']);
  assert.equal(inserted[0].editStart, undefined);
  assert.equal(inserted[1].editStart, 0);
  const edited = mergeEditRows(base, 'NEW\ntail');
  assert.equal(edited[1].type, 'add');
  assert.equal(edited[1].text, 'NEW');
  assert.equal(edited[0].type, 'del');
});

test('mergeEditRows keeps a trailing empty editor line', () => {
  const hunk = item(0, [
    { type: 'del', text: 'old', noNl: false, blockId: 0 },
    { type: 'add', text: 'new', noNl: false, blockId: 0 },
  ]);
  const base = unitLines('new\n', [hunk]);
  const merged = mergeEditRows(base, 'new\n');
  const types = merged.map((line) => `${line.type}:${line.text}`);
  assert.deepEqual(types, ['del:old', 'add:new', 'ctx:']);
  const last = merged[merged.length - 1];
  assert.equal(last.editLast, true);
  assert.equal(last.editStart, last.editEnd);
});

test('mergeEditRows keeps a block marked when a line goes above it', () => {
  const hunk = item(0, [
    { type: 'del', text: 'old', noNl: false, blockId: 0 },
    { type: 'add', text: 'new', noNl: false, blockId: 0 },
  ]);
  const base = unitLines('new\ntail\n', [hunk]);
  const merged = mergeEditRows(base, 'top\nnew\ntail');
  const types = merged.map((line) => `${line.type}:${line.text}`);
  assert.deepEqual(types, ['del:old', 'ctx:top', 'add:new', 'ctx:tail']);
});
