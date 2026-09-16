'use strict';

const { itemPath } = require('../files.js');

const manifest = require('./manifest.js');
const { MANIFEST, LOCKFILE, SECTION_KEYS, depFileMeta, relOf } = manifest;
const { parseJson, readSections, emptySectionMaps } = manifest;
const { lockRootSections, lockEntries, lockPackageCount } = manifest;

const SECTION_ORDER = [...SECTION_KEYS, 'resolved', 'field'];
const ACTION_ORDER = ['added', 'removed', 'changed', 'vulnerable'];
const SECTION_NAMES = SECTION_KEYS.join('|');
const SECTION_OPEN = new RegExp(`^\\s*"(${SECTION_NAMES})"\\s*:\\s*\\{\\s*$`);
const SECTION_END = /^\s*\},?\s*$/;
const DEP_ENTRY = /^\s*"([^"]+)"\s*:\s*"([^"]*)"\s*,?\s*$/;

const diffMaps = (oldMap, newMap, section) => {
  const keys = [...oldMap.keys(), ...newMap.keys()];
  const names = [...new Set(keys)];
  names.sort();
  const changes = [];
  for (const name of names) {
    const from = oldMap.has(name) ? oldMap.get(name) : '';
    const to = newMap.has(name) ? newMap.get(name) : '';
    if (from === to) continue;
    let action = 'changed';
    if (!oldMap.has(name)) action = 'added';
    else if (!newMap.has(name)) action = 'removed';
    changes.push({ name, section, action, from, to });
  }
  return changes;
};

const diffSections = (oldMaps, newMaps) => {
  const changes = [];
  for (const key of SECTION_KEYS) {
    const found = diffMaps(oldMaps[key], newMaps[key], key);
    for (const change of found) changes.push(change);
  }
  return changes;
};

const fieldText = (value) => {
  if (value === undefined) return '';
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
};

const sameJson = (left, right) =>
  JSON.stringify(left) === JSON.stringify(right);

const diffOtherFields = (oldPkg, newPkg) => {
  if (!oldPkg && !newPkg) return [];
  const oldObj = oldPkg ?? {};
  const newObj = newPkg ?? {};
  const keys = [...Object.keys(oldObj), ...Object.keys(newObj)];
  const names = [...new Set(keys)];
  names.sort();
  const changes = [];
  for (const name of names) {
    if (SECTION_KEYS.includes(name)) continue;
    const prev = oldObj[name];
    const next = newObj[name];
    if (sameJson(prev, next)) continue;
    let action = 'changed';
    if (!Object.hasOwn(oldObj, name)) action = 'added';
    else if (!Object.hasOwn(newObj, name)) action = 'removed';
    const from = fieldText(prev);
    const to = fieldText(next);
    const section = 'field';
    changes.push({ name, section, action, from, to });
  }
  return changes;
};

const onlyDepEdits = (items) => {
  if (!items.length) return false;
  for (const item of items) {
    if (!item.hunk) return false;
    const blockId = item.blockId;
    const scoped = typeof blockId === 'number';
    let section = '';
    for (const line of item.hunk.lines) {
      const open = SECTION_OPEN.exec(line.text);
      let nextSection = section;
      if (open) nextSection = open[1];
      else if (section && SECTION_END.test(line.text)) nextSection = '';
      const inBlock = !scoped || line.blockId === blockId;
      if (inBlock && line.type !== 'ctx') {
        const inDep = !!(open || section);
        if (!inDep) return false;
        const isEntry = DEP_ENTRY.test(line.text);
        const isClose = SECTION_END.test(line.text);
        if (!open && !isEntry && !isClose) return false;
      }
      section = nextSection;
    }
  }
  return true;
};

const mapsFromHunks = (items) => {
  const oldMaps = emptySectionMaps();
  const newMaps = emptySectionMaps();
  let section = '';
  for (const item of items) {
    if (!item.hunk) continue;
    for (const line of item.hunk.lines) {
      const open = SECTION_OPEN.exec(line.text);
      if (open) {
        section = open[1];
        continue;
      }
      if (section && SECTION_END.test(line.text)) {
        section = '';
        continue;
      }
      if (!section) continue;
      const entry = DEP_ENTRY.exec(line.text);
      if (!entry) continue;
      const name = entry[1];
      const version = entry[2];
      if (line.type === 'del' || line.type === 'ctx') {
        oldMaps[section].set(name, version);
      }
      if (line.type === 'add' || line.type === 'ctx') {
        newMaps[section].set(name, version);
      }
    }
  }
  return { oldMaps, newMaps };
};

const directNames = (oldMaps, newMaps) => {
  const names = new Set();
  for (const key of SECTION_KEYS) {
    for (const name of oldMaps[key].keys()) names.add(name);
    for (const name of newMaps[key].keys()) names.add(name);
  }
  return names;
};

const mergeResolved = (changes, oldResolved, newResolved, oldMaps, newMaps) => {
  const seen = new Set();
  const merged = [];
  for (const change of changes) {
    seen.add(change.name);
    const resolvedFrom = oldResolved.get(change.name) ?? '';
    const resolvedTo = newResolved.get(change.name) ?? '';
    merged.push({ ...change, resolvedFrom, resolvedTo });
  }
  const names = [...directNames(oldMaps, newMaps)];
  names.sort();
  for (const name of names) {
    if (seen.has(name)) continue;
    const from = oldResolved.get(name) ?? '';
    const to = newResolved.get(name) ?? '';
    if (from === to) continue;
    if (!from && !to) continue;
    let action = 'changed';
    if (!from) action = 'added';
    else if (!to) action = 'removed';
    const section = 'resolved';
    const resolvedFrom = from;
    const resolvedTo = to;
    merged.push({ name, section, action, from, to, resolvedFrom, resolvedTo });
  }
  return merged;
};

const compareChangeOrder = (left, right) => {
  const section = SECTION_ORDER.indexOf(left.section);
  const other = SECTION_ORDER.indexOf(right.section);
  if (section !== other) return section - other;
  const leftAction = ACTION_ORDER.indexOf(left.action);
  const rightAction = ACTION_ORDER.indexOf(right.action);
  if (leftAction !== rightAction) return leftAction - rightAction;
  return left.name.localeCompare(right.name);
};

const orderedChanges = (changes) => [...changes].sort(compareChangeOrder);

const kindItems = (items, kind) => {
  const matched = [];
  for (const item of items) {
    const rel = itemPath(item);
    const meta = depFileMeta(rel);
    if (meta && meta.kind === kind) matched.push(item);
  }
  return matched;
};

const readGroupSnapshot = (group, readSides) => {
  const origin = group.origin;
  const dir = group.dir;
  const groupItems = group.items;
  const manifestItems = kindItems(groupItems, 'manifest');
  const lockItems = kindItems(groupItems, 'lockfile');
  const manifestRel = relOf(dir, MANIFEST);
  const lockRel = relOf(dir, LOCKFILE);
  const manifestSides = readSides(origin, manifestRel);
  const lockSides = readSides(origin, lockRel);
  const oldPkg = parseJson(manifestSides.oldText);
  const newPkg = parseJson(manifestSides.newText);
  const oldLock = parseJson(lockSides.oldText);
  const newLock = parseJson(lockSides.newText);
  const parsedManifest = !!(oldPkg || newPkg);
  return {
    origin,
    dir,
    groupItems,
    manifestItems,
    lockItems,
    oldPkg,
    newPkg,
    oldLock,
    newLock,
    parsedManifest,
  };
};

const sectionMapsOf = (snapshot) => {
  if (snapshot.parsedManifest) {
    const oldMaps = readSections(snapshot.oldPkg);
    const newMaps = readSections(snapshot.newPkg);
    return { oldMaps, newMaps };
  }
  if (snapshot.manifestItems.length) {
    return mapsFromHunks(snapshot.manifestItems);
  }
  const oldMaps = lockRootSections(snapshot.oldLock);
  const newMaps = lockRootSections(snapshot.newLock);
  return { oldMaps, newMaps };
};

const comparedChanges = (snapshot) => {
  const maps = sectionMapsOf(snapshot);
  const oldMaps = maps.oldMaps;
  const newMaps = maps.newMaps;
  const manifestChanges = diffSections(oldMaps, newMaps);
  const parsed = snapshot.parsedManifest;
  let otherChanges = [];
  if (parsed) {
    otherChanges = diffOtherFields(snapshot.oldPkg, snapshot.newPkg);
  }
  const oldResolved = lockEntries(snapshot.oldLock);
  const newResolved = lockEntries(snapshot.newLock);
  const changes = mergeResolved(
    manifestChanges,
    oldResolved,
    newResolved,
    oldMaps,
    newMaps,
  );
  const oldCount = lockPackageCount(snapshot.oldLock);
  const newCount = lockPackageCount(snapshot.newLock);
  return { changes, otherChanges, oldCount, newCount };
};

const foldingPolicy = (snapshot, compared) => {
  const foldLock = snapshot.lockItems.length > 0;
  const hasDepChanges = compared.changes.length > 0;
  if (!snapshot.manifestItems.length) {
    const foldManifest = false;
    const takeAllManifest = false;
    return { foldLock, foldManifest, takeAllManifest };
  }
  if (snapshot.parsedManifest) {
    const foldManifest = hasDepChanges;
    const takeAllManifest = hasDepChanges && compared.otherChanges.length === 0;
    return { foldLock, foldManifest, takeAllManifest };
  }
  const foldManifest = hasDepChanges && onlyDepEdits(snapshot.manifestItems);
  const takeAllManifest = foldManifest;
  return { foldLock, foldManifest, takeAllManifest };
};

const summarizeGroup = (group, readSides) => {
  const snapshot = readGroupSnapshot(group, readSides);
  const compared = comparedChanges(snapshot);
  const policy = foldingPolicy(snapshot, compared);
  return {
    changes: compared.changes,
    oldCount: compared.oldCount,
    newCount: compared.newCount,
    foldLock: policy.foldLock,
    foldManifest: policy.foldManifest,
    takeAllManifest: policy.takeAllManifest,
    manifestItems: snapshot.manifestItems,
    lockItems: snapshot.lockItems,
    pkg: snapshot.newPkg || snapshot.oldPkg,
  };
};

const collectGroups = (items) => {
  const groups = new Map();
  for (const item of items) {
    const rel = itemPath(item);
    const meta = depFileMeta(rel);
    if (!meta) continue;
    const key = `${item.origin}\0${meta.dir}`;
    let group = groups.get(key);
    if (!group) {
      const dir = meta.dir;
      const origin = item.origin;
      group = { dir, origin, items: [] };
      groups.set(key, group);
    }
    group.items.push(item);
  }
  return groups;
};

const takeManifestItems = (summary) => {
  if (!summary.foldManifest) return [];
  if (summary.takeAllManifest) return [...summary.manifestItems];
  const taken = [];
  for (const item of summary.manifestItems) {
    if (onlyDepEdits([item])) taken.push(item);
  }
  return taken;
};

module.exports = {
  diffSections,
  mergeResolved,
  orderedChanges,
  summarizeGroup,
  collectGroups,
  takeManifestItems,
};
