'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const reports = require('../lib/dashboard/reports.js');
const { remembered, reportCounts, forgetReports } = reports;
const { Session } = require('../lib/session/session.js');
const { createGitRepo } = require('../lib/git/git.js');
const { makeRepo, uiSink, tempDir, removeTree } = require('./helpers.js');

// What npm would answer: the number of problems asked for, counted
const counter = (sizes = { audit: 2, outdated: 3 }) => {
  const calls = [];
  const collect = async (dir, kind) => {
    calls.push([path.basename(dir), kind]);
    return { size: sizes[kind] };
  };
  return { calls, collect };
};

const project = (root, name, lock = '{"lockfileVersion":3}') => {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"x"}');
  fs.writeFileSync(path.join(dir, 'package-lock.json'), lock);
  return dir;
};

test('an answer of npm is asked once while the files stay', async () => {
  forgetReports();
  let asked = 0;
  const collect = async () => {
    asked += 1;
    return asked;
  };
  assert.equal(await remembered('k', collect), 1);
  assert.equal(await remembered('k', collect), 1);
  assert.equal(await remembered('other', collect), 2);
  const later = Date.now() + 11 * 60 * 1000;
  assert.equal(await remembered('k', collect, later), 3);
  assert.equal(await remembered('', collect), 4);
  assert.equal(await remembered('', collect), 5);
  const broken = () => Promise.reject(new Error('offline'));
  await assert.rejects(remembered('bad', broken));
  assert.equal(await remembered('bad', collect), 6);
});

test('worktrees with one lockfile ask npm audit once', async () => {
  forgetReports();
  const root = tempDir('reslop-npm-');
  try {
    const first = project(root, 'app');
    const second = project(root, 'app-two');
    const changed = project(root, 'app-three', '{"lockfileVersion":2}');
    const { calls, collect } = counter();
    const one = await reportCounts(first, collect);
    const two = await reportCounts(second, collect);
    assert.deepEqual(one, { audit: 2, outdated: 3 });
    assert.deepEqual(two, one);
    const audits = calls.filter(([, kind]) => kind === 'audit');
    const outdated = calls.filter(([, kind]) => kind === 'outdated');
    assert.equal(audits.length, 1);
    assert.equal(outdated.length, 2);
    await reportCounts(changed, collect);
    assert.equal(calls.filter(([, kind]) => kind === 'audit').length, 2);
    await reportCounts(first, collect);
    await reportCounts(second, collect);
    await reportCounts(changed, collect);
    assert.equal(calls.length, 5);
    fs.writeFileSync(path.join(first, 'package.json'), '{"name":"y","a":1}');
    await reportCounts(first, collect);
    assert.equal(calls.length, 6);
    assert.deepEqual(calls.at(-1), ['app', 'outdated']);
  } finally {
    forgetReports();
    await removeTree(root);
  }
});

test('a directory without package files does not ask npm', async () => {
  forgetReports();
  const root = tempDir('reslop-npm-');
  try {
    const { calls, collect } = counter({ audit: 0, outdated: 0 });
    const counts = await reportCounts(root, collect);
    assert.deepEqual(counts, { audit: 0, outdated: 0 });
    assert.equal(
      calls.every(([, kind]) => kind === 'audit' || kind === 'outdated'),
      true,
    );
  } finally {
    forgetReports();
    await removeTree(root);
  }
});

const sessionAt = async (cwd) => {
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

test('tiles ask npm again only where nothing is known', async () => {
  const repo = makeRepo();
  repo.write('a.js', 'ok\n');
  repo.git(['add', '.']);
  repo.git(['commit', '-m', 'init']);
  const ui = await sessionAt(repo.dir);
  try {
    ui.trees.start();
    ui.trees.stop();
    const asked = [];
    ui.trees.active = true;
    ui.trees.kick = (row, bag) => asked.push([row.name, bag.npm, bag.git]);
    ui.trees.rows = [
      { name: 'known', npmReady: true },
      { name: 'new', npmReady: false },
    ];
    ui.trees.refresh();
    assert.deepEqual(asked, [
      ['known', false, true],
      ['new', true, true],
    ]);
  } finally {
    ui.trees.active = false;
    repo.cleanup();
  }
});

test('the reports of npm are kept for each worktree', async () => {
  const repo = makeRepo();
  repo.write('a.js', 'ok\n');
  repo.git(['add', '.']);
  repo.git(['commit', '-m', 'init']);
  const other = `${repo.dir}-other`;
  repo.git(['worktree', 'add', '-b', 'other', other]);
  const ui = await sessionAt(repo.dir);
  try {
    const { lifecycle } = ui;
    assert.equal(lifecycle.cachedExtras, null);
    lifecycle.cachedExtras = { stamp: 'a', auditMap: new Map() };
    ui.top = other;
    assert.equal(lifecycle.cachedExtras, null);
    lifecycle.cachedExtras = { stamp: 'b', auditMap: null };
    assert.equal(lifecycle.cachedExtras.stamp, 'b');
    ui.top = repo.dir;
    assert.equal(lifecycle.cachedExtras.stamp, 'a');
    lifecycle.clearNpmExtras();
    assert.equal(lifecycle.cachedExtras, null);
    ui.top = other;
    assert.equal(lifecycle.cachedExtras, null);
  } finally {
    repo.cleanup();
    fs.rmSync(other, { recursive: true, force: true });
  }
});
