'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { posixRel } = require('../common/files.js');
const linked = require('../git/linked.js');
const { listWorktrees, dirKey } = linked;
const { resolveGitDirs } = require('../git/dir.js');
const { workspaceAt } = require('./workspace.js');

const HEAD_LENGTH = 7;
const UNSAFE_NAME = /[\\/:*?"<>|\s]+/g;

const isDir = (dir) => {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
};

// Inside the folder a worktree is named by its directory, outside by its path
const nameOf = (root, dir, taken) => {
  const rel = posixRel(path.relative(root, dir));
  const inside = rel && !rel.startsWith('..') && !path.isAbsolute(rel);
  const plain = inside ? rel : path.basename(dir);
  return taken.has(plain) ? dir : plain;
};

const plainRow = (repo) => ({
  name: repo.name,
  dir: repo.dir,
  group: repo.name,
  main: true,
  linked: false,
  branch: '',
  head: '',
  detached: false,
  locked: false,
});

const entryRow = (root, entry, taken) => {
  const name = nameOf(root, entry.path, taken);
  return {
    name,
    dir: entry.path,
    group: name,
    main: entry.main,
    linked: !entry.main,
    branch: entry.branch,
    head: entry.head.slice(0, HEAD_LENGTH),
    detached: entry.detached,
    locked: entry.locked,
  };
};

const usable = (entry) => !entry.bare && !entry.prunable && isDir(entry.path);

// The main one first, the linked ones by their directory name
const inOrder = (entries) => {
  const main = entries.filter((entry) => entry.main);
  const rest = entries.filter((entry) => !entry.main);
  const dirName = (entry) => path.basename(entry.path);
  rest.sort((a, b) => dirName(a).localeCompare(dirName(b), 'en'));
  return [...main, ...rest];
};

// The repositories of the folder with all their worktrees, one group each:
// the main worktree first and the linked ones after it
const expandWorkspace = async (info) => {
  const seen = new Set();
  const taken = new Set();
  const repos = [];
  const lists = await Promise.all(info.repos.map((r) => listWorktrees(r.dir)));
  // Git reports real paths; a directory that was found keeps the path it
  // was found by, which may go through a link
  const found = new Map(info.repos.map((r) => [dirKey(r.dir), r.dir]));
  for (const [index, repo] of info.repos.entries()) {
    if (seen.has(dirKey(repo.dir))) continue;
    const rows = inOrder(lists[index].filter(usable));
    if (!rows.length) {
      seen.add(dirKey(repo.dir));
      taken.add(repo.name);
      repos.push(plainRow(repo));
      continue;
    }
    let group = '';
    for (const entry of rows) {
      seen.add(dirKey(entry.path));
      const where = found.get(dirKey(entry.path)) ?? entry.path;
      const row = entryRow(info.root, { ...entry, path: where }, taken);
      group ||= row.name;
      taken.add(row.name);
      repos.push({ ...row, group });
    }
  }
  return { ...info, repos };
};

// A folder of repositories, or the worktrees of one repository
// The worktrees of a repository are asked of any of them that is left
const readWorkspace = async (info, rows = []) => {
  if (info.derived) {
    const row = rows.find((it) => isDir(it.dir));
    const seed = row ? [{ name: row.name, dir: row.dir }] : info.repos;
    return expandWorkspace({ ...info, repos: seed });
  }
  const found = workspaceAt(info.root);
  if (!found) return { ...info, repos: [] };
  return expandWorkspace(found);
};

const worktreesOf = (top) => ({
  root: top,
  repos: [{ name: path.basename(top), dir: top }],
  derived: true,
});

// What the watcher of the folder needs of a worktree besides the folder:
// its git directory and, outside of the folder, its files
const watchedBy = (root, row) => {
  const key = dirKey(row.dir);
  const rel = path.relative(root, key);
  const inside = rel && !rel.startsWith('..') && !path.isAbsolute(rel);
  const paths = inside ? [] : [key];
  const dirs = resolveGitDirs(key);
  if (dirs) paths.push(dirKey(dirs.gitDir));
  return paths;
};

// A new worktree is a sibling of the main one: `app` and `app-feature`
const worktreeTarget = (main, branch) => {
  const slug = `${branch}`.trim().replace(UNSAFE_NAME, '-');
  const base = path.basename(main.dir);
  return path.join(path.dirname(main.dir), `${base}-${slug}`);
};

module.exports = {
  expandWorkspace,
  readWorkspace,
  worktreesOf,
  watchedBy,
  worktreeTarget,
};
