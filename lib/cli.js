'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { createGitRepo } = require('./git.js');
const { Session } = require('./session.js');
const { ACTIONS, actionHot } = require('./keys.js');

const helpText = () => {
  const lines = [
    'Usage: metadiff [commit] [path...]',
    '',
    'Review uncommitted git changes, or a given commit (read only).',
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
  let help = false;
  let version = false;
  for (const arg of argv) {
    if (arg === '-h' || arg === '--help') {
      help = true;
      continue;
    }
    if (arg === '-v' || arg === '--version') {
      version = true;
      continue;
    }
    if (arg.startsWith('-')) {
      throw new Error(`unknown option ${arg}`);
    }
    paths.push(arg);
  }
  return { paths, help, version };
};

const looksLikeRev = (spec) => {
  if (!spec) return false;
  if (/^[0-9a-f]{4,40}$/i.test(spec)) return true;
  if (/^HEAD([~^].*)?$/i.test(spec)) return true;
  return /[~^]/.test(spec);
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

const startPaneFromPaths = (cwd, paths, statSync = fs.statSync) => {
  if (!paths.length) return 'files';
  for (const rel of paths) {
    const full = path.resolve(cwd, rel);
    let st;
    try {
      st = statSync(full);
    } catch {
      return 'diff';
    }
    if (st.isFile()) return 'diff';
  }
  return 'files';
};

const run = async (proc, deps = {}) => {
  const stdout = proc.stdout;
  const stderr = proc.stderr;
  const env = proc.env ?? {};
  let args;
  try {
    args = parseArgv(proc.argv.slice(2));
  } catch (error) {
    stderr.write(`metadiff: ${error.message}\n`);
    return 1;
  }
  if (args.help) {
    stdout.write(helpText());
    return 0;
  }
  if (args.version) {
    const pkgPath = path.join(__dirname, '..', 'package.json');
    const pkg = deps.pkg ?? JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    stdout.write(`${pkg.version}\n`);
    return 0;
  }
  const repo = deps.repo ?? createGitRepo();
  const cwd = deps.cwd ?? proc.cwd();
  const statSync = deps.statSync ?? fs.statSync;
  let scope;
  try {
    scope = resolveScope(cwd, args.paths, repo, statSync);
  } catch (error) {
    stderr.write(`metadiff: ${error.message}\n`);
    return 1;
  }
  const session = new Session({
    repo,
    cwd,
    paths: scope.paths,
    rev: scope.rev,
    stdin: proc.stdin,
    stdout,
    color: Boolean(stdout.isTTY) && !env.NO_COLOR,
    getSize: deps.getSize,
    startPane: startPaneFromPaths(cwd, scope.paths, statSync),
  });
  try {
    session.load();
  } catch (error) {
    stderr.write(`metadiff: ${error.message}\n`);
    return 1;
  }
  if (!session.items.length) {
    stdout.write('nothing to review\n');
    return 0;
  }
  if (!proc.stdin.isTTY || !stdout.isTTY) {
    stderr.write('metadiff: interactive terminal required\n');
    return 1;
  }
  return session.startUi();
};

module.exports = {
  run,
  parseArgv,
  helpText,
  startPaneFromPaths,
  resolveScope,
  looksLikeRev,
};
