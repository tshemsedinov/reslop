'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const allow = require('../lib/agents/allow.js');
const { PLAN_ALLOWS, ensureAllows, cursorConfigPath } = allow;
const agents = require('../lib/agents/agents.js');
const { AGENTS, buildLaunch, emptyChoice, startAgent } = agents;
const { removeTree } = require('./helpers.js');

test('plan edits and test commands are remembered in the cursor config', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reslop-allow-'));
  const file = path.join(dir, 'cli-config.json');
  fs.writeFileSync(
    file,
    `${JSON.stringify({ permissions: { allow: ['Shell(ls)'], deny: [] } })}\n`,
  );
  assert.equal(ensureAllows(file, PLAN_ALLOWS), true);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(saved.permissions.allow.includes('Shell(ls)'));
  assert.ok(saved.permissions.allow.includes('Write(.plan/**/*.md)'));
  assert.ok(saved.permissions.allow.includes('Shell(npm)'));
  assert.ok(saved.permissions.allow.includes('Shell(reslop t)'));
  assert.equal(ensureAllows(file, PLAN_ALLOWS), true);
  const again = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(again.permissions.allow.length, saved.permissions.allow.length);
  const env = { ...process.env, RESLOP_CURSOR_CONFIG: file };
  assert.equal(cursorConfigPath(env), file);
  fs.rmSync(dir, { recursive: true, force: true });
});

const cursorRow = () => {
  const spec = AGENTS.find((agent) => agent.id === 'cursor');
  const bin = '/usr/bin/cursor-agent';
  return { id: spec.id, name: spec.name, bin, spec, models: spec.models };
};

test('the cursor agent runs without a terminal', () => {
  const row = cursorRow();
  const launch = buildLaunch(row, emptyChoice(row), '/tmp/plan.md');
  assert.deepEqual(launch.args.slice(0, 2), ['--print', '--trust']);
  assert.equal(launch.command, 'cursor-agent --print --trust /tmp/plan.md');
  const resumed = buildLaunch(row, emptyChoice(row), '/tmp/plan.md', '', 'abc');
  assert.deepEqual(resumed.args.slice(0, 3), [
    '--print',
    '--trust',
    '--resume=abc',
  ]);
});

const runToEnd = (dir, launch) =>
  new Promise((resolve) => {
    let text = '';
    const onData = (next) => {
      text = next;
    };
    startAgent(dir, launch, onData, (result) => resolve({ ...result, text }));
  });

test('an agent with an allow list gets the plan entries', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reslop-allow-'));
  const config = path.join(dir, 'cli-config.json');
  const previous = process.env.RESLOP_CURSOR_CONFIG;
  process.env.RESLOP_CURSOR_CONFIG = config;
  const script = 'process.stdout.write("tty=" + Boolean(process.stdout.isTTY))';
  const args = ['-e', script];
  try {
    const base = { cmd: process.execPath, args, kind: 'run' };
    const first = await runToEnd(dir, { ...base, id: 'claude' });
    assert.equal(first.status, 0);
    await runToEnd(dir, { ...base, id: 'cursor', kind: 'login' });
    assert.equal(fs.existsSync(config), false);
    const cursor = { ...base, id: 'cursor' };
    const second = await runToEnd(dir, cursor);
    assert.equal(second.status, 0);
    assert.match(second.text, /tty=false/);
    const saved = JSON.parse(fs.readFileSync(config, 'utf8'));
    assert.ok(saved.permissions.allow.includes('Write(.plan/**/*.md)'));
    assert.ok(saved.permissions.allow.includes('Shell(npm)'));
  } finally {
    if (previous === undefined) delete process.env.RESLOP_CURSOR_CONFIG;
    else process.env.RESLOP_CURSOR_CONFIG = previous;
    await removeTree(dir);
  }
});
