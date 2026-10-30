'use strict';

const { diffChars, tokenSimilarity } = require('./inline.js');
const { isCtxType, flattenBlock } = require('./patch.js');

const PAIR_MIN_SIM = 0.3;
const PAIR_HEAD_WEIGHT = 0.4;
const PAIR_TOKEN_WEIGHT = 0.6;
const TOKEN_RE = /[A-Za-z_$][\w$]*|\d+|[^\s]/g;

const DISPLAY_CONTEXT = 3;

const lineTokens = (text) => {
  TOKEN_RE.lastIndex = 0;
  return text.match(TOKEN_RE) ?? [];
};

const pairScore = (a, b) => {
  const token = tokenSimilarity(a, b);
  const head = a[0] && a[0] === b[0] ? 1 : 0;
  return PAIR_HEAD_WEIGHT * head + PAIR_TOKEN_WEIGHT * token;
};

const comparePair = (left, right) => {
  if (right.score !== left.score) return right.score - left.score;
  if (left.dist !== right.dist) return left.dist - right.dist;
  if (left.i !== right.i) return left.i - right.i;
  return left.j - right.j;
};

const pairCandidates = (delTexts, addTexts) => {
  if (!delTexts.length || !addTexts.length) return [];
  const delTokens = delTexts.map(lineTokens);
  const addTokens = addTexts.map(lineTokens);
  const candidates = [];
  for (let i = 0; i < delTexts.length; i++) {
    for (let j = 0; j < addTexts.length; j++) {
      const score = pairScore(delTokens[i], addTokens[j]);
      if (score < PAIR_MIN_SIM) continue;
      const dist = Math.abs(i - j);
      candidates.push({ i, j, score, dist });
    }
  }
  return candidates.sort(comparePair);
};

const pairIndices = (delTexts, addTexts) => {
  const delToAdd = new Array(delTexts.length).fill(-1);
  const addUsed = new Array(addTexts.length).fill(false);
  for (const pair of pairCandidates(delTexts, addTexts)) {
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

const pairBlock = (block) => {
  const dels = block.filter((line) => line.type === 'del');
  const adds = block.filter((line) => line.type === 'add');
  const delToAdd = pairIndices(
    dels.map((line) => line.text),
    adds.map((line) => line.text),
  );
  return { dels, adds, delToAdd };
};

const wholeSpans = (text, changed) => [{ text, changed }];

const attachInline = (lines) => {
  const painted = lines.map((line) => ({ ...line }));
  const { dels, adds, delToAdd } = pairBlock(painted);
  for (const add of adds) add.spans = wholeSpans(add.text, true);
  for (let i = 0; i < dels.length; i++) {
    const j = delToAdd[i];
    if (j < 0) {
      dels[i].spans = wholeSpans(dels[i].text, true);
      continue;
    }
    const diff = diffChars(dels[i].text, adds[j].text);
    dels[i].spans = diff.oldSpans;
    adds[j].spans = diff.newSpans;
  }
  for (const line of painted) {
    if (isCtxType(line.type)) line.spans = wholeSpans(line.text, false);
  }
  return painted;
};

const pushAligned = (rows, dels, adds, delToAdd) => {
  const paired = new Array(adds.length).fill(false);
  for (const j of delToAdd) if (j >= 0) paired[j] = true;
  let addPos = 0;
  const takeAdds = (limit) => {
    for (; addPos < limit; addPos++) {
      if (!paired[addPos]) rows.push({ left: null, right: adds[addPos] });
    }
  };
  for (let i = 0; i < dels.length; i++) {
    const j = delToAdd[i];
    if (j < 0) {
      rows.push({ left: dels[i], right: null });
      continue;
    }
    takeAdds(j);
    rows.push({ left: dels[i], right: adds[j] });
    if (addPos <= j) addPos = j + 1;
  }
  takeAdds(adds.length);
};

const sideRows = (lines) => {
  const rows = [];
  let i = 0;
  while (i < lines.length) {
    if (isCtxType(lines[i].type)) {
      rows.push({ left: lines[i], right: lines[i] });
      i += 1;
      continue;
    }
    const start = i;
    while (i < lines.length && !isCtxType(lines[i].type)) i += 1;
    const { dels, adds, delToAdd } = pairBlock(lines.slice(start, i));
    pushAligned(rows, dels, adds, delToAdd);
  }
  return rows;
};

const mixedLines = (lines) => {
  const out = [];
  for (const { left, right } of sideRows(lines)) {
    if (left) out.push(left);
    if (right && right !== left) out.push(right);
  }
  return out;
};

const LAYOUT_ALIGN = { mixed: mixedLines, side: sideRows };

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

const insertAddIndex = (lines) => {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!isCtxType(lines[i].type)) return i + 1;
  }
  return lines.length;
};

const taggedAdds = (text, blockId) => {
  const tagged = [];
  let editStart = 0;
  for (const row of text.split('\n')) {
    tagged.push({
      type: 'add',
      text: row,
      noNl: false,
      blockId,
      wrap: true,
      editStart,
      editEnd: editStart + row.length,
      editLast: true,
    });
    editStart += row.length + 1;
  }
  return tagged;
};

const replaceAdds = (lines, overlay, blockId) => {
  if (overlay.text === '' && !overlay.keepEmpty) {
    return lines.filter((line) => line.type !== 'add');
  }
  const tagged = taggedAdds(overlay.text, blockId);
  const out = [];
  let placed = 0;
  let lastAdd = -1;
  for (const line of lines) {
    if (line.type !== 'add') {
      out.push(line);
      continue;
    }
    if (placed >= tagged.length) continue;
    out.push(tagged[placed++]);
    lastAdd = out.length - 1;
  }
  const extras = tagged.slice(placed);
  if (!extras.length) return out;
  const at = lastAdd >= 0 ? lastAdd + 1 : insertAddIndex(out);
  out.splice(at, 0, ...extras);
  return out;
};

const blockAddText = (hunk, blockId) => {
  if (!hunk) return '';
  const parts = [];
  for (const line of hunk.lines) {
    if (line.type === 'add' && line.blockId === blockId) parts.push(line.text);
  }
  return parts.join('\n');
};

const countsOld = (line) => {
  if (line.type === 'add' || line.synthetic === true) return false;
  return line.type !== 'note' && line.type !== 'noteSep';
};

const countsNew = (line) => line.type !== 'del';

const stampLineNumbers = (lines, hunk) => {
  let oldNo = hunk && hunk.oldStart > 0 ? hunk.oldStart : 0;
  let newNo = hunk && hunk.newStart > 0 ? hunk.newStart : 1;
  return lines.map((line) => {
    const next = { ...line };
    if (line.type === 'note' || line.type === 'noteSep') return next;
    if (countsOld(line)) {
      if (oldNo > 0) next.oldNo = oldNo;
      oldNo += 1;
    }
    if (countsNew(line)) {
      next.newNo = newNo;
      newNo += 1;
    }
    return next;
  });
};

const displayLines = (hunk, blockId, layout = 'unified', radius, overlay) => {
  const flat = flattenBlock(hunk, blockId, 'new');
  const source = overlay ? replaceAdds(flat, overlay, blockId) : flat;
  const numbered = stampLineNumbers(source, hunk);
  const around = radius ?? DISPLAY_CONTEXT;
  const painted = attachInline(windowAroundBlock(numbered, blockId, around));
  const alignRows = LAYOUT_ALIGN[layout];
  return alignRows ? alignRows(painted) : painted;
};

module.exports = {
  DISPLAY_CONTEXT,
  pairIndices,
  attachInline,
  blockAddText,
  displayLines,
};
