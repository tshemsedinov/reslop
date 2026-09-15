'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { createGitRepo } = require('./git.js');
const { githubToken, loadPullRequest } = require('./github.js');
const { gitlabToken, loadMergeRequest } = require('./gitlab.js');
const { selectChangeSource, createLoadedSource } = require('./source.js');
const { Session } = require('./session.js');

const HEX_REV = /^[0-9a-f]{4,40}$/i;
const HEAD_REV = /^HEAD([~^].*)?$/i;
const RANGE_REV = /[~^]/;

const USAGE = 'Usage: reslop [-n] [-r] [path | commit | pr-url | mr-url]';

const REMOTE_CHANGE = {
  'github-pr': {
    load: 'loadPullRequest',
    fallback: loadPullRequest,
    token: githubToken,
    target: (selected) => selected.pr,
  },
  'gitlab-mr': {
    load: 'loadMergeRequest',
    fallback: loadMergeRequest,
    token: gitlabToken,
    target: (selected) => selected.mr,
  },
};

const errorMessage = (reason) => {
  if (reason instanceof Error) return reason.message;
  if (reason === null || reason === undefined) return '';
  if (typeof reason === 'string') return reason;
  return `${reason}`;
};

const failLine = (reason) => `reslop: ${errorMessage(reason)}\n`;

const fail = (stderr, reason) => {
  stderr.write(failLine(reason));
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
  let readOnly = false;
  for (const arg of argv) {
    if (arg === '-n') {
      newReview = true;
      continue;
    }
    if (arg === '-r') {
      readOnly = true;
      continue;
    }
    if (arg.startsWith('-')) {
      throw new Error(`unknown option ${arg}`);
    }
    paths.push(arg);
  }
  return { paths, newReview, readOnly };
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
  const resolved = repo.resolveRev(cwd, first);
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

const sessionOptions = (proc, deps, args, env, extra) => ({
  cwd: deps.cwd ?? proc.cwd(),
  stdin: proc.stdin,
  stdout: proc.stdout,
  color: isColorEnabled(proc.stdout, env),
  getSize: deps.getSize,
  startPane: 'files',
  newReview: args.newReview,
  readOnly: args.readOnly,
  audit: true,
  ...extra,
});

const startSession = (options, extra = {}) => {
  const session = new Session(options);
  if (extra.load) session.load();
  return session;
};

const openLocalSession = (proc, deps, args, selected, env) => {
  const cwd = deps.cwd ?? proc.cwd();
  const repo = deps.repo ?? createGitRepo();
  const statSync = deps.statSync ?? fs.statSync;
  const scope = resolveScope(cwd, selected.paths, repo, statSync);
  const session = startSession(
    sessionOptions(proc, deps, args, env, {
      repo,
      paths: scope.paths,
      rev: scope.rev,
    }),
  );
  session.ensureRepo();
  return session;
};

const remoteRepo = (deps, selected, env, cwd) => {
  if (deps.repo) return deps.repo;
  const remote = REMOTE_CHANGE[selected.kind];
  const loader = deps[remote.load] ?? remote.fallback;
  const token = remote.token(env);
  const loadRemote = async () => {
    const loaded = await loader(remote.target(selected), {
      cwd,
      paths: selected.paths,
      token,
      fetch: deps.fetch,
    });
    const items = loaded.items ?? [];
    return { ...loaded, items: [...items] };
  };
  const repo = createLoadedSource({ items: [] });
  repo.loadAsync = loadRemote;
  return repo;
};

const openRemoteSession = (proc, deps, args, selected, env) => {
  const cwd = deps.cwd ?? proc.cwd();
  return startSession(
    sessionOptions(proc, deps, args, env, {
      repo: remoteRepo(deps, selected, env, cwd),
      paths: selected.paths,
    }),
  );
};

const loadSession = async (proc, deps, args) => {
  const env = proc.env ?? {};
  const selected = selectChangeSource(args.paths);
  if (REMOTE_CHANGE[selected.kind]) {
    return openRemoteSession(proc, deps, args, selected, env);
  }
  return openLocalSession(proc, deps, args, selected, env);
};

const runUi = async (session, proc) => {
  const code = await session.startUi();
  if (session.loadError) return fail(proc.stderr, session.loadError);
  if (session.emptyReview) proc.stdout.write('nothing to review\n');
  return code;
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
  const tty = proc.stdin.isTTY === true && stdout.isTTY === true;
  if (tty) return runUi(session, proc);
  try {
    await session.loadReady();
  } catch (error) {
    return fail(stderr, error);
  }
  if (!session.items.length) {
    stdout.write('nothing to review\n');
    return 0;
  }
  stderr.write('reslop: interactive terminal required\n');
  return 1;
};

module.exports = {
  failLine,
  parseArgv,
  resolveScope,
  run,
};
