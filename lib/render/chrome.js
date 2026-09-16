'use strict';

const ansi = require('../ansi.js');
const keys = require('../keys.js');
const files = require('../files.js');
const primitives = require('./primitives.js');

const { itemPath, TODO_FILE, isTodosEntry } = files;
const { ACTION_IDS, BRANCH_ACTIONS, actionLetter, buttonWord } = keys;
const { FILES_DISABLED, FILES_GIT_DISABLED, BRANCHES_DISABLED } = keys;
const { TODO_DISABLED, DIFF_DISABLED, diffGitDisabled } = keys;
const { branchGitDisabled, CONFIRM, confirmPrefix, promptFromChoices } = keys;
const { THEME, paint, visibleWidth } = ansi;
const { truncateVisible, fg, RESET, EL, seq } = ansi;
const { fill, branchLabel, paintBracketName } = primitives;

const HEADER_ROLE_FG = {
  repo: THEME.headerRepoFg,
  dir: THEME.headerDirFg,
  slash: THEME.headerSlashFg,
  file: THEME.headerFileFg,
  meta: THEME.headerMetaFg,
};

const BUSY_BAR = ['▰▰▱▱▱▱', '▱▰▰▱▱▱', '▱▱▰▰▱▱', '▱▱▱▰▰▱', '▱▱▱▱▰▰', '▰▱▱▱▱▰'];
const BUSY_PROGRESS = [
  'pulling',
  'pushing',
  'loading',
  'checking npm',
  'updating reslop',
  'npm i',
  'npm uninstall',
  'npm audit fix',
  'checking out',
  'creating branch',
  'rebasing',
  'dropping',
  'committing',
  'force pushing',
];

const formatBusyStatus = (status, frame = 0) => {
  const kind = `${status ?? ''}`;
  if (!BUSY_PROGRESS.includes(kind)) return kind;
  const i = Math.abs(frame) % BUSY_BAR.length;
  return `${kind}  ${BUSY_BAR[i]}`;
};

const INFO_STATUS = [
  'copied',
  'staged',
  'unstaged',
  'not staged',
  'dropped',
  'already staged',
  'read only',
  'nothing to review',
  'nothing to commit',
  'unified',
  'mixed',
  'side-by-side',
  'saved',
  'reloaded',
  'not a diff block',
  'committed',
  'amended',
  'fixup',
  'updated',
  'updating reslop',
  'loading',
  'checking npm',
  'npm i',
  'npm uninstall',
  'npm audit fix',
  'pulling',
  'pushing',
  'pulled',
  'pushed',
  'force pushing',
  'force pushed',
  'checking out',
  'creating branch',
  'rebasing',
  'dropping',
  'committing',
  'checked out',
  'created',
  'empty branch name',
];
const INFO_PREFIX = ['checked out ', 'created ', 'rebased onto ', 'dropped '];

const QUIT_PROMPT = promptFromChoices(CONFIRM.confirmQuit.choices);
const COMMIT_PROMPT = promptFromChoices(CONFIRM.confirmCommit.choices);
const updatePrompt = (from, to) => ` update reslop ${from} → ${to}? y/n`;
const dropPrompt = (name) => ` drop ${name}? y/n`;
const PUSH_REJECT_PREFIX = CONFIRM.confirmPush.prefix;
const PUSH_PROMPT = `${PUSH_REJECT_PREFIX} force push`;

const BUTTON_GAP = '  ';
const LOGO = '👁️';

const ORIGIN_LABEL = {
  commit: (view) => view.revShort || 'commit',
  pr: (view) => view.sourceLabel || 'pr',
  todo: () => 'todo',
};

const originLabel = (origin, view) => {
  const named = ORIGIN_LABEL[origin];
  if (named) return named(view);
  return origin ?? 'unknown';
};

const headerRoleFg = (role) => HEADER_ROLE_FG[role] ?? THEME.headerChromeFg;

const pathSegments = (rel) => {
  const segs = [];
  if (!rel) return segs;
  const bits = rel.split('/');
  for (let i = 0; i < bits.length; i++) {
    if (i) {
      segs.push({ text: '/', role: 'slash' });
    }
    if (!bits[i]) {
      continue;
    }
    const last = i === bits.length - 1;
    segs.push({ text: bits[i], role: last ? 'file' : 'dir' });
  }
  return segs;
};

const headerTarget = (view) => {
  const pane = view.pane ?? 'diff';
  if (pane === 'files') {
    const files = view.files ?? [];
    const cursor = view.fileCursor ?? 0;
    const entry = files[cursor];
    const total = files.length;
    const n = total ? cursor + 1 : 0;
    if (!entry) return { path: '', origin: '', n, total };
    if (isTodosEntry(entry)) {
      return { path: TODO_FILE, origin: 'todo', n, total };
    }
    return { path: entry.path, origin: entry.status, n, total };
  }
  if (pane === 'branches') {
    const compose = view.compose;
    const branches = view.branches ?? [];
    if (compose && compose.kind === 'branch') {
      const total = branches.length + 1;
      return { path: compose.text || '', origin: 'new', n: total, total };
    }
    const cursor = view.branchCursor ?? 0;
    const entry = branches[cursor];
    const total = branches.length;
    const n = total ? cursor + 1 : 0;
    if (!entry) return { path: '', origin: 'branch', n, total };
    const origin = entry.current ? 'current' : 'branch';
    return { path: entry.name, origin, n, total };
  }
  if (!view.item) return { path: '', origin: '', n: 0, total: view.total ?? 0 };
  if (view.item.origin === 'todo') {
    return { path: TODO_FILE, origin: 'todo', n: 1, total: 1 };
  }
  return {
    path: itemPath(view.item),
    origin: originLabel(view.item.origin, view),
    n: view.index + 1,
    total: view.total,
  };
};

const headerPrefix = (view) => {
  const repo = view.repoName || '';
  const { path } = headerTarget(view);
  if (repo && path) return ` ${LOGO}  reslop: ${repo}/`;
  if (repo) return ` ${LOGO}  reslop: ${repo} `;
  return ` ${LOGO}  reslop: `;
};

const headerSuffix = ({ origin, n, total }) =>
  origin ? ` ${origin} ${n}/${total}` : ` ${n}/${total}`;

const headerText = (view) => {
  const prefix = headerPrefix(view);
  const target = headerTarget(view);
  return `${prefix}${target.path}${headerSuffix(target)}`;
};

const headerPieces = (view, width) => {
  const repo = view.repoName || '';
  const target = headerTarget(view);
  const path = target.path;
  const suffix = headerSuffix(target);
  const right = ' ';
  const chrome = ` ${LOGO}  reslop: `;
  const prefixW = visibleWidth(headerPrefix(view));
  const used = prefixW + visibleWidth(suffix) + visibleWidth(right);
  const room = Math.max(0, width - used);
  const clipped = truncateVisible(path, room);
  const pad = Math.max(0, room - visibleWidth(clipped));
  const pieces = [{ text: chrome, role: 'chrome' }];
  if (repo) {
    pieces.push({ text: repo, role: 'repo' });
    if (path) {
      pieces.push({ text: '/', role: 'slash' });
    } else {
      pieces.push({ text: ' ', role: 'chrome' });
    }
  }
  for (const seg of pathSegments(clipped)) {
    pieces.push(seg);
  }
  if (pad) {
    pieces.push({ text: ' '.repeat(pad), role: 'chrome' });
  }
  pieces.push({ text: suffix, role: 'meta' });
  pieces.push({ text: right, role: 'chrome' });
  return pieces;
};

const paintHeader = (view, width, color) => {
  const pieces = headerPieces(view, width);
  if (!color) {
    return pieces.map((piece) => piece.text).join('');
  }
  const bgRgb = THEME.headerBg;
  let out = `${seq(THEME.headerChromeFg, bgRgb)}${EL}`;
  for (const piece of pieces) {
    if (!piece.text) {
      continue;
    }
    out += `${fg(headerRoleFg(piece.role))}${piece.text}`;
  }
  return `${out}${RESET}`;
};

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

const paintMarkedWord = (label, letter, color, mark) => {
  const at = label.indexOf(letter);
  if (at < 0) {
    return paint(label, mark.missFg, mark.bgRgb, color, mark.missBold);
  }
  const before = label.slice(0, at);
  const hot = label.slice(at, at + letter.length);
  const after = label.slice(at + letter.length);
  let out = '';
  if (before) out += paint(before, mark.fgRgb, mark.bgRgb, color);
  out += paint(hot, mark.hotFg, mark.bgRgb, color, true);
  if (after) out += paint(after, mark.fgRgb, mark.bgRgb, color);
  return out;
};

const layoutButtons = (width, compact, hidden, extra, disabled) => {
  const hiddenIds = hidden ?? [];
  const extraIds = extra ?? [];
  const disabledIds = disabled ?? [];
  const ids = [];
  for (const id of ACTION_IDS) {
    if (id === 'quit') {
      for (const add of extraIds) {
        if (!hiddenIds.includes(add)) ids.push(add);
      }
    }
    if (hiddenIds.includes(id)) continue;
    ids.push(id);
  }
  const build = (short) => {
    const hits = [];
    const parts = [];
    let x = 0;
    for (const id of ids) {
      const letter = actionLetter(id);
      const word = buttonWord(id);
      const label = short ? letter : word;
      const piece = `${BUTTON_GAP}${label}`;
      const w = visibleWidth(piece);
      if (x + w > width && parts.length) break;
      const off = disabledIds.includes(id);
      if (!off) hits.push({ id, x0: x, x1: x + w });
      parts.push({ action: { id }, piece, letter, label, disabled: off });
      x += w;
    }
    return { hits, parts, width: x };
  };
  if (compact) return build(true);
  const words = build(false);
  if (words.parts.length === ids.length) return words;
  return build(true);
};

const paintButtons = (layout, width, color) => {
  let out = '';
  let used = 0;
  const fgRgb = THEME.buttonFg;
  const bgRgb = THEME.buttonBg;
  for (const part of layout.parts) {
    out += paint(BUTTON_GAP, fgRgb, bgRgb, color);
    if (part.disabled) out += paint(part.label, fgRgb, bgRgb, color);
    else out += paintMarkedWord(part.label, part.letter, color, BUTTON_MARK);
    used += visibleWidth(part.piece);
  }
  if (used < width) {
    out += fill(width - used, THEME.buttonFg, THEME.buttonBg, color);
  }
  return out;
};

const remoteCounts = (kind, { counts, notes, sourceLabel }) => {
  const n = counts.pr ?? 0;
  const label = sourceLabel || kind;
  return ` ${kind} ${label}  ${n}  ${notes}`;
};

const COUNTS_KIND = {
  pr: (args) => remoteCounts('pr', args),
  mr: (args) => remoteCounts('mr', args),
  commit: ({ counts, notes, revShort }) => {
    const n = counts.commit ?? 0;
    return ` commit ${revShort}  ${n}  ${notes}`;
  },
  worktree: ({ counts, notes, branch }) => {
    const staged = counts.staged ?? 0;
    const unstaged = counts.unstaged ?? 0;
    const untracked = counts.untracked ?? 0;
    const gitCounts = `unstaged ${unstaged}  untracked ${untracked}`;
    const git = `staged ${staged}  ${gitCounts}`;
    const mark = branchLabel(branch);
    if (mark) return ` ${mark}  ${git}  ${notes}`;
    return ` ${git}  ${notes}`;
  },
};

const countsKind = (sourceKind, revShort) => {
  if (sourceKind === 'pr' || sourceKind === 'mr') return sourceKind;
  if (revShort) return 'commit';
  return 'worktree';
};

const countsLine = (counts, revShort, sourceKind, sourceLabel, branch) => {
  const feedback = counts.feedback ?? 0;
  const todo = counts.todo ?? 0;
  const code = counts.code ?? 0;
  const notes = `feedback ${feedback}  todo ${todo}  code ${code}`;
  const kind = countsKind(sourceKind, revShort);
  return COUNTS_KIND[kind]({ counts, notes, sourceLabel, revShort, branch });
};

const choiceHits = (choices, prefix, y) => {
  const hits = [];
  let x = visibleWidth(prefix);
  for (const choice of choices) {
    const piece = `${choice.lead}${choice.label}`;
    const w = visibleWidth(piece);
    hits.push({ id: choice.letter, y, x0: x, x1: x + w });
    x += w;
  }
  return hits;
};

const paintChoicePrompt = (choices, width, color, prefix = '') => {
  const bgRgb = THEME.chromeBg;
  const labels = choices
    .map((choice) => `${choice.lead}${choice.label}`)
    .join('');
  const body = `${prefix}${labels}`;
  if (!color) {
    const pad = Math.max(0, width - visibleWidth(body));
    return body + ' '.repeat(pad);
  }
  let out = '';
  if (prefix) out += paint(prefix, THEME.mutedFg, bgRgb, color);
  for (const choice of choices) {
    const label = `${choice.lead}${choice.label}`;
    out += paintMarkedWord(label, choice.letter, color, QUIT_MARK);
  }
  const pad = Math.max(0, width - visibleWidth(body));
  return out + fill(pad, THEME.mutedFg, bgRgb, color);
};

const isInfoStatus = (status) => {
  if (INFO_STATUS.includes(status)) return true;
  for (const prefix of INFO_PREFIX) {
    if (status.startsWith(prefix)) return true;
  }
  return false;
};

const paintStatusLeft = (text, color) => {
  const bgRgb = THEME.chromeBg;
  const muted = THEME.mutedFg;
  if (!color) return text;
  const open = text.indexOf('[');
  const close = text.indexOf(']');
  if (open < 0 || close <= open) return paint(text, muted, bgRgb, color);
  const before = text.slice(0, open);
  const name = text.slice(open + 1, close);
  const after = text.slice(close + 1);
  const label = `[${name}]`;
  return (
    paint(before, muted, bgRgb, color) +
    paintBracketName(label, THEME.buttonHotFg, muted, bgRgb, color) +
    paint(after, muted, bgRgb, color)
  );
};

const paintStatusLine = (view, status, width, color) => {
  const { mode, counts, revShort, sourceKind, sourceLabel } = view;
  const confirm = CONFIRM[mode];
  if (confirm) {
    const prefix = confirmPrefix(confirm, view);
    return paintChoicePrompt(confirm.choices, width, color, prefix);
  }
  const branch = view.branch ?? '';
  const left = countsLine(
    counts ?? {},
    revShort,
    sourceKind,
    sourceLabel,
    branch,
  );
  const shown = formatBusyStatus(status, view.progressFrame ?? 0);
  let right = '';
  let msgFg = THEME.chromeFg;
  if (shown) {
    right = ` ${shown} `;
    if (!isInfoStatus(status)) msgFg = THEME.errorFg;
  }
  const rightW = visibleWidth(right);
  const room = Math.max(0, width - rightW);
  const clipped = truncateVisible(left, room);
  const pad = Math.max(0, width - visibleWidth(clipped) - rightW);
  const gap = ' '.repeat(pad);
  const paintedRight = paint(right, msgFg, THEME.chromeBg, color);
  return (
    paintStatusLeft(clipped, color) +
    paint(gap, THEME.mutedFg, THEME.chromeBg, color) +
    paintedRight
  );
};

const statusChoiceHits = (view, y) => {
  const spec = CONFIRM[view.mode];
  if (!spec) return [];
  const prefix = confirmPrefix(spec, view);
  return choiceHits(spec.choices, prefix, y);
};

const statusBranchHit = (view, width, y) => {
  const mode = view.mode;
  if (CONFIRM[mode]) return null;
  const branch = view.branch ?? '';
  if (!branchLabel(branch)) return null;
  if (countsKind(view.sourceKind, view.revShort) !== 'worktree') return null;
  const left = countsLine(
    view.counts ?? {},
    view.revShort,
    view.sourceKind,
    view.sourceLabel,
    branch,
  );
  const status = view.status ?? '';
  const shown = formatBusyStatus(status, view.progressFrame ?? 0);
  const right = shown ? ` ${shown} ` : '';
  const room = Math.max(0, width - visibleWidth(right));
  const clipped = truncateVisible(left, room);
  const open = clipped.indexOf('[');
  const close = clipped.indexOf(']');
  if (open < 0 || close <= open) return null;
  return { id: 'branch', y, x0: open, x1: close + 1 };
};

const hiddenActions = (view) => {
  const pane = view.pane ?? 'diff';
  if (pane === 'files') return FILES_DISABLED;
  if (pane === 'branches') return BRANCHES_DISABLED;
  if (view.item && view.item.origin === 'todo') return TODO_DISABLED;
  return DIFF_DISABLED;
};

const dimFooterActions = (view) => {
  const pane = view.pane ?? 'diff';
  if (pane === 'files') {
    const files = view.files ?? [];
    const entry = files[view.fileCursor ?? 0];
    if (!entry || entry.kind !== 'todos') return [];
    return FILES_GIT_DISABLED;
  }
  if (pane === 'diff') return diffGitDisabled(view.item);
  if (pane === 'branches') {
    const branches = view.branches ?? [];
    const entry = branches[view.branchCursor ?? 0];
    return branchGitDisabled(entry);
  }
  return [];
};

const extraFooterActions = (view) => {
  if ((view.pane ?? 'diff') === 'branches') return Object.keys(BRANCH_ACTIONS);
  return [];
};

module.exports = {
  QUIT_PROMPT,
  COMMIT_PROMPT,
  PUSH_PROMPT,
  updatePrompt,
  dropPrompt,
  formatBusyStatus,
  headerText,
  paintHeader,
  layoutButtons,
  paintButtons,
  paintStatusLine,
  statusChoiceHits,
  statusBranchHit,
  hiddenActions,
  dimFooterActions,
  extraFooterActions,
};
