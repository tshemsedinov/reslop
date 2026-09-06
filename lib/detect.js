'use strict';

const path = require('node:path');

const LANG = {
  md: 'md',
  markdown: 'md',
  js: 'js',
  javascript: 'js',
  mjs: 'mjs',
  cjs: 'js',
  ts: 'ts',
  typescript: 'ts',
  json: 'json',
  csv: 'csv',
  html: 'html',
  htm: 'html',
  css: 'css',
  sh: 'bash',
  bash: 'bash',
  shell: 'bash',
  zsh: 'bash',
  txt: 'txt',
  text: 'txt',
  plain: 'txt',
  log: 'log',
  env: 'dot',
  ini: 'dot',
  conf: 'dot',
  cfg: 'dot',
  yaml: 'dot',
  yml: 'dot',
  toml: 'dot',
  py: 'py',
  python: 'py',
};

const PROSE_BASENAMES = [
  'license',
  'licence',
  'copying',
  'authors',
  'notice',
  'copyright',
];

const fileExt = (filePath) => {
  const base = path.basename(filePath || '');
  const i = base.lastIndexOf('.');
  if (i <= 0) return '';
  return base.slice(i + 1).toLowerCase();
};

const mapLang = (name) => {
  if (!name) return 'txt';
  return LANG[name.toLowerCase()] || 'txt';
};

const isProseBasename = (base) => {
  const name = (base || '').toLowerCase();
  if (PROSE_BASENAMES.includes(name)) return true;
  const stem = name.replace(/\.(txt|text|md|markdown)$/i, '');
  return PROSE_BASENAMES.includes(stem);
};

const detectLang = (filePath) => {
  const base = path.basename(filePath || '').toLowerCase();
  if (base.endsWith('.d.ts')) return 'dts';
  if (isProseBasename(base)) return 'md';
  if (base.endsWith('.log')) return 'log';
  if (base.startsWith('.')) return 'dot';
  if (!base.includes('.')) return 'dot';
  const ext = fileExt(base);
  if (ext) return LANG[ext] || 'txt';
  return 'dot';
};

module.exports = { LANG, mapLang, detectLang, fileExt };
