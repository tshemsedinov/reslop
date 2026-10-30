'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const agents = require('../../lib/agents/agents.js');
const { planPrompt } = agents;
const { emptyChoice, buildLaunch, buildInstall, AGENTS } = agents;
const { effortChange, fastChange } = agents;
const { contextChange } = agents;
const { press, click, rightClick } = require('../helpers.js');
const ansi = require('../../lib/term/ansi.js');
const { stripAnsi, THEME, bg, RESET, seq } = ansi;
const clipboard = require('../../lib/term/select.js');
const { setImmediate: settle } = require('node:timers/promises');
const agentsHelpers = require('../agents-helpers.js');
const { labelRow, select, acpState, STATES, listed, rowOf } = agentsHelpers;
const { specOf, openAgents, showAgents, typeInto } = agentsHelpers;

test('an install is the npm command and its output', async () => {
  const { startAgent } = agents;
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

test('a failed or stopped install leaves the agent missing', async (t) => {
  const { env, ui } = await openAgents(t, 'cursor-agent');
  await showAgents(ui, env);
  ui.nav.agentCursor = AGENTS.findIndex((spec) => spec.id === 'codex');
  const calls = [];
  const killed = [];
  let close = null;
  ui.agents.spawn = (cwd, launch, onData, onClose) => {
    calls.push(launch);
    close = onClose;
    return { kill: () => killed.push(launch.id) };
  };
  press(ui, 'i', 'y');
  close({ status: 243, text: 'npm error code EACCES\n' });
  assert.equal(ui.status, 'install failed');
  assert.equal(ui.agents.selected().bin, '');
  ui.draw();
  assert.match(stripAnsi(ui.lastFrame.rows.join('\n')), /EACCES/);
  press(ui, 'r');
  assert.equal(calls.length, 2);
  assert.equal(calls[1].command, calls[0].command);
  press(ui, 's');
  assert.deepEqual(killed, ['codex']);
  assert.equal(ui.status, 'stopped');
  assert.equal(ui.agents.runningCount(), 0);
  press(ui, 'escape', 'i', 'y');
  assert.equal(calls.length, 3);
  close({ status: 0, text: 'added 1 package\n' });
  assert.equal(ui.status, 'installed, but not found');
});

const GROK_OPTIONS = [
  select('context', 'model_config', '256k', ['256k', '500k']),
  select('reasoning_effort', 'thought_level', 'high', ['low', 'high']),
  select('fast', 'model_config', 'true', ['false', 'true']),
];

// An agent whose options belong to a model: only an asked model has them
const perModelAgent = () => {
  const base = acpState({ models: ['composer', 'grok'] });
  const own = [select('fast', 'model_config', 'true', ['false', 'true'])];
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

test('picking a model asks the agent for its settings', async (t) => {
  const { env, ui } = await openAgents(t, 'cursor-agent');
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
  press(ui, 'm', 'down', 'enter');
  assert.equal(ui.agents.choice('cursor').model, 'grok');
  assert.deepEqual(row().efforts, []);
  assert.deepEqual(row().contexts, []);
  await settle();
  assert.deepEqual(asked, [[], ['grok']]);
  assert.deepEqual(row().efforts, ['low', 'high']);
  assert.deepEqual(row().contexts, ['256k', '500k']);
  assert.equal(row().effort, 'high');
  assert.equal(row().context, '256k');
  assert.equal(row().fast, 'off');
  press(ui, 'e');
  assert.deepEqual(ui.agents.menuItems(), ['low', 'high']);
  press(ui, 'up', 'enter', 'x');
  assert.deepEqual(ui.agents.menuItems(), ['256k', '500k']);
  press(ui, 'down', 'enter', 'o');
  assert.equal(ui.status, 'fast on');
  ui.draw();
  const text = stripAnsi(ui.lastFrame.rows.join('\n'));
  assert.match(text, /model +grok/);
  assert.match(text, /effort +low/);
  assert.match(text, /fast mode +on/);
  assert.match(text, /context +500k/);
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
  press(ui, 'escape', 'm', 'enter');
  await settle();
  assert.equal(asked.length, 2);
});

test('the settings of a saved model are asked for on load', async (t) => {
  const { env, ui, repo } = await openAgents(t, 'cursor-agent');
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
});

test('clicking the context column drops the size list', async (t) => {
  const { env, ui } = await openAgents(t, 'cursor-agent');
  await showAgents(ui, env);
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
  click(ui, hit.x0 + 1, hit.y);
  assert.equal(ui.agents.pick && ui.agents.pick.field, 'context');
  assert.deepEqual(ui.agents.menuItems(), ['272k', '1m']);
  assert.equal(calls.length, 0);
  click(ui, hit.x0 + 1, hit.y);
  assert.equal(calls.length, 0);
  assert.equal(ui.agents.jobs.length, 0);
});

test('agent properties are a table beside the sessions', async (t) => {
  const { env, ui, stdout } = await openAgents(t, 'claude-agent-acp');
  await showAgents(ui, env);
  stdout.columns = 160;
  stdout.rows = 30;
  ui.draw();
  const plain = stripAnsi(ui.lastFrame.rows.join('\n')).split('\n');
  assert.equal(plain[1].trim(), '');
  const labels = ['agent', 'model', 'effort', 'fast mode', 'context'];
  labels.push('plan', 'Status');
  const ends = new Set();
  for (const label of labels) {
    const line = plain.find((text) => new RegExp(`^ +${label} `).test(text));
    if (label === 'context' && !line) continue;
    assert.ok(line, label);
    ends.add(line.indexOf(label) + label.length);
  }
  assert.equal(ends.size, 1);
  assert.equal(
    plain.some((line) => /agent\s+model\s+effort/.test(line)),
    false,
  );
  // The sessions are on the left under the table, the prompt on the right
  const leftW = 160 - Math.floor(160 * 0.3);
  const run = ui.lastFrame.fileHits.find((hit) => hit.side === 'runs');
  assert.equal(run.x0, 0);
  assert.equal(run.x1, leftW);
  const hits = ui.lastFrame.editHits;
  const task = hits.filter((hit) => hit.editor === ui.agents.task);
  assert.ok(task.length > 3);
  for (const hit of task) assert.ok(hit.x0 > leftW);
  const last = Math.max(...task.map((hit) => hit.y));
  assert.equal(last, ui.lastFrame.height - 3);
});

test('the cursor walks the fields and a combo drops on Enter', async (t) => {
  const { env, ui } = await openAgents(t, 'claude-agent-acp');
  await showAgents(ui, env);
  assert.equal(ui.agents.currentField(), 'agent');
  press(ui, 'down');
  assert.equal(ui.agents.currentField(), 'model');
  assert.equal(ui.agents.pick, null);
  press(ui, 'down', 'down');
  assert.equal(ui.agents.currentField(), 'fast');
  assert.equal(ui.agents.pick, null);
  press(ui, 'enter');
  assert.equal(ui.agents.choice('claude').fast, true);
  assert.equal(ui.agents.pick, null);
  press(ui, 'up', 'up');
  assert.equal(ui.agents.currentField(), 'model');
  press(ui, 'enter');
  assert.equal(ui.agents.pick.field, 'model');
  press(ui, 'escape');
  assert.equal(ui.agents.pick, null);
  assert.equal(ui.pane, 'agents');
  press(ui, 'up', 'enter');
  assert.equal(ui.agents.pick.field, 'agent');
  const items = ui.agents.menuItems();
  assert.equal(items[0], 'claude');
  assert.ok(items.includes('opencode  not installed'));
  press(ui, 'down', 'enter');
  assert.equal(ui.agents.selected().id, 'opencode');
  ui.draw();
  const text = stripAnsi(ui.lastFrame.rows.join('\n'));
  assert.match(text, /agent +opencode/);
  assert.match(text, / install /);
  assert.match(text, /npm install --global opencode-ai/);
  assert.equal(ui.agents.currentField(), 'agent');
  press(ui, 'down');
  assert.equal(ui.agents.currentField(), 'install');
  press(ui, 'down', 'down');
  assert.equal(ui.agents.currentField(), 'task');
});

test('the hotkeys are in the table, the footer keeps the start', async (t) => {
  const { env, ui } = await openAgents(t, 'claude-agent-acp');
  await showAgents(ui, env);
  ui.color = true;
  ui.draw();
  const hot = seq(THEME.buttonHotFg, THEME.ctxBg);
  for (const label of ['model', 'effort', 'fast', 'plan']) {
    const row = labelRow(ui.lastFrame.rows, label);
    assert.ok(row.includes(hot), label);
  }
  const statusRow = labelRow(ui.lastFrame.rows, 'Status');
  assert.equal(statusRow.includes(hot), false);
  const ids = ui.lastFrame.buttons.map((button) => button.id);
  assert.deepEqual(
    ids.filter((id) => id.startsWith('agent')),
    ['agentStart'],
  );
});

test('the install button is clicked or pressed with i', async (t) => {
  const { env, ui } = await openAgents(t, 'cursor-agent');
  await showAgents(ui, env);
  ui.nav.agentCursor = AGENTS.findIndex((spec) => spec.id === 'opencode');
  ui.color = true;
  ui.draw();
  const hit = ui.lastFrame.fileHits.find((h) => h.field === 'install');
  assert.ok(hit);
  assert.equal(hit.x1 - hit.x0, ' install '.length);
  const row = ui.lastFrame.rows[hit.y - 1];
  assert.ok(row.includes(seq(THEME.buttonHotFg, THEME.buttonBg)));
  click(ui, hit.x0 + 2, hit.y);
  assert.equal(ui.mode, 'confirmAgentInstall');
  assert.equal(ui.view().agentInstallPackage, 'opencode-ai');
  press(ui, 'n');
  assert.equal(ui.mode, 'review');
  press(ui, 'i');
  assert.equal(ui.mode, 'confirmAgentInstall');
  press(ui, 'n');
  click(ui, hit.x1 + 5, hit.y);
  assert.equal(ui.mode, 'review');
});

test('the task box types, adds lines, and starts the run', async (t) => {
  const { env, ui } = await openAgents(t, 'claude-agent-acp');
  await showAgents(ui, env);
  ui.stdout.rows = 30;
  press(ui, 'down', 'down', 'down', 'down', 'down');
  assert.equal(ui.agents.currentField(), 'task');
  typeInto(ui, 'make a test plan is');
  assert.equal(ui.agents.pick, null);
  assert.equal(ui.agents.task.text, 'make a test plan is');
  press(ui, 'shift-enter');
  typeInto(ui, 'ok');
  press(ui, 'ctrl-enter', 'shift-left', 'shift-left');
  assert.equal(ui.agents.task.text, 'make a test plan is\nok\n');
  assert.equal(ui.agents.jobs.length, 0);
  ui.draw();
  const text = stripAnsi(ui.lastFrame.rows.join('\n'));
  assert.match(text, /make a test plan is/);
  assert.equal(text.includes('Text typed here'), false);
  assert.ok(ui.lastFrame.cursor);
  const calls = [];
  ui.agents.spawn = (cwd, launch) => {
    calls.push(launch);
    return { kill() {} };
  };
  press(ui, 'end', 'enter');
  assert.equal(calls.length, 1);
  const [launch] = calls;
  // The text comes first, then the plan the agent is told to execute
  assert.match(launch.plan, /^\.plan\/.+\.md$/);
  assert.equal(launch.task, 'make a test plan is\nok');
  const head = 'make a test plan is\nok\n\nRead and execute repair plan at ';
  assert.equal(launch.prompt.startsWith(`${head}${launch.plan}\n\n`), true);
  assert.match(launch.prompt, /You are running unattended/);
  assert.match(launch.command, /^claude .*\.plan\//);
  assert.equal(ui.agents.task.text, '');
  assert.equal(ui.agents.jobs[0].task, launch.task);
  assert.equal(ui.agents.jobs[0].title, 'make a test plan is');
  const record = ui.agents.jobs[0].record();
  assert.equal(record.task, launch.task);
  assert.equal(record.plan, launch.plan);
});

test('a run of a typed task is repeated with the same task', async (t) => {
  const { env, ui } = await openAgents(t, 'claude-agent-acp');
  await showAgents(ui, env);
  const calls = [];
  let close = null;
  ui.agents.spawn = (cwd, launch, onData, onClose) => {
    calls.push(launch);
    close = onClose;
    return { kill() {} };
  };
  ui.agents.task.insert('rename the helper');
  ui.agents.start();
  assert.equal(calls.length, 1);
  close({ status: 0, text: 'done\n' });
  press(ui, 'r');
  assert.equal(calls.length, 2);
  assert.equal(calls[1].task, 'rename the helper');
  assert.equal(calls[1].prompt, calls[0].prompt);
  assert.equal(calls[1].plan, calls[0].plan);
});

test('a dropped list is as wide as its combo, a click closes', async (t) => {
  const { env, ui } = await openAgents(t, 'claude-agent-acp');
  await showAgents(ui, env);
  ui.stdout.rows = 30;
  ui.draw();
  const rowText = (label) => stripAnsi(labelRow(ui.lastFrame.rows, label));
  const closed = rowText('model');
  assert.equal(closed.includes('▾'), false);
  const start = closed.indexOf('sonnet') - 1;
  press(ui, 'm');
  ui.draw();
  const menu = ui.lastFrame.fileHits.filter((hit) => hit.field === 'menu');
  assert.ok(menu.length > 1);
  // The combo box is 40 columns wide here
  for (const hit of menu) {
    assert.equal(hit.x0, start);
    assert.equal(hit.x1, start + 40);
  }
  const open = ui.lastFrame.fileHits.find((hit) => hit.field === 'model');
  click(ui, open.x0 + 3, open.y);
  assert.equal(ui.agents.pick, null);
  click(ui, open.x0 + 3, open.y);
  assert.equal(ui.agents.pick.field, 'model');
  click(ui, open.x0 + 3, open.y);
  assert.equal(ui.agents.pick, null);
});

test('the caret shows in the task box while it has the cursor', async (t) => {
  const { env, ui, stdout } = await openAgents(t, 'claude-agent-acp');
  await showAgents(ui, env);
  ui.stdout.rows = 30;
  ui.draw();
  const since = (mark) => stdout.dump().slice(mark);
  let mark = stdout.dump().length;
  press(ui, 'down', 'down', 'down', 'down', 'down');
  ui.draw();
  assert.ok(since(mark).includes('\x1b[?25h'));
  mark = stdout.dump().length;
  press(ui, 'up');
  ui.draw();
  assert.equal(since(mark).includes('\x1b[?25h'), false);
  assert.ok(since(mark).includes('\x1b[?25l'));
});

test('fast shows on and off and marks the set one inverted', async (t) => {
  const { env, ui } = await openAgents(t, 'claude-agent-acp');
  await showAgents(ui, env);
  ui.color = true;
  ui.draw();
  const fast = () => labelRow(ui.lastFrame.rows, 'fast');
  assert.match(stripAnsi(fast()), /fast mode +on +off/);
  const set = seq(THEME.noteBg, THEME.chromeFg);
  const plain = seq(THEME.chromeFg, THEME.noteBg);
  const at = (row, mark) => row.indexOf(mark);
  assert.ok(at(fast(), set) > at(fast(), plain));
  assert.ok(at(fast(), plain) >= 0);
  press(ui, 'o');
  ui.draw();
  // the field under the cursor has the colors of a selection
  const hot = seq(THEME.popupBg, THEME.popupFg);
  const rest = seq(THEME.popupFg, THEME.popupBg);
  assert.ok(at(fast(), hot) >= 0);
  assert.ok(at(fast(), hot) < at(fast(), rest));
});

test('agent progress stays compact with yellow and grey parts', async (t) => {
  const { env, ui, repo } = await openAgents(t, 'claude-agent-acp');
  const reviewDir = path.join(repo.dir, '.plan');
  fs.mkdirSync(reviewDir, { recursive: true });
  const name = '2020-01-01-00.md';
  const body = '---\nstatus: editing\n---\n\n> a.js\n\n- [x] one\n- [ ] two\n';
  fs.writeFileSync(path.join(reviewDir, name), body);
  ui.review.store.reviewPath = '';
  await showAgents(ui, env);
  ui.agents.planPath = path.join(reviewDir, name);
  ui.color = true;
  ui.draw();
  for (const [width, leftW] of [
    [60, 42],
    [80, 56],
    [160, 112],
    [240, 168],
  ]) {
    ui.stdout.columns = width;
    for (const done of [0, 1, 2]) {
      const checks = ['one', 'two'].map(
        (text, index) => `- [${index < done ? 'x' : ' '}] ${text}`,
      );
      fs.writeFileSync(
        path.join(reviewDir, name),
        `---\nstatus: editing\n---\n\n> a.js\n\n${checks.join('\n')}\n`,
      );
      ui.draw();
      const row = labelRow(ui.lastFrame.rows, 'Status');
      const plain = stripAnsi(row).slice(0, leftW);
      assert.match(plain, new RegExp(`Status +editing +${done}/2 ─+ *$`));
      const barW = /─+/.exec(plain)[0].length;
      assert.ok(barW <= 26);
      if (width >= 80) {
        assert.equal(barW, 26);
        assert.ok(plain.endsWith(' '));
      }
      const on = Math.round((done / 2) * barW);
      if (on) {
        const yellow = seq(THEME.warnFg, THEME.ctxBg);
        assert.ok(row.includes(`${yellow}${'─'.repeat(on)}${RESET}`));
      }
      if (barW > on) {
        const grey = seq(THEME.heatTrack, THEME.ctxBg);
        assert.ok(row.includes(`${grey}${'─'.repeat(barW - on)}${RESET}`));
      }
    }
  }
});

test('the table marks hotkeys and unset settings say default', async (t) => {
  const { env, ui } = await openAgents(t, 'cursor-agent');
  // A model with every setting: effort, context size, and fast mode
  const variants = [];
  for (const context of ['272k', '1m']) {
    for (const effort of ['low', 'high']) {
      for (const fast of ['false', 'true']) {
        const id = `context=${context},reasoning=${effort},fast=${fast}`;
        variants.push(`gpt-5[${id}]`);
      }
    }
  }
  const state = acpState({ models: variants });
  ui.agents.listModels = async () => state;
  ui.agents.refresh(env);
  await ui.agents.open();
  ui.nav.agentCursor = AGENTS.findIndex((spec) => spec.id === 'cursor');
  ui.stdout.rows = 30;
  ui.color = true;
  ui.draw();
  const hot = seq(THEME.buttonHotFg, THEME.ctxBg);
  const letterOf = (label) => {
    const row = labelRow(ui.lastFrame.rows, label);
    const at = row.indexOf(hot);
    return stripAnsi(row.slice(at + hot.length)).trimStart()[0];
  };
  const caption = (label, letter) => {
    const row = stripAnsi(labelRow(ui.lastFrame.rows, label));
    assert.match(row, new RegExp(`^ +${label}`));
    assert.equal(letterOf(label), letter, label);
  };
  caption('agent', 'a');
  caption('model', 'm');
  caption('effort', 'e');
  caption('fast mode', 'o');
  caption('context', 'x');
  caption('plan', 'p');
  press(ui, 'a');
  assert.equal(ui.agents.pick.field, 'agent');
  press(ui, 'escape');
  ui.draw();
  const fast = stripAnsi(labelRow(ui.lastFrame.rows, 'fast mode'));
  assert.match(fast, /on {2}off/);
  // Before the agent has listed anything an unset model is the default
  ui.agents.reset();
  ui.agents.refresh(env);
  ui.agents.listModels = async () => null;
  await ui.agents.open();
  ui.draw();
  assert.match(stripAnsi(labelRow(ui.lastFrame.rows, 'model')), /default/);
  for (const label of ['effort', 'fast mode', 'context']) {
    assert.equal(labelRow(ui.lastFrame.rows, label), undefined, label);
  }
});

test('s starts, resumes, or stops by the selected session', async (t) => {
  const { env, ui } = await openAgents(t, 'claude-agent-acp');
  await showAgents(ui, env);
  ui.stdout.rows = 30;
  const footer = () => {
    ui.draw();
    return stripAnsi(ui.lastFrame.rows.at(-1));
  };
  assert.match(footer(), /start/);
  const killed = [];
  ui.agents.spawn = () => ({ kill: () => killed.push('child') });
  press(ui, 's', 'escape');
  assert.equal(ui.agents.jobs.length, 1);
  const live = ui.agents.jobs[0];
  live.session = '2fa698ba-9a19-4a84-8134-5a7cd9ec2c56';
  ui.agents.focusRuns();
  const rows = ui.agents.sessionRows();
  ui.agents.runCursor = rows.findIndex((row) => row.status === 'running');
  assert.equal(ui.view().agentStartMode, 'stop');
  assert.match(footer(), /stop/);
  press(ui, 's');
  assert.deepEqual(killed, ['child']);
  assert.equal(live.status, 'stopped');
  assert.equal(ui.status, 'stopped');
  assert.equal(ui.agents.jobs.length, 1);
  ui.agents.runCursor = ui.agents.sessionRows().findIndex((row) => row.id);
  assert.equal(ui.view().agentStartMode, 'resume');
  assert.match(footer(), /resume/);
});

test('the text goes before the plan, no text sends the plan alone', () => {
  const row = rowOf(specOf('claude'));
  const picked = emptyChoice();
  const plan = '.plan/2026-10-16-02.md';
  const alone = buildLaunch(row, picked, plan, '/repo');
  assert.equal(alone.prompt, planPrompt(plan));
  const blank = buildLaunch(row, picked, plan, '/repo', '', '  \n ');
  assert.equal(blank.prompt, planPrompt(plan));
  const typed = buildLaunch(row, picked, plan, '/repo', '', 'fix the loop');
  assert.equal(typed.prompt, `fix the loop\n\n${planPrompt(plan)}`);
  assert.equal(typed.plan, plan);
  const noPlan = buildLaunch(row, picked, '', '/repo', '', 'fix the loop');
  assert.equal(noPlan.ok, true);
  assert.match(noPlan.prompt, /^fix the loop\n\nYou are running/);
  assert.equal(buildLaunch(row, picked, '', '/repo').error, 'no plan');
});

test('none in the plan combo runs the agent without a plan file', async (t) => {
  const { env, ui } = await openAgents(t, 'claude-agent-acp');
  await showAgents(ui, env);
  const calls = [];
  ui.agents.spawn = (cwd, launch) => {
    calls.push(launch);
    return { kill() {} };
  };
  press(ui, 'p');
  assert.equal(ui.agents.pick.field, 'plan');
  assert.equal(ui.agents.menuItems()[0], 'none');
  press(ui, 'up', 'up', 'up', 'enter');
  assert.equal(ui.agents.pick, null);
  assert.equal(ui.agents.planFile(), '');
  assert.equal(ui.status, 'plan none');
  ui.draw();
  const text = stripAnsi(ui.lastFrame.rows.join('\n'));
  assert.match(text, /plan +none/);
  ui.agents.start();
  assert.equal(calls.length, 0);
  assert.equal(ui.status, 'no plan');
  ui.agents.task.insert('check the build');
  ui.agents.start();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].plan, '');
  assert.match(calls[0].prompt, /^check the build\n\nYou are running/);
  assert.equal(calls[0].prompt.includes('repair plan'), false);
  press(ui, 'escape', 'p');
  assert.equal(ui.agents.pick.cursor, 0);
  press(ui, 'down', 'enter');
  assert.notEqual(ui.agents.planFile(), '');
});

test('the prompt keeps the panel color, the sessions are black', async (t) => {
  const { env, ui } = await openAgents(t, 'claude-agent-acp');
  await showAgents(ui, env);
  ui.agents.spawn = () => ({ kill() {} });
  ui.stdout.rows = 30;
  ui.color = true;
  ui.agents.start();
  press(ui, 'escape', 'down', 'down', 'down', 'down', 'down');
  assert.equal(ui.agents.currentField(), 'task');
  const grey = bg(THEME.buttonBg);
  const dark = bg(THEME.ctxBg);
  ui.draw();
  const empty = ui.lastFrame.editHits.find((h) => h.editor);
  const emptyRow = ui.lastFrame.rows[empty.y - 1];
  typeInto(ui, 'hello there');
  ui.draw();
  const typed = ui.lastFrame.rows[empty.y - 1];
  for (const row of [emptyRow, typed]) {
    const right = row.slice(row.indexOf(grey));
    assert.equal(right.includes(dark), false);
    assert.equal(right.includes(bg(THEME.popupBg)), false);
  }
  assert.ok(stripAnsi(typed).includes('hello there'));
  const session = ui.lastFrame.rows.find((row) => row.includes('running'));
  assert.ok(session);
  const left = session.slice(0, session.indexOf(grey));
  assert.ok(left.includes('running'));
  assert.ok(left.includes(dark));
});

test('the session of the last run is selected on load', async (t) => {
  const { env, ui, repo } = await openAgents(
    t,
    'cursor-agent',
    'claude-agent-acp',
  );
  const plan = path.join(repo.dir, '.plan');
  fs.mkdirSync(plan, { recursive: true });
  const run = (id, startedAt, name) => ({
    id,
    cliId: 'cursor',
    name: 'cursor',
    model: 'grok',
    command: `cursor ${name}`,
    plan: '.plan/a.md',
    action: 'run',
    exit: 0,
    elapsed: 1,
    startedAt,
    session: `aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa${id}`,
    log: `${name}.log`,
    output: '',
  });
  const recorded = [run(1, 1, 'cursor-old'), run(2, 2, 'cursor-new')];
  const file = path.join(plan, '.runs');
  fs.writeFileSync(file, `${JSON.stringify(recorded, null, 2)}\n`);
  ui.agents.listModels = listed;
  ui.agents.refresh(env);
  ui.agents.loadRuns();
  await ui.agents.open();
  ui.nav.agentCursor = ui.agents.rows().findIndex((r) => r.id === 'cursor');
  ui.agents.selectLastSession();
  assert.equal(ui.agents.runCursor, 1);
  assert.equal(ui.agents.selectedSession().name, 'cursor-new');
  assert.equal(ui.view().agentStartMode, 'resume');
  // An agent without sessions starts a new one
  ui.agents.chooseAgent(ui.agents.rows().findIndex((r) => r.id === 'claude'));
  assert.equal(ui.agents.runCursor, 0);
  assert.equal(ui.agents.selectedSession().fresh, true);
  assert.equal(ui.view().agentStartMode, 'start');
  ui.agents.chooseAgent(ui.agents.rows().findIndex((r) => r.id === 'cursor'));
  assert.equal(ui.agents.selectedSession().name, 'cursor-new');
});

test('the scroller column of the sessions is black', async (t) => {
  const { env, ui } = await openAgents(t, 'claude-agent-acp');
  await showAgents(ui, env);
  ui.stdout.rows = 30;
  ui.color = true;
  ui.agents.runCursor = 0;
  ui.draw();
  const grey = bg(THEME.buttonBg);
  const rows = ui.lastFrame.rows.filter((row) => row.includes('<start'));
  assert.equal(rows.length, 1);
  const left = rows[0].slice(0, rows[0].indexOf(grey));
  // The last cell of the left panel is the scroller column
  const selected = `${seq(THEME.chromeFg, THEME.checkBg)} `;
  assert.ok(left.length - left.lastIndexOf(selected) < 80);
  const spare = ui.lastFrame.rows.at(-4);
  const edge = spare.slice(0, spare.indexOf(grey));
  const black = `${seq(THEME.chromeFg, THEME.ctxBg)} `;
  assert.ok(edge.length - edge.lastIndexOf(black) < 80);
  assert.equal(edge.includes(grey), false);
});

test('a double click in the prompt selects a word, three a line', async (t) => {
  const { env, ui } = await openAgents(t, 'claude-agent-acp');
  await showAgents(ui, env);
  ui.stdout.rows = 30;
  ui.agents.task.insert('alpha beta\nsecond line');
  ui.draw();
  const rows = ui.lastFrame.editHits.filter((h) => h.editor);
  const first = rows.find((hit) => hit.text === 'alpha beta');
  const second = rows.find((hit) => hit.text === 'second line');
  const task = ui.agents.task;
  click(ui, first.textX + 7, first.y);
  assert.equal(task.hasSelect(), false);
  assert.equal(task.cursor, 7);
  click(ui, first.textX + 7, first.y);
  assert.equal(task.selectedText(), 'beta');
  click(ui, first.textX + 7, first.y);
  assert.equal(task.selectedText(), 'alpha beta');
  click(ui, first.textX + 7, first.y);
  assert.equal(task.hasSelect(), false);
  // another place starts the count again
  click(ui, second.textX + 1, second.y);
  click(ui, second.textX + 1, second.y);
  assert.equal(task.selectedText(), 'second');
  click(ui, second.textX + 1, second.y);
  assert.equal(task.selectedText(), 'second line');
  assert.equal(ui.agents.currentField(), 'task');
});

test('the prompt has the context menu of a text area', async (t) => {
  const { env, ui } = await openAgents(t, 'claude-agent-acp');
  await showAgents(ui, env);
  ui.stdout.rows = 30;
  ui.agents.task.insert('hello world');
  ui.draw();
  const hit = ui.lastFrame.editHits.find((h) => h.editor);
  click(ui, hit.textX + 8, hit.y);
  click(ui, hit.textX + 8, hit.y);
  assert.equal(ui.agents.task.selectedText(), 'world');
  rightClick(ui, hit.textX + 8, hit.y);
  const menu = ui.nav.contextMenu;
  assert.ok(menu);
  assert.equal(menu.editor, ui.agents.task);
  assert.ok(menu.actions.includes('textCopy'));
  assert.ok(menu.actions.includes('textCut'));
  assert.equal(ui.agents.currentField(), 'task');
  assert.equal(ui.agents.task.selectedText(), 'world');
  press(ui, 'ctrl-c');
  assert.equal(ui.nav.contextMenu, null);
  assert.equal(clipboard.pasteText(), 'world');
  rightClick(ui, hit.textX + 8, hit.y);
  press(ui, 'ctrl-x');
  assert.equal(ui.agents.task.text, 'hello ');
  rightClick(ui, hit.textX + 2, hit.y);
  press(ui, 'ctrl-a');
  assert.equal(ui.agents.task.selectedText(), 'hello ');
});

test('space and the arrows set the fast mode', async (t) => {
  const { env, ui } = await openAgents(t, 'claude-agent-acp');
  await showAgents(ui, env);
  const fast = () => ui.agents.rows()[0].fast;
  press(ui, 'down', 'down', 'down');
  assert.equal(ui.agents.currentField(), 'fast');
  assert.equal(fast(), 'off');
  press(ui, ' ');
  assert.equal(fast(), 'on');
  press(ui, ' ');
  assert.equal(fast(), 'off');
  press(ui, 'left');
  assert.equal(fast(), 'on');
  press(ui, 'left');
  assert.equal(fast(), 'on');
  press(ui, 'right');
  assert.equal(fast(), 'off');
  press(ui, 'right');
  assert.equal(fast(), 'off');
  assert.equal(ui.agents.focus, 'cli');
  // elsewhere the arrows still move between the table and the sessions
  press(ui, 'up');
  assert.equal(ui.agents.currentField(), 'effort');
  press(ui, 'right');
  assert.equal(ui.agents.focus, 'runs');
});

test('a focused combo and its selected item differ in color', async (t) => {
  const { env, ui } = await openAgents(t, 'claude-agent-acp');
  await showAgents(ui, env);
  ui.stdout.rows = 30;
  ui.color = true;
  press(ui, 'm');
  ui.draw();
  const model = labelRow(ui.lastFrame.rows, 'model');
  assert.ok(model.includes(bg(THEME.popupBg)));
  assert.equal(model.includes(bg(THEME.checkBg)), false);
  const hits = ui.lastFrame.fileHits.filter((h) => h.field === 'menu');
  hits.sort((left, right) => left.y - right.y);
  const first = ui.lastFrame.rows[hits[0].y - 1];
  assert.ok(first.includes(bg(THEME.checkBg)));
  assert.equal(first.includes(bg(THEME.popupBg)), false);
  assert.notDeepEqual(THEME.popupBg, THEME.checkBg);
});

// A listing that reports whether the agent let a session open
const listedAs = (state) => async (row, options) => {
  if (state && options.auth) options.auth.state = state;
  if (state === 'out') return null;
  return STATES[row.id] ?? null;
};

const accountOf = (ui) => {
  ui.draw();
  const text = stripAnsi(labelRow(ui.lastFrame.rows, 'account'));
  // The left panel of an 80 column screen
  return text
    .slice(0, 56)
    .trim()
    .replace(/^account\s+/, '');
};

test('the screen shows whether the selected agent is signed in', async (t) => {
  const { env, ui } = await openAgents(t, 'claude-agent-acp');
  ui.stdout.rows = 30;
  ui.agents.refresh(env);
  ui.agents.listModels = listedAs('');
  await ui.agents.open();
  assert.match(accountOf(ui), /^unknown\s*$/);
  assert.equal(
    ui.lastFrame.fileHits.some((hit) => hit.field === 'auth'),
    false,
  );
  ui.agents.reset();
  ui.agents.refresh(env);
  ui.agents.listModels = listedAs('in');
  await ui.agents.open();
  assert.match(accountOf(ui), /^logged in\s+logout\s*$/);
  const lines = stripAnsi(ui.lastFrame.rows.join('\n')).split('\n');
  assert.match(
    lines.find((line) => /^ +account /.test(line)),
    /logged in {6}logout/,
  );
  // It is under the settings, where a missing agent shows its install
  const at = (label) =>
    lines.findIndex((l) => new RegExp(`^ +${label} `).test(l));
  assert.equal(at('account'), at('fast mode') + 2);
  assert.equal(at('plan'), at('account') + 2);
  ui.agents.reset();
  ui.agents.refresh(env);
  ui.agents.listModels = listedAs('out');
  await ui.agents.open();
  assert.match(accountOf(ui), /^not logged in\s+login\s*$/);
  const hit = ui.lastFrame.fileHits.find((entry) => entry.field === 'auth');
  assert.equal(hit.x1 - hit.x0, ' login '.length);
  // An agent that is not installed has no account to show
  ui.nav.agentCursor = 1;
  ui.draw();
  assert.equal(labelRow(ui.lastFrame.rows, 'account'), undefined);
});

test('the agent signs in on a proposal that is accepted', async (t) => {
  const { env, ui } = await openAgents(t, 'claude-agent-acp');
  ui.stdout.rows = 30;
  ui.agents.refresh(env);
  let listings = 0;
  const out = listedAs('out');
  ui.agents.listModels = async (row, options) => {
    listings += 1;
    return listings > 1 ? listedAs('in')(row, options) : out(row, options);
  };
  const asked = [];
  let finish = null;
  ui.agents.signIn = (row) => {
    asked.push(row.id);
    return new Promise((resolve) => {
      finish = resolve;
    });
  };
  await ui.agents.open();
  press(ui, 'l');
  assert.equal(ui.mode, 'confirmAgentAuth');
  assert.equal(ui.view().agentAuthAsk, 'sign in to claude');
  ui.draw();
  assert.match(stripAnsi(ui.lastFrame.rows.at(-2)), /sign in to claude\? y\/n/);
  press(ui, 'n');
  assert.equal(ui.mode, 'review');
  assert.equal(asked.length, 0);
  const hit = ui.lastFrame.fileHits.find((entry) => entry.field === 'auth');
  click(ui, hit.x0 + 2, hit.y);
  assert.equal(ui.mode, 'confirmAgentAuth');
  press(ui, 'y');
  assert.equal(ui.mode, 'review');
  assert.deepEqual(asked, ['claude']);
  assert.equal(ui.status, 'signing in to claude…');
  assert.match(accountOf(ui), /^signing in…/);
  // While it goes on another proposal waits
  press(ui, 'l');
  assert.equal(ui.mode, 'review');
  finish({ ok: true });
  await settle();
  await settle();
  assert.equal(ui.status, 'signed in to claude');
  assert.match(accountOf(ui), /^logged in\s+logout\s*$/);
  // The models the agent refused to list are asked for again
  assert.equal(listings, 2);
  assert.equal(ui.agents.rows()[0].model, 'sonnet');
});

test('a failed sign-out leaves the account as it was', async (t) => {
  const { env, ui } = await openAgents(t, 'claude-agent-acp');
  ui.stdout.rows = 30;
  ui.agents.refresh(env);
  ui.agents.listModels = listedAs('in');
  const answers = [
    { ok: false, error: 'sign out in the CLI of the agent' },
    { ok: true },
  ];
  ui.agents.signOut = async () => answers.shift();
  await ui.agents.open();
  press(ui, 'l');
  assert.equal(ui.view().agentAuthAsk, 'sign out of claude');
  press(ui, 'y');
  await settle();
  assert.equal(ui.status, 'sign out in the CLI of the agent');
  assert.match(accountOf(ui), /^logged in\s+logout\s*$/);
  press(ui, 'l', 'y');
  await settle();
  assert.equal(ui.status, 'signed out of claude');
  assert.match(accountOf(ui), /^not logged in\s+login\s*$/);
  ui.nav.agentCursor = 1;
  press(ui, 'l');
  assert.equal(ui.status, 'not installed');
  assert.equal(ui.mode, 'review');
});

test('an agent that is being asked shows loading, not unknown', async (t) => {
  const { env, ui } = await openAgents(t, 'claude-agent-acp');
  ui.stdout.rows = 30;
  ui.agents.refresh(env);
  let answer = null;
  ui.agents.listModels = (row, options) =>
    new Promise((resolve) => {
      answer = () => {
        options.auth.state = 'in';
        resolve(STATES[row.id]);
      };
    });
  const opening = ui.agents.open();
  assert.match(accountOf(ui), /^loading…\s*$/);
  assert.equal(ui.view().agentAccount.loading, true);
  answer();
  await opening;
  assert.match(accountOf(ui), /^logged in\s+logout\s*$/);
  assert.equal(ui.view().agentAccount.loading, false);
  // A probe that learns nothing leaves it unknown once it is over
  ui.agents.reset();
  ui.agents.refresh(env);
  ui.agents.listModels = async () => null;
  await ui.agents.open();
  assert.match(accountOf(ui), /^unknown\s*$/);
});
