'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { createGitRepo } = require('./git.js');
const { githubToken, loadPullRequest } = require('./github.js');
const { selectChangeSource, createLoadedSource } = require('./source.js');
const { Session } = require('./session.js');
const { ACTIONS, actionHot } = require('./keys.js');

const FLAGS = Object.assign(Object.create(null), {
  '-h': 'help',
  '--help': 'help',
  '-v': 'version',
  '--version': 'version',
  '-n': 'newReview',
  '--new': 'newReview',
});

const HEX_REV = /^[0-9a-f]{4,40}$/i;
const HEAD_REV = /^HEAD([~^].*)?$/i;
const RANGE_REV = /[~^]/;

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

const helpText = () => {
  const lines = [
    'Usage: reslop [-n] [commit | pull-request-url] [path...]',
    '',
    'Review uncommitted git changes, a commit, or a GitHub pull request.',
    'Commit and pull request review is read only.',
    'Resumes the latest .review file when its status is editing.',
    'Finish marks the review ready for the agent to execute.',
    'Use -n / --new to start a new review file.',
    '',
    'Keys:',
  ];
  for (const action of ACTIONS) {
    lines.push(`  ${actionHot(action)}    ${action.label}`);
  }
  lines.push('  ?    Help');
  lines.push('');
  return `${lines.join('\n')}\n`;
};

const parseArgv = (argv) => {
  const paths = [];
  const flags = { help: false, version: false, newReview: false };
  for (const arg of argv) {
    const flag = FLAGS[arg];
    if (flag) {
      flags[flag] = true;
      continue;
    }
    if (arg.startsWith('-')) {
      throw new Error(`unknown option ${arg}`);
    }
    paths.push(arg);
  }
  const help = flags.help;
  const version = flags.version;
  const newReview = flags.newReview;
  return { paths, help, version, newReview };
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
  if (resolved) return { rev: resolved, paths: paths.slice(1) };
  if (looksLikeRev(first)) {
    throw new Error(`bad revision ${first}`);
  }
  return { rev: null, paths };
};

const writeHelp = (stdout) => {
  stdout.write(helpText());
  return 0;
};

const writeVersion = (stdout, deps) => {
  const pkgPath = path.join(__dirname, '..', 'package.json');
  const pkg = deps.pkg ?? JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  stdout.write(`${pkg.version}\n`);
  return 0;
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
    startPane: 'diff',
    newReview: args.newReview,
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
    startPane: 'diff',
    newReview: args.newReview,
    repoName: repository,
    sourceLabel: loaded.sourceLabel,
    change,
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
    return fail(stderr, error);
  }
  if (args.help) return writeHelp(stdout);
  if (args.version) return writeVersion(stdout, deps);
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
  helpText,
  resolveScope,
  looksLikeRev,
  selectChangeSource,
  errorMessage,
};
