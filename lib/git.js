'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const diff = require('./diff.js');
const { parseDiff, synthesizeNewFile, itemsFromFiles } = diff;
const { itemPath } = require('./files.js');
const { REVIEW_DIR } = require('./review.js');
const deps = require('./deps.js');
const { foldDepItems, mergeDepFile, depFileMeta } = deps;
const { collectUsedNames, parseAuditReport, parseOutdatedReport } = deps;
const { mergeProposedItems } = deps;

const GIT_CONFIG = ['-c', 'core.quotepath=false'];
const DIFF_OPTS = ['--no-color', '--no-ext-diff', '--no-renames', '-U3'];
const GIT_ENCODING = 'utf8';
const GIT_MAX_BUFFER = 32 * 1024 * 1024;
const BINARY_SIZE = 1000000;
const AUDIT_MS = 15000;
const INSTALL_MS = 120000;
const MANIFEST = 'package.json';
const LOCKFILE = 'package-lock.json';

const oneLine = (text) => text.trim().split('\n')[0] || 'git failed';

const requireOk = (result, fallback = 'git failed') => {
  if (result.status === 0) return result;
  const msg = result.stderr || result.stdout || fallback;
  throw new Error(oneLine(msg));
};

const isReviewFile = (rel) => {
  if (!rel) return false;
  const first = rel.split(/[/\\]/)[0];
  return first === REVIEW_DIR;
};

const dropReviewItems = (items) => {
  const kept = [];
  for (const item of items) {
    if (isReviewFile(itemPath(item))) continue;
    kept.push(item);
  }
  return kept;
};

const runGit = (args, cwd, input) => {
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0' };
  const options = {
    cwd,
    encoding: GIT_ENCODING,
    input,
    maxBuffer: GIT_MAX_BUFFER,
    env,
  };
  const result = spawnSync('git', args, options);
  if (result.error) {
    if (result.error.code === 'ENOENT') throw new Error('git not found');
    throw result.error;
  }
  return result;
};

const toplevel = (cwd) => {
  const result = runGit(['rev-parse', '--show-toplevel'], cwd);
  if (result.status !== 0) throw new Error('not a git repository');
  return result.stdout.trim();
};

const applyPatch = (cwd, patch, flags) => {
  const args = ['apply', ...flags, '--whitespace=nowarn', '-'];
  const result = runGit(args, cwd, patch);
  requireOk(result, 'apply failed');
};

const isBinaryBuffer = (buf) => {
  if (buf.length > BINARY_SIZE) return true;
  return buf.includes(0);
};

const listUntracked = (top, paths) => {
  const args = ['ls-files', '-o', '--exclude-standard', '-z'];
  if (paths.length) args.push('--', ...paths);
  const result = requireOk(runGit(args, top));
  if (!result.stdout) return [];
  return result.stdout.split('\0').filter(Boolean);
};

const binaryNewFile = (rel) => ({
  oldPath: rel,
  newPath: rel,
  isNew: true,
  isDeleted: false,
  isBinary: true,
  preamble: [`diff --git a/${rel} b/${rel}`, 'new file mode 100644'],
  hunks: [],
});

const untrackedItems = (top, paths) => {
  const files = [];
  for (const rel of listUntracked(top, paths)) {
    if (isReviewFile(rel)) continue;
    const full = path.join(top, rel);
    let buf;
    try {
      buf = fs.readFileSync(full);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    if (isBinaryBuffer(buf)) {
      files.push(binaryNewFile(rel));
      continue;
    }
    files.push(synthesizeNewFile(rel, buf.toString('utf8')));
  }
  return itemsFromFiles(files, 'untracked');
};

const mergeItems = (groups) => {
  const byPath = new Map();
  for (const group of groups) {
    for (const item of group) {
      const rel = itemPath(item);
      const list = byPath.get(rel);
      if (list) {
        list.push(item);
        continue;
      }
      byPath.set(rel, [item]);
    }
  }
  const items = [];
  for (const list of byPath.values()) {
    for (const item of list) items.push(item);
  }
  return items;
};

const gitText = (top, spec) => {
  const result = runGit(['show', spec], top);
  if (result.status !== 0) return '';
  return result.stdout ?? '';
};

const worktreeText = (top, rel) => {
  try {
    return fs.readFileSync(path.join(top, rel), 'utf8');
  } catch {
    return '';
  }
};

const readDepSides = (top, rev) => (origin, rel) => {
  if (origin === 'untracked') {
    const oldText = '';
    const newText = worktreeText(top, rel);
    return { oldText, newText };
  }
  if (origin === 'staged') {
    const oldText = gitText(top, `HEAD:${rel}`);
    const newText = gitText(top, `:${rel}`);
    return { oldText, newText };
  }
  if (origin === 'unstaged') {
    const indexed = gitText(top, `:${rel}`);
    const oldText = indexed || gitText(top, `HEAD:${rel}`);
    const newText = worktreeText(top, rel);
    return { oldText, newText };
  }
  if (origin === 'commit' && rev) {
    const oldText = gitText(top, `${rev}^:${rel}`);
    const newText = gitText(top, `${rev}:${rel}`);
    return { oldText, newText };
  }
  return { oldText: '', newText: '' };
};

const runNpmJson = (top, args, timeout) => {
  const result = spawnSync('npm', args, {
    cwd: top,
    encoding: GIT_ENCODING,
    maxBuffer: GIT_MAX_BUFFER,
    timeout,
  });
  if (result.error) return '';
  return result.stdout || '';
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

const coversManifest = (paths, rel) => {
  if (!paths || !paths.length) return true;
  for (const raw of paths) {
    const spec = `${raw}`.replaceAll('\\', '/').replace(/\/$/, '');
    if (!spec || spec === '.') return true;
    if (rel === spec) return true;
    if (rel.startsWith(`${spec}/`)) return true;
  }
  return false;
};

const pickNpmMap = (override, collect, top) => {
  if (override !== undefined) return override;
  return collect(top);
};

const foldLoaded = (items, top, rev, extra = {}) => {
  const readSides = readDepSides(top, rev);
  let usedNames = null;
  let audit = null;
  let outdated = null;
  const live = extra.audit === true && !rev;
  let hasDepDiff = false;
  for (const item of items) {
    if (!depFileMeta(itemPath(item))) continue;
    hasDepDiff = true;
    break;
  }
  if (hasDepDiff) usedNames = collectUsedNames(top);
  if (live) {
    audit = pickNpmMap(extra.auditMap, collectAudit, top);
    outdated = pickNpmMap(extra.outdatedMap, collectOutdated, top);
  } else if (extra.audit && hasDepDiff) {
    audit = pickNpmMap(extra.auditMap, collectAudit, top);
  }
  const folded = foldDepItems(items, readSides, usedNames, audit, outdated);
  if (!live) return folded;
  if (!coversManifest(extra.paths, MANIFEST)) return folded;
  const pkgText = worktreeText(top, MANIFEST);
  const lockText = worktreeText(top, LOCKFILE);
  return mergeProposedItems(folded, pkgText, outdated, audit, { lockText });
};

const depPaths = (item) => {
  if (!item || !item.dep) return [];
  return item.dep.files ?? [];
};

const origDepItems = (item) => {
  if (!item || !item.dep) return [];
  return item.dep.items ?? [];
};

const depChange = (item) => {
  if (!item || !item.dep) return null;
  return item.dep.change ?? null;
};

const writeWorktreeFile = (top, rel, text) => {
  const abs = path.join(top, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
};

const restoreWorktreeFile = (top, rel, saved, existed) => {
  const abs = path.join(top, rel);
  if (existed) {
    fs.writeFileSync(abs, saved);
    return;
  }
  try {
    fs.unlinkSync(abs);
  } catch {
    // missing
  }
};

const writeIndexFile = (top, rel, text) => {
  const abs = path.join(top, rel);
  const existed = fs.existsSync(abs);
  const saved = existed ? fs.readFileSync(abs, 'utf8') : '';
  writeWorktreeFile(top, rel, text);
  try {
    requireOk(runGit(['add', '--', rel], top));
  } finally {
    restoreWorktreeFile(top, rel, saved, existed);
  }
};

const mergeDepLive = (top, rel, change, origin, base, side, kind) => {
  const sides = readDepSides(top, null)(origin, rel);
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

const depRel = (dir, name) => (dir === '.' ? name : `${dir}/${name}`);

const runNpmInstall = (cwd) =>
  spawnSync('npm', ['i'], {
    cwd,
    encoding: GIT_ENCODING,
    maxBuffer: GIT_MAX_BUFFER,
    timeout: INSTALL_MS,
  });

const runNpmAuditFix = (cwd) =>
  spawnSync('npm', ['audit', 'fix'], {
    cwd,
    encoding: GIT_ENCODING,
    maxBuffer: GIT_MAX_BUFFER,
    timeout: INSTALL_MS,
  });

const firstDepRel = (files, kind) => {
  for (const rel of files) {
    const meta = depFileMeta(rel);
    if (meta && meta.kind === kind) return rel;
  }
  return '';
};

const applyProposedUpdate = (top, item) => {
  const change = depChange(item);
  const origin = item.origin;
  const files = depPaths(item);
  const lockOnly = change.section === 'resolved';
  const manifest = firstDepRel(files, 'manifest');
  const lockRel = firstDepRel(files, 'lockfile');
  const picked = lockOnly ? lockRel : manifest;
  const target = picked || files[0] || '';
  const meta = depFileMeta(target);
  if (!meta) return;
  let saved = '';
  if (!lockOnly && manifest) {
    const worktree = worktreeText(top, manifest);
    saved = worktree;
    const text = mergeDepLive(
      top,
      manifest,
      change,
      origin,
      worktree,
      'new',
      'manifest',
    );
    writeWorktreeFile(top, manifest, text);
  }
  const cwd = meta.dir === '.' ? top : path.join(top, meta.dir);
  const fallback = lockOnly ? runNpmAuditFix : runNpmInstall;
  const install = item.dep.install ?? fallback;
  const result = install(cwd);
  if (result && (result.error || result.status !== 0)) {
    if (saved && manifest) writeWorktreeFile(top, manifest, saved);
    if (result.error) {
      const msg = result.error.message || 'npm i failed';
      throw new Error(oneLine(msg));
    }
    const msg = result.stderr || result.stdout || 'npm i failed';
    throw new Error(oneLine(msg));
  }
  const toAdd = [];
  if (!lockOnly && manifest) toAdd.push(manifest);
  const lockPath = lockRel || depRel(meta.dir, LOCKFILE);
  if (fs.existsSync(path.join(top, lockPath))) toAdd.push(lockPath);
  if (toAdd.length) requireOk(runGit(['add', '--', ...toAdd], top));
};

const applyDepChange = (top, item, mode) => {
  const change = depChange(item);
  if (change && change.propose) {
    if (mode === 'add') applyProposedUpdate(top, item);
    return;
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
    if (origin === 'staged') {
      applyDepIndex(top, rel, change, origin, 'old');
    }
    applyDepWorktree(top, rel, change, origin);
  }
};

const resolveRev = (cwd, spec) => {
  if (!spec) return null;
  const top = toplevel(cwd);
  const args = ['rev-parse', '--verify', `${spec}^{commit}`];
  const result = runGit(args, top);
  if (result.status !== 0) return null;
  return result.stdout.trim();
};

const shortRev = (top, commit) => {
  const result = runGit(['rev-parse', '--short', commit], top);
  if (result.status !== 0) return commit.slice(0, 7);
  return result.stdout.trim();
};

const loadCommit = (top, commit, extra) => {
  const parent = runGit(['rev-parse', '--verify', `${commit}^`], top);
  let args;
  if (parent.status === 0) {
    const from = parent.stdout.trim();
    args = [...GIT_CONFIG, 'diff', ...DIFF_OPTS, from, commit, ...extra];
  } else {
    args = [
      ...GIT_CONFIG,
      'diff-tree',
      '--no-commit-id',
      '--root',
      '-p',
      ...DIFF_OPTS,
      commit,
      ...extra,
    ];
  }
  const result = requireOk(runGit(args, top));
  return parseDiff(result.stdout);
};

const load = (cwd, paths = [], options = {}) => {
  const top = toplevel(cwd);
  const extra = paths.length ? ['--', ...paths] : [];
  const rev = options.commit;
  if (rev) {
    const files = loadCommit(top, rev, extra);
    const commitItems = itemsFromFiles(files, 'commit');
    const parsed = dropReviewItems(commitItems);
    const items = foldLoaded(parsed, top, rev, { ...options, paths });
    const revShort = shortRev(top, rev);
    return { top, items, rev, revShort };
  }
  const stagedArgs = [
    ...GIT_CONFIG,
    'diff',
    '--cached',
    ...DIFF_OPTS,
    ...extra,
  ];
  const unstagedArgs = [...GIT_CONFIG, 'diff', ...DIFF_OPTS, ...extra];
  const stagedRes = requireOk(runGit(stagedArgs, top));
  const unstagedRes = requireOk(runGit(unstagedArgs, top));
  const stagedDiff = parseDiff(stagedRes.stdout);
  const unstagedDiff = parseDiff(unstagedRes.stdout);
  const staged = itemsFromFiles(stagedDiff, 'staged');
  const unstaged = itemsFromFiles(unstagedDiff, 'unstaged');
  const untracked = untrackedItems(top, paths);
  const combined = mergeItems([staged, unstaged, untracked]);
  const merged = dropReviewItems(combined);
  const items = foldLoaded(merged, top, undefined, { ...options, paths });
  return { top, items };
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
    return;
  }
  if (item.origin === 'untracked' || item.file.isBinary) {
    requireOk(runGit(['add', '--', item.file.newPath], top));
    return;
  }
  applyPatch(top, item.patchAdd, ['--cached']);
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
    return;
  }
  const rel = itemPath(item);
  if (item.file.isBinary) {
    requireOk(runGit(['restore', '--staged', '--', rel], top));
    return;
  }
  applyPatch(top, item.patchAdd, ['--reverse', '--cached']);
};

const revertOnePath = (top, rel, items) => {
  const origins = new Set();
  let isNew = false;
  for (const item of items) {
    origins.add(item.origin);
    if (item.file && item.file.isNew) isNew = true;
  }
  if (isNew) {
    if (origins.has('staged')) {
      requireOk(runGit(['rm', '-f', '--', rel], top));
      return;
    }
    fs.unlinkSync(path.join(top, rel));
    return;
  }
  if (origins.has('untracked') && origins.size === 1) {
    fs.unlinkSync(path.join(top, rel));
    return;
  }
  const args = ['restore', '-s', 'HEAD', '--worktree', '--staged', '--', rel];
  requireOk(runGit(args, top));
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

const revertItem = (top, item) => {
  if (item.origin === 'commit') return;
  if (depChange(item)) {
    applyDepChange(top, item, 'revert');
    return;
  }
  if (item.dep) {
    const byPath = new Map();
    for (const orig of origDepItems(item)) {
      const rel = itemPath(orig);
      const list = byPath.get(rel);
      if (list) list.push(orig);
      else byPath.set(rel, [orig]);
    }
    for (const [rel, group] of byPath) revertOnePath(top, rel, group);
    return;
  }
  const rel = itemPath(item);
  if (item.origin === 'untracked') {
    fs.unlinkSync(path.join(top, rel));
    return;
  }
  if (item.file.isBinary) {
    const args = ['restore', '-s', 'HEAD', '--worktree'];
    if (item.origin === 'staged') args.push('--staged');
    args.push('--', rel);
    requireOk(runGit(args, top));
    return;
  }
  if (item.origin === 'unstaged') {
    applyPatch(top, item.patchRevert, ['--reverse']);
    return;
  }
  applyPatch(top, item.patchRevert, ['--reverse', '--cached']);
  try {
    applyPatch(top, item.patchRevert, ['--reverse']);
  } catch (error) {
    if (!error.message.includes('does not apply')) throw error;
  }
};

const revertFile = (top, rel, items) => {
  const paths = new Set([rel]);
  for (const item of items) {
    for (const file of depPaths(item)) paths.add(file);
  }
  for (const file of paths) {
    const group = itemsForPath(file, items);
    const targets = group.length ? group : items;
    revertOnePath(top, file, targets);
  }
};

const createGitRepo = () => ({
  load,
  resolveRev,
  add: addItem,
  unstage: unstageItem,
  revert: revertItem,
  revertFile,
});

module.exports = {
  runGit,
  toplevel,
  load,
  resolveRev,
  addItem,
  unstageItem,
  revertItem,
  revertFile,
  createGitRepo,
  oneLine,
};
