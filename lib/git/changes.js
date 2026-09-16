'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { itemPath } = require('../files.js');
const { requireOk, runGit } = require('./run.js');

const applyPatch = (cwd, patch, flags) => {
  const args = ['apply', ...flags, '--whitespace=nowarn', '-'];
  const result = runGit(args, cwd, patch);
  requireOk(result, 'apply failed');
};

const addItem = (top, item) => {
  if (item.origin === 'staged' || item.origin === 'commit') return;
  if (item.origin === 'untracked' || item.file.isBinary) {
    requireOk(runGit(['add', '--', item.file.newPath], top));
    return;
  }
  applyPatch(top, item.patchAdd, ['--cached']);
};

const unstageItem = (top, item) => {
  if (item.origin !== 'staged') return;
  const rel = itemPath(item);
  if (item.file.isBinary) {
    requireOk(runGit(['restore', '--staged', '--', rel], top));
    return;
  }
  applyPatch(top, item.patchAdd, ['--reverse', '--cached']);
};

const revertOnePath = (top, rel, items) => {
  const origins = new Set();
  let isNew = false;
  for (const item of items) {
    origins.add(item.origin);
    if (item.file && item.file.isNew) isNew = true;
  }
  if (isNew) {
    if (origins.has('staged')) {
      requireOk(runGit(['rm', '-f', '--', rel], top));
      return;
    }
    fs.unlinkSync(path.join(top, rel));
    return;
  }
  if (origins.has('untracked') && origins.size === 1) {
    fs.unlinkSync(path.join(top, rel));
    return;
  }
  const args = ['restore', '-s', 'HEAD', '--worktree', '--staged', '--', rel];
  requireOk(runGit(args, top));
};

const revertItem = (top, item) => {
  if (item.origin === 'commit') return;
  const rel = itemPath(item);
  if (item.origin === 'untracked') {
    fs.unlinkSync(path.join(top, rel));
    return;
  }
  if (item.file.isBinary) {
    const args = ['restore', '-s', 'HEAD', '--worktree'];
    if (item.origin === 'staged') args.push('--staged');
    args.push('--', rel);
    requireOk(runGit(args, top));
    return;
  }
  if (item.origin === 'unstaged') {
    applyPatch(top, item.patchRevert, ['--reverse']);
    return;
  }
  applyPatch(top, item.patchRevert, ['--reverse', '--cached']);
  try {
    applyPatch(top, item.patchRevert, ['--reverse']);
  } catch (error) {
    if (!error.message.includes('does not apply')) throw error;
  }
};

const revertFile = (top, rel, items) => {
  const group = [];
  for (const item of items) {
    if (itemPath(item) === rel) group.push(item);
  }
  const targets = group.length ? group : items;
  revertOnePath(top, rel, targets);
};

module.exports = {
  addItem,
  unstageItem,
  revertOnePath,
  revertItem,
  revertFile,
};
