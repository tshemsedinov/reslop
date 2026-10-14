'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Session } = require('../lib/session/session.js');
const { createGitRepo } = require('../lib/git/git.js');
const { dirKey } = require('../lib/git/linked.js');
const { makeRepo, uiSink } = require('./helpers.js');

const fakeBin = (name) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reslop-bins-'));
  const file = path.join(dir, name);
  fs.writeFileSync(file, '#!/bin/sh\n');
  fs.chmodSync(file, 0o755);
  return { dir, env: { PATH: dir } };
};

const openAt = async (cwd) => {
  const ui = new Session({
    cwd,
    stdout: uiSink(),
    repo: createGitRepo(),
    color: false,
    startPane: 'dashboard',
  });
  await ui.ensureRepo();
  await ui.load();
  return ui;
};

const jsonLogs = (dir) => {
  const folder = path.join(dir, '.log');
  if (!fs.existsSync(folder)) return [];
  return fs.readdirSync(folder).filter((name) => name.endsWith('.json'));
};

const showWorktree = async (ui, dir) => {
  ui.retarget({ cwd: dir, repoName: path.basename(dir), pane: 'dashboard' });
  await ui.ensureRepo();
  await ui.openLoad();
};

test('agents of two worktrees run side by side and save apart', async () => {
  const { dir, env } = fakeBin('claude-agent-acp');
  const repo = makeRepo();
  repo.write('a.js', 'ok\n');
  repo.git(['add', '.']);
  repo.git(['commit', '-m', 'init']);
  const other = `${repo.dir}-other`;
  repo.git(['worktree', 'add', '-b', 'other', other]);
  const ui = await openAt(repo.dir);
  const calls = [];
  try {
    ui.agents.spawn = (cwd, launch, onData, onClose) => {
      calls.push({ cwd, onClose });
      onData('working\n');
      return { kill() {} };
    };
    ui.agents.listModels = async () => null;
    ui.agents.refresh(env);
    await ui.agents.open();
    ui.agents.start();
    assert.equal(calls.length, 1);
    assert.equal(ui.agents.jobs.length, 1);
    await showWorktree(ui, other);
    ui.agents.refresh(env);
    await ui.agents.open();
    assert.equal(ui.agents.jobs.length, 0);
    assert.equal(ui.agents.runningCount(), 1);
    ui.agents.start();
    assert.equal(calls.length, 2, ui.status);
    assert.equal(ui.agents.jobs.length, 1);
    assert.equal(dirKey(calls[0].cwd), dirKey(repo.dir));
    assert.equal(dirKey(calls[1].cwd), dirKey(other));
    assert.equal(ui.agents.runningCount(), 2);
    const live = ui.agents.liveByRoot();
    assert.equal(live.size, 2);
    assert.deepEqual([...live.values()], [1, 1]);
    calls[0].onClose({ status: 0, text: 'done\n' });
    assert.equal(ui.agents.runningCount(), 1);
    assert.equal(jsonLogs(repo.dir).length, 1);
    assert.equal(jsonLogs(other).length, 1);
    const first = path.join(repo.dir, '.log', jsonLogs(repo.dir)[0]);
    assert.equal(JSON.parse(fs.readFileSync(first, 'utf8')).exit, 0);
    const second = path.join(other, '.log', jsonLogs(other)[0]);
    assert.equal(JSON.parse(fs.readFileSync(second, 'utf8')).exit, undefined);
    assert.equal(ui.agents.jobs[0].status, 'running');
    await showWorktree(ui, repo.dir);
    await ui.agents.open();
    assert.equal(ui.agents.jobs.length, 1);
    assert.equal(ui.agents.jobs[0].status, 'exit 0');
    assert.equal(ui.agents.runningCount(), 1);
    calls[1].onClose({ status: 0, text: 'done\n' });
    assert.equal(ui.agents.runningCount(), 0);
    const closed = path.join(other, '.log', jsonLogs(other)[0]);
    assert.equal(JSON.parse(fs.readFileSync(closed, 'utf8')).exit, 0);
    assert.equal(jsonLogs(repo.dir).length, 1);
    assert.equal(ui.agents.away.jobs().length, 0);
  } finally {
    ui.agents.reset();
    repo.cleanup();
    fs.rmSync(other, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('test runs stay with the worktree they were started in', async () => {
  const repo = makeRepo();
  repo.write('a.js', 'ok\n');
  repo.git(['add', '.']);
  repo.git(['commit', '-m', 'init']);
  const other = `${repo.dir}-other`;
  repo.git(['worktree', 'add', '-b', 'other', other]);
  const ui = await openAt(repo.dir);
  try {
    const run = { id: 1, status: 'running', top: ui.top, child: null };
    ui.npm.runs.push(run);
    assert.equal(ui.npm.runs.length, 1);
    await showWorktree(ui, other);
    assert.equal(ui.npm.runs.length, 0);
    assert.equal(ui.npm.running, true);
    assert.equal(ui.npm.liveByRoot().get(run.top), 1);
    assert.equal(ui.npm.viewing, false);
    ui.npm.runs.push({ id: 2, status: 'exited', top: ui.top, child: null });
    await showWorktree(ui, repo.dir);
    assert.equal(ui.npm.runs.length, 1);
    assert.equal(ui.npm.runs[0], run);
    run.status = 'exited';
    assert.equal(ui.npm.running, false);
  } finally {
    ui.npm.reset();
    repo.cleanup();
    fs.rmSync(other, { recursive: true, force: true });
  }
});

test('plans and reviews are saved in the worktree that is shown', async () => {
  const repo = makeRepo();
  repo.write('a.js', 'ok\n');
  repo.git(['add', '.']);
  repo.git(['commit', '-m', 'init']);
  const other = `${repo.dir}-other`;
  repo.git(['worktree', 'add', '-b', 'other', other]);
  fs.writeFileSync(path.join(other, 'a.js'), 'changed\n');
  const ui = await openAt(other);
  try {
    assert.equal(ui.items.length > 0, true);
    ui.initReview();
    ui.review.store.addTask('TODOs', 'only here', false, 'backlog');
    ui.flushReview(true);
    assert.equal(fs.existsSync(path.join(other, '.plan')), true);
    assert.equal(fs.existsSync(path.join(repo.dir, '.plan')), false);
    assert.equal(ui.agents.root, ui.top);
  } finally {
    ui.agents.reset();
    repo.cleanup();
    fs.rmSync(other, { recursive: true, force: true });
  }
});
