'use strict';

const ansi = require('../term/ansi.js');
const { shortAge } = require('../common/format.js');
const primitives = require('./primitives.js');

const { THEME, paint, visibleWidth, trimVisible, seq, EL } = ansi;
const { markPrefix, branchLabel, paintCursorList } = primitives;
const { measureColumns, padColumns, joinColumns, paintColumns } = primitives;
const { paintNameEdit } = require('./name-edit.js');
const { paintTreeBand } = require('./repos.js');
const { tileHits } = require('./tiles.js');

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
  ...BRANCH_COL_FG,
  sha: THEME.shaDarkFg,
  date: THEME.headerFg,
};

const BRANCH_NAME_MAX = 24;
const BRANCH_TAIL = 1;

const branchNameChip = (entry, rowBg) => {
  if (entry.current) {
    return { nameFg: THEME.mutedFg, nameBg: THEME.currentBg, nameBold: false };
  }
  if (entry.isDefault) {
    return { nameFg: THEME.warnFg, nameBg: rowBg, nameBold: true };
  }
  return { nameFg: THEME.buttonHotFg, nameBg: rowBg, nameBold: false };
};

const branchRowFields = (entry) => ({
  sha: entry.sha ?? '',
  ahead: entry.ahead ? `⇡${entry.ahead}` : '',
  behind: entry.behind ? `⇣${entry.behind}` : '',
  gone: entry.gone ? 'gone' : '',
  date: shortAge(entry.date),
});

const branchRowFg = (entry, selected) => {
  if (entry.current) return THEME.headerFg;
  return selected ? THEME.chromeFg : THEME.mutedFg;
};

const branchRowBg = (entry, selected) => {
  if (entry.current) return THEME.currentBg;
  return selected ? THEME.buttonBg : THEME.ctxBg;
};

const paintBranchRow = (entry, width, color, selected, cols) => {
  const inner = Math.max(1, width - BRANCH_TAIL);
  const prefix = markPrefix(selected);
  const parts = padColumns(branchRowFields(entry), cols, BRANCH_COL_ALIGN);
  const suffix = joinColumns(parts, cols);
  const rest = Math.max(1, inner - visibleWidth(prefix + suffix));
  const nameW = Math.min(cols.name, rest);
  const label = trimVisible(branchLabel(entry.name), nameW);
  const namePad = ' '.repeat(Math.max(0, nameW - visibleWidth(label)));
  const canSubject = rest >= nameW + 3;
  const gap = canSubject ? '  ' : '';
  const subjectW = canSubject ? rest - nameW - gap.length : 0;
  const subject = trimVisible(entry.subject ?? '', subjectW);
  const mid = `${label}${namePad}${gap}${subject}`;
  const pad = ' '.repeat(Math.max(0, rest - visibleWidth(mid)));
  const after = `${namePad}${gap}${subject}${pad}`;
  const tail = ' '.repeat(BRANCH_TAIL);
  if (!color) return `${prefix}${label}${after}${suffix}${tail}`;
  const fgRgb = branchRowFg(entry, selected);
  const bgRgb = branchRowBg(entry, selected);
  const chip = branchNameChip(entry, bgRgb);
  const tones = entry.current ? BRANCH_CURRENT_COL_FG : BRANCH_COL_FG;
  let out = `${seq(fgRgb, bgRgb)}${EL}`;
  out += paint(prefix, fgRgb, bgRgb, color);
  out += paint(label, chip.nameFg, chip.nameBg, color, chip.nameBold);
  out += paint(after, fgRgb, bgRgb, color);
  out += paintColumns(parts, cols, fgRgb, bgRgb, color, tones);
  return out + paint(tail, fgRgb, bgRgb, color);
};

const TREES_FULL_H = 8;
const TREES_MIN_H = 6;
const LIST_MIN_H = 4;

// The tiles of the worktrees take what the list of branches can spare
const treesHeight = (bodyH) => {
  if (bodyH - TREES_FULL_H >= LIST_MIN_H) return TREES_FULL_H;
  return bodyH - TREES_MIN_H >= LIST_MIN_H ? TREES_MIN_H : 0;
};

const shiftRows = (list, by) => ({
  ...list,
  cursor: list.cursor ? { ...list.cursor, row: list.cursor.row + by } : null,
  editHits: list.editHits.map((span) => ({ ...span, row: span.row + by })),
});

// The worktrees above the branches; one element is selected, a tile or a branch
const paintBodyBranches = (view, width, color, bodyH, headerLines) => {
  const branches = view.branches ?? [];
  const cols = measureColumns(branches, branchRowFields, BRANCH_COL_ALIGN);
  cols.name = 0;
  for (const entry of branches) {
    cols.name = Math.max(cols.name, visibleWidth(branchLabel(entry.name)));
  }
  cols.name = Math.min(BRANCH_NAME_MAX, cols.name);
  const cursor = view.branchCursor ?? 0;
  const { compose } = view;
  const trees = view.trees ? treesHeight(bodyH) : 0;
  const typing = compose?.kind === 'branch' || compose?.kind === 'worktree';
  const typed = typing ? paintNameEdit(compose, width, color) : null;
  const above = trees && compose?.kind === 'worktree' ? typed : null;
  const edit = above ? null : typed;
  const top = trees + (above ? 1 : 0);
  const room = bodyH - top;
  const lines = headerLines + top;
  const pane = { width, color, bodyH: room, headerLines: lines };
  pane.offset = view.listScroll;
  const picked = !view.treeFocus;
  const paintRow = (entry, selected) =>
    paintBranchRow(entry, width, color, selected && picked, cols);
  const list = paintCursorList(branches, cursor, pane, paintRow, edit);
  if (!trees) return list;
  const band = paintTreeBand(view.trees, width, trees, color);
  const lead = above ? 1 : 0;
  const hits = tileHits(band.bands, headerLines + lead);
  const treeHits = hits.map((hit) => ({ ...hit, tree: true }));
  const head = above ? [above.row] : [];
  const body = [...head, ...band.rows, ...list.body];
  const fileHits = [...treeHits, ...list.fileHits];
  const moved = shiftRows(list, top);
  const typedAbove = above ? { ...above.cursor, row: 0 } : null;
  const spans = above ? above.edits.map((span) => ({ ...span, row: 0 })) : [];
  return {
    ...moved,
    body,
    fileHits,
    cursor: typedAbove ?? moved.cursor,
    editHits: [...spans, ...moved.editHits],
    gridCols: band.cols,
  };
};

module.exports = { paintBodyBranches };
