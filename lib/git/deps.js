'use strict';

const fs = require('node:fs');
const path = require('node:path');

const deps = require('../deps/deps.js');
const { foldDepItems, mergeProposedItems } = deps;
const { parseAuditReport, parseOutdatedReport } = deps;
const { collectUsedNames, collectExportMeta } = deps;
const { collectGroups } = require('../deps/diff.js');
const manifest = require('../deps/manifest.js');
const { MANIFEST, LOCKFILE, depFileMeta, mergeDepFile, relOf } = manifest;
const { itemPath, isPathInScope } = require('../common/files.js');
const utilities = require('../common/utilities.js');
const {
  INSTALL_MS,
  IS_WIN,
  abortError,
  npmBin,
  runProc,
} = require('../common/process.js');
const { oneLine } = utilities;
const worktree = require('./worktree.js');
const { gitOk, indexedText, worktreeText, readDepSides } = worktree;
const { revertOnePath, groupByPath, writeFile, writeIndex } = worktree;

const AUDIT_MS = 15000;

const NPM_REPORT = {
  audit: {
    file: LOCKFILE,
    args: ['audit', '--json', '--package-lock-only'],
    parse: parseAuditReport,
  },
  outdated: {
    file: MANIFEST,
    args: ['outdated', '--json', '--long'],
    parse: parseOutdatedReport,
  },
};

const npmOptions = (cwd, timeout, signal) => ({
  cwd,
  timeout,
  signal,
  shell: IS_WIN,
});

const runNpm = (cwd, args) =>
  runProc(npmBin(), args, npmOptions(cwd, INSTALL_MS));

const npmOutput = (result) => (result.error ? '' : result.stdout);

const collectReport = async (top, kind, signal) => {
  const report = NPM_REPORT[kind];
  if (!fs.existsSync(path.join(top, report.file))) return null;
  const options = npmOptions(top, AUDIT_MS, signal);
  const result = await runProc(npmBin(), report.args, options);
  return report.parse(npmOutput(result));
};

const depPaths = (item) => item.dep?.files ?? [];

const depChange = (item) => item.dep?.change ?? null;

const isStagedOrCommit = (item) => {
  const staged = item.origin === 'staged';
  const commit = item.origin === 'commit';
  return staged || commit;
};

const firstDepRel = (rels, kind) => {
  const match = (rel) => depFileMeta(rel)?.kind === kind;
  return rels.find(match) ?? '';
};

const proposedNpmPlan = (top, item) => {
  const change = depChange(item);
  if (!change) return null;
  const rels = depPaths(item);
  const lockOnly = change.section === 'resolved';
  const removing = !!change.unused;
  const manifestRel = firstDepRel(rels, 'manifest');
  const lockRel = firstDepRel(rels, 'lockfile');
  const meta = depFileMeta((lockOnly ? lockRel : manifestRel) || rels[0]);
  if (!meta) return null;
  let npmArgs = ['i'];
  if (removing) npmArgs = ['uninstall', change.name];
  else if (lockOnly) npmArgs = ['audit', 'fix'];
  return {
    cwd: meta.dir === '.' ? top : path.join(top, meta.dir),
    npmArgs,
    fail: removing ? 'npm uninstall failed' : 'npm i failed',
    lockOnly,
    lockPath: lockRel || relOf(meta.dir, LOCKFILE),
    manifest: manifestRel,
    prepareManifest: !lockOnly && !removing && !!manifestRel,
    runner: item.dep.install,
  };
};

const itemsForPath = (rel, items) => {
  const group = [];
  for (const item of items) {
    const listed = item.dep ? item.dep.items : [item];
    for (const entry of listed ?? []) {
      if (itemPath(entry) === rel) group.push(entry);
    }
  }
  return group;
};

const extrasNeeds = (items, rev, extra) => {
  const live = extra.audit === true && !rev;
  const hasDepDiff = items.some((item) => depFileMeta(itemPath(item)));
  const audit = live || (Boolean(extra.audit) && hasDepDiff);
  return { live, scan: live || hasDepDiff, audit };
};

const NO_SIDES = { oldText: '', newText: '' };

const sidesReader = async (items, top, rev) => {
  const sides = new Map();
  const reads = [];
  for (const group of collectGroups(items).values()) {
    for (const name of [MANIFEST, LOCKFILE]) {
      const rel = relOf(group.dir, name);
      const key = `${group.origin}\0${rel}`;
      const keep = (found) => sides.set(key, found);
      reads.push(readDepSides(top, rev, group.origin, rel).then(keep));
    }
  }
  await Promise.all(reads);
  return (origin, rel) => sides.get(`${origin}\0${rel}`) ?? NO_SIDES;
};

const foldLoaded = async (items, top, rev, extra) => {
  const readSides = await sidesReader(items, top, rev);
  const needs = extrasNeeds(items, rev, extra);
  const collect = extra.collect !== false;
  const scan = collect && needs.scan;
  const usedNames = extra.usedNames ?? (scan ? collectUsedNames(top) : null);
  let { exportEntries, auditMap: audit, outdatedMap: outdated } = extra;
  if (scan && exportEntries === undefined) {
    exportEntries = collectExportMeta(top);
  }
  if (collect && needs.audit && audit === undefined) {
    audit = await collectReport(top, 'audit', extra.signal);
  }
  if (collect && needs.live && outdated === undefined) {
    outdated = await collectReport(top, 'outdated', extra.signal);
  }
  audit ??= null;
  outdated ??= null;
  const folded = foldDepItems(items, readSides, usedNames, audit, outdated, {
    root: top,
    exportEntries,
  });
  if (!needs.live || !isPathInScope(MANIFEST, extra.paths)) return folded;
  const texts = [worktreeText(top, MANIFEST), worktreeText(top, LOCKFILE)];
  const [pkgText, lockText] = await Promise.all(texts);
  const options = { lockText, usedNames, root: top, exportEntries };
  return mergeProposedItems(folded, pkgText, outdated, audit, options);
};

const finishLoad = async (snapshot, extra) => {
  const { top, rev, parsed } = snapshot;
  const options = { ...extra, collect: !extra.deferExtras };
  const items = await foldLoaded(parsed, top, rev, options);
  const pending = extra.deferExtras && extrasNeeds(parsed, rev, extra).audit;
  return { ...snapshot, items, pending };
};

const later = (fn) => Promise.resolve().then(fn);

const reportTask = (wanted, known, collect) => {
  if (!wanted) return null;
  return known === undefined ? collect() : known;
};

const loadExtras = async (snapshot, extra = {}) => {
  const { top, rev, parsed } = snapshot;
  const { signal } = extra;
  const needs = extrasNeeds(parsed, rev, extra);
  const known = extra.exportEntries;
  let exportMeta = known;
  if (known === undefined && needs.scan) {
    exportMeta = later(() => collectExportMeta(top));
  }
  const [usedNames, audit, outdated, exportEntries] = await Promise.all([
    needs.scan ? later(() => collectUsedNames(top)) : null,
    reportTask(needs.audit, extra.auditMap, () =>
      collectReport(top, 'audit', signal),
    ),
    reportTask(needs.live, extra.outdatedMap, () =>
      collectReport(top, 'outdated', signal),
    ),
    exportMeta,
  ]);
  if (signal && signal.aborted) throw abortError();
  const found = { usedNames, auditMap: audit, outdatedMap: outdated };
  const items = await foldLoaded(parsed, top, rev, {
    ...extra,
    ...found,
    paths: extra.paths ?? [],
    exportEntries,
    collect: false,
  });
  return { ...snapshot, items, pending: false, ...found, exportEntries };
};

const captureFile = (top, rel) => {
  try {
    const text = fs.readFileSync(path.join(top, rel), 'utf8');
    return { rel, existed: true, text };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return { rel, existed: false, text: '' };
  }
};

const restoreFile = (top, saved) => {
  const abs = path.join(top, saved.rel);
  if (saved.existed) fs.writeFileSync(abs, saved.text);
  else fs.rmSync(abs, { force: true });
};

const mergeLive = async (top, rel, item, base, side) => {
  const sides = await readDepSides(top, null, item.origin, rel);
  const { kind } = depFileMeta(rel);
  const change = depChange(item);
  return mergeDepFile(base, sides.oldText, sides.newText, change, side, kind);
};

const applyDepIndex = async (top, rel, item, side) => {
  if (!depFileMeta(rel)) return;
  const indexed = await indexedText(top, rel);
  await writeIndex(top, rel, await mergeLive(top, rel, item, indexed, side));
};

const applyDepWorktree = async (top, rel, item, side) => {
  if (!depFileMeta(rel)) return;
  const live = await worktreeText(top, rel);
  await writeFile(top, rel, await mergeLive(top, rel, item, live, side));
};

const npmError = (result, fail) => {
  const { error } = result;
  const msg = error ? error.message : result.stderr || result.stdout;
  return new Error(oneLine(msg || fail, fail));
};

const stagePlan = async (top, plan) => {
  const toAdd = [];
  if (!plan.lockOnly && plan.manifest) toAdd.push(plan.manifest);
  if (fs.existsSync(path.join(top, plan.lockPath))) toAdd.push(plan.lockPath);
  if (!toAdd.length) return;
  await gitOk(['add', '--', ...toAdd], top);
};

const startPlan = (top, item) => {
  const plan = proposedNpmPlan(top, item);
  if (!plan) return null;
  const rels = [...new Set([plan.manifest, plan.lockPath].filter(Boolean))];
  const owned = rels.map((rel) => captureFile(top, rel));
  return { plan, owned };
};

const finishPlan = async (top, plan, result, stage = stagePlan) => {
  const failed = result && (result.error || result.status !== 0);
  if (failed) throw npmError(result, plan.fail);
  await stage(top, plan);
};

const restoreOwned = (top, owned) => {
  for (const saved of owned) restoreFile(top, saved);
};

const unlocked = (write) => write();

// The install can run for minutes, so only the file and index steps around
// it go through the caller's write lock
const applyProposedUpdate = async (top, item, extra = {}) => {
  const started = startPlan(top, item);
  if (!started) return;
  const { plan, owned } = started;
  const locked = extra.locked ?? unlocked;
  try {
    if (plan.prepareManifest) {
      await locked(() => applyDepWorktree(top, plan.manifest, item, 'new'));
    }
    const install = extra.run ?? plan.runner ?? runNpm;
    const result = await install(plan.cwd, plan.npmArgs);
    await locked(() => finishPlan(top, plan, result, extra.stage));
  } catch (error) {
    restoreOwned(top, owned);
    throw error;
  }
};

const applyDepChange = async (top, item, mode, extra) => {
  const change = depChange(item);
  if (change.propose) {
    if (mode === 'add') {
      await applyProposedUpdate(top, item, extra);
      return;
    }
    if (!change.unused) return;
  }
  for (const rel of depPaths(item)) {
    if (mode !== 'revert') {
      await applyDepIndex(top, rel, item, mode === 'add' ? 'new' : 'old');
      continue;
    }
    if (item.origin === 'staged') await applyDepIndex(top, rel, item, 'old');
    await applyDepWorktree(top, rel, item, 'old');
  }
};

const addItem = async (top, item, extra) => {
  if (!item.dep) {
    await worktree.addItem(top, item);
    return;
  }
  if (isStagedOrCommit(item)) return;
  if (depChange(item)) {
    await applyDepChange(top, item, 'add', extra);
    return;
  }
  const rels = depPaths(item);
  if (rels.length) await gitOk(['add', '--', ...rels], top);
};

const unstageItem = async (top, item) => {
  if (!item.dep) {
    await worktree.unstageItem(top, item);
    return;
  }
  if (item.origin !== 'staged') return;
  if (depChange(item)) {
    await applyDepChange(top, item, 'unstage');
    return;
  }
  const rels = depPaths(item);
  if (!rels.length) return;
  await gitOk(['restore', '--staged', '--', ...rels], top);
};

const revertItem = async (top, item) => {
  if (item.origin === 'commit') return;
  if (!item.dep) {
    await worktree.revertItem(top, item);
    return;
  }
  if (depChange(item)) {
    await applyDepChange(top, item, 'revert');
    return;
  }
  const byPath = groupByPath(item.dep.items ?? []);
  for (const rel of byPath.keys()) {
    await revertOnePath(top, rel, byPath.get(rel));
  }
};

const revertFile = async (top, rel, items) => {
  const rels = new Set([rel]);
  for (const item of items) {
    for (const file of depPaths(item)) rels.add(file);
  }
  for (const file of rels) {
    const group = itemsForPath(file, items);
    await revertOnePath(top, file, group.length ? group : items);
  }
};

module.exports = {
  collectReport,
  finishLoad,
  loadExtras,
  captureFile,
  restoreFile,
  proposedNpmPlan,
  applyProposedUpdate,
  addItem,
  unstageItem,
  revertItem,
  revertFile,
};
