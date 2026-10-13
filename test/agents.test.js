'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const agents = require('../lib/agents/agents.js');
const { detectAgents, findBin, planPrompt } = agents;
const { emptyChoice, buildLaunch, AGENTS } = agents;
const { catalogOf, parseModelId, fitEffort } = agents;
const { modelChange, effortChange, fastChange, modeChange } = agents;
const { contextChange } = agents;
const { captionFromPlan } = require('../lib/session/agents/plans.js');
const { Session } = require('../lib/session/session.js');
const { createGitRepo } = require('../lib/git/git.js');
const { makeRepo, uiSink } = require('./helpers.js');
const render = require('../lib/render/render.js');
const { renderFrame } = render;
const ansi = require('../lib/term/ansi.js');
const { stripAnsi, THEME, bg, RESET, BOLD, seq } = ansi;
const { actionFromKey } = require('../lib/input/actions.js');
const jobs = require('../lib/session/agents/jobs.js');
const { launchJob } = jobs;

const FIXTURE = path.join(__dirname, 'acp-agent.js');

const makeBin = (dir, name) => {
  const file = path.join(dir, name);
  fs.writeFileSync(file, '#!/bin/sh\n');
  fs.chmodSync(file, 0o755);
  return file;
};

const fakePath = (...names) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reslop-bins-'));
  const bins = {};
  for (const name of names) bins[name] = makeBin(dir, name);
  return { dir, bins, env: { PATH: dir } };
};

const select = (id, category, currentValue, values) => ({
  id,
  category,
  type: 'select',
  currentValue,
  options: values.map((value) => ({ value, name: value })),
});

// What an agent answers to session/new, as far as the panel reads it
const acpState = (given) => {
  const { models, efforts, fast, listed, modes } = given;
  const configOptions = [];
  const current = given.current ?? models[0];
  if (modes) configOptions.push(select('mode', 'mode', modes[0], modes));
  if (!given.bare) {
    configOptions.push(select('model', 'model', current, models));
  }
  if (efforts) {
    const level = given.effort ?? 'high';
    configOptions.push(select('effort', 'thought_level', level, efforts));
  }
  if (fast) {
    configOptions.push(select('fast', 'model_config', 'off', ['on', 'off']));
  }
  const ids = listed ?? (given.bare ? models : null);
  const availableModels = (ids ?? []).map((modelId) => ({ modelId }));
  const listing = { currentModelId: current, availableModels };
  return {
    sessionId: 'session-1',
    configOptions,
    models: ids ? listing : null,
  };
};

const CLAUDE_STATE = acpState({
  models: ['sonnet', 'opus', 'haiku'],
  efforts: ['default', 'low', 'medium', 'high', 'max'],
  fast: true,
  modes: ['default', 'acceptEdits'],
});

const CURSOR_STATE = acpState({
  models: [
    'default[]',
    'grok-4.6[effort=high,fast=true]',
    'composer-2[fast=true]',
    'gpt-5[context=272k,reasoning=low,fast=false]',
    'gpt-5[context=1m,reasoning=low,fast=false]',
    'gpt-5[context=272k,reasoning=high,fast=false]',
    'gpt-5[context=1m,reasoning=high,fast=false]',
  ],
});

const CODEX_STATE = acpState({
  models: ['gpt-a', 'gpt-b'],
  efforts: ['low', 'medium', 'high'],
  listed: [
    'gpt-a[low]',
    'gpt-a[high]',
    'gpt-a[ultra]',
    'gpt-b[low]',
    'gpt-b[medium]',
  ],
});

const STATES = {
  claude: CLAUDE_STATE,
  cursor: CURSOR_STATE,
  codex: CODEX_STATE,
};

const listed = async (row) => STATES[row.id] ?? null;

const rowOf = (spec, catalog = null) => {
  const [name, ...args] = spec.commands[0];
  const { id } = spec;
  return { id, name: spec.name, bin: `/usr/bin/${name}`, args, spec, catalog };
};

const specOf = (id) => AGENTS.find((spec) => spec.id === id);

const SH_ONLY = { skip: process.platform === 'win32' };

test('findBin returns the first executable on PATH', () => {
  const { dir, bins, env } = fakePath('claude');
  try {
    assert.equal(findBin('claude', env), bins.claude);
    assert.equal(findBin('missing', env), '');
    assert.equal(findBin('claude', { PATH: '' }), '');
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
    ]);
    assert.equal(list[0].catalog, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
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
    assert.match(agy.hint, /acp adapter for agy/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the cli of an agent alone does not make it runnable', () => {
  const { dir, env } = fakePath('claude', 'codex', 'agy');
  try {
    const found = detectAgents(env).filter((row) => row.bin);
    assert.deepEqual(found, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
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
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'reslop-codex-git-'));
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
  const job = launchJob(1, launch, 'sonnet');
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
  const failed = launchJob(2, launch, '');
  failed.finish({ status: 1, text: '' });
  assert.equal(failed.status, 'exit 1');
  const continued = launchJob(3, { ...launch, session: 'old-1' }, '');
  assert.equal(continued.record().resume, 'old-1');
  const restored = jobs.restoreJobs([
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
  assert.equal(captionFromPlan(''), '');
});

const openUi = async () => {
  const repo = makeRepo();
  repo.write('a.js', 'ok\n');
  repo.git(['add', '.']);
  repo.git(['commit', '-m', 'init']);
  const stdout = uiSink();
  const ui = new Session({
    cwd: repo.dir,
    stdout,
    repo: createGitRepo(),
    color: false,
    startPane: 'dashboard',
  });
  await ui.ensureRepo();
  await ui.load();
  return { ui, repo, stdout };
};

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

test('agents screen lists agents and starts with the review plan', async () => {
  const { dir, bins, env } = fakePath('claude-agent-acp');
  const { ui, repo } = await openUi();
  try {
    ui.agents.listModels = listed;
    ui.agents.refresh(env);
    await ui.agents.open();
    assert.equal(ui.pane, 'agents');
    assert.equal(actionFromKey('a', 'dashboard'), 'dashAgents');
    const rows = ui.agents.rows();
    assert.equal(rows[0].bin, bins['claude-agent-acp']);
    assert.equal(rows[0].model, 'sonnet');
    assert.equal(rows[0].effort, 'medium');
    assert.equal(rows[0].fast, 'off');
    assert.equal(ui.agents.choice('claude').model, '');
    assert.equal(rows[1].bin, '');
    ui.draw();
    const text = stripAnsi(ui.lastFrame.rows.join('\n'));
    assert.match(text, /agent\s+model\s+effort\s+fast\s+(?:context\s+)?plan/);
    assert.equal(text.includes('▶'), false);
    assert.equal(text.includes('status'), false);
    assert.match(text, /claude/);
    assert.match(text, /opencode/);
    assert.match(text, /cursor/);
    assert.match(text, /codex/);
    assert.match(text, /opencode +npm i -g opencode-ai/);
    assert.match(text, /codex +npm i -g @agentclientprotocol\/codex-acp/);
    assert.match(text, /cursor +needs the Cursor CLI from cursor\.com\/cli/);
    assert.equal(text.includes('not installed'), false);
    assert.equal(text.includes(bins['claude-agent-acp']), false);
    assert.match(render.headerText(ui.view()), /agents/);
    ui.handleEvent({ type: 'key', key: 'm' });
    assert.equal(ui.agents.pick.field, 'model');
    assert.match(render.headerText(ui.view()), /agents$/);
    ui.draw();
    const menu = stripAnsi(ui.lastFrame.rows.join('\n'));
    assert.match(menu, /claude/);
    assert.match(menu, /opencode/);
    assert.match(menu, /sonnet/);
    assert.deepEqual(ui.agents.menuItems(), ['sonnet', 'opus', 'haiku']);
    ui.handleEvent({ type: 'key', key: 'enter' });
    assert.equal(ui.agents.pick, null);
    assert.equal(ui.agents.choice('claude').model, 'sonnet');
    ui.draw();
    const after = stripAnsi(ui.lastFrame.rows.join('\n'));
    assert.match(after, /\d{4}-\d{2}-\d{2}-\d+\.md {2}editing {2}\d+\/\d+/);
    assert.equal(after.includes('default'), false);
    assert.equal(after.includes('claude-agent-acp'), false);
    ui.handleEvent({ type: 'key', key: 'e' });
    assert.equal(ui.agents.pick.field, 'effort');
    assert.deepEqual(ui.agents.menuItems(), ['low', 'medium', 'high', 'max']);
    ui.handleEvent({ type: 'key', key: 'enter' });
    assert.equal(ui.agents.choice('claude').effort, 'medium');
    ui.draw();
    const picked = stripAnsi(ui.lastFrame.rows.join('\n'));
    assert.match(picked, /claude\s+sonnet\s+medium\s+off/);
    const calls = [];
    ui.agents.spawn = (cwd, launch, onData) => {
      calls.push({ cwd, launch });
      onData('hello\n');
      return { kill() {} };
    };
    ui.handleEvent({ type: 'key', key: 'enter' });
    assert.equal(calls.length, 1);
    const { launch } = calls[0];
    assert.equal(launch.cmd, bins['claude-agent-acp']);
    assert.deepEqual(launch.args, []);
    assert.equal(launch.mode, 'acceptEdits');
    assert.deepEqual(launch.choice, {
      model: 'sonnet',
      effort: 'medium',
      fast: false,
      context: '',
    });
    assert.match(launch.prompt, /repair plan/);
    assert.match(launch.prompt, /\.plan\//);
    assert.equal(ui.agents.viewing, true);
    assert.equal(ui.agents.jobs.length, 1);
    assert.equal(ui.agents.jobs[0].status, 'running');
    assert.match(ui.agents.jobs[0].command, /^claude sonnet medium \.plan\//);
    const jobRow = ui.agents.rows().some((row) => row.kind === 'job');
    assert.equal(jobRow, false);
    ui.draw();
    const log = stripAnsi(ui.lastFrame.rows.join('\n'));
    assert.match(log, /hello/);
    assert.match(render.headerText(ui.view()), /agents log/);
    const watching = renderFrame(ui.view(), {
      width: 80,
      height: 24,
      color: false,
    });
    assert.ok(watching.buttons.some((hit) => hit.id === 'agentStop'));
    assert.match(log, /re-run/);
    ui.handleEvent({ type: 'key', key: 'escape' });
    assert.equal(ui.agents.viewing, false);
    assert.equal(ui.agents.jobs[0].status, 'running');
    ui.nav.agentCursor = 1;
    ui.agents.start();
    assert.equal(ui.status, 'not installed');
    assert.equal(calls.length, 1);
    ui.nav.agentCursor = 0;
    const view = ui.view();
    const frame = renderFrame(view, { width: 80, height: 24, color: false });
    assert.ok(frame.buttons.some((hit) => hit.id === 'agentModel'));
    assert.ok(frame.buttons.some((hit) => hit.id === 'agentEffort'));
    assert.ok(frame.buttons.some((hit) => hit.id === 'agentFast'));
    const footer = stripAnsi(frame.rows.at(-1));
    assert.equal(footer.includes('stop'), false);
    assert.match(footer, /plan/);
  } finally {
    ui.agents.reset();
    repo.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('agent jobs keep running after leaving the log', async () => {
  const { dir, env } = fakePath('claude-agent-acp', 'cursor-agent');
  const { ui, repo } = await openUi();
  try {
    ui.agents.listModels = listed;
    const reviewDir = path.join(repo.dir, '.plan');
    fs.mkdirSync(reviewDir, { recursive: true });
    const other = '2020-01-01-00.md';
    const body = '---\nstatus: editing\n---\n';
    fs.writeFileSync(path.join(reviewDir, other), body);
    ui.agents.refresh(env);
    await ui.agents.open();
    const killed = [];
    ui.agents.spawn = (cwd, launch, onData, onClose) => ({
      kill() {
        killed.push(launch.cmd);
        onClose({ status: 1, text: 'bye\n' });
      },
    });
    const clis = ui.agents.rows().length;
    ui.agents.start();
    ui.agents.start();
    assert.equal(ui.agents.jobs.length, 1);
    assert.equal(ui.agents.viewing, true);
    assert.equal(ui.agents.rows().length, clis);
    ui.handleEvent({ type: 'key', key: 'escape' });
    assert.equal(ui.agents.jobs[0].status, 'running');
    ui.agents.start();
    assert.equal(ui.agents.jobs.length, 1);
    assert.equal(ui.agents.viewing, true);
    ui.handleEvent({ type: 'key', key: 'escape' });
    ui.nav.agentCursor = 2;
    ui.agents.start();
    assert.equal(ui.agents.jobs.length, 1);
    assert.equal(ui.status, `busy ${path.basename(ui.agents.planFile())}`);
    ui.handleEvent({ type: 'key', key: 'p' });
    ui.handleEvent({ type: 'key', key: 'enter' });
    ui.agents.start();
    assert.equal(ui.agents.jobs.length, 2);
    assert.equal(ui.agents.rows().length, clis);
    assert.equal(ui.agents.runningCount(), 2);
    ui.handleEvent({ type: 'key', key: 'escape' });
    ui.handleEvent({ type: 'key', key: 's' });
    assert.equal(killed.length, 0);
    ui.handleEvent({ type: 'key', key: 'enter' });
    ui.handleEvent({ type: 'key', key: 's' });
    assert.equal(killed.length, 1);
    assert.equal(ui.agents.runningCount(), 1);
    const live = ui.agents.jobs.filter((job) => job.status === 'running');
    assert.equal(live.length, 1);
    assert.equal(live[0].name, 'claude');
  } finally {
    ui.agents.reset();
    repo.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('r in the agent log repeats the command', async () => {
  const { dir, env } = fakePath('claude-agent-acp');
  const { ui, repo } = await openUi();
  try {
    ui.agents.listModels = listed;
    ui.agents.refresh(env);
    await ui.agents.open();
    const calls = [];
    let close = null;
    ui.agents.spawn = (cwd, launch, onData, onClose) => {
      calls.push(launch);
      onData('live\n');
      close = onClose;
      return {
        kill() {
          onClose({ status: 1, text: 'bye\n' });
        },
      };
    };
    ui.agents.start();
    assert.equal(ui.agents.viewing, true);
    ui.handleEvent({ type: 'key', key: 'r' });
    assert.equal(calls.length, 1);
    close({ status: 0, text: 'done\n' });
    ui.handleEvent({ type: 'key', key: 'r' });
    assert.equal(calls.length, 2);
    assert.equal(calls[1].command, calls[0].command);
    ui.handleEvent({ type: 'key', key: 'escape' });
    ui.handleEvent({ type: 'key', key: 'r' });
    assert.equal(calls.length, 2);
  } finally {
    ui.agents.reset();
    repo.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('agents screen offers the efforts the agent lists', async () => {
  const { dir, env } = fakePath('claude-agent-acp', 'codex-acp');
  const { ui, repo } = await openUi();
  try {
    const calls = [];
    ui.agents.listModels = async (row, options) => {
      calls.push([row.id, options.cwd]);
      return listed(row);
    };
    ui.agents.refresh(env);
    assert.equal(ui.agents.rows()[0].model, '');
    assert.deepEqual(ui.agents.rows()[0].efforts, []);
    await ui.agents.open();
    assert.deepEqual(calls, [
      ['claude', repo.dir],
      ['codex', repo.dir],
    ]);
    await ui.agents.open();
    assert.equal(calls.length, 2);
    const row = (id) => ui.agents.rows().find((item) => item.id === id);
    assert.deepEqual(row('claude').efforts, ['low', 'medium', 'high', 'max']);
    assert.equal(row('claude').effort, 'medium');
    assert.equal(row('codex').model, 'gpt-a');
    assert.deepEqual(row('codex').efforts, ['low', 'high', 'ultra']);
    assert.equal(row('codex').effort, 'high');
    ui.agents.choice('codex').effort = 'max';
    assert.equal(row('codex').effort, 'ultra');
    assert.equal(ui.agents.choice('codex').effort, 'ultra');
    ui.agents.choice('codex').model = 'gpt-b';
    assert.deepEqual(row('codex').efforts, ['low', 'medium']);
    assert.equal(row('codex').effort, 'medium');
  } finally {
    ui.agents.reset();
    repo.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a saved choice survives until the agent lists its models', async () => {
  const { dir, env } = fakePath('claude-agent-acp');
  const { ui, repo } = await openUi();
  try {
    const file = path.join(repo.dir, '.reslop');
    const claude = { model: 'opus', effort: 'max', fast: true };
    fs.writeFileSync(file, `${JSON.stringify({ agents: { claude } })}\n`);
    let answer = null;
    ui.agents.listModels = () =>
      new Promise((resolve) => {
        answer = resolve;
      });
    ui.agents.refresh(env);
    const opening = ui.agents.open();
    const before = ui.agents.rows()[0];
    assert.equal(before.model, 'opus');
    assert.equal(before.effort, 'max');
    assert.equal(before.fast, 'on');
    answer(CLAUDE_STATE);
    await opening;
    const after = ui.agents.rows()[0];
    assert.equal(after.model, 'opus');
    assert.equal(after.effort, 'max');
    assert.equal(after.fast, 'on');
    assert.deepEqual(ui.agents.choice('claude'), { ...claude, context: '' });
  } finally {
    ui.agents.reset();
    repo.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an agent that lists nothing runs with its own defaults', async () => {
  const { dir, env } = fakePath('claude-agent-acp');
  const { ui, repo } = await openUi();
  try {
    ui.agents.listModels = async () => {
      throw new Error('probe failed');
    };
    ui.agents.refresh(env);
    await ui.agents.open();
    const row = ui.agents.rows()[0];
    assert.equal(row.model, '');
    assert.deepEqual(row.efforts, []);
    ui.handleEvent({ type: 'key', key: 'm' });
    assert.equal(ui.agents.pick, null);
    const calls = [];
    ui.agents.spawn = (cwd, launch) => {
      calls.push(launch);
      return { kill() {} };
    };
    ui.agents.start();
    assert.deepEqual(calls[0].choice, emptyChoice());
  } finally {
    ui.agents.reset();
    repo.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('agents screen picks a model from the list', async () => {
  const { dir, env } = fakePath('cursor-agent');
  const { ui, repo } = await openUi();
  try {
    ui.agents.listModels = listed;
    ui.agents.refresh(env);
    await ui.agents.open();
    ui.nav.agentCursor = 2;
    const row = ui.agents.selected();
    assert.equal(row.id, 'cursor');
    assert.equal(row.name, 'cursor');
    assert.equal(ui.agents.rows()[2].model, 'default');
    ui.handleEvent({ type: 'key', key: 'm' });
    assert.ok(ui.agents.menuItems().includes('default'));
    ui.handleEvent({ type: 'key', key: 'g' });
    ui.handleEvent({ type: 'key', key: 'r' });
    ui.handleEvent({ type: 'key', key: 'o' });
    ui.handleEvent({ type: 'key', key: 'k' });
    ui.handleEvent({ type: 'key', key: 'enter' });
    assert.equal(ui.agents.choice('cursor').model, 'grok-4.6');
    assert.equal(ui.agents.selected().name, 'cursor');
    const picked = ui.agents.rows()[2];
    assert.equal(picked.effort, 'high');
    assert.equal(picked.fast, 'on');
    ui.draw();
    const text = stripAnsi(ui.lastFrame.rows.join('\n'));
    assert.match(text, /cursor\s+grok-4\.6\s+high\s+on/);
    assert.match(text, /\d{4}-\d{2}-\d{2}-\d+\.md/);
    assert.equal(text.includes('cursor-agent'), false);
    assert.equal(text.includes('effort='), false);
    ui.handleEvent({ type: 'key', key: 'e' });
    assert.equal(ui.agents.pick, null);
    ui.handleEvent({ type: 'key', key: 'a' });
    assert.equal(ui.agents.choice('cursor').fast, false);
    assert.equal(ui.status, 'fast on');
  } finally {
    ui.agents.reset();
    repo.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('start falls back to the latest review file', async () => {
  const { dir, env } = fakePath('claude-agent-acp');
  const { ui, repo } = await openUi();
  try {
    const reviewDir = path.join(repo.dir, '.plan');
    fs.mkdirSync(reviewDir, { recursive: true });
    const name = '2020-01-01-00.md';
    fs.writeFileSync(path.join(reviewDir, name), '---\nstatus: editing\n---\n');
    ui.review.store.reviewPath = '';
    ui.agents.listModels = listed;
    ui.agents.refresh(env);
    await ui.agents.open();
    const calls = [];
    ui.agents.spawn = (cwd, launch) => {
      calls.push(launch);
      return { kill() {} };
    };
    ui.agents.start();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].plan, `.plan/${name}`);
    assert.match(calls[0].prompt, /\.plan\/2020-01-01-00\.md/);
    assert.match(calls[0].command, /\.plan\/2020-01-01-00\.md$/);
  } finally {
    ui.agents.reset();
    repo.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('agents screen runs the review file chosen in the combo', async () => {
  const { dir, env } = fakePath('claude-agent-acp');
  const { ui, repo } = await openUi();
  try {
    const reviewDir = path.join(repo.dir, '.plan');
    fs.mkdirSync(reviewDir, { recursive: true });
    const older = '2020-01-01-00.md';
    const newer = '2020-01-02-00.md';
    const olderBody = [
      '---',
      'status: editing',
      '---',
      '',
      '> a.js',
      '',
      '- [x] rewrite loop',
      '- [ ] still open',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(reviewDir, older), olderBody);
    const newerBody = '---\nstatus: partial\n---\n';
    fs.writeFileSync(path.join(reviewDir, newer), newerBody);
    ui.review.store.reviewPath = '';
    ui.agents.listModels = listed;
    ui.agents.refresh(env);
    await ui.agents.open();
    ui.handleEvent({ type: 'key', key: 'p' });
    assert.equal(ui.agents.pick.field, 'plan');
    assert.deepEqual(ui.agents.menuItems(), [
      `${newer}  partial  0/0`,
      `${older}  editing  1/2`,
    ]);
    ui.draw();
    const menu = stripAnsi(ui.lastFrame.rows.join('\n'));
    assert.match(menu, /2020-01-02-00\.md {2}partial {2}0\/0/);
    assert.match(menu, /2020-01-01-00\.md {2}editing {2}1\/2/);
    ui.handleEvent({ type: 'key', key: 'down' });
    ui.handleEvent({ type: 'key', key: 'enter' });
    assert.equal(ui.agents.pick, null);
    ui.draw();
    const text = stripAnsi(ui.lastFrame.rows.join('\n'));
    assert.match(text, new RegExp(`${older}  editing  1/2`));
    const calls = [];
    ui.agents.spawn = (cwd, launch) => {
      calls.push(launch);
      return { kill() {} };
    };
    ui.agents.start();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].plan, `.plan/${older}`);
    assert.match(calls[0].command, /\.plan\/2020-01-01-00\.md$/);
  } finally {
    ui.agents.reset();
    repo.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('plan combo lists plain markdown and aligns columns', async () => {
  const { dir, env } = fakePath('claude-agent-acp');
  const { ui, repo } = await openUi();
  try {
    const reviewDir = path.join(repo.dir, '.plan');
    fs.mkdirSync(reviewDir, { recursive: true });
    const dated = '2020-01-02-00.md';
    const note = 'note.md';
    const ideas = 'ideas.md';
    const datedBody = [
      '---',
      'status: partial',
      '---',
      '',
      '> a.js',
      '',
      '- [ ] still open',
      '',
    ].join('\n');
    const noteBody = [
      '---',
      'status: editing',
      '---',
      '',
      '> a.js',
      '',
      '- [x] one',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(reviewDir, dated), datedBody);
    fs.writeFileSync(path.join(reviewDir, note), noteBody);
    fs.writeFileSync(path.join(reviewDir, ideas), '# ideas\n\nJust a note.\n');
    fs.writeFileSync(path.join(reviewDir, '.templates'), '[]\n');
    ui.review.store.reviewPath = '';
    ui.agents.listModels = listed;
    ui.agents.refresh(env);
    await ui.agents.open();
    ui.handleEvent({ type: 'key', key: 'p' });
    assert.deepEqual(ui.agents.menuItems(), [
      `${dated}  partial  0/1`,
      ideas,
      `${'note.md'.padEnd(dated.length)}  editing  1/1`,
    ]);
    ui.handleEvent({ type: 'key', key: 'down' });
    ui.handleEvent({ type: 'key', key: 'enter' });
    assert.equal(path.basename(ui.agents.planFile()), ideas);
    ui.draw();
    const text = stripAnsi(ui.lastFrame.rows.join('\n'));
    assert.match(text, /ideas\.md/);
    assert.equal(text.includes('ideas.md  editing'), false);
    ui.handleEvent({ type: 'key', key: 'p' });
    ui.handleEvent({ type: 'key', key: 'down' });
    ui.handleEvent({ type: 'key', key: 'enter' });
    assert.equal(path.basename(ui.agents.planFile()), note);
    assert.equal(ui.agents.planFace(), `${note}  editing  1/1`);
  } finally {
    ui.agents.reset();
    repo.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('clicking the model column opens the model list', async () => {
  const { dir, env } = fakePath('cursor-agent');
  const { ui, repo } = await openUi();
  try {
    const state = acpState({
      models: [
        'default[]',
        'gpt-5.6-sol[effort=high]',
        'gpt-5.6-sol[effort=low]',
      ],
    });
    ui.agents.listModels = async () => state;
    ui.agents.refresh(env);
    await ui.agents.open();
    ui.nav.agentCursor = 2;
    ui.draw();
    const hit = ui.lastFrame.fileHits.find((entry) => entry.field === 'model');
    assert.ok(hit);
    const click = {
      type: 'mouse',
      button: 0,
      btn: 0,
      x: hit.x0 + 1,
      y: hit.y,
    };
    ui.handleEvent({ ...click, kind: 'press', press: true });
    ui.handleEvent({ ...click, kind: 'release', press: false });
    assert.equal(ui.agents.pick.field, 'model');
    ui.draw();
    const text = stripAnsi(ui.lastFrame.rows.join('\n'));
    assert.match(text, /claude/);
    assert.match(text, /cursor/);
    assert.match(text, /gpt-5\.6-sol/);
    assert.equal(text.includes('effort='), false);
    ui.handleEvent({ type: 'key', key: 's' });
    ui.handleEvent({ type: 'key', key: 'o' });
    ui.draw();
    assert.equal(ui.agents.pick.query, 'so');
    const found = ui.agents.menuItems();
    assert.ok(found.length > 0);
    assert.ok(found.every((name) => name.toLowerCase().includes('so')));
    const showsQuery = (text, q) => new RegExp(`\\s${q}(?:\\s|$)`).test(text);
    const typed = stripAnsi(ui.lastFrame.rows.join('\n'));
    assert.ok(showsQuery(typed, 'so'));
    const typedLines = typed.split('\n').map((line) => line.trim());
    assert.equal(typedLines.includes('so'), false);
    assert.ok(
      typedLines.some(
        (line) => line.includes('cursor') && /\sso(?:\s|$)/.test(line),
      ),
    );
    ui.handleEvent({ type: 'key', key: 'backspace' });
    assert.equal(ui.agents.pick.query, 's');
    ui.draw();
    const cleared = stripAnsi(ui.lastFrame.rows.join('\n'));
    assert.equal(showsQuery(cleared, 'so'), false);
    assert.ok(showsQuery(cleared, 's'));
    ui.handleEvent({ type: 'key', key: 'o' });
    ui.handleEvent({ type: 'key', key: 'l' });
    ui.handleEvent({ type: 'key', key: 'enter' });
    assert.equal(ui.agents.choice('cursor').model, 'gpt-5.6-sol');
    assert.equal(ui.agents.rows()[2].effort, 'high');
    ui.handleEvent({ type: 'key', key: 'e' });
    assert.deepEqual(ui.agents.menuItems(), ['low', 'high']);
    ui.handleEvent({ type: 'key', key: 'up' });
    ui.handleEvent({ type: 'key', key: 'enter' });
    assert.equal(ui.agents.choice('cursor').effort, 'low');
  } finally {
    ui.agents.reset();
    repo.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('clicking another column switches the open combo', async () => {
  const { dir, env } = fakePath('cursor-agent');
  const { ui, repo } = await openUi();
  try {
    ui.agents.listModels = listed;
    ui.agents.refresh(env);
    await ui.agents.open();
    const at = ui.agents.rows().findIndex((row) => row.id === 'cursor');
    ui.nav.agentCursor = at;
    ui.agents.choice('cursor').model = 'gpt-5';
    ui.draw();
    const clickAt = (hit) => {
      const click = {
        type: 'mouse',
        button: 0,
        btn: 0,
        x: hit.x0 + 1,
        y: hit.y,
      };
      ui.handleEvent({ ...click, kind: 'press', press: true });
      ui.handleEvent({ ...click, kind: 'release', press: false });
    };
    const model = ui.lastFrame.fileHits.find(
      (entry) => entry.field === 'model',
    );
    assert.ok(model);
    clickAt(model);
    assert.equal(ui.agents.pick.field, 'model');
    ui.handleEvent({ type: 'key', key: 'j' });
    ui.handleEvent({ type: 'key', key: 'k' });
    assert.equal(ui.agents.pick.query, 'jk');
    assert.equal(ui.agents.pick.cursor, 0);
    ui.draw();
    const effort = ui.lastFrame.fileHits.find(
      (entry) => entry.field === 'effort',
    );
    assert.ok(effort);
    clickAt(effort);
    assert.equal(ui.agents.pick.field, 'effort');
    assert.equal(ui.agents.pick.query, '');
  } finally {
    ui.agents.reset();
    repo.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('model menu uses background and a right scroller', async () => {
  const { dir, env } = fakePath('cursor-agent');
  const repo = makeRepo();
  repo.write('a.js', 'ok\n');
  repo.git(['add', '.']);
  repo.git(['commit', '-m', 'init']);
  const stdout = uiSink();
  stdout.columns = 160;
  const ui = new Session({
    cwd: repo.dir,
    stdout,
    repo: createGitRepo(),
    color: true,
    startPane: 'dashboard',
  });
  await ui.ensureRepo();
  await ui.load();
  try {
    const models = Array.from({ length: 16 }, (_, i) => `model-${i}`);
    const efforts = ['low', 'medium', 'high'];
    const state = acpState({ models, efforts });
    ui.agents.listModels = async () => state;
    ui.agents.refresh(env);
    await ui.agents.open();
    assert.equal(ui.agents.selected().id, 'cursor');
    ui.nav.agentCursor = 2;
    ui.draw();
    const fresh = ui.lastFrame.rows.find((row) =>
      stripAnsi(row).includes('<start new session>'),
    );
    assert.ok(fresh);
    assert.ok(fresh.includes(bg(THEME.checkBg)));
    assert.ok(fresh.includes(seq(THEME.chromeFg, THEME.checkBg)));
    assert.equal(fresh.includes(seq(THEME.buttonHotFg, THEME.checkBg)), false);
    const pickedCli = ui.lastFrame.rows.find((row) =>
      stripAnsi(row).includes('cursor'),
    );
    assert.ok(pickedCli);
    assert.ok(pickedCli.includes(bg(THEME.buttonBg)));
    const head = ui.lastFrame.rows.find((row) => {
      const plain = stripAnsi(row);
      return plain.includes('model') && plain.includes('plan');
    });
    assert.ok(head);
    assert.equal(head.includes(BOLD), false);
    assert.ok(head.includes('38;2;122;122;138'));
    const claude = ui.lastFrame.rows.find((row) =>
      stripAnsi(row).includes('claude'),
    );
    const cursor = ui.lastFrame.rows.find((row) =>
      stripAnsi(row).includes('cursor'),
    );
    assert.ok(claude);
    assert.ok(cursor);
    assert.equal(claude.includes(BOLD), false);
    assert.ok(claude.includes('38;2;122;122;138'));
    assert.ok(claude.includes(seq(THEME.warnFg, THEME.ctxBg)));
    assert.match(stripAnsi(claude), /npm i -g @agentclientprotocol/);
    ui.nav.agentCursor = 0;
    ui.draw();
    const pickedHint = ui.lastFrame.rows.find((row) =>
      stripAnsi(row).includes('npm i -g @agentclientprotocol'),
    );
    assert.ok(pickedHint.includes(seq(THEME.warnFg, THEME.buttonBg)));
    ui.nav.agentCursor = 2;
    ui.draw();
    assert.ok(cursor.includes(BOLD));
    assert.ok(cursor.includes('38;2;86;156;214'));
    ui.handleEvent({ type: 'key', key: 'm' });
    ui.draw();
    const plain = stripAnsi(ui.lastFrame.rows.join('\n'));
    assert.equal(plain.includes('┌'), false);
    assert.equal(plain.includes('│'), false);
    assert.equal(plain.includes('─'), false);
    assert.equal(plain.includes('▸'), false);
    const thumb = bg(THEME.taskHeadBg);
    const track = bg(THEME.buttonBg);
    const menuRows = () =>
      ui.lastFrame.rows.filter(
        (row) =>
          row.includes(bg(THEME.noteBg)) || row.includes(bg(THEME.checkBg)),
      );
    const open = menuRows();
    assert.match(plain, /model-0/);
    assert.ok(open.length > 1);
    assert.ok(open.some((row) => row.includes(bg(THEME.checkBg))));
    assert.ok(open.some((row) => row.includes(bg(THEME.noteBg))));
    assert.ok(open.some((row) => row.includes(thumb)));
    assert.ok(open.some((row) => row.includes(track)));
    const thumbAt = open.findIndex((row) => row.includes(thumb));
    ui.handleEvent({ type: 'key', key: 'end' });
    ui.draw();
    const scrolled = menuRows();
    const nextAt = scrolled.findIndex((row) => row.includes(thumb));
    assert.ok(nextAt > thumbAt);
    assert.ok(scrolled.at(-1).includes(thumb));
    assert.equal(scrolled[0].includes(thumb), false);
    const itemFace = (row) => {
      const checked = bg(THEME.checkBg);
      const note = bg(THEME.noteBg);
      const mark = row.includes(checked) ? checked : note;
      const at = row.indexOf(mark);
      const start = row.indexOf('m', at) + 1;
      const end = row.indexOf(RESET, start);
      return row.slice(start, end);
    };
    assert.match(itemFace(open.find((row) => row.includes(thumb))), /^ /);
    ui.handleEvent({ type: 'key', key: '1' });
    ui.draw();
    const filtered = ui.lastFrame.rows.find((row) =>
      /model-1(?!\d)/.test(stripAnsi(row)),
    );
    assert.ok(filtered);
    const onFocus = seq(THEME.warnFg, THEME.checkBg);
    const onNote = seq(THEME.warnFg, THEME.noteBg);
    const marked = filtered.includes(onFocus) || filtered.includes(onNote);
    assert.ok(marked);
    assert.equal(filtered.includes(bg(THEME.searchBg)), false);
    const queryRow = ui.lastFrame.rows.find((line) =>
      stripAnsi(line).includes('cursor'),
    );
    assert.ok(queryRow.includes(seq(THEME.warnFg, THEME.buttonBg)));
    assert.equal(queryRow.includes(bg(THEME.searchBg)), false);
    ui.handleEvent({ type: 'key', key: 'escape' });
    ui.handleEvent({ type: 'key', key: 'e' });
    ui.draw();
    const effort = menuRows();
    assert.ok(effort.length > 1);
    assert.equal(
      effort.some((row) => row.includes(thumb)),
      false,
    );
    const low = itemFace(effort.find((row) => stripAnsi(row).includes('low')));
    assert.match(low, /^ /);
    assert.match(low, / $/);
  } finally {
    ui.agents.reset();
    repo.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('agents screen remembers model and effort in .reslop', async () => {
  const { dir, env } = fakePath('claude-agent-acp');
  const { ui, repo } = await openUi();
  try {
    ui.agents.listModels = listed;
    ui.agents.refresh(env);
    await ui.agents.open();
    ui.handleEvent({ type: 'key', key: 'm' });
    ui.handleEvent({ type: 'key', key: 'down' });
    ui.handleEvent({ type: 'key', key: 'enter' });
    ui.handleEvent({ type: 'key', key: 'e' });
    ui.handleEvent({ type: 'key', key: 'down' });
    ui.handleEvent({ type: 'key', key: 'enter' });
    assert.equal(ui.agents.choice('claude').model, 'opus');
    assert.equal(ui.agents.choice('claude').effort, 'high');
    const file = path.join(repo.dir, '.reslop');
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(saved.agents.claude, { model: 'opus', effort: 'high' });
    ui.agents.choices = new Map();
    ui.agents.refresh(env);
    assert.equal(ui.agents.choice('claude').model, 'opus');
    assert.equal(ui.agents.choice('claude').effort, 'high');
  } finally {
    ui.agents.reset();
    repo.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('flags written for the cli runs are not read from .reslop', async () => {
  const { dir, env } = fakePath('claude-agent-acp');
  const { ui, repo } = await openUi();
  try {
    const file = path.join(repo.dir, '.reslop');
    const claude = { model: 'sonnet', extra: '--unsafe-example' };
    fs.writeFileSync(file, `${JSON.stringify({ agents: { claude } })}\n`);
    ui.agents.listModels = listed;
    ui.agents.refresh(env);
    await ui.agents.open();
    assert.equal(ui.agents.choice('claude').extra, undefined);
    ui.agents.saveChoice('claude');
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(saved.agents.claude, {
      model: 'sonnet',
      effort: 'medium',
    });
  } finally {
    ui.agents.reset();
    repo.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('recorded runs stay listed for the selected cli', async () => {
  const { dir, env } = fakePath('cursor-agent', 'claude-agent-acp');
  const { ui, repo } = await openUi();
  try {
    const plan = path.join(repo.dir, '.plan');
    fs.mkdirSync(plan, { recursive: true });
    const recorded = [
      {
        id: 1,
        cliId: 'cursor',
        name: 'cursor',
        model: 'grok-4.6',
        cmd: '/bin/cursor-agent',
        args: [],
        command: 'cursor old grok',
        plan: '.plan/a.md',
        action: 'run',
        exit: 1,
        elapsed: 4,
        startedAt: 1,
        session: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1',
        log: 'cursor-old.log',
        output: '',
      },
      {
        id: 2,
        cliId: 'cursor',
        name: 'cursor',
        model: 'cursor-grok-4.6',
        cmd: '/bin/cursor-agent',
        args: [],
        command: 'cursor new grok',
        plan: '.plan/a.md',
        action: 'run',
        stopped: true,
        elapsed: 0,
        startedAt: 2,
        session: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2',
        log: 'cursor-new.log',
        output: '',
      },
      {
        id: 3,
        cliId: 'claude',
        name: 'claude',
        model: 'sonnet',
        cmd: '/bin/claude',
        args: [],
        command: 'claude only',
        plan: '.plan/a.md',
        action: 'run',
        exit: 0,
        elapsed: 1,
        startedAt: 3,
        session: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa3',
        log: 'claude-only.log',
        output: '',
      },
    ];
    const file = path.join(plan, '.runs');
    fs.writeFileSync(file, `${JSON.stringify(recorded, null, 2)}\n`);
    ui.agents.listModels = listed;
    ui.agents.refresh(env);
    ui.agents.loadRuns();
    await ui.agents.open();
    const at = ui.agents.rows().findIndex((row) => row.id === 'cursor');
    ui.nav.agentCursor = at;
    ui.agents.choice('cursor').model = 'auto';
    const shown = ui.agents.sessionRows().map((row) => row.name);
    const expected = ['<start new session>', 'cursor-new', 'cursor-old'];
    assert.deepEqual(shown, expected);
    ui.draw();
    const text = stripAnsi(ui.lastFrame.rows.join('\n'));
    assert.match(text, /cursor-new/);
    assert.match(text, /cursor-old/);
    const claudeAt = ui.agents.rows().findIndex((row) => row.id === 'claude');
    ui.nav.agentCursor = claudeAt;
    const claudeRuns = ui.agents.sessionRows().map((row) => row.name);
    assert.deepEqual(claudeRuns, ['<start new session>', 'claude-only']);
  } finally {
    ui.agents.reset();
    repo.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('agents screen lists sessions for the selected cli', async () => {
  const { dir, env } = fakePath('claude-agent-acp');
  const { ui, repo, stdout } = await openUi();
  try {
    ui.agents.listModels = listed;
    ui.agents.refresh(env);
    await ui.agents.open();
    ui.agents.spawn = () => ({ kill() {} });
    ui.handleEvent({ type: 'key', key: 'm' });
    ui.handleEvent({ type: 'key', key: 'enter' });
    ui.handleEvent({ type: 'key', key: 'enter' });
    ui.handleEvent({ type: 'key', key: 'escape' });
    stdout.columns = 160;
    ui.draw();
    const lines = stripAnsi(ui.lastFrame.rows.join('\n')).split('\n');
    assert.ok(lines.some((row) => /claude/.test(row)));
    assert.ok(lines.some((row) => /<start new session>/.test(row)));
    const title = lines.findIndex((line) => /agent\s+model/.test(line));
    const runHit = ui.lastFrame.fileHits.find((hit) => hit.side === 'runs');
    assert.ok(runHit);
    assert.equal(runHit.y, title + 1);
    assert.match(ui.agents.jobs[0].command, /^claude sonnet medium /);
    ui.handleEvent({ type: 'key', key: 'right' });
    assert.equal(ui.agents.focus, 'runs');
    ui.handleEvent({ type: 'key', key: 'tab' });
    assert.equal(ui.agents.focus, 'cli');
    ui.handleEvent({ type: 'key', key: 'tab' });
    assert.equal(ui.agents.focus, 'runs');
    ui.handleEvent({ type: 'key', key: 'left' });
    assert.equal(ui.agents.focus, 'cli');
    const live = ui.agents.jobs[0];
    live.status = 'exit 0';
    live.child = null;
    ui.agents.closeView();
    ui.handleEvent({ type: 'key', key: 'right' });
    ui.handleEvent({ type: 'key', key: 'enter' });
    assert.equal(ui.agents.jobs.length, 2);
    assert.equal(ui.agents.viewing, true);
  } finally {
    ui.agents.reset();
    repo.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a new agent session is its own run with status', async () => {
  const { dir, env } = fakePath('claude-agent-acp');
  const { ui, repo, stdout } = await openUi();
  try {
    const reviewDir = path.join(repo.dir, '.plan');
    fs.mkdirSync(reviewDir, { recursive: true });
    const name = '2020-01-01-00.md';
    const file = path.join(reviewDir, name);
    const body = [
      '---',
      'status: editing',
      '---',
      '',
      '> a.js',
      '',
      '- [x] rewrite loop',
      '- [ ] still open',
      '',
    ];
    fs.writeFileSync(file, `${body.join('\n')}\n`);
    ui.review.store.reviewPath = '';
    ui.agents.listModels = listed;
    ui.agents.refresh(env);
    await ui.agents.open();
    ui.agents.planPath = file;
    ui.agents.spawn = () => ({ kill() {} });
    ui.agents.start();
    assert.equal(ui.agents.viewing, true);
    const banner = ui.agents.jobView().agentCommand;
    assert.equal(banner, 'rewrite loop');
    assert.match(ui.agents.jobs[0].logName, /-agent-\d+\.log$/);
    ui.agents.closeView();
    const rows = ui.agents.sessionRows();
    assert.equal(rows[0].name, '<start new session>');
    assert.equal(rows[0].fresh, true);
    assert.equal(rows[0].status, undefined);
    assert.equal(rows[1].name, banner);
    assert.equal(rows[1].status, 'running');
    assert.match(rows[1].elapsed, /^\d+:\d{2}$/);
    assert.equal(rows[1].progress, '1/2');
    assert.equal(rows[1].fresh, undefined);
    assert.equal(rows[1].session, undefined);
    assert.notEqual(rows[1].name, '<start new session>');
    stdout.columns = 160;
    ui.draw();
    const lines = stripAnsi(ui.lastFrame.rows.join('\n')).split('\n');
    const fresh = lines.find((line) => line.includes('<start new session>'));
    const live = lines.find((line) => line.includes('running'));
    assert.ok(fresh);
    assert.equal(fresh.includes('running'), false);
    assert.ok(live);
    assert.match(live, /1\/2/);
    const job = ui.agents.jobs[0];
    job.status = 'exit 0';
    const finished = ui.agents.sessionRows();
    const kept = finished.find((row) => row.name === banner);
    assert.ok(kept);
    assert.match(kept.id, /-agent-\d+$/);
    assert.equal(ui.agents.sessionView(kept.id).agentCommand, banner);
    job.status = 'running';
    const sessionId = '2fa698ba-9a19-4a84-8134-5a7cd9ec2c56';
    ui.agents.jobs[0].session = sessionId;
    const next = ui.agents.sessionRows();
    const starters = next.filter((row) => row.name === '<start new session>');
    const active = next.filter((row) => row.status === 'running');
    assert.equal(starters.length, 1);
    assert.equal(active.length, 1);
    assert.equal(active[0].id, sessionId);
    assert.equal(active[0].name, banner);
    assert.equal(ui.agents.sessionView(sessionId).agentCommand, banner);
    ui.agents.focusRuns();
    ui.agents.move(1);
    ui.agents.start();
    assert.equal(ui.agents.viewing, true);
    assert.equal(ui.agents.viewId, ui.agents.jobs[0].id);
    assert.equal(ui.agents.jobs.length, 1);
  } finally {
    ui.agents.reset();
    repo.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('agents panels scroll past one screen', async () => {
  const { dir, env } = fakePath('claude-agent-acp');
  const { ui, repo } = await openUi();
  try {
    ui.agents.listModels = listed;
    ui.agents.refresh(env);
    await ui.agents.open();
    ui.agents.choice('claude').model = 'sonnet';
    for (let i = 0; i < 40; i++) {
      ui.agents.jobs.push({
        id: i + 1,
        cliId: 'claude',
        session: `sess-${i}`,
        logName: `run-${i}.log`,
        startedAt: i + 1,
        model: 'sonnet',
        status: 'exit 0',
        command: `run-${i}`,
      });
    }
    ui.agents.focusRuns();
    ui.draw();
    const top = stripAnsi(ui.lastFrame.rows.join('\n'));
    assert.match(top, /run-39/);
    assert.equal(/\brun-0\b/.test(top), false);
    ui.handleEvent({ type: 'key', key: 'end' });
    ui.draw();
    const bottom = stripAnsi(ui.lastFrame.rows.join('\n'));
    assert.match(bottom, /run-0/);
    assert.equal(bottom.includes('run-39'), false);
  } finally {
    ui.agents.reset();
    repo.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('agents screen blocks a review file that is already running', async () => {
  const { dir, env } = fakePath('claude-agent-acp', 'cursor-agent');
  const { ui, repo } = await openUi();
  try {
    const reviewDir = path.join(repo.dir, '.plan');
    fs.mkdirSync(reviewDir, { recursive: true });
    const older = '2020-01-01-00.md';
    const newer = '2020-01-02-00.md';
    const body = '---\nstatus: editing\n---\n';
    fs.writeFileSync(path.join(reviewDir, older), body);
    fs.writeFileSync(path.join(reviewDir, newer), body);
    ui.review.store.reviewPath = '';
    ui.agents.listModels = listed;
    ui.agents.refresh(env);
    await ui.agents.open();
    const calls = [];
    ui.agents.spawn = () => {
      calls.push(1);
      return { kill() {} };
    };
    ui.agents.start();
    assert.equal(calls.length, 1);
    assert.equal(ui.agents.jobs[0].plan, `.plan/${newer}`);
    ui.handleEvent({ type: 'key', key: 'escape' });
    ui.nav.agentCursor = 2;
    ui.agents.start();
    assert.equal(calls.length, 1);
    assert.equal(ui.status, `busy ${newer}`);
    ui.handleEvent({ type: 'key', key: 'p' });
    assert.deepEqual(ui.agents.menuItems(), [
      `${newer}  editing  0/0`,
      `${older}  editing  0/0`,
    ]);
    assert.equal(ui.agents.pick.cursor, 1);
    ui.agents.pick.cursor = 0;
    ui.handleEvent({ type: 'key', key: 'enter' });
    assert.equal(ui.agents.pick.field, 'plan');
    assert.equal(path.basename(ui.agents.planFile()), newer);
    ui.handleEvent({ type: 'key', key: 'down' });
    assert.equal(ui.agents.pick.cursor, 1);
    ui.handleEvent({ type: 'key', key: 'enter' });
    assert.equal(ui.agents.pick, null);
    assert.equal(path.basename(ui.agents.planFile()), older);
    ui.agents.start();
    assert.equal(calls.length, 2);
    assert.equal(ui.agents.jobs[1].plan, `.plan/${older}`);
  } finally {
    ui.agents.reset();
    repo.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('agents screen toggles fast mode with a', async () => {
  const { dir, env } = fakePath('claude-agent-acp', 'opencode');
  const { ui, repo } = await openUi();
  try {
    ui.agents.listModels = listed;
    ui.agents.refresh(env);
    await ui.agents.open();
    ui.handleEvent({ type: 'key', key: 'a' });
    assert.equal(ui.agents.choice('claude').fast, true);
    assert.equal(ui.agents.rows()[0].fast, 'on');
    assert.equal(ui.status, 'fast on');
    ui.draw();
    const on = stripAnsi(ui.lastFrame.rows.join('\n'));
    assert.match(on, /claude\s+sonnet\s+medium\s+on/);
    const saved = JSON.parse(fs.readFileSync(path.join(repo.dir, '.reslop')));
    assert.equal(saved.agents.claude.fast, true);
    ui.handleEvent({ type: 'key', key: 'a' });
    assert.equal(ui.agents.choice('claude').fast, false);
    assert.equal(ui.agents.rows()[0].fast, 'off');
    const cleared = JSON.parse(
      fs.readFileSync(path.join(repo.dir, '.reslop'), 'utf8'),
    );
    assert.equal(cleared.agents.claude.fast, undefined);
    ui.nav.agentCursor = 1;
    ui.handleEvent({ type: 'key', key: 'a' });
    assert.equal(ui.agents.choice('opencode').fast, false);
    assert.equal(ui.status, 'fast off');
  } finally {
    ui.agents.reset();
    repo.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('single click on the fast column toggles it', async () => {
  const { dir, env } = fakePath('claude-agent-acp');
  const { ui, repo } = await openUi();
  try {
    ui.agents.listModels = listed;
    ui.agents.refresh(env);
    await ui.agents.open();
    ui.draw();
    const hit = ui.lastFrame.fileHits.find((entry) => entry.field === 'fast');
    assert.ok(hit);
    const click = {
      type: 'mouse',
      button: 0,
      btn: 0,
      x: hit.x0 + 1,
      y: hit.y,
    };
    const press = (kind) => {
      ui.handleEvent({ ...click, kind, press: kind === 'press' });
    };
    press('press');
    press('release');
    assert.equal(ui.agents.choice('claude').fast, true);
    assert.equal(ui.agents.rows()[0].fast, 'on');
  } finally {
    ui.agents.reset();
    repo.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a model listed in several context sizes offers them', async () => {
  const { dir, env } = fakePath('cursor-agent');
  const { ui, repo } = await openUi();
  try {
    ui.agents.listModels = listed;
    ui.agents.refresh(env);
    await ui.agents.open();
    const at = ui.agents.rows().findIndex((row) => row.id === 'cursor');
    ui.nav.agentCursor = at;
    ui.handleEvent({ type: 'key', key: 't' });
    assert.equal(ui.agents.pick, null);
    ui.handleEvent({ type: 'key', key: 'm' });
    ui.handleEvent({ type: 'key', key: 'end' });
    ui.handleEvent({ type: 'key', key: 'enter' });
    assert.equal(ui.agents.choice('cursor').model, 'gpt-5');
    assert.equal(ui.agents.rows()[at].effort, 'low');
    assert.equal(ui.agents.rows()[at].context, '272k');
    ui.handleEvent({ type: 'key', key: 't' });
    assert.equal(ui.agents.pick.field, 'context');
    assert.deepEqual(ui.agents.menuItems(), ['272k', '1m']);
    ui.handleEvent({ type: 'key', key: 'down' });
    ui.handleEvent({ type: 'key', key: 'enter' });
    assert.equal(ui.agents.choice('cursor').context, '1m');
    ui.handleEvent({ type: 'key', key: 'e' });
    assert.deepEqual(ui.agents.menuItems(), ['low', 'high']);
    ui.handleEvent({ type: 'key', key: 'down' });
    ui.handleEvent({ type: 'key', key: 'enter' });
    assert.equal(ui.agents.choice('cursor').effort, 'high');
    ui.draw();
    const text = stripAnsi(ui.lastFrame.rows.join('\n'));
    assert.match(text, /context/);
    assert.match(text, /cursor\s+gpt-5\s+high\s+off\s+1m/);
    const file = path.join(repo.dir, '.reslop');
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(saved.agents.cursor.context, '1m');
    const calls = [];
    ui.agents.spawn = (cwd, launch) => {
      calls.push(launch);
      return { kill() {} };
    };
    ui.agents.start();
    assert.equal(calls.length, 1);
    const { choice } = calls[0];
    assert.deepEqual(modelChange(CURSOR_STATE, choice).params, {
      configId: 'model',
      value: 'gpt-5[context=1m,reasoning=high,fast=false]',
    });
    ui.handleEvent({ type: 'key', key: 'escape' });
    ui.handleEvent({ type: 'key', key: 'm' });
    ui.handleEvent({ type: 'key', key: 'up' });
    ui.handleEvent({ type: 'key', key: 'enter' });
    assert.equal(ui.agents.choice('cursor').model, 'composer-2');
    assert.equal(ui.agents.rows()[at].context, '');
    assert.deepEqual(ui.agents.rows()[at].contexts, []);
  } finally {
    ui.agents.reset();
    repo.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const pressKey = (ui, key) => ui.handleEvent({ type: 'key', key });

const settled = () =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });

test('i installs the npm package a missing agent needs', async () => {
  const { dir, bins, env } = fakePath('cursor-agent');
  const { ui, repo } = await openUi();
  try {
    ui.agents.listModels = listed;
    ui.agents.refresh(env);
    await ui.agents.open();
    assert.equal(actionFromKey('i', 'agents'), 'agentInstall');
    const calls = [];
    let close = null;
    ui.agents.spawn = (cwd, launch, onData, onClose) => {
      calls.push(launch);
      onData('added 120 packages\n');
      close = onClose;
      return { kill() {} };
    };
    const buttons = () => {
      const size = { width: 120, height: 24, color: false };
      return renderFrame(ui.view(), size).buttons;
    };
    const install = () => buttons().find((hit) => hit.id === 'agentInstall');
    assert.equal(ui.agents.selected().id, 'cursor');
    assert.equal(install(), undefined);
    pressKey(ui, 'i');
    assert.equal(calls.length, 0);
    assert.equal(ui.status, 'installed');
    ui.nav.agentCursor = AGENTS.findIndex((spec) => spec.id === 'agy');
    assert.equal(install(), undefined);
    pressKey(ui, 'i');
    assert.equal(calls.length, 0);
    assert.match(ui.status, /acp adapter for agy/);
    ui.nav.agentCursor = 0;
    assert.ok(install());
    pressKey(ui, 'i');
    assert.equal(calls.length, 1);
    const name = '@agentclientprotocol/claude-agent-acp';
    assert.equal(calls[0].kind, 'install');
    assert.deepEqual(calls[0].args, ['install', '--global', name]);
    assert.equal(calls[0].command, `npm install --global ${name}`);
    assert.equal(ui.agents.viewing, true);
    assert.equal(ui.agents.runningCount(), 1);
    assert.equal(ui.agents.jobs.length, 0);
    ui.draw();
    const log = stripAnsi(ui.lastFrame.rows.join('\n'));
    assert.match(log, /npm install --global @agentclientprotocol/);
    assert.match(log, /added 120 packages/);
    pressKey(ui, 'escape');
    assert.equal(ui.agents.sessionRows().length, 1);
    pressKey(ui, 'i');
    assert.equal(calls.length, 1);
    assert.equal(ui.agents.viewing, true);
    bins.claude = makeBin(dir, 'claude-agent-acp');
    close({ status: 0, text: 'added 120 packages\n' });
    assert.equal(ui.status, 'installed claude');
    assert.equal(ui.agents.runningCount(), 0);
    assert.equal(ui.agents.rows()[0].bin, bins.claude);
    await settled();
    assert.equal(ui.agents.rows()[0].model, 'sonnet');
    assert.equal(fs.existsSync(path.join(repo.dir, '.log')), false);
    pressKey(ui, 'escape');
    pressKey(ui, 'i');
    assert.equal(calls.length, 1);
    assert.equal(ui.status, 'installed');
  } finally {
    ui.agents.reset();
    repo.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an install is the npm command and its output', async () => {
  const { buildInstall, startAgent } = agents;
  const row = { ...rowOf(specOf('claude')), bin: '' };
  const launch = buildInstall(row);
  assert.equal(launch.ok, true);
  assert.match(path.basename(launch.cmd), /^npm(\.cmd)?$/);
  const name = '@agentclientprotocol/claude-agent-acp';
  assert.deepEqual(launch.args, ['install', '--global', name]);
  assert.equal(buildInstall(rowOf(specOf('claude'))).error, 'installed');
  const cursor = { ...rowOf(specOf('cursor')), bin: '', hint: 'by hand' };
  assert.equal(buildInstall(cursor).error, 'by hand');
  assert.equal(buildInstall(null).ok, false);
  const args = ['-e', 'console.log("added 1 package")'];
  const plain = { ...launch, cmd: process.execPath, args };
  const result = await new Promise((resolve) => {
    startAgent(os.tmpdir(), plain, () => {}, resolve);
  });
  assert.equal(result.status, 0);
  assert.equal(result.text, 'added 1 package\n');
});

test('a failed or stopped install leaves the agent missing', async () => {
  const { dir, env } = fakePath('cursor-agent');
  const { ui, repo } = await openUi();
  try {
    ui.agents.listModels = listed;
    ui.agents.refresh(env);
    await ui.agents.open();
    ui.nav.agentCursor = AGENTS.findIndex((spec) => spec.id === 'codex');
    const calls = [];
    const killed = [];
    let close = null;
    ui.agents.spawn = (cwd, launch, onData, onClose) => {
      calls.push(launch);
      close = onClose;
      return { kill: () => killed.push(launch.id) };
    };
    pressKey(ui, 'i');
    close({ status: 243, text: 'npm error code EACCES\n' });
    assert.equal(ui.status, 'install failed');
    assert.equal(ui.agents.selected().bin, '');
    ui.draw();
    assert.match(stripAnsi(ui.lastFrame.rows.join('\n')), /EACCES/);
    pressKey(ui, 'r');
    assert.equal(calls.length, 2);
    assert.equal(calls[1].command, calls[0].command);
    pressKey(ui, 's');
    assert.deepEqual(killed, ['codex']);
    assert.equal(ui.status, 'stopped');
    assert.equal(ui.agents.runningCount(), 0);
    pressKey(ui, 'escape');
    pressKey(ui, 'i');
    assert.equal(calls.length, 3);
    close({ status: 0, text: 'added 1 package\n' });
    assert.equal(ui.status, 'installed, but not on PATH');
  } finally {
    ui.agents.reset();
    repo.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const paramOption = (id, category, current, values) =>
  select(id, category, current, values);

const GROK_OPTIONS = [
  paramOption('context', 'model_config', '256k', ['256k', '500k']),
  paramOption('reasoning_effort', 'thought_level', 'high', ['low', 'high']),
  paramOption('fast', 'model_config', 'true', ['false', 'true']),
];

// An agent whose options belong to a model: only an asked model has them
const perModelAgent = () => {
  const base = acpState({ models: ['composer', 'grok'] });
  const own = [paramOption('fast', 'model_config', 'true', ['false', 'true'])];
  base.configOptions.push(...own);
  const asked = [];
  const listModels = async (row, options) => {
    asked.push(options.models);
    const byModel = new Map([['composer', base.configOptions]]);
    const grok = [base.configOptions[0], ...GROK_OPTIONS];
    if (options.models.includes('grok')) byModel.set('grok', grok);
    return { ...base, byModel };
  };
  return { asked, listModels };
};

test('picking a model asks the agent for its settings', async () => {
  const { dir, env } = fakePath('cursor-agent');
  const { ui, repo } = await openUi();
  try {
    const { asked, listModels } = perModelAgent();
    ui.agents.listModels = listModels;
    ui.agents.refresh(env);
    await ui.agents.open();
    assert.deepEqual(asked, [[]]);
    const at = ui.agents.rows().findIndex((row) => row.id === 'cursor');
    ui.nav.agentCursor = at;
    const row = () => ui.agents.rows()[at];
    assert.equal(row().model, 'composer');
    assert.deepEqual(row().efforts, []);
    assert.equal(row().fast, 'off');
    ui.handleEvent({ type: 'key', key: 'm' });
    ui.handleEvent({ type: 'key', key: 'down' });
    ui.handleEvent({ type: 'key', key: 'enter' });
    assert.equal(ui.agents.choice('cursor').model, 'grok');
    assert.deepEqual(row().efforts, []);
    assert.deepEqual(row().contexts, []);
    await settled();
    assert.deepEqual(asked, [[], ['grok']]);
    assert.deepEqual(row().efforts, ['low', 'high']);
    assert.deepEqual(row().contexts, ['256k', '500k']);
    assert.equal(row().effort, 'high');
    assert.equal(row().context, '256k');
    assert.equal(row().fast, 'off');
    ui.handleEvent({ type: 'key', key: 'e' });
    assert.deepEqual(ui.agents.menuItems(), ['low', 'high']);
    ui.handleEvent({ type: 'key', key: 'up' });
    ui.handleEvent({ type: 'key', key: 'enter' });
    ui.handleEvent({ type: 'key', key: 't' });
    assert.deepEqual(ui.agents.menuItems(), ['256k', '500k']);
    ui.handleEvent({ type: 'key', key: 'down' });
    ui.handleEvent({ type: 'key', key: 'enter' });
    ui.handleEvent({ type: 'key', key: 'a' });
    assert.equal(ui.status, 'fast on');
    ui.draw();
    const text = stripAnsi(ui.lastFrame.rows.join('\n'));
    assert.match(text, /cursor\s+grok\s+low\s+on\s+500k/);
    const calls = [];
    ui.agents.spawn = (cwd, launch) => {
      calls.push(launch);
      return { kill() {} };
    };
    ui.agents.start();
    const { choice } = calls[0];
    assert.deepEqual(choice, {
      model: 'grok',
      effort: 'low',
      fast: true,
      context: '500k',
    });
    const live = { configOptions: GROK_OPTIONS };
    const set = (change) => [change.params.configId, change.params.value];
    assert.deepEqual(set(effortChange(live, choice)), [
      'reasoning_effort',
      'low',
    ]);
    assert.deepEqual(set(contextChange(live, choice)), ['context', '500k']);
    assert.equal(fastChange(live, choice), null);
    const slow = { ...choice, fast: false };
    assert.deepEqual(set(fastChange(live, slow)), ['fast', 'false']);
    ui.handleEvent({ type: 'key', key: 'escape' });
    ui.handleEvent({ type: 'key', key: 'm' });
    ui.handleEvent({ type: 'key', key: 'enter' });
    await settled();
    assert.equal(asked.length, 2);
  } finally {
    ui.agents.reset();
    repo.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the settings of a saved model are asked for on load', async () => {
  const { dir, env } = fakePath('cursor-agent');
  const { ui, repo } = await openUi();
  try {
    const file = path.join(repo.dir, '.reslop');
    const cursor = { model: 'grok', effort: 'low', context: '500k' };
    fs.writeFileSync(file, `${JSON.stringify({ agents: { cursor } })}\n`);
    const { asked, listModels } = perModelAgent();
    ui.agents.listModels = listModels;
    ui.agents.refresh(env);
    await ui.agents.open();
    assert.deepEqual(asked, [['grok']]);
    const row = ui.agents.rows().find((item) => item.id === 'cursor');
    assert.equal(row.model, 'grok');
    assert.equal(row.effort, 'low');
    assert.equal(row.context, '500k');
    assert.deepEqual(row.efforts, ['low', 'high']);
  } finally {
    ui.agents.reset();
    repo.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('clicking the context column drops the size list', async () => {
  const { dir, env } = fakePath('cursor-agent');
  const { ui, repo } = await openUi();
  try {
    ui.agents.listModels = listed;
    ui.agents.refresh(env);
    await ui.agents.open();
    const at = ui.agents.rows().findIndex((row) => row.id === 'cursor');
    ui.nav.agentCursor = at;
    ui.agents.choice('cursor').model = 'gpt-5';
    const calls = [];
    ui.agents.spawn = () => {
      calls.push('start');
      return { kill() {} };
    };
    ui.draw();
    const hit = ui.lastFrame.fileHits.find(
      (entry) => entry.field === 'context' && entry.cursor === at,
    );
    assert.ok(hit);
    const click = {
      type: 'mouse',
      button: 0,
      btn: 0,
      x: hit.x0 + 1,
      y: hit.y,
    };
    const press = (kind) => {
      ui.handleEvent({ ...click, kind, press: kind === 'press' });
    };
    press('press');
    press('release');
    assert.equal(ui.agents.pick && ui.agents.pick.field, 'context');
    assert.deepEqual(ui.agents.menuItems(), ['272k', '1m']);
    assert.equal(calls.length, 0);
    press('press');
    press('release');
    assert.equal(calls.length, 0);
    assert.equal(ui.agents.jobs.length, 0);
  } finally {
    ui.agents.reset();
    repo.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('agent columns fill the row in proportion to their content', async () => {
  const { dir, env } = fakePath('claude-agent-acp');
  const { ui, repo, stdout } = await openUi();
  try {
    ui.agents.listModels = listed;
    ui.agents.refresh(env);
    await ui.agents.open();
    stdout.columns = 160;
    ui.draw();
    const plain = stripAnsi(ui.lastFrame.rows.join('\n')).split('\n');
    const titleAt = plain.findIndex((line) => /agent\s+model/.test(line));
    assert.equal(titleAt, 2);
    assert.equal(plain[1].trim(), '');
    assert.match(plain[titleAt], /plan/);
    assert.match(plain[titleAt], /^ {2}agent/);
    assert.equal(/^ {3}agent/.test(plain[titleAt]), false);
    assert.equal(plain[titleAt].includes('status'), false);
    const plan = ui.lastFrame.fileHits.find((hit) => hit.field === 'plan');
    const model = ui.lastFrame.fileHits.find((hit) => hit.field === 'model');
    assert.ok(plan);
    assert.ok(model);
    const planW = plan.x1 - plan.x0;
    const modelW = model.x1 - model.x0;
    assert.ok(planW > modelW);
    assert.ok(modelW > 'sonnet'.length);
    assert.equal(plan.x1, 122);
  } finally {
    ui.agents.reset();
    repo.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('agent history keeps the launch, output, time, and progress', async () => {
  const { dir, env } = fakePath('claude-agent-acp');
  const { ui, repo, stdout } = await openUi();
  try {
    const reviewDir = path.join(repo.dir, '.plan');
    fs.mkdirSync(reviewDir, { recursive: true });
    const name = '2020-01-01-00.md';
    const body = [
      '---',
      'status: editing',
      '---',
      '',
      '> a.js',
      '',
      '- [x] rewrite loop',
      '- [ ] still open',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(reviewDir, name), body);
    ui.review.store.reviewPath = '';
    ui.agents.listModels = listed;
    ui.agents.refresh(env);
    await ui.agents.open();
    const sessionId = '2fa698ba-9a19-4a84-8134-5a7cd9ec2c56';
    const text = 'hello from agent\n';
    const stats = { session: sessionId, files: 9, tokens: 1234 };
    ui.agents.spawn = (cwd, launch, onData, onClose) => {
      onData(text);
      onClose({ status: 0, text, stats });
      return { kill() {} };
    };
    ui.agents.start();
    const job = ui.agents.jobs[0];
    assert.equal(job.status, 'exit 0');
    assert.match(job.command, /claude/);
    assert.match(job.output, /hello from agent/);
    stdout.columns = 160;
    assert.equal(ui.agents.viewing, true);
    ui.draw();
    const rows = ui.lastFrame.rows.map((row) => stripAnsi(row));
    const log = rows.join('\n');
    assert.equal(rows[1].trim(), '');
    const command = rows.find((row) => row.includes('rewrite loop'));
    const status = rows.find((row) => row.includes('exit 0'));
    assert.match(command, /^ {2}\S/);
    assert.match(status, /^ {2}exit 0/);
    assert.equal(command.slice(-2), '  ');
    assert.equal(status.slice(-2), '  ');
    assert.match(log, /rewrite loop/);
    assert.match(ui.agents.jobs[0].logName, /-agent-\d+\.log$/);
    assert.match(log, /hello from agent/);
    assert.match(log, /exit 0/);
    assert.match(log, /\d+:\d{2}/);
    assert.match(log, /1\/2/);
    ui.handleEvent({ type: 'key', key: 'escape' });
    assert.equal(ui.agents.viewing, false);
    ui.agents.focusRuns();
    ui.draw();
    const list = stripAnsi(ui.lastFrame.rows.join('\n'));
    assert.equal(list.includes('▶'), false);
    assert.equal(list.includes('status'), false);
    assert.match(list, /<start new session>/);
    assert.match(list, /rewrite loop/);
    assert.equal(/-agent-\d+/.test(list), false);
    assert.equal(list.includes('exit 0'), false);
    ui.handleEvent({ type: 'key', key: 'down' });
    ui.handleEvent({ type: 'key', key: 'enter' });
    assert.equal(ui.agents.viewing, true);
    ui.draw();
    const opened = stripAnsi(ui.lastFrame.rows.join('\n'));
    assert.match(opened, /hello from agent/);
    const folder = path.join(repo.dir, '.log');
    const jsonName = fs
      .readdirSync(folder)
      .find((name) => name.endsWith('.json'));
    const runPath = path.join(folder, jsonName);
    const run = JSON.parse(fs.readFileSync(runPath, 'utf8'));
    assert.equal(run.exit, 0);
    assert.equal(run.status, undefined);
    assert.equal(run.endedAt, undefined);
    assert.equal(run.output, undefined);
    assert.equal(typeof run.elapsed, 'number');
    assert.equal(run.files, 9);
    assert.equal(run.session, sessionId);
    assert.match(run.command, /claude/);
    assert.match(run.log, /\.log$/);
    assert.match(run.raw, /\.raw$/);
    const savedLog = fs.readFileSync(path.join(folder, run.log), 'utf8');
    const savedRaw = fs.readFileSync(path.join(folder, run.raw), 'utf8');
    assert.match(savedLog, /hello from agent/);
    assert.match(savedRaw, /hello from agent/);
    assert.equal(fs.existsSync(path.join(repo.dir, '.plan', '.runs')), false);
    const sessions = JSON.parse(
      fs.readFileSync(path.join(repo.dir, '.plan', '.sessions'), 'utf8'),
    );
    const session = sessions[sessionId];
    assert.equal(session.cli, 'claude');
    assert.equal(session.files, 9);
    assert.equal(session.tokens, 1234);
    assert.match(session.name, /-agent-/);
    assert.equal(session.title, 'rewrite loop');
    assert.equal(fs.existsSync(path.join(repo.dir, '.reslop')), false);
    ui.agents.reset();
    assert.equal(ui.agents.jobs[0].status, 'exit 0');
    ui.agents.openSession(sessionId);
    assert.match(ui.agents.historyText, /hello from agent/);
  } finally {
    ui.agents.reset();
    repo.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('agent output shows a scroller when the log overflows', async () => {
  const { dir, env } = fakePath('claude-agent-acp');
  const repo = makeRepo();
  repo.write('a.js', 'ok\n');
  repo.git(['add', '.']);
  repo.git(['commit', '-m', 'init']);
  const stdout = uiSink();
  stdout.columns = 80;
  stdout.rows = 16;
  const ui = new Session({
    cwd: repo.dir,
    stdout,
    repo: createGitRepo(),
    color: true,
    startPane: 'dashboard',
  });
  await ui.ensureRepo();
  await ui.load();
  try {
    ui.agents.listModels = listed;
    ui.agents.refresh(env);
    await ui.agents.open();
    const text = Array.from({ length: 80 }, (_, i) => `line ${i}`).join('\n');
    ui.agents.spawn = (cwd, launch, onData, onClose) => {
      onData(`${text}\n`);
      onClose({ status: 0, text: `${text}\n` });
      return { kill() {} };
    };
    ui.agents.start();
    assert.equal(ui.agents.viewing, true);
    ui.draw();
    const thumb = bg(THEME.taskHeadBg);
    const track = bg(THEME.buttonBg);
    const ground = bg(THEME.ctxBg);
    const logRows = () =>
      ui.lastFrame.rows.filter((row) => {
        if (!row.includes(ground)) return false;
        return row.includes(thumb) || row.includes(track);
      });
    const open = logRows();
    assert.ok(open.some((row) => row.includes(thumb)));
    assert.ok(open.some((row) => !row.includes(thumb)));
    const thumbAt = open.findIndex((row) => row.includes(thumb));
    assert.ok(thumbAt > 0);
    ui.handleEvent({ type: 'key', key: 'home' });
    ui.draw();
    const top = logRows();
    const nextAt = top.findIndex((row) => row.includes(thumb));
    assert.ok(nextAt < thumbAt);
  } finally {
    ui.agents.reset();
    repo.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('dragging the agent output scroller scrolls the log', async () => {
  const { dir, env } = fakePath('claude-agent-acp');
  const repo = makeRepo();
  repo.write('a.js', 'ok\n');
  repo.git(['add', '.']);
  repo.git(['commit', '-m', 'init']);
  const stdout = uiSink();
  stdout.columns = 80;
  stdout.rows = 16;
  const ui = new Session({
    cwd: repo.dir,
    stdout,
    repo: createGitRepo(),
    color: true,
    startPane: 'dashboard',
  });
  await ui.ensureRepo();
  await ui.load();
  try {
    ui.agents.listModels = listed;
    ui.agents.refresh(env);
    await ui.agents.open();
    const text = Array.from({ length: 80 }, (_, i) => `line ${i}`).join('\n');
    ui.agents.spawn = (cwd, launch, onData, onClose) => {
      onData(`${text}\n`);
      onClose({ status: 0, text: `${text}\n` });
      return { kill() {} };
    };
    ui.agents.start();
    ui.draw();
    const bar = ui.lastFrame.scrollBar;
    assert.ok(bar);
    const max = bar.count - bar.rows;
    assert.ok(max > 0);
    const thumb = bg(THEME.taskHeadBg);
    const thumbAt = ui.lastFrame.rows.findIndex((row) => row.includes(thumb));
    assert.ok(thumbAt > 1);
    const pointer = (kind, x, y) => {
      ui.handleEvent({
        type: 'mouse',
        button: kind === 'drag' ? 32 : 0,
        btn: 0,
        kind,
        x,
        y,
        press: kind !== 'release',
      });
    };
    pointer('press', bar.x, thumbAt + 1);
    pointer('drag', bar.x, thumbAt - 1);
    pointer('release', bar.x, thumbAt - 1);
    ui.draw();
    assert.equal(ui.nav.selection, null);
    assert.equal(ui.agents.followEnd, false);
    assert.ok(ui.agents.logScroll > 0);
    assert.ok(ui.agents.logScroll < max);
    const mid = ui.lastFrame.scrollBar;
    pointer('press', mid.x, mid.y + mid.height - 1);
    pointer('drag', mid.x, mid.y);
    pointer('release', mid.x, mid.y);
    ui.draw();
    assert.equal(ui.nav.selection, null);
    assert.equal(ui.agents.logScroll, 0);
    const shown = stripAnsi(ui.lastFrame.rows.join('\n'));
    assert.match(shown, /line 0/);
    assert.equal(shown.includes('line 79'), false);
    const line = ui.lastFrame.rows.findIndex((row) =>
      stripAnsi(row).includes('line 0'),
    );
    assert.ok(line >= 0);
    pointer('press', 4, line + 1);
    pointer('drag', 12, line + 1);
    assert.ok(ui.nav.selection);
    assert.equal(ui.agents.logScroll, 0);
  } finally {
    ui.agents.reset();
    repo.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('continue starts the session selected in the right panel', async () => {
  const { dir, env } = fakePath('cursor-agent');
  const { ui, repo, stdout } = await openUi();
  try {
    ui.agents.listModels = listed;
    ui.agents.refresh(env);
    await ui.agents.open();
    const at = ui.agents.rows().findIndex((row) => row.id === 'cursor');
    ui.nav.agentCursor = at;
    const calls = [];
    ui.agents.spawn = (cwd, launch) => {
      calls.push(launch);
      return { kill() {} };
    };
    stdout.columns = 160;
    ui.draw();
    const chooser = stripAnsi(ui.lastFrame.rows.join('\n'));
    assert.match(chooser, /<start new session>/);
    assert.equal(chooser.includes('session?'), false);
    assert.equal(ui.agents.focus, 'cli');
    assert.equal(ui.view().agentCanStart, true);
    ui.handleEvent({ type: 'key', key: 's' });
    assert.equal(ui.mode, 'review');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].session, '');
    const started = ui.agents.jobs.find((job) => job.status === 'running');
    const sessionId = '2fa698ba-9a19-4a84-8134-5a7cd9ec2c56';
    started.status = 'exit 0';
    started.child = null;
    started.session = sessionId;
    started.logName = '2026-10-09-agent-01.log';
    started.startedAt = 1;
    ui.agents.closeView();
    ui.agents.focusRuns();
    ui.agents.move(1);
    ui.agents.focusCli();
    assert.equal(ui.view().agentCanStart, true);
    ui.draw();
    const footer = stripAnsi(ui.lastFrame.rows.at(-1));
    assert.match(footer, /start/);
    assert.equal(footer.includes('continue'), false);
    ui.handleEvent({ type: 'key', key: 's' });
    assert.equal(calls.length, 2);
    assert.equal(calls[1].session, sessionId);
    assert.deepEqual(calls[1].args, ['acp']);
    assert.match(calls[1].prompt, /repair plan/);
    const continued = ui.agents.jobs.at(-1);
    assert.equal(continued.resume, sessionId);
    continued.status = 'exit 1';
    continued.child = null;
    ui.handleEvent({ type: 'key', key: 'r' });
    assert.equal(calls.length, 3);
    assert.equal(calls[2].session, sessionId);
  } finally {
    ui.agents.reset();
    repo.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('agent raw log keeps terminal escapes', async () => {
  const { dir, env } = fakePath('claude-agent-acp');
  const { ui, repo } = await openUi();
  try {
    ui.agents.listModels = listed;
    ui.agents.refresh(env);
    await ui.agents.open();
    const colored = '\x1b[31mred\x1b[0m\n';
    ui.agents.spawn = (cwd, launch, onData, onClose) => {
      const child = {
        kill() {},
        raw: () => colored,
      };
      queueMicrotask(() => {
        onData('red\n');
        onClose({ status: 0, text: 'red\n' });
      });
      return child;
    };
    ui.agents.start();
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
    const folder = path.join(repo.dir, '.log');
    const jsonName = fs
      .readdirSync(folder)
      .find((name) => name.endsWith('.json'));
    const runPath = path.join(folder, jsonName);
    const run = JSON.parse(fs.readFileSync(runPath, 'utf8'));
    const savedRaw = fs.readFileSync(path.join(folder, run.raw), 'utf8');
    const savedLog = fs.readFileSync(path.join(folder, run.log), 'utf8');
    assert.ok(savedRaw.includes('\x1b[31mred'));
    assert.equal(savedLog.includes('\x1b'), false);
    assert.match(savedLog, /red/);
  } finally {
    ui.agents.reset();
    repo.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a plan runs through an acp agent to its end', SH_ONLY, async () => {
  const name = 'claude-agent-acp';
  const { dir, bins, env } = fakePath(name);
  const script = `#!/bin/sh\nexec "${process.execPath}" "${FIXTURE}" --acp\n`;
  fs.writeFileSync(bins[name], script);
  const { ui, repo } = await openUi();
  try {
    ui.agents.refresh(env);
    await ui.agents.open();
    const row = ui.agents.rows()[0];
    assert.equal(row.model, 'opus');
    assert.deepEqual(row.efforts, ['low', 'medium', 'high']);
    assert.equal(row.effort, 'medium');
    ui.agents.start();
    const job = ui.agents.jobs[0];
    assert.equal(job.status, 'running');
    await new Promise((resolve) => {
      const check = () => {
        if (job.status === 'running') setTimeout(check, 5);
        else resolve();
      };
      check();
    });
    assert.equal(job.status, 'exit 0');
    assert.match(job.output, /got: Read and execute repair plan at \.plan\//);
    assert.match(job.output, /settings: acceptEdits opus medium off/);
    assert.match(job.output, /✔ Edit a\.js/);
    assert.equal(job.rawText, job.output);
    assert.equal(job.session, 'session-1');
    assert.equal(job.files, 1);
    assert.equal(job.tokens, 1234);
    const rows = ui.agents.sessionRows();
    assert.equal(rows[1].id, 'session-1');
  } finally {
    ui.agents.reset();
    repo.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a session opens on its last run and loads older on scroll', async () => {
  const { dir, env } = fakePath('claude-agent-acp');
  const { ui, repo } = await openUi();
  try {
    ui.agents.listModels = listed;
    ui.agents.refresh(env);
    await ui.agents.open();
    const sessionId = '2fa698ba-9a19-4a84-8134-5a7cd9ec2c56';
    const folder = path.join(repo.dir, '.log');
    fs.mkdirSync(folder, { recursive: true });
    const older = '2026-10-09-agent-01';
    const newer = '2026-10-09-agent-02';
    fs.writeFileSync(path.join(folder, `${older}.raw`), 'older line\n');
    fs.writeFileSync(path.join(folder, `${newer}.raw`), 'newer line\n');
    ui.agents.jobs = [
      {
        id: 1,
        cliId: 'claude',
        session: sessionId,
        logName: `${older}.log`,
        rawName: `${older}.raw`,
        startedAt: 1,
      },
      {
        id: 2,
        cliId: 'claude',
        session: sessionId,
        logName: `${newer}.log`,
        rawName: `${newer}.raw`,
        startedAt: 2,
      },
    ];
    ui.agents.openSession(sessionId);
    assert.match(ui.agents.historyText, /newer line/);
    assert.equal(ui.agents.historyText.includes('older line'), false);
    ui.agents.followEnd = false;
    ui.agents.logScroll = 0;
    ui.agents.scrollLog(-1);
    assert.match(ui.agents.historyText, /older line/);
    assert.match(ui.agents.historyText, /newer line/);
    const olderAt = ui.agents.historyText.indexOf('older line');
    const newerAt = ui.agents.historyText.indexOf('newer line');
    assert.ok(olderAt < newerAt);
  } finally {
    ui.agents.reset();
    repo.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a completed session reopens with its captured output', async () => {
  const { dir, env } = fakePath('claude-agent-acp');
  const { ui, repo } = await openUi();
  try {
    ui.agents.listModels = listed;
    ui.agents.refresh(env);
    await ui.agents.open();
    const sessionId = '2fa698ba-9a19-4a84-8134-5a7cd9ec2c56';
    ui.agents.jobs = [
      {
        id: 1,
        cliId: 'claude',
        session: sessionId,
        logName: '2026-10-09-agent-01.log',
        output: 'completed agent output\n',
        startedAt: 1,
      },
    ];
    ui.agents.focusRuns();
    ui.agents.move(1);
    ui.handleEvent({ type: 'key', key: 'enter' });
    assert.equal(ui.agents.viewing, true);
    assert.match(ui.agents.historyText, /completed agent output/);
  } finally {
    ui.agents.reset();
    repo.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('saved runs reload when the repository root changes', async () => {
  const { dir, env } = fakePath('claude-agent-acp');
  const { ui, repo } = await openUi();
  try {
    ui.agents.listModels = listed;
    ui.agents.refresh(env);
    const sessionId = '2fa698ba-9a19-4a84-8134-5a7cd9ec2c56';
    const folder = path.join(repo.dir, '.log');
    fs.mkdirSync(folder, { recursive: true });
    const stem = '2026-10-09-agent-01';
    const saved = {
      id: 1,
      cliId: 'claude',
      action: 'run',
      exit: 0,
      startedAt: 1,
      session: sessionId,
      log: `${stem}.log`,
      raw: `${stem}.raw`,
    };
    fs.writeFileSync(path.join(folder, `${stem}.json`), JSON.stringify(saved));
    fs.writeFileSync(path.join(folder, `${stem}.raw`), 'saved line\n');
    ui.agents.runsRoot = path.join(repo.dir, 'elsewhere');
    ui.agents.jobs = [];
    await ui.agents.open();
    const rows = ui.agents.sessionRows();
    assert.equal(rows.length, 2);
    assert.equal(rows[1].id, sessionId);
    ui.agents.focusRuns();
    ui.agents.move(1);
    ui.handleEvent({ type: 'key', key: 'enter' });
    assert.equal(ui.agents.viewing, true);
    assert.match(ui.agents.historyText, /saved line/);
  } finally {
    ui.agents.reset();
    repo.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('reopening the agents screen restores both selections', async () => {
  const { dir, env } = fakePath('claude-agent-acp', 'codex-acp');
  const { ui, repo } = await openUi();
  try {
    ui.agents.listModels = listed;
    ui.agents.refresh(env);
    await ui.agents.open();
    assert.equal(ui.agents.selected().id, 'claude');
    const codex = ui.agents.list.findIndex((row) => row.id === 'codex');
    ui.nav.agentCursor = codex;
    ui.agents.jobs = ['one', 'two'].map((session, at) => ({
      id: at + 1,
      cliId: 'codex',
      session,
      logName: `2026-10-09-agent-0${at + 1}.log`,
      startedAt: at + 1,
    }));
    ui.agents.focusRuns();
    ui.agents.move(1);
    assert.equal(ui.agents.runCursor, 1);
    await ui.agents.open();
    assert.equal(ui.nav.agentCursor, codex);
    assert.equal(ui.agents.focus, 'runs');
    assert.equal(ui.agents.runCursor, 1);
    assert.equal(ui.agents.viewing, false);
  } finally {
    ui.agents.reset();
    repo.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('legacy .reslop runs move into .log', async () => {
  const { dir, env } = fakePath('claude-agent-acp');
  const { ui, repo } = await openUi();
  try {
    ui.agents.listModels = listed;
    ui.agents.refresh(env);
    const legacy = {
      id: 4,
      cliId: 'claude',
      name: 'claude',
      model: 'sonnet',
      cmd: '/bin/claude',
      args: [],
      command: 'claude plan',
      plan: '.plan/a.md',
      action: 'run',
      status: 'exit 0',
      exit: 0,
      output: 'done\n',
      startedAt: 1000,
      endedAt: 4000,
    };
    const prefs = { agents: { claude: { model: 'sonnet' } }, runs: [legacy] };
    const file = path.join(repo.dir, '.reslop');
    fs.writeFileSync(file, `${JSON.stringify(prefs, null, 2)}\n`);
    ui.agents.loadRuns();
    assert.equal(ui.agents.jobs.length, 1);
    assert.equal(ui.agents.jobs[0].status, 'exit 0');
    assert.equal(ui.agents.jobs[0].elapsed(), '0:03');
    const folder = path.join(repo.dir, '.log');
    const jsonName = fs
      .readdirSync(folder)
      .find((name) => name.endsWith('.json'));
    const runPath = path.join(folder, jsonName);
    const run = JSON.parse(fs.readFileSync(runPath, 'utf8'));
    assert.equal(run.exit, 0);
    assert.equal(run.status, undefined);
    assert.equal(run.elapsed, 3);
    assert.equal(run.endedAt, undefined);
    const body = fs.readFileSync(path.join(folder, run.log), 'utf8');
    assert.match(body, /done/);
    assert.equal(fs.existsSync(path.join(repo.dir, '.plan', '.runs')), false);
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(saved.runs, undefined);
    assert.equal(saved.agents.claude.model, 'sonnet');
  } finally {
    ui.agents.reset();
    repo.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
