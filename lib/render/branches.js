'use strict';

const ansi = require('../ansi.js');
const primitives = require('./primitives.js');

const { THEME, paint, visibleWidth, truncateVisible, seq, EL } = ansi;
const { fill, padVisible, FILE_MARK, paneResult } = primitives;
const { paintCursorList, branchLabel, paintBracketName } = primitives;

const BRANCH_COL_KEYS = ['sha', 'ahead', 'behind', 'gone', 'date'];

const BRANCH_COL_ALIGN = {
  sha: 'end',
  ahead: 'start',
  behind: 'start',
  gone: 'end',
  date: 'end',
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
const BRANCH_GAP = '  ';
const BRANCH_DATE_GAP = '   ';

const colGap = (key) => (key === 'date' ? BRANCH_DATE_GAP : BRANCH_GAP);

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

const branchColumns = (branches) => {
  const widths = { name: 0 };
  for (const key of BRANCH_COL_KEYS) widths[key] = 0;
  for (const entry of branches) {
    const nameW = visibleWidth(branchLabel(entry.name));
    if (nameW > widths.name) widths.name = nameW;
    const fields = branchRowFields(entry);
    for (const key of BRANCH_COL_KEYS) {
      const w = visibleWidth(fields[key]);
      if (w > widths[key]) widths[key] = w;
    }
  }
  widths.name = Math.min(BRANCH_NAME_MAX, widths.name);
  return widths;
};

const branchRowParts = (entry, cols) => {
  const fields = branchRowFields(entry);
  const parts = {};
  for (const key of BRANCH_COL_KEYS) {
    const width = cols?.[key] ?? visibleWidth(fields[key]);
    const align = BRANCH_COL_ALIGN[key];
    parts[key] = padVisible(fields[key], width, align);
  }
  return parts;
};

const joinBranchSuffix = (parts, cols) => {
  const bits = [];
  for (const key of BRANCH_COL_KEYS) {
    if (!cols[key]) continue;
    bits.push(colGap(key) + parts[key]);
  }
  if (!bits.length) return '';
  return bits.join('');
};

const branchColFg = (key, current) => {
  if (current && Object.hasOwn(BRANCH_CURRENT_COL_FG, key)) {
    return BRANCH_CURRENT_COL_FG[key];
  }
  return BRANCH_COL_FG[key];
};

const paintBranchSuffix = (parts, cols, fgRgb, bgRgb, color, current) => {
  const bits = [];
  for (const key of BRANCH_COL_KEYS) {
    if (!cols[key]) continue;
    const tone = branchColFg(key, current) ?? fgRgb;
    const gap = paint(colGap(key), fgRgb, bgRgb, color);
    bits.push(gap + paint(parts[key], tone, bgRgb, color));
  }
  if (!bits.length) return '';
  return bits.join('');
};

const paintBranchRow = (entry, width, color, selected, cols) => {
  const inner = Math.max(1, width - BRANCH_EDGE - BRANCH_TAIL);
  const mark = selected ? FILE_MARK : ' ';
  const prefix = ` ${mark} `;
  const parts = branchRowParts(entry, cols);
  const suffix = joinBranchSuffix(parts, cols);
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
  out += paintBranchSuffix(parts, cols, markFg, markBg, color, entry.current);
  out += paint(tail, markFg, markBg, color);
  return out + edge;
};

const paintBranchEdit = (compose, width, color) => {
  const inner = Math.max(1, width - BRANCH_EDGE);
  const prefix = ` ${FILE_MARK} `;
  const prefixW = visibleWidth(prefix);
  const rest = Math.max(1, inner - prefixW);
  const text = compose.text ?? '';
  const label = `[${text}]`;
  const clipped = truncateVisible(label, rest);
  const pad = Math.max(0, rest - visibleWidth(clipped));
  const left = `${prefix}${clipped}${' '.repeat(pad)}`;
  const fgRgb = THEME.chromeFg;
  const bgRgb = THEME.buttonBg;
  const edge = fill(BRANCH_EDGE, fgRgb, THEME.ctxBg, color);
  let row = `${left}${edge}`;
  if (color) {
    const gap = ' '.repeat(pad);
    row = `${seq(fgRgb, bgRgb)}${EL}`;
    row += paint(prefix, fgRgb, bgRgb, color);
    row += paintBracketName(
      clipped,
      THEME.buttonHotFg,
      THEME.mutedFg,
      bgRgb,
      color,
    );
    row += paint(gap, fgRgb, bgRgb, color);
    row += edge;
  }
  const col = Math.min((compose.cursor ?? 0) + 1, visibleWidth(clipped));
  return { row, cursor: { x: prefixW + col + 1 } };
};

const paintBodyBranches = (view, width, color, bodyH, headerLines) => {
  const branches = view.branches ?? [];
  const cols = branchColumns(branches);
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
