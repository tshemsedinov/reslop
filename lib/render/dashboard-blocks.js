'use strict';

const { shortAge, formatNumber, size } = require('../common/format.js');
const { TOP_PACKAGES } = require('../dashboard/npm.js');
const { clamp } = require('../common/utilities.js');
const { visibleWidth, truncateVisible } = require('../term/ansi.js');
const { minuteOf } = require('../dashboard/model.js');
const { seg, barSegments, spinner } = require('./tiles.js');
const { FOLDER, extMark, badgeColors } = require('./icons.js');
const table = require('./table.js');
const { delta, notice, cell, cellSegs, flexCell, tableLines } = table;
const { pickGroups, labelOf, titleAside, captionOver } = table;
const { cmpText, hasRange, inRange } = require('../deps/manifest.js');

const BAR_W = 6;
const MARK_GAP = 1;
const ACTIVITY_LABEL = 'activity';
const PULSE = '∙';
const TRACE = '─';
// The glyph of each mark of a minute, the first one found is shown
const ACTIVITY_MARK = {
  fail: '⨯',
  commit: '◉',
  pass: '*',
  abort: '!',
  branch: '⎇',
  rebase: '↻',
  npm: '✦',
};
const MARK_KINDS = Object.keys(ACTIVITY_MARK);
const MARK_TONE = {
  '⨯': 'error',
  '◉': 'key',
  '*': 'add',
  '!': 'error',
  '⎇': 'sha',
  '↻': 'sha',
  '✦': 'key',
  '+': 'add',
  '-': 'del',
};
const UNKNOWN = '…';

// The lowest level of each heat step above none
const HEAT_STEPS = [1, 16, 81, 301];

const NAME_GAP = 2;
const RATIO_GAP = 1;

const share = (value, total) => (total > 0 ? value / total : 0);

const iconCell = (mark) => {
  const piece = seg(mark.text, 'text', Boolean(mark.tone));
  const chip = badgeColors(mark.tone);
  if (chip) {
    piece.fg = chip.fg;
    piece.bg = chip.bg;
  }
  return { segs: [piece], align: 'l', flex: false };
};

const groupIcon = (key, isDir) => {
  if (isDir) return { text: FOLDER, tone: '' };
  return extMark(key);
};

const nameCell = (key, isDir, hot = false) => {
  const name = cell(labelOf(key, isDir), hot ? 'warn' : 'sha', 'l', hot);
  name.gap = MARK_GAP;
  return name;
};

const fileName = (key, isDir, hot) => {
  const name = nameCell(key, isDir, hot);
  name.flex = true;
  name.keep = true;
  return name;
};

const fileRow = (group, isDir, data) => {
  const hot = (isDir ? data.hot.dirs : data.hot.exts).has(group.key);
  const ratio = share(group.bytes, data.total.bytes);
  const icon = groupIcon(group.key, isDir);
  return [
    iconCell(icon),
    fileName(group.key, isDir, hot),
    cell(`${group.files}`, 'muted', 'r'),
    cell(size(group.bytes), 'text', 'r'),
    cell(formatNumber(group.lines), 'muted', 'r'),
    cellSegs(barSegments(ratio, BAR_W, 'sha')),
  ];
};

const filesTotal = (data, context) => {
  const { total } = data;
  const name = cell('');
  name.flex = true;
  name.gap = MARK_GAP;
  const row = [
    cell(''),
    name,
    cell(`${total.files}`, 'text', 'r', true),
    cell(size(total.bytes), 'text', 'r', true),
    cell(formatNumber(total.lines), 'text', 'r', true),
    cell(''),
  ];
  const moved = data.delta ? data.delta.lines : 0;
  const change = delta(moved, context.now, data.delta?.at);
  if (change) row.push(cellSegs([change]));
  return row;
};

const filesBlock = (model, width, height, context, tile) => {
  const data = model.files;
  if (!data.ready) return notice('scanning…');
  if (!data.total.files) return notice('no files');
  const picked = pickGroups(data.dirs, data.exts, height - 1);
  const labels = [
    cell(''),
    cell(''),
    cell('files', 'caption', 'r'),
    cell('size', 'caption', 'r'),
    cell('lines', 'caption', 'r'),
    cell('share', 'caption', 'r'),
  ];
  const rows = [labels];
  for (const group of picked.dirs) rows.push(fileRow(group, true, data));
  for (const group of picked.exts) rows.push(fileRow(group, false, data));
  rows.push(filesTotal(data, context));
  const lines = tableLines(rows, width);
  return {
    titleLine: captionOver(tile, lines[0]),
    lines: lines.slice(1, -1),
    footer: lines.at(-1),
  };
};

const ratio = (sign, part, total) => `${sign}${part}/${total}`;

const changeCells = (group, bold = false) => [
  cell(ratio('+', group.stagedAdded, group.added), 'add', 'r', bold),
  cell(ratio('-', group.stagedRemoved, group.removed), 'del', 'r', bold),
  cell(`${group.staged}/${group.remaining}`, 'text', 'r', bold),
  cell(shortAge(group.date), 'muted', 'r'),
];

const diffRow = (group, isDir) => {
  const icon = groupIcon(group.key, isDir);
  const name = nameCell(group.key, isDir);
  return [iconCell(icon), name, ...changeCells(group)];
};

const diffsHeader = (data, context) => {
  const name = cell('');
  name.gap = MARK_GAP;
  const row = [cell(''), name, ...changeCells(data.totals, true)];
  const moved = data.delta ? data.delta.added + data.delta.removed : 0;
  const change = delta(moved, context.now, data.delta?.at);
  if (change) row[row.length - 1] = cellSegs([change], 'r');
  return row;
};

const heatIndex = (level) => HEAT_STEPS.filter((min) => level >= min).length;

const markGlyph = (marks) => {
  const list = marks ?? [];
  const kind = MARK_KINDS.find((name) => list.includes(name));
  return kind ? ACTIVITY_MARK[kind] : '';
};

const diffGlyph = (bucket) => {
  if (!bucket) return '';
  const added = bucket.added || 0;
  const removed = bucket.removed || 0;
  if (removed > added) return '-';
  if (added > 0 || removed > 0 || bucket.level > 0) return '+';
  return '';
};

const pulseGlyph = (level) => {
  const index = heatIndex(level);
  if (index >= 4) return '●';
  if (index >= 3) return '•';
  return '◦';
};

const activityCell = (bucket, blink, pulse) => {
  const level = bucket ? bucket.level : 0;
  const glyph = markGlyph(bucket ? bucket.marks : null);
  const mark = glyph || diffGlyph(bucket);
  const phase = blink ? pulseGlyph(level) : PULSE;
  const char = pulse ? phase : mark || TRACE;
  if (blink) return seg(char, 'key', true);
  if (!pulse && mark) {
    return seg(char, MARK_TONE[mark] || 'sha', Boolean(glyph));
  }
  return seg(char, 'sha');
};

const activityCells = (activity, context, width) => {
  const minutes = activity && activity.minutes ? activity.minutes : [];
  const byAt = new Map();
  for (const row of minutes) {
    byAt.set(row.at, row);
  }
  const current = minuteOf(context.now);
  const flash = Boolean(activity && activity.live);
  const on = Math.abs(context.frame ?? 0) % 2 === 1;
  const body = Math.max(0, width - 2);
  const cells = [];
  for (let i = 0; i < body; i++) {
    const at = current - (body - 1 - i);
    const last = i === body - 1;
    const pulse = flash && last;
    const blink = pulse && on;
    cells.push(activityCell(byAt.get(at), blink, pulse));
  }
  return [seg(' ', 'muted'), ...cells, seg(' ', 'muted')];
};

const activityFooter = (data, width, context) => {
  const lineWidth = width + 1;
  const room = lineWidth - ACTIVITY_LABEL.length;
  if (room < 3) return null;
  const cells = activityCells(data.activity, context, room);
  return [seg(ACTIVITY_LABEL, 'sha'), ...cells];
};

const diffsBlock = (model, width, height, context, tile) => {
  const data = model.diffs;
  if (!data.files) return notice('working tree clean');
  const footer = activityFooter(data, width, context);
  const room = footer ? height - 1 : height;
  const picked = pickGroups(data.dirs, data.exts, room);
  const rows = [diffsHeader(data, context)];
  for (const group of picked.dirs) rows.push(diffRow(group, true));
  for (const group of picked.exts) rows.push(diffRow(group, false));
  const lines = tableLines(rows, width, 2, true);
  const titleLine = captionOver(tile, lines[0]);
  const body = lines.slice(1);
  const footerFlush = true;
  return { titleLine, lines: body, footer, footerFlush };
};

const compactSize = (bytes) => size(bytes).replaceAll(' ', '');

const alertSegs = (value, tone, mark) => {
  if (!value) return [];
  return [seg(' '), seg(mark, tone), seg(` ${value}`, tone, true)];
};

const npmAside = (data) => {
  const modules = data.modules;
  const bytes = compactSize(modules.bytes);
  const counts = `deps:${data.deps} dev:${data.dev}`;
  const text = `${counts} all:${modules.count}/${bytes}`;
  return [
    seg(text, 'caption'),
    ...alertSegs(data.audit, 'error', '🚨'),
    ...alertSegs(data.outdated, 'warn', '⚠️'),
  ];
};

const npmStatus = (data) => {
  if (!data || !data.ready || !data.hasManifest) return '';
  const modules = data.modules || { count: 0, bytes: 0 };
  let text = `deps: ${data.deps}  dev: ${data.dev}`;
  text += `  all: ${modules.count} (${size(modules.bytes)})`;
  if (data.audit) text += `  🚨 ${data.audit}`;
  if (data.outdated) text += `  ⚠️ ${data.outdated}`;
  return text;
};

const vulnTone = (text, pkg) => {
  if (!pkg.audit || !text || text === UNKNOWN) return '';
  const fix = pkg.fix || '';
  if (fix) {
    const cmp = cmpText(text, fix);
    if (cmp === null) return text === pkg.current ? 'error' : '';
    return cmp < 0 ? 'error' : 'add';
  }
  const range = pkg.range || '';
  if (hasRange(range)) {
    if (inRange(text, range)) return 'error';
    const cmp = cmpText(text, pkg.current);
    if (cmp !== null && cmp > 0) return 'add';
  }
  return text === pkg.current ? 'error' : '';
};

const isOutdated = (pkg) => {
  const current = pkg.current || '';
  const wanted = pkg.wanted || '';
  const latest = pkg.latest || '';
  if (!current || current === UNKNOWN) return false;
  if (wanted && wanted !== UNKNOWN && wanted !== current) return true;
  return Boolean(latest && latest !== UNKNOWN && latest !== current);
};

const fixesOutdated = (text, pkg) => {
  if (!isOutdated(pkg) || !text || text === UNKNOWN) return false;
  const current = pkg.current || '';
  const wanted = pkg.wanted || '';
  const latest = pkg.latest || '';
  if (text === wanted && wanted !== current) return true;
  return text === latest && latest !== current;
};

const versionTone = (text, pkg) => {
  const vuln = vulnTone(text, pkg);
  if (vuln) return vuln;
  if (fixesOutdated(text, pkg)) return 'add';
  if (text === pkg.current && isOutdated(pkg)) return 'warn';
  return 'muted';
};

const packageMark = (pkg, marks) => {
  if (!marks) return cell('');
  const segs = [];
  if (pkg.audit) segs.push(seg('🛑 vulnerability detected', 'error'));
  if (isOutdated(pkg)) {
    if (segs.length) segs.push(seg('  '));
    segs.push(seg('⚠️ outdated', 'warn'));
  }
  if (!segs.length) return cell('');
  return cellSegs(segs);
};

const nameTone = (pkg) => {
  if (pkg.transitive) return 'pkg';
  if (pkg.dev) return 'dev';
  return 'dep';
};

const packageName = (pkg) => {
  const segs = [seg(pkg.name, nameTone(pkg))];
  if (pkg.chain) segs.push(seg(` 🢒 ${pkg.chain}`, 'chain'));
  const align = 'l';
  const flex = true;
  const keep = true;
  const measure = visibleWidth(pkg.name);
  return { segs, align, flex, keep, measure };
};

const versionCell = (text, pkg) => cell(text, versionTone(text, pkg), 'r');

const packageHead = () => {
  const title = flexCell('name');
  title.keep = true;
  return [
    title,
    cell(''),
    cell('current', 'muted', 'r'),
    cell('wanted', 'muted', 'r'),
    cell('latest', 'muted', 'r'),
    cell('size', 'muted', 'r'),
  ];
};

const packageRow = (pkg, marks) => {
  const current = pkg.current || UNKNOWN;
  const wanted = pkg.wanted || UNKNOWN;
  const latest = pkg.latest || UNKNOWN;
  return [
    packageName(pkg),
    packageMark(pkg, marks),
    versionCell(current, pkg),
    versionCell(wanted, pkg),
    versionCell(latest, pkg),
    cell(size(pkg.bytes), 'muted', 'r'),
  ];
};

const packageLines = (packages, width, limit) => {
  const all = limit === null;
  const headed = packages.length > 0 && (all || limit > 1);
  const head = headed ? 1 : 0;
  const room = all ? packages.length : Math.max(0, limit - head);
  const shown = packages.slice(0, room);
  const rows = shown.map((pkg) => packageRow(pkg, all));
  if (headed) rows.unshift(packageHead());
  return tableLines(rows, width);
};

const npmContent = (data, width, limit, context, tile) => {
  if (!data || !data.ready) return notice('reading package.json…');
  if (!data.hasManifest) return notice('no package.json');
  const badge = data.running ? [seg(spinner(context.frame), 'warn', true)] : [];
  const titleLine = titleAside(tile, npmAside(data), width, badge);
  const listed = data.modules && data.modules.packages;
  const packages = listed ? listed : [];
  if (!packages.length) return notice('no packages', titleLine);
  const short = limit === null ? packages : packages.slice(0, TOP_PACKAGES);
  return { titleLine, lines: packageLines(short, width, limit) };
};

const npmBlock = (model, width, height, context, tile) =>
  npmContent(model.npm, width, height, context, tile);

const ratioLabel = (done, total) => `${done}/${total}`;

const taskSpecs = (data) => {
  const rows = [];
  for (const kind of data.kinds) {
    const { title, done, total } = kind;
    const bold = false;
    const row = { title, done, total, bold };
    rows.push(row);
  }
  const title = 'Total';
  const titleTone = 'add';
  const { done, total } = data;
  const bold = true;
  const row = { title, titleTone, done, total, bold };
  rows.push(row);
  return rows;
};

const taskRows = (specs, room) => {
  if (room < 1) return [];
  const total = specs.at(-1);
  const kinds = specs.slice(0, -1).slice(0, room - 1);
  return [...kinds, total];
};

const planAside = (tile, plan, width) => {
  if (!plan) return [];
  const room = Math.max(0, width - tile.title.length - 1);
  const shown = truncateVisible(plan, room);
  return shown ? [seg(shown, 'caption')] : [];
};

const widest = (rows, read) => {
  let width = 0;
  for (const row of rows) {
    const size = read(row).length;
    if (size > width) width = size;
  }
  return width;
};

const taskBarWidth = (width, nameW, ratioW) => {
  const room = width - nameW - ratioW - NAME_GAP - RATIO_GAP;
  return room > 0 ? room : 0;
};

const taskBarSegments = (ratio, width) => {
  if (width < 1) return [];
  const edge = width >= 3 ? 1 : 0;
  const inner = width - edge * 2;
  const clamped = clamp(Number.isFinite(ratio) ? ratio : 0, 0, 1);
  const on = Math.round(clamped * inner);
  const off = inner - on;
  const parts = edge ? [seg(' ', 'muted')] : [];
  if (on) parts.push(seg(TRACE.repeat(on), 'add'));
  if (off) parts.push(seg(TRACE.repeat(off), 'track'));
  if (edge) parts.push(seg(' ', 'muted'));
  return parts;
};

const taskLine = (row, barW) => {
  const tone = row.bold ? 'text' : 'muted';
  const titleTone = row.titleTone ?? 'text';
  const titleBold = row.titleTone ? false : row.bold;
  const line = [cell(row.title, titleTone, 'l', titleBold)];
  if (barW > 0) {
    const ratio = share(row.done, row.total);
    line.push(cellSegs(taskBarSegments(ratio, barW)));
  }
  const count = cell(ratioLabel(row.done, row.total), tone, 'r', row.bold);
  count.gap = RATIO_GAP;
  line.push(count);
  return line;
};

const tasksBlock = (model, width, height, context, tile) => {
  const data = model.tasks;
  if (!data.total) {
    const aside = planAside(tile, data.plan, width);
    return notice('no tasks', titleAside(tile, aside, width));
  }
  const specs = taskSpecs(data);
  const nameW = widest(specs, (row) => row.title);
  const ratioW = widest(specs, (row) => ratioLabel(row.done, row.total));
  const barW = taskBarWidth(width, nameW, ratioW);
  const visible = taskRows(specs, Math.max(0, height));
  const rows = visible.map((row) => taskLine(row, barW));
  const lines = tableLines(rows, width, NAME_GAP);
  const aside = planAside(tile, data.plan, width);
  return { titleLine: titleAside(tile, aside, width), lines };
};

module.exports = {
  filesBlock,
  diffsBlock,
  npmStatus,
  npmContent,
  npmBlock,
  tasksBlock,
};
