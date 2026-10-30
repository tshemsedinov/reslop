'use strict';

const { baseName } = require('../common/paths.js');
const ansi = require('../term/ansi.js');
const { visibleWidth, paint } = ansi;

const ICON_W = 2;
const ICON_GAP = ' ';
const NO_EXT = '(none)';

const RAW = {
  folder: '📁',
  file: '📄',
  bare: '📃',
  tasks: '📋',
  license: '⚖️',
  env: '🔐',
  git: '🙈',
  dot: '⚫',
};

const RAW_EMOJI = {
  html: '🌐',
  htm: '🌐',
  css: '🎨',
  csv: '📊',
  tsv: '📊',
  yml: '⚙️',
  yaml: '⚙️',
  ini: '⚙️',
  md: '⬇️',
  mdx: '⬇️',
  txt: '📄',
  rst: '📄',
  sh: '🐚',
  bash: '🐚',
  zsh: '🐚',
  py: '🐍',
  rb: '💎',
  rs: '🦀',
  java: '☕',
  php: '🐘',
  swift: '🟠',
  dart: '🎯',
  c: '🔷',
  h: '🔷',
  cc: '🔷',
  cpp: '🔷',
  sql: '🗃️',
  wasm: '🧊',
  bin: '📦',
  svg: '✒️',
  png: '🌄',
  jpg: '🌄',
  jpeg: '🌄',
  gif: '🌄',
  webp: '🌄',
  ico: '🌄',
  mp3: '🎵',
  wav: '🎵',
  ogg: '🎵',
  mp4: '🎬',
  webm: '🎬',
  mov: '🎬',
  zip: '📦',
  tar: '📦',
  gz: '📦',
  tgz: '📦',
  rar: '📦',
  '7z': '📦',
  env: '🔐',
  pem: '🔑',
  key: '🔑',
  cert: '🔐',
  crt: '🔐',
  lock: '🔒',
};

const RAW_NAME = {
  '.gitignore': '🙈',
  '.gitattributes': '🙈',
  '.gitmodules': '🙈',
  '.env': '🔐',
  Dockerfile: '🐳',
  Makefile: '🔨',
  'package.json': '📦',
  'package-lock.json': '📦',
};

const BADGES = {
  js: { text: 'js', tone: 'yellow' },
  mjs: { text: 'js', tone: 'yellow' },
  cjs: { text: 'js', tone: 'yellow' },
  jsx: { text: 'js', tone: 'yellow' },
  ts: { text: 'ts', tone: 'blue' },
  mts: { text: 'ts', tone: 'blue' },
  cts: { text: 'ts', tone: 'blue' },
  tsx: { text: 'ts', tone: 'blue' },
  json: { text: '{}', tone: 'orange' },
  jsonc: { text: '{}', tone: 'orange' },
  xml: { text: '<>', tone: 'orange' },
  cs: { text: 'c#', tone: 'purple' },
  kt: { text: 'kt', tone: 'magenta' },
  kts: { text: 'kt', tone: 'magenta' },
  go: { text: 'go', tone: 'cyan' },
};

const BADGE_FG = [10, 12, 15];

const BADGE_BG = {
  yellow: [221, 190, 82],
  blue: [88, 166, 255],
  orange: [220, 150, 82],
  purple: [191, 140, 220],
  magenta: [201, 120, 180],
  cyan: [86, 196, 214],
};

const LICENSE_NAMES = [
  'license',
  'licence',
  'copying',
  'unlicense',
  'copyright',
];

const DOT_PREFIX = [
  { prefix: '.env', icon: 'env' },
  { prefix: '.git', icon: 'git' },
];

// A one-column glyph grows by a space. A wide glyph such as 📁 stays two.
const fitIcon = (icon) => {
  const trimmed = icon.replace(/ +$/u, '');
  if (visibleWidth(trimmed) >= ICON_W) return trimmed;
  return `${trimmed} `;
};

const fitMap = (map) => {
  const out = {};
  for (const key of Object.keys(map)) out[key] = fitIcon(map[key]);
  return out;
};

const EMOJI = fitMap(RAW);
const FILE_EMOJI = fitMap(RAW_EMOJI);
const NAME_EMOJI = fitMap(RAW_NAME);
const FOLDER = EMOJI.folder;

const extOf = (name) => {
  const at = name.lastIndexOf('.');
  if (at <= 0) return '';
  return name.slice(at + 1).toLowerCase();
};

const isLicenseName = (name) => {
  const lower = name.toLowerCase();
  if (LICENSE_NAMES.includes(lower)) return true;
  const stem = lower.split('.')[0];
  return LICENSE_NAMES.includes(stem);
};

const dotIcon = (name) => {
  const hit = DOT_PREFIX.find((row) => name.startsWith(row.prefix));
  if (hit) return EMOJI[hit.icon];
  return EMOJI.dot;
};

const plainMark = (text) => ({ text, tone: '' });

const fileMark = (rel) => {
  const name = baseName(`${rel ?? ''}`);
  if (isLicenseName(name)) return plainMark(EMOJI.license);
  const named = NAME_EMOJI[name];
  if (named) return plainMark(named);
  if (name.startsWith('.')) return plainMark(dotIcon(name));
  const ext = extOf(name);
  const badge = BADGES[ext];
  if (badge) return { text: badge.text, tone: badge.tone };
  const icon = FILE_EMOJI[ext];
  if (icon) return plainMark(icon);
  if (!ext) return plainMark(EMOJI.bare);
  return plainMark(EMOJI.file);
};

const extMark = (key) => {
  if (!key || key === NO_EXT) return plainMark(EMOJI.bare);
  const ext = key.startsWith('.') ? key.slice(1) : key;
  return fileMark(`file.${ext.toLowerCase()}`);
};

const entryMark = (entry) => {
  if (entry && entry.kind === 'tasks') return plainMark(EMOJI.tasks);
  return fileMark(entry && entry.path);
};

const entryIcon = (entry) => entryMark(entry).text;

const badgeColors = (tone) => {
  const bg = BADGE_BG[tone];
  if (!bg) return null;
  return { fg: BADGE_FG, bg };
};

const paintIconLead = (mark, rowFg, rowBg, color, bold) => {
  const chip = badgeColors(mark.tone);
  let iconFg = rowFg;
  let iconBg = rowBg;
  let iconBold = bold;
  if (chip) {
    iconFg = chip.fg;
    iconBg = chip.bg;
    iconBold = true;
  }
  const icon = paint(mark.text, iconFg, iconBg, color, iconBold);
  const gap = paint(ICON_GAP, rowFg, rowBg, color, bold);
  return icon + gap;
};

module.exports = {
  FOLDER,
  ICON_GAP,
  entryIcon,
  fileMark,
  extMark,
  entryMark,
  badgeColors,
  paintIconLead,
};
