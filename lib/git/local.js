'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { readText } = require('../common/utilities.js');

const GITDIR_PREFIX = 'gitdir:';

const statOf = (file) => {
  try {
    return fs.statSync(file);
  } catch {
    return null;
  }
};

const readFirstLine = (file) => readText(file).split('\n')[0];

// A linked worktree keeps `.git` as a file that points into the main one
const gitDirOf = (dot) => {
  const line = readFirstLine(dot).trim();
  if (!line.startsWith(GITDIR_PREFIX)) return '';
  const raw = line.slice(GITDIR_PREFIX.length).trim();
  if (!raw) return '';
  return path.resolve(path.dirname(dot), raw);
};

const commonGitDir = (gitDir) => {
  const raw = readFirstLine(path.join(gitDir, 'commondir')).trim();
  if (!raw) return gitDir;
  return path.resolve(gitDir, raw);
};

// The directory with HEAD and the index, and the one with refs and objects
const resolveGitDirs = (root) => {
  const dot = path.join(path.resolve(root), '.git');
  const stat = statOf(dot);
  if (!stat) return null;
  if (stat.isDirectory()) return { gitDir: dot, commonDir: dot, linked: false };
  const gitDir = stat.isFile() ? gitDirOf(dot) : '';
  if (!gitDir) return null;
  return { gitDir, commonDir: commonGitDir(gitDir), linked: true };
};

const HEAD_REF = 'ref: refs/heads/';

const SHA = /^[0-9a-f]{40}$/i;

const isWorktreeRoot = (dir) => {
  const dirs = resolveGitDirs(dir);
  if (!dirs) return false;
  try {
    const head = path.join(dirs.gitDir, 'HEAD');
    const objects = path.join(dirs.commonDir, 'objects');
    const refs = path.join(dirs.commonDir, 'refs');
    return (
      fs.statSync(head).isFile() &&
      fs.statSync(objects).isDirectory() &&
      fs.statSync(refs).isDirectory()
    );
  } catch {
    return false;
  }
};

// The worktree that contains `start`, without asking git. A linked checkout
// is the directory whose `.git` file points at the common repository.
const worktreeRoot = (start) => {
  let dir = path.resolve(start);
  const stat = statOf(dir);
  if (!stat) return '';
  if (!stat.isDirectory()) dir = path.dirname(dir);
  for (;;) {
    if (isWorktreeRoot(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return '';
    dir = parent;
  }
};

const headLine = (top) => {
  const dirs = resolveGitDirs(top);
  if (!dirs) return '';
  return readFirstLine(path.join(dirs.gitDir, 'HEAD')).trim();
};

// Empty when HEAD is detached or the checkout has no branch yet
const branchOf = (top) => {
  const line = headLine(top);
  if (!line.startsWith(HEAD_REF)) return '';
  return line.slice(HEAD_REF.length);
};

const packedSha = (commonDir, ref) => {
  const text = readText(path.join(commonDir, 'packed-refs'));
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#') || line.startsWith('^')) continue;
    const space = line.indexOf(' ');
    if (space < 0) continue;
    if (line.slice(space + 1).trim() === ref) return line.slice(0, space);
  }
  return '';
};

const refSha = (commonDir, ref) => {
  const direct = readFirstLine(path.join(commonDir, ref)).trim();
  if (SHA.test(direct)) return direct;
  return packedSha(commonDir, ref);
};

const headSha = (dirs) => {
  const line = readFirstLine(path.join(dirs.gitDir, 'HEAD')).trim();
  if (SHA.test(line)) return line;
  if (!line.startsWith('ref: ')) return '';
  return refSha(dirs.commonDir, line.slice('ref: '.length).trim());
};

const looseCommit = (commonDir, sha) => {
  if (!SHA.test(sha)) return null;
  const file = path.join(commonDir, 'objects', sha.slice(0, 2), sha.slice(2));
  let raw;
  try {
    raw = zlib.inflateSync(fs.readFileSync(file));
  } catch {
    return null;
  }
  const text = raw.toString('utf8');
  const nul = text.indexOf('\0');
  if (nul < 0 || !text.slice(0, nul).startsWith('commit ')) return null;
  return text.slice(nul + 1);
};

const parentsOf = (body) => {
  const parents = [];
  for (const line of body.split('\n')) {
    if (line.startsWith('parent ')) parents.push(line.slice('parent '.length));
    else if (line === '') break;
  }
  return parents;
};

// Null when an object lives in a pack: the caller asks git then
const countLoose = (commonDir, sha) => {
  const seen = new Set();
  const queue = [sha];
  while (queue.length) {
    const id = queue.pop();
    if (!id || seen.has(id)) continue;
    const body = looseCommit(commonDir, id);
    if (body === null) return null;
    seen.add(id);
    for (const parent of parentsOf(body)) queue.push(parent);
  }
  return seen.size;
};

// '' when the history is not a set of loose objects
const commitCount = (top) => {
  const dirs = resolveGitDirs(top);
  if (!dirs) return '';
  const sha = headSha(dirs);
  if (!sha) return '0';
  const count = countLoose(dirs.commonDir, sha);
  if (count === null) return '';
  return `${count}`;
};

const originUrl = (text) => {
  let section = '';
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      section = trimmed.slice(1, -1).trim();
      continue;
    }
    if (section !== 'remote "origin"') continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    if (trimmed.slice(0, eq).trim() !== 'url') continue;
    return trimmed.slice(eq + 1).trim();
  }
  return '';
};

const remoteOrigin = (top) => {
  const dirs = resolveGitDirs(top);
  if (!dirs) return '';
  return originUrl(readText(path.join(dirs.commonDir, 'config')));
};

const gitDirPath = (top) => {
  const dirs = resolveGitDirs(top);
  return dirs ? dirs.gitDir : '';
};

module.exports = {
  worktreeRoot,
  branchOf,
  commitCount,
  remoteOrigin,
  gitDirPath,
  statOf,
  resolveGitDirs,
};
