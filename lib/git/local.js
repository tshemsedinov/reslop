'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const { resolveGitDirs } = require('./dir.js');

const HEAD_REF = 'ref: refs/heads/';
const SHA = /^[0-9a-f]{40}$/i;

const readText = (file) => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
};

const readFirstLine = (file) => readText(file).split('\n')[0] ?? '';

// The worktree that contains `start`, without asking git. A linked checkout
// is the directory whose `.git` file points at the common repository.
const worktreeRoot = (start) => {
  let dir = path.resolve(start);
  let stat;
  try {
    stat = fs.statSync(dir);
  } catch {
    return '';
  }
  if (!stat.isDirectory()) dir = path.dirname(dir);
  for (;;) {
    const dot = path.join(dir, '.git');
    try {
      fs.accessSync(dot);
      return dir;
    } catch {
      // keep walking
    }
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
};
