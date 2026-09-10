'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { createGitRepo } = require('./git.js');
const { githubToken, loadPullRequest } = require('./github.js');
const { selectChangeSource, createLoadedSource } = require('./source.js');
const { Session } = require('./session.js');

const HEX_REV = /^[0-9a-f]{4,40}$/i;
const HEAD_REV = /^HEAD([~^].*)?$/i;
const RANGE_REV = /[~^]/;

const USAGE = 'Usage: reslop [-n] [path | commit | pr-url]';

const errorMessage = (reason) => {
  if (reason instanceof Error) return reason.message;
  if (reason === null || reason === undefined) return '';
  if (typeof reason === 'string') return reason;
  return `${reason}`;
};

const fail = (stderr, reason) => {
  stderr.write(`reslop: ${errorMessage(reason)}\n`);
  return 1;
};

const failUsage = (stderr, reason) => {
  fail(stderr, reason);
  stderr.write(`${USAGE}\n`);
  return 1;
};

const parseArgv = (argv) => {
  const paths = [];
  let newReview = false;
  for (const arg of argv) {
    if (arg === '-n') {
      newReview = true;
      continue;
    }
    if (arg.startsWith('-')) {
      throw new Error(`unknown option ${arg}`);
    }
    paths.push(arg);
  }
  return { paths, newReview };
};

const looksLikeRev = (spec) => {
  if (!spec) return false;
  if (HEX_REV.test(spec)) return true;
  if (HEAD_REV.test(spec)) return true;
  return RANGE_REV.test(spec);
};

const pathExists = (cwd, rel, statSync) => {
  try {
    statSync(path.resolve(cwd, rel));
    return true;
  } catch {
    return false;
  }
};

const resolveScope = (cwd, paths, repo, statSync = fs.statSync) => {
  if (!paths.length) return { rev: null, paths };
  const first = paths[0];
  if (pathExists(cwd, first, statSync)) {
    return { rev: null, paths };
  }
  const resolved = repo.resolveRev ? repo.resolveRev(cwd, first) : null;
  if (resolved) {
    if (paths.length > 1) {
      throw new Error('use a commit or a path, not both');
    }
    return { rev: resolved, paths: [] };
  }
  if (looksLikeRev(first)) {
    throw new Error(`bad revision ${first}`);
  }
  return { rev: null, paths };
};

const isColorEnabled = (stdout, env) => stdout.isTTY === true && !env.NO_COLOR;

const openLocalSession = (proc, deps, args, env) => {
  const stdout = proc.stdout;
  const repo = deps.repo ?? createGitRepo();
  const cwd = deps.cwd ?? proc.cwd();
  const statSync = deps.statSync ?? fs.statSync;
  const scope = resolveScope(cwd, args.paths, repo, statSync);
  const session = new Session({
    repo,
    cwd,
    paths: scope.paths,
    rev: scope.rev,
    stdin: proc.stdin,
    stdout,
    color: isColorEnabled(stdout, env),
    getSize: deps.getSize,
    startPane: 'files',
    newReview: args.newReview,
    audit: true,
  });
  session.load();
  return session;
};

const openPullRequestSession = async (proc, deps, args, selected, env) => {
  const stdout = proc.stdout;
  const cwd = deps.cwd ?? proc.cwd();
  const loader = deps.loadPullRequest ?? loadPullRequest;
  const token = githubToken(env);
  const loaded = await loader(selected.pr, {
    cwd,
    paths: selected.paths,
    token,
    fetch: deps.fetch,
    env,
  });
  const change = loaded.change ?? null;
  const repository = change ? change.repository : '';
  const repo = deps.repo ?? createLoadedSource(loaded);
  const session = new Session({
    repo,
    cwd,
    paths: selected.paths,
    stdin: proc.stdin,
    stdout,
    color: isColorEnabled(stdout, env),
    getSize: deps.getSize,
    startPane: 'files',
    newReview: args.newReview,
    repoName: repository,
    sourceLabel: loaded.sourceLabel,
    change,
    audit: true,
  });
  session.load();
  return session;
};

const loadSession = async (proc, deps, args) => {
  const env = proc.env ?? {};
  const selected = selectChangeSource(args.paths);
  if (selected.kind === 'github-pr') {
    return openPullRequestSession(proc, deps, args, selected, env);
  }
  return openLocalSession(proc, deps, args, env);
};

const run = async (proc, deps = {}) => {
  const stdout = proc.stdout;
  const stderr = proc.stderr;
  let args;
  try {
    args = parseArgv(proc.argv.slice(2));
  } catch (error) {
    return failUsage(stderr, error);
  }
  let session;
  try {
    session = await loadSession(proc, deps, args);
  } catch (error) {
    return fail(stderr, error);
  }
  if (!session.items.length) {
    stdout.write('nothing to review\n');
    return 0;
  }
  if (!proc.stdin.isTTY || !stdout.isTTY) {
    stderr.write('reslop: interactive terminal required\n');
    return 1;
  }
  return session.startUi();
};

module.exports = {
  run,
  parseArgv,
  resolveScope,
  looksLikeRev,
  selectChangeSource,
  errorMessage,
};
