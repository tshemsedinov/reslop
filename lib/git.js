'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const diff = require('./diff.js');
const { parseDiff, synthesizeNewFile, itemsFromFiles } = diff;
const { itemPath } = require('./files.js');
const { REVIEW_DIR } = require('./review.js');

const GIT_CONFIG = ['-c', 'core.quotepath=false'];
const DIFF_OPTS = ['--no-color', '--no-ext-diff', '--no-renames', '-U3'];
const GIT_ENCODING = 'utf8';
const GIT_MAX_BUFFER = 32 * 1024 * 1024;
const BINARY_SIZE = 1000000;

const oneLine = (text) => text.trim().split('\n')[0] || 'git failed';

const requireOk = (result, fallback = 'git failed') => {
  if (result.status === 0) return result;
  const msg = result.stderr || result.stdout || fallback;
  throw new Error(oneLine(msg));
};

const isReviewFile = (rel) => {
  if (!rel) return false;
  const first = rel.split(/[/\\]/)[0];
  return first === REVIEW_DIR;
};

const dropReviewItems = (items) => {
  const kept = [];
  for (const item of items) {
    if (isReviewFile(itemPath(item))) continue;
    kept.push(item);
  }
  return kept;
};

const runGit = (args, cwd, input) => {
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0' };
  const options = {
    cwd,
    encoding: GIT_ENCODING,
    input,
    maxBuffer: GIT_MAX_BUFFER,
    env,
  };
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
  requireOk(result, 'apply failed');
};

const isBinaryBuffer = (buf) => {
  if (buf.length > BINARY_SIZE) return true;
  return buf.includes(0);
};

const listUntracked = (top, paths) => {
  const args = ['ls-files', '-o', '--exclude-standard', '-z'];
  if (paths.length) args.push('--', ...paths);
  const result = requireOk(runGit(args, top));
  if (!result.stdout) return [];
  return result.stdout.split('\0').filter(Boolean);
};

const binaryNewFile = (rel) => ({
  oldPath: rel,
  newPath: rel,
  isNew: true,
  isDeleted: false,
  isBinary: true,
  preamble: [`diff --git a/${rel} b/${rel}`, 'new file mode 100644'],
  hunks: [],
});

const untrackedItems = (top, paths) => {
  const files = [];
  for (const rel of listUntracked(top, paths)) {
    if (isReviewFile(rel)) continue;
    const full = path.join(top, rel);
    let buf;
    try {
      buf = fs.readFileSync(full);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    if (isBinaryBuffer(buf)) {
      files.push(binaryNewFile(rel));
      continue;
    }
    files.push(synthesizeNewFile(rel, buf.toString('utf8')));
  }
  return itemsFromFiles(files, 'untracked');
};

const mergeItems = (groups) => {
  const byPath = new Map();
  for (const group of groups) {
    for (const item of group) {
      const rel = itemPath(item);
      const list = byPath.get(rel);
      if (list) {
        list.push(item);
        continue;
      }
      byPath.set(rel, [item]);
    }
  }
  const items = [];
  for (const list of byPath.values()) {
    for (const item of list) items.push(item);
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
  const result = requireOk(runGit(args, top));
  return parseDiff(result.stdout);
};

const load = (cwd, paths = [], options = {}) => {
  const top = toplevel(cwd);
  const extra = paths.length ? ['--', ...paths] : [];
  const rev = options.commit;
  if (rev) {
    const files = loadCommit(top, rev, extra);
    const items = dropReviewItems(itemsFromFiles(files, 'commit'));
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
  const stagedRes = requireOk(runGit(stagedArgs, top));
  const unstagedRes = requireOk(runGit(unstagedArgs, top));
  const staged = itemsFromFiles(parseDiff(stagedRes.stdout), 'staged');
  const unstaged = itemsFromFiles(parseDiff(unstagedRes.stdout), 'unstaged');
  const untracked = untrackedItems(top, paths);
  const items = dropReviewItems(mergeItems([staged, unstaged, untracked]));
  return { top, items };
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
