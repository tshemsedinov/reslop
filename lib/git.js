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
const { collectUsedNames, parseAuditReport } = deps;

const GIT_CONFIG = ['-c', 'core.quotepath=false'];
const DIFF_OPTS = ['--no-color', '--no-ext-diff', '--no-renames', '-U3'];
const GIT_ENCODING = 'utf8';
const GIT_MAX_BUFFER = 32 * 1024 * 1024;
const BINARY_SIZE = 1000000;
const AUDIT_MS = 15000;

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

const collectAudit = (top) => {
  const lock = path.join(top, 'package-lock.json');
  if (!fs.existsSync(lock)) return null;
  const args = ['audit', '--json', '--package-lock-only'];
  const result = spawnSync('npm', args, {
    cwd: top,
    encoding: GIT_ENCODING,
    maxBuffer: GIT_MAX_BUFFER,
    timeout: AUDIT_MS,
  });
  if (result.error) return null;
  return parseAuditReport(result.stdout);
};

const foldLoaded = (items, top, rev, extra = {}) => {
  const readSides = readDepSides(top, rev);
  let usedNames = null;
  let audit = null;
  for (const item of items) {
    if (!depFileMeta(itemPath(item))) continue;
    usedNames = collectUsedNames(top);
    if (extra.audit) audit = collectAudit(top);
    break;
  }
  return foldDepItems(items, readSides, usedNames, audit);
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

const applyDepChange = (top, item, mode) => {
  const change = depChange(item);
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
    const items = foldLoaded(parsed, top, rev, options);
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
  const items = foldLoaded(merged, top, undefined, options);
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
