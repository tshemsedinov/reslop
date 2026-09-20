'use strict';

const ansi = require('../ansi.js');
const primitives = require('./primitives.js');
const { measureColumns, padColumns, joinColumns, paintColumns } = primitives;

const { THEME, paint, visibleWidth, truncateVisible, seq, EL } = ansi;
const { fill, FILE_MARK, paneResult, paintCursorList } = primitives;

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
const commitRowFields = (entry) => ({
  sha: entry.shortSha ?? '',
  author: entry.author ?? '',
  date: entry.date ?? '',
});

const paintCommitRow = (entry, width, color, selected, cols) => {
  const inner = Math.max(1, width - COMMIT_EDGE - COMMIT_TAIL);
  const mark = selected ? FILE_MARK : ' ';
  const prefix = ` ${mark} `;
  const lead = ' ';
  const parts = padColumns(commitRowFields(entry), cols, COMMIT_COL_ALIGN);
  const suffix = joinColumns(parts, cols);
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
  out += paintColumns(parts, cols, fgRgb, bgRgb, color, COMMIT_COL_FG);
  out += paint(tail, fgRgb, bgRgb, color);
  return out + edge;
};

const paintBodyCommits = (view, width, color, bodyH, headerLines) => {
  const commits = view.commits ?? [];
  const cols = measureColumns(commits, commitRowFields, COMMIT_COL_ALIGN);
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
