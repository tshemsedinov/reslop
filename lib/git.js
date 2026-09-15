'use strict';

const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const diff = require('./diff.js');
const { parseDiff, synthesizeNewFile, itemsFromFiles } = diff;
const { itemPath, isPathInScope, REVIEW_DIR } = require('./files.js');
const { npmBin, spawnBase } = require('./sys.js');
const deps = require('./deps.js');
const { foldDepItems, mergeDepFile, depFileMeta } = deps;
const { collectUsedNames, parseAuditReport, parseOutdatedReport } = deps;
const { mergeProposedItems, MANIFEST, LOCKFILE } = deps;

const GIT_CONFIG = [
  '-c',
  'core.quotepath=false',
  '-c',
  'i18n.logOutputEncoding=utf-8',
];
const DIFF_OPTS = ['--no-color', '--no-ext-diff', '--no-renames', '-U3'];
const GIT_ENCODING = 'utf8';
const GIT_MAX_BUFFER = 32 * 1024 * 1024;
const BINARY_SIZE = 1000000;
const AUDIT_MS = 15000;
const INSTALL_MS = 120000;
const BRANCH_FORMAT = [
  '%(HEAD)',
  '%(refname:short)',
  '%(objectname:short)',
  '%(committerdate:relative)',
  '%(upstream:track)',
  '%(subject)',
].join('%09');
const TRACK_AHEAD = /ahead (\d+)/;
const TRACK_BEHIND = /behind (\d+)/;
const ORIGIN_HEAD = 'refs/remotes/origin/HEAD';
const DEFAULT_BRANCHES = ['main', 'master'];
const PUSH_REJECTED = [
  'non-fast-forward',
  'failed to push some refs',
  'updates were rejected',
];

const oneLine = (text) => {
  const line = text.trim().split('\n')[0];
  return line || 'git failed';
};

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

const abortError = () => {
  const error = new Error('aborted');
  error.code = 'ABORT';
  return error;
};

const isAbort = (error) => !!(error && error.code === 'ABORT');

const runProc = (cmd, args, options = {}) =>
  new Promise((resolve) => {
    const cwd = options.cwd;
    const env = options.env;
    const encoding = options.encoding ?? GIT_ENCODING;
    const maxBuffer = options.maxBuffer ?? GIT_MAX_BUFFER;
    const timeout = options.timeout;
    const input = options.input;
    const signal = options.signal;
    if (signal && signal.aborted) {
      resolve({ status: null, error: abortError(), stdout: '', stderr: '' });
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer = null;
    const child = spawn(cmd, args, spawnBase({ cwd, env }));
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };
    const onAbort = () => {
      child.kill();
      finish({ status: null, error: abortError(), stdout, stderr });
    };
    const append = (kind, chunk) => {
      if (kind === 'out') stdout += chunk;
      else stderr += chunk;
      if (stdout.length + stderr.length <= maxBuffer) return;
      child.kill();
      const error = new Error('maxBuffer exceeded');
      error.code = 'ENOBUFS';
      finish({ status: null, error, stdout, stderr });
    };
    if (signal) signal.addEventListener('abort', onAbort);
    if (child.stdout) {
      child.stdout.setEncoding(encoding);
      child.stdout.on('data', (chunk) => append('out', chunk));
    }
    if (child.stderr) {
      child.stderr.setEncoding(encoding);
      child.stderr.on('data', (chunk) => append('err', chunk));
    }
    if (timeout) {
      timer = setTimeout(() => {
        child.kill();
        const error = new Error('timed out');
        error.code = 'ETIMEDOUT';
        finish({ status: null, error, stdout, stderr });
      }, timeout);
    }
    child.on('error', (error) => {
      finish({ status: null, error, stdout, stderr });
    });
    child.on('close', (status) => {
      finish({ status, stdout, stderr });
    });
    if (child.stdin) {
      try {
        if (input) child.stdin.end(input);
        else child.stdin.end();
      } catch {
        // closed
      }
    }
  });

const gitResult = (result) => {
  if (!result.error) return result;
  if (isAbort(result.error)) throw result.error;
  if (result.error.code === 'ENOENT') throw new Error('git not found');
  throw result.error;
};

const runGit = (args, cwd, input) => {
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0' };
  const encoding = GIT_ENCODING;
  const maxBuffer = GIT_MAX_BUFFER;
  const options = spawnBase({ cwd, encoding, input, maxBuffer, env });
  const result = spawnSync('git', args, options);
  return gitResult(result);
};

const runGitAsync = (args, cwd, extra = {}) => {
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0' };
  const encoding = GIT_ENCODING;
  const maxBuffer = GIT_MAX_BUFFER;
  const input = extra.input;
  const signal = extra.signal;
  return runProc('git', args, {
    cwd,
    env,
    encoding,
    maxBuffer,
    input,
    signal,
  }).then(gitResult);
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

const namesFromLs = (stdout) => {
  if (!stdout) return [];
  return stdout.split('\0').filter(Boolean);
};

const listUntracked = (top, paths) => {
  const args = ['ls-files', '-o', '--exclude-standard', '-z'];
  if (paths.length) args.push('--', ...paths);
  const result = requireOk(runGit(args, top));
  return namesFromLs(result.stdout);
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

const untrackedItemsFrom = (top, names) => {
  const files = [];
  for (const rel of names) {
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

const readDepSides = (top, rev, origin, rel) => {
  if (origin === 'untracked') {
    const newText = worktreeText(top, rel);
    return { oldText: '', newText };
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
  const result = spawnSync(
    npmBin(),
    args,
    spawnBase({
      cwd: top,
      encoding: GIT_ENCODING,
      maxBuffer: GIT_MAX_BUFFER,
      timeout,
    }),
  );
  if (result.error) return '';
  return result.stdout || '';
};

const runNpmJsonAsync = async (top, args, timeout, signal) => {
  const result = await runProc(npmBin(), args, {
    cwd: top,
    encoding: GIT_ENCODING,
    maxBuffer: GIT_MAX_BUFFER,
    timeout,
    signal,
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

const hasDepFile = (items) => {
  for (const item of items) {
    if (depFileMeta(itemPath(item))) return true;
  }
  return false;
};

const foldLoaded = (items, top, rev, extra = {}) => {
  const readSides = (origin, rel) => readDepSides(top, rev, origin, rel);
  const live = extra.audit === true && !rev;
  const hasDepDiff = hasDepFile(items);
  const collect = extra.collect !== false;
  let usedNames = extra.usedNames ?? null;
  let audit = extra.auditMap;
  let outdated = extra.outdatedMap;
  if (collect && usedNames === null && (hasDepDiff || live)) {
    usedNames = collectUsedNames(top);
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
  });
  if (!live) return folded;
  if (!isPathInScope(MANIFEST, extra.paths ?? [])) return folded;
  const pkgText = worktreeText(top, MANIFEST);
  const lockText = worktreeText(top, LOCKFILE);
  return mergeProposedItems(folded, pkgText, outdated, audit, {
    lockText,
    usedNames,
    root: top,
  });
};

const depPaths = (item) => item.dep?.files ?? [];

const origDepItems = (item) => item.dep?.items ?? [];

const depChange = (item) => item.dep?.change ?? null;

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

const runNpm = (cwd, args) =>
  spawnSync(
    npmBin(),
    args,
    spawnBase({
      cwd,
      encoding: GIT_ENCODING,
      maxBuffer: GIT_MAX_BUFFER,
      timeout: INSTALL_MS,
    }),
  );

const runNpmAsync = (cwd, args) =>
  runProc(npmBin(), args, {
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

const proposedNpmPlan = (top, item) => {
  const change = depChange(item);
  const origin = item.origin;
  const files = depPaths(item);
  const lockOnly = change.section === 'resolved';
  const removing = !!change.unused;
  const manifest = firstDepRel(files, 'manifest');
  const lockRel = firstDepRel(files, 'lockfile');
  const picked = lockOnly ? lockRel : manifest;
  const target = picked || files[0] || '';
  const meta = depFileMeta(target);
  if (!meta) return null;
  let saved = '';
  if (!lockOnly && !removing && manifest) {
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
  let npmArgs = ['i'];
  if (removing) npmArgs = ['uninstall', change.name];
  else if (lockOnly) npmArgs = ['audit', 'fix'];
  const fail = removing ? 'npm uninstall failed' : 'npm i failed';
  const dirLock = meta.dir === '.' ? LOCKFILE : `${meta.dir}/${LOCKFILE}`;
  const lockPath = lockRel || dirLock;
  return {
    cwd,
    npmArgs,
    saved,
    manifest,
    lockOnly,
    lockPath,
    fail,
    runner: item.dep.install,
  };
};

const finishProposedNpm = (top, plan, result) => {
  const { saved, manifest, lockOnly, lockPath, fail } = plan;
  if (result && (result.error || result.status !== 0)) {
    if (saved && manifest) writeWorktreeFile(top, manifest, saved);
    if (result.error) {
      const msg = result.error.message || fail;
      throw new Error(oneLine(msg));
    }
    const msg = result.stderr || result.stdout || fail;
    throw new Error(oneLine(msg));
  }
  const toAdd = [];
  if (!lockOnly && manifest) toAdd.push(manifest);
  if (fs.existsSync(path.join(top, lockPath))) toAdd.push(lockPath);
  if (toAdd.length) requireOk(runGit(['add', '--', ...toAdd], top));
};

const applyProposedUpdate = (top, item) => {
  const plan = proposedNpmPlan(top, item);
  if (!plan) return;
  const install = plan.runner ?? ((dir) => runNpm(dir, plan.npmArgs));
  finishProposedNpm(top, plan, install(plan.cwd));
};

const applyProposedUpdateAsync = async (top, item) => {
  const plan = proposedNpmPlan(top, item);
  if (!plan) return;
  const run = plan.runner
    ? (dir) => Promise.resolve(plan.runner(dir))
    : (dir) => runNpmAsync(dir, plan.npmArgs);
  finishProposedNpm(top, plan, await run(plan.cwd));
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

const commitDiffArgs = (commit, parent, pathArgs) => {
  if (parent.status === 0) {
    const from = parent.stdout.trim();
    return [...GIT_CONFIG, 'diff', ...DIFF_OPTS, from, commit, ...pathArgs];
  }
  return [
    ...GIT_CONFIG,
    'diff-tree',
    '--no-commit-id',
    '--root',
    '-p',
    ...DIFF_OPTS,
    commit,
    ...pathArgs,
  ];
};

const pathArgsOf = (paths) => (paths.length ? ['--', ...paths] : []);

const currentBranch = (top) => {
  const args = ['rev-parse', '--abbrev-ref', 'HEAD'];
  const result = runGit(args, top);
  if (result.status !== 0) return '';
  const name = result.stdout.trim();
  if (!name || name === 'HEAD') return '';
  return name;
};

const snapshotWorktree = (top, stagedOut, unstagedOut, names) => {
  const stagedDiff = parseDiff(stagedOut);
  const unstagedDiff = parseDiff(unstagedOut);
  const staged = itemsFromFiles(stagedDiff, 'staged');
  const unstaged = itemsFromFiles(unstagedDiff, 'unstaged');
  const untracked = untrackedItemsFrom(top, names);
  const combined = mergeItems([staged, unstaged, untracked]);
  const parsed = dropReviewItems(combined);
  const branch = currentBranch(top);
  return { top, parsed, branch };
};

const snapshotCommit = (top, commit, files) => {
  const commitItems = itemsFromFiles(files, 'commit');
  const parsed = dropReviewItems(commitItems);
  const revShort = shortRev(top, commit);
  const branch = currentBranch(top);
  return { top, parsed, rev: commit, revShort, branch };
};

const loadCommit = (top, commit, extra) => {
  const parent = runGit(['rev-parse', '--verify', `${commit}^`], top);
  const args = commitDiffArgs(commit, parent, extra);
  const result = requireOk(runGit(args, top));
  return parseDiff(result.stdout);
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

const readSnapshotSync = (cwd, paths, options) => {
  const top = toplevel(cwd);
  const extra = pathArgsOf(paths);
  const rev = options.commit;
  if (rev) return snapshotCommit(top, rev, loadCommit(top, rev, extra));
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
  const names = listUntracked(top, paths);
  return snapshotWorktree(top, stagedRes.stdout, unstagedRes.stdout, names);
};

const loadCommitAsync = async (top, commit, extra, signal) => {
  const parent = await runGitAsync(
    ['rev-parse', '--verify', `${commit}^`],
    top,
    { signal },
  );
  const args = commitDiffArgs(commit, parent, extra);
  const result = requireOk(await runGitAsync(args, top, { signal }));
  return parseDiff(result.stdout);
};

const readSnapshotAsync = async (cwd, paths, options) => {
  const top = toplevel(cwd);
  const extra = pathArgsOf(paths);
  const rev = options.commit;
  const signal = options.signal;
  if (rev) {
    const files = await loadCommitAsync(top, rev, extra, signal);
    return snapshotCommit(top, rev, files);
  }
  const stagedArgs = [
    ...GIT_CONFIG,
    'diff',
    '--cached',
    ...DIFF_OPTS,
    ...extra,
  ];
  const unstagedArgs = [...GIT_CONFIG, 'diff', ...DIFF_OPTS, ...extra];
  const lsArgs = ['ls-files', '-o', '--exclude-standard', '-z'];
  if (paths.length) lsArgs.push('--', ...paths);
  const stagedP = runGitAsync(stagedArgs, top, { signal });
  const unstagedP = runGitAsync(unstagedArgs, top, { signal });
  const lsP = runGitAsync(lsArgs, top, { signal });
  const stagedRes = requireOk(await stagedP);
  const unstagedRes = requireOk(await unstagedP);
  const names = namesFromLs(requireOk(await lsP).stdout);
  return snapshotWorktree(top, stagedRes.stdout, unstagedRes.stdout, names);
};

const load = (cwd, paths = [], options = {}) => {
  const snapshot = readSnapshotSync(cwd, paths, options);
  return finishLoad(snapshot, { ...options, paths });
};

const loadAsync = async (cwd, paths = [], options = {}) => {
  const snapshot = await readSnapshotAsync(cwd, paths, options);
  return finishLoad(snapshot, { ...options, paths, deferExtras: true });
};

const usedNamesPromise = (parsed, rev, extra, top) => {
  const live = extra.audit === true && !rev;
  if (!live && !hasDepFile(parsed)) return Promise.resolve(null);
  return Promise.resolve().then(() => collectUsedNames(top));
};

const loadExtras = async (snapshot, extra = {}) => {
  const top = snapshot.top;
  const rev = snapshot.rev;
  const parsed = snapshot.parsed;
  const signal = extra.signal;
  const live = extra.audit === true && !rev;
  const hasDepDiff = hasDepFile(parsed);
  const usedP = usedNamesPromise(parsed, rev, extra, top);
  let auditP = Promise.resolve(null);
  let outdatedP = Promise.resolve(null);
  if (live) {
    auditP = collectAuditAsync(top, extra, signal);
    outdatedP = collectOutdatedAsync(top, extra, signal);
  } else if (extra.audit && hasDepDiff) {
    auditP = collectAuditAsync(top, extra, signal);
  }
  const extras = await Promise.all([usedP, auditP, outdatedP]);
  const usedNames = extras[0];
  const audit = extras[1];
  const outdated = extras[2];
  if (signal && signal.aborted) throw abortError();
  const folded = foldLoaded(parsed, top, rev, {
    ...extra,
    paths: extra.paths ?? [],
    usedNames,
    auditMap: audit,
    outdatedMap: outdated,
    collect: false,
  });
  return { ...snapshot, items: folded, pending: false };
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

const addItemAsync = async (top, item) => {
  if (item.origin === 'staged' || item.origin === 'commit') return;
  const change = depChange(item);
  if (change && change.propose) {
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
    for (const rel of byPath.keys()) {
      revertOnePath(top, rel, byPath.get(rel));
    }
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

const lastMessage = (top) => {
  const result = runGit(['log', '-1', '--format=%B'], top);
  if (result.status !== 0) return '';
  return (result.stdout ?? '').replace(/\s+$/, '');
};

const parseTrack = (text) => {
  const raw = `${text ?? ''}`.trim().replace(/^\[|\]$/g, '');
  if (!raw) return { ahead: 0, behind: 0, gone: false };
  if (raw === 'gone') return { ahead: 0, behind: 0, gone: true };
  const aheadMatch = TRACK_AHEAD.exec(raw);
  const behindMatch = TRACK_BEHIND.exec(raw);
  const ahead = aheadMatch ? Number(aheadMatch[1]) : 0;
  const behind = behindMatch ? Number(behindMatch[1]) : 0;
  return { ahead, behind, gone: false };
};

const parseBranchLine = (line) => {
  const parts = line.split('\t');
  if (parts.length < 2) return null;
  const name = (parts[1] ?? '').trim();
  if (!name) return null;
  const mark = parts[0] ?? '';
  const sha = (parts[2] ?? '').trim();
  const date = (parts[3] ?? '').trim();
  const track = parseTrack(parts[4]);
  const subject = parts.slice(5).join('\t').trim();
  return {
    name,
    current: mark.includes('*'),
    isDefault: false,
    sha,
    date,
    subject,
    ...track,
  };
};

const originHead = (top) => {
  const args = ['symbolic-ref', '--short', ORIGIN_HEAD];
  const result = runGit(args, top);
  if (result.status !== 0) return '';
  const ref = result.stdout.trim();
  const prefix = 'origin/';
  if (ref.startsWith(prefix)) return ref.slice(prefix.length);
  return ref;
};

const defaultBranch = (top, names) => {
  const remote = originHead(top);
  if (names.has(remote)) return remote;
  for (const name of DEFAULT_BRANCHES) {
    if (names.has(name)) return name;
  }
  return '';
};

const listBranches = (top) => {
  const args = ['for-each-ref', `--format=${BRANCH_FORMAT}`, 'refs/heads'];
  const result = requireOk(runGit(args, top), 'branch failed');
  const branches = [];
  for (const line of result.stdout.split('\n')) {
    if (!line) continue;
    const entry = parseBranchLine(line);
    if (entry) branches.push(entry);
  }
  const names = new Set();
  for (const entry of branches) names.add(entry.name);
  const primary = defaultBranch(top, names);
  for (const entry of branches) {
    entry.isDefault = entry.name === primary;
  }
  return branches;
};

const namedBranch = (name) => {
  const branch = `${name ?? ''}`.trim();
  if (!branch) throw new Error('empty branch name');
  return branch;
};

const checkoutBranch = (top, name) => {
  const branch = namedBranch(name);
  requireOk(runGit(['checkout', branch], top), 'checkout failed');
};

const checkoutBranchAsync = async (top, name) => {
  const branch = namedBranch(name);
  requireOk(await runGitAsync(['checkout', branch], top), 'checkout failed');
};

const createBranch = (top, name) => {
  const branch = namedBranch(name);
  const args = ['checkout', '-b', branch];
  requireOk(runGit(args, top), 'checkout failed');
};

const createBranchAsync = async (top, name) => {
  const branch = namedBranch(name);
  const args = ['checkout', '-b', branch];
  requireOk(await runGitAsync(args, top), 'checkout failed');
};

const pullChanges = (top) => {
  requireOk(runGit(['pull'], top), 'pull failed');
};

const pullChangesAsync = async (top) => {
  requireOk(await runGitAsync(['pull'], top), 'pull failed');
};

const isRejectedPush = (msg) => {
  const text = `${msg ?? ''}`.toLowerCase();
  for (const token of PUSH_REJECTED) {
    if (text.includes(token)) return true;
  }
  return false;
};

const pushError = (msg) => {
  const text = `${msg ?? ''}`;
  const rejected = isRejectedPush(text);
  const error = new Error(rejected ? 'push rejected' : oneLine(text));
  error.rejected = rejected;
  return error;
};

const pushCmd = (force) => {
  if (force) return ['push', '--force-with-lease'];
  return ['push'];
};

const pushUpstreamCmd = (force) => {
  if (force) return ['push', '--force-with-lease', '-u', 'origin', 'HEAD'];
  return ['push', '-u', 'origin', 'HEAD'];
};

const finishPush = (result, force, run) => {
  if (result.status === 0) return;
  const msg = result.stderr || result.stdout || 'push failed';
  if (!msg.toLowerCase().includes('no upstream')) {
    throw pushError(msg);
  }
  const next = run(pushUpstreamCmd(force));
  if (next.status !== 0) {
    throw pushError(next.stderr || next.stdout || 'push failed');
  }
};

const pushChanges = (top, force) => {
  const useForce = force === true;
  const result = runGit(pushCmd(useForce), top);
  finishPush(result, useForce, (args) => runGit(args, top));
};

const pushChangesAsync = async (top, force) => {
  const useForce = force === true;
  const result = await runGitAsync(pushCmd(useForce), top);
  if (result.status === 0) return;
  const msg = result.stderr || result.stdout || 'push failed';
  if (!msg.toLowerCase().includes('no upstream')) {
    throw pushError(msg);
  }
  const next = await runGitAsync(pushUpstreamCmd(useForce), top);
  if (next.status !== 0) {
    throw pushError(next.stderr || next.stdout || 'push failed');
  }
};

const hasStaged = (top) => {
  const result = runGit(['diff', '--cached', '--quiet'], top);
  return result.status === 1;
};

const commitPlan = (kind, message) => {
  if (kind === 'fixup') {
    const target = (message ?? '').trim() || 'HEAD';
    return { args: ['commit', `--fixup=${target}`], body: undefined };
  }
  const args = ['commit'];
  if (kind === 'amend') args.push('--amend');
  args.push('-F', '-');
  const text = message ?? '';
  const body = text.endsWith('\n') ? text : `${text}\n`;
  return { args, body };
};

const commitChanges = (top, kind, message) => {
  const plan = commitPlan(kind, message);
  requireOk(runGit(plan.args, top, plan.body));
};

const commitChangesAsync = async (top, kind, message) => {
  const plan = commitPlan(kind, message);
  requireOk(await runGitAsync(plan.args, top, { input: plan.body }));
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
  loadAsync,
  loadExtras,
  toplevel,
  resolveRev,
  add: addItem,
  addAsync: addItemAsync,
  unstage: unstageItem,
  revert: revertItem,
  revertFile,
  commit: commitChanges,
  commitAsync: commitChangesAsync,
  hasStaged,
  lastMessage,
  listBranches,
  currentBranch,
  checkout: checkoutBranch,
  checkoutAsync: checkoutBranchAsync,
  createBranch,
  createBranchAsync,
  pull: pullChanges,
  pullAsync: pullChangesAsync,
  push: pushChanges,
  pushAsync: pushChangesAsync,
});

module.exports = {
  load,
  loadAsync,
  loadExtras,
  addItem,
  unstageItem,
  revertItem,
  commitChanges,
  commitChangesAsync,
  hasStaged,
  currentBranch,
  lastMessage,
  listBranches,
  checkoutBranch,
  checkoutBranchAsync,
  createBranch,
  createBranchAsync,
  pullChanges,
  pullChangesAsync,
  pushChanges,
  pushChangesAsync,
  createGitRepo,
};
