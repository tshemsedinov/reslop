'use strict';

const { itemPath } = require('./files.js');

const manifest = require('./deps/manifest.js');
const { MANIFEST, LOCKFILE, depFileMeta, parseJson } = manifest;
const { readSections, lockEntries, lockPackageCount } = manifest;

const { mergeDepFile } = require('./deps/merge.js');

const changes = require('./deps/changes.js');
const { diffSections, mergeResolved, summarizeGroup } = changes;
const { collectGroups, takeManifestItems } = changes;

const { makeDepItems, stubFileItem } = require('./deps/items.js');

const scan = require('./deps/scan.js');
const { collectUsedNames, collectExportEntries } = scan;

const reports = require('./deps/reports.js');
const { parseAuditReport, parseOutdatedReport } = reports;
const { markAuditChanges, markOutdatedChanges } = reports;

const versions = require('./deps/versions.js');
const { applyWantedRange, patchedFromRange } = versions;

const proposals = require('./deps/proposals.js');
const { unusedChangeNames, unusedDeclaredNames } = proposals;
const { markUnusedChanges, buildProposedChanges } = proposals;

const noSides = () => ({ oldText: '', newText: '' });

const loadExportEntries = (names, extra = {}, pkgDir) => {
  const supplied = extra.exportEntries;
  if (supplied === null) return new Map();
  const dir = pkgDir ?? extra.dir;
  const missing = [];
  for (const name of names) {
    if (!supplied || !supplied.has(name)) missing.push(name);
  }
  if (!missing.length) return supplied ?? new Map();
  const found = collectExportEntries(extra.root, dir, missing);
  if (!supplied) return found;
  const merged = new Map(supplied);
  for (const name of found.keys()) merged.set(name, found.get(name));
  return merged;
};

const foldDepItems = (
  items,
  readSides = noSides,
  usedNames = null,
  audit = null,
  outdated = null,
  extra = {},
) => {
  const groups = collectGroups(items);
  if (!groups.size) return items;
  const folded = new Set();
  const synthetic = new Map();
  for (const key of groups.keys()) {
    const group = groups.get(key);
    const summary = summarizeGroup(group, readSides);
    const unusedNames = unusedChangeNames(summary.changes, usedNames);
    const exportEntries = loadExportEntries(unusedNames, extra, group.dir);
    const unused = markUnusedChanges(
      summary.changes,
      usedNames,
      summary.pkg,
      exportEntries,
    );
    const audited = markAuditChanges(unused, audit);
    const changes = markOutdatedChanges(audited, outdated);
    const next = { ...summary, changes };
    const taken = takeManifestItems(next);
    if (next.foldLock) {
      for (const item of next.lockItems) taken.push(item);
    }
    if (!taken.length && !next.changes.length) continue;
    const made = makeDepItems(group.origin, group.items, taken, next);
    synthetic.set(key, made);
    for (const item of taken) folded.add(item);
  }
  if (!synthetic.size) return items;
  const out = [];
  const placed = new Set();
  for (const item of items) {
    const rel = itemPath(item);
    const meta = depFileMeta(rel);
    if (meta) {
      const key = `${item.origin}\0${meta.dir}`;
      if (synthetic.has(key) && !placed.has(key)) {
        placed.add(key);
        const made = synthetic.get(key);
        for (const depItem of made) out.push(depItem);
      }
    }
    if (!folded.has(item)) out.push(item);
  }
  return out;
};

const proposeDepItems = (pkgText, outdated, audit, extra = {}) => {
  const pkg = parseJson(pkgText);
  if (!pkg) return [];
  const lock = parseJson(extra.lockText ?? '');
  const used = extra.usedNames;
  const names = unusedDeclaredNames(pkg, used);
  const exportEntries = loadExportEntries(names, extra, extra.dir);
  const options = { used, exportEntries };
  const changes = buildProposedChanges(pkg, outdated, audit, lock, options);
  if (!changes.length) return [];
  const stubs = [
    stubFileItem(MANIFEST, 'unstaged'),
    stubFileItem(LOCKFILE, 'unstaged'),
  ];
  const summary = { changes, oldCount: 0, newCount: 0 };
  return makeDepItems('unstaged', stubs, [], summary);
};

const mergeProposedItems = (items, pkgText, outdated, audit, extra = {}) => {
  const proposed = proposeDepItems(pkgText, outdated, audit, extra);
  if (!proposed.length) return items;
  const taken = new Set();
  for (const item of items) {
    const change = item.dep && item.dep.change;
    if (change) taken.add(change.name);
  }
  const added = [];
  for (const item of proposed) {
    const change = item.dep && item.dep.change;
    if (!change || taken.has(change.name)) continue;
    added.push(item);
  }
  if (!added.length) return items;
  return [...items, ...added];
};

module.exports = {
  MANIFEST,
  LOCKFILE,
  depFileMeta,
  readSections,
  lockEntries,
  lockPackageCount,
  diffSections,
  mergeDepFile,
  mergeResolved,
  collectUsedNames,
  parseAuditReport,
  parseOutdatedReport,
  applyWantedRange,
  patchedFromRange,
  proposeDepItems,
  foldDepItems,
  mergeProposedItems,
};
