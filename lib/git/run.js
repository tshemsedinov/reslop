'use strict';

const proc = require('./proc.js');
const { runProc, runProcSync, isAbort } = proc;

const oneLine = (text, fallback = 'git failed') => proc.oneLine(text, fallback);

const GIT_CONFIG = [
  '-c',
  'core.quotepath=false',
  '-c',
  'i18n.logOutputEncoding=utf-8',
];
const DIFF_OPTS = ['--no-color', '--no-ext-diff', '--no-renames', '-U3'];
const GIT_ENCODING = proc.DEFAULT_ENCODING;
const GIT_MAX_BUFFER = proc.DEFAULT_MAX_BUFFER;

const gitEnv = () => ({ ...process.env, GIT_OPTIONAL_LOCKS: '0' });

const gitProcOptions = (cwd, extra = {}) => ({
  cwd,
  env: gitEnv(),
  encoding: GIT_ENCODING,
  maxBuffer: GIT_MAX_BUFFER,
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

const runGit = (args, cwd, input) => {
  const options = gitProcOptions(cwd, { input });
  return gitResult(runProcSync('git', args, options));
};

const runGitAsync = (args, cwd, extra = {}) => {
  const options = gitProcOptions(cwd, extra);
  return runProc('git', args, options).then(gitResult);
};

const pathArgsOf = (paths) => (paths.length ? ['--', ...paths] : []);

const cachedDiffArgs = (pathArgs) => [
  ...GIT_CONFIG,
  'diff',
  '--cached',
  ...DIFF_OPTS,
  ...pathArgs,
];

const worktreeDiffArgs = (pathArgs) => [
  ...GIT_CONFIG,
  'diff',
  ...DIFF_OPTS,
  ...pathArgs,
];

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

module.exports = {
  GIT_CONFIG,
  DIFF_OPTS,
  GIT_ENCODING,
  GIT_MAX_BUFFER,
  oneLine,
  gitResult,
  requireOk,
  runGit,
  runGitAsync,
  pathArgsOf,
  cachedDiffArgs,
  worktreeDiffArgs,
  commitDiffArgs,
};
