'use strict';

const { itemPath } = require('../files.js');

const { depFileMeta } = require('./manifest.js');
const { orderedChanges } = require('./changes.js');
const { buildRows, makeHunk } = require('./rows.js');

const uniquePaths = (items) => {
  const files = [];
  const seen = new Set();
  for (const item of items) {
    const rel = itemPath(item);
    if (!rel || seen.has(rel)) continue;
    seen.add(rel);
    files.push(rel);
  }
  return files;
};

const filesForChange = (change, files) => {
  const manifest = [];
  const lockfile = [];
  for (const rel of files) {
    const meta = depFileMeta(rel);
    if (!meta) continue;
    if (meta.kind === 'manifest') manifest.push(rel);
    else lockfile.push(rel);
  }
  if (change.section === 'field') {
    if (manifest.length) return manifest;
    return files;
  }
  if (change.section === 'resolved') {
    if (lockfile.length) return lockfile;
    return files;
  }
  if (change.propose) {
    if (manifest.length) return manifest;
    return files;
  }
  const both = [...manifest, ...lockfile];
  if (both.length) return both;
  return files;
};

const pickPrimary = (items) => {
  for (const item of items) {
    const rel = itemPath(item);
    const meta = depFileMeta(rel);
    if (meta && meta.kind === 'manifest') return item;
  }
  return items[0];
};

const makeDepItem = (origin, fileItems, hidden, change, extra, blockId) => {
  const allFiles = uniquePaths(fileItems);
  const files = change ? filesForChange(change, allFiles) : allFiles;
  const primary = pickPrimary(fileItems);
  const oldPath = itemPath(primary);
  const newPath = oldPath;
  const isNew = fileItems.some((item) => item.file && item.file.isNew);
  const isDeleted = fileItems.every((item) => item.file && item.file.isDeleted);
  let oldCount = 0;
  let newCount = 0;
  if (!change) {
    oldCount = extra.oldCount ?? 0;
    newCount = extra.newCount ?? 0;
  }
  const rows = buildRows(change, oldCount, newCount);
  const hunk = makeHunk(rows, blockId);
  const isBinary = false;
  const preamble = [];
  const hunks = [hunk];
  const file = {
    oldPath,
    newPath,
    isNew,
    isDeleted,
    isBinary,
    preamble,
    hunks,
  };
  const patchAdd = '';
  const patchRevert = '';
  const items = hidden;
  const dep = { files, items, change };
  const reload = !!(change && change.propose);
  return { origin, file, hunk, blockId, patchAdd, patchRevert, dep, reload };
};

const makeDepItems = (origin, fileItems, hidden, summary) => {
  const ordered = orderedChanges(summary.changes);
  if (!ordered.length) {
    return [makeDepItem(origin, fileItems, hidden, null, summary, 0)];
  }
  const items = [];
  let blockId = 0;
  for (const change of ordered) {
    const made = makeDepItem(
      origin,
      fileItems,
      hidden,
      change,
      summary,
      blockId,
    );
    items.push(made);
    blockId += 1;
  }
  return items;
};

const stubFileItem = (rel, origin) => {
  const file = {
    oldPath: rel,
    newPath: rel,
    isNew: false,
    isDeleted: false,
    isBinary: false,
    preamble: [],
    hunks: [],
  };
  const hunk = null;
  const blockId = 0;
  const patchAdd = '';
  const patchRevert = '';
  return { origin, file, hunk, blockId, patchAdd, patchRevert };
};

module.exports = { makeDepItems, stubFileItem };
