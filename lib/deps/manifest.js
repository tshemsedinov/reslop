'use strict';

const path = require('node:path');

const MANIFEST = 'package.json';
const LOCKFILE = 'package-lock.json';
const DEP_KIND = { [MANIFEST]: 'manifest', [LOCKFILE]: 'lockfile' };
const SECTION_KEYS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
];

const posixRel = (rel) => {
  const raw = `${rel ?? ''}`;
  return raw.replaceAll('\\', '/');
};

const depFileMeta = (rel) => {
  const normalized = posixRel(rel);
  if (!normalized) return null;
  const base = path.posix.basename(normalized);
  const kind = DEP_KIND[base];
  if (!kind) return null;
  const dir = path.posix.dirname(normalized);
  return { kind, dir, base, rel: normalized };
};

const relOf = (dir, name) => (dir === '.' ? name : `${dir}/${name}`);

const parseJson = (text) => {
  if (!text || !`${text}`.trim()) return null;
  try {
    const data = JSON.parse(text);
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    return data;
  } catch {
    return null;
  }
};

const emptySectionMaps = () => {
  const maps = {};
  for (const key of SECTION_KEYS) maps[key] = new Map();
  return maps;
};

const readSectionMap = (pkg, key) => {
  const map = new Map();
  const raw = pkg ? pkg[key] : null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return map;
  for (const name of Object.keys(raw)) {
    const version = raw[name];
    if (typeof version === 'string') map.set(name, version);
  }
  return map;
};

const readSections = (pkg) => {
  const maps = emptySectionMaps();
  if (!pkg) return maps;
  for (const key of SECTION_KEYS) maps[key] = readSectionMap(pkg, key);
  return maps;
};

const lockRootSections = (lock) => {
  if (!lock) return emptySectionMaps();
  const packages = lock.packages;
  const root = packages && typeof packages === 'object' ? packages[''] : null;
  const src = root && typeof root === 'object' ? root : lock;
  return readSections(src);
};

const lockEntries = (lock) => {
  const versions = new Map();
  if (!lock) return versions;
  const packages = lock.packages;
  if (packages && typeof packages === 'object') {
    for (const key of Object.keys(packages)) {
      const entry = packages[key];
      if (!key.startsWith('node_modules/')) continue;
      if (key.includes('/node_modules/')) continue;
      if (!entry || typeof entry.version !== 'string') continue;
      const name = key.slice('node_modules/'.length);
      versions.set(name, entry.version);
    }
  }
  const deps = lock.dependencies;
  if (!deps || typeof deps !== 'object') return versions;
  for (const name of Object.keys(deps)) {
    const entry = deps[name];
    if (versions.has(name)) continue;
    if (!entry || typeof entry.version !== 'string') continue;
    versions.set(name, entry.version);
  }
  return versions;
};

const lockPackageCount = (lock) => {
  if (!lock) return 0;
  const packages = lock.packages;
  if (packages && typeof packages === 'object') {
    let count = 0;
    for (const key of Object.keys(packages)) {
      if (key !== '') count += 1;
    }
    return count;
  }
  const deps = lock.dependencies;
  if (!deps || typeof deps !== 'object') return 0;
  return Object.keys(deps).length;
};

const cloneJson = (value) => JSON.parse(JSON.stringify(value ?? null));

const detectIndent = (text) => {
  const match = /\n([ \t]+)"/.exec(text);
  if (!match) return 2;
  return match[1];
};

const stringifyJson = (value, original) => {
  const indent = detectIndent(original || '');
  const body = JSON.stringify(value, null, indent);
  return `${body}\n`;
};

module.exports = {
  MANIFEST,
  LOCKFILE,
  DEP_KIND,
  SECTION_KEYS,
  posixRel,
  depFileMeta,
  relOf,
  parseJson,
  emptySectionMaps,
  readSections,
  lockRootSections,
  lockEntries,
  lockPackageCount,
  cloneJson,
  stringifyJson,
};
