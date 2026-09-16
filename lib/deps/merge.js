'use strict';

const manifest = require('./manifest.js');
const { SECTION_KEYS, parseJson, cloneJson, stringifyJson } = manifest;

const parseFieldValue = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

const setSectionEntry = (pkg, section, name, version) => {
  if (!version) {
    const map = pkg[section];
    if (!map || typeof map !== 'object') return;
    delete map[name];
    if (!Object.keys(map).length) delete pkg[section];
    return;
  }
  const map = pkg[section];
  if (!map || typeof map !== 'object') pkg[section] = {};
  pkg[section][name] = version;
};

const dropsEntry = (change, side) => {
  if (side === 'new') return change.action === 'removed';
  return change.action === 'added';
};

const applyManifestChange = (pkg, change, side) => {
  if (change.section === 'resolved') return pkg;
  const value = side === 'new' ? change.to : change.from;
  if (change.section === 'field') {
    if (value === '') {
      delete pkg[change.name];
      return pkg;
    }
    pkg[change.name] = parseFieldValue(value);
    return pkg;
  }
  const version = dropsEntry(change, side) ? '' : value;
  setSectionEntry(pkg, change.section, change.name, version);
  return pkg;
};

const ensureLockRoot = (lock) => {
  if (!lock.packages || typeof lock.packages !== 'object') {
    lock.packages = {};
  }
  const root = lock.packages[''];
  if (!root || typeof root !== 'object') lock.packages[''] = {};
  return lock.packages[''];
};

const lockNodeKey = (name) => `node_modules/${name}`;

const applyLegacyLockDep = (lock, change, side, src) => {
  const deps = lock.dependencies;
  if (!deps || typeof deps !== 'object') return;
  if (dropsEntry(change, side)) {
    delete deps[change.name];
    return;
  }
  const srcDeps = src && src.dependencies;
  if (!srcDeps || typeof srcDeps !== 'object') return;
  const entry = srcDeps[change.name];
  if (entry) deps[change.name] = cloneJson(entry);
};

const applyLockChange = (lock, change, side, oldLock, newLock) => {
  if (change.section === 'field') return lock;
  const src = side === 'new' ? newLock : oldLock;
  if (change.section !== 'resolved') {
    const root = ensureLockRoot(lock);
    applyManifestChange(root, change, side);
    applyLegacyLockDep(lock, change, side, src);
  }
  const packages = lock.packages;
  if (!packages || typeof packages !== 'object') return lock;
  const key = lockNodeKey(change.name);
  if (dropsEntry(change, side)) {
    delete packages[key];
    return lock;
  }
  const srcPkgs = src && src.packages;
  if (!srcPkgs || typeof srcPkgs !== 'object') return lock;
  const entry = srcPkgs[key];
  if (entry) packages[key] = cloneJson(entry);
  return lock;
};

const seedManifest = (oldObj, newObj) => {
  const base = cloneJson(oldObj) || {};
  if (!newObj) return base;
  for (const key of Object.keys(newObj)) {
    const value = newObj[key];
    if (SECTION_KEYS.includes(key)) continue;
    if (Object.hasOwn(base, key)) continue;
    base[key] = cloneJson(value);
  }
  return base;
};

const mergeDepFile = (baseText, oldText, newText, change, side, kind) => {
  const oldObj = parseJson(oldText);
  const newObj = parseJson(newText);
  const parsedBase = parseJson(baseText);
  let base;
  if (parsedBase) base = cloneJson(parsedBase);
  else if (kind === 'manifest') base = seedManifest(oldObj, newObj);
  else base = cloneJson(oldObj) || {};
  if (kind === 'lockfile') applyLockChange(base, change, side, oldObj, newObj);
  else applyManifestChange(base, change, side);
  const original = baseText || newText || oldText || '';
  return stringifyJson(base, original);
};

module.exports = { mergeDepFile };
