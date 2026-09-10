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
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return '';
  return base.slice(dot + 1).toLowerCase();
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

const LANG_RULES = [
  { test: (base) => base.endsWith('.d.ts'), lang: 'dts' },
  { test: isProseBasename, lang: 'md' },
  { test: (base) => base.endsWith('.log'), lang: 'log' },
  { test: (base) => base.startsWith('.'), lang: 'dot' },
  { test: (base) => !base.includes('.'), lang: 'dot' },
];

const detectLang = (filePath) => {
  const base = path.basename(filePath || '').toLowerCase();
  for (const rule of LANG_RULES) {
    if (rule.test(base)) return rule.lang;
  }
  const ext = fileExt(base);
  if (ext) return LANG[ext] || 'txt';
  return 'dot';
};

module.exports = { mapLang, detectLang };
