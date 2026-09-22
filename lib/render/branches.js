'use strict';

const ansi = require('../ansi.js');
const primitives = require('./primitives.js');
const { measureColumns, padColumns, joinColumns, paintColumns } = primitives;

const { THEME, paint, visibleWidth, truncateVisible, seq, EL } = ansi;
const { fill, FILE_MARK, paneResult } = primitives;
const { paintCursorList, paintListEdit } = primitives;
const { branchLabel, paintBracketName } = primitives;

const BRANCH_COL_ALIGN = {
  sha: 'end',
  ahead: 'start',
  behind: 'start',
  gone: 'end',
  date: 'start',
};

const BRANCH_COL_FG = {
  sha: THEME.shaFg,
  ahead: THEME.addLineFg,
  behind: THEME.delLineFg,
  gone: THEME.delLineFg,
  date: THEME.mutedFg,
};

const BRANCH_CURRENT_COL_FG = {
  sha: THEME.shaDarkFg,
  date: THEME.headerFg,
};

const BRANCH_NAME_MAX = 24;
const BRANCH_EDGE = 2;
const BRANCH_TAIL = 1;
const branchNameChip = (entry, rowBg) => {
  if (entry.current) {
    return {
      nameFg: THEME.mutedFg,
      wrapFg: THEME.mutedFg,
      nameBg: THEME.currentBg,
      nameBold: false,
    };
  }
  if (entry.isDefault) {
    return {
      nameFg: THEME.warnFg,
      wrapFg: THEME.mutedFg,
      nameBg: rowBg,
      nameBold: true,
    };
  }
  return {
    nameFg: THEME.buttonHotFg,
    wrapFg: THEME.mutedFg,
    nameBg: rowBg,
    nameBold: false,
  };
};

const branchRowFg = (entry, selected) => {
  if (selected) return THEME.chromeFg;
  return THEME.mutedFg;
};

const branchRowFields = (entry) => {
  const sha = entry.sha ?? '';
  const date = entry.date ?? '';
  const gone = entry.gone ? 'gone' : '';
  const ahead = entry.ahead ? `⇡${entry.ahead}` : '';
  const behind = entry.behind ? `⇣${entry.behind}` : '';
  return { sha, ahead, behind, gone, date };
};

const paintBranchRow = (entry, width, color, selected, cols) => {
  const inner = Math.max(1, width - BRANCH_EDGE - BRANCH_TAIL);
  const mark = selected ? FILE_MARK : ' ';
  const prefix = ` ${mark} `;
  const parts = padColumns(branchRowFields(entry), cols, BRANCH_COL_ALIGN);
  const suffix = joinColumns(parts, cols);
  const rest = Math.max(1, inner - visibleWidth(prefix + suffix));
  const nameW = Math.min(cols.name, rest);
  const label = truncateVisible(branchLabel(entry.name), nameW);
  const namePad = Math.max(0, nameW - visibleWidth(label));
  const canSubject = rest >= nameW + 3;
  const gap = canSubject ? '  ' : '';
  const subjectW = canSubject ? rest - nameW - visibleWidth(gap) : 0;
  const subject = truncateVisible(entry.subject ?? '', subjectW);
  const mid = `${label}${' '.repeat(namePad)}${gap}${subject}`;
  const pad = Math.max(0, rest - visibleWidth(mid));
  const after = `${' '.repeat(namePad)}${gap}${subject}${' '.repeat(pad)}`;
  const left = `${prefix}${label}${after}`;
  const fgRgb = branchRowFg(entry, selected);
  const bgRgb = selected ? THEME.buttonBg : THEME.ctxBg;
  const chip = branchNameChip(entry, bgRgb);
  const markFg = entry.current ? THEME.headerFg : fgRgb;
  const markBg = entry.current ? THEME.currentBg : bgRgb;
  const tail = ' '.repeat(BRANCH_TAIL);
  const edge = fill(BRANCH_EDGE, fgRgb, THEME.ctxBg, color);
  if (!color) return `${left}${suffix}${tail}${edge}`;
  let out = `${seq(fgRgb, bgRgb)}${EL}`;
  out += paint(prefix, fgRgb, bgRgb, color);
  out += paintBracketName(
    label,
    chip.nameFg,
    chip.wrapFg,
    chip.nameBg,
    color,
    chip.nameBold,
  );
  out += paint(after, markFg, markBg, color);
  const tones = entry.current
    ? { ...BRANCH_COL_FG, ...BRANCH_CURRENT_COL_FG }
    : BRANCH_COL_FG;
  out += paintColumns(parts, cols, markFg, markBg, color, tones);
  out += paint(tail, markFg, markBg, color);
  return out + edge;
};

const paintBranchEdit = (compose, width, color) =>
  paintListEdit(compose, width, color, BRANCH_EDGE);

const paintBodyBranches = (view, width, color, bodyH, headerLines) => {
  const branches = view.branches ?? [];
  const cols = measureColumns(branches, branchRowFields, BRANCH_COL_ALIGN);
  cols.name = 0;
  for (const entry of branches) {
    cols.name = Math.max(cols.name, visibleWidth(branchLabel(entry.name)));
  }
  cols.name = Math.min(BRANCH_NAME_MAX, cols.name);
  const cursor = view.branchCursor ?? 0;
  const compose = view.compose;
  const editing = compose && compose.kind === 'branch';
  const tail = editing ? paintBranchEdit(compose, width, color) : null;
  const paintRow = (entry, rowWidth, rowColor, selected) =>
    paintBranchRow(entry, rowWidth, rowColor, selected, cols);
  const painted = paintCursorList(
    branches,
    cursor,
    width,
    color,
    bodyH,
    headerLines,
    paintRow,
    tail,
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

module.exports = { paintBodyBranches };
