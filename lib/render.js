'use strict';

const ansi = require('./ansi.js');
const { displayLines } = require('./diff.js');
const { tokenize, overlayTokens } = require('./highlight.js');
const { detectLang } = require('./detect.js');
const { ACTIONS, actionHot, actionLetter, buttonWord } = require('./keys.js');
const { overlayRows } = require('./select.js');
const { itemPath } = require('./files.js');

const { THEME, CODE_FG, codeFg, paint, visibleWidth, truncateVisible, fg } =
  ansi;
const { RESET, ESC, EL, seq } = ansi;

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
  ctx: STYLES.ctx,
};

const lineStyles = (origin) => (origin === 'staged' ? STAGED_STYLES : STYLES);

const GUTTER_W = 2;

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

const paintDiffLine = (line, width, color, origin, lang) => {
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
    return (
      fill(inner, THEME.ctxFg, THEME.ctxBg, color) +
      fill(1, THEME.ctxFg, THEME.ctxBg, color)
    );
  }
  if (kind === 'split') {
    return paintSplitBlank(width, color);
  }
  return fill(width, THEME.ctxFg, THEME.ctxBg, color);
};

const paintBar = (text, width, fgRgb, bgRgb, color) => {
  const clipped = truncateVisible(text, width);
  const pad = Math.max(0, width - visibleWidth(clipped));
  const filled = clipped + ' '.repeat(pad);
  if (!color) return filled;
  return `${seq(fgRgb, bgRgb)}${EL}${filled}${RESET}`;
};

const LOGO = '👁️';
const FILE_CURSOR = '▷';
const FILE_CURRENT = '▶';

const originLabel = (origin, revShort) => {
  if (origin === 'commit') return revShort || 'commit';
  return origin ?? 'unknown';
};

const headerRoleFg = (role) => {
  if (role === 'repo') return THEME.headerRepoFg;
  if (role === 'dir') return THEME.headerDirFg;
  if (role === 'slash') return THEME.headerSlashFg;
  if (role === 'file') return THEME.headerFileFg;
  if (role === 'meta') return THEME.headerMetaFg;
  return THEME.headerChromeFg;
};

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
    origin: originLabel(view.item.origin, view.revShort),
    n: view.index + 1,
    total: view.total,
  };
};

const headerPrefix = (view) => {
  const repo = view.repoName || '';
  const { path } = headerTarget(view);
  if (repo && path) return ` ${LOGO}  metadiff: ${repo}/`;
  if (repo) return ` ${LOGO}  metadiff: ${repo} `;
  return ` ${LOGO}  metadiff: `;
};

const headerText = (view) => {
  const prefix = headerPrefix(view);
  const { path, origin, n, total } = headerTarget(view);
  const suffix = origin ? ` ${origin} ${n}/${total}` : ` ${n}/${total}`;
  return `${prefix}${path}${suffix}`;
};

const headerPieces = (view, width) => {
  const repo = view.repoName || '';
  const { path, origin, n, total } = headerTarget(view);
  const suffix = origin ? ` ${origin} ${n}/${total}` : ` ${n}/${total}`;
  const right = ' ';
  const chrome = ` ${LOGO}  metadiff: `;
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
    return pieces.map((p) => p.text).join('');
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
  return displayLines(item.hunk, item.blockId, layout);
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

const helpLines = () => {
  const lines = [' keys and buttons', ''];
  for (const action of ACTIONS) {
    const keys = actionHot(action);
    let label = action.label;
    if (action.id === 'layout') {
      label = 'Mode (unified / mixed / side)';
    }
    lines.push(` ${keys.padEnd(16)} ${label}`);
  }
  lines.push(' enter            open file');
  lines.push(' j, k, wheel      scroll / move');
  lines.push(' drag              copy');
  lines.push(' ?, h              help');
  return lines;
};

const paintHotWord = (label, letter, color) => {
  const bgRgb = THEME.buttonBg;
  const at = label.indexOf(letter);
  if (at < 0) {
    return paint(label, THEME.buttonHotFg, bgRgb, color, true);
  }
  const before = label.slice(0, at);
  const hot = label.slice(at, at + letter.length);
  const after = label.slice(at + letter.length);
  let out = '';
  if (before) out += paint(before, THEME.buttonFg, bgRgb, color);
  out += paint(hot, THEME.buttonHotFg, bgRgb, color, true);
  if (after) out += paint(after, THEME.buttonFg, bgRgb, color);
  return out;
};

const BUTTON_GAP = '  ';

const layoutButtons = (width, compact = false) => {
  const build = (short) => {
    const hits = [];
    const parts = [];
    let x = 0;
    for (const action of ACTIONS) {
      const letter = actionLetter(action);
      const word = buttonWord(action);
      const label = short ? letter : word;
      const piece = `${BUTTON_GAP}${label}`;
      const w = visibleWidth(piece);
      if (x + w > width && parts.length) break;
      hits.push({ id: action.id, x0: x, x1: x + w });
      parts.push({ action, piece, letter, label });
      x += w;
    }
    return { hits, parts, width: x };
  };
  if (compact) return build(true);
  const words = build(false);
  if (words.parts.length === ACTIONS.length) return words;
  return build(true);
};

const paintButtons = (layout, width, color) => {
  let out = '';
  let used = 0;
  for (const part of layout.parts) {
    out += paint(BUTTON_GAP, THEME.buttonFg, THEME.buttonBg, color);
    out += paintHotWord(part.label, part.letter, color);
    used += visibleWidth(part.piece);
  }
  if (used < width) {
    out += fill(width - used, THEME.buttonFg, THEME.buttonBg, color);
  }
  return out;
};

const INFO_STATUS = [
  'copied',
  'skipped',
  'staged',
  'unstaged',
  'not staged',
  'reverted',
  'already staged',
  'read only',
  'last block',
  'first block',
  'all skipped',
  'first file',
  'last file',
  'nothing to review',
  'unified',
  'mixed',
  'side-by-side',
];

const countsLine = (counts, revShort) => {
  const skipped = counts.skipped ?? 0;
  if (revShort) {
    const n = counts.commit ?? 0;
    const base = ` commit ${revShort}  ${n}`;
    if (!skipped) return base;
    return `${base}  skipped ${skipped}`;
  }
  const staged = counts.staged ?? 0;
  const unstaged = counts.unstaged ?? 0;
  const untracked = counts.untracked ?? 0;
  const git = `staged ${staged}  unstaged ${unstaged}  untracked ${untracked}`;
  const base = ` ${git}`;
  if (!skipped) return base;
  return `${base}  skipped ${skipped}`;
};

const paintStatusLine = (view, status, width, color) => {
  const left = countsLine(view.counts ?? {}, view.revShort);
  const right = status ? ` ${status} ` : '';
  const rightW = visibleWidth(right);
  const room = Math.max(0, width - rightW);
  const clipped = truncateVisible(left, room);
  const pad = Math.max(0, width - visibleWidth(clipped) - rightW);
  const gap = ' '.repeat(pad);
  const info = !status || INFO_STATUS.includes(status);
  const msgFg = info ? THEME.chromeFg : THEME.errorFg;
  return (
    paint(clipped, THEME.mutedFg, THEME.chromeBg, color) +
    paint(gap, THEME.mutedFg, THEME.chromeBg, color) +
    paint(right, msgFg, THEME.chromeBg, color)
  );
};

const fileColumns = (files) => {
  let statusW = 0;
  let countW = 0;
  for (const entry of files) {
    const status = entry.status ?? '';
    const count = `${entry.remaining ?? 0}`;
    const sw = visibleWidth(status);
    const cw = visibleWidth(count);
    if (sw > statusW) statusW = sw;
    if (cw > countW) countW = cw;
  }
  return { statusW, countW };
};

const padStartVisible = (text, width) => {
  const n = Math.max(0, width - visibleWidth(text));
  return `${' '.repeat(n)}${text}`;
};

const paintFileRow = (entry, width, color, selected, here, cols) => {
  const inner = Math.max(1, width - 1);
  let mark = ' ';
  if (here) mark = FILE_CURRENT;
  else if (selected) mark = FILE_CURSOR;
  const prefix = ` ${mark} `;
  const status = entry.status ?? '';
  const count = `${entry.remaining ?? 0}`;
  const statusW = cols?.statusW ?? visibleWidth(status);
  const countW = cols?.countW ?? visibleWidth(count);
  const statusCol = padStartVisible(status, statusW);
  const countCol = padStartVisible(count, countW);
  const suffix = `  ${statusCol}  ${countCol}`;
  const pathW = Math.max(1, inner - visibleWidth(prefix + suffix));
  const clipped = truncateVisible(entry.path, pathW);
  const pad = Math.max(0, pathW - visibleWidth(clipped));
  const line = `${prefix}${clipped}${' '.repeat(pad)}${suffix}`;
  const fgRgb = selected ? THEME.chromeFg : THEME.mutedFg;
  const bgRgb = selected ? THEME.buttonBg : THEME.ctxBg;
  const row = paintBar(line, inner, fgRgb, bgRgb, color);
  return row + fill(1, fgRgb, bgRgb, color);
};

const wrapPlain = (text, width) => {
  if (visibleWidth(text) <= width) return [text];
  const rows = [];
  let rest = text;
  while (rest.length) {
    const row = truncateVisible(rest, width);
    rows.push(row);
    rest = rest.slice(row.length);
  }
  return rows;
};

const renderFrame = (view, options = {}) => {
  const width = Math.max(20, options.width ?? 80);
  const height = Math.max(6, options.height ?? 24);
  const color = options.color ?? true;
  const pane = view.pane ?? 'diff';
  const item = view.item;
  const rows = [];
  rows.push(paintHeader(view, width, color));
  const layout = layoutButtons(width);
  const status = view.status ?? '';
  const chrome = 3;
  const bodyH = Math.max(1, height - chrome);
  const body = [];
  const fileHits = [];
  const headerLines = rows.length;
  let splitBody = false;
  if (view.help) {
    for (const line of helpLines()) {
      for (const row of wrapPlain(line, width)) {
        body.push(paintBar(row, width, THEME.chromeFg, THEME.ctxBg, color));
      }
    }
  } else if (pane === 'files') {
    const files = view.files ?? [];
    const cols = fileColumns(files);
    const cursor = view.fileCursor ?? 0;
    let start = 0;
    if (cursor >= bodyH) start = cursor - bodyH + 1;
    for (let i = 0; i < bodyH; i++) {
      const idx = start + i;
      const entry = files[idx];
      if (!entry) break;
      const selected = idx === cursor;
      const here = view.reviewPath === entry.path;
      body.push(paintFileRow(entry, width, color, selected, here, cols));
      fileHits.push({ y: headerLines + i + 1, cursor: idx });
    }
  } else if (item) {
    const diffLayout = view.layout ?? 'unified';
    const lang = detectLang(itemPath(item));
    splitBody = diffLayout === 'side' && !item.file.isBinary;
    const lines = dropLeadingEmpty(bodyLines(item, diffLayout), splitBody);
    if (splitBody) {
      for (const row of lines) {
        body.push(paintSplitRow(row, width, color, item.origin, lang));
      }
    } else {
      for (const line of lines) {
        body.push(paintDiffLine(line, width, color, item.origin, lang));
      }
    }
  }
  const scrollRaw = view.scroll ?? 0;
  const listPane = pane === 'files' && !view.help;
  let fillKind = 'plain';
  if (listPane) {
    fillKind = 'files';
  } else if (splitBody) {
    fillKind = 'split';
  }
  if (!listPane && !view.help && body.length > 0) {
    body.unshift(paintBodyFill(width, color, fillKind));
  }
  const scrollMax = Math.max(0, body.length - bodyH);
  const scroll = listPane ? 0 : Math.min(scrollRaw, scrollMax);
  const slice = body.slice(scroll, scroll + bodyH);
  while (slice.length < bodyH) {
    slice.push(paintBodyFill(width, color, fillKind));
  }
  for (const row of slice) rows.push(row);
  rows.push(paintStatusLine(view, status, width, color));
  rows.push(paintButtons(layout, width, color));
  const painted = overlayRows(rows, view.selection);
  const text = painted.map((row) => (color ? row + RESET : row)).join('\n');
  const footerY = painted.length;
  return {
    text,
    rows: painted,
    buttons: layout.hits,
    fileHits,
    footerY,
    height: painted.length,
    scroll,
  };
};

const presentRows = (rows, options = {}) => {
  const clear = options.clear === true;
  const parts = [`${ESC}[?2026h`];
  if (clear) parts.push(`${ESC}[H${ESC}[2J`);
  for (let i = 0; i < rows.length; i++) {
    parts.push(`${ESC}[${i + 1};1H`);
    parts.push(rows[i]);
  }
  parts.push(`${ESC}[?2026l`);
  return parts.join('');
};

const DEL_CHAR_BG = ansi.bg(THEME.delCharBg);
const ADD_CHAR_BG = ansi.bg(THEME.addCharBg);
const DEL_LINE_FG = ansi.fg(THEME.delLineFg);
const ADD_LINE_FG = ansi.fg(THEME.addLineFg);

module.exports = {
  LOGO,
  FILE_CURSOR,
  FILE_CURRENT,
  STYLES,
  STAGED_STYLES,
  renderFrame,
  presentRows,
  layoutButtons,
  paintDiffLine,
  paintSplitRow,
  bodyLines,
  headerText,
  DEL_CHAR_BG,
  ADD_CHAR_BG,
  DEL_LINE_FG,
  ADD_LINE_FG,
};
