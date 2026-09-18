'use strict';

const ansi = require('../ansi.js');
const primitives = require('./primitives.js');

const { THEME, paint, visibleWidth, truncateVisible, seq, EL } = ansi;
const { fill, padVisible, FILE_MARK, paneResult, paintCursorList } = primitives;

const COMMIT_COL_KEYS = ['sha', 'author', 'date'];

const COMMIT_COL_ALIGN = {
  sha: 'end',
  author: 'start',
  date: 'start',
};

const COMMIT_COL_FG = {
  sha: THEME.shaFg,
  author: THEME.mutedFg,
  date: THEME.mutedFg,
};

const COMMIT_EDGE = 2;
const COMMIT_TAIL = 1;
const COMMIT_GAP = '  ';
const COMMIT_DATE_GAP = '   ';

const colGap = (key) => (key === 'date' ? COMMIT_DATE_GAP : COMMIT_GAP);

const commitRowFields = (entry) => ({
  sha: entry.shortSha ?? '',
  author: entry.author ?? '',
  date: entry.date ?? '',
});

const commitColumns = (commits) => {
  const widths = {};
  for (const key of COMMIT_COL_KEYS) widths[key] = 0;
  for (const entry of commits) {
    const fields = commitRowFields(entry);
    for (const key of COMMIT_COL_KEYS) {
      const w = visibleWidth(fields[key]);
      if (w > widths[key]) widths[key] = w;
    }
  }
  return widths;
};

const commitRowParts = (entry, cols) => {
  const fields = commitRowFields(entry);
  const parts = {};
  for (const key of COMMIT_COL_KEYS) {
    const width = cols?.[key] ?? visibleWidth(fields[key]);
    parts[key] = padVisible(fields[key], width, COMMIT_COL_ALIGN[key]);
  }
  return parts;
};

const joinCommitSuffix = (parts, cols) => {
  const bits = [];
  for (const key of COMMIT_COL_KEYS) {
    if (!cols[key]) continue;
    bits.push(colGap(key) + parts[key]);
  }
  if (!bits.length) return '';
  return bits.join('');
};

const commitColFg = (key) => COMMIT_COL_FG[key];

const paintCommitSuffix = (parts, cols, fgRgb, bgRgb, color) => {
  const bits = [];
  for (const key of COMMIT_COL_KEYS) {
    if (!cols[key]) continue;
    const tone = commitColFg(key) ?? fgRgb;
    const gap = paint(colGap(key), fgRgb, bgRgb, color);
    bits.push(gap + paint(parts[key], tone, bgRgb, color));
  }
  if (!bits.length) return '';
  return bits.join('');
};

const paintCommitRow = (entry, width, color, selected, cols) => {
  const inner = Math.max(1, width - COMMIT_EDGE - COMMIT_TAIL);
  const mark = selected ? FILE_MARK : ' ';
  const prefix = ` ${mark} `;
  const lead = ' ';
  const parts = commitRowParts(entry, cols);
  const suffix = joinCommitSuffix(parts, cols);
  const rest = Math.max(1, inner - visibleWidth(prefix + lead + suffix));
  const subject = truncateVisible(entry.subject ?? '', rest);
  const pad = Math.max(0, rest - visibleWidth(subject));
  const after = `${' '.repeat(pad)}`;
  const left = `${prefix}${lead}${subject}${after}`;
  const fgRgb = selected ? THEME.chromeFg : THEME.mutedFg;
  const bgRgb = selected ? THEME.buttonBg : THEME.ctxBg;
  const nameFg = selected ? THEME.buttonHotFg : THEME.chromeFg;
  const tail = ' '.repeat(COMMIT_TAIL);
  const edge = fill(COMMIT_EDGE, fgRgb, THEME.ctxBg, color);
  if (!color) return `${left}${suffix}${tail}${edge}`;
  let out = `${seq(fgRgb, bgRgb)}${EL}`;
  out += paint(prefix, fgRgb, bgRgb, color);
  out += paint(lead, nameFg, bgRgb, color);
  out += paint(subject, nameFg, bgRgb, color);
  out += paint(after, fgRgb, bgRgb, color);
  out += paintCommitSuffix(parts, cols, fgRgb, bgRgb, color);
  out += paint(tail, fgRgb, bgRgb, color);
  return out + edge;
};

const paintBodyCommits = (view, width, color, bodyH, headerLines) => {
  const commits = view.commits ?? [];
  const cols = commitColumns(commits);
  const cursor = view.commitCursor ?? 0;
  const paintRow = (entry, rowWidth, rowColor, selected) =>
    paintCommitRow(entry, rowWidth, rowColor, selected, cols);
  const painted = paintCursorList(
    commits,
    cursor,
    width,
    color,
    bodyH,
    headerLines,
    paintRow,
    null,
    view.listScroll,
  );
  return paneResult({
    body: painted.body,
    fileHits: painted.fileHits,
    todoOwners: [],
    cursor: painted.cursor,
    splitBody: false,
    listScroll: painted.offset,
  });
};

module.exports = { paintBodyCommits };
