'use strict';

const fs = require('node:fs');
const path = require('node:path');

const deps = require('../deps.js');
const { foldDepItems, mergeDepFile, depFileMeta } = deps;
const { parseAuditReport, parseOutdatedReport } = deps;
const { mergeProposedItems, MANIFEST, LOCKFILE } = deps;
const scan = require('../deps/scan.js');
const { collectUsedNames, collectExportMeta } = scan;
const { itemPath, isPathInScope } = require('../files.js');
const { abortError } = require('./proc.js');
const { oneLine, requireOk, runGit } = require('./run.js');
const read = require('./read.js');
const { gitText, worktreeText, readDepSides } = read;
const changes = require('./changes.js');
const npm = require('../npm/commands.js');
const { proposedNpmPlan, runNpm, runNpmAsync } = npm;
const { runNpmJson, runNpmJsonAsync, AUDIT_MS } = npm;

const depPaths = (item) => item.dep?.files ?? [];

const origDepItems = (item) => item.dep?.items ?? [];

const depChange = (item) => item.dep?.change ?? null;

const hasDepChange = (item) => !!depChange(item);

const hasProposed = (item) => {
  const change = depChange(item);
  return !!(change && change.propose);
};

const relatedFiles = (items) => {
  const files = [];
  for (const item of items) {
    for (const file of depPaths(item)) files.push(file);
  }
  return files;
};

const itemsForPath = (rel, items) => {
  const group = [];
  for (const item of items) {
    if (item.dep) {
      for (const orig of origDepItems(item)) {
        if (itemPath(orig) === rel) group.push(orig);
      }
      continue;
    }
    if (itemPath(item) === rel) group.push(item);
  }
  return group;
};

const hasDepFile = (items) => {
  for (const item of items) {
    if (depFileMeta(itemPath(item))) return true;
  }
  return false;
};

const collectAudit = (top) => {
  const lock = path.join(top, LOCKFILE);
  if (!fs.existsSync(lock)) return null;
  const args = ['audit', '--json', '--package-lock-only'];
  const text = runNpmJson(top, args, AUDIT_MS);
  return parseAuditReport(text);
};

const collectOutdated = (top) => {
  const manifest = path.join(top, MANIFEST);
  if (!fs.existsSync(manifest)) return null;
  const args = ['outdated', '--json', '--long'];
  const text = runNpmJson(top, args, AUDIT_MS);
  return parseOutdatedReport(text);
};

const collectAuditAsync = async (top, extra, signal) => {
  if (extra.auditMap !== undefined) return extra.auditMap;
  const lock = path.join(top, LOCKFILE);
  if (!fs.existsSync(lock)) return null;
  const args = ['audit', '--json', '--package-lock-only'];
  const text = await runNpmJsonAsync(top, args, AUDIT_MS, signal);
  return parseAuditReport(text);
};

const collectOutdatedAsync = async (top, extra, signal) => {
  if (extra.outdatedMap !== undefined) return extra.outdatedMap;
  const manifest = path.join(top, MANIFEST);
  if (!fs.existsSync(manifest)) return null;
  const args = ['outdated', '--json', '--long'];
  const text = await runNpmJsonAsync(top, args, AUDIT_MS, signal);
  return parseOutdatedReport(text);
};

const pickNpmMap = (override, collect, top) => {
  if (override !== undefined) return override;
  return collect(top);
};

const foldLoaded = (items, top, rev, extra = {}) => {
  const readSides = (origin, rel) => readDepSides(top, rev, origin, rel);
  const live = extra.audit === true && !rev;
  const hasDepDiff = hasDepFile(items);
  const collect = extra.collect !== false;
  let usedNames = extra.usedNames ?? null;
  let audit = extra.auditMap;
  let outdated = extra.outdatedMap;
  let exportEntries = extra.exportEntries;
  if (collect && usedNames === null && (hasDepDiff || live)) {
    usedNames = collectUsedNames(top);
  }
  if (collect && exportEntries === undefined && (hasDepDiff || live)) {
    exportEntries = collectExportMeta(top);
  }
  if (collect && live) {
    audit = pickNpmMap(extra.auditMap, collectAudit, top);
    outdated = pickNpmMap(extra.outdatedMap, collectOutdated, top);
  } else if (collect && extra.audit && hasDepDiff) {
    audit = pickNpmMap(extra.auditMap, collectAudit, top);
  }
  if (audit === undefined) audit = null;
  if (outdated === undefined) outdated = null;
  const folded = foldDepItems(items, readSides, usedNames, audit, outdated, {
    root: top,
    exportEntries,
  });
  if (!live) return folded;
  if (!isPathInScope(MANIFEST, extra.paths ?? [])) return folded;
  const pkgText = worktreeText(top, MANIFEST);
  const lockText = worktreeText(top, LOCKFILE);
  const options = { lockText, usedNames, root: top, exportEntries };
  return mergeProposedItems(folded, pkgText, outdated, audit, options);
};

const needsExtras = (parsed, rev, extra) => {
  const live = extra.audit === true && !rev;
  if (live) return true;
  if (!extra.audit) return false;
  return hasDepFile(parsed);
};

const finishLoad = (snapshot, extra) => {
  const options = { ...extra, paths: extra.paths ?? [] };
  if (extra.deferExtras) options.collect = false;
  const parsed = snapshot.parsed;
  const top = snapshot.top;
  const rev = snapshot.rev;
  const items = foldLoaded(parsed, top, rev, options);
  const pending = extra.deferExtras && needsExtras(parsed, rev, extra);
  return { ...snapshot, items, pending };
};

const usedNamesPromise = (parsed, rev, extra, top) => {
  const live = extra.audit === true && !rev;
  if (!live && !hasDepFile(parsed)) return Promise.resolve(null);
  return Promise.resolve().then(() => collectUsedNames(top));
};

const exportMetaPromise = (parsed, rev, extra, top) => {
  if (extra.exportEntries !== undefined) {
    return Promise.resolve(extra.exportEntries);
  }
  const live = extra.audit === true && !rev;
  if (!live && !hasDepFile(parsed)) return Promise.resolve(undefined);
  return Promise.resolve().then(() => collectExportMeta(top));
};

const extraTasksOf = (parsed, rev, extra, top, signal) => {
  const live = extra.audit === true && !rev;
  const hasDepDiff = hasDepFile(parsed);
  const usedTask = usedNamesPromise(parsed, rev, extra, top);
  const exportTask = exportMetaPromise(parsed, rev, extra, top);
  if (live) {
    const auditTask = collectAuditAsync(top, extra, signal);
    const outdatedTask = collectOutdatedAsync(top, extra, signal);
    return [usedTask, auditTask, outdatedTask, exportTask];
  }
  if (extra.audit && hasDepDiff) {
    const auditTask = collectAuditAsync(top, extra, signal);
    return [usedTask, auditTask, Promise.resolve(null), exportTask];
  }
  return [usedTask, Promise.resolve(null), Promise.resolve(null), exportTask];
};

const loadExtras = async (snapshot, extra = {}) => {
  const top = snapshot.top;
  const rev = snapshot.rev;
  const parsed = snapshot.parsed;
  const signal = extra.signal;
  const extras = await Promise.all(
    extraTasksOf(parsed, rev, extra, top, signal),
  );
  const usedNames = extras[0];
  const audit = extras[1];
  const outdated = extras[2];
  const exportEntries = extras[3];
  if (signal && signal.aborted) throw abortError();
  const folded = foldLoaded(parsed, top, rev, {
    ...extra,
    paths: extra.paths ?? [],
    usedNames,
    auditMap: audit,
    outdatedMap: outdated,
    exportEntries,
    collect: false,
  });
  return { ...snapshot, items: folded, pending: false };
};

const writeWorktreeFile = (top, rel, text) => {
  const abs = path.join(top, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
};

const captureFile = (top, rel) => {
  const abs = path.join(top, rel);
  try {
    const text = fs.readFileSync(abs, 'utf8');
    return { rel, existed: true, text };
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { rel, existed: false, text: '' };
    }
    throw error;
  }
};

const restoreFile = (top, saved) => {
  const abs = path.join(top, saved.rel);
  if (saved.existed) {
    fs.writeFileSync(abs, saved.text);
    return;
  }
  try {
    fs.unlinkSync(abs);
  } catch {
    // missing
  }
};

const captureFiles = (top, rels) => {
  const owned = [];
  for (const rel of rels) owned.push(captureFile(top, rel));
  return owned;
};

const restoreFiles = (top, owned) => {
  for (const saved of owned) restoreFile(top, saved);
};

const writeIndexFile = (top, rel, text) => {
  const saved = captureFile(top, rel);
  writeWorktreeFile(top, rel, text);
  try {
    requireOk(runGit(['add', '--', rel], top));
  } finally {
    restoreFile(top, saved);
  }
};

const mergeDepLive = (top, rel, change, origin, base, side, kind) => {
  const sides = readDepSides(top, null, origin, rel);
  return mergeDepFile(base, sides.oldText, sides.newText, change, side, kind);
};

const applyDepIndex = (top, rel, change, origin, side) => {
  const meta = depFileMeta(rel);
  if (!meta) return;
  const indexed = gitText(top, `:${rel}`) || gitText(top, `HEAD:${rel}`);
  const text = mergeDepLive(top, rel, change, origin, indexed, side, meta.kind);
  writeIndexFile(top, rel, text);
};

const applyDepWorktree = (top, rel, change, origin) => {
  const meta = depFileMeta(rel);
  if (!meta) return;
  const worktree = worktreeText(top, rel);
  const text = mergeDepLive(
    top,
    rel,
    change,
    origin,
    worktree,
    'old',
    meta.kind,
  );
  writeWorktreeFile(top, rel, text);
};

const ownedRelsOf = (plan) => {
  const rels = [];
  if (plan.manifest) rels.push(plan.manifest);
  if (plan.lockPath && plan.lockPath !== plan.manifest) {
    rels.push(plan.lockPath);
  }
  return rels;
};

const resultFailed = (result) =>
  !!(result && (result.error || result.status !== 0));

const errorFromResult = (result, fail) => {
  if (!result) return new Error(fail);
  if (result.error) {
    const msg = result.error.message || fail;
    return new Error(oneLine(msg, fail));
  }
  const msg = result.stderr || result.stdout || fail;
  return new Error(oneLine(msg, fail));
};

const applyPreparation = (top, item, plan) => {
  if (!plan.prepareManifest || !plan.manifest) return;
  const change = depChange(item);
  const origin = item.origin;
  const worktree = worktreeText(top, plan.manifest);
  const text = mergeDepLive(
    top,
    plan.manifest,
    change,
    origin,
    worktree,
    'new',
    'manifest',
  );
  writeWorktreeFile(top, plan.manifest, text);
};

const stagePlan = (top, plan) => {
  const toAdd = [];
  if (!plan.lockOnly && plan.manifest) toAdd.push(plan.manifest);
  if (fs.existsSync(path.join(top, plan.lockPath))) toAdd.push(plan.lockPath);
  if (!toAdd.length) return;
  requireOk(runGit(['add', '--', ...toAdd], top));
};

const finishPlan = (top, plan, result, stage) => {
  if (resultFailed(result)) throw errorFromResult(result, plan.fail);
  const stageFn = stage ?? stagePlan;
  stageFn(top, plan);
};

const syncInstaller = (plan, extra) => {
  if (extra.run) return extra.run;
  if (plan.runner) return plan.runner;
  return (dir) => runNpm(dir, plan.npmArgs);
};

const asyncInstaller = (plan, extra) => {
  if (extra.run) return extra.run;
  if (plan.runner) return (dir) => Promise.resolve(plan.runner(dir));
  return (dir) => runNpmAsync(dir, plan.npmArgs);
};

const applyProposedUpdate = (top, item, extra = {}) => {
  const plan = proposedNpmPlan(top, item);
  if (!plan) return;
  const owned = captureFiles(top, ownedRelsOf(plan));
  try {
    applyPreparation(top, item, plan);
    const install = syncInstaller(plan, extra);
    const result = install(plan.cwd);
    finishPlan(top, plan, result, extra.stage);
  } catch (error) {
    restoreFiles(top, owned);
    throw error;
  }
};

const applyProposedUpdateAsync = async (top, item, extra = {}) => {
  const plan = proposedNpmPlan(top, item);
  if (!plan) return;
  const owned = captureFiles(top, ownedRelsOf(plan));
  try {
    applyPreparation(top, item, plan);
    const run = asyncInstaller(plan, extra);
    const result = await run(plan.cwd);
    finishPlan(top, plan, result, extra.stage);
  } catch (error) {
    restoreFiles(top, owned);
    throw error;
  }
};

const applyDepChange = (top, item, mode) => {
  const change = depChange(item);
  if (change && change.propose) {
    if (mode === 'add') return void applyProposedUpdate(top, item);
    if (!change.unused) return;
  }
  const origin = item.origin;
  const files = depPaths(item);
  for (const rel of files) {
    if (mode === 'add') {
      applyDepIndex(top, rel, change, origin, 'new');
      continue;
    }
    if (mode === 'unstage') {
      applyDepIndex(top, rel, change, origin, 'old');
      continue;
    }
    if (origin === 'staged') applyDepIndex(top, rel, change, origin, 'old');
    applyDepWorktree(top, rel, change, origin);
  }
};

const addItem = (top, item) => {
  if (item.origin === 'staged' || item.origin === 'commit') return;
  if (depChange(item)) {
    applyDepChange(top, item, 'add');
    return;
  }
  const files = depPaths(item);
  if (files.length) {
    requireOk(runGit(['add', '--', ...files], top));
  }
};

const addItemAsync = async (top, item) => {
  if (item.origin === 'staged' || item.origin === 'commit') return;
  if (hasProposed(item)) {
    await applyProposedUpdateAsync(top, item);
    return;
  }
  addItem(top, item);
};

const unstageItem = (top, item) => {
  if (item.origin !== 'staged') return;
  if (depChange(item)) {
    applyDepChange(top, item, 'unstage');
    return;
  }
  const files = depPaths(item);
  if (files.length) {
    requireOk(runGit(['restore', '--staged', '--', ...files], top));
  }
};

const revertDepItem = (top, item) => {
  if (depChange(item)) {
    applyDepChange(top, item, 'revert');
    return;
  }
  const byPath = new Map();
  for (const orig of origDepItems(item)) {
    const rel = itemPath(orig);
    const list = byPath.get(rel);
    if (list) list.push(orig);
    else byPath.set(rel, [orig]);
  }
  for (const rel of byPath.keys()) {
    changes.revertOnePath(top, rel, byPath.get(rel));
  }
};

const revertFile = (top, rel, items) => {
  const paths = new Set([rel]);
  for (const file of relatedFiles(items)) paths.add(file);
  for (const file of paths) {
    const group = itemsForPath(file, items);
    const targets = group.length ? group : items;
    changes.revertOnePath(top, file, targets);
  }
};

const handles = (item) => !!(item && item.dep);

module.exports = {
  hasDepChange,
  hasProposed,
  handles,
  relatedFiles,
  itemsForPath,
  finishLoad,
  loadExtras,
  captureFile,
  restoreFile,
  applyProposedUpdate,
  applyProposedUpdateAsync,
  applyDepChange,
  addItem,
  addItemAsync,
  unstageItem,
  revertDepItem,
  revertFile,
};
