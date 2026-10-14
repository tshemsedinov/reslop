'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { oneLine } = require('../common/utilities.js');
const { REVIEW_DIR, LOG_DIR } = require('../common/files.js');
const { runGit, requireOk } = require('./worktree.js');

const HEADS = 'refs/heads/';

const FIELDS = {
  worktree: (entry, value) => ({ path: path.resolve(value) }),
  HEAD: (entry, value) => ({ head: value }),
  branch: (entry, value) => ({ branch: value.replace(HEADS, '') }),
  detached: () => ({ detached: true }),
  bare: () => ({ bare: true }),
  prunable: () => ({ prunable: true }),
  locked: (entry, value) => ({ locked: true, lockReason: value }),
};

const parseEntry = (block) => {
  let entry = {
    path: '',
    head: '',
    branch: '',
    detached: false,
    bare: false,
    locked: false,
    lockReason: '',
    prunable: false,
  };
  for (const line of block.split('\n')) {
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1).trim();
    const field = Object.hasOwn(FIELDS, key) ? FIELDS[key] : null;
    if (field) entry = { ...entry, ...field(entry, value) };
  }
  return entry;
};

// The first entry is the main worktree, the others are linked to it
const parseWorktrees = (text) =>
  `${text ?? ''}`
    .split(/\r?\n\r?\n/)
    .filter((block) => block.trim())
    .map(parseEntry)
    .filter((entry) => entry.path)
    .map((entry, index) => ({ ...entry, main: index === 0 }));

const listWorktrees = async (dir) => {
  const args = ['worktree', 'list', '--porcelain'];
  const result = await runGit(args, dir);
  if (result.status !== 0) return [];
  return parseWorktrees(result.stdout);
};

// Git reports real paths, the others can go through links
const dirKey = (dir) => {
  try {
    return fs.realpathSync.native(dir);
  } catch {
    return path.resolve(dir);
  }
};

const sameDir = (left, right) => dirKey(left) === dirKey(right);

const findWorktree = (list, dir) => list.find((it) => sameDir(it.path, dir));

const isOwnFile = (rel) => {
  const head = rel.split(/[/\\]/)[0];
  return head === REVIEW_DIR || head === LOG_DIR;
};

// The plan and the logs of reslop are not the work of the user
const changedFiles = async (dir) => {
  const args = ['status', '--porcelain', '-z', '--untracked-files=all'];
  const result = await runGit([...args, '--no-renames'], dir);
  requireOk(result, 'git status failed');
  const names = result.stdout.split('\0').filter(Boolean);
  return names.map((line) => line.slice(3)).filter((rel) => !isOwnFile(rel));
};

const isDirty = async (dir) => (await changedFiles(dir)).length > 0;

const branchExists = async (top, branch) => {
  const args = ['show-ref', '--verify', '--quiet', `${HEADS}${branch}`];
  return (await runGit(args, top)).status === 0;
};

const branchError = (branch) => {
  const name = `${branch ?? ''}`.trim();
  if (!name) return 'empty branch name';
  if (name.startsWith('-')) return `bad branch name ${name}`;
  return '';
};

// Git tells what happened after a line of progress: the last complaint
const requireDone = (result, fallback) => {
  if (result.status === 0) return result;
  const text = `${result.stderr}\n${result.stdout}`;
  const lines = text.split(/\r?\n/).map((line) => line.trim());
  const filled = lines.filter(Boolean);
  const named = filled.filter((line) => /^(fatal|error):/.test(line));
  const line = named.at(-1) ?? filled.at(-1) ?? fallback;
  throw new Error(oneLine(line.replace(/^(fatal|error):\s*/, ''), fallback));
};

// Git itself refuses a branch that is checked out in another worktree
const addWorktree = async (top, target, branch) => {
  const failed = branchError(branch);
  if (failed) throw new Error(failed);
  const name = branch.trim();
  const dir = path.resolve(top, target);
  const exists = await branchExists(top, name);
  const args = exists
    ? ['worktree', 'add', '--', dir, name]
    : ['worktree', 'add', '-b', name, '--', dir];
  requireDone(await runGit(args, top), 'git worktree add failed');
  return dir;
};

// Never forced: uncommitted work or a lock keeps the worktree
const removeWorktree = async (top, target) => {
  const list = await listWorktrees(top);
  const found = findWorktree(list, target);
  if (!found) throw new Error('not a worktree of this repository');
  if (found.main) throw new Error('the main worktree cannot be removed');
  if (found.locked) {
    const why = found.lockReason ? `: ${found.lockReason}` : '';
    throw new Error(oneLine(`worktree is locked${why}`, 'worktree is locked'));
  }
  if (await isDirty(found.path)) {
    throw new Error('worktree has uncommitted changes');
  }
  const args = ['worktree', 'remove', '--', found.path];
  requireDone(await runGit(args, top), 'git worktree remove failed');
};

module.exports = {
  parseWorktrees,
  listWorktrees,
  findWorktree,
  dirKey,
  sameDir,
  changedFiles,
  isDirty,
  addWorktree,
  removeWorktree,
};
