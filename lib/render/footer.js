'use strict';

const ansi = require('../term/ansi.js');
const actions = require('../input/actions.js');
const files = require('../common/files.js');
const primitives = require('./primitives.js');
const { fill, isTaskView } = primitives;
const { isTasksEntry } = files;
const { ACTION_IDS, actionLetter } = actions;
const { DASH_IDS, buttonWord } = actions;
const { FILES_GIT_DISABLED } = actions;
const { diffGitDisabled, branchGitDisabled, commitGitDisabled } = actions;
const { entryHasDiff, lineHasDiff, withoutMoves } = actions;
const { THEME, paint, visibleWidth } = ansi;
const { selectedFile, selectedBranch, selectedCommit } = require('./header.js');

const BUTTON_LEAD = ' ';

const BUTTON_GAP = '  ';

const HINT_ONLY = ['taskNudge'];

const BUTTON_EDGE = 1;

const BACK_ARROW = '🢐';

const BACK_KEY = 'esc';

const BUTTON_MARK = {
  bgRgb: THEME.buttonBg,
  fgRgb: THEME.buttonFg,
  hotFg: THEME.buttonHotFg,
  missFg: THEME.buttonHotFg,
  missBold: true,
};

const QUIT_MARK = {
  bgRgb: THEME.chromeBg,
  fgRgb: THEME.mutedFg,
  hotFg: THEME.warnFg,
  missFg: THEME.mutedFg,
  missBold: false,
};

const SAVE_HINT = 'Press **Ctrl-S** or **Enter** at EOF to save';

const HINT_HOT_FG = 0xff;

const buttonGap = (index) => (index ? BUTTON_GAP : BUTTON_LEAD);

const hintBody = (mark) => `${mark}${BACK_KEY}`;

const buttonLabel = (id, short) => (short ? actionLetter(id) : buttonWord(id));

const paintBackHint = (color, mark) => {
  const bgRgb = THEME.buttonBg;
  const rest = hintBody(mark).slice(mark.length);
  const arrow = paint(mark, THEME.buttonHotFg, bgRgb, color, true);
  return arrow + paint(rest, THEME.buttonFg, bgRgb, color);
};

const paintMarkedWord = (label, letter, color, mark) => {
  const at = label.indexOf(letter);
  if (at < 0) {
    return paint(label, mark.missFg, mark.bgRgb, color, mark.missBold);
  }
  const before = label.slice(0, at);
  const hot = label.slice(at, at + letter.length);
  const after = label.slice(at + letter.length);
  let out = paint(before, mark.fgRgb, mark.bgRgb, color);
  out += paint(hot, mark.hotFg, mark.bgRgb, color, true);
  return out + paint(after, mark.fgRgb, mark.bgRgb, color);
};

const footerIds = (hidden, extra, backId, globals, tail, after) => {
  const ids = backId ? [backId] : [];
  const push = (id) => {
    if (!ids.includes(id)) ids.push(id);
  };
  for (const add of extra) push(add);
  for (const id of globals) push(id);
  if (tail) {
    for (const id of ACTION_IDS) {
      if (id === 'quit' || hidden.includes(id) || ids.includes(id)) continue;
      ids.push(id);
    }
  }
  for (const id of after) push(id);
  return ids;
};

const buttonPiece = (id, index, short, backId, mark) => {
  const back = id === backId;
  const letter = back ? BACK_KEY : actionLetter(id);
  const label = back ? hintBody(mark) : buttonLabel(id, short);
  const gap = buttonGap(index);
  return {
    id,
    piece: `${gap}${label}`,
    gap,
    letter,
    label,
    back,
    mark: back ? mark : '',
  };
};

const packGroup = (ids, short, start, backId, mark) => {
  const parts = [];
  for (let i = 0; i < ids.length; i++) {
    parts.push(buttonPiece(ids[i], start + i, short, backId, mark));
  }
  return parts;
};

const groupWidth = (parts) => {
  let width = 0;
  for (const part of parts) width += visibleWidth(part.piece);
  return width;
};

const placeGroup = (parts, hits, disabled, x) => {
  const placed = [];
  let cursor = x;
  for (const part of parts) {
    const w = visibleWidth(part.piece);
    const off = disabled.includes(part.id);
    const hint = HINT_ONLY.includes(part.id);
    if (!off && !hint) hits.push({ id: part.id, x0: cursor, x1: cursor + w });
    placed.push({ ...part, disabled: off });
    cursor += w;
  }
  return { placed, cursor };
};

const splitFooter = (ids, options, limit) => {
  const { disabled = [], backId = '', mark = BACK_ARROW } = options;
  const { globals = [], after = [] } = options;
  const rightIds = [];
  for (const id of [...globals, ...after]) {
    if (ids.includes(id) && !rightIds.includes(id)) rightIds.push(id);
  }
  const leftIds = ids.filter((id) => !rightIds.includes(id));
  const pack = (leftShort, rightShort) => {
    const left = packGroup(leftIds, leftShort, 0, backId, mark);
    const start = left.length ? 1 : 0;
    const right = packGroup(rightIds, rightShort, start, backId, mark);
    return { left, right };
  };
  const wide = (packed) =>
    groupWidth(packed.left) + groupWidth(packed.right) > limit;
  let packed = pack(false, false);
  if (wide(packed)) packed = pack(false, true);
  if (wide(packed)) packed = pack(true, true);
  const left = packed.left.slice();
  const right = packed.right.slice();
  while (groupWidth(left) + groupWidth(right) > limit && left.length) {
    left.pop();
  }
  while (groupWidth(left) + groupWidth(right) > limit && right.length) {
    right.pop();
  }
  const hits = [];
  const leftPlace = placeGroup(left, hits, disabled, 0);
  const parts = leftPlace.placed;
  let x = leftPlace.cursor;
  const gap = Math.max(0, limit - x - groupWidth(right));
  if (gap && right.length) {
    parts.push({ spacer: true, piece: ' '.repeat(gap) });
    x += gap;
  }
  const rightPlace = placeGroup(right, hits, disabled, x);
  parts.push(...rightPlace.placed);
  return { hits, parts };
};

const layoutButtons = (width, options = {}) => {
  const { compact = false, hidden = [], extra = [], disabled = [] } = options;
  const { backId = '', mark = BACK_ARROW, globals = [] } = options;
  const { tail = true, after = [] } = options;
  const ids = footerIds(hidden, extra, backId, globals, tail, after);
  const limit = Math.max(0, width - BUTTON_EDGE);
  if (globals.length) return splitFooter(ids, options, limit);
  const build = (short) => {
    const hits = [];
    const parts = [];
    let x = 0;
    for (const id of ids) {
      const part = buttonPiece(id, parts.length, short, backId, mark);
      const w = visibleWidth(part.piece);
      if (x + w > limit && parts.length) break;
      const off = disabled.includes(id);
      const hint = HINT_ONLY.includes(id);
      if (!off && !hint) hits.push({ id, x0: x, x1: x + w });
      parts.push({ ...part, disabled: off });
      x += w;
    }
    return { hits, parts };
  };
  if (compact) return build(true);
  const words = build(false);
  if (words.parts.length === ids.length) return words;
  return build(true);
};

const paintButtons = (layout, width, color) => {
  const fgRgb = THEME.buttonFg;
  const bgRgb = THEME.buttonBg;
  let out = '';
  let used = 0;
  for (let i = 0; i < layout.parts.length; i++) {
    const part = layout.parts[i];
    if (part.spacer) {
      out += paint(part.piece, fgRgb, bgRgb, color);
      used += visibleWidth(part.piece);
      continue;
    }
    const gap = part.gap ?? buttonGap(i);
    out += paint(gap, fgRgb, bgRgb, color);
    if (part.back) out += paintBackHint(color, part.mark);
    else if (part.disabled) out += paint(part.label, fgRgb, bgRgb, color);
    else out += paintMarkedWord(part.label, part.letter, color, BUTTON_MARK);
    used += visibleWidth(part.piece);
  }
  return out + fill(width - used, fgRgb, bgRgb, color);
};

const commitSaveHint = (view) => {
  const composing = view.mode === 'compose';
  const full = view.commitView === 'full';
  const commit = view.compose?.kind === 'commit';
  return composing && full && commit;
};

const paintSaveHintBar = (width, color) => {
  const bgRgb = THEME.buttonBg;
  const plain = `${BUTTON_LEAD}${SAVE_HINT.replaceAll('**', '')}`;
  const pad = Math.max(0, width - visibleWidth(plain));
  if (!color) return plain + ' '.repeat(pad);
  let out = paint(BUTTON_LEAD, THEME.buttonFg, bgRgb, color);
  const bits = SAVE_HINT.split('**');
  for (let i = 0; i < bits.length; i++) {
    const hot = i % 2 === 1;
    const tone = hot ? HINT_HOT_FG : THEME.buttonFg;
    out += paint(bits[i], tone, bgRgb, color, hot);
  }
  return out + fill(pad, THEME.buttonFg, bgRgb, color);
};

const paintFooter = (view, layout, width, color) => {
  if (commitSaveHint(view)) return paintSaveHintBar(width, color);
  return paintButtons(layout, width, color);
};

const footerHits = (view, layout) => (commitSaveHint(view) ? [] : layout.hits);

const filesDim = (view) => {
  const entry = selectedFile(view);
  if (isTasksEntry(entry)) return FILES_GIT_DISABLED;
  return withoutMoves([], entryHasDiff(entry));
};

const unitDim = (view) => {
  const off = [...diffGitDisabled(view.item)];
  const lines = view.unitLines;
  if (!lines || !lines.length) return off;
  const line = lines[view.unitLine ?? 0];
  return withoutMoves(off, lineHasDiff(line));
};

const commitsDim = (view) => {
  const canCommit = (view.counts?.staged ?? 0) > 0;
  const unstagedCurrent = !view.rev && !view.revShort;
  const target = { ...selectedCommit(view), canCommit, unstagedCurrent };
  return commitGitDisabled(target);
};

const PACKAGE_ROW_ACTIONS = ['packageDrop', 'packageWanted', 'packageLatest'];

const packagesDim = (view) => {
  const listed = view.packages && view.packages.modules;
  const rows = listed && listed.packages ? listed.packages : [];
  const cursor = view.packagesCursor ?? 0;
  const onRow = rows.length > 0 && cursor < rows.length;
  if (!onRow) return PACKAGE_ROW_ACTIONS;
  const row = rows[cursor];
  return row && row.transitive ? ['packageNew', 'packageDrop'] : [];
};

const agentListDim = (view) => {
  const list = view.agents ?? [];
  const row = list[view.agentCursor ?? 0];
  const installed = Boolean(row && row.bin);
  const levels = (row && row.efforts) || [];
  const sizes = (row && row.contexts) || [];
  const off = [];
  if (!installed || levels.length < 2) off.push('agentEffort');
  if (!installed) off.push('agentFast');
  if (!installed || sizes.length < 2) off.push('agentContext');
  if ((view.agentPlanCount ?? 0) < 2) off.push('agentReview');
  if (installed || !row || !row.package) off.push('agentInstall');
  if (!view.agentCanStart) off.push('agentStart');
  return off;
};

const agentsDim = (view) => {
  if (!view.agentView) return agentListDim(view);
  return view.agentRunning ? ['agentRerun'] : ['agentStop'];
};

const npmDim = (view) => {
  if (view.npmView) return view.npmRunning ? [] : ['npmStop'];
  return view.npmLogs ? [] : ['npmLogs'];
};

const FOOTER_DIM = {
  files: filesDim,
  unit: unitDim,
  diff: (view) => diffGitDisabled(view.item),
  branches: (view) => branchGitDisabled(selectedBranch(view)),
  commits: commitsDim,
  packages: packagesDim,
  agents: agentsDim,
  npm: npmDim,
};

const dimFooterActions = (view) => {
  const pick = FOOTER_DIM[view.pane ?? 'diff'];
  return pick ? pick(view) : [];
};

const GIT_FOOTER = ['add', 'unstage', 'revert', 'ignore'];

const FOOTER_EXTRA = {
  repos: ['theme'],
  dashboard: ['theme', 'pull', 'push'],
  unit: ['add', 'unstage', 'revert', 'feedback', 'code', 'lines'],
  files: [...GIT_FOOTER, 'code'],
  diff: [...GIT_FOOTER, 'feedback', 'code', 'layout', 'lines'],
  branches: ['newBranch', 'rebase', 'drop', 'pull', 'push'],
  commits: ['newCommit', 'apply', 'reword', 'drop', 'view', 'pull', 'push'],
  npmLog: ['npmVerbose', 'npmStop', 'npmRerun'],
  npm: ['npmEdit', 'npmNew', 'npmDrop', 'npmLogs'],
  packages: ['packageNew', 'packageDrop', 'packageWanted', 'packageLatest'],
  agentLog: ['agentStop', 'agentRerun'],
  agents: [
    'agentModel',
    'agentEffort',
    'agentFast',
    'agentContext',
    'agentReview',
    'agentInstall',
    'agentStart',
  ],
  tasks: ['plan', 'import', 'drop', 'check', 'taskNudge'],
};

const extraFooterActions = (view) => {
  const { pane } = view;
  if (pane === 'npm' && view.npmView) return FOOTER_EXTRA.npmLog;
  if (pane === 'npm') return FOOTER_EXTRA.npm;
  if (pane === 'agents' && view.agentView) return FOOTER_EXTRA.agentLog;
  if (pane === 'agents') return FOOTER_EXTRA.agents;
  const listed = FOOTER_EXTRA[pane];
  if (listed) return listed;
  if (isTaskView(view)) return FOOTER_EXTRA.tasks;
  return GIT_FOOTER;
};

const footerLayout = (view, width) => {
  const extra = extraFooterActions(view);
  const disabled = dimFooterActions(view);
  const backId = 'back';
  const globals = view.pane === 'repos' ? [] : DASH_IDS;
  const tail = false;
  const options = { extra, disabled, backId, globals, tail };
  return layoutButtons(width, options);
};

module.exports = {
  QUIT_MARK,
  paintMarkedWord,
  layoutButtons,
  paintFooter,
  footerHits,
  footerLayout,
};
