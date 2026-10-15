'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { IS_WIN, npmBin, npmOpts, spawnBase } = require('../common/process.js');
const { commandEnv, PipeProcess } = require('../runs/process.js');
const { trimText } = require('../common/utilities.js');
const { COMMANDS } = require('./allow.js');
const models = require('./models.js');
const { choiceOf } = models;
const { startRun, probeSession } = require('./run.js');
const registry = require('./registry.js');
const { installedRegistryAgent } = registry;
const { resolveGitDirs } = require('../git/dir.js');

const CODEX_SANDBOX = 'sandbox_workspace_write';
const CODEX_ROOTS = 'writable_roots';
const AGY_SERVER = IS_WIN ? 'agy_acp_server.exe' : 'agy_acp_server.par';
const AGY_ARGS = process.platform === 'linux' ? ['--uid='] : [];

const realPath = (file) => {
  try {
    return fs.realpathSync.native(file);
  } catch {
    return path.resolve(file);
  }
};

// workspace-write remounts .git read-only unless that path is itself writable.
const gitWriteRoots = (cwd) => {
  if (!cwd) return [];
  const dirs = resolveGitDirs(cwd);
  if (!dirs) return [];
  const roots = [realPath(dirs.gitDir), realPath(dirs.commonDir)];
  return [...new Set(roots)];
};

// The adapter merges this into the session config of codex
const codexEnv = (cwd, env = process.env) => {
  const roots = gitWriteRoots(cwd);
  if (!roots.length || env.CODEX_CONFIG) return {};
  const config = { [CODEX_SANDBOX]: { [CODEX_ROOTS]: roots } };
  return { CODEX_CONFIG: JSON.stringify(config) };
};

const antigravityEnv = (cwd, row) => {
  if (!row || !row.bin) return {};
  const name = IS_WIN ? 'localharness_external.exe' : 'localharness_external';
  const helper = path.join(path.dirname(row.bin), name);
  return fs.existsSync(helper) ? { ANTIGRAVITY_HARNESS_PATH: helper } : {};
};

// Each agent is reached through the command that serves ACP on its stdio:
// its own subcommand, or the adapter that wraps its SDK
const defineAgent = (spec) => ({
  id: spec.id,
  name: spec.name ?? spec.id,
  title: spec.title,
  commands: spec.commands,
  package: spec.package ?? '',
  // The cli of the agent that an adapter starts, as { bin, package }
  requires: spec.requires ?? null,
  registry: spec.registry ?? '',
  installLabel: spec.installLabel ?? '',
  hint: spec.hint ?? '',
  mode: spec.mode ?? '',
  env: spec.env ?? (() => ({})),
});

const AGENTS = [
  defineAgent({
    id: 'claude',
    title: 'Claude Code',
    commands: [['claude-agent-acp'], ['claude-code-acp']],
    package: '@agentclientprotocol/claude-agent-acp',
    // Edits are accepted by the agent, the rest is asked of the run
    mode: 'acceptEdits',
  }),
  defineAgent({
    id: 'opencode',
    title: 'OpenCode',
    commands: [['opencode', 'acp']],
    package: 'opencode-ai',
  }),
  defineAgent({
    id: 'cursor',
    title: 'Cursor',
    commands: [
      ['cursor-agent', 'acp'],
      ['agent', 'acp'],
    ],
    hint: 'needs the Cursor CLI from cursor.com/cli',
  }),
  defineAgent({
    id: 'codex',
    title: 'Codex',
    commands: [['codex-acp']],
    package: '@agentclientprotocol/codex-acp',
    mode: 'workspace-write',
    env: codexEnv,
  }),
  defineAgent({
    id: 'agy',
    title: 'Antigravity',
    commands: [[AGY_SERVER, ...AGY_ARGS], ['agy-acp']],
    registry: 'antigravity-acp',
    installLabel: 'Google Antigravity ACP',
    hint: 'install Google Antigravity ACP',
    env: antigravityEnv,
  }),
  defineAgent({
    id: 'junie',
    title: 'Junie',
    commands: [['junie', '--acp=true']],
    package: '@jetbrains/junie',
  }),
  defineAgent({
    id: 'copilot',
    title: 'Copilot',
    commands: [['copilot', '--acp']],
    package: '@github/copilot',
  }),
  defineAgent({
    id: 'pi',
    title: 'Pi',
    commands: [['pi-acp']],
    package: 'pi-acp',
    requires: { bin: 'pi', package: '@earendil-works/pi-coding-agent' },
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
  if (spec.registry) {
    const installed = installedRegistryAgent(spec.registry, { env });
    if (installed) return installed;
  }
  return { bin: '', args: [] };
};

// npm packages still missing: the adapter and the cli of the agent it starts
const missingPackages = (spec, env, found) => {
  const names = [];
  if (!found.bin && spec.package) names.push(spec.package);
  const cli = spec.requires;
  if (cli && !findBin(cli.bin, env)) names.push(cli.package);
  return names;
};

// What a missing agent takes: npm packages or an official registry binary
const installHint = (spec, env, packages) => {
  if (packages.length) return `npm i -g ${packages.join(' ')}`;
  if (spec.package) return `npm i -g ${spec.package}`;
  if (spec.registry && findBin('agy', env)) {
    return 'agy installed; install Google Antigravity ACP';
  }
  return spec.hint;
};

const detectAgent = (spec, env) => {
  const found = findCommand(spec, env);
  const packages = missingPackages(spec, env, found);
  const command = packages.length ? { bin: '', args: [] } : found;
  return {
    id: spec.id,
    name: spec.name,
    spec,
    package: packages.join(' ') || spec.package,
    packages,
    installable: Boolean(spec.package || spec.registry),
    installLabel: spec.installLabel,
    hint: installHint(spec, env, packages),
    catalog: null,
    ...command,
  };
};

const detectAgents = (env = process.env) =>
  AGENTS.map((spec) => detectAgent(spec, env));

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
    env: row.spec.env(cwd, row),
    choice: choiceOf(picked),
    plan,
    prompt: planPrompt(plan),
    session: trimText(sessionId),
    command: '',
  };
  launch.command = launchLabel(launch);
  return launch;
};

// The package lands in the global prefix of npm, where PATH finds its command
const buildInstall = (row) => {
  if (!row) return { ok: false, error: 'no agent' };
  if (row.bin) return { ok: false, error: 'installed' };
  const names = row.packages ?? [row.spec.package].filter(Boolean);
  const registryId = row.spec.registry;
  if (!names.length && !registryId) {
    return { ok: false, error: row.hint || 'no installer' };
  }
  const npmArgs = names.length ? ['install', '--global', ...names] : [];
  const args = registryId
    ? [path.join(__dirname, 'registry.js'), registryId]
    : npmArgs;
  const cmd = registryId ? process.execPath : npmBin();
  const command = registryId
    ? `install ${row.spec.installLabel || row.name}`
    : `npm ${npmArgs.join(' ')}`;
  return {
    ok: true,
    id: row.id,
    name: row.name,
    kind: 'install',
    installer: registryId ? 'registry' : 'npm',
    cmd,
    args,
    plan: '',
    session: '',
    command,
  };
};

const startInstall = (cwd, launch, onData, onClose) => {
  const extra = { cwd, env: commandEnv(), detached: !IS_WIN };
  const options =
    launch.installer === 'npm' ? npmOpts(extra) : spawnBase(extra);
  const proc = new PipeProcess(onData, onClose);
  proc.start(launch.cmd, launch.args, options).closeInput();
  return proc;
};

const startAgent = (cwd, launch, onData, onClose) => {
  if (launch.kind === 'install') {
    return startInstall(cwd, launch, onData, onClose);
  }
  return startRun(cwd, launch, onData, onClose, launch.env);
};

module.exports = {
  ...models,
  AGENTS,
  agentSpec,
  findBin,
  detectAgents,
  listModels,
  planPrompt,
  buildLaunch,
  buildInstall,
  startAgent,
};
