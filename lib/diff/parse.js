'use strict';

const LINE_TYPE = {
  '+': 'add',
  '-': 'del',
  ' ': 'ctx',
};

const parseGitPaths = (line) => {
  const rest = line.slice('diff --git '.length);
  const mid = rest.lastIndexOf(' b/');
  if (mid < 0 || !rest.startsWith('a/')) return { oldPath: '', newPath: '' };
  const oldPath = rest.slice(2, mid);
  const newPath = rest.slice(mid + 3);
  return { oldPath, newPath };
};

const stripAb = (raw) => {
  if (raw === '/dev/null') return raw;
  if (raw.startsWith('a/') || raw.startsWith('b/')) return raw.slice(2);
  return raw;
};

const parsePathLine = (line) => {
  const space = line.indexOf(' ');
  if (space < 0) return '';
  let rest = line.slice(space + 1);
  if (rest.startsWith('"') && rest.endsWith('"')) {
    rest = rest.slice(1, -1);
  }
  const tab = rest.indexOf('\t');
  if (tab >= 0) rest = rest.slice(0, tab);
  return stripAb(rest);
};

const parseHunkHeader = (line) => {
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(line);
  if (!match) return null;
  const oldStart = parseInt(match[1], 10);
  const oldCount = match[2] === undefined ? 1 : parseInt(match[2], 10);
  const newStart = parseInt(match[3], 10);
  const newCount = match[4] === undefined ? 1 : parseInt(match[4], 10);
  return { oldStart, oldCount, newStart, newCount, header: line };
};

const closeFile = (file, files) => {
  if (file) files.push(file);
};

const createFile = (line) => {
  const paths = parseGitPaths(line);
  return {
    oldPath: paths.oldPath,
    newPath: paths.newPath,
    isNew: false,
    isDeleted: false,
    isBinary: false,
    preamble: [line],
    hunks: [],
  };
};

const startGitFile = (line, ctx) => {
  ctx.hunk = null;
  closeFile(ctx.file, ctx.files);
  ctx.file = createFile(line);
};

const markBinary = (line, ctx) => {
  ctx.file.isBinary = true;
  ctx.file.preamble.push(line);
  ctx.hunk = null;
};

const markNewFile = (line, ctx) => {
  ctx.file.isNew = true;
  ctx.file.preamble.push(line);
};

const markDeleted = (line, ctx) => {
  ctx.file.isDeleted = true;
  ctx.file.preamble.push(line);
};

const setOldPath = (line, ctx) => {
  const parsed = parsePathLine(line);
  if (parsed === '/dev/null') ctx.file.isNew = true;
  else ctx.file.oldPath = parsed;
  ctx.file.preamble.push(line);
};

const setNewPath = (line, ctx) => {
  const parsed = parsePathLine(line);
  if (parsed === '/dev/null') ctx.file.isDeleted = true;
  else ctx.file.newPath = parsed;
  ctx.file.preamble.push(line);
};

const startHunk = (line, ctx) => {
  const meta = parseHunkHeader(line);
  if (!meta) return;
  ctx.hunk = { ...meta, lines: [] };
  ctx.file.hunks.push(ctx.hunk);
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
  if (type) {
    hunk.lines.push({ type, text: line.slice(1), noNl: false });
    return;
  }
  hunk.lines.push({ type: 'ctx', text: line, noNl: false });
};

const parseDiff = (text) => {
  const files = [];
  if (!text) return files;
  const rawLines = text.split('\n');
  if (rawLines.at(-1) === '') rawLines.pop();
  const ctx = { files, file: null, hunk: null };
  for (const raw of rawLines) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    const rule = DIFF_PREFIX.find((entry) => line.startsWith(entry.prefix));
    if (rule) {
      if (rule.needFile && !ctx.file) continue;
      rule.apply(line, ctx);
      continue;
    }
    if (!ctx.file) continue;
    if (!ctx.hunk) {
      ctx.file.preamble.push(line);
      continue;
    }
    takeHunkLine(line, ctx.hunk);
  }
  closeFile(ctx.file, files);
  return files;
};

module.exports = { parseDiff };
