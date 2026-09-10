'use strict';

const { graphemes } = require('./ansi.js');

const LCS_CELL_LIMIT = 250000;
const DISPLAY_CONTEXT = 3;
const NOISY_TINY_SPANS = 6;
const PAIR_MIN_SIM = 0.3;
const PAIR_HEAD_WEIGHT = 0.4;
const PAIR_TOKEN_WEIGHT = 0.6;
const WORD_REFINE_MIN = 0.6;
const TOKEN_RE = /[A-Za-z_$][\w$]*|\d+|[^\s]/g;
const PIECE_RE = /[A-Za-z_$][\w$]*|\d+|\s+|./g;
const LINE_MARK = {
  add: '+',
  del: '-',
  ctx: ' ',
};
const LINE_TYPE = {
  '+': 'add',
  '-': 'del',
  ' ': 'ctx',
};
const INDEX_SIDE = {
  staged: 'new',
  unstaged: 'old',
  untracked: 'old',
  commit: 'old',
  pr: 'old',
};

const collapseSpans = (parts) => {
  const spans = [];
  for (const part of parts) {
    const last = spans[spans.length - 1];
    if (last && last.changed === part.changed) {
      last.text += part.text;
      continue;
    }
    spans.push({ text: part.text, changed: part.changed });
  }
  return spans;
};

const isNoisy = (spans) => {
  let tiny = 0;
  for (const span of spans) {
    if (span.changed && graphemes(span.text).length <= 2) tiny += 1;
  }
  return tiny > NOISY_TINY_SPANS;
};

const wholeChanged = (a, b) => ({
  oldSpans: a.length ? [{ text: a.join(''), changed: true }] : [],
  newSpans: b.length ? [{ text: b.join(''), changed: true }] : [],
});

const lcsLength = (a, b) => {
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0) return 0;
  if (n * m > LCS_CELL_LIMIT) {
    let lo = 0;
    while (lo < n && lo < m && a[lo] === b[lo]) lo += 1;
    let hiA = n;
    let hiB = m;
    while (hiA > lo && hiB > lo && a[hiA - 1] === b[hiB - 1]) {
      hiA -= 1;
      hiB -= 1;
    }
    return lo + (n - hiA);
  }
  let prev = new Uint32Array(m + 1);
  let cur = new Uint32Array(m + 1);
  for (let i = 1; i <= n; i++) {
    const ai = a[i - 1];
    for (let j = 1; j <= m; j++) {
      if (ai === b[j - 1]) cur[j] = prev[j - 1] + 1;
      else cur[j] = prev[j] > cur[j - 1] ? prev[j] : cur[j - 1];
    }
    const swap = prev;
    prev = cur;
    cur = swap;
    cur.fill(0);
  }
  return prev[m];
};

const similarity = (left, right) => {
  const a = graphemes(left);
  const b = graphemes(right);
  if (a.length === 0 && b.length === 0) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  const lcs = lcsLength(a, b);
  return (2 * lcs) / (a.length + b.length);
};

const lineTokens = (text) => {
  TOKEN_RE.lastIndex = 0;
  return text.match(TOKEN_RE) ?? [];
};

const tokenSimilarity = (a, b) => {
  if (a.length === 0 && b.length === 0) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  const lcs = lcsLength(a, b);
  return (2 * lcs) / (a.length + b.length);
};

const pairScore = (left, right) => {
  const a = lineTokens(left);
  const b = lineTokens(right);
  const token = tokenSimilarity(a, b);
  const headA = a[0];
  const headB = b[0];
  const head = headA && headA === headB ? 1 : 0;
  return PAIR_HEAD_WEIGHT * head + PAIR_TOKEN_WEIGHT * token;
};

const comparePair = (left, right) => {
  if (right.score !== left.score) return right.score - left.score;
  if (left.dist !== right.dist) return left.dist - right.dist;
  if (left.i !== right.i) return left.i - right.i;
  return left.j - right.j;
};

const pairCandidates = (delTexts, addTexts) => {
  const candidates = [];
  for (let i = 0; i < delTexts.length; i++) {
    for (let j = 0; j < addTexts.length; j++) {
      const score = pairScore(delTexts[i], addTexts[j]);
      if (score < PAIR_MIN_SIM) continue;
      const dist = Math.abs(i - j);
      candidates.push({ i, j, score, dist });
    }
  }
  candidates.sort(comparePair);
  return candidates;
};

const fillLcsTable = (a, b) => {
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = 1; i <= n; i++) {
    const ai = a[i - 1];
    const row = dp[i];
    const prev = dp[i - 1];
    for (let j = 1; j <= m; j++) {
      if (ai === b[j - 1]) row[j] = prev[j - 1] + 1;
      else row[j] = prev[j] > row[j - 1] ? prev[j] : row[j - 1];
    }
  }
  return dp;
};

const tracebackLcs = (a, b, dp) => {
  const rev = [];
  let i = a.length;
  let j = b.length;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      rev.push({ type: 'eq', text: a[i - 1] });
      i -= 1;
      j -= 1;
      continue;
    }
    if (dp[i - 1][j] >= dp[i][j - 1]) {
      rev.push({ type: 'del', text: a[i - 1] });
      i -= 1;
      continue;
    }
    rev.push({ type: 'add', text: b[j - 1] });
    j -= 1;
  }
  while (i > 0) {
    rev.push({ type: 'del', text: a[i - 1] });
    i -= 1;
  }
  while (j > 0) {
    rev.push({ type: 'add', text: b[j - 1] });
    j -= 1;
  }
  rev.reverse();
  return rev;
};

const lcsOps = (a, b) => tracebackLcs(a, b, fillLcsTable(a, b));

const lcsSpans = (a, b) => {
  const oldParts = [];
  const newParts = [];
  for (const op of lcsOps(a, b)) {
    if (op.type === 'eq') {
      oldParts.push({ text: op.text, changed: false });
      newParts.push({ text: op.text, changed: false });
      continue;
    }
    if (op.type === 'del') {
      oldParts.push({ text: op.text, changed: true });
      continue;
    }
    newParts.push({ text: op.text, changed: true });
  }
  return {
    oldSpans: collapseSpans(oldParts),
    newSpans: collapseSpans(newParts),
  };
};

const trimSharedEnds = (a, b) => {
  let lo = 0;
  while (lo < a.length && lo < b.length && a[lo] === b[lo]) lo += 1;
  let hiA = a.length;
  let hiB = b.length;
  while (hiA > lo && hiB > lo && a[hiA - 1] === b[hiB - 1]) {
    hiA -= 1;
    hiB -= 1;
  }
  return {
    prefix: a.slice(0, lo),
    suffix: a.slice(hiA),
    midA: a.slice(lo, hiA),
    midB: b.slice(lo, hiB),
  };
};

const diffTokenMiddle = (midA, midB) => {
  if (midA.length * midB.length > LCS_CELL_LIMIT) {
    return wholeChanged(midA, midB);
  }
  if (midA.length === 0 && midB.length === 0) {
    return { oldSpans: [], newSpans: [] };
  }
  if (midA.length === 0 || midB.length === 0) return wholeChanged(midA, midB);
  return lcsSpans(midA, midB);
};

const joinTrimmedSpans = (prefix, mid, suffix) => {
  const oldParts = [];
  const newParts = [];
  if (prefix.length) {
    const text = prefix.join('');
    oldParts.push({ text, changed: false });
    newParts.push({ text, changed: false });
  }
  for (const span of mid.oldSpans) oldParts.push(span);
  for (const span of mid.newSpans) newParts.push(span);
  if (suffix.length) {
    const text = suffix.join('');
    oldParts.push({ text, changed: false });
    newParts.push({ text, changed: false });
  }
  return {
    oldSpans: collapseSpans(oldParts),
    newSpans: collapseSpans(newParts),
  };
};

const diffTokens = (a, b) => {
  if (a.length === 0 && b.length === 0) {
    return { oldSpans: [], newSpans: [] };
  }
  if (a.length === 0 || b.length === 0) return wholeChanged(a, b);
  const trimmed = trimSharedEnds(a, b);
  const mid = diffTokenMiddle(trimmed.midA, trimmed.midB);
  const joined = joinTrimmedSpans(trimmed.prefix, mid, trimmed.suffix);
  if (isNoisy(joined.oldSpans) || isNoisy(joined.newSpans)) {
    return wholeChanged(a, b);
  }
  return joined;
};

const splitIdentWords = (part) => {
  const words = [];
  for (const word of part.split(/(_+)/)) {
    if (word === '') continue;
    words.push(word);
  }
  return words;
};

const splitPieces = (text) => {
  if (text === '') return [];
  PIECE_RE.lastIndex = 0;
  const coarse = text.match(PIECE_RE) ?? [];
  const pieces = [];
  for (const part of coarse) {
    for (const word of splitIdentWords(part)) pieces.push(word);
  }
  return pieces;
};

const spansFromWordOps = (ops) => {
  const oldParts = [];
  const newParts = [];
  let i = 0;
  while (i < ops.length) {
    const op = ops[i];
    if (op.type === 'eq') {
      oldParts.push({ text: op.text, changed: false });
      newParts.push({ text: op.text, changed: false });
      i += 1;
      continue;
    }
    const dels = [];
    const adds = [];
    while (i < ops.length && ops[i].type !== 'eq') {
      if (ops[i].type === 'del') dels.push(ops[i].text);
      else adds.push(ops[i].text);
      i += 1;
    }
    const one = dels.length === 1 && adds.length === 1;
    const close = one && similarity(dels[0], adds[0]) >= WORD_REFINE_MIN;
    if (close) {
      const inner = diffTokens(graphemes(dels[0]), graphemes(adds[0]));
      for (const span of inner.oldSpans) oldParts.push(span);
      for (const span of inner.newSpans) newParts.push(span);
      continue;
    }
    if (dels.length) {
      oldParts.push({ text: dels.join(''), changed: true });
    }
    if (adds.length) {
      newParts.push({ text: adds.join(''), changed: true });
    }
  }
  return {
    oldSpans: collapseSpans(oldParts),
    newSpans: collapseSpans(newParts),
  };
};

const joinAffix = (prefix, mid, suffix) => {
  const parts = [];
  if (prefix.length) {
    parts.push({ text: prefix.join(''), changed: false });
  }
  for (const span of mid) parts.push(span);
  if (suffix.length) {
    parts.push({ text: suffix.join(''), changed: false });
  }
  return collapseSpans(parts);
};

const diffChars = (oldText, newText) => {
  const a = splitPieces(oldText);
  const b = splitPieces(newText);
  if (a.length === 0 && b.length === 0) {
    return { oldSpans: [], newSpans: [] };
  }
  if (a.length === 0 || b.length === 0) return wholeChanged(a, b);
  let lo = 0;
  while (lo < a.length && lo < b.length && a[lo] === b[lo]) lo += 1;
  let hiA = a.length;
  let hiB = b.length;
  while (hiA > lo && hiB > lo && a[hiA - 1] === b[hiB - 1]) {
    hiA -= 1;
    hiB -= 1;
  }
  const prefix = a.slice(0, lo);
  const suffix = a.slice(hiA);
  const midA = a.slice(lo, hiA);
  const midB = b.slice(lo, hiB);
  let mid;
  if (midA.length === 0 && midB.length === 0) {
    mid = { oldSpans: [], newSpans: [] };
  } else if (midA.length === 0 || midB.length === 0) {
    mid = wholeChanged(midA, midB);
  } else if (midA.length * midB.length > LCS_CELL_LIMIT) {
    mid = wholeChanged(midA, midB);
  } else {
    mid = spansFromWordOps(lcsOps(midA, midB));
  }
  return {
    oldSpans: joinAffix(prefix, mid.oldSpans, suffix),
    newSpans: joinAffix(prefix, mid.newSpans, suffix),
  };
};

const pairIndices = (delTexts, addTexts) => {
  const delToAdd = new Array(delTexts.length).fill(-1);
  const addUsed = new Array(addTexts.length).fill(false);
  const candidates = pairCandidates(delTexts, addTexts);
  for (const pair of candidates) {
    if (delToAdd[pair.i] >= 0 || addUsed[pair.j]) continue;
    delToAdd[pair.i] = pair.j;
    addUsed[pair.j] = true;
  }
  if (delTexts.length !== addTexts.length) return delToAdd;
  for (let i = 0; i < delTexts.length; i++) {
    if (delToAdd[i] >= 0 || addUsed[i]) continue;
    delToAdd[i] = i;
    addUsed[i] = true;
  }
  return delToAdd;
};

const changeSides = (block) => {
  const dels = [];
  const adds = [];
  for (const line of block) {
    if (line.type === 'del') dels.push(line);
    if (line.type === 'add') adds.push(line);
  }
  return { dels, adds };
};

const applyInlineSpans = (dels, adds, delToAdd) => {
  const addSeen = new Set();
  for (let i = 0; i < dels.length; i++) {
    const j = delToAdd[i];
    if (j < 0) {
      dels[i].spans = [{ text: dels[i].text, changed: true }];
      continue;
    }
    addSeen.add(j);
    const diff = diffChars(dels[i].text, adds[j].text);
    dels[i].spans = diff.oldSpans;
    adds[j].spans = diff.newSpans;
  }
  for (let j = 0; j < adds.length; j++) {
    if (addSeen.has(j)) continue;
    adds[j].spans = [{ text: adds[j].text, changed: true }];
  }
};

const attachInline = (lines) => {
  const { dels, adds } = changeSides(lines);
  const delToAdd = pairIndices(
    dels.map((line) => line.text),
    adds.map((line) => line.text),
  );
  applyInlineSpans(dels, adds, delToAdd);
  for (const line of lines) {
    if (line.type === 'ctx') {
      line.spans = [{ text: line.text, changed: false }];
    }
  }
  return lines;
};

const addPartners = (delToAdd, addCount) => {
  const addToDel = new Array(addCount).fill(-1);
  for (let i = 0; i < delToAdd.length; i++) {
    const j = delToAdd[i];
    if (j >= 0) addToDel[j] = i;
  }
  return addToDel;
};

const walkAligned = (dels, adds, delToAdd, emit) => {
  const addToDel = addPartners(delToAdd, adds.length);
  const usedAdd = new Array(adds.length).fill(false);
  let addPos = 0;
  const takeUnpairedAdds = (limit) => {
    while (addPos < limit) {
      const free = addToDel[addPos] < 0 && !usedAdd[addPos];
      if (free) {
        emit.unpairedAdd(adds[addPos]);
        usedAdd[addPos] = true;
      }
      addPos += 1;
    }
  };
  for (let i = 0; i < dels.length; i++) {
    const j = delToAdd[i];
    if (j < 0) {
      emit.unpairedDel(dels[i]);
      continue;
    }
    takeUnpairedAdds(j);
    emit.pair(dels[i], adds[j]);
    usedAdd[j] = true;
    if (addPos <= j) addPos = j + 1;
  }
  takeUnpairedAdds(adds.length);
  for (let j = 0; j < adds.length; j++) {
    if (!usedAdd[j]) emit.unpairedAdd(adds[j]);
  }
};

const alignChangeBlock = (dels, adds, delToAdd) => {
  const out = [];
  walkAligned(dels, adds, delToAdd, {
    unpairedDel: (del) => {
      out.push(del);
    },
    unpairedAdd: (add) => {
      out.push(add);
    },
    pair: (del, add) => {
      out.push(del);
      out.push(add);
    },
  });
  return out;
};

const mapHunkBlocks = (lines, onCtx, onChange) => {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].type === 'ctx') {
      out.push(onCtx(lines[i]));
      i += 1;
      continue;
    }
    const start = i;
    while (i < lines.length && lines[i].type !== 'ctx') i += 1;
    const block = lines.slice(start, i);
    const { dels, adds } = changeSides(block);
    const delToAdd = pairIndices(
      dels.map((line) => line.text),
      adds.map((line) => line.text),
    );
    for (const row of onChange(dels, adds, delToAdd)) out.push(row);
  }
  return out;
};

const alignPairs = (lines) =>
  mapHunkBlocks(lines, (line) => line, alignChangeBlock);

const alignSplitBlock = (dels, adds, delToAdd) => {
  const out = [];
  walkAligned(dels, adds, delToAdd, {
    unpairedDel: (del) => {
      out.push({ left: del, right: null });
    },
    unpairedAdd: (add) => {
      out.push({ left: null, right: add });
    },
    pair: (del, add) => {
      out.push({ left: del, right: add });
    },
  });
  return out;
};

const alignSplit = (lines) =>
  mapHunkBlocks(
    lines,
    (line) => ({ left: line, right: line }),
    alignSplitBlock,
  );

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

const splitHunk = (hunk) => {
  const { oldStart, oldCount, newStart, newCount, header } = hunk;
  const blocks = [];
  let current = null;
  let blockId = -1;
  const lines = hunk.lines.map((line) => {
    if (line.type === 'ctx') {
      current = null;
      return { ...line, blockId: null };
    }
    if (!current) {
      blockId += 1;
      current = { id: blockId };
      blocks.push(current);
    }
    return { ...line, blockId };
  });
  const nextHunk = { oldStart, oldCount, newStart, newCount, header, lines };
  return { hunk: nextHunk, blocks };
};

const otherContext = (contextSide, blockId) => {
  if (contextSide === 'new') return 'new';
  if (contextSide === 'old') return 'old';
  return contextSide[blockId] ?? 'old';
};

const flattenBlock = (hunk, blockId, contextSide) => {
  const out = [];
  for (const line of hunk.lines) {
    if (line.blockId === blockId || line.type === 'ctx') {
      out.push(line);
      continue;
    }
    const side = otherContext(contextSide, line.blockId);
    if (side === 'old' && line.type === 'del') {
      out.push({ type: 'ctx', text: line.text, noNl: line.noNl });
      continue;
    }
    if (side === 'new' && line.type === 'add') {
      out.push({ type: 'ctx', text: line.text, noNl: line.noNl });
    }
  }
  return out;
};

const countSides = (lines) => {
  let oldCount = 0;
  let newCount = 0;
  for (const line of lines) {
    if (line.type === 'ctx' || line.type === 'del') oldCount += 1;
    if (line.type === 'ctx' || line.type === 'add') newCount += 1;
  }
  return { oldCount, newCount };
};

const formatHunkHeader = (oldStart, oldCount, newStart, newCount) =>
  `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`;

const lineMark = (type) => LINE_MARK[type] ?? ' ';

const formatBodyLine = (line) => {
  const rows = [`${lineMark(line.type)}${line.text}`];
  if (line.noNl) rows.push('\\ No newline at end of file');
  return rows;
};

const formatPatch = (file, hunk, blockId, contextSide) => {
  const lines = flattenBlock(hunk, blockId, contextSide);
  const counts = countSides(lines);
  const header = formatHunkHeader(
    hunk.oldStart,
    counts.oldCount,
    hunk.newStart,
    counts.newCount,
  );
  const parts = [...file.preamble, header];
  for (const line of lines) {
    for (const row of formatBodyLine(line)) parts.push(row);
  }
  return `${parts.join('\n')}\n`;
};

const LAYOUT_ALIGN = {
  mixed: alignPairs,
  side: alignSplit,
};

const windowAroundBlock = (lines, blockId, radius) => {
  let start = -1;
  let end = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].blockId !== blockId) continue;
    if (start < 0) start = i;
    end = i + 1;
  }
  if (start < 0) return lines;
  const from = Math.max(0, start - radius);
  const to = Math.min(lines.length, end + radius);
  return lines.slice(from, to);
};

const displayLines = (hunk, blockId, layout = 'unified', radius) => {
  const flat = flattenBlock(hunk, blockId, 'new');
  const around = radius ?? DISPLAY_CONTEXT;
  const windowed = windowAroundBlock(flat, blockId, around);
  const lines = windowed.map((line) => ({ ...line }));
  const painted = attachInline(lines);
  const align = LAYOUT_ALIGN[layout];
  if (align) return align(painted);
  return painted;
};

const splitLines = (content) => {
  if (content === '') return { lines: [''], noNl: true };
  const parts = content.split('\n');
  const noNl = parts.at(-1) !== '';
  if (!noNl) parts.pop();
  return { lines: parts, noNl };
};

const synthesizeNewFile = (relPath, content) => {
  const { lines, noNl } = splitLines(content);
  const body = lines.map((text, index) => ({
    type: 'add',
    text,
    noNl: noNl && index === lines.length - 1,
    blockId: 0,
  }));
  const oldStart = 0;
  const oldCount = 0;
  const newStart = 1;
  const newCount = body.length;
  const header = formatHunkHeader(oldStart, oldCount, newStart, newCount);
  const hunk = { oldStart, oldCount, newStart, newCount, header, lines: body };
  const preamble = [
    `diff --git a/${relPath} b/${relPath}`,
    'new file mode 100644',
    '--- /dev/null',
    `+++ b/${relPath}`,
  ];
  return {
    oldPath: relPath,
    newPath: relPath,
    isNew: true,
    isDeleted: false,
    isBinary: false,
    preamble,
    hunks: [hunk],
  };
};

const itemsFromFiles = (files, origin) => {
  const items = [];
  for (const file of files) {
    if (file.isBinary) {
      const hunk = null;
      const blockId = null;
      const patchAdd = '';
      const patchRevert = '';
      items.push({ origin, file, hunk, blockId, patchAdd, patchRevert });
      continue;
    }
    for (const rawHunk of file.hunks) {
      const { hunk, blocks } = splitHunk(rawHunk);
      for (const block of blocks) {
        const blockId = block.id;
        const indexSide = INDEX_SIDE[origin] ?? 'old';
        const patchAdd = formatPatch(file, hunk, blockId, indexSide);
        const patchRevert = formatPatch(file, hunk, blockId, 'new');
        items.push({ origin, file, hunk, blockId, patchAdd, patchRevert });
      }
    }
  }
  return items;
};

const refreshIndexPatches = (items, item) => {
  if (!item.hunk || !item.file) return;
  const siblings = [];
  for (const other of items) {
    if (other.hunk === item.hunk && other.file === item.file) {
      siblings.push(other);
    }
  }
  const sides = Object.create(null);
  for (const other of siblings) {
    sides[other.blockId] = INDEX_SIDE[other.origin] ?? 'old';
  }
  for (const other of siblings) {
    other.patchAdd = formatPatch(other.file, other.hunk, other.blockId, sides);
  }
};

module.exports = {
  LCS_CELL_LIMIT,
  DISPLAY_CONTEXT,
  PAIR_MIN_SIM,
  diffChars,
  similarity,
  pairScore,
  pairIndices,
  attachInline,
  parseDiff,
  splitHunk,
  flattenBlock,
  formatPatch,
  displayLines,
  alignSplit,
  synthesizeNewFile,
  itemsFromFiles,
  refreshIndexPatches,
  countSides,
};
