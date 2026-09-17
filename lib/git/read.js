'use strict';

const fs = require('node:fs');
const path = require('node:path');

const diff = require('../diff.js');
const { parseDiff, synthesizeNewFile, itemsFromFiles } = diff;
const { itemPath, REVIEW_DIR } = require('../files.js');
const git = require('./run.js');
const { requireOk, runGit, runGitAsync } = git;
const { pathArgsOf, cachedDiffArgs, worktreeDiffArgs, commitDiffArgs } = git;

const BINARY_SIZE = 1000000;

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

const isBinaryBuffer = (buf) => {
  if (buf.length > BINARY_SIZE) return true;
  return buf.includes(0);
};

const namesFromLs = (stdout) => {
  if (!stdout) return [];
  return stdout.split('\0').filter(Boolean);
};

const untrackedLsArgs = (paths) => {
  const args = ['ls-files', '-o', '--exclude-standard', '-z'];
  if (paths.length) args.push('--', ...paths);
  return args;
};

const listUntracked = (top, paths) => {
  const result = requireOk(runGit(untrackedLsArgs(paths), top));
  return namesFromLs(result.stdout);
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

const untrackedItemsFrom = (top, names) => {
  const files = [];
  for (const rel of names) {
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

const gitText = (top, spec) => {
  const result = runGit(['show', spec], top);
  if (result.status !== 0) return '';
  return result.stdout ?? '';
};

const worktreeText = (top, rel) => {
  try {
    return fs.readFileSync(path.join(top, rel), 'utf8');
  } catch {
    return '';
  }
};

const readDepSides = (top, rev, origin, rel) => {
  if (origin === 'untracked') {
    const newText = worktreeText(top, rel);
    return { oldText: '', newText };
  }
  if (origin === 'staged') {
    const oldText = gitText(top, `HEAD:${rel}`);
    const newText = gitText(top, `:${rel}`);
    return { oldText, newText };
  }
  if (origin === 'unstaged') {
    const indexed = gitText(top, `:${rel}`);
    const oldText = indexed || gitText(top, `HEAD:${rel}`);
    const newText = worktreeText(top, rel);
    return { oldText, newText };
  }
  if (origin === 'commit' && rev) {
    const oldText = gitText(top, `${rev}^:${rel}`);
    const newText = gitText(top, `${rev}:${rel}`);
    return { oldText, newText };
  }
  return { oldText: '', newText: '' };
};

const toplevel = (cwd) => {
  const result = runGit(['rev-parse', '--show-toplevel'], cwd);
  if (result.status !== 0) throw new Error('not a git repository');
  return result.stdout.trim();
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

const currentBranch = (top) => {
  const args = ['rev-parse', '--abbrev-ref', 'HEAD'];
  const result = runGit(args, top);
  if (result.status !== 0) return '';
  const name = result.stdout.trim();
  if (!name || name === 'HEAD') return '';
  return name;
};

const snapshotWorktree = (top, stagedOut, unstagedOut, names) => {
  const stagedDiff = parseDiff(stagedOut);
  const unstagedDiff = parseDiff(unstagedOut);
  const staged = itemsFromFiles(stagedDiff, 'staged');
  const unstaged = itemsFromFiles(unstagedDiff, 'unstaged');
  const untracked = untrackedItemsFrom(top, names);
  const combined = mergeItems([staged, unstaged, untracked]);
  const parsed = dropReviewItems(combined);
  const branch = currentBranch(top);
  return { top, parsed, branch };
};

const snapshotCommit = (top, commit, files) => {
  const commitItems = itemsFromFiles(files, 'commit');
  const parsed = dropReviewItems(commitItems);
  const revShort = shortRev(top, commit);
  const branch = currentBranch(top);
  return { top, parsed, rev: commit, revShort, branch };
};

const loadCommit = (top, commit, extra) => {
  const parent = runGit(['rev-parse', '--verify', `${commit}^`], top);
  const args = commitDiffArgs(commit, parent, extra);
  const result = requireOk(runGit(args, top));
  return parseDiff(result.stdout);
};

const loadCommitAsync = async (top, commit, extra, signal) => {
  const parent = await runGitAsync(
    ['rev-parse', '--verify', `${commit}^`],
    top,
    { signal },
  );
  const args = commitDiffArgs(commit, parent, extra);
  const result = requireOk(await runGitAsync(args, top, { signal }));
  return parseDiff(result.stdout);
};

const readSnapshot = (cwd, paths, options) => {
  const top = toplevel(cwd);
  const extra = pathArgsOf(paths);
  const rev = options.commit;
  if (rev) return snapshotCommit(top, rev, loadCommit(top, rev, extra));
  const stagedRes = requireOk(runGit(cachedDiffArgs(extra), top));
  const unstagedRes = requireOk(runGit(worktreeDiffArgs(extra), top));
  const names = listUntracked(top, paths);
  return snapshotWorktree(top, stagedRes.stdout, unstagedRes.stdout, names);
};

const readSnapshotAsync = async (cwd, paths, options) => {
  const top = toplevel(cwd);
  const extra = pathArgsOf(paths);
  const rev = options.commit;
  const signal = options.signal;
  if (rev) {
    const files = await loadCommitAsync(top, rev, extra, signal);
    return snapshotCommit(top, rev, files);
  }
  const stagedArgs = cachedDiffArgs(extra);
  const unstagedArgs = worktreeDiffArgs(extra);
  const lsArgs = untrackedLsArgs(paths);
  const stagedP = runGitAsync(stagedArgs, top, { signal });
  const unstagedP = runGitAsync(unstagedArgs, top, { signal });
  const lsP = runGitAsync(lsArgs, top, { signal });
  const extras = await Promise.all([stagedP, unstagedP, lsP]);
  const stagedRes = extras[0];
  const unstagedRes = extras[1];
  const lsRes = extras[2];
  requireOk(stagedRes);
  requireOk(unstagedRes);
  const names = namesFromLs(requireOk(lsRes).stdout);
  return snapshotWorktree(top, stagedRes.stdout, unstagedRes.stdout, names);
};

module.exports = {
  toplevel,
  resolveRev,
  currentBranch,
  gitText,
  worktreeText,
  readDepSides,
  readSnapshot,
  readSnapshotAsync,
};
