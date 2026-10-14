'use strict';

const STAGED_TITLE = 'Changes to be committed:\n';
const WORK_TITLE = 'Changes not staged for commit:\n';
const UNTRACKED_TITLE = 'Untracked files:\n';
const PREFIX = {
  staged: { left: 'c/', right: 'i/' },
  work: { left: 'i/', right: 'w/' },
};

const DIFF_HEADS = [
  'diff --git ',
  'index ',
  '@@ ',
  'new file ',
  'deleted file ',
  'old mode ',
  'new mode ',
  'similarity ',
  'rename ',
  'Binary files ',
];

const isDiffHead = (line) => DIFF_HEADS.some((head) => line.startsWith(head));

const isDiffLine = (line) => {
  if (/^-{10,}$/.test(line)) return false;
  if (line.startsWith('+') || line.startsWith('-') || line.startsWith(' ')) {
    return true;
  }
  if (line.startsWith('\\')) return true;
  return isDiffHead(line);
};

const sectionDiff = (text, title) => {
  const at = text.lastIndexOf(title);
  if (at < 0) return '';
  const rest = text.slice(at + title.length);
  if (!rest.startsWith('diff --git ')) return '';
  const lines = [];
  for (const line of rest.split('\n')) {
    if (lines.length && !isDiffLine(line)) break;
    lines.push(line);
  }
  return lines.join('\n').replace(/\s+$/, '');
};

const untrackedOf = (text) => {
  const at = text.indexOf(UNTRACKED_TITLE);
  if (at < 0) return [];
  const rest = text.slice(at + UNTRACKED_TITLE.length);
  const stop = rest.indexOf('\ndiff --git ');
  const block = stop < 0 ? rest : rest.slice(0, stop);
  const names = [];
  for (const line of block.split('\n')) {
    if (line.startsWith('\t')) names.push(line.slice(1));
  }
  return names;
};

const rewritePath = (value, from, to) => {
  if (value === '/dev/null') return value;
  if (!value.startsWith(from)) return '';
  return `${to}${value.slice(from.length)}`;
};

const rewriteGit = (line, left, right) => {
  const rest = line.slice('diff --git '.length);
  const mid = ` ${right}`;
  const at = rest.indexOf(mid);
  if (!rest.startsWith(left) || at < 0) return '';
  const oldPath = rest.slice(left.length, at);
  const newPath = rest.slice(at + mid.length);
  return `diff --git a/${oldPath} b/${newPath}`;
};

const rewriteBinary = (line, left, right) => {
  const match = /^Binary files (.+) and (.+) differ$/.exec(line);
  if (!match) return line;
  const oldPath = rewritePath(match[1], left, 'a/');
  const newPath = rewritePath(match[2], right, 'b/');
  if (!oldPath || !newPath) return '';
  return `Binary files ${oldPath} and ${newPath} differ`;
};

const rewriteMarker = (line, mark, from, to) => {
  if (!line.startsWith(mark)) return line;
  const value = line.slice(mark.length);
  if (value === '/dev/null') return line;
  const next = rewritePath(value, from, to);
  if (!next) return '';
  return `${mark}${next}`;
};

const rewritten = (line, left, right) => {
  if (line.startsWith('diff --git ')) return rewriteGit(line, left, right);
  if (line.startsWith('Binary files ')) return rewriteBinary(line, left, right);
  if (line.startsWith('--- ')) return rewriteMarker(line, '--- ', left, 'a/');
  if (line.startsWith('+++ ')) return rewriteMarker(line, '+++ ', right, 'b/');
  return line;
};

// git status -vv labels the sides c/ (HEAD), i/ (index) and w/ (worktree).
// The diff parser wants the a/ and b/ labels of git diff.
const rewriteDiff = (text, side) => {
  if (!text) return '';
  const { left, right } = PREFIX[side];
  const lines = [];
  for (const line of text.split('\n')) {
    const next = rewritten(line, left, right);
    if (!next) return null;
    lines.push(next);
  }
  return `${lines.join('\n')}\n`;
};

// Null when this git prints diffs in a shape we do not rewrite
const parseStatus = (text) => {
  const raw = `${text ?? ''}`.replaceAll('\r\n', '\n');
  const staged = rewriteDiff(sectionDiff(raw, STAGED_TITLE), 'staged');
  const work = rewriteDiff(sectionDiff(raw, WORK_TITLE), 'work');
  if (staged === null || work === null) return null;
  return { staged, work, untracked: untrackedOf(raw) };
};

module.exports = { parseStatus };
