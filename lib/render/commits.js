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

const paintCommitEdit = (compose, width, color, entry, cols) => {
  const text = `${compose.text ?? ''}`.replaceAll('\n', ' ');
  if (entry && cols) {
    const row = paintCommitRow(
      { ...entry, subject: text },
      width,
      color,
      true,
      cols,
    );
    const inner = Math.max(1, width - COMMIT_EDGE - COMMIT_TAIL);
    const prefix = ` ${FILE_MARK} `;
    const lead = ' ';
    const parts = padColumns(commitRowFields(entry), cols, COMMIT_COL_ALIGN);
    const suffix = joinColumns(parts, cols);
    const rest = Math.max(1, inner - visibleWidth(prefix + lead + suffix));
    const clipped = truncateVisible(text, rest);
    const prefixW = visibleWidth(prefix + lead);
    const col = Math.min(compose.cursor ?? 0, visibleWidth(clipped));
    return {
      row,
      cursor: { x: prefixW + col + 1 },
      at: 'replace',
    };
  }
  const inner = Math.max(1, width - COMMIT_EDGE);
  const prefix = ` ${FILE_MARK} `;
  const lead = ' ';
  const prefixW = visibleWidth(prefix + lead);
  const rest = Math.max(1, inner - prefixW);
  const clipped = truncateVisible(text, rest);
  const pad = Math.max(0, rest - visibleWidth(clipped));
  const gap = ' '.repeat(pad);
  const fgRgb = THEME.chromeFg;
  const bgRgb = THEME.buttonBg;
  const nameFg = THEME.buttonHotFg;
  const edge = fill(COMMIT_EDGE, fgRgb, THEME.ctxBg, color);
  let row = `${prefix}${lead}${clipped}${gap}${edge}`;
  if (color) {
    row = `${seq(fgRgb, bgRgb)}${EL}`;
    row += paint(prefix, fgRgb, bgRgb, color);
    row += paint(lead, nameFg, bgRgb, color);
    row += paint(clipped, nameFg, bgRgb, color);
    row += paint(gap, fgRgb, bgRgb, color);
    row += edge;
  }
  const col = Math.min(compose.cursor ?? 0, visibleWidth(clipped));
  return { row, cursor: { x: prefixW + col + 1 }, at: 'start' };
};

const commitEditRow = (compose, commits, cursor, width, color, cols) => {
  if (!compose || compose.kind !== 'commit') return null;
  if (compose.commitKind === 'amend') {
    const entry = commits[cursor];
    if (!entry) return null;
    return paintCommitEdit(compose, width, color, entry, cols);
  }
  return paintCommitEdit(compose, width, color);
};

const paintBodyCommits = (view, width, color, bodyH, headerLines) => {
  const commits = view.commits ?? [];
  const cols = measureColumns(commits, commitRowFields, COMMIT_COL_ALIGN);
  const cursor = view.commitCursor ?? 0;
  const compose = view.compose;
  const extra = commitEditRow(compose, commits, cursor, width, color, cols);
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
    extra,
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
