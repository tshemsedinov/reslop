'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const agents = require('../../lib/agents/agents.js');
const { detectAgents, findBin, planPrompt } = agents;
const { emptyChoice, buildLaunch, buildInstall, AGENTS } = agents;
const { catalogOf, parseModelId, fitEffort } = agents;
const { modelChange, effortChange, fastChange, modeChange } = agents;
const { captionFromPlan } = require('../../lib/session/plans.js');
const { Session } = require('../../lib/session/session.js');
const { uiSink, tempDir } = require('../helpers.js');
const AgentJobs = require('../../lib/session/agent-jobs.js');
const { AgentJob } = AgentJobs;
const agentsHelpers = require('../agents-helpers.js');
const { makeBin, fakePath, acpState, CLAUDE_STATE } = agentsHelpers;
const { CURSOR_STATE, CODEX_STATE, rowOf, specOf } = agentsHelpers;

test('findBin returns the first executable on PATH', () => {
  const { dir, bins, env } = fakePath('claude');
  try {
    assert.equal(findBin('claude', env), bins.claude);
    assert.equal(findBin('missing', env), '');
    assert.equal(findBin('claude', { PATH: '' }), '');
    const added = makeBin(dir, 'missing');
    assert.equal(findBin('missing', env), added);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('detectAgents finds the acp command of every agent', () => {
  const { dir, bins, env } = fakePath(
    'claude-agent-acp',
    'opencode',
    'cursor-agent',
    'codex-acp',
    'agy-acp',
    'junie',
    'copilot',
    'pi-acp',
    'pi',
    'kiro-cli',
    'cline',
    'devin',
    'kilo',
  );
  try {
    const list = detectAgents(env);
    assert.equal(list.length, AGENTS.length);
    const found = list.map((row) => [row.id, row.bin, row.args]);
    assert.deepEqual(found, [
      ['claude', bins['claude-agent-acp'], []],
      ['opencode', bins.opencode, ['acp']],
      ['cursor', bins['cursor-agent'], ['acp']],
      ['codex', bins['codex-acp'], []],
      ['agy', bins['agy-acp'], []],
      ['junie', bins.junie, ['--acp=true']],
      ['copilot', bins.copilot, ['--acp']],
      ['pi', bins['pi-acp'], []],
      ['kiro', bins['kiro-cli'], ['acp', '--agent-engine=v3']],
      ['cline', bins.cline, ['--acp']],
      ['devin', bins.devin, ['acp']],
      ['kilo', bins.kilo, ['acp']],
    ]);
    assert.equal(list[0].catalog, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the official Antigravity server uses its registry command', () => {
  const exe = process.platform === 'win32' ? '.exe' : '';
  const server = exe ? 'agy_acp_server.exe' : 'agy_acp_server.par';
  const helper = `localharness_external${exe}`;
  const { dir, bins, env } = fakePath(server);
  const helperBin = makeBin(dir, helper);
  try {
    const row = detectAgents(env).find((item) => item.id === 'agy');
    assert.equal(row.bin, bins[server]);
    assert.deepEqual(row.args, process.platform === 'linux' ? ['--uid='] : []);
    const launch = buildLaunch(row, emptyChoice(), '/r.md', dir);
    assert.deepEqual(launch.env, { ANTIGRAVITY_HARNESS_PATH: helperBin });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Antigravity installs from the official ACP registry', () => {
  const row = { ...rowOf(specOf('agy')), bin: '' };
  const install = buildInstall(row);
  assert.equal(install.installer, 'registry');
  assert.equal(install.cmd, process.execPath);
  assert.equal(path.basename(install.args[0]), 'registry.js');
  assert.equal(install.args[1], 'antigravity-acp');
  assert.equal(install.command, 'install Google Antigravity ACP');
});

test('detectAgents falls back to the next command of an agent', () => {
  const { dir, bins, env } = fakePath('agent', 'claude-code-acp', 'claude');
  try {
    const list = detectAgents(env);
    const cursor = list.find((row) => row.id === 'cursor');
    assert.equal(cursor.bin, bins.agent);
    assert.deepEqual(cursor.args, ['acp']);
    const claude = list.find((row) => row.id === 'claude');
    assert.equal(claude.bin, bins['claude-code-acp']);
    const codex = list.find((row) => row.id === 'codex');
    assert.equal(codex.bin, '');
    assert.equal(codex.package, '@agentclientprotocol/codex-acp');
    assert.equal(codex.hint, 'npm i -g @agentclientprotocol/codex-acp');
    assert.equal(cursor.package, '');
    const agy = list.find((row) => row.id === 'agy');
    assert.equal(agy.package, '');
    assert.equal(agy.installable, true);
    assert.equal(agy.hint, 'install Google Antigravity ACP');
    const junie = list.find((row) => row.id === 'junie');
    assert.equal(junie.bin, '');
    assert.equal(junie.hint, 'npm i -g @jetbrains/junie');
    const copilot = list.find((row) => row.id === 'copilot');
    assert.equal(copilot.bin, '');
    assert.equal(copilot.hint, 'npm i -g @github/copilot');
    const cline = list.find((row) => row.id === 'cline');
    assert.equal(cline.bin, '');
    assert.equal(cline.hint, 'npm i -g cline');
    const devin = list.find((row) => row.id === 'devin');
    assert.equal(devin.installable, true);
    const hint = 'install the Devin CLI, the agent of Windsurf';
    assert.equal(devin.hint, hint);
    const kilo = list.find((row) => row.id === 'kilo');
    assert.equal(kilo.bin, '');
    assert.equal(kilo.hint, 'npm i -g @kilocode/cli');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the cli of an agent alone does not make it runnable', () => {
  const names = ['claude', 'codex', 'agy', 'pi', 'windsurf'];
  const { dir, env } = fakePath(...names);
  try {
    const agents = detectAgents(env);
    const found = agents.filter((row) => row.bin);
    assert.deepEqual(found, []);
    const agy = agents.find((row) => row.id === 'agy');
    assert.equal(agy.hint, 'agy installed; install Google Antigravity ACP');
    const devin = agents.find((row) => row.id === 'devin');
    assert.equal(devin.hint, 'windsurf installed; install the Devin CLI');
    assert.equal(buildInstall(devin).installer, 'script');
    const pi = agents.find((row) => row.id === 'pi');
    assert.equal(pi.hint, 'npm i -g pi-acp');
    assert.deepEqual(buildInstall(pi).args, ['install', '--global', 'pi-acp']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an adapter runs only when the cli of its agent is installed', () => {
  const cli = '@earendil-works/pi-coding-agent';
  const { dir, bins, env } = fakePath('pi-acp');
  try {
    const adapter = detectAgents(env).find((row) => row.id === 'pi');
    assert.equal(adapter.bin, '');
    assert.equal(adapter.package, cli);
    assert.equal(adapter.hint, `npm i -g ${cli}`);
    assert.deepEqual(buildInstall(adapter).args, ['install', '--global', cli]);
    const none = detectAgents({ PATH: '' }).find((row) => row.id === 'pi');
    assert.equal(none.hint, `npm i -g pi-acp ${cli}`);
    const both = ['install', '--global', 'pi-acp', cli];
    assert.deepEqual(buildInstall(none).args, both);
    makeBin(dir, 'pi');
    const ready = detectAgents(env).find((row) => row.id === 'pi');
    assert.equal(ready.bin, bins['pi-acp']);
    assert.deepEqual(ready.packages, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Kiro installs with its script and is found in ~/.local/bin', () => {
  const home = tempDir('reslop-home-');
  try {
    const env = { PATH: '', HOME: home, USERPROFILE: home };
    const missing = detectAgents(env).find((row) => row.id === 'kiro');
    assert.equal(missing.bin, '');
    assert.equal(missing.installable, true);
    assert.equal(missing.hint, 'install the Kiro CLI from cli.kiro.dev');
    const install = buildInstall(missing);
    assert.equal(install.installer, 'script');
    assert.equal(install.cmd, process.execPath);
    assert.equal(path.basename(install.args[0]), 'script.js');
    const windows = process.platform === 'win32';
    const script = windows ? 'install.ps1' : 'install';
    assert.equal(install.args[1], `https://cli.kiro.dev/${script}`);
    assert.equal(install.command, 'install Kiro CLI from cli.kiro.dev');
    const local = path.join(home, '.local', 'bin');
    fs.mkdirSync(local, { recursive: true });
    const bin = makeBin(local, windows ? 'kiro-cli.exe' : 'kiro-cli');
    makeBin(local, windows ? 'claude-agent-acp.exe' : 'claude-agent-acp');
    const list = detectAgents(env);
    assert.equal(list.find((row) => row.id === 'kiro').bin, bin);
    assert.equal(list.find((row) => row.id === 'claude').bin, '');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('buildLaunch describes an acp run of the review plan', () => {
  const row = rowOf(specOf('claude'));
  const missing = buildLaunch({ ...row, bin: '' }, emptyChoice(), '/r.md');
  assert.equal(missing.ok, false);
  assert.equal(missing.error, 'not installed');
  const noPlan = buildLaunch(row, emptyChoice(), '');
  assert.equal(noPlan.ok, false);
  assert.equal(noPlan.error, 'no plan');
  const choice = { model: 'sonnet', effort: 'high', fast: true };
  const launch = buildLaunch(row, choice, '/tmp/plan.md');
  assert.equal(launch.ok, true);
  assert.equal(launch.kind, 'run');
  assert.equal(launch.cmd, '/usr/bin/claude-agent-acp');
  assert.deepEqual(launch.args, []);
  assert.equal(launch.mode, 'acceptEdits');
  assert.deepEqual(launch.choice, {
    model: 'sonnet',
    effort: 'high',
    fast: true,
    context: '',
  });
  assert.equal(launch.plan, '/tmp/plan.md');
  assert.equal(launch.prompt, planPrompt('/tmp/plan.md'));
  assert.equal(launch.session, '');
  assert.equal(launch.command, 'claude sonnet high fast /tmp/plan.md');
  const plain = buildLaunch(row, emptyChoice(), '/tmp/plan.md');
  assert.equal(plain.command, 'claude /tmp/plan.md');
  const rel = buildLaunch(row, choice, '/tmp/work/.plan/a.md', '/tmp/work');
  assert.equal(rel.plan, '.plan/a.md');
  assert.equal(rel.prompt, planPrompt('.plan/a.md'));
  assert.match(rel.command, /^claude sonnet high fast \.plan\/a\.md$/);
  const cursor = buildLaunch(rowOf(specOf('cursor')), {}, '/tmp/plan.md');
  assert.deepEqual(cursor.args, ['acp']);
  assert.equal(cursor.mode, '');
});

test('the plan prompt tells the agent it runs unattended', () => {
  const prompt = planPrompt('.plan/a.md');
  assert.match(prompt, /^Read and execute repair plan at \.plan\/a\.md\n/);
  assert.match(prompt, /unattended/);
  assert.match(prompt, /npm, npx, node, reslop, git/);
});

test('buildLaunch continues a previous session for every agent', () => {
  const sessionId = '2fa698ba-9a19-4a84-8134-5a7cd9ec2c56';
  for (const spec of AGENTS) {
    const row = rowOf(spec);
    const args = [row, emptyChoice(), '/tmp/plan.md', '/tmp'];
    const kept = buildLaunch(...args, sessionId);
    assert.equal(kept.session, sessionId, spec.id);
    assert.equal(kept.prompt, planPrompt('plan.md'), spec.id);
    assert.equal(buildLaunch(...args).session, '', spec.id);
  }
});

test('a codex run may write to the git directory of its repository', () => {
  const row = rowOf(specOf('codex'));
  const scratch = tempDir('reslop-codex-git-');
  const gitRoots = (launch) => {
    const config = JSON.parse(launch.env.CODEX_CONFIG);
    return config.sandbox_workspace_write.writable_roots;
  };
  try {
    const repo = path.join(scratch, 'repo');
    const dot = path.join(repo, '.git');
    fs.mkdirSync(dot, { recursive: true });
    const plan = path.join(repo, 'plan.md');
    const rooted = buildLaunch(row, emptyChoice(), plan, repo);
    assert.equal(rooted.mode, 'workspace-write');
    assert.deepEqual(gitRoots(rooted), [fs.realpathSync.native(dot)]);
    const gitdir = path.join(dot, 'worktrees', 'wt');
    const work = path.join(scratch, 'work');
    fs.mkdirSync(gitdir, { recursive: true });
    fs.writeFileSync(path.join(gitdir, 'commondir'), '../..\n');
    fs.mkdirSync(work);
    fs.writeFileSync(path.join(work, '.git'), `gitdir: ${gitdir}\n`);
    const linked = buildLaunch(
      row,
      emptyChoice(),
      path.join(work, 'plan.md'),
      work,
    );
    const common = fs.realpathSync.native(dot);
    const linkedDir = fs.realpathSync.native(gitdir);
    assert.deepEqual(gitRoots(linked), [linkedDir, common]);
    const bare = buildLaunch(row, emptyChoice(), '/tmp/plan.md', scratch);
    assert.deepEqual(bare.env, {});
    const claude = buildLaunch(rowOf(specOf('claude')), {}, plan, repo);
    assert.deepEqual(claude.env, {});
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('a model id carries its settings in brackets', () => {
  assert.deepEqual(parseModelId('opus'), {
    id: 'opus',
    name: 'opus',
    effort: '',
    context: '',
    fast: '',
  });
  const cursor = 'gpt-5[context=272k,reasoning=medium,fast=false]';
  assert.deepEqual(parseModelId(cursor), {
    id: cursor,
    name: 'gpt-5',
    effort: 'medium',
    context: '272k',
    fast: 'off',
  });
  const grok = parseModelId('grok[reasoning_effort=high,fast=true]');
  assert.equal(grok.effort, 'high');
  assert.equal(grok.fast, 'on');
  assert.equal(
    parseModelId('claude[thinking=true,effort=xhigh]').effort,
    'xhigh',
  );
  assert.equal(parseModelId('gpt-6[high]').effort, 'high');
  assert.equal(parseModelId('default[]').name, 'default');
});

test('a session lists its models, efforts and fast mode', () => {
  const catalog = catalogOf(CLAUDE_STATE);
  assert.equal(catalog.loaded, true);
  assert.deepEqual(catalog.names, ['sonnet', 'opus', 'haiku']);
  assert.equal(catalog.current, 'sonnet');
  assert.deepEqual(catalog.efforts('opus'), ['low', 'medium', 'high', 'max']);
  assert.deepEqual(catalog.fasts('opus'), ['off', 'on']);
  assert.deepEqual(catalog.contexts('opus'), []);
  assert.equal(catalogOf(CLAUDE_STATE), catalog);
  const none = catalogOf(null);
  assert.equal(none.loaded, false);
  assert.deepEqual(none.names, []);
  const grouped = acpState({ models: ['a', 'b'] });
  grouped.configOptions[0].options = [
    { group: 'one', name: 'One', options: [{ value: 'a', name: 'A' }] },
    { group: 'two', name: 'Two', options: [{ value: 'b', name: 'B' }] },
  ];
  assert.deepEqual(catalogOf(grouped).names, ['a', 'b']);
});

test('settings a model id fixes are shown and not chosen', () => {
  const catalog = catalogOf(CURSOR_STATE);
  const names = ['default', 'grok-4.6', 'composer-2', 'gpt-5'];
  assert.deepEqual(catalog.names, names);
  assert.equal(catalog.current, 'default');
  assert.deepEqual(catalog.efforts('default'), []);
  assert.deepEqual(catalog.efforts('grok-4.6'), ['high']);
  assert.deepEqual(catalog.fasts('grok-4.6'), ['on']);
  assert.deepEqual(catalog.fasts('default'), []);
  assert.deepEqual(catalog.efforts('gpt-5'), ['low', 'high']);
  assert.deepEqual(catalog.contexts('gpt-5'), ['272k', '1m']);
  const fixed = catalog.resolve('grok-4.6', { effort: 'low', fast: false });
  assert.deepEqual(fixed, {
    id: 'grok-4.6[effort=high,fast=true]',
    effort: 'high',
    context: '',
    fast: 'on',
  });
  const wide = catalog.resolve('gpt-5', { effort: 'high', context: '1m' });
  assert.equal(wide.id, 'gpt-5[context=1m,reasoning=high,fast=false]');
  const plain = catalog.resolve('gpt-5', {});
  assert.equal(plain.id, 'gpt-5[context=272k,reasoning=low,fast=false]');
  assert.equal(plain.effort, 'low');
  assert.equal(plain.context, '272k');
});

test('the model list names the efforts of each model', () => {
  const catalog = catalogOf(CODEX_STATE);
  assert.deepEqual(catalog.names, ['gpt-a', 'gpt-b']);
  assert.deepEqual(catalog.efforts('gpt-a'), ['low', 'high', 'ultra']);
  assert.deepEqual(catalog.efforts('gpt-b'), ['low', 'medium']);
  const bare = acpState({
    models: ['gpt-a[low]', 'gpt-a[high]', 'gpt-b[low]'],
    current: 'gpt-a[high]',
    bare: true,
  });
  const listing = catalogOf(bare);
  assert.deepEqual(listing.names, ['gpt-a', 'gpt-b']);
  assert.equal(listing.current, 'gpt-a');
  assert.deepEqual(listing.efforts('gpt-a'), ['low', 'high']);
  assert.equal(listing.resolve('gpt-a', {}).id, 'gpt-a[high]');
  assert.deepEqual(modelChange(bare, { model: 'gpt-a', effort: 'low' }), {
    method: 'session/set_model',
    params: { modelId: 'gpt-a[low]' },
  });
  assert.equal(modelChange(bare, { model: 'gpt-a', effort: 'high' }), null);
});

test('a choice becomes the requests that configure a session', () => {
  const set = (configId, value) => ({
    method: 'session/set_config_option',
    params: { configId, value },
  });
  const picked = { model: 'opus', effort: 'medium', fast: true };
  assert.deepEqual(modelChange(CLAUDE_STATE, picked), set('model', 'opus'));
  assert.deepEqual(effortChange(CLAUDE_STATE, picked), set('effort', 'medium'));
  assert.deepEqual(fastChange(CLAUDE_STATE, picked), set('fast', 'on'));
  assert.deepEqual(
    modeChange(CLAUDE_STATE, 'acceptEdits'),
    set('mode', 'acceptEdits'),
  );
  const same = { model: 'sonnet', effort: 'high', fast: false };
  assert.equal(modelChange(CLAUDE_STATE, same), null);
  assert.equal(effortChange(CLAUDE_STATE, same), null);
  assert.equal(fastChange(CLAUDE_STATE, same), null);
  assert.equal(modeChange(CLAUDE_STATE, 'default'), null);
  assert.equal(modeChange(CLAUDE_STATE, 'unknown'), null);
  assert.equal(modeChange(CLAUDE_STATE, ''), null);
  assert.equal(modelChange(CLAUDE_STATE, emptyChoice()), null);
  assert.equal(effortChange(CLAUDE_STATE, { effort: 'ultra' }), null);
  assert.equal(modelChange(CLAUDE_STATE, { model: 'gone' }), null);
  assert.equal(fastChange(CURSOR_STATE, { fast: true }), null);
  const cursor = { model: 'gpt-5', effort: 'high', context: '1m' };
  const wide = 'gpt-5[context=1m,reasoning=high,fast=false]';
  assert.deepEqual(modelChange(CURSOR_STATE, cursor), set('model', wide));
  const modes = { currentModeId: 'ask', availableModes: [{ id: 'code' }] };
  const legacy = { configOptions: [], models: null, modes };
  assert.deepEqual(modeChange(legacy, 'code'), {
    method: 'session/set_mode',
    params: { modeId: 'code' },
  });
  assert.equal(modeChange(legacy, 'plan'), null);
});

test('an effort a model lacks moves to the nearest it offers', () => {
  const levels = ['low', 'medium', 'high'];
  assert.equal(fitEffort(levels, 'medium'), 'medium');
  assert.equal(fitEffort(levels, 'max'), 'high');
  assert.equal(fitEffort(levels, 'minimal'), 'low');
  assert.equal(fitEffort(levels, ''), '');
  assert.equal(fitEffort(levels, 'default'), '');
  assert.equal(fitEffort(['high'], 'low'), 'high');
  assert.equal(fitEffort([], 'low'), 'low');
});

test('a finished run reports its session, files and tokens', () => {
  const launch = buildLaunch(rowOf(specOf('claude')), {}, '/tmp/plan.md');
  const job = AgentJob.launch(1, launch, 'sonnet');
  assert.equal(job.status, 'running');
  job.child = { stats: () => ({ session: 'live-1', files: null }) };
  assert.equal(job.record().session, 'live-1');
  const stats = { session: 'done-1', files: 8, tokens: 1234 };
  job.finish({ status: 0, text: 'Done\n', stats });
  assert.equal(job.status, 'exit 0');
  assert.equal(job.output, 'Done\n');
  const saved = job.record();
  assert.equal(saved.session, 'done-1');
  assert.equal(saved.files, 8);
  assert.equal(job.tokens, 1234);
  assert.deepEqual(saved.choice, launch.choice);
  assert.equal(saved.cmd, undefined);
  const failed = AgentJob.launch(2, launch, '');
  failed.finish({ status: 1, text: '' });
  assert.equal(failed.status, 'exit 1');
  const continued = AgentJob.launch(3, { ...launch, session: 'old-1' }, '');
  assert.equal(continued.record().resume, 'old-1');
  const restored = AgentJobs.restoreJobs([
    { id: 5, cliId: 'claude', model: 'opus', exit: 0 },
    { id: 6, cliId: 'cursor', action: 'login', exit: 0 },
  ]);
  assert.equal(restored.jobs.length, 1);
  assert.equal(restored.jobs[0].choice.model, 'opus');
});

test('a plan caption prefers a heading over a dated review title', () => {
  const dated = [
    '---',
    'status: editing',
    '---',
    '',
    '# reslop review 2026-10-14-00',
    '',
    '- [ ] F1: use start instead of continue',
  ].join('\n');
  assert.equal(captionFromPlan(dated), 'use start instead of continue');
  const titled = '# Fix the login form\n\n- [ ] F2: retry the request\n';
  assert.equal(captionFromPlan(titled), 'Fix the login form');
  const lower = '- [ ] f19: tidy the footer\n';
  assert.equal(captionFromPlan(lower), 'tidy the footer');
  const bare = '- [ ] f4 tidy the header\n';
  assert.equal(captionFromPlan(bare), 'tidy the header');
  assert.equal(captionFromPlan(''), '');
});

test('interactive startup begins loading agent models', async () => {
  const ui = new Session({
    cwd: process.cwd(),
    stdout: uiSink(),
    repo: {},
    color: false,
  });
  let calls = 0;
  ui.agents.loadModels = async () => {
    calls += 1;
  };
  ui.openLoad = () => Promise.resolve();
  ui.openUpdate = () => {};
  ui.done = true;

  await ui.startUi();

  assert.equal(calls, 1);
});
