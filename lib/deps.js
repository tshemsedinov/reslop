'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { itemPath } = require('./files.js');
const { countSides } = require('./diff.js');

const MANIFEST = 'package.json';
const LOCKFILE = 'package-lock.json';
const DEP_KIND = {
  [MANIFEST]: 'manifest',
  [LOCKFILE]: 'lockfile',
};
const SECTIONS = {
  dependencies: 'dependency',
  devDependencies: 'devDependency',
  optionalDependencies: 'optionalDependency',
  peerDependencies: 'peerDependency',
};
const SECTION_KEYS = Object.keys(SECTIONS);
const ACTION_TITLE = {
  added: 'added',
  removed: 'removed',
  changed: 'version changed',
  vulnerable: 'vulnerable',
};
const SECTION_ORDER = [...SECTION_KEYS, 'resolved', 'field'];
const ACTION_ORDER = ['added', 'removed', 'changed', 'vulnerable'];
const SECTION_NAMES = SECTION_KEYS.join('|');
const SECTION_OPEN = new RegExp(`^\\s*"(${SECTION_NAMES})"\\s*:\\s*\\{\\s*$`);
const SECTION_END = /^\s*\},?\s*$/;
const DEP_ENTRY = /^\s*"([^"]+)"\s*:\s*"([^"]*)"\s*,?\s*$/;
const DEP_CAPTION = 'Dependencies in package.json & package-lock.json';
const SKIP_WALK = ['node_modules', '.git', '.review', 'coverage', 'dist'];
const SOURCE_EXT = ['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts'];
const REQUIRE_SPEC = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
const FROM_SPEC = /\bfrom\s+['"]([^'"]+)['"]/g;
const IMPORT_FILE = /import\s+['"]([^'"]+)['"]/g;
const IMPORT_CALL = /import\(\s*['"]([^'"]+)['"]\s*\)/g;
const SEVERITY_RANK = {
  critical: 4,
  high: 3,
  moderate: 2,
  low: 1,
  info: 0,
};

const noSides = () => ({ oldText: '', newText: '' });

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
  for (const [name, version] of Object.entries(raw)) {
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
    for (const [key, entry] of Object.entries(packages)) {
      if (!key.startsWith('node_modules/')) continue;
      if (key.includes('/node_modules/')) continue;
      if (!entry || typeof entry.version !== 'string') continue;
      const name = key.slice('node_modules/'.length);
      versions.set(name, entry.version);
    }
  }
  const deps = lock.dependencies;
  if (!deps || typeof deps !== 'object') return versions;
  for (const [name, entry] of Object.entries(deps)) {
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
    let n = 0;
    for (const key of Object.keys(packages)) {
      if (key !== '') n += 1;
    }
    return n;
  }
  const deps = lock.dependencies;
  if (!deps || typeof deps !== 'object') return 0;
  return Object.keys(deps).length;
};

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
  if (typeof value === 'number' || typeof value === 'boolean') {
    return `${value}`;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
};

const sameJson = (left, right) => {
  try {
    const leftText = JSON.stringify(left);
    const rightText = JSON.stringify(right);
    return leftText === rightText;
  } catch {
    return false;
  }
};

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

const applyManifestChange = (pkg, change, side) => {
  if (!pkg) return pkg;
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
  const takeNew = side === 'new';
  const dropAdded = !takeNew && change.action === 'added';
  const dropRemoved = takeNew && change.action === 'removed';
  const version = dropAdded || dropRemoved ? '' : value;
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
  const takeNew = side === 'new';
  const dropAdded = !takeNew && change.action === 'added';
  const dropRemoved = takeNew && change.action === 'removed';
  if (dropAdded || dropRemoved) {
    delete deps[change.name];
    return;
  }
  const srcDeps = src && src.dependencies;
  if (!srcDeps || typeof srcDeps !== 'object') return;
  const entry = srcDeps[change.name];
  if (entry) deps[change.name] = cloneJson(entry);
};

const applyLockChange = (lock, change, side, oldLock, newLock) => {
  if (!lock) return lock;
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
  const takeNew = side === 'new';
  const dropAdded = !takeNew && change.action === 'added';
  const dropRemoved = takeNew && change.action === 'removed';
  if (dropAdded || dropRemoved) {
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
  for (const [key, value] of Object.entries(newObj)) {
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

const mergeResolved = (
  manifest,
  oldResolved,
  newResolved,
  oldMaps,
  newMaps,
) => {
  const seen = new Set();
  const changes = [];
  for (const change of manifest) {
    seen.add(change.name);
    const resolvedFrom = oldResolved.get(change.name) ?? '';
    const resolvedTo = newResolved.get(change.name) ?? '';
    changes.push({ ...change, resolvedFrom, resolvedTo });
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
    changes.push({ name, section, action, from, to, resolvedFrom, resolvedTo });
  }
  return changes;
};

const kindItems = (items, kind) => {
  const matched = [];
  for (const item of items) {
    const rel = itemPath(item);
    const meta = depFileMeta(rel);
    if (meta && meta.kind === kind) matched.push(item);
  }
  return matched;
};

const uniquePaths = (items) => {
  const files = [];
  const seen = new Set();
  for (const item of items) {
    const rel = itemPath(item);
    if (!rel || seen.has(rel)) continue;
    seen.add(rel);
    files.push(rel);
  }
  return files;
};

const filesForChange = (change, files) => {
  const manifest = [];
  const lockfile = [];
  for (const rel of files) {
    const meta = depFileMeta(rel);
    if (!meta) continue;
    if (meta.kind === 'manifest') manifest.push(rel);
    else lockfile.push(rel);
  }
  if (change.propose) {
    if (manifest.length) return manifest;
    return files;
  }
  if (change.section === 'field') {
    if (manifest.length) return manifest;
    return files;
  }
  if (change.section === 'resolved') {
    if (lockfile.length) return lockfile;
    return files;
  }
  const both = [...manifest, ...lockfile];
  if (both.length) return both;
  return files;
};

const bucketKey = (change) => `${change.section}\0${change.action}`;

const compareBuckets = (left, right) => {
  const section = SECTION_ORDER.indexOf(left.section);
  const other = SECTION_ORDER.indexOf(right.section);
  if (section !== other) return section - other;
  const leftAction = ACTION_ORDER.indexOf(left.action);
  const rightAction = ACTION_ORDER.indexOf(right.action);
  return leftAction - rightAction;
};

const groupChanges = (changes) => {
  const buckets = [];
  const index = new Map();
  for (const change of changes) {
    const key = bucketKey(change);
    let bucket = index.get(key);
    if (!bucket) {
      const section = change.section;
      const action = change.action;
      const items = [];
      bucket = { section, action, items };
      index.set(key, bucket);
      buckets.push(bucket);
    }
    bucket.items.push(change);
  }
  for (const bucket of buckets) {
    bucket.items.sort((a, b) => a.name.localeCompare(b.name));
  }
  buckets.sort(compareBuckets);
  return buckets;
};

const changeMarks = (change) => {
  const marks = [];
  if (change.unused) marks.push('unused');
  if (change.outdated && !change.propose) marks.push('outdated');
  if (change.audit) marks.push(change.audit.severity);
  return marks;
};

const changeSources = (change) => {
  const sources = [];
  if (change.propose && change.outdated) sources.push('npm outdated');
  if (change.audit) sources.push('npm audit');
  return sources;
};

const sectionTitle = (section, action, marks, sources) => {
  const title = ACTION_TITLE[action] ?? action;
  let label = `${SECTIONS[section] ?? section} ${title}`;
  if (section === 'field') label = `package.json ${title}`;
  if (section === 'resolved') label = `lockfile resolved ${title}`;
  if (marks.length) label = `${label}, ${marks.join(', ')}`;
  if (!sources.length) return label;
  return `${sources.join(', ')}: ${label}`;
};

const entryText = (change, side) => {
  const version = side === 'old' ? change.from : change.to;
  return `"${change.name}": "${version}"`;
};

const ctxLine = (text) => {
  const type = 'ctx';
  return { type, text };
};

const changeLine = (type, change, side) => {
  const text = entryText(change, side);
  return { type, text };
};

const pushChangeLines = (rows, change) => {
  if (change.action === 'added') {
    rows.push(changeLine('add', change, 'new'));
    return;
  }
  if (change.action === 'removed') {
    rows.push(changeLine('del', change, 'old'));
    return;
  }
  if (change.from === change.to) {
    rows.push(changeLine('ctx', change, 'old'));
    return;
  }
  rows.push(changeLine('del', change, 'old'));
  rows.push(changeLine('add', change, 'new'));
};

const lockCountText = (oldCount, newCount) => {
  if (oldCount === newCount) return '';
  return `lockfile packages  ${oldCount} → ${newCount}`;
};

const buildRows = (changes, oldCount, newCount) => {
  const rows = [ctxLine(DEP_CAPTION), ctxLine('')];
  const buckets = groupChanges(changes);
  for (const bucket of buckets) {
    if (rows.length && rows.at(-1).text !== '') rows.push(ctxLine(''));
    const marks = [];
    const sources = [];
    for (const change of bucket.items) {
      for (const mark of changeMarks(change)) {
        if (!marks.includes(mark)) marks.push(mark);
      }
      for (const source of changeSources(change)) {
        if (!sources.includes(source)) sources.push(source);
      }
    }
    const title = sectionTitle(bucket.section, bucket.action, marks, sources);
    rows.push(ctxLine(title));
    for (const change of bucket.items) {
      pushChangeLines(rows, change);
      const audit = change.audit;
      if (!audit) continue;
      const severity = audit.severity;
      const hint = audit.title;
      const line = hint
        ? `npm audit  ${severity}  ${hint}`
        : `npm audit  ${severity}`;
      rows.push(ctxLine(line));
    }
  }
  const countLine = lockCountText(oldCount, newCount);
  if (countLine) {
    if (rows.length && rows.at(-1).text !== '') rows.push(ctxLine(''));
    rows.push(ctxLine(countLine));
  }
  if (!changes.length && !countLine) rows.push(ctxLine('lockfile updated'));
  return rows;
};

const toHunkLine = (row, blockId) => {
  const type = row.type;
  const text = row.text;
  const noNl = false;
  const id = type === 'ctx' ? null : blockId;
  return { type, text, noNl, blockId: id };
};

const makeHunk = (rows, blockId) => {
  const lines = rows.map((row) => toHunkLine(row, blockId));
  const counts = countSides(lines);
  const oldCount = counts.oldCount;
  const newCount = counts.newCount;
  const header = `@@ -1,${oldCount} +1,${newCount} @@`;
  return { oldStart: 1, oldCount, newStart: 1, newCount, header, lines };
};

const orderedChanges = (changes) => {
  const buckets = groupChanges(changes);
  const ordered = [];
  for (const bucket of buckets) {
    for (const change of bucket.items) ordered.push(change);
  }
  return ordered;
};

const pickPrimary = (items) => {
  for (const item of items) {
    const rel = itemPath(item);
    const meta = depFileMeta(rel);
    if (meta && meta.kind === 'manifest') return item;
  }
  return items[0];
};

const makeDepItem = (origin, fileItems, hidden, change, extra, blockId) => {
  const allFiles = uniquePaths(fileItems);
  const files = change ? filesForChange(change, allFiles) : allFiles;
  const changes = change ? [change] : [];
  const primary = pickPrimary(fileItems);
  const oldPath = itemPath(primary);
  const newPath = oldPath;
  const isNew = fileItems.some((item) => item.file && item.file.isNew);
  const isDeleted = fileItems.every((item) => item.file && item.file.isDeleted);
  let oldCount = 0;
  let newCount = 0;
  if (!change) {
    oldCount = extra.oldCount ?? 0;
    newCount = extra.newCount ?? 0;
  }
  const rows = buildRows(changes, oldCount, newCount);
  const hunk = makeHunk(rows, blockId);
  const isBinary = false;
  const preamble = [];
  const hunks = [hunk];
  const file = {
    oldPath,
    newPath,
    isNew,
    isDeleted,
    isBinary,
    preamble,
    hunks,
  };
  const patchAdd = '';
  const patchRevert = '';
  const items = hidden;
  const dep = { files, items, change };
  return { origin, file, hunk, blockId, patchAdd, patchRevert, dep };
};

const makeDepItems = (origin, fileItems, hidden, summary) => {
  const ordered = orderedChanges(summary.changes);
  if (!ordered.length) {
    return [makeDepItem(origin, fileItems, hidden, null, summary, 0)];
  }
  const items = [];
  let blockId = 0;
  for (const change of ordered) {
    const made = makeDepItem(
      origin,
      fileItems,
      hidden,
      change,
      summary,
      blockId,
    );
    items.push(made);
    blockId += 1;
  }
  return items;
};

const summarizeGroup = (group, readSides) => {
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
  let oldMaps;
  let newMaps;
  if (parsedManifest) {
    oldMaps = readSections(oldPkg);
    newMaps = readSections(newPkg);
  } else if (manifestItems.length) {
    const parsed = mapsFromHunks(manifestItems);
    oldMaps = parsed.oldMaps;
    newMaps = parsed.newMaps;
  } else {
    oldMaps = lockRootSections(oldLock);
    newMaps = lockRootSections(newLock);
  }
  const manifestChanges = diffSections(oldMaps, newMaps);
  const otherChanges = parsedManifest ? diffOtherFields(oldPkg, newPkg) : [];
  const oldResolved = lockEntries(oldLock);
  const newResolved = lockEntries(newLock);
  const changes = mergeResolved(
    manifestChanges,
    oldResolved,
    newResolved,
    oldMaps,
    newMaps,
  );
  const oldCount = lockPackageCount(oldLock);
  const newCount = lockPackageCount(newLock);
  const foldLock = lockItems.length > 0;
  const hasDepChanges = changes.length > 0;
  const hunkOnlyDeps =
    !parsedManifest && hasDepChanges && onlyDepEdits(manifestItems);
  let foldManifest = false;
  let takeAllManifest = false;
  if (manifestItems.length) {
    if (parsedManifest) {
      foldManifest = hasDepChanges;
      takeAllManifest = hasDepChanges && otherChanges.length === 0;
    } else {
      foldManifest = hunkOnlyDeps;
      takeAllManifest = hunkOnlyDeps;
    }
  }
  return {
    changes,
    oldCount,
    newCount,
    foldLock,
    foldManifest,
    takeAllManifest,
    manifestItems,
    lockItems,
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
      const items = [];
      group = { dir, origin, items };
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
  pattern.lastIndex = 0;
  let match = pattern.exec(text);
  while (match) {
    addSpec(used, match[1]);
    match = pattern.exec(text);
  }
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

const markUnusedChanges = (changes, used) => {
  if (!used) return;
  for (const change of changes) {
    if (change.action !== 'added') continue;
    if (change.section === 'resolved') continue;
    if (change.section === 'field') continue;
    change.unused = !used.has(change.name);
  }
};

const viaTitle = (via) => {
  if (!Array.isArray(via)) return '';
  for (const item of via) {
    if (!item || typeof item !== 'object') continue;
    if (typeof item.title === 'string' && item.title) return item.title;
  }
  return '';
};

const severityRank = (severity) => SEVERITY_RANK[severity] ?? 0;

const auditFix = (entry) => {
  const available = entry.fixAvailable;
  if (!available || typeof available !== 'object') return '';
  if (typeof available.version !== 'string') return '';
  return available.version;
};

const auditEntryNames = (key, entry) => {
  const names = [];
  const primary = entry.name || key;
  if (primary) names.push(primary);
  const effects = entry.effects;
  if (!Array.isArray(effects)) return names;
  for (const effect of effects) {
    if (typeof effect === 'string' && effect) names.push(effect);
  }
  return names;
};

const keepHighestAudit = (audit, name, severity, title, fix) => {
  if (!name || !severity || severity === 'info') return;
  const prev = audit.get(name);
  if (prev && severityRank(prev.severity) >= severityRank(severity)) {
    if (!prev.fix && fix) prev.fix = fix;
    return;
  }
  audit.set(name, { severity, title, fix: fix || '' });
};

const parseAuditReport = (text) => {
  const audit = new Map();
  if (!text || !`${text}`.trim()) return audit;
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return audit;
  }
  if (!data || typeof data !== 'object') return audit;
  const vulns = data.vulnerabilities;
  if (vulns && typeof vulns === 'object') {
    for (const [key, entry] of Object.entries(vulns)) {
      if (!entry || typeof entry !== 'object') continue;
      const severity = entry.severity;
      const title = viaTitle(entry.via);
      const fix = auditFix(entry);
      const names = auditEntryNames(key, entry);
      for (const name of names) {
        keepHighestAudit(audit, name, severity, title, fix);
      }
    }
  }
  const advisories = data.advisories;
  if (advisories && typeof advisories === 'object') {
    for (const entry of Object.values(advisories)) {
      if (!entry || typeof entry !== 'object') continue;
      const name = entry.module_name || entry.name;
      const severity = entry.severity;
      const title = typeof entry.title === 'string' ? entry.title : '';
      const fix = auditFix(entry);
      keepHighestAudit(audit, name, severity, title, fix);
    }
  }
  return audit;
};

const parseOutdatedReport = (text) => {
  const outdated = new Map();
  if (!text || !`${text}`.trim()) return outdated;
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return outdated;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return outdated;
  for (const [name, entry] of Object.entries(data)) {
    if (!entry || typeof entry !== 'object') continue;
    const current = typeof entry.current === 'string' ? entry.current : '';
    const wanted = typeof entry.wanted === 'string' ? entry.wanted : '';
    const latest = typeof entry.latest === 'string' ? entry.latest : '';
    const type = typeof entry.type === 'string' ? entry.type : '';
    if (!wanted) continue;
    outdated.set(name, { current, wanted, latest, type });
  }
  return outdated;
};

const applyWantedRange = (declared, wanted) => {
  if (!wanted) return declared ?? '';
  if (!declared) return wanted;
  if (/^(file:|git[+@:]|workspace:|https?:|npm:)/.test(declared)) {
    return declared;
  }
  if (declared.includes(' ') || declared.includes('|')) return declared;
  if (declared.includes('<') || declared.includes('>')) return declared;
  const prefix = declared.startsWith('^') || declared.startsWith('~');
  const mark = prefix ? declared[0] : '';
  return `${mark}${wanted}`;
};

const findDeclared = (pkg, name, type) => {
  if (type && SECTION_KEYS.includes(type)) {
    const map = pkg[type];
    if (map && typeof map[name] === 'string') {
      return { section: type, version: map[name] };
    }
  }
  for (const section of SECTION_KEYS) {
    const map = pkg[section];
    if (map && typeof map[name] === 'string') {
      return { section, version: map[name] };
    }
  }
  return null;
};

const proposedWanted = (out, vul) => {
  if (out && out.wanted && out.wanted !== out.current) return out.wanted;
  if (vul && vul.fix) return vul.fix;
  return '';
};

const buildProposedChanges = (pkg, outdated, audit) => {
  const names = new Set();
  if (outdated) {
    for (const name of outdated.keys()) names.add(name);
  }
  if (audit) {
    for (const name of audit.keys()) names.add(name);
  }
  const listed = [...names];
  listed.sort();
  const changes = [];
  for (const name of listed) {
    const out = outdated ? outdated.get(name) : null;
    const vul = audit ? audit.get(name) : null;
    const type = out ? out.type : '';
    const declared = findDeclared(pkg, name, type);
    if (!declared) continue;
    const wanted = proposedWanted(out, vul);
    if (!wanted && !vul) continue;
    const to = wanted
      ? applyWantedRange(declared.version, wanted)
      : declared.version;
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

const stubFileItem = (rel, origin) => {
  const file = {
    oldPath: rel,
    newPath: rel,
    isNew: false,
    isDeleted: false,
    isBinary: false,
    preamble: [],
    hunks: [],
  };
  const hunk = null;
  const blockId = 0;
  const patchAdd = '';
  const patchRevert = '';
  return { origin, file, hunk, blockId, patchAdd, patchRevert };
};

const proposeDepItems = (pkgText, outdated, audit, extra = {}) => {
  const origin = extra.origin ?? 'unstaged';
  const dir = extra.dir ?? '.';
  const pkg = parseJson(pkgText);
  if (!pkg) return [];
  const changes = buildProposedChanges(pkg, outdated, audit);
  if (!changes.length) return [];
  const rel = relOf(dir, MANIFEST);
  const stub = stubFileItem(rel, origin);
  const summary = { changes, oldCount: 0, newCount: 0 };
  return makeDepItems(origin, [stub], [], summary);
};

const markAuditChanges = (changes, audit) => {
  if (!audit) return;
  for (const change of changes) {
    if (change.action === 'removed') continue;
    if (change.section === 'field') continue;
    const found = audit.get(change.name);
    if (found) change.audit = found;
  }
};

const markOutdatedChanges = (changes, outdated) => {
  if (!outdated) return;
  for (const change of changes) {
    if (change.action === 'removed') continue;
    if (change.section === 'field') continue;
    const found = outdated.get(change.name);
    if (!found) continue;
    if (found.wanted && found.wanted === found.current) continue;
    change.outdated = found;
  }
};

const foldDepItems = (
  items,
  readSides = noSides,
  usedNames = null,
  audit = null,
  outdated = null,
) => {
  const groups = collectGroups(items);
  if (!groups.size) return items;
  const folded = new Set();
  const synthetic = new Map();
  for (const [key, group] of groups) {
    const summary = summarizeGroup(group, readSides);
    markUnusedChanges(summary.changes, usedNames);
    markAuditChanges(summary.changes, audit);
    markOutdatedChanges(summary.changes, outdated);
    const taken = takeManifestItems(summary);
    if (summary.foldLock) {
      for (const item of summary.lockItems) taken.push(item);
    }
    if (!taken.length && !summary.changes.length) continue;
    const made = makeDepItems(group.origin, group.items, taken, summary);
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

const mergeProposedItems = (items, pkgText, outdated, audit) => {
  const proposed = proposeDepItems(pkgText, outdated, audit);
  if (!proposed.length) return items;
  const taken = new Set();
  for (const item of items) {
    const change = item.dep && item.dep.change;
    if (change) taken.add(change.name);
  }
  const extra = [];
  for (const item of proposed) {
    const change = item.dep && item.dep.change;
    if (!change || taken.has(change.name)) continue;
    extra.push(item);
  }
  if (!extra.length) return items;
  return [...items, ...extra];
};

module.exports = {
  depFileMeta,
  readSections,
  diffSections,
  lockEntries,
  lockPackageCount,
  mergeResolved,
  mergeDepFile,
  collectUsedNames,
  parseAuditReport,
  parseOutdatedReport,
  applyWantedRange,
  proposeDepItems,
  mergeProposedItems,
  foldDepItems,
};
