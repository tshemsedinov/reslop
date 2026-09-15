'use strict';

const ansi = require('./ansi.js');
const { displayLines } = require('./diff.js');
const highlight = require('./highlight.js');
const { detectLang } = require('./detect.js');
const keys = require('./keys.js');
const { overlayRows } = require('./select.js');
const files = require('./files.js');
const { itemPath, TODO_FILE, isTodosEntry, REPO_TODOS_LABEL } = files;
const wrap = require('./wrap.js');

const { tokenize, overlayTokens } = highlight;
const { ACTION_IDS, BRANCH_ACTIONS, actionLetter, buttonWord } = keys;
const { FILES_DISABLED, FILES_GIT_DISABLED, BRANCHES_DISABLED } = keys;
const { TODO_DISABLED, DIFF_DISABLED, diffGitDisabled } = keys;
const { branchGitDisabled } = keys;
const { wrapPlain, wrapMultiline, cursorInWrap } = wrap;
const { THEME, CODE_FG, codeFg, paint, visibleWidth } = ansi;
const { truncateVisible, fg, RESET, ESC, EL, seq, BOLD } = ansi;

const STYLES = {
  del: {
    baseFg: THEME.delLineFg,
    baseBg: THEME.delLineBg,
    chFg: THEME.delCharFg,
    chBg: THEME.delCharBg,
    mark: '-',
  },
  add: {
    baseFg: THEME.addLineFg,
    baseBg: THEME.addLineBg,
    chFg: THEME.addCharFg,
    chBg: THEME.addCharBg,
    mark: '+',
  },
  warn: {
    baseFg: THEME.delLineFg,
    baseBg: THEME.delLineBg,
    chFg: THEME.delCharFg,
    chBg: THEME.delCharBg,
    mark: ' ',
  },
  note: {
    baseFg: THEME.chromeFg,
    baseBg: THEME.noteBg,
    chFg: THEME.chromeFg,
    chBg: THEME.noteBg,
    mark: ' ',
  },
  noteSep: {
    baseFg: THEME.mutedFg,
    baseBg: THEME.chromeBg,
    chFg: THEME.mutedFg,
    chBg: THEME.chromeBg,
    mark: ' ',
  },
  ctx: {
    baseFg: THEME.ctxFg,
    baseBg: THEME.ctxBg,
    chFg: THEME.ctxFg,
    chBg: THEME.ctxBg,
    mark: ' ',
  },
};

const STAGED_STYLES = {
  del: {
    baseFg: THEME.stagedDelLineFg,
    baseBg: THEME.stagedDelLineBg,
    chFg: THEME.stagedDelCharFg,
    chBg: THEME.stagedDelCharBg,
    mark: '-',
  },
  add: {
    baseFg: THEME.stagedAddLineFg,
    baseBg: THEME.stagedAddLineBg,
    chFg: THEME.stagedAddCharFg,
    chBg: THEME.stagedAddCharBg,
    mark: '+',
  },
  warn: {
    baseFg: THEME.stagedDelLineFg,
    baseBg: THEME.stagedDelLineBg,
    chFg: THEME.stagedDelCharFg,
    chBg: THEME.stagedDelCharBg,
    mark: ' ',
  },
  note: STYLES.note,
  noteSep: STYLES.noteSep,
  ctx: STYLES.ctx,
};

const HEADER_ROLE_FG = {
  repo: THEME.headerRepoFg,
  dir: THEME.headerDirFg,
  slash: THEME.headerSlashFg,
  file: THEME.headerFileFg,
  meta: THEME.headerMetaFg,
};

const FILE_STATUS_FG = {
  unstaged: THEME.delLineFg,
  staged: THEME.addLineFg,
  untracked: THEME.mutedFg,
  partial: THEME.warnFg,
};

const FILE_COL_KEYS = ['add', 'del', 'status', 'n', 'm'];

const FILE_COL_ALIGN = {
  add: 'start',
  del: 'start',
  status: 'start',
  n: 'start',
  m: 'end',
};

const BRANCH_COL_KEYS = ['sha', 'ahead', 'behind', 'gone', 'date'];

const BRANCH_COL_ALIGN = {
  sha: 'end',
  ahead: 'start',
  behind: 'start',
  gone: 'end',
  date: 'end',
};

const BRANCH_COL_FG = {
  sha: THEME.mutedFg,
  ahead: THEME.addLineFg,
  behind: THEME.delLineFg,
  gone: THEME.delLineFg,
  date: THEME.mutedFg,
};

const BRANCH_NAME_MAX = 24;

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

const QUIT_CHOICES = [
  { letter: 'f', label: 'finish as ready', lead: ' ' },
  { letter: 'c', label: 'continue next time', lead: '  ' },
];
const QUIT_PROMPT = QUIT_CHOICES.map(
  (choice) => `${choice.lead}${choice.label}`,
).join('');
const COMMIT_CHOICES = [
  { letter: 'c', label: 'commit', lead: ' ' },
  { letter: 'a', label: 'amend', lead: '  ' },
  { letter: 'f', label: 'fixup', lead: '  ' },
];
const COMMIT_PROMPT = COMMIT_CHOICES.map(
  (choice) => `${choice.lead}${choice.label}`,
).join('');
const UPDATE_CHOICES = [
  { letter: 'y', label: 'y', lead: ' ' },
  { letter: 'n', label: 'n', lead: '  ' },
];
const updatePrompt = (from, to) => ` update reslop ${from} → ${to}? y  n`;
const dropPrompt = (name) => ` drop ${name}? y  n`;
const PUSH_CHOICES = [{ letter: 'f', label: 'force push', lead: ' ' }];
const PUSH_REJECT_PREFIX = ' Need force-push?';
const PUSH_PROMPT = `${PUSH_REJECT_PREFIX} force push`;

const NOTE_COMPOSE = ['feedback', 'commit'];
const LIST_PANES = ['files', 'branches'];
const GUTTER_W = 2;
const BUTTON_GAP = '  ';
const LOGO = '👁️';
const FILE_MARK = '▶';
const FILE_LIST_PAD = 1;
const CHECK_DONE = 'xX';
const INPUT_MAX = 4;
const NOTE_MAX = 4;
const NOTE_PAD = 1;
const SOFT_WRAP = ['warn', 'note'];
const DEL_CHAR_BG = ansi.bg(THEME.delCharBg);
const ADD_CHAR_BG = ansi.bg(THEME.addCharBg);

const lineStyles = (origin) => (origin === 'staged' ? STAGED_STYLES : STYLES);

const fill = (width, fgRgb, bgRgb, color) =>
  paint(' '.repeat(Math.max(0, width)), fgRgb, bgRgb, color);

const paintSpans = (pieces, lineStyle, budget, color) => {
  let out = '';
  let used = 0;
  for (const piece of pieces) {
    if (used >= budget) break;
    const room = budget - used;
    const text = truncateVisible(piece.text, room);
    const w = visibleWidth(text);
    if (w <= 0) continue;
    const fgRgb = codeFg(piece.style);
    const bgRgb = piece.changed ? lineStyle.chBg : lineStyle.baseBg;
    out += paint(text, fgRgb, bgRgb, color);
    used += w;
  }
  if (used < budget) {
    out += fill(budget - used, CODE_FG.plain, lineStyle.baseBg, color);
  }
  return { text: out, used };
};

const paintAuditNote = (line, width, color) => {
  const style = STYLES.note;
  const gutterW = Math.min(GUTTER_W, Math.max(0, width));
  const label = `${style.mark} `.slice(0, gutterW);
  const gutter = paint(label, style.baseFg, style.baseBg, color);
  const budget = Math.max(0, width - gutterW);
  const text = truncateVisible(line.text ?? '', budget);
  const used = visibleWidth(text);
  let out = gutter;
  if (text) out += paint(text, style.baseFg, style.baseBg, color);
  if (used < budget) {
    out += fill(budget - used, style.baseFg, style.baseBg, color);
  }
  return out;
};

const paintAuditRule = (width, color) => {
  const style = STYLES.noteSep;
  const n = Math.max(0, width);
  const bar = '─'.repeat(n);
  return paint(bar, style.baseFg, style.baseBg, color);
};

const paintDiffLine = (line, width, color, origin, lang) => {
  if (line.type === 'noteSep') return paintAuditRule(width, color);
  if (line.type === 'note') return paintAuditNote(line, width, color);
  const styles = lineStyles(origin);
  const style = styles[line.type] ?? styles.ctx;
  const diffSpans = line.spans ?? [{ text: line.text, changed: false }];
  const tokens = tokenize(lang, line.text ?? '');
  const pieces = overlayTokens(tokens, diffSpans);
  const gutterW = Math.min(GUTTER_W, Math.max(0, width));
  const label = `${style.mark} `.slice(0, gutterW);
  const gutter = paint(label, CODE_FG.punct, style.baseBg, color);
  const budget = Math.max(0, width - gutterW);
  const rest = paintSpans(pieces, style, budget, color);
  return gutter + rest.text;
};

const splitWidths = (width) => {
  const inner = Math.max(0, width - 1);
  const leftW = Math.floor(inner / 2);
  return { leftW, rightW: inner - leftW };
};

const paintSplitRule = (color) =>
  fill(1, THEME.splitGutterFg, THEME.splitGutterBg, color);

const paintSplitHalf = (line, width, color, origin, lang) => {
  if (!line || width <= 0) {
    return fill(width, THEME.ctxFg, THEME.ctxBg, color);
  }
  return paintDiffLine(line, width, color, origin, lang);
};

const paintSplitRow = (row, width, color, origin, lang) => {
  const { leftW, rightW } = splitWidths(width);
  const left = paintSplitHalf(row.left, leftW, color, origin, lang);
  const right = paintSplitHalf(row.right, rightW, color, origin, lang);
  return `${left}${paintSplitRule(color)}${right}`;
};

const paintSplitBlank = (width, color) => {
  const { leftW, rightW } = splitWidths(width);
  return (
    fill(leftW, THEME.ctxFg, THEME.ctxBg, color) +
    paintSplitRule(color) +
    fill(rightW, THEME.ctxFg, THEME.ctxBg, color)
  );
};

const paintBodyFill = (width, color, kind) => {
  if (kind === 'files') {
    const inner = Math.max(1, width - 1);
    const main = fill(inner, THEME.ctxFg, THEME.ctxBg, color);
    const edge = fill(1, THEME.ctxFg, THEME.ctxBg, color);
    return main + edge;
  }
  if (kind === 'split') return paintSplitBlank(width, color);
  return fill(width, THEME.ctxFg, THEME.ctxBg, color);
};

const paintBar = (text, width, fgRgb, bgRgb, color) => {
  const clipped = truncateVisible(text, width);
  const pad = Math.max(0, width - visibleWidth(clipped));
  const filled = clipped + ' '.repeat(pad);
  if (!color) return filled;
  return `${seq(fgRgb, bgRgb)}${EL}${filled}${RESET}`;
};

const CHECK_TOKEN = /\[([ xX])\]/;
const CHECK_LEAD = /^\[[ xX]\] /;

const splitCheck = (text) => {
  const match = CHECK_TOKEN.exec(text);
  if (!match) return null;
  const start = match.index;
  const token = match[0];
  const before = text.slice(0, start);
  const mark = match[1];
  const after = text.slice(start + token.length);
  return { before, mark, token, after };
};

const paintCheckBar = (text, width, fgRgb, bgRgb, color) => {
  const clipped = truncateVisible(text, width);
  const parts = color ? splitCheck(clipped) : null;
  if (!parts) return paintBar(text, width, fgRgb, bgRgb, color);
  const pad = Math.max(0, width - visibleWidth(clipped));
  const done = CHECK_DONE.includes(parts.mark);
  const chipFg = done ? THEME.checkDoneFg : THEME.checkFg;
  const chipBg = done ? THEME.checkDoneBg : THEME.checkBg;
  const after = `${parts.after}${' '.repeat(pad)}`;
  let out = `${seq(fgRgb, bgRgb)}${EL}`;
  if (parts.before) out += paint(parts.before, fgRgb, bgRgb, color);
  out += paint(parts.token, chipFg, chipBg, color);
  if (after) out += paint(after, fgRgb, bgRgb, color);
  return out;
};

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

const bodyLines = (item, layout, overlay) => {
  if (item.file.isBinary) {
    const text = '(binary)';
    return [{ type: 'ctx', text, spans: [{ text, changed: false }] }];
  }
  if (!item.hunk) return [];
  const radius = item.dep ? Number.MAX_SAFE_INTEGER : undefined;
  return displayLines(item.hunk, item.blockId, layout, radius, overlay);
};

const sourceEmpty = (line) => {
  if (!line) return true;
  if (line.editStart !== undefined) return false;
  return !(line.text ?? '').trim();
};

const displayRowEmpty = (row, split) => {
  if (!split) return sourceEmpty(row);
  return sourceEmpty(row.left) && sourceEmpty(row.right);
};

const dropLeadingEmpty = (lines, split) => {
  let i = 0;
  while (i < lines.length && displayRowEmpty(lines[i], split)) {
    i += 1;
  }
  return i ? lines.slice(i) : lines;
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

const layoutButtons = (
  width,
  compact = false,
  hidden = [],
  extra = [],
  disabled = [],
) => {
  const ids = [];
  for (const id of ACTION_IDS) {
    if (id === 'quit') {
      for (const add of extra) {
        if (!hidden.includes(add)) ids.push(add);
      }
    }
    if (hidden.includes(id)) continue;
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
      const off = disabled.includes(id);
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

const branchLabel = (name) => {
  const branch = `${name ?? ''}`.trim();
  if (!branch) return '';
  return `[${branch}]`;
};

const branchNameChip = (entry, rowBg) => {
  if (entry.current) {
    return {
      nameFg: THEME.headerFg,
      wrapFg: THEME.mutedFg,
      nameBg: THEME.buttonHotFg,
    };
  }
  if (entry.isDefault) {
    return {
      nameFg: THEME.checkDoneFg,
      wrapFg: THEME.mutedFg,
      nameBg: THEME.checkDoneBg,
    };
  }
  return {
    nameFg: THEME.buttonHotFg,
    wrapFg: THEME.mutedFg,
    nameBg: rowBg,
  };
};

const splitBracketName = (label) => {
  const text = `${label ?? ''}`;
  const open = text.startsWith('[') ? '[' : '';
  const rest = open ? text.slice(1) : text;
  const close = rest.endsWith(']') ? ']' : '';
  const name = close ? rest.slice(0, -1) : rest;
  return { open, name, close };
};

const paintBracketName = (label, nameFg, wrapFg, bgRgb, color) => {
  const { open, name, close } = splitBracketName(label);
  return (
    paint(open, wrapFg, bgRgb, color, true) +
    paint(name, nameFg, bgRgb, color) +
    paint(close, wrapFg, bgRgb, color, true)
  );
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
  if (mode === 'confirmQuit') {
    return paintChoicePrompt(QUIT_CHOICES, width, color);
  }
  if (mode === 'confirmCommit') {
    return paintChoicePrompt(COMMIT_CHOICES, width, color);
  }
  if (mode === 'confirmUpdate') {
    const from = view.updateFrom ?? '';
    const to = view.updateTo ?? '';
    const prefix = ` update reslop ${from} → ${to}?`;
    return paintChoicePrompt(UPDATE_CHOICES, width, color, prefix);
  }
  if (mode === 'confirmDrop') {
    const name = view.dropName ?? '';
    const prefix = ` drop ${name}?`;
    return paintChoicePrompt(UPDATE_CHOICES, width, color, prefix);
  }
  if (mode === 'confirmPush') {
    return paintChoicePrompt(PUSH_CHOICES, width, color, PUSH_REJECT_PREFIX);
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

const statusBranchHit = (view, width, y) => {
  const mode = view.mode;
  if (mode === 'confirmQuit') return null;
  if (mode === 'confirmCommit') return null;
  if (mode === 'confirmUpdate') return null;
  if (mode === 'confirmDrop') return null;
  if (mode === 'confirmPush') return null;
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

const signedCount = (sign, n) => `${sign}${n ?? 0}`;

const fileRowFields = (entry) => {
  if (isTodosEntry(entry)) {
    const n = `${entry.staged ?? 0}`;
    const m = `${entry.remaining ?? 0}`;
    return { add: '', del: '', status: '', n, m };
  }
  const { added, removed, staged, remaining } = entry;
  const add = signedCount('+', added);
  const del = signedCount('-', removed);
  const status = entry.status ?? '';
  const n = `${staged ?? 0}`;
  const m = `${remaining ?? 0}`;
  return { add, del, status, n, m };
};

const fileColumns = (files) => {
  const widths = {};
  for (const key of FILE_COL_KEYS) widths[key] = 0;
  for (const entry of files) {
    const fields = fileRowFields(entry);
    for (const key of FILE_COL_KEYS) {
      const w = visibleWidth(fields[key]);
      if (w > widths[key]) widths[key] = w;
    }
  }
  return widths;
};

const padVisible = (text, width, align) => {
  const n = Math.max(0, width - visibleWidth(text));
  const gap = ' '.repeat(n);
  if (align === 'end') return `${text}${gap}`;
  return `${gap}${text}`;
};

const fileRowFg = (status, selected) => {
  const statusFg = FILE_STATUS_FG[status];
  if (statusFg) return statusFg;
  if (selected) return THEME.chromeFg;
  return THEME.mutedFg;
};

const fileRowParts = (entry, cols) => {
  const fields = fileRowFields(entry);
  const parts = {};
  for (const key of FILE_COL_KEYS) {
    const width = cols?.[key] ?? visibleWidth(fields[key]);
    const align = FILE_COL_ALIGN[key];
    parts[key] = padVisible(fields[key], width, align);
  }
  return parts;
};

const joinFileSuffix = (parts) => {
  const { add, del, status, n, m } = parts;
  return `  ${add}  ${del}  ${status}  ${n}/${m}`;
};

const paintFileSuffix = (parts, fgRgb, bgRgb, color) => {
  const { add, del, status, n, m } = parts;
  const gap = paint('  ', fgRgb, bgRgb, color);
  const addText = paint(add, THEME.addLineFg, bgRgb, color);
  const delText = paint(del, THEME.delLineFg, bgRgb, color);
  const statusText = paint(status, fgRgb, bgRgb, color);
  const nText = paint(n, fgRgb, bgRgb, color);
  const slash = paint('/', fgRgb, bgRgb, color);
  const mText = paint(m, fgRgb, bgRgb, color);
  const counts = addText + gap + delText;
  const meta = statusText + gap + nText + slash + mText;
  return gap + counts + gap + meta;
};

const paintTodosRow = (entry, width, color, selected, cols) => {
  const inner = Math.max(1, width - 1);
  const mark = selected ? FILE_MARK : ' ';
  const prefix = ` ${mark} `;
  const parts = fileRowParts(entry, cols);
  const suffix = joinFileSuffix(parts);
  const pathW = Math.max(1, inner - visibleWidth(prefix + suffix));
  const clipped = truncateVisible(entry.path, pathW);
  const pad = Math.max(0, pathW - visibleWidth(clipped));
  const left = `${prefix}${clipped}${' '.repeat(pad)}`;
  const fgRgb = THEME.buttonHotFg;
  const bgRgb = selected ? THEME.buttonBg : THEME.ctxBg;
  const edge = fill(1, fgRgb, bgRgb, color);
  if (!color) return `${left}${suffix}${edge}`;
  let out = `${seq(fgRgb, bgRgb)}${EL}`;
  out += paint(left, fgRgb, bgRgb, color, true);
  out += paint(suffix, fgRgb, bgRgb, color, true);
  return out + edge;
};

const paintFileRow = (entry, width, color, selected, cols) => {
  if (isTodosEntry(entry)) {
    return paintTodosRow(entry, width, color, selected, cols);
  }
  const inner = Math.max(1, width - 1);
  const mark = selected ? FILE_MARK : ' ';
  const prefix = ` ${mark} `;
  const parts = fileRowParts(entry, cols);
  const suffix = joinFileSuffix(parts);
  const pathW = Math.max(1, inner - visibleWidth(prefix + suffix));
  const { path, status } = entry;
  const clipped = truncateVisible(path, pathW);
  const pad = Math.max(0, pathW - visibleWidth(clipped));
  const left = `${prefix}${clipped}${' '.repeat(pad)}`;
  const fgRgb = fileRowFg(status, selected);
  const bgRgb = selected ? THEME.buttonBg : THEME.ctxBg;
  const edge = fill(1, fgRgb, bgRgb, color);
  if (!color) return `${left}${suffix}${edge}`;
  let out = `${seq(fgRgb, bgRgb)}${EL}`;
  out += paint(left, fgRgb, bgRgb, color);
  out += paintFileSuffix(parts, fgRgb, bgRgb, color);
  return out + edge;
};

const todoInnerWidth = (width) => Math.max(1, width - 2);

const codeInnerWidth = (width, layout = 'unified') => {
  const lineW = layout === 'side' ? splitWidths(width).rightW : width;
  const gutterW = Math.min(GUTTER_W, Math.max(0, lineW));
  return Math.max(1, lineW - gutterW);
};

const checkLeadLen = (text) => {
  const match = CHECK_LEAD.exec(text);
  return match ? match[0].length : 0;
};

const paintTodoList = (texts, focus, width, color, edit) => {
  const inner = todoInnerWidth(width);
  const rows = [];
  const owners = [];
  let cursor = null;
  for (let i = 0; i < texts.length; i++) {
    const selected = i === focus;
    const fgRgb = selected ? THEME.chromeFg : THEME.mutedFg;
    const bgRgb = selected ? THEME.buttonBg : THEME.ctxBg;
    const text = texts[i];
    const wrapped = wrapMultiline(text, inner);
    const rowStart = rows.length;
    for (const line of wrapped) {
      rows.push(paintCheckBar(` ${line}`, width, fgRgb, bgRgb, color));
      owners.push(i);
    }
    if (!edit || !selected) continue;
    const lead = checkLeadLen(text);
    const pos = cursorInWrap(text, lead + (edit.cursor ?? 0), inner);
    cursor = { x: pos.col + 2, row: rowStart + pos.row };
  }
  return { rows, owners, cursor };
};

const windowRows = (rows, focus, cap) => {
  if (rows.length <= cap) return { rows, offset: 0 };
  let start = focus - cap + 1;
  if (start < 0) start = 0;
  if (start + cap > rows.length) start = rows.length - cap;
  return { rows: rows.slice(start, start + cap), offset: start };
};

const noteInnerWidth = (width) => Math.max(1, width - NOTE_PAD * 2);

const paintNoteLine = (text, width, fgRgb, bgRgb, color, withCheck) => {
  const inner = noteInnerWidth(width);
  const clipped = truncateVisible(text, inner);
  const line = `${' '.repeat(NOTE_PAD)}${clipped}`;
  if (withCheck) return paintCheckBar(line, width, fgRgb, bgRgb, color);
  return paintBar(line, width, fgRgb, bgRgb, color);
};

const paintTemplateRow = (text, selected, width, color) => {
  const fgRgb = selected ? THEME.chromeFg : THEME.mutedFg;
  const bgRgb = selected ? THEME.buttonBg : THEME.noteBg;
  return paintNoteLine(text, width, fgRgb, bgRgb, color);
};

const paintComposeNote = (view, width, color, cap) => {
  const inner = noteInnerWidth(width);
  const bgRgb = THEME.noteBg;
  const compose = view.compose;
  const wrapped = wrapMultiline(compose.text, inner);
  const { row, col } = cursorInWrap(compose.text, compose.cursor ?? 0, inner);
  const shown = windowRows(wrapped, row, INPUT_MAX);
  const rows = [];
  const templateHits = [];
  if (compose.kind === 'feedback') {
    const all = view.templates ?? [];
    const room =
      cap === undefined ? all.length : Math.max(0, cap - shown.rows.length);
    const n = Math.min(all.length, room);
    const focus = view.templateIndex ?? -1;
    for (let i = 0; i < n; i++) {
      const text = all[i].text ?? '';
      const selected = i === focus;
      rows.push(paintTemplateRow(text, selected, width, color));
      templateHits.push({ row: i, cursor: i });
    }
  }
  const templateCount = rows.length;
  for (const line of shown.rows) {
    rows.push(paintNoteLine(line, width, THEME.chromeFg, bgRgb, color));
  }
  return {
    rows,
    cursor: {
      x: NOTE_PAD + col + 1,
      row: templateCount + row - shown.offset,
    },
    templateHits,
  };
};

const paintIdleNote = (view, width, color) => {
  const empty = { rows: [], cursor: null, templateHits: [] };
  const text = view.noteText;
  if (!text) return empty;
  const inner = noteInnerWidth(width);
  const wrapped = wrapMultiline(`feedback: ${text}`, inner);
  const rows = [];
  for (const line of wrapped.slice(0, NOTE_MAX)) {
    const painted = paintNoteLine(
      line,
      width,
      THEME.chromeFg,
      THEME.noteBg,
      color,
      true,
    );
    rows.push(painted);
  }
  return { rows, cursor: null, templateHits: [] };
};

const paintNotePanel = (view, width, color, cap) => {
  const empty = { rows: [], cursor: null, templateHits: [] };
  const compose = view.compose;
  if (compose && NOTE_COMPOSE.includes(compose.kind)) {
    return paintComposeNote(view, width, color, cap);
  }
  const pane = view.pane ?? 'diff';
  if (LIST_PANES.includes(pane)) return empty;
  return paintIdleNote(view, width, color);
};

const paintCursorList = (
  items,
  cursor,
  width,
  color,
  bodyH,
  headerLines,
  paintRow,
  tail,
) => {
  const pad = bodyH >= FILE_LIST_PAD * 2 + 1 ? FILE_LIST_PAD : 0;
  const listH = bodyH - pad * 2;
  const extra = tail ? 1 : 0;
  const last = items.length + extra - 1;
  const focus = extra ? last : cursor;
  const start = focus >= listH ? focus - listH + 1 : 0;
  const blank = paintBodyFill(width, color, 'files');
  const body = [];
  const fileHits = [];
  let textCursor = null;
  if (pad) body.push(blank);
  for (let i = 0; i < listH; i++) {
    const idx = start + i;
    if (tail && idx === items.length) {
      body.push(tail.row);
      if (tail.cursor) {
        textCursor = { x: tail.cursor.x, row: body.length - 1 };
      }
      continue;
    }
    const entry = items[idx];
    if (!entry) break;
    const selected = extra ? false : idx === cursor;
    body.push(paintRow(entry, width, color, selected));
    const y = headerLines + pad + i + 1;
    fileHits.push({ y, cursor: idx });
  }
  if (pad) body.push(blank);
  return { body, fileHits, cursor: textCursor };
};

const paintBodyFiles = (view, width, color, bodyH, headerLines) => {
  const files = view.files ?? [];
  const cols = fileColumns(files);
  const cursor = view.fileCursor ?? 0;
  const paintRow = (entry, rowWidth, rowColor, selected) =>
    paintFileRow(entry, rowWidth, rowColor, selected, cols);
  return paintCursorList(
    files,
    cursor,
    width,
    color,
    bodyH,
    headerLines,
    paintRow,
  );
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
    bits.push(parts[key]);
  }
  if (!bits.length) return '';
  return `  ${bits.join('  ')}`;
};

const paintBranchSuffix = (parts, cols, fgRgb, bgRgb, color) => {
  const gap = paint('  ', fgRgb, bgRgb, color);
  const bits = [];
  for (const key of BRANCH_COL_KEYS) {
    if (!cols[key]) continue;
    const tone = BRANCH_COL_FG[key] ?? fgRgb;
    bits.push(paint(parts[key], tone, bgRgb, color));
  }
  if (!bits.length) return '';
  return gap + bits.join(gap);
};

const paintBranchRow = (entry, width, color, selected, cols) => {
  const inner = Math.max(1, width - 1);
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
  const edge = fill(1, fgRgb, bgRgb, color);
  if (!color) return `${left}${suffix}${edge}`;
  let out = `${seq(fgRgb, bgRgb)}${EL}`;
  out += paint(prefix, fgRgb, bgRgb, color);
  out += paintBracketName(label, chip.nameFg, chip.wrapFg, chip.nameBg, color);
  out += paint(after, fgRgb, bgRgb, color);
  out += paintBranchSuffix(parts, cols, fgRgb, bgRgb, color);
  return out + edge;
};

const paintBranchEdit = (compose, width, color) => {
  const inner = Math.max(1, width - 1);
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
  const edge = fill(1, fgRgb, bgRgb, color);
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
  return paintCursorList(
    branches,
    cursor,
    width,
    color,
    bodyH,
    headerLines,
    paintRow,
    tail,
  );
};

const paintTodoCaption = (width, color) => {
  const text = ` ${REPO_TODOS_LABEL}`;
  const clipped = truncateVisible(text, width);
  const pad = Math.max(0, width - visibleWidth(clipped));
  const filled = clipped + ' '.repeat(pad);
  if (!color) return filled;
  const fgRgb = THEME.buttonHotFg;
  const bgRgb = THEME.ctxBg;
  return `${BOLD}${seq(fgRgb, bgRgb)}${EL}${filled}${RESET}`;
};

const paintBodyTodo = (view, width, color) => {
  const texts = view.todos ?? [];
  let lines = texts;
  if (!lines.length && view.noteText) lines = [view.noteText];
  const painted = paintTodoList(
    lines,
    view.todoFocus ?? 0,
    width,
    color,
    view.todoEdit,
  );
  const caption = paintTodoCaption(width, color);
  const body = [caption, ...painted.rows];
  const todoOwners = [null, ...painted.owners];
  const cursor = painted.cursor
    ? { x: painted.cursor.x, row: painted.cursor.row + 1 }
    : null;
  return { body, todoOwners, cursor };
};

const wrapSoftLine = (line, width) => {
  const gutterW = Math.min(GUTTER_W, Math.max(0, width));
  const budget = Math.max(1, width - gutterW);
  const rows = wrapPlain(line.text ?? '', budget);
  const changed = line.wrap === true;
  const pieces = [];
  let used = 0;
  for (let i = 0; i < rows.length; i++) {
    const text = rows[i];
    const last = i === rows.length - 1;
    const spans = [{ text, changed }];
    const next = { ...line, text, spans, editLast: last };
    if (line.editStart !== undefined) {
      next.editStart = line.editStart + used;
      if (last) next.editEnd = line.editEnd;
      else next.editEnd = next.editStart + text.length;
    }
    used += text.length;
    pieces.push(next);
  }
  return pieces;
};

const shouldWrap = (line) => {
  if (!line) return false;
  if (SOFT_WRAP.includes(line.type)) return true;
  return line.wrap === true;
};

const expandSoftRows = (lines, width, split) => {
  const { leftW, rightW } = splitWidths(width);
  const out = [];
  for (const row of lines) {
    if (!split) {
      if (!shouldWrap(row)) {
        out.push(row);
        continue;
      }
      for (const part of wrapSoftLine(row, width)) out.push(part);
      continue;
    }
    const right = row.right;
    if (shouldWrap(right)) {
      const parts = wrapSoftLine(right, rightW);
      out.push({ left: row.left, right: parts[0] });
      for (let i = 1; i < parts.length; i++) {
        out.push({ left: null, right: parts[i] });
      }
      continue;
    }
    const left = row.left;
    if (shouldWrap(left)) {
      const parts = wrapSoftLine(left, leftW);
      for (const part of parts) out.push({ left: part, right: part });
      continue;
    }
    out.push(row);
  }
  return out;
};

const onCodePiece = (line, cursor) => {
  if (!line || line.editStart === undefined) return false;
  if (cursor < line.editStart) return false;
  if (line.editLast) return cursor <= line.editEnd;
  return cursor < line.editEnd;
};

const codeCursorInRows = (rows, split, width, cursor) => {
  if (cursor === undefined || cursor === null) return null;
  const { leftW, rightW } = splitWidths(width);
  for (let i = 0; i < rows.length; i++) {
    const line = split ? rows[i].right : rows[i];
    if (!onCodePiece(line, cursor)) continue;
    const lineW = split ? rightW : width;
    const gutterW = Math.min(GUTTER_W, Math.max(0, lineW));
    const take = Math.min(cursor - line.editStart, line.text.length);
    const col = visibleWidth(line.text.slice(0, take));
    const x0 = split ? leftW + 1 : 0;
    return { x: x0 + gutterW + col + 1, row: i };
  }
  return null;
};

const paintBodyDiff = (view, width, color) => {
  const item = view.item;
  const layout = view.layout ?? 'unified';
  const overlay = view.codeOverlay;
  const lang = detectLang(itemPath(item));
  const splitBody = layout === 'side' && !item.file.isBinary;
  const raw = dropLeadingEmpty(bodyLines(item, layout, overlay), splitBody);
  const lines = expandSoftRows(raw, width, splitBody);
  const body = [];
  if (splitBody) {
    for (const row of lines) {
      body.push(paintSplitRow(row, width, color, item.origin, lang));
    }
  } else {
    for (const line of lines) {
      body.push(paintDiffLine(line, width, color, item.origin, lang));
    }
  }
  const edit = overlay ? overlay.cursor : null;
  const cursor = codeCursorInRows(lines, splitBody, width, edit);
  return { body, splitBody, cursor };
};

const bodyKind = (view) => {
  const pane = view.pane ?? 'diff';
  if (pane === 'files' || pane === 'branches') return pane;
  if (!view.item) return 'empty';
  if (view.item.origin === 'todo') return 'todo';
  return 'diff';
};

const BODY_PAINT = {
  files: (view, width, color, bodyH, headerLines) => ({
    ...paintBodyFiles(view, width, color, bodyH, headerLines),
    todoOwners: [],
  }),
  branches: (view, width, color, bodyH, headerLines) => ({
    ...paintBodyBranches(view, width, color, bodyH, headerLines),
    todoOwners: [],
  }),
  empty: () => ({ body: [], fileHits: [], todoOwners: [] }),
  todo: (view, width, color) => ({
    ...paintBodyTodo(view, width, color),
    fileHits: [],
  }),
  diff: (view, width, color) => ({
    ...paintBodyDiff(view, width, color),
    fileHits: [],
    todoOwners: [],
  }),
};

const paintFrameBody = (view, width, color, bodyH, headerLines) => {
  const paint = BODY_PAINT[bodyKind(view)];
  return paint(view, width, color, bodyH, headerLines);
};

const frameNotes = (view, width, height, color) => {
  const notesCap = Math.max(0, height - 4);
  const notesWanted = paintNotePanel(view, width, color, notesCap);
  const noteRows = notesWanted.rows.slice(0, notesCap);
  let noteCursor = notesWanted.cursor;
  if (noteCursor && noteCursor.row >= noteRows.length) noteCursor = null;
  const chrome = 3 + noteRows.length;
  const bodyH = Math.max(1, height - chrome);
  return { notesWanted, noteRows, noteCursor, bodyH };
};

const bodyFillKind = (listPane, splitBody) => {
  if (listPane) return 'files';
  if (splitBody) return 'split';
  return 'plain';
};

const mapBodyCursor = (cursor, shift, scroll, headerLines, shown) => {
  if (!cursor) return null;
  const row = cursor.row + shift;
  if (row < scroll || row >= scroll + shown) return null;
  return {
    x: cursor.x,
    y: headerLines + (row - scroll) + 1,
  };
};

const windowBody = (view, width, color, bodyH, headerLines, paintedBody) => {
  const body = paintedBody.body;
  const todoOwners = paintedBody.todoOwners;
  const splitBody = paintedBody.splitBody === true;
  const pane = view.pane ?? 'diff';
  const listPane = LIST_PANES.includes(pane);
  const fillKind = bodyFillKind(listPane, splitBody);
  let shift = 0;
  if (!listPane && body.length > 0) {
    body.unshift(paintBodyFill(width, color, fillKind));
    if (todoOwners.length) todoOwners.unshift(null);
    shift = 1;
  }
  const scrollRaw = view.scroll ?? 0;
  const scrollMax = Math.max(0, body.length - bodyH);
  const scroll = listPane ? 0 : Math.min(scrollRaw, scrollMax);
  const slice = body.slice(scroll, scroll + bodyH);
  const todoHits = [];
  for (let i = 0; i < slice.length; i++) {
    const owner = todoOwners[scroll + i];
    if (owner === undefined || owner === null) continue;
    todoHits.push({ y: headerLines + i + 1, cursor: owner });
  }
  const cursor = mapBodyCursor(
    paintedBody.cursor,
    shift,
    scroll,
    headerLines,
    slice.length,
  );
  while (slice.length < bodyH) {
    slice.push(paintBodyFill(width, color, fillKind));
  }
  return { slice, scroll, todoHits, fileHits: paintedBody.fileHits, cursor };
};

const notePointerHits = (notesWanted, noteRows, noteCursor, bodyH) => {
  const cursor = noteCursor
    ? { x: noteCursor.x, y: 2 + bodyH + noteCursor.row }
    : null;
  const templateHits = [];
  for (const hit of notesWanted.templateHits ?? []) {
    if (hit.row >= noteRows.length) continue;
    templateHits.push({ y: 2 + bodyH + hit.row, cursor: hit.cursor });
  }
  return { cursor, templateHits };
};

const stackFrame = (view, width, color, rows, layout, windowed, notes) => {
  for (const row of windowed.slice) rows.push(row);
  for (const row of notes.noteRows) rows.push(row);
  const status = view.status ?? '';
  rows.push(paintStatusLine(view, status, width, color));
  rows.push(paintButtons(layout, width, color));
  return overlayRows(rows, view.selection);
};

const frameResult = (
  text,
  painted,
  layout,
  windowed,
  hits,
  bodyH,
  statusHits,
) => {
  const fileHits = windowed.fileHits;
  const todoHits = windowed.todoHits;
  const templateHits = hits.templateHits;
  const footerY = painted.length;
  const scroll = windowed.scroll;
  const cursor = hits.cursor ?? windowed.cursor;
  return {
    text,
    rows: painted,
    buttons: layout.hits,
    fileHits,
    todoHits,
    templateHits,
    statusHits,
    footerY,
    height: painted.length,
    scroll,
    cursor,
    bodyH,
  };
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

const renderFrame = (view, options = {}) => {
  const width = Math.max(20, options.width ?? 80);
  const height = Math.max(6, options.height ?? 24);
  const color = options.color ?? true;
  const rows = [paintHeader(view, width, color)];
  const extra = extraFooterActions(view);
  const hidden = hiddenActions(view);
  const dimmed = dimFooterActions(view);
  const layout = layoutButtons(width, false, hidden, extra, dimmed);
  const notes = frameNotes(view, width, height, color);
  const headerLines = rows.length;
  const bodyH = notes.bodyH;
  const paintedBody = paintFrameBody(view, width, color, bodyH, headerLines);
  const windowed = windowBody(
    view,
    width,
    color,
    bodyH,
    headerLines,
    paintedBody,
  );
  const painted = stackFrame(view, width, color, rows, layout, windowed, notes);
  const text = painted.map((row) => (color ? row + RESET : row)).join('\n');
  const hits = notePointerHits(
    notes.notesWanted,
    notes.noteRows,
    notes.noteCursor,
    bodyH,
  );
  const statusY = painted.length - 1;
  const branchHit = statusBranchHit(view, width, statusY);
  const statusHits = branchHit ? [branchHit] : [];
  return frameResult(text, painted, layout, windowed, hits, bodyH, statusHits);
};

const presentCursor = (cursor) => {
  if (!cursor || cursor.x <= 0 || cursor.y <= 0) return `${ESC}[?25l`;
  const pos = `${ESC}[${cursor.y};${cursor.x}H`;
  return `${pos}${ESC}[1 q${ESC}[?12h${ESC}[?25h`;
};

const presentRows = (rows, options = {}) => {
  const clear = options.clear === true;
  const cursor = options.cursor;
  const parts = [`${ESC}[?25l`, `${ESC}[?2026h`];
  if (clear) parts.push(`${ESC}[H${ESC}[2J`);
  for (let i = 0; i < rows.length; i++) {
    parts.push(`${ESC}[${i + 1};1H`);
    parts.push(rows[i]);
  }
  parts.push(`${ESC}[?2026l`);
  parts.push(presentCursor(cursor));
  return parts.join('');
};

module.exports = {
  QUIT_PROMPT,
  COMMIT_PROMPT,
  PUSH_PROMPT,
  updatePrompt,
  dropPrompt,
  DEL_CHAR_BG,
  ADD_CHAR_BG,
  paintDiffLine,
  headerText,
  layoutButtons,
  todoInnerWidth,
  noteInnerWidth,
  codeInnerWidth,
  formatBusyStatus,
  renderFrame,
  presentCursor,
  presentRows,
};
