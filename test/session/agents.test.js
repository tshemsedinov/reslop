'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const agents = require('../../lib/agents/agents.js');
const { emptyChoice, AGENTS } = agents;
const { modelChange } = agents;
const { press, click } = require('../helpers.js');
const render = require('../../lib/render/render.js');
const { renderFrame } = render;
const ansi = require('../../lib/term/ansi.js');
const { stripAnsi, THEME, bg, RESET, seq } = ansi;
const { setImmediate: settle } = require('node:timers/promises');
const agentsHelpers = require('../agents-helpers.js');
const { makeBin, labelRow, acpState, CLAUDE_STATE } = agentsHelpers;
const { CURSOR_STATE, listed, openAgents, showAgents } = agentsHelpers;

test('agents screen lists agents and starts on the review plan', async (t) => {
  const { bins, env, ui } = await openAgents(t, 'claude-agent-acp');
  await showAgents(ui, env);
  assert.equal(ui.pane, 'agents');
  const rows = ui.agents.rows();
  assert.equal(rows[0].bin, bins['claude-agent-acp']);
  assert.equal(rows[0].model, 'sonnet');
  assert.equal(rows[0].effort, 'medium');
  assert.equal(rows[0].fast, 'off');
  assert.equal(ui.agents.choice('claude').model, '');
  assert.equal(rows[1].bin, '');
  ui.draw();
  const text = stripAnsi(ui.lastFrame.rows.join('\n'));
  assert.match(text, /agent +claude/);
  for (const label of ['model', 'effort', 'fast', 'plan']) {
    assert.ok(text.includes(label), label);
  }
  assert.match(text, /Status +editing/);
  assert.match(text, /Status +editing +\d+\/\d+/);
  assert.match(text, /Text typed here/);
  assert.equal(text.includes('▶'), false);
  assert.equal(text.includes('install'), false);
  assert.equal(text.includes(bins['claude-agent-acp']), false);
  assert.match(render.headerText(ui.view()), /agents/);
  press(ui, 'm');
  assert.equal(ui.agents.pick.field, 'model');
  assert.match(render.headerText(ui.view()), /agents$/);
  ui.draw();
  const menu = stripAnsi(ui.lastFrame.rows.join('\n'));
  assert.match(menu, /sonnet/);
  assert.deepEqual(ui.agents.menuItems(), ['sonnet', 'opus', 'haiku']);
  press(ui, 'enter');
  assert.equal(ui.agents.pick, null);
  assert.equal(ui.agents.choice('claude').model, 'sonnet');
  ui.draw();
  const after = stripAnsi(ui.lastFrame.rows.join('\n'));
  assert.match(after, /plan +\d{4}-\d{2}-\d{2}-\d+\.md/);
  assert.match(after, /Status +editing/);
  assert.equal(after.includes('default'), false);
  assert.equal(after.includes('claude-agent-acp'), false);
  press(ui, 'e');
  assert.equal(ui.agents.pick.field, 'effort');
  assert.deepEqual(ui.agents.menuItems(), ['low', 'medium', 'high', 'max']);
  press(ui, 'enter');
  assert.equal(ui.agents.choice('claude').effort, 'medium');
  ui.draw();
  const picked = stripAnsi(ui.lastFrame.rows.join('\n'));
  assert.match(picked, /agent +claude/);
  assert.match(picked, /model +sonnet/);
  assert.match(picked, /effort +medium/);
  assert.match(picked, /fast mode +on +off/);
  const calls = [];
  ui.agents.spawn = (cwd, launch, onData) => {
    calls.push({ cwd, launch });
    onData('hello\n');
    return { kill() {} };
  };
  press(ui, 's');
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
  press(ui, 'escape');
  assert.equal(ui.agents.viewing, false);
  assert.equal(ui.agents.jobs[0].status, 'running');
  ui.nav.agentCursor = 1;
  ui.agents.start();
  assert.equal(ui.status, 'not installed');
  assert.equal(calls.length, 1);
  ui.nav.agentCursor = 0;
  const view = ui.view();
  const frame = renderFrame(view, { width: 80, height: 24, color: false });
  const ids = frame.buttons.map((hit) => hit.id);
  assert.ok(ids.includes('agentStart'));
  for (const id of ['agentModel', 'agentEffort', 'agentFast']) {
    assert.equal(ids.includes(id), false, id);
  }
  const footer = stripAnsi(frame.rows.at(-1));
  assert.equal(footer.includes('stop'), false);
  assert.equal(footer.includes('model'), false);
});

test('agent jobs keep running after leaving the log', async (t) => {
  const { env, ui, repo } = await openAgents(
    t,
    'claude-agent-acp',
    'cursor-agent',
  );
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
  press(ui, 'escape');
  assert.equal(ui.agents.jobs[0].status, 'running');
  ui.agents.start();
  assert.equal(ui.agents.jobs.length, 1);
  assert.equal(ui.agents.viewing, true);
  press(ui, 'escape');
  ui.nav.agentCursor = 2;
  ui.agents.start();
  assert.equal(ui.agents.jobs.length, 1);
  assert.equal(ui.status, `busy ${path.basename(ui.agents.planFile())}`);
  press(ui, 'p', 'enter');
  ui.agents.start();
  assert.equal(ui.agents.jobs.length, 2);
  assert.equal(ui.agents.rows().length, clis);
  assert.equal(ui.agents.runningCount(), 2);
  press(ui, 'escape', 's');
  assert.equal(killed.length, 0);
  press(ui, 'enter', 's');
  assert.equal(killed.length, 1);
  assert.equal(ui.agents.runningCount(), 1);
  const live = ui.agents.jobs.filter((job) => job.status === 'running');
  assert.equal(live.length, 1);
  assert.equal(live[0].name, 'claude');
});

test('r in the agent log repeats the command', async (t) => {
  const { env, ui } = await openAgents(t, 'claude-agent-acp');
  await showAgents(ui, env);
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
  press(ui, 'r');
  assert.equal(calls.length, 1);
  close({ status: 0, text: 'done\n' });
  press(ui, 'r');
  assert.equal(calls.length, 2);
  assert.equal(calls[1].command, calls[0].command);
  press(ui, 'escape', 'r');
  assert.equal(calls.length, 2);
});

test('agents screen offers the efforts the agent lists', async (t) => {
  const { env, ui } = await openAgents(t, 'claude-agent-acp', 'codex-acp');
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
    ['claude', ui.top],
    ['codex', ui.top],
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
});

test('a saved choice survives until the agent lists its models', async (t) => {
  const { env, ui, repo } = await openAgents(t, 'claude-agent-acp');
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
});

test('an agent that lists nothing runs with its own defaults', async (t) => {
  const { env, ui } = await openAgents(t, 'claude-agent-acp');
  ui.agents.listModels = async () => {
    throw new Error('probe failed');
  };
  ui.agents.refresh(env);
  await ui.agents.open();
  const row = ui.agents.rows()[0];
  assert.equal(row.model, '');
  assert.deepEqual(row.efforts, []);
  press(ui, 'm');
  assert.equal(ui.agents.pick, null);
  const calls = [];
  ui.agents.spawn = (cwd, launch) => {
    calls.push(launch);
    return { kill() {} };
  };
  ui.agents.start();
  assert.deepEqual(calls[0].choice, emptyChoice());
});

test('agents screen picks a model from the list', async (t) => {
  const { env, ui } = await openAgents(t, 'cursor-agent');
  await showAgents(ui, env);
  ui.nav.agentCursor = 2;
  const row = ui.agents.selected();
  assert.equal(row.id, 'cursor');
  assert.equal(row.name, 'cursor');
  assert.equal(ui.agents.rows()[2].model, 'default');
  press(ui, 'm');
  assert.ok(ui.agents.menuItems().includes('default'));
  press(ui, 'g', 'r', 'o', 'k', 'enter');
  assert.equal(ui.agents.choice('cursor').model, 'grok-4.6');
  assert.equal(ui.agents.selected().name, 'cursor');
  const picked = ui.agents.rows()[2];
  assert.equal(picked.effort, 'high');
  assert.equal(picked.fast, 'on');
  ui.draw();
  const text = stripAnsi(ui.lastFrame.rows.join('\n'));
  assert.match(text, /agent +cursor/);
  assert.match(text, /model +grok-4\.6/);
  assert.match(text, /effort +high/);
  // A fast mode that the model fixes is not a switch
  assert.equal(text.includes('fast mode'), false);
  assert.match(text, /\d{4}-\d{2}-\d{2}-\d+\.md/);
  assert.equal(text.includes('cursor-agent'), false);
  assert.equal(text.includes('effort='), false);
  press(ui, 'e');
  assert.equal(ui.agents.pick, null);
  press(ui, 'o');
  assert.equal(ui.agents.choice('cursor').fast, false);
  assert.equal(ui.status, 'fast on');
});

test('agents screen restores the last selected agent', async (t) => {
  const { env, ui, repo } = await openAgents(
    t,
    'claude-agent-acp',
    'cursor-agent',
  );
  ui.agents.refresh(env);
  await ui.agents.open();
  const cursor = ui.agents.list.findIndex((row) => row.id === 'cursor');
  ui.agents.chooseAgent(cursor);

  const saved = JSON.parse(fs.readFileSync(path.join(repo.dir, '.reslop')));
  assert.equal(saved.lastAgent, 'cursor');

  ui.agents.reset();
  ui.agents.refresh(env);
  await ui.agents.open();
  assert.equal(ui.agents.selected().id, 'cursor');
});

test('start falls back to the latest review file', async (t) => {
  const { env, ui, repo } = await openAgents(t, 'claude-agent-acp');
  const reviewDir = path.join(repo.dir, '.plan');
  fs.mkdirSync(reviewDir, { recursive: true });
  const name = '2020-01-01-00.md';
  fs.writeFileSync(path.join(reviewDir, name), '---\nstatus: editing\n---\n');
  ui.review.store.reviewPath = '';
  await showAgents(ui, env);
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
});

test('agents screen runs the review file chosen in the combo', async (t) => {
  const { env, ui, repo } = await openAgents(t, 'claude-agent-acp');
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
  await showAgents(ui, env);
  press(ui, 'p');
  assert.equal(ui.agents.pick.field, 'plan');
  assert.deepEqual(ui.agents.menuItems(), [
    'none',
    `${newer}  partial  0/0`,
    `${older}  editing  1/2`,
  ]);
  ui.draw();
  const menu = stripAnsi(ui.lastFrame.rows.join('\n'));
  assert.match(menu, /2020-01-02-00\.md {2}partial {2}0\/0/);
  assert.match(menu, /2020-01-01-00\.md {2}editing {2}1\/2/);
  press(ui, 'down', 'enter');
  assert.equal(ui.agents.pick, null);
  ui.draw();
  const text = stripAnsi(ui.lastFrame.rows.join('\n'));
  assert.match(text, new RegExp(`plan +${older}`));
  assert.match(text, /Status +editing/);
  assert.match(text, /Status +editing +1\/2/);
  const calls = [];
  ui.agents.spawn = (cwd, launch) => {
    calls.push(launch);
    return { kill() {} };
  };
  ui.agents.start();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].plan, `.plan/${older}`);
  assert.match(calls[0].command, /\.plan\/2020-01-01-00\.md$/);
});

test('plan combo lists plain markdown and aligns columns', async (t) => {
  const { env, ui, repo } = await openAgents(t, 'claude-agent-acp');
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
  await showAgents(ui, env);
  press(ui, 'p');
  assert.deepEqual(ui.agents.menuItems(), [
    'none',
    `${dated}  partial  0/1`,
    ideas,
    `${'note.md'.padEnd(dated.length)}  editing  1/1`,
  ]);
  press(ui, 'down', 'enter');
  assert.equal(path.basename(ui.agents.planFile()), ideas);
  ui.draw();
  const text = stripAnsi(ui.lastFrame.rows.join('\n'));
  assert.match(text, /ideas\.md/);
  assert.equal(text.includes('ideas.md  editing'), false);
  press(ui, 'p', 'down', 'enter');
  assert.equal(path.basename(ui.agents.planFile()), note);
  assert.equal(ui.agents.planFace(), `${note}  editing  1/1`);
});

test('clicking the model column opens the model list', async (t) => {
  const { env, ui } = await openAgents(t, 'cursor-agent');
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
  click(ui, hit.x0 + 1, hit.y);
  assert.equal(ui.agents.pick.field, 'model');
  ui.draw();
  const text = stripAnsi(ui.lastFrame.rows.join('\n'));
  assert.match(text, /agent +cursor/);
  assert.match(text, /gpt-5\.6-sol/);
  assert.equal(text.includes('effort='), false);
  press(ui, 's', 'o');
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
      (line) => line.includes('model') && /\sso(?:\s|$)/.test(line),
    ),
  );
  press(ui, 'backspace');
  assert.equal(ui.agents.pick.query, 's');
  ui.draw();
  const cleared = stripAnsi(ui.lastFrame.rows.join('\n'));
  assert.equal(showsQuery(cleared, 'so'), false);
  assert.ok(showsQuery(cleared, 's'));
  press(ui, 'o', 'l', 'enter');
  assert.equal(ui.agents.choice('cursor').model, 'gpt-5.6-sol');
  assert.equal(ui.agents.rows()[2].effort, 'high');
  press(ui, 'e');
  assert.deepEqual(ui.agents.menuItems(), ['low', 'high']);
  press(ui, 'up', 'enter');
  assert.equal(ui.agents.choice('cursor').effort, 'low');
});

test('mouse and keyboard share selection in an agent query', async (t) => {
  const { env, ui } = await openAgents(t, 'cursor-agent');
  await showAgents(ui, env);
  const rows = ui.agents.rows();
  ui.nav.agentCursor = rows.findIndex((row) => row.id === 'cursor');
  ui.agents.openPick('model');
  const pick = ui.agents.pick;
  pick.editor.replace('sol');
  pick.touch();
  ui.draw();
  const editor = pick.editor;
  const hit = ui.lastFrame.editHits.find((entry) => entry.editor === editor);
  assert.ok(hit);
  const base = { type: 'mouse', btn: 0, y: hit.y };
  ui.handleEvent({ ...base, kind: 'press', button: 0, x: hit.textX });
  ui.handleEvent({ ...base, kind: 'drag', button: 32, x: hit.textX + 2 });
  ui.handleEvent({ ...base, kind: 'release', button: 0, x: hit.textX + 2 });
  assert.equal(pick.editor.selectedText(), 'so');
  press(ui, 'shift-right');
  assert.equal(pick.editor.selectedText(), 'sol');
  press(ui, 'ctrl-c');
  assert.equal(ui.status, 'copied');
  assert.equal(ui.nav.selection, null);
  assert.equal(ui.agents.pick, pick);
});

test('clicking another column switches the open combo', async (t) => {
  const { env, ui } = await openAgents(t, 'cursor-agent');
  await showAgents(ui, env);
  const at = ui.agents.rows().findIndex((row) => row.id === 'cursor');
  ui.nav.agentCursor = at;
  ui.agents.choice('cursor').model = 'gpt-5';
  ui.draw();
  const clickHit = (hit) => click(ui, hit.x0 + 1, hit.y);
  const model = ui.lastFrame.fileHits.find((entry) => entry.field === 'model');
  assert.ok(model);
  clickHit(model);
  assert.equal(ui.agents.pick.field, 'model');
  press(ui, 'j', 'k');
  assert.equal(ui.agents.pick.query, 'jk');
  assert.equal(ui.agents.pick.cursor, 0);
  ui.draw();
  const effort = ui.lastFrame.fileHits.find(
    (entry) => entry.field === 'effort',
  );
  assert.ok(effort);
  clickHit(effort);
  assert.equal(ui.agents.pick.field, 'effort');
  assert.equal(ui.agents.pick.query, '');
});

test('model menu uses background and a right scroller', async (t) => {
  const { ui, env } = await openAgents(
    t,
    { color: true, columns: 160, rows: 24 },
    'cursor-agent',
  );
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
  const rowWith = (text) =>
    ui.lastFrame.rows.find((row) => stripAnsi(row).includes(text));
  const agentRow = labelRow(ui.lastFrame.rows, 'agent');
  assert.ok(agentRow.includes(seq(THEME.popupFg, THEME.popupBg)));
  const modelRow = labelRow(ui.lastFrame.rows, 'model');
  assert.ok(modelRow.includes(seq(THEME.chromeFg, THEME.noteBg)));
  assert.ok(modelRow.includes(seq(THEME.buttonHotFg, THEME.ctxBg)));
  ui.nav.agentCursor = 0;
  ui.draw();
  const hintRow = rowWith('npm install --global @agentclientprotocol');
  assert.ok(hintRow);
  assert.match(stripAnsi(hintRow), / install /);
  assert.ok(hintRow.includes(seq(THEME.buttonHotFg, THEME.buttonBg)));
  // An agent that is missing has no settings to show
  for (const label of ['model', 'effort', 'fast mode', 'context']) {
    assert.equal(labelRow(ui.lastFrame.rows, label), undefined, label);
  }
  ui.nav.agentCursor = 2;
  press(ui, 'm');
  ui.draw();
  const plain = stripAnsi(ui.lastFrame.rows.join('\n'));
  assert.equal(plain.includes('┌'), false);
  assert.equal(plain.includes('│'), false);
  assert.equal(plain.includes('─'), false);
  assert.equal(plain.includes('▸'), false);
  const thumb = bg(THEME.taskHeadBg);
  const track = bg(THEME.buttonBg);
  const menuRows = () => {
    const { fileHits, rows } = ui.lastFrame;
    const hits = fileHits.filter((hit) => hit.field === 'menu');
    hits.sort((left, right) => left.y - right.y);
    return hits.map((hit) => rows[hit.y - 1]);
  };
  const open = menuRows();
  assert.match(plain, /model-0/);
  assert.ok(open.length > 1);
  assert.ok(open.some((row) => row.includes(bg(THEME.checkBg))));
  assert.ok(open.some((row) => row.includes(bg(THEME.noteBg))));
  assert.ok(open.some((row) => row.includes(thumb)));
  assert.ok(open.some((row) => row.includes(track)));
  const thumbAt = open.findIndex((row) => row.includes(thumb));
  press(ui, 'end');
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
  press(ui, '1');
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
  const queryRow = labelRow(ui.lastFrame.rows, 'model');
  assert.ok(queryRow.includes(seq(THEME.warnFg, THEME.popupBg)));
  assert.equal(queryRow.includes(bg(THEME.searchBg)), false);
  press(ui, 'escape', 'e');
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
});

test('agents screen remembers model and effort in .reslop', async (t) => {
  const { env, ui, repo } = await openAgents(t, 'claude-agent-acp');
  await showAgents(ui, env);
  press(ui, 'm', 'down', 'enter', 'e', 'down', 'enter');
  assert.equal(ui.agents.choice('claude').model, 'opus');
  assert.equal(ui.agents.choice('claude').effort, 'high');
  const file = path.join(repo.dir, '.reslop');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(saved.agents.claude, { model: 'opus', effort: 'high' });
  ui.agents.choices = new Map();
  ui.agents.refresh(env);
  assert.equal(ui.agents.choice('claude').model, 'opus');
  assert.equal(ui.agents.choice('claude').effort, 'high');
});

test('flags written for the cli runs are not read from .reslop', async (t) => {
  const { env, ui, repo } = await openAgents(t, 'claude-agent-acp');
  const file = path.join(repo.dir, '.reslop');
  const claude = { model: 'sonnet', extra: '--unsafe-example' };
  fs.writeFileSync(file, `${JSON.stringify({ agents: { claude } })}\n`);
  await showAgents(ui, env);
  assert.equal(ui.agents.choice('claude').extra, undefined);
  ui.agents.saveChoice('claude');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(saved.agents.claude, {
    model: 'sonnet',
    effort: 'medium',
  });
});

test('recorded runs stay listed for the selected cli', async (t) => {
  const { env, ui, repo } = await openAgents(
    t,
    'cursor-agent',
    'claude-agent-acp',
  );
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
  ui.stdout.rows = 30;
  ui.draw();
  const text = stripAnsi(ui.lastFrame.rows.join('\n'));
  assert.match(text, /cursor-new/);
  assert.match(text, /cursor-old/);
  const claudeAt = ui.agents.rows().findIndex((row) => row.id === 'claude');
  ui.nav.agentCursor = claudeAt;
  const claudeRuns = ui.agents.sessionRows().map((row) => row.name);
  assert.deepEqual(claudeRuns, ['<start new session>', 'claude-only']);
});

test('agents screen lists sessions for the selected cli', async (t) => {
  const { env, ui, stdout } = await openAgents(t, 'claude-agent-acp');
  await showAgents(ui, env);
  ui.agents.spawn = () => ({ kill() {} });
  press(ui, 'm', 'enter', 's', 'escape');
  stdout.columns = 160;
  stdout.rows = 30;
  ui.draw();
  const lines = stripAnsi(ui.lastFrame.rows.join('\n')).split('\n');
  assert.ok(lines.some((row) => /claude/.test(row)));
  assert.ok(lines.some((row) => /<start new session>/.test(row)));
  const runHit = ui.lastFrame.fileHits.find((hit) => hit.side === 'runs');
  assert.ok(runHit);
  // The sessions are under the table of the settings
  const progressAt = lines.findIndex((line) => /Status/.test(line));
  assert.ok(runHit.y - 1 > progressAt);
  assert.match(ui.agents.jobs[0].command, /^claude sonnet medium /);
  press(ui, 'right');
  assert.equal(ui.agents.focus, 'runs');
  press(ui, 'tab');
  assert.equal(ui.agents.focus, 'cli');
  press(ui, 'tab');
  assert.equal(ui.agents.focus, 'runs');
  press(ui, 'left');
  assert.equal(ui.agents.focus, 'cli');
  const live = ui.agents.jobs[0];
  live.status = 'exit 0';
  live.child = null;
  ui.agents.closeView();
  press(ui, 'right', 'enter');
  assert.equal(ui.agents.jobs.length, 2);
  assert.equal(ui.agents.viewing, true);
});

test('a new agent session is its own run with status', async (t) => {
  const { env, ui, repo, stdout } = await openAgents(t, 'claude-agent-acp');
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
  await showAgents(ui, env);
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
  stdout.rows = 30;
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
});

test('agents panels scroll past one screen', async (t) => {
  const { env, ui } = await openAgents(t, 'claude-agent-acp');
  await showAgents(ui, env);
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
  ui.stdout.rows = 24;
  ui.draw();
  const top = stripAnsi(ui.lastFrame.rows.join('\n'));
  assert.match(top, /run-39/);
  assert.equal(/\brun-0\b/.test(top), false);
  press(ui, 'end');
  ui.draw();
  const bottom = stripAnsi(ui.lastFrame.rows.join('\n'));
  assert.match(bottom, /run-0/);
  assert.equal(bottom.includes('run-39'), false);
});

test('agent sessions select a range', async (t) => {
  const { env, ui } = await openAgents(t, 'claude-agent-acp');
  await showAgents(ui, env);
  for (let i = 0; i < 3; i++) {
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
  ui.agents.runCursor = 0;
  press(ui, 'shift-down');
  assert.deepEqual(ui.view().listSelection, [0, 1]);
  press(ui, 's');
  assert.equal(ui.agents.viewing, false);
  press(ui, 'down');
  assert.deepEqual(ui.view().listSelection, []);
});

test('agents screen blocks a review file that is running', async (t) => {
  const { env, ui, repo } = await openAgents(
    t,
    'claude-agent-acp',
    'cursor-agent',
  );
  const reviewDir = path.join(repo.dir, '.plan');
  fs.mkdirSync(reviewDir, { recursive: true });
  const older = '2020-01-01-00.md';
  const newer = '2020-01-02-00.md';
  const body = '---\nstatus: editing\n---\n';
  fs.writeFileSync(path.join(reviewDir, older), body);
  fs.writeFileSync(path.join(reviewDir, newer), body);
  ui.review.store.reviewPath = '';
  await showAgents(ui, env);
  const calls = [];
  ui.agents.spawn = () => {
    calls.push(1);
    return { kill() {} };
  };
  ui.agents.start();
  assert.equal(calls.length, 1);
  assert.equal(ui.agents.jobs[0].plan, `.plan/${newer}`);
  press(ui, 'escape');
  ui.nav.agentCursor = 2;
  ui.agents.start();
  assert.equal(calls.length, 1);
  assert.equal(ui.status, `busy ${newer}`);
  press(ui, 'p');
  assert.deepEqual(ui.agents.menuItems(), [
    'none',
    `${newer}  editing  0/0`,
    `${older}  editing  0/0`,
  ]);
  assert.equal(ui.agents.pick.cursor, 2);
  ui.agents.pick.cursor = 1;
  press(ui, 'enter');
  assert.equal(ui.agents.pick.field, 'plan');
  assert.equal(path.basename(ui.agents.planFile()), newer);
  press(ui, 'down');
  assert.equal(ui.agents.pick.cursor, 2);
  press(ui, 'enter');
  assert.equal(ui.agents.pick, null);
  assert.equal(path.basename(ui.agents.planFile()), older);
  ui.agents.start();
  assert.equal(calls.length, 2);
  assert.equal(ui.agents.jobs[1].plan, `.plan/${older}`);
});

test('agents screen toggles fast mode with o', async (t) => {
  const { env, ui, repo } = await openAgents(t, 'claude-agent-acp', 'opencode');
  await showAgents(ui, env);
  press(ui, 'o');
  assert.equal(ui.agents.choice('claude').fast, true);
  assert.equal(ui.agents.rows()[0].fast, 'on');
  assert.equal(ui.status, 'fast on');
  ui.draw();
  const on = stripAnsi(ui.lastFrame.rows.join('\n'));
  assert.match(on, /fast mode +on/);
  const saved = JSON.parse(fs.readFileSync(path.join(repo.dir, '.reslop')));
  assert.equal(saved.agents.claude.fast, true);
  press(ui, 'o');
  assert.equal(ui.agents.choice('claude').fast, false);
  assert.equal(ui.agents.rows()[0].fast, 'off');
  const cleared = JSON.parse(
    fs.readFileSync(path.join(repo.dir, '.reslop'), 'utf8'),
  );
  assert.equal(cleared.agents.claude.fast, undefined);
  ui.nav.agentCursor = 1;
  press(ui, 'o');
  assert.equal(ui.agents.choice('opencode').fast, false);
  assert.equal(ui.status, 'fast off');
});

test('single click on the fast column toggles it', async (t) => {
  const { env, ui } = await openAgents(t, 'claude-agent-acp');
  await showAgents(ui, env);
  ui.draw();
  const hit = ui.lastFrame.fileHits.find((entry) => entry.field === 'fast');
  assert.ok(hit);
  click(ui, hit.x0 + 1, hit.y);
  assert.equal(ui.agents.choice('claude').fast, true);
  assert.equal(ui.agents.rows()[0].fast, 'on');
});

test('a model listed in several context sizes offers them', async (t) => {
  const { env, ui, repo } = await openAgents(t, 'cursor-agent');
  await showAgents(ui, env);
  const at = ui.agents.rows().findIndex((row) => row.id === 'cursor');
  ui.nav.agentCursor = at;
  press(ui, 'x');
  assert.equal(ui.agents.pick, null);
  press(ui, 'm', 'end', 'enter');
  assert.equal(ui.agents.choice('cursor').model, 'gpt-5');
  assert.equal(ui.agents.rows()[at].effort, 'low');
  assert.equal(ui.agents.rows()[at].context, '272k');
  press(ui, 'x');
  assert.equal(ui.agents.pick.field, 'context');
  assert.deepEqual(ui.agents.menuItems(), ['272k', '1m']);
  press(ui, 'down', 'enter');
  assert.equal(ui.agents.choice('cursor').context, '1m');
  press(ui, 'e');
  assert.deepEqual(ui.agents.menuItems(), ['low', 'high']);
  press(ui, 'down', 'enter');
  assert.equal(ui.agents.choice('cursor').effort, 'high');
  ui.draw();
  const text = stripAnsi(ui.lastFrame.rows.join('\n'));
  assert.match(text, /model +gpt-5/);
  assert.match(text, /effort +high/);
  assert.equal(text.includes('fast mode'), false);
  assert.match(text, /context +1m/);
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
  press(ui, 'escape', 'm', 'up', 'enter');
  assert.equal(ui.agents.choice('cursor').model, 'composer-2');
  assert.equal(ui.agents.rows()[at].context, '');
  assert.deepEqual(ui.agents.rows()[at].contexts, []);
});

test('i proposes the npm package a missing agent needs', async (t) => {
  const { dir, bins, env, ui, repo } = await openAgents(t, 'cursor-agent');
  await showAgents(ui, env);
  const calls = [];
  let close = null;
  ui.agents.spawn = (cwd, launch, onData, onClose) => {
    calls.push(launch);
    onData('added 120 packages\n');
    close = onClose;
    return { kill() {} };
  };
  // The button is in the table of the screen, not among the footer buttons
  const install = () => {
    ui.draw();
    const hit = ui.lastFrame.fileHits.find((h) => h.field === 'install');
    const footer = ui.lastFrame.buttons.map((button) => button.id);
    assert.equal(footer.includes('agentInstall'), false);
    return hit;
  };
  assert.equal(ui.agents.selected().id, 'cursor');
  assert.equal(install(), undefined);
  press(ui, 'i');
  assert.equal(calls.length, 0);
  assert.equal(ui.status, 'installed');
  ui.nav.agentCursor = AGENTS.findIndex((spec) => spec.id === 'agy');
  assert.ok(install());
  press(ui, 'i');
  assert.equal(calls.length, 0);
  assert.equal(ui.mode, 'confirmAgentInstall');
  assert.equal(ui.view().agentInstallPackage, 'Google Antigravity ACP');
  press(ui, 'n');
  ui.nav.agentCursor = 0;
  assert.ok(install());
  press(ui, 'i');
  assert.equal(calls.length, 0);
  assert.equal(ui.mode, 'confirmAgentInstall');
  assert.equal(
    ui.view().agentInstallPackage,
    '@agentclientprotocol/claude-agent-acp',
  );
  ui.draw();
  assert.match(
    stripAnsi(ui.lastFrame.rows.join('\n')),
    /install @agentclientprotocol\/claude-agent-acp\? y\/n/,
  );
  press(ui, 'n');
  assert.equal(ui.mode, 'review');
  assert.equal(calls.length, 0);
  press(ui, 'i', 'y');
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
  press(ui, 'escape');
  assert.equal(ui.agents.sessionRows().length, 1);
  press(ui, 'i');
  assert.equal(calls.length, 1);
  assert.equal(ui.agents.viewing, true);
  bins.claude = makeBin(dir, 'claude-agent-acp');
  close({ status: 0, text: 'added 120 packages\n' });
  assert.equal(ui.status, 'installed claude');
  assert.equal(ui.agents.runningCount(), 0);
  assert.equal(ui.agents.rows()[0].bin, bins.claude);
  await settle();
  assert.equal(ui.agents.rows()[0].model, 'sonnet');
  assert.equal(fs.existsSync(path.join(repo.dir, '.log')), false);
  press(ui, 'escape', 'i');
  assert.equal(calls.length, 1);
  assert.equal(ui.status, 'installed');
});
