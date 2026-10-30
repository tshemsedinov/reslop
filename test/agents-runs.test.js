'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const agents = require('../lib/agents/agents.js');
const { planPrompt } = agents;
const { emptyChoice, buildLaunch, AGENTS } = agents;
const { press, click, tempDir } = require('./helpers.js');
const ansi = require('../lib/term/ansi.js');
const { stripAnsi, THEME, bg } = ansi;
const { setImmediate: settle } = require('node:timers/promises');
const agentsHelpers = require('./agents-helpers.js');
const { fakePath, labelRow, STATES, listed, rowOf, specOf } = agentsHelpers;
const { openUi, openAgents, showAgents, typeInto } = agentsHelpers;

const FIXTURE = path.join(__dirname, 'acp-agent.js');

const SH_ONLY = { skip: process.platform === 'win32' };

test('the agents are asked default first, a few at a time', async () => {
  const names = ['claude-agent-acp', 'cursor-agent', 'codex-acp', 'opencode'];
  const { dir, env } = fakePath(...names);
  const { ui, repo } = await openUi();
  try {
    const order = [];
    let busy = 0;
    let most = 0;
    ui.agents.listModels = async (row, options) => {
      order.push(row.id);
      busy += 1;
      most = Math.max(most, busy);
      await settle();
      await settle();
      busy -= 1;
      options.auth.state = 'in';
      return STATES[row.id] ?? null;
    };
    ui.agents.refresh(env);
    const installed = ui.agents.list.filter((row) => row.bin).map((r) => r.id);
    assert.equal(installed.length, 4);
    // Not installed agents are never asked, a duplicate call asks nothing
    const first = ui.agents.loadModels();
    const again = ui.agents.loadModels();
    await Promise.all([first, again]);
    assert.deepEqual(order, installed);
    assert.ok(most <= 3 && most > 1);
    assert.equal(ui.agents.accounts.size, 4);
    // The agent the screen is on goes first
    ui.agents.reset();
    ui.agents.refresh(env);
    order.length = 0;
    ui.nav.agentCursor = ui.agents.list.findIndex((row) => row.id === 'codex');
    ui.agents.opened = true;
    await ui.agents.loadModels();
    assert.equal(order[0], 'codex');
    assert.deepEqual([...order].sort(), [...installed].sort());
    // Without the screen the first installed agent is the default
    ui.agents.reset();
    ui.agents.refresh(env);
    order.length = 0;
    await ui.agents.loadModels();
    assert.equal(order[0], installed[0]);
  } finally {
    ui.agents.reset();
    repo.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('settings that do not apply are not shown', async (t) => {
  const { env, ui } = await openAgents(t, 'claude-agent-acp', 'cursor-agent');
  ui.stdout.rows = 30;
  await showAgents(ui, env);
  const shown = () => {
    ui.draw();
    const labels = ['model', 'effort', 'fast mode', 'context'];
    return labels.filter((label) => labelRow(ui.lastFrame.rows, label));
  };
  // claude has efforts and a fast mode, no context sizes
  assert.deepEqual(shown(), ['model', 'effort', 'fast mode']);
  assert.deepEqual(ui.agents.fieldList(), [
    'agent',
    'model',
    'effort',
    'fast',
    'plan',
    'task',
  ]);
  // a model of cursor with one fixed fast mode and no choice of effort
  ui.nav.agentCursor = AGENTS.findIndex((spec) => spec.id === 'cursor');
  ui.agents.choice('cursor').model = 'composer-2';
  assert.deepEqual(shown(), ['model']);
  assert.deepEqual(ui.agents.fieldList(), ['agent', 'model', 'plan', 'task']);
  // an agent that has listed nothing offers nothing to set
  ui.agents.listModels = async () => null;
  ui.agents.reset();
  ui.agents.refresh(env);
  await ui.agents.open();
  assert.deepEqual(shown(), ['model']);
  // a missing agent shows no settings at all
  ui.nav.agentCursor = AGENTS.findIndex((spec) => spec.id === 'codex');
  assert.deepEqual(shown(), []);
  assert.deepEqual(ui.agents.fieldList(), ['agent', 'install', 'plan', 'task']);
});

test('status and progress are one row, one spacer follows', async (t) => {
  const { env, ui, repo } = await openAgents(t, 'claude-agent-acp');
  const reviewDir = path.join(repo.dir, '.plan');
  fs.mkdirSync(reviewDir, { recursive: true });
  const name = '2020-01-01-00.md';
  const body = '---\nstatus: partial\n---\n\n> a.js\n\n- [x] one\n- [ ] two\n';
  fs.writeFileSync(path.join(reviewDir, name), body);
  ui.review.store.reviewPath = '';
  await showAgents(ui, env);
  ui.agents.planPath = path.join(reviewDir, name);
  ui.stdout.rows = 30;
  ui.draw();
  // The left panel of an 80 column screen
  const lines = stripAnsi(ui.lastFrame.rows.join('\n'))
    .split('\n')
    .map((line) => line.slice(0, 56));
  const status = lines.findIndex((line) => /^ +Status /.test(line));
  assert.match(lines[status], /Status +partial +1\/2 +─+/);
  assert.equal(
    lines.some((line) => /Progress/.test(line)),
    false,
  );
  assert.match(lines[status - 1], /plan +2020-01-01-00\.md/);
  assert.equal(lines[status + 1].trim(), '');
  assert.match(lines[status + 2], /<start new session>/);
});

test('the task box moves lines, is clicked, and Escape leaves', async (t) => {
  const { env, ui } = await openAgents(t, 'claude-agent-acp');
  await showAgents(ui, env);
  ui.stdout.rows = 30;
  ui.draw();
  const empty = ui.lastFrame.editHits.find((h) => h.editor === ui.agents.task);
  assert.ok(empty);
  click(ui, empty.textX, empty.y);
  assert.equal(ui.agents.currentField(), 'task');
  typeInto(ui, 'one');
  press(ui, 'shift-enter');
  typeInto(ui, 'two');
  press(ui, 'up');
  assert.equal(ui.agents.currentField(), 'task');
  assert.equal(ui.agents.task.linePos().line, 0);
  press(ui, 'up');
  assert.equal(ui.agents.currentField(), 'plan');
  press(ui, 'down', 'down');
  assert.equal(ui.agents.task.linePos().line, 1);
  ui.draw();
  const second = ui.lastFrame.editHits.find((h) => h.text === 'two');
  click(ui, second.textX + 1, second.y);
  assert.equal(ui.agents.task.cursor, 'one\nt'.length);
  press(ui, 'escape');
  assert.equal(ui.pane, 'dashboard');
  assert.equal(ui.agents.task.text, 'one\ntwo');
});

test('agent history keeps launch, output, time, and progress', async (t) => {
  const { env, ui, repo, stdout } = await openAgents(t, 'claude-agent-acp');
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
  await showAgents(ui, env);
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
  stdout.rows = 24;
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
  press(ui, 'escape');
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
  press(ui, 'down', 'enter');
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
  const prefs = JSON.parse(fs.readFileSync(path.join(repo.dir, '.reslop')));
  assert.equal(prefs.lastAgent, 'claude');
  assert.equal(prefs.runs, undefined);
  ui.agents.reset();
  assert.equal(ui.agents.jobs[0].status, 'exit 0');
  ui.agents.openSession(sessionId);
  assert.match(ui.agents.historyText, /hello from agent/);
});

test('agent output shows a scroller when the log overflows', async (t) => {
  const { ui, env } = await openAgents(
    t,
    { color: true, columns: 80, rows: 16 },
    'claude-agent-acp',
  );
  await showAgents(ui, env);
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
  press(ui, 'home');
  ui.draw();
  const top = logRows();
  const nextAt = top.findIndex((row) => row.includes(thumb));
  assert.ok(nextAt < thumbAt);
});

test('dragging the agent output scroller scrolls the log', async (t) => {
  const { ui, env } = await openAgents(
    t,
    { color: true, columns: 80, rows: 16 },
    'claude-agent-acp',
  );
  await showAgents(ui, env);
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
});

test('continue starts the session selected in the right panel', async (t) => {
  const { env, ui, stdout } = await openAgents(t, 'cursor-agent');
  await showAgents(ui, env);
  const at = ui.agents.rows().findIndex((row) => row.id === 'cursor');
  ui.nav.agentCursor = at;
  const calls = [];
  ui.agents.spawn = (cwd, launch) => {
    calls.push(launch);
    return { kill() {} };
  };
  stdout.columns = 160;
  stdout.rows = 30;
  ui.draw();
  const chooser = stripAnsi(ui.lastFrame.rows.join('\n'));
  assert.match(chooser, /<start new session>/);
  assert.equal(chooser.includes('session?'), false);
  assert.match(stripAnsi(ui.lastFrame.rows.at(-1)), /start/);
  assert.equal(ui.view().agentStartMode, 'start');
  assert.equal(ui.agents.focus, 'cli');
  assert.equal(ui.view().agentCanStart, true);
  press(ui, 's');
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
  assert.match(footer, /resume/);
  assert.equal(footer.includes('start'), false);
  assert.equal(ui.view().agentStartMode, 'resume');
  press(ui, 's');
  assert.equal(calls.length, 2);
  assert.equal(calls[1].session, sessionId);
  assert.deepEqual(calls[1].args, ['acp']);
  assert.match(calls[1].prompt, /repair plan/);
  const continued = ui.agents.jobs.at(-1);
  assert.equal(continued.resume, sessionId);
  continued.status = 'exit 1';
  continued.child = null;
  press(ui, 'r');
  assert.equal(calls.length, 3);
  assert.equal(calls[2].session, sessionId);
});

test('agent raw log keeps terminal escapes', async (t) => {
  const { env, ui, repo } = await openAgents(t, 'claude-agent-acp');
  await showAgents(ui, env);
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

test('a session opens on its last run and loads older on scroll', async (t) => {
  const { env, ui, repo } = await openAgents(t, 'claude-agent-acp');
  await showAgents(ui, env);
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
});

test('a completed session reopens with its captured output', async (t) => {
  const { env, ui } = await openAgents(t, 'claude-agent-acp');
  await showAgents(ui, env);
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
  press(ui, 'enter');
  assert.equal(ui.agents.viewing, true);
  assert.match(ui.agents.historyText, /completed agent output/);
});

test('saved runs reload when the repository root changes', async (t) => {
  const { env, ui, repo } = await openAgents(t, 'claude-agent-acp');
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
  press(ui, 'enter');
  assert.equal(ui.agents.viewing, true);
  assert.match(ui.agents.historyText, /saved line/);
});

test('reopening the agents screen restores both selections', async (t) => {
  const { env, ui } = await openAgents(t, 'claude-agent-acp', 'codex-acp');
  await showAgents(ui, env);
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
});

test('legacy .reslop runs move into .log', async (t) => {
  const { env, ui, repo } = await openAgents(t, 'claude-agent-acp');
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
});

test('a plan without agent instructions gets them in the prompt', () => {
  const dir = tempDir('reslop-guide-');
  try {
    const row = { ...rowOf(specOf('claude')) };
    const spec = path.join(dir, 'specs', 'plan.md');
    fs.mkdirSync(path.dirname(spec), { recursive: true });
    fs.writeFileSync(spec, '# Plan\n\n- [ ] F1: do it\n');
    const bare = buildLaunch(row, emptyChoice(), spec, dir);
    assert.equal(bare.plan, 'specs/plan.md');
    assert.match(
      bare.prompt,
      /^Read and execute repair plan at specs\/plan\.md/,
    );
    assert.match(bare.prompt, /has no agent instructions; follow these:/);
    assert.match(bare.prompt, /Work through unchecked items\./);
    assert.match(bare.prompt, /unattended/);
    const own = '# Plan\n\n## Agent instructions\n\nMine.\n\n- [ ] F1: x\n';
    fs.writeFileSync(spec, own);
    const told = buildLaunch(row, emptyChoice(), spec, dir);
    assert.equal(told.prompt, planPrompt('specs/plan.md'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
