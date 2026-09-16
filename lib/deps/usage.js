'use strict';

const SOURCE_EXT = ['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts'];
const REQUIRE_SPEC = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
const FROM_SPEC = /\bfrom\s+['"]([^'"]+)['"]/g;
const IMPORT_FILE = /import\s+['"]([^'"]+)['"]/g;
const IMPORT_CALL = /import\(\s*['"]([^'"]+)['"]\s*\)/g;

const toPackageName = (spec) => {
  if (!spec || spec.startsWith('.') || spec.startsWith('/')) return '';
  if (spec.startsWith('node:')) return '';
  if (spec.startsWith('@')) {
    const parts = spec.split('/');
    if (parts.length < 2) return '';
    return `${parts[0]}/${parts[1]}`;
  }
  return spec.split('/')[0];
};

const addSpec = (used, spec) => {
  const name = toPackageName(spec);
  if (name) used.add(name);
};

const addMatches = (used, text, pattern) => {
  const matches = text.matchAll(pattern);
  for (const match of matches) addSpec(used, match[1]);
};

const collectUsedFromText = (used, text) => {
  addMatches(used, text, REQUIRE_SPEC);
  addMatches(used, text, FROM_SPEC);
  addMatches(used, text, IMPORT_FILE);
  addMatches(used, text, IMPORT_CALL);
};

const collectUsedFromScripts = (used, scripts) => {
  if (!scripts || typeof scripts !== 'object') return;
  for (const script of Object.values(scripts)) {
    const tokens = `${script}`.split(/[\s;&|]+/);
    for (const token of tokens) {
      if (!token || token.startsWith('-')) continue;
      if (token === 'npx' || token === 'npm' || token === 'node') continue;
      addSpec(used, token);
    }
  }
};

const pkgHasExportEntry = (pkg) => {
  if (!pkg || typeof pkg !== 'object') return false;
  const main = pkg.main;
  if (typeof main === 'string' && main) return true;
  const esm = pkg.module;
  if (typeof esm === 'string' && esm) return true;
  const exported = pkg.exports;
  if (typeof exported === 'string' && exported) return true;
  if (!exported || typeof exported !== 'object') return false;
  if (Array.isArray(exported)) return exported.length > 0;
  return Object.keys(exported).length > 0;
};

module.exports = {
  SOURCE_EXT,
  toPackageName,
  collectUsedFromText,
  collectUsedFromScripts,
  pkgHasExportEntry,
};
