'use strict';

const patch = require('./patch.js');
const { splitHunk, formatHunkHeader, formatPatch } = patch;

const INDEX_SIDE = {
  staged: 'new',
  unstaged: 'old',
  untracked: 'old',
  commit: 'old',
  pr: 'old',
};

const splitLines = (content) => {
  if (content === '') return { lines: [''], noNl: true };
  const parts = content.split('\n');
  const noNl = parts.at(-1) !== '';
  if (!noNl) parts.pop();
  return { lines: parts, noNl };
};

const synthesizeNewFile = (relPath, content) => {
  const { lines, noNl } = splitLines(content);
  const body = lines.map((text, index) => ({
    type: 'add',
    text,
    noNl: noNl && index === lines.length - 1,
    blockId: 0,
  }));
  const oldStart = 0;
  const oldCount = 0;
  const newStart = 1;
  const newCount = body.length;
  const header = formatHunkHeader(oldStart, oldCount, newStart, newCount);
  const hunk = { oldStart, oldCount, newStart, newCount, header, lines: body };
  const preamble = [
    `diff --git a/${relPath} b/${relPath}`,
    'new file mode 100644',
    '--- /dev/null',
    `+++ b/${relPath}`,
  ];
  return {
    oldPath: relPath,
    newPath: relPath,
    isNew: true,
    isDeleted: false,
    isBinary: false,
    preamble,
    hunks: [hunk],
  };
};

const itemsFromFiles = (files, origin) => {
  const items = [];
  for (const file of files) {
    if (file.isBinary) {
      const hunk = null;
      const blockId = null;
      const patchAdd = '';
      const patchRevert = '';
      items.push({ origin, file, hunk, blockId, patchAdd, patchRevert });
      continue;
    }
    for (const rawHunk of file.hunks) {
      const { hunk, blocks } = splitHunk(rawHunk);
      for (const block of blocks) {
        const blockId = block.id;
        const indexSide = INDEX_SIDE[origin] ?? 'old';
        const patchAdd = formatPatch(file, hunk, blockId, indexSide);
        const patchRevert = formatPatch(file, hunk, blockId, 'new');
        items.push({ origin, file, hunk, blockId, patchAdd, patchRevert });
      }
    }
  }
  return items;
};

const refreshIndexPatches = (items, item) => {
  if (!item.hunk || !item.file) return items;
  const sides = {};
  for (const other of items) {
    if (other.hunk !== item.hunk || other.file !== item.file) continue;
    sides[other.blockId] = INDEX_SIDE[other.origin] ?? 'old';
  }
  const next = [];
  for (const other of items) {
    if (other.hunk !== item.hunk || other.file !== item.file) {
      next.push(other);
      continue;
    }
    const patchAdd = formatPatch(other.file, other.hunk, other.blockId, sides);
    next.push({ ...other, patchAdd });
  }
  return next;
};

module.exports = {
  synthesizeNewFile,
  itemsFromFiles,
  refreshIndexPatches,
};
