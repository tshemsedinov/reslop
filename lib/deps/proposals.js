'use strict';

const { SECTION_KEYS, readSections, lockEntries } = require('./manifest.js');
const { pkgHasExportEntry } = require('./usage.js');
const versions = require('./versions.js');
const { findDeclared, applyWantedRange } = versions;
const { proposedLockVersion, proposedWanted } = versions;

const depExports = (exportEntries, name) => {
  if (!exportEntries || !exportEntries.has(name)) return true;
  return exportEntries.get(name) === true;
};

const isAddedDep = (change) => {
  if (change.action !== 'added') return false;
  if (change.section === 'resolved') return false;
  if (change.section === 'field') return false;
  return true;
};

const unusedChangeNames = (changes, used) => {
  const names = [];
  if (!used || !used.size) return names;
  for (const change of changes) {
    if (!isAddedDep(change)) continue;
    if (used.has(change.name)) continue;
    names.push(change.name);
  }
  return names;
};

const unusedDeclaredNames = (pkg, used) => {
  const names = [];
  if (!pkgHasExportEntry(pkg)) return names;
  if (!used || !used.size) return names;
  const maps = readSections(pkg);
  for (const section of SECTION_KEYS) {
    if (section === 'peerDependencies') continue;
    const keys = [...maps[section].keys()];
    keys.sort();
    for (const name of keys) {
      if (used.has(name)) continue;
      names.push(name);
    }
  }
  return names;
};

const markUnusedChanges = (changes, used, pkg, exportEntries) => {
  if (!pkgHasExportEntry(pkg)) return changes;
  if (!used || !used.size) return changes;
  const marked = [];
  for (const change of changes) {
    if (!isAddedDep(change) || used.has(change.name)) {
      marked.push(change);
      continue;
    }
    if (!depExports(exportEntries, change.name)) {
      marked.push(change);
      continue;
    }
    marked.push({ ...change, unused: true, propose: true });
  }
  return marked;
};

const unusedDeclaredChanges = (pkg, used, exportEntries) => {
  const changes = [];
  if (!pkgHasExportEntry(pkg)) return changes;
  if (!used || !used.size) return changes;
  const maps = readSections(pkg);
  const taken = new Set();
  for (const section of SECTION_KEYS) {
    if (section === 'peerDependencies') continue;
    const map = maps[section];
    const names = [...map.keys()];
    names.sort();
    for (const name of names) {
      if (used.has(name)) continue;
      if (taken.has(name)) continue;
      if (!depExports(exportEntries, name)) continue;
      taken.add(name);
      const version = map.get(name);
      changes.push({
        name,
        section,
        action: 'removed',
        from: version,
        to: '',
        propose: true,
        unused: true,
      });
    }
  }
  return changes;
};

const buildProposedChanges = (pkg, outdated, audit, lock, options = {}) => {
  const used = options.used;
  const exportEntries = options.exportEntries;
  const names = new Set();
  if (outdated) {
    for (const name of outdated.keys()) names.add(name);
  }
  if (audit) {
    for (const name of audit.keys()) names.add(name);
  }
  const listed = [...names];
  listed.sort();
  const resolved = lockEntries(lock);
  const unused = unusedDeclaredChanges(pkg, used, exportEntries);
  const taken = new Set();
  for (const change of unused) taken.add(change.name);
  const changes = [...unused];
  for (const name of listed) {
    if (taken.has(name)) continue;
    const out = outdated ? outdated.get(name) : null;
    const vul = audit ? audit.get(name) : null;
    const type = out ? out.type : '';
    const declared = findDeclared(pkg, name, type);
    if (!declared) {
      if (!vul) continue;
      const version = resolved.get(name) || '';
      if (!version) continue;
      const to = proposedLockVersion(version, vul);
      changes.push({
        name,
        section: 'resolved',
        action: 'vulnerable',
        from: version,
        to,
        propose: true,
        audit: vul,
      });
      continue;
    }
    const wanted = proposedWanted(out, vul);
    if (!wanted && !vul) continue;
    let to = declared.version;
    if (wanted) to = applyWantedRange(declared.version, wanted);
    if (to === declared.version && !vul) continue;
    let action = 'changed';
    if (to === declared.version) action = 'vulnerable';
    const change = {
      name,
      section: declared.section,
      action,
      from: declared.version,
      to,
      propose: true,
    };
    if (out) change.outdated = out;
    if (vul) change.audit = vul;
    changes.push(change);
  }
  return changes;
};

module.exports = {
  unusedChangeNames,
  unusedDeclaredNames,
  markUnusedChanges,
  buildProposedChanges,
};
