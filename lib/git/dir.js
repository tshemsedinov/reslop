'use strict';

const fs = require('node:fs');
const path = require('node:path');

const GITDIR_PREFIX = 'gitdir:';

const statOf = (file) => {
  try {
    return fs.statSync(file);
  } catch {
    return null;
  }
};

const readFirstLine = (file) => {
  try {
    return fs.readFileSync(file, 'utf8').split('\n')[0] ?? '';
  } catch {
    return '';
  }
};

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

module.exports = { resolveGitDirs };
