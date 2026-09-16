'use strict';

const fs = require('node:fs');
const path = require('node:path');

const manifest = require('./manifest.js');
const { MANIFEST, SECTION_KEYS, parseJson, readSections } = manifest;

const usage = require('./usage.js');
const { SOURCE_EXT, collectUsedFromText, collectUsedFromScripts } = usage;
const { pkgHasExportEntry } = usage;

const SKIP_WALK = ['node_modules', '.git', '.review', 'coverage', 'dist'];

const collectUsedFromManifest = (used, rel) => {
  let text;
  try {
    text = fs.readFileSync(rel, 'utf8');
  } catch {
    return;
  }
  const pkg = parseJson(text);
  if (!pkg) return;
  collectUsedFromScripts(used, pkg.scripts);
};

const walkUsedNames = (used, dir) => {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_WALK.includes(entry.name)) continue;
      if (entry.name.startsWith('.')) continue;
      walkUsedNames(used, full);
      continue;
    }
    if (entry.name === MANIFEST) {
      collectUsedFromManifest(used, full);
      continue;
    }
    const ext = path.extname(entry.name);
    if (!SOURCE_EXT.includes(ext)) continue;
    let text;
    try {
      text = fs.readFileSync(full, 'utf8');
    } catch {
      continue;
    }
    collectUsedFromText(used, text);
  }
};

const collectUsedNames = (root) => {
  const used = new Set();
  if (!root) return used;
  walkUsedNames(used, root);
  return used;
};

const depModuleParts = (name) => {
  if (!name.startsWith('@')) return [name];
  const parts = name.split('/');
  if (parts.length < 2) return [];
  return parts.slice(0, 2);
};

const readDepPkg = (root, pkgDir, name) => {
  if (!root || !name) return null;
  const parts = depModuleParts(name);
  if (!parts.length) return null;
  const nested = pkgDir && pkgDir !== '.' ? pkgDir : '';
  let dir = nested ? path.join(root, nested) : root;
  while (true) {
    const file = path.join(dir, 'node_modules', ...parts, MANIFEST);
    let text = '';
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      // Missing node_modules copy; try a parent directory.
    }
    if (text) return parseJson(text);
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
};

const depHasExportEntry = (root, pkgDir, name) => {
  const pkg = readDepPkg(root, pkgDir, name);
  if (!pkg) return true;
  return pkgHasExportEntry(pkg);
};

const collectExportEntries = (root, pkgDir, names) => {
  const entries = new Map();
  if (!root) return entries;
  for (const name of names) {
    const hasExport = depHasExportEntry(root, pkgDir, name);
    entries.set(name, hasExport);
  }
  return entries;
};

const declaredDepNames = (root, pkgDir) => {
  const nested = pkgDir && pkgDir !== '.' ? pkgDir : '';
  const file = path.join(root, nested, MANIFEST);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const maps = readSections(parseJson(text));
  const names = [];
  for (const key of SECTION_KEYS) {
    for (const name of maps[key].keys()) names.push(name);
  }
  return names;
};

const collectExportMeta = (root, extra = {}) => {
  if (extra.exportEntries !== undefined) return extra.exportEntries;
  const pkgDir = extra.dir ?? '.';
  const names = extra.names ?? declaredDepNames(root, pkgDir);
  return collectExportEntries(root, pkgDir, names);
};

const collectUsageMeta = (root, extra = {}) => {
  const usedNames = extra.usedNames ?? collectUsedNames(root);
  const exportEntries = collectExportMeta(root, extra);
  return { usedNames, exportEntries };
};

module.exports = {
  collectUsedNames,
  collectExportEntries,
  collectExportMeta,
  collectUsageMeta,
};
