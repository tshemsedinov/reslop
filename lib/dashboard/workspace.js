'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { REVIEW_DIR, MANIFEST } = require('../common/files.js');
const review = require('../review/review.js');
const { listReviewNames, latestReviewName, loadReview, noteCounts } = review;
const { diffCounts, pathArgs } = require('../git/worktree.js');
const local = require('../git/local.js');
const { branchOf, commitCount, worktreeRoot, statOf } = local;
const { gitText, countOf } = require('./git.js');
const { runName } = require('./model.js');
const { readRuns } = require('../runs/runs.js');
const { cmpEn, listEntries } = require('../common/utilities.js');

const SKIP_CHILD = new Set(['node_modules']);

const emptyDiff = () => ({
  stagedAdded: 0,
  unstagedAdded: 0,
  stagedRemoved: 0,
  unstagedRemoved: 0,
});

const isRepoDir = (dir) => {
  try {
    fs.accessSync(path.join(dir, '.git'));
    return true;
  } catch {
    return false;
  }
};

const hasManifest = (dir) => {
  const stat = statOf(path.join(dir, MANIFEST));
  return stat !== null && stat.isFile();
};

const isChildDir = (entry) => {
  if (!entry.isDirectory() || entry.name.startsWith('.')) return false;
  return !SKIP_CHILD.has(entry.name);
};

const childNames = (dir) => {
  const dirs = listEntries(dir).filter(isChildDir);
  const names = dirs.map((entry) => entry.name);
  return names.sort(cmpEn);
};

const packageRow = (dir, name) => ({ name, dir, scoped: !isRepoDir(dir) });

// A directory with package.json is one project. Inside a directory without
// one, each child with package.json is a project, so `packages/app` is found
const listPackages = (dir) => {
  const found = [];
  for (const name of childNames(dir)) {
    const full = path.join(dir, name);
    if (hasManifest(full)) {
      found.push(packageRow(full, name));
      continue;
    }
    for (const inner of childNames(full)) {
      const nested = path.join(full, inner);
      if (!hasManifest(nested)) continue;
      found.push(packageRow(nested, `${name}/${inner}`));
    }
  }
  found.sort((left, right) => cmpEn(left.name, right.name));
  return found;
};

// The repository itself is the first tile, then each package below it
const listMonorepo = (dir) => {
  const packages = listPackages(dir);
  if (packages.length < 2) return [];
  const base = path.basename(dir);
  const taken = packages.some((row) => row.name === base);
  const rootName = taken ? `${base} (root)` : base;
  return [packageRow(dir, rootName)].concat(packages);
};

const listChildRepos = (dir) => {
  const repos = [];
  for (const name of childNames(dir)) {
    const full = path.join(dir, name);
    if (isRepoDir(full)) repos.push({ name, dir: full });
  }
  return repos;
};

const rowBusy = (row) => {
  if (!row.filesReady || !row.commitsReady) return true;
  if (!row.diffReady || !row.tasksReady) return true;
  return !row.runsReady || !row.npmReady;
};

const workspaceAt = (dir) => {
  const stat = statOf(dir);
  if (!stat || !stat.isDirectory()) return null;
  const root = path.resolve(dir);
  const mono = isRepoDir(root);
  const repos = mono ? listMonorepo(root) : listChildRepos(root);
  if (!repos.length) return null;
  return { root, repos, mono };
};

const workspaceFromArgs = (cwd, paths) => {
  if (paths.length > 1) return null;
  const dir = paths.length ? path.resolve(cwd, paths[0]) : cwd;
  if (paths.length && !statOf(dir)?.isDirectory()) return null;
  return workspaceAt(dir);
};

const readDiffStat = async (dir, paths = []) => {
  try {
    return await diffCounts(dir, paths);
  } catch {
    return emptyDiff();
  }
};

const countCommits = async (dir, paths = []) => {
  const counted = paths.length ? '' : commitCount(dir);
  if (counted !== '') return countOf(counted);
  const args = ['rev-list', '--count', 'HEAD', ...pathArgs(paths)];
  return countOf(await gitText(dir, args));
};

// Empty when HEAD is detached
const currentBranchName = async (dir) => {
  const root = worktreeRoot(dir);
  if (root) return branchOf(root);
  return gitText(dir, ['symbolic-ref', '--short', '-q', 'HEAD']);
};

const taskStats = (dir) => {
  const latest = latestReviewName(listReviewNames(dir));
  if (!latest) return { done: 0, total: 0 };
  try {
    const file = path.join(dir, REVIEW_DIR, latest);
    const counts = noteCounts(loadReview(file, []));
    return { done: counts.tasksDone, total: counts.tasks };
  } catch {
    return { done: 0, total: 0 };
  }
};

const pickRun = (dir) => {
  const list = readRuns(dir);
  const live = list.find((row) => row.status === 'running');
  const record = live ?? list[0] ?? null;
  if (!record) return null;
  const progress = record.progress ?? {};
  return {
    name: runName(record),
    status: record.status,
    done: progress.done ?? 0,
    failed: progress.failed ?? 0,
    expected: progress.expected ?? 0,
    result: record.result ?? null,
  };
};

module.exports = {
  emptyDiff,
  rowBusy,
  workspaceAt,
  workspaceFromArgs,
  readDiffStat,
  countCommits,
  currentBranchName,
  taskStats,
  pickRun,
};
