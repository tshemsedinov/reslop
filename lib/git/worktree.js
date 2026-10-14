'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { runProc, isAbort, abortError } = require('../common/process.js');
const { oneLine } = require('../common/utilities.js');
const diff = require('../diff/diff.js');
const { parseDiff, synthesizeNewFile, itemsFromFiles } = diff;
const files = require('../common/files.js');
const { groupByPath } = files;
const { itemPath, isReadOnlyOrigin, lineDelta, REVIEW_DIR } = files;
const local = require('./local.js');
const { worktreeRoot, branchOf, remoteOrigin } = local;
const { parseStatus } = require('./status.js');
const { replaceBlockAdds } = require('../diff/patch.js');

const GIT_CONFIG = [
  '-c',
  'core.quotepath=false',
  '-c',
  'i18n.logOutputEncoding=utf-8',
];
const DIFF_OPTS = ['--no-color', '--no-ext-diff', '--no-renames', '-U3'];
const BINARY_SIZE = 1000000;
const STATUS_ARGS = [
  '-c',
  'core.quotepath=false',
  '-c',
  'color.ui=false',
  '-c',
  'diff.renames=false',
  'status',
  '-vv',
  '--no-renames',
  '--no-ahead-behind',
  '-uall',
];
const STATUS_ENV = { LC_MESSAGES: 'C', LANGUAGE: 'C' };

const gitOptions = (cwd, extra) => ({
  cwd,
  env: {
    ...process.env,
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'Never',
    ...extra.env,
  },
  input: extra.input,
  signal: extra.signal,
});

const gitResult = (result) => {
  if (!result.error) return result;
  if (isAbort(result.error)) throw result.error;
  if (result.error.code === 'ENOENT') throw new Error('git not found');
  throw result.error;
};

const requireOk = (result, fallback = 'git failed') => {
  if (result.status === 0) return result;
  const msg = result.stderr || result.stdout || fallback;
  throw new Error(oneLine(msg, fallback));
};

const runGit = (args, cwd, extra = {}) =>
  runProc('git', args, gitOptions(cwd, extra)).then(gitResult);

const command = (args, extra = {}) => ({
  args,
  input: extra.input,
  env: extra.env,
});

const runSteps = async (steps, top, signal) => {
  try {
    let step = steps.next();
    while (!step.done) {
      const extra = { ...step.value, signal };
      step = steps.next(await runGit(step.value.args, top, extra));
    }
    return step.value;
  } finally {
    steps.return();
  }
};

const gitOp =
  (op) =>
  (top, ...args) =>
    runSteps(op(...args), top);

const pathArgs = (paths) => (paths.length ? ['--', ...paths] : []);

const diffArgs = (revs, paths) => [
  ...GIT_CONFIG,
  'diff',
  ...DIFF_OPTS,
  ...revs,
  ...pathArgs(paths),
];

const commitDiffArgs = (commit, parent, paths) => {
  if (parent.status === 0) {
    return diffArgs([parent.stdout.trim(), commit], paths);
  }
  return [
    ...GIT_CONFIG,
    'diff-tree',
    '--no-commit-id',
    '--root',
    '-p',
    ...DIFF_OPTS,
    commit,
    ...pathArgs(paths),
  ];
};

const untrackedArgs = (paths) => [
  'ls-files',
  '-o',
  '--exclude-standard',
  '-z',
  ...pathArgs(paths),
];

const isReviewFile = (rel) => rel.split(/[/\\]/)[0] === REVIEW_DIR;

const isDirEntry = (rel) => rel.endsWith('/');

const dropReviewItems = (items) =>
  items.filter((item) => !isReviewFile(itemPath(item)));

const isBinaryBuffer = (buf) => buf.length > BINARY_SIZE || buf.includes(0);

const namesFromLs = (stdout) => stdout.split('\0').filter(Boolean);

const listScopeFiles = async (top, paths = [], options = {}) => {
  const rev = options.commit;
  const scope = pathArgs(paths);
  let args = ['ls-files', '-co', '--exclude-standard', '-z', ...scope];
  if (rev) args = ['ls-tree', '-r', '--name-only', '-z', rev, ...scope];
  const result = requireOk(await runGit(args, top), 'ls-files failed');
  const names = namesFromLs(result.stdout).filter(
    (rel) => !isReviewFile(rel) && !isDirEntry(rel),
  );
  names.sort((left, right) => left.localeCompare(right, 'en'));
  return names;
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

const UNTRACKED_READS = 16;

const untrackedNames = (names) => {
  const keep = (rel) => !isReviewFile(rel) && !isDirEntry(rel);
  return names.filter(keep);
};

const untrackedFile = (rel, buf) => {
  if (isBinaryBuffer(buf)) return binaryNewFile(rel);
  const text = buf.toString('utf8');
  return synthesizeNewFile(rel, text);
};

const isGone = (error) => error.code === 'ENOENT' || error.code === 'EISDIR';

const untrackedItemsFrom = (top, names) => {
  const files = [];
  for (const rel of untrackedNames(names)) {
    try {
      files.push(untrackedFile(rel, fs.readFileSync(path.join(top, rel))));
    } catch (error) {
      if (!isGone(error)) throw error;
    }
  }
  return itemsFromFiles(files, 'untracked');
};

const readUntracked = async (top, rel) => {
  try {
    return untrackedFile(rel, await fs.promises.readFile(path.join(top, rel)));
  } catch (error) {
    if (isGone(error)) return null;
    throw error;
  }
};

const untrackedItems = async (top, names) => {
  const rels = untrackedNames(names);
  const files = [];
  for (let at = 0; at < rels.length; at += UNTRACKED_READS) {
    const batch = rels.slice(at, at + UNTRACKED_READS);
    const read = await Promise.all(batch.map((rel) => readUntracked(top, rel)));
    for (const file of read) if (file) files.push(file);
  }
  return itemsFromFiles(files, 'untracked');
};

const addedOf = (names, top) => {
  let added = 0;
  for (const item of untrackedItemsFrom(top, names)) {
    added += lineDelta(item).added;
  }
  return added;
};

const gitText = async (top, spec) => {
  const result = await runGit(['show', spec], top);
  return result.status === 0 ? result.stdout : '';
};

const worktreeText = async (top, rel) => {
  try {
    return await fs.promises.readFile(path.join(top, rel), 'utf8');
  } catch {
    return '';
  }
};

const indexedText = async (top, rel) => {
  const staged = await gitText(top, `:${rel}`);
  return staged || gitText(top, `HEAD:${rel}`);
};

const fileText = async (top, rel, rev) => {
  if (!rel) return '';
  if (rev) return gitText(top, `${rev}:${rel}`);
  return worktreeText(top, rel);
};

const DEP_SIDES = {
  untracked: (top, rel) => ['', worktreeText(top, rel)],
  staged: (top, rel) => [gitText(top, `HEAD:${rel}`), gitText(top, `:${rel}`)],
  unstaged: (top, rel) => [indexedText(top, rel), worktreeText(top, rel)],
  commit: (top, rel, rev) => [
    gitText(top, `${rev}^:${rel}`),
    gitText(top, `${rev}:${rel}`),
  ],
};

const readDepSides = async (top, rev, origin, rel) => {
  const known = Object.hasOwn(DEP_SIDES, origin);
  if (!known || (origin === 'commit' && !rev)) {
    return { oldText: '', newText: '' };
  }
  const reads = DEP_SIDES[origin](top, rel, rev);
  const [oldText, newText] = await Promise.all(reads);
  return { oldText, newText };
};

const toplevelGit = async (cwd, signal) => {
  const args = ['rev-parse', '--show-toplevel'];
  const result = await runGit(args, cwd, { signal });
  if (result.status !== 0) throw new Error('not a git repository');
  return result.stdout.trim();
};

const toplevel = async (cwd, signal) => {
  if (signal && signal.aborted) throw abortError();
  if (process.env.GIT_DIR || process.env.GIT_WORK_TREE) {
    return toplevelGit(cwd, signal);
  }
  const found = worktreeRoot(cwd);
  if (found) return found;
  return toplevelGit(cwd, signal);
};

const resolveRev = async (cwd, spec) => {
  if (!spec) return null;
  const args = ['rev-parse', '--verify', `${spec}^{commit}`];
  const result = await runGit(args, await toplevel(cwd));
  return result.status === 0 ? result.stdout.trim() : null;
};

const shortRev = async (top, commit) => {
  const result = await runGit(['rev-parse', '--short', commit], top);
  return result.status === 0 ? result.stdout.trim() : commit.slice(0, 7);
};

const currentBranch = async (top) => {
  const root = worktreeRoot(top);
  if (root) return branchOf(root);
  const args = ['rev-parse', '--abbrev-ref', 'HEAD'];
  const result = await runGit(args, top);
  if (result.status !== 0) return '';
  const name = result.stdout.trim();
  return name === 'HEAD' ? '' : name;
};

const repositoryUrl = (raw) => {
  let value = `${raw ?? ''}`.trim();
  if (!value) return '';
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/.exec(value);
  if (scp && !value.includes('://')) value = `https://${scp[1]}/${scp[2]}`;
  else if (value.startsWith('git+')) value = value.slice(4);
  let url;
  try {
    url = new URL(value);
  } catch {
    return '';
  }
  if (!['http:', 'https:', 'git:', 'ssh:'].includes(url.protocol)) return '';
  url.protocol = 'https:';
  url.username = '';
  url.password = '';
  if (url.port === '22') url.port = '';
  url.search = '';
  url.hash = '';
  url.pathname = url.pathname.replace(/\.git\/?$/i, '').replace(/\/$/, '');
  return url.toString().replace(/\/$/, '');
};

const worktreeSnapshot = (top, outputs, untracked, branch, repoUrl) => {
  const staged = itemsFromFiles(parseDiff(outputs[0]), 'staged');
  const unstaged = itemsFromFiles(parseDiff(outputs[1]), 'unstaged');
  const grouped = groupByPath([...staged, ...unstaged, ...untracked]);
  const parsed = dropReviewItems([...grouped.values()].flat());
  return { top, parsed, branch, repositoryUrl: repoUrl };
};

const snapshotCommit = async (top, commit, files) => {
  const parsed = dropReviewItems(itemsFromFiles(files, 'commit'));
  const revShort = await shortRev(top, commit);
  const branch = await currentBranch(top);
  const repoUrl = repositoryUrl(remoteOrigin(top));
  return { top, parsed, rev: commit, revShort, branch, repositoryUrl: repoUrl };
};

function* commitDiff(commit, paths) {
  const parent = yield command(['rev-parse', '--verify', `${commit}^`]);
  const result = yield command(commitDiffArgs(commit, parent, paths));
  return parseDiff(requireOk(result).stdout);
}

const worktreeCommands = (paths) => [
  diffArgs(['--cached'], paths),
  diffArgs([], paths),
  untrackedArgs(paths),
];

const gitView = async (top, paths, signal) => {
  const commands = worktreeCommands(paths);
  const running = commands.map((args) => runGit(args, top, { signal }));
  const results = await Promise.all(running);
  const outputs = results.map((result) => requireOk(result).stdout);
  return {
    staged: outputs[0],
    work: outputs[1],
    untracked: namesFromLs(outputs[2]),
  };
};

const worktreeView = async (top, paths, signal) => {
  // status -vv prints every diff and ignores the pathspec
  if (paths.length) return gitView(top, paths, signal);
  const extra = { signal, env: STATUS_ENV };
  const result = await runGit(STATUS_ARGS, top, extra);
  if (result.status !== 0) return gitView(top, paths, signal);
  const parsed = parseStatus(result.stdout);
  if (!parsed) return gitView(top, paths, signal);
  return parsed;
};

const countUntrackedAdded = async (top) => {
  try {
    const view = await worktreeView(top, []);
    return addedOf(view.untracked, top);
  } catch {
    return 0;
  }
};

const readSnapshot = async (cwd, paths, options) => {
  const { commit: rev, signal } = options;
  const top = await toplevel(cwd, signal);
  if (rev) {
    const files = await runSteps(commitDiff(rev, paths), top, signal);
    return snapshotCommit(top, rev, files);
  }
  const view = await worktreeView(top, paths, signal);
  const untracked = await untrackedItems(top, view.untracked);
  const branch = await currentBranch(top);
  const repoUrl = repositoryUrl(remoteOrigin(top));
  const outputs = [view.staged, view.work];
  return worktreeSnapshot(top, outputs, untracked, branch, repoUrl);
};

const applyPatch = async (cwd, patch, flags) => {
  const args = ['apply', ...flags, '--whitespace=nowarn', '-'];
  const result = await runGit(args, cwd, { input: patch });
  requireOk(result, 'apply failed');
};

const gitOk = async (args, top) => requireOk(await runGit(args, top));

const addItem = async (top, item) => {
  if (item.origin === 'staged' || item.origin === 'commit') return;
  if (item.origin === 'untracked' || item.file.isBinary) {
    await gitOk(['add', '--', item.file.newPath], top);
    return;
  }
  await applyPatch(top, item.patchAdd, ['--cached']);
};

const unstageItem = async (top, item) => {
  if (item.origin !== 'staged') return;
  if (item.file.isBinary) {
    await gitOk(['restore', '--staged', '--', itemPath(item)], top);
    return;
  }
  await applyPatch(top, item.patchAdd, ['--reverse', '--cached']);
};

const revertOnePath = async (top, rel, items) => {
  const origins = new Set(items.map((item) => item.origin));
  const isNew = items.some((item) => item.file?.isNew);
  if (isNew && origins.has('staged')) {
    await gitOk(['rm', '-f', '--', rel], top);
    return;
  }
  const onlyUntracked = origins.size === 1 && origins.has('untracked');
  if (isNew || onlyUntracked) return void fs.unlinkSync(path.join(top, rel));
  const args = ['restore', '-s', 'HEAD', '--worktree', '--staged', '--', rel];
  await gitOk(args, top);
};

const revertItem = async (top, item) => {
  const rel = itemPath(item);
  if (item.origin === 'untracked') {
    return void fs.unlinkSync(path.join(top, rel));
  }
  if (item.file.isBinary) {
    const args = ['restore', '-s', 'HEAD', '--worktree'];
    if (item.origin === 'staged') args.push('--staged');
    await gitOk([...args, '--', rel], top);
    return;
  }
  if (item.origin === 'unstaged') {
    await applyPatch(top, item.patchRevert, ['--reverse']);
    return;
  }
  await applyPatch(top, item.patchRevert, ['--reverse', '--cached']);
  try {
    await applyPatch(top, item.patchRevert, ['--reverse']);
  } catch (error) {
    if (!error.message.includes('does not apply')) throw error;
  }
};

const isExecutable = async (abs) => {
  try {
    const stat = await fs.promises.stat(abs);
    return (stat.mode & 0o111) !== 0;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return false;
  }
};

const indexMode = async (top, rel) => {
  const result = await gitOk(['ls-files', '--stage', '--', rel], top);
  const line = result.stdout.trim();
  if (line) return line.split(' ')[0];
  const executable = await isExecutable(path.join(top, rel));
  return executable ? '100755' : '100644';
};

const writeIndex = async (top, rel, text) => {
  const hashArgs = ['hash-object', '-w', `--path=${rel}`, '--stdin'];
  const hashed = await runGit(hashArgs, top, { input: text });
  const sha = requireOk(hashed, 'hash-object failed').stdout.trim();
  const mode = await indexMode(top, rel);
  const args = ['update-index', '--add', '--cacheinfo', mode, sha, rel];
  requireOk(await runGit(args, top), 'update-index failed');
};

const readIfPresent = async (abs) => {
  try {
    return await fs.promises.readFile(abs, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return null;
  }
};

const editStaged = async (top, rel, abs, item, text) => {
  const shown = await runGit(['show', `:${rel}`], top);
  const source = requireOk(shown, 'show failed').stdout;
  const next = replaceBlockAdds(source, item.hunk, item.blockId, text);
  await writeIndex(top, rel, next);
  const work = await readIfPresent(abs);
  if (work === null || work === source) await fs.promises.writeFile(abs, next);
};

const editWorktree = async (abs, item, text) => {
  const source = await fs.promises.readFile(abs, 'utf8');
  const next = replaceBlockAdds(source, item.hunk, item.blockId, text);
  if (next !== source) await fs.promises.writeFile(abs, next);
};

const editItem = async (top, item, text) => {
  if (isReadOnlyOrigin(item.origin)) return;
  const rel = itemPath(item);
  if (!rel || !item.hunk) return;
  const abs = path.join(top, rel);
  if (item.origin === 'staged') await editStaged(top, rel, abs, item, text);
  else await editWorktree(abs, item, text);
};

const writeFile = async (top, rel, text) => {
  if (!rel) return;
  const abs = path.join(top, rel);
  await fs.promises.mkdir(path.dirname(abs), { recursive: true });
  await fs.promises.writeFile(abs, text);
};

const stagePath = async (top, rel) => {
  if (rel) await gitOk(['add', '--', rel], top);
};

const sumDelta = (items) => {
  let added = 0;
  let removed = 0;
  for (const item of items) {
    const delta = lineDelta(item);
    added += delta.added;
    removed += delta.removed;
  }
  return { added, removed };
};

const diffCounts = async (top) => {
  const view = await worktreeView(top, []);
  const staged = sumDelta(itemsFromFiles(parseDiff(view.staged), 'staged'));
  const open = sumDelta(itemsFromFiles(parseDiff(view.work), 'unstaged'));
  return {
    stagedAdded: staged.added,
    unstagedAdded: open.added + addedOf(view.untracked, top),
    stagedRemoved: staged.removed,
    unstagedRemoved: open.removed,
  };
};

module.exports = {
  requireOk,
  gitOk,
  runGit,
  command,
  gitOp,
  groupByPath,
  gitText,
  indexedText,
  worktreeText,
  readDepSides,
  revertOnePath,
  toplevel,
  resolveRev,
  currentBranch,
  fileText,
  countUntrackedAdded,
  diffCounts,
  listScopeFiles,
  readSnapshot,
  editItem,
  writeFile,
  writeIndex,
  stagePath,
  addItem,
  unstageItem,
  revertItem,
};
