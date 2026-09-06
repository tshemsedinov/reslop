'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const diff = require('./diff.js');
const { parseDiff, synthesizeNewFile, itemsFromFiles } = diff;

const GIT_CONFIG = ['-c', 'core.quotepath=false'];
const DIFF_OPTS = ['--no-color', '--no-ext-diff', '--no-renames', '-U3'];

const BINARY_SIZE = 1000000;

const oneLine = (text) => text.trim().split('\n')[0] || 'git failed';

const runGit = (args, cwd, input) => {
  const encoding = 'utf8';
  const maxBuffer = 32 * 1024 * 1024;
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0' };
  const options = { cwd, encoding, input, maxBuffer, env };
  const result = spawnSync('git', args, options);
  if (result.error) {
    if (result.error.code === 'ENOENT') throw new Error('git not found');
    throw result.error;
  }
  return result;
};

const toplevel = (cwd) => {
  const result = runGit(['rev-parse', '--show-toplevel'], cwd);
  if (result.status !== 0) throw new Error('not a git repository');
  return result.stdout.trim();
};

const applyPatch = (cwd, patch, flags) => {
  const args = ['apply', ...flags, '--whitespace=nowarn', '-'];
  const result = runGit(args, cwd, patch);
  if (result.status === 0) return;
  const msg = result.stderr || result.stdout || 'apply failed';
  throw new Error(oneLine(msg));
};

const isBinaryBuffer = (buf) => {
  if (buf.length > BINARY_SIZE) return true;
  return buf.includes(0);
};

const listUntracked = (top, paths) => {
  const args = ['ls-files', '-o', '--exclude-standard', '-z'];
  if (paths.length) args.push('--', ...paths);
  const result = runGit(args, top);
  if (result.status !== 0) throw new Error(oneLine(result.stderr || ''));
  if (!result.stdout) return [];
  return result.stdout.split('\0').filter(Boolean);
};

const untrackedItems = (top, paths) => {
  const files = [];
  for (const rel of listUntracked(top, paths)) {
    const full = path.join(top, rel);
    let buf;
    try {
      buf = fs.readFileSync(full);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    if (isBinaryBuffer(buf)) {
      const oldPath = rel;
      const newPath = rel;
      const isNew = true;
      const isDeleted = false;
      const isBinary = true;
      const preamble = [`diff --git a/${rel} b/${rel}`, 'new file mode 100644'];
      const hunks = [];
      files.push({
        oldPath,
        newPath,
        isNew,
        isDeleted,
        isBinary,
        preamble,
        hunks,
      });
      continue;
    }
    files.push(synthesizeNewFile(rel, buf.toString('utf8')));
  }
  return itemsFromFiles(files, 'untracked');
};

const mergeItems = (groups) => {
  const order = [];
  const map = new Map();
  for (const group of groups) {
    for (const item of group) {
      const rel = item.file.newPath || item.file.oldPath;
      if (!map.has(rel)) {
        map.set(rel, []);
        order.push(rel);
      }
      map.get(rel).push(item);
    }
  }
  const items = [];
  for (const rel of order) {
    for (const item of map.get(rel)) items.push(item);
  }
  return items;
};

const resolveRev = (cwd, spec) => {
  if (!spec) return null;
  const top = toplevel(cwd);
  const args = ['rev-parse', '--verify', `${spec}^{commit}`];
  const result = runGit(args, top);
  if (result.status !== 0) return null;
  return result.stdout.trim();
};

const shortRev = (top, commit) => {
  const result = runGit(['rev-parse', '--short', commit], top);
  if (result.status !== 0) return commit.slice(0, 7);
  return result.stdout.trim();
};

const loadCommit = (top, commit, extra) => {
  const parent = runGit(['rev-parse', '--verify', `${commit}^`], top);
  let args;
  if (parent.status === 0) {
    const from = parent.stdout.trim();
    args = [...GIT_CONFIG, 'diff', ...DIFF_OPTS, from, commit, ...extra];
  } else {
    args = [
      ...GIT_CONFIG,
      'diff-tree',
      '--no-commit-id',
      '--root',
      '-p',
      ...DIFF_OPTS,
      commit,
      ...extra,
    ];
  }
  const result = runGit(args, top);
  if (result.status !== 0) throw new Error(oneLine(result.stderr || ''));
  return parseDiff(result.stdout);
};

const load = (cwd, paths = [], options = {}) => {
  const top = toplevel(cwd);
  const extra = paths.length ? ['--', ...paths] : [];
  const rev = options.commit;
  if (rev) {
    const files = loadCommit(top, rev, extra);
    const items = itemsFromFiles(files, 'commit');
    const revShort = shortRev(top, rev);
    return { top, items, rev, revShort };
  }
  const stagedArgs = [
    ...GIT_CONFIG,
    'diff',
    '--cached',
    ...DIFF_OPTS,
    ...extra,
  ];
  const unstagedArgs = [...GIT_CONFIG, 'diff', ...DIFF_OPTS, ...extra];
  const stagedRes = runGit(stagedArgs, top);
  const unstagedRes = runGit(unstagedArgs, top);
  if (stagedRes.status !== 0) throw new Error(oneLine(stagedRes.stderr || ''));
  if (unstagedRes.status !== 0) {
    throw new Error(oneLine(unstagedRes.stderr || ''));
  }
  const staged = itemsFromFiles(parseDiff(stagedRes.stdout), 'staged');
  const unstaged = itemsFromFiles(parseDiff(unstagedRes.stdout), 'unstaged');
  const untracked = untrackedItems(top, paths);
  const items = mergeItems([staged, unstaged, untracked]);
  return { top, items };
};

const addItem = (top, item) => {
  if (item.origin === 'staged' || item.origin === 'commit') return;
  if (item.origin === 'untracked' || item.file.isBinary) {
    const result = runGit(['add', '--', item.file.newPath], top);
    if (result.status !== 0) throw new Error(oneLine(result.stderr || ''));
    return;
  }
  applyPatch(top, item.patchAdd, ['--cached']);
};

const unstageItem = (top, item) => {
  if (item.origin !== 'staged') return;
  const rel = item.file.newPath || item.file.oldPath;
  if (item.file.isBinary) {
    const result = runGit(['restore', '--staged', '--', rel], top);
    if (result.status !== 0) throw new Error(oneLine(result.stderr || ''));
    return;
  }
  applyPatch(top, item.patchRevert, ['--reverse', '--cached']);
};

const revertItem = (top, item) => {
  if (item.origin === 'commit') return;
  const rel = item.file.newPath || item.file.oldPath;
  if (item.origin === 'untracked') {
    fs.unlinkSync(path.join(top, rel));
    return;
  }
  if (item.file.isBinary) {
    const args = ['restore', '-s', 'HEAD', '--worktree'];
    if (item.origin === 'staged') args.push('--staged');
    args.push('--', rel);
    const result = runGit(args, top);
    if (result.status !== 0) throw new Error(oneLine(result.stderr || ''));
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

const createGitRepo = () => ({
  load,
  resolveRev,
  add: addItem,
  unstage: unstageItem,
  revert: revertItem,
});

module.exports = {
  runGit,
  toplevel,
  load,
  resolveRev,
  addItem,
  unstageItem,
  revertItem,
  createGitRepo,
  oneLine,
};
