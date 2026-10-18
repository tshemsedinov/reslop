'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { REVIEW_DIR } = require('../common/files.js');
const review = require('../review/review.js');
const { listReviewNames, latestReviewName, loadReview, noteCounts } = review;
const { diffCounts } = require('../git/worktree.js');
const local = require('../git/local.js');
const { branchOf, commitCount, worktreeRoot, statOf } = local;
const { gitText, countOf } = require('./git.js');
const { runName } = require('./model.js');
const { readRuns } = require('../runs/runs.js');
const { cmpEn } = require('../common/utilities.js');

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

const listChildRepos = (dir) => {
  let entries = null;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    // unreadable directory
  }
  if (!entries) return [];
  const repos = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (!isRepoDir(full)) continue;
    repos.push({ name: entry.name, dir: full });
  }
  repos.sort((left, right) => cmpEn(left.name, right.name));
  return repos;
};

// A repo row is busy until each of its parts has loaded
const rowBusy = (row) => {
  if (!row.filesReady || !row.commitsReady) return true;
  if (!row.diffReady || !row.tasksReady) return true;
  return !row.runsReady || !row.npmReady;
};

const workspaceAt = (dir) => {
  const stat = statOf(dir);
  if (!stat) return null;
  if (!stat.isDirectory() || isRepoDir(dir)) return null;
  const repos = listChildRepos(dir);
  if (!repos.length) return null;
  return { root: path.resolve(dir), repos };
};

const workspaceFromArgs = (cwd, paths) => {
  if (paths.length > 1) return null;
  const dir = paths.length ? path.resolve(cwd, paths[0]) : cwd;
  if (paths.length && !statOf(dir)?.isDirectory()) return null;
  return workspaceAt(dir);
};

const sumNumstat = (text) => {
  let added = 0;
  let removed = 0;
  for (const line of `${text ?? ''}`.split('\n')) {
    if (!line) continue;
    const parts = line.split('\t');
    const add = Number(parts[0]);
    const del = Number(parts[1]);
    if (Number.isFinite(add)) added += add;
    if (Number.isFinite(del)) removed += del;
  }
  return { added, removed };
};

const readDiffStat = async (dir) => {
  try {
    return await diffCounts(dir);
  } catch {
    return emptyDiff();
  }
};

const countCommits = async (dir) => {
  const counted = commitCount(dir);
  if (counted !== '') return countOf(counted);
  return countOf(await gitText(dir, ['rev-list', '--count', 'HEAD']));
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
  workspaceAt,
  workspaceFromArgs,
  sumNumstat,
  readDiffStat,
  countCommits,
  currentBranchName,
  taskStats,
  pickRun,
  rowBusy,
};
