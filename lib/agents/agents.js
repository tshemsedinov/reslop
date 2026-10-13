'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { IS_WIN } = require('../common/process.js');
const { trimText } = require('../common/utilities.js');
const { COMMANDS } = require('./allow.js');
const models = require('./models.js');
const { choiceOf } = models;
const { startRun, probeSession } = require('./run.js');

const GITDIR_PREFIX = 'gitdir:';
const CODEX_SANDBOX = 'sandbox_workspace_write';
const CODEX_ROOTS = 'writable_roots';

const statOf = (file) => {
  try {
    return fs.statSync(file);
  } catch {
    return null;
  }
};

const readFirstLine = (file) => {
  try {
    return fs.readFileSync(file, 'utf8').split('\n')[0] ?? '';
  } catch {
    return '';
  }
};

const realPath = (file) => {
  try {
    return fs.realpathSync.native(file);
  } catch {
    return path.resolve(file);
  }
};

const gitDirOf = (dot) => {
  const line = readFirstLine(dot).trim();
  if (!line.startsWith(GITDIR_PREFIX)) return '';
  const raw = line.slice(GITDIR_PREFIX.length).trim();
  if (!raw) return '';
  return path.resolve(path.dirname(dot), raw);
};

const commonGitDir = (gitDir) => {
  const raw = readFirstLine(path.join(gitDir, 'commondir')).trim();
  if (!raw) return gitDir;
  return path.resolve(gitDir, raw);
};

// workspace-write remounts .git read-only unless that path is itself writable.
const gitWriteRoots = (cwd) => {
  if (!cwd) return [];
  const dot = path.join(path.resolve(cwd), '.git');
  const stat = statOf(dot);
  if (!stat) return [];
  if (stat.isDirectory()) return [realPath(dot)];
  if (!stat.isFile()) return [];
  const gitDir = gitDirOf(dot);
  if (!gitDir) return [];
  const roots = [realPath(gitDir), realPath(commonGitDir(gitDir))];
  return [...new Set(roots)];
};

// The adapter merges this into the session config of codex
const codexEnv = (cwd, env = process.env) => {
  const roots = gitWriteRoots(cwd);
  if (!roots.length || env.CODEX_CONFIG) return {};
  const config = { [CODEX_SANDBOX]: { [CODEX_ROOTS]: roots } };
  return { CODEX_CONFIG: JSON.stringify(config) };
};

// Each agent is reached through the command that serves ACP on its stdio:
// its own subcommand, or the adapter that wraps its SDK
const defineAgent = (spec) => ({
  id: spec.id,
  name: spec.name ?? spec.id,
  title: spec.title,
  commands: spec.commands,
  mode: spec.mode ?? '',
  env: spec.env ?? (() => ({})),
});

const AGENTS = [
  defineAgent({
    id: 'claude',
    title: 'Claude Code',
    commands: [['claude-agent-acp'], ['claude-code-acp']],
    // Edits are accepted by the agent, the rest is asked of the run
    mode: 'acceptEdits',
  }),
  defineAgent({
    id: 'opencode',
    title: 'OpenCode',
    commands: [['opencode', 'acp']],
  }),
  defineAgent({
    id: 'cursor',
    title: 'Cursor',
    commands: [
      ['cursor-agent', 'acp'],
      ['agent', 'acp'],
    ],
  }),
  defineAgent({
    id: 'codex',
    title: 'Codex',
    commands: [['codex-acp']],
    mode: 'workspace-write',
    env: codexEnv,
  }),
  defineAgent({
    id: 'agy',
    title: 'Antigravity',
    commands: [['agy-acp'], ['agy_acp_server.par']],
  }),
];

const agentSpec = (id) => AGENTS.find((spec) => spec.id === id) ?? null;

const pathDirs = (env) => {
  const raw = env.PATH ?? env.Path ?? '';
  return raw.split(path.delimiter).filter(Boolean);
};

const winNames = (name, env) => {
  const ext = env.PATHEXT || '.EXE;.CMD;.BAT;.COM';
  const upper = name.toUpperCase();
  const names = [name];
  for (const item of ext.split(';').filter(Boolean)) {
    const suffix = item.startsWith('.') ? item : `.${item}`;
    if (upper.endsWith(suffix.toUpperCase())) return [name];
    names.push(`${name}${suffix}`);
  }
  return names;
};

const binNames = (name, env) => (IS_WIN ? winNames(name, env) : [name]);

const isBin = (file) => {
  try {
    if (!fs.statSync(file).isFile()) return false;
    if (!IS_WIN) fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

const findBin = (name, env = process.env) => {
  for (const dir of pathDirs(env)) {
    for (const file of binNames(name, env)) {
      const full = path.join(dir, file);
      if (isBin(full)) return full;
    }
  }
  return '';
};

const findCommand = (spec, env) => {
  for (const [name, ...args] of spec.commands) {
    const bin = findBin(name, env);
    if (bin) return { bin, args };
  }
  return { bin: '', args: [] };
};

const detectAgents = (env = process.env) =>
  AGENTS.map((spec) => ({
    id: spec.id,
    name: spec.name,
    spec,
    needs: spec.commands[0][0],
    catalog: null,
    ...findCommand(spec, env),
  }));

const listModels = (row, options = {}) => {
  if (!row || !row.bin) return Promise.resolve(null);
  return probeSession(row, options);
};

const planRef = (reviewPath, cwd) => {
  const file = `${reviewPath ?? ''}`;
  if (!file || !cwd) return file;
  const rel = path.relative(cwd, path.resolve(cwd, file));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return file;
  return rel.split(path.sep).join('/');
};

// A refusal reads to an agent as a person saying no, and it stops to ask
const UNATTENDED = [
  'You are running unattended: nobody can answer questions or approve',
  'commands. Change files with your edit tools. The shell is limited to',
  `${COMMANDS.join(', ')} and read-only filters such as cat, grep,`,
  'head and tail. When a command is refused, do the step another way',
  'and continue with the plan.',
].join(' ');

const planPrompt = (reviewPath) =>
  `Read and execute repair plan at ${reviewPath}\n\n${UNATTENDED}`;

// What a run is shown as: the settings it was started with and its plan
const launchLabel = (launch) => {
  const { choice } = launch;
  const fast = choice.fast ? 'fast' : '';
  const parts = [launch.name, choice.model, choice.effort, fast];
  return [...parts, choice.context, launch.plan].filter(Boolean).join(' ');
};

const buildLaunch = (row, picked, reviewPath, cwd, sessionId = '') => {
  if (!row || !row.bin) return { ok: false, error: 'not installed' };
  if (!reviewPath) return { ok: false, error: 'no plan' };
  const plan = planRef(reviewPath, cwd) || reviewPath;
  const launch = {
    ok: true,
    id: row.id,
    name: row.name,
    kind: 'run',
    cmd: row.bin,
    args: (row.args ?? []).slice(),
    mode: row.spec.mode,
    env: row.spec.env(cwd),
    choice: choiceOf(picked),
    plan,
    prompt: planPrompt(plan),
    session: trimText(sessionId),
    command: '',
  };
  launch.command = launchLabel(launch);
  return launch;
};

const startAgent = (cwd, launch, onData, onClose) =>
  startRun(cwd, launch, onData, onClose, launch.env);

module.exports = {
  ...models,
  AGENTS,
  agentSpec,
  findBin,
  detectAgents,
  listModels,
  planPrompt,
  buildLaunch,
  startAgent,
};
