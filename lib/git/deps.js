'use strict';

const fs = require('node:fs');
const path = require('node:path');

const deps = require('../deps/deps.js');
const { foldDepItems, mergeProposedItems, parseAuditReport } = deps;
const { parseOutdatedReport, collectUsedNames, collectExportMeta } = deps;
const { collectGroups } = require('../deps/diff.js');
const manifest = require('../deps/manifest.js');
const { mergeDepFile } = manifest;
const files = require('../common/files.js');
const { MANIFEST, LOCKFILE, depFileMeta, relOf, itemPath } = files;
const { isPathInScope, groupByPath } = files;
const { oneLine, unique } = require('../common/utilities.js');
const processPart = require('../common/process.js');
const { INSTALL_MS, IS_WIN, abortError, npmBin, runProc } = processPart;
const worktree = require('./worktree.js');
const { gitOk, indexedText, worktreeText, readDepSides } = worktree;
const { revertOnePath, writeFile, writeIndex } = worktree;

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

const NO_SIDES = { oldText: '', newText: '' };

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
  const manifest = firstDepRel(rels, 'manifest');
  const lockRel = firstDepRel(rels, 'lockfile');
  const meta = depFileMeta((lockOnly ? lockRel : manifest) || rels[0]);
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
    manifest,
    prepareManifest: !lockOnly && !removing && !!manifest,
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

const sidesReader = async (items, top, rev) => {
  const sides = new Map();
  const reads = [];
  for (const group of collectGroups(items).values()) {
    for (const name of [MANIFEST, LOCKFILE]) {
      const rel = relOf(group.dir, name);
      const key = `${group.origin}\0${rel}`;
      const read = async () => {
        const found = await readDepSides(top, rev, group.origin, rel);
        sides.set(key, found);
      };
      reads.push(read());
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
  const report = (need, known, kind) => {
    if (!collect || !need || known !== undefined) return known;
    return collectReport(top, kind, extra.signal);
  };
  [audit, outdated] = await Promise.all([
    report(needs.audit, audit, 'audit'),
    report(needs.live, outdated, 'outdated'),
  ]);
  audit ??= null;
  outdated ??= null;
  const folded = foldDepItems(items, readSides, usedNames, audit, outdated, {
    root: top,
    exportEntries,
  });
  if (!needs.live || !isPathInScope(MANIFEST, extra.paths)) return folded;
  const texts = [worktreeText(top, MANIFEST), worktreeText(top, LOCKFILE)];
  const results = await Promise.all(texts);
  const pkgText = results[0];
  const lockText = results[1];
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

const later = async (fn) => fn();

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
  const results = await Promise.all([
    needs.scan ? later(() => collectUsedNames(top)) : null,
    reportTask(needs.audit, extra.auditMap, () =>
      collectReport(top, 'audit', signal),
    ),
    reportTask(needs.live, extra.outdatedMap, () =>
      collectReport(top, 'outdated', signal),
    ),
    exportMeta,
  ]);
  const usedNames = results[0];
  const auditMap = results[1];
  const outdatedMap = results[2];
  const exportEntries = results[3];
  if (signal && signal.aborted) throw abortError();
  const found = { usedNames, auditMap, outdatedMap };
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
  const message = error ? error.message : result.stderr || result.stdout;
  return new Error(oneLine(message || fail, fail));
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
  const rels = unique([plan.manifest, plan.lockPath]);
  const owned = rels.map((rel) => captureFile(top, rel));
  return { plan, owned };
};

const finishPlan = async (top, plan, result, stage = stagePlan) => {
  const failed = result && (result.error || result.status !== 0);
  if (failed) throw npmError(result, plan.fail);
  await stage(top, plan);
};

const manifestPlan = (top, manifest) => {
  const meta = depFileMeta(manifest);
  if (!meta || meta.kind !== 'manifest') return null;
  return {
    cwd: meta.dir === '.' ? top : path.join(top, meta.dir),
    npmArgs: ['i'],
    fail: 'npm i failed',
    lockOnly: false,
    lockPath: relOf(meta.dir, LOCKFILE),
    manifest,
  };
};

const syncManifest = async (top, rel, extra = {}) => {
  const plan = manifestPlan(top, rel);
  if (!plan) return;
  const install = extra.run ?? runNpm;
  const result = await install(plan.cwd, plan.npmArgs);
  await finishPlan(top, plan, result, extra.stage);
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

const manifestLock = (rel) => {
  const meta = depFileMeta(rel);
  if (!meta || meta.kind !== 'manifest') return '';
  return relOf(meta.dir, LOCKFILE);
};

const indexPaths = async (top) => {
  const listed = await gitOk(['ls-files', '--stage', '-z'], top);
  const names = new Set();
  for (const line of listed.stdout.split('\0')) {
    if (!line) continue;
    const tab = line.indexOf('\t');
    if (tab >= 0) names.add(line.slice(tab + 1));
  }
  return names;
};

const cachedPaths = async (top) => {
  const listed = await gitOk(['diff', '--cached', '--name-only', '-z'], top);
  return listed.stdout.split('\0').filter(Boolean);
};

const dirtyPaths = async (top) => {
  const commands = [
    ['diff', '--name-only', '-z'],
    ['diff', '--cached', '--name-only', '-z'],
    ['ls-files', '--others', '--exclude-standard', '-z'],
  ];
  const names = new Set();
  for (const args of commands) {
    const listed = await gitOk(args, top);
    for (const name of listed.stdout.split('\0')) {
      if (name) names.add(name);
    }
  }
  return names;
};

const lockChanged = async (top, rel) => {
  const lock = manifestLock(rel);
  if (!lock) return '';
  const dirty = await dirtyPaths(top);
  return dirty.has(lock) ? lock : '';
};

const lockReady = async (top, rel) => {
  const lock = manifestLock(rel);
  if (!lock) return '';
  if (fs.existsSync(path.join(top, lock))) return lock;
  const indexed = await indexPaths(top);
  return indexed.has(lock) ? lock : '';
};

const stageFiles = async (top, rels) => {
  const indexed = await indexPaths(top);
  const present = [];
  for (const rel of rels) {
    if (!rel) continue;
    const onDisk = fs.existsSync(path.join(top, rel));
    if (onDisk || indexed.has(rel)) present.push(rel);
  }
  if (!present.length) return;
  await gitOk(['add', '--', ...present], top);
};

const unstagePaths = async (top, rels) => {
  const wanted = new Set(rels.filter(Boolean));
  const cached = await cachedPaths(top);
  const staged = cached.filter((name) => wanted.has(name));
  if (!staged.length) return;
  await gitOk(['restore', '--staged', '--', ...staged], top);
};

const revertKnown = async (top, rel) => {
  const indexed = await indexPaths(top);
  const shown = await worktree.runGit(['cat-file', '-e', `HEAD:${rel}`], top);
  const inHead = shown.status === 0;
  const onDisk = fs.existsSync(path.join(top, rel));
  if (!inHead) {
    if (indexed.has(rel)) await gitOk(['rm', '-f', '--', rel], top);
    else if (onDisk) fs.rmSync(path.join(top, rel), { force: true });
    return;
  }
  if (!indexed.has(rel) && !onDisk) return;
  const args = ['restore', '-s', 'HEAD', '--worktree', '--staged', '--', rel];
  await gitOk(args, top);
};

const stagePlain = async (top, item, extra) => {
  const rel = itemPath(item);
  const lock = await lockChanged(top, rel);
  await worktree.addItem(top, item);
  if (lock) {
    await stageFiles(top, [lock]);
    return;
  }
  await syncManifest(top, rel, extra);
};

const stageManifest = async (top, rel, extra = {}) => {
  const lock = await lockChanged(top, rel);
  const paths = lock ? [rel, lock] : [rel];
  await stageFiles(top, paths);
  if (!lock) await syncManifest(top, rel, extra);
};

const unstageManifest = async (top, rel) => {
  const lock = manifestLock(rel);
  const paths = lock ? [rel, lock] : [rel];
  await unstagePaths(top, paths);
};

const revertManifest = async (top, rel) => {
  const lock = await lockReady(top, rel);
  const paths = lock ? [rel, lock] : [rel];
  for (const file of paths) await revertKnown(top, file);
};

const addItem = async (top, item, extra) => {
  if (!item.dep) {
    await stagePlain(top, item, extra);
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

const stagePath = async (top, rel, extra) => {
  await worktree.stagePath(top, rel);
  await syncManifest(top, rel, extra);
};

const unstageItem = async (top, item) => {
  if (!item.dep) {
    await worktree.unstageItem(top, item);
    const lock = manifestLock(itemPath(item));
    if (lock) await unstagePaths(top, [lock]);
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
    const lock = await lockReady(top, itemPath(item));
    if (lock) await revertKnown(top, lock);
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
  const lock = await lockReady(top, rel);
  if (lock) rels.add(lock);
  for (const item of items) {
    for (const file of depPaths(item)) rels.add(file);
  }
  for (const file of rels) {
    const group = itemsForPath(file, items);
    if (file === lock && !group.length) {
      await revertKnown(top, file);
      continue;
    }
    await revertOnePath(top, file, group.length ? group : items);
  }
};

module.exports = {
  collectReport,
  proposedNpmPlan,
  finishLoad,
  loadExtras,
  captureFile,
  restoreFile,
  applyProposedUpdate,
  addItem,
  stagePath,
  stageManifest,
  unstageManifest,
  revertManifest,
  unstageItem,
  revertItem,
  revertFile,
};
