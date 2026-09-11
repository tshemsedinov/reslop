'use strict';

const ansi = require('./ansi.js');
const { displayLines } = require('./diff.js');
const highlight = require('./highlight.js');
const { detectLang } = require('./detect.js');
const keys = require('./keys.js');
const { overlayRows } = require('./select.js');
const { itemPath } = require('./files.js');
const wrap = require('./wrap.js');

const { tokenize, overlayTokens } = highlight;
const { ACTIONS, ACTION_IDS, actionLetter, buttonWord } = keys;
const { FILES_DISABLED } = keys;
const { wrapPlain, wrapMultiline, cursorInWrap } = wrap;
const { THEME, CODE_FG, codeFg, paint, visibleWidth } = ansi;
const { truncateVisible, fg, RESET, ESC, EL, seq } = ansi;

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

const FILE_COL_KEYS = ['add', 'del', 'status', 'ratio'];

const INFO_STATUS = [
  'copied',
  'staged',
  'unstaged',
  'not staged',
  'reverted',
  'already staged',
  'read only',
  'last block',
  'first block',
  'first file',
  'last file',
  'nothing to review',
  'unified',
  'mixed',
  'side-by-side',
  'saved',
  'not a diff block',
];

const QUIT_FINISH = 'f';
const QUIT_CONTINUE = 'c';
const QUIT_FINISH_LABEL = 'finish as ready';
const QUIT_CONTINUE_LABEL = 'continue next time';
const QUIT_PROMPT = ` ${QUIT_FINISH_LABEL}  ${QUIT_CONTINUE_LABEL}`;

const GUTTER_W = 2;
const BUTTON_GAP = '  ';
const LOGO = '👁️';
const FILE_MARK = '▶';
const FILE_LIST_PAD = 1;
const CHECK_DONE = 'xX';
const TODO_CAPTION = 'TODO:';
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
    return { path: entry.path, origin: entry.status, n, total };
  }
  if (!view.item) return { path: '', origin: '', n: 0, total: view.total ?? 0 };
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

const bodyLines = (item, layout) => {
  if (item.file.isBinary) {
    const text = '(binary)';
    return [{ type: 'ctx', text, spans: [{ text, changed: false }] }];
  }
  if (!item.hunk) return [];
  const radius = item.dep ? Number.MAX_SAFE_INTEGER : undefined;
  return displayLines(item.hunk, item.blockId, layout, radius);
};

const sourceEmpty = (line) => !line || !(line.text ?? '').trim();

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

const layoutButtons = (width, compact = false, disabled = []) => {
  const build = (short) => {
    const hits = [];
    const parts = [];
    let x = 0;
    for (const id of ACTION_IDS) {
      const action = { id, ...ACTIONS[id] };
      const letter = actionLetter(action);
      const word = buttonWord(action);
      const label = short ? letter : word;
      const piece = `${BUTTON_GAP}${label}`;
      const w = visibleWidth(piece);
      if (x + w > width && parts.length) break;
      const isDisabled = disabled.includes(id);
      if (!isDisabled) hits.push({ id, x0: x, x1: x + w });
      parts.push({ action, piece, letter, label, disabled: isDisabled });
      x += w;
    }
    return { hits, parts, width: x };
  };
  if (compact) return build(true);
  const words = build(false);
  if (words.parts.length === ACTION_IDS.length) return words;
  return build(true);
};

const paintButtons = (layout, width, color) => {
  let out = '';
  let used = 0;
  for (const part of layout.parts) {
    out += paint(BUTTON_GAP, THEME.buttonFg, THEME.buttonBg, color);
    if (part.disabled) {
      out += paint(part.label, THEME.buttonFg, THEME.buttonBg, color);
    } else {
      out += paintMarkedWord(part.label, part.letter, color, BUTTON_MARK);
    }
    used += visibleWidth(part.piece);
  }
  if (used < width) {
    out += fill(width - used, THEME.buttonFg, THEME.buttonBg, color);
  }
  return out;
};

const COUNTS_KIND = {
  pr: ({ counts, notes, sourceLabel }) => {
    const n = counts.pr ?? 0;
    const label = sourceLabel || 'pr';
    return ` pr ${label}  ${n}  ${notes}`;
  },
  commit: ({ counts, notes, revShort }) => {
    const n = counts.commit ?? 0;
    return ` commit ${revShort}  ${n}  ${notes}`;
  },
  worktree: ({ counts, notes }) => {
    const staged = counts.staged ?? 0;
    const unstaged = counts.unstaged ?? 0;
    const untracked = counts.untracked ?? 0;
    const gitCounts = `unstaged ${unstaged}  untracked ${untracked}`;
    const git = `staged ${staged}  ${gitCounts}`;
    return ` ${git}  ${notes}`;
  },
};

const countsKind = (sourceKind, revShort) => {
  if (sourceKind === 'pr') return 'pr';
  if (revShort) return 'commit';
  return 'worktree';
};

const countsLine = (counts, revShort, sourceKind, sourceLabel) => {
  const feedback = counts.feedback ?? 0;
  const todo = counts.todo ?? 0;
  const notes = `feedback ${feedback}  todo ${todo}`;
  const kind = countsKind(sourceKind, revShort);
  return COUNTS_KIND[kind]({ counts, notes, sourceLabel, revShort });
};

const paintQuitPrompt = (width, color) => {
  const bgRgb = THEME.chromeBg;
  let body = QUIT_PROMPT;
  if (color) {
    const finish = ` ${QUIT_FINISH_LABEL}`;
    const rest = `  ${QUIT_CONTINUE_LABEL}`;
    const paintQuit = (label, letter) =>
      paintMarkedWord(label, letter, color, QUIT_MARK);
    body = paintQuit(finish, QUIT_FINISH) + paintQuit(rest, QUIT_CONTINUE);
  }
  const pad = Math.max(0, width - visibleWidth(body));
  return body + fill(pad, THEME.mutedFg, bgRgb, color);
};

const paintStatusLine = (view, status, width, color) => {
  const { mode, counts, revShort, sourceKind, sourceLabel } = view;
  if (mode === 'confirmQuit') return paintQuitPrompt(width, color);
  const left = countsLine(counts ?? {}, revShort, sourceKind, sourceLabel);
  let right = '';
  let msgFg = THEME.chromeFg;
  if (status) {
    right = ` ${status} `;
    if (!INFO_STATUS.includes(status)) msgFg = THEME.errorFg;
  }
  const rightW = visibleWidth(right);
  const room = Math.max(0, width - rightW);
  const clipped = truncateVisible(left, room);
  const pad = Math.max(0, width - visibleWidth(clipped) - rightW);
  const gap = ' '.repeat(pad);
  const paintedRight = paint(right, msgFg, THEME.chromeBg, color);
  return (
    paint(clipped, THEME.mutedFg, THEME.chromeBg, color) +
    paint(gap, THEME.mutedFg, THEME.chromeBg, color) +
    paintedRight
  );
};

const signedCount = (sign, n) => `${sign}${n ?? 0}`;

const fileRowFields = (entry) => {
  const { added, removed, staged, remaining } = entry;
  const add = signedCount('+', added);
  const del = signedCount('-', removed);
  const status = entry.status ?? '';
  const ratio = `${staged ?? 0}/${remaining ?? 0}`;
  return { add, del, status, ratio };
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

const padStartVisible = (text, width) => {
  const n = Math.max(0, width - visibleWidth(text));
  return `${' '.repeat(n)}${text}`;
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
    parts[key] = padStartVisible(fields[key], width);
  }
  return parts;
};

const joinFileSuffix = (parts) => {
  const { add, del, status, ratio } = parts;
  const stat = `${add}/${del}`;
  return `  ${stat}  ${status}  ${ratio}`;
};

const paintFileSuffix = (parts, fgRgb, bgRgb, color) => {
  const { add, del, status, ratio } = parts;
  const gap = paint('  ', fgRgb, bgRgb, color);
  const addText = paint(add, THEME.addLineFg, bgRgb, color);
  const slash = paint('/', THEME.mutedFg, bgRgb, color);
  const delText = paint(del, THEME.delLineFg, bgRgb, color);
  const statusText = paint(status, fgRgb, bgRgb, color);
  const ratioText = paint(ratio, fgRgb, bgRgb, color);
  return gap + addText + slash + delText + gap + statusText + gap + ratioText;
};

const paintFileRow = (entry, width, color, selected, cols) => {
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
  if ((view.pane ?? 'diff') === 'files') return empty;
  const compose = view.compose;
  if (compose && compose.kind === 'feedback') {
    return paintComposeNote(view, width, color, cap);
  }
  return paintIdleNote(view, width, color);
};

const paintBodyFiles = (view, width, color, bodyH, headerLines) => {
  const files = view.files ?? [];
  const cols = fileColumns(files);
  const cursor = view.fileCursor ?? 0;
  const pad = bodyH >= FILE_LIST_PAD * 2 + 1 ? FILE_LIST_PAD : 0;
  const listH = bodyH - pad * 2;
  const start = cursor >= listH ? cursor - listH + 1 : 0;
  const blank = paintBodyFill(width, color, 'files');
  const body = [];
  const fileHits = [];
  if (pad) body.push(blank);
  for (let i = 0; i < listH; i++) {
    const idx = start + i;
    const entry = files[idx];
    if (!entry) break;
    const selected = idx === cursor;
    body.push(paintFileRow(entry, width, color, selected, cols));
    const y = headerLines + pad + i + 1;
    fileHits.push({ y, cursor: idx });
  }
  if (pad) body.push(blank);
  return { body, fileHits };
};

const paintTodoCaption = (width, color) =>
  paintBar(` ${TODO_CAPTION}`, width, THEME.chromeFg, THEME.ctxBg, color);

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
  return rows.map((text) => {
    const spans = [{ text, changed: false }];
    return { ...line, text, spans };
  });
};

const expandSoftRows = (lines, width, split) => {
  const wrapWidth = split ? splitWidths(width).leftW : width;
  const out = [];
  for (const row of lines) {
    const line = split ? row.left || row.right : row;
    if (!line || !SOFT_WRAP.includes(line.type)) {
      out.push(row);
      continue;
    }
    const parts = wrapSoftLine(line, wrapWidth);
    for (const part of parts) {
      if (split) out.push({ left: part, right: part });
      else out.push(part);
    }
  }
  return out;
};

const paintBodyDiff = (item, layout, width, color) => {
  const lang = detectLang(itemPath(item));
  const splitBody = layout === 'side' && !item.file.isBinary;
  const raw = dropLeadingEmpty(bodyLines(item, layout), splitBody);
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
  return { body, splitBody };
};

const bodyKind = (view) => {
  if ((view.pane ?? 'diff') === 'files') return 'files';
  if (!view.item) return 'empty';
  if (view.item.origin === 'todo') return 'todo';
  return 'diff';
};

const BODY_PAINT = {
  files: (view, width, color, bodyH, headerLines) => ({
    ...paintBodyFiles(view, width, color, bodyH, headerLines),
    todoOwners: [],
  }),
  empty: () => ({ body: [], fileHits: [], todoOwners: [] }),
  todo: (view, width, color) => ({
    ...paintBodyTodo(view, width, color),
    fileHits: [],
  }),
  diff: (view, width, color) => ({
    ...paintBodyDiff(view.item, view.layout ?? 'unified', width, color),
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
  const listPane = pane === 'files';
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

const frameResult = (text, painted, layout, windowed, hits) => {
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
    footerY,
    height: painted.length,
    scroll,
    cursor,
  };
};

const renderFrame = (view, options = {}) => {
  const width = Math.max(20, options.width ?? 80);
  const height = Math.max(6, options.height ?? 24);
  const color = options.color ?? true;
  const rows = [paintHeader(view, width, color)];
  const pane = view.pane ?? 'diff';
  const disabled = pane === 'files' ? FILES_DISABLED : [];
  const layout = layoutButtons(width, false, disabled);
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
  return frameResult(text, painted, layout, windowed, hits);
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
  QUIT_FINISH,
  QUIT_CONTINUE,
  QUIT_PROMPT,
  DEL_CHAR_BG,
  ADD_CHAR_BG,
  paintDiffLine,
  headerText,
  layoutButtons,
  todoInnerWidth,
  noteInnerWidth,
  renderFrame,
  presentCursor,
  presentRows,
};
