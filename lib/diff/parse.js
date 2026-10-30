'use strict';

const LINE_TYPE = { '+': 'add', '-': 'del', ' ': 'ctx' };

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

const parseGitPaths = (line) => {
  const rest = line.slice('diff --git '.length);
  const mid = rest.lastIndexOf(' b/');
  if (mid < 0 || !rest.startsWith('a/')) return { oldPath: '', newPath: '' };
  return { oldPath: rest.slice(2, mid), newPath: rest.slice(mid + 3) };
};

const parsePathLine = (line) => {
  const space = line.indexOf(' ');
  if (space < 0) return '';
  let rest = line.slice(space + 1);
  if (rest.startsWith('"') && rest.endsWith('"')) rest = rest.slice(1, -1);
  const tab = rest.indexOf('\t');
  if (tab >= 0) rest = rest.slice(0, tab);
  if (rest.startsWith('a/') || rest.startsWith('b/')) return rest.slice(2);
  return rest;
};

const parseCount = (text) => (text === undefined ? 1 : parseInt(text, 10));

const startGitFile = (line, context) => {
  if (context.file) context.files.push(context.file);
  context.hunk = null;
  context.file = {
    ...parseGitPaths(line),
    isNew: false,
    isDeleted: false,
    isBinary: false,
    preamble: [line],
    hunks: [],
  };
};

const markBinary = (line, context) => {
  context.file.isBinary = true;
  context.file.preamble.push(line);
  context.hunk = null;
};

const markNewFile = (line, context) => {
  context.file.isNew = true;
  context.file.preamble.push(line);
};

const markDeleted = (line, context) => {
  context.file.isDeleted = true;
  context.file.preamble.push(line);
};

const setOldPath = (line, context) => {
  const parsed = parsePathLine(line);
  if (parsed === '/dev/null') context.file.isNew = true;
  else context.file.oldPath = parsed;
  context.file.preamble.push(line);
};

const setNewPath = (line, context) => {
  const parsed = parsePathLine(line);
  if (parsed === '/dev/null') context.file.isDeleted = true;
  else context.file.newPath = parsed;
  context.file.preamble.push(line);
};

const startHunk = (header, context) => {
  const match = HUNK_RE.exec(header);
  if (!match) return;
  context.hunk = {
    oldStart: parseInt(match[1], 10),
    oldCount: parseCount(match[2]),
    newStart: parseInt(match[3], 10),
    newCount: parseCount(match[4]),
    header,
    lines: [],
  };
  context.file.hunks.push(context.hunk);
};

const DIFF_PREFIX = [
  { prefix: 'diff --git ', apply: startGitFile, needFile: false },
  { prefix: 'Binary files ', apply: markBinary, needFile: true },
  { prefix: 'GIT binary', apply: markBinary, needFile: true },
  { prefix: 'new file mode', apply: markNewFile, needFile: true },
  { prefix: 'deleted file mode', apply: markDeleted, needFile: true },
  { prefix: '--- ', apply: setOldPath, needFile: true },
  { prefix: '+++ ', apply: setNewPath, needFile: true },
  { prefix: '@@ ', apply: startHunk, needFile: true },
];

const takeHunkLine = (line, hunk) => {
  if (line.startsWith('\\')) {
    const prev = hunk.lines[hunk.lines.length - 1];
    if (prev) prev.noNl = true;
    return;
  }
  const type = LINE_TYPE[line[0]];
  const text = type ? line.slice(1) : line;
  hunk.lines.push({ type: type ?? 'ctx', text, noNl: false });
};

const parseDiff = (text) => {
  const files = [];
  if (!text) return files;
  const rawLines = text.split('\n');
  if (rawLines.at(-1) === '') rawLines.pop();
  const context = { files, file: null, hunk: null };
  for (const raw of rawLines) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    const rule = DIFF_PREFIX.find((entry) => line.startsWith(entry.prefix));
    if (rule) {
      if (rule.needFile && !context.file) continue;
      rule.apply(line, context);
      continue;
    }
    if (!context.file) continue;
    if (context.hunk) takeHunkLine(line, context.hunk);
    else context.file.preamble.push(line);
  }
  if (context.file) files.push(context.file);
  return files;
};

module.exports = { parseDiff };
