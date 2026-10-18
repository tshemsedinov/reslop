'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const workspace = require('../lib/dashboard/workspace.js');
const { workspaceAt, sumNumstat, readDiffStat } = workspace;
const { load } = require('../lib/git/git.js');
const { fileEntries, fileTotals } = require('../lib/common/files.js');
const { countCommits, taskStats, pickRun } = workspace;
const tiles = require('../lib/render/tiles.js');
const { equalGrid, pageWindow, placeEqualTiles } = tiles;
const { size } = require('../lib/common/format.js');
const { paintBodyRepos } = require('../lib/render/repos.js');
const { renderFrame } = require('../lib/render/render.js');
const ansi = require('../lib/term/ansi.js');
const { stripAnsi } = ansi;
const { actionFromKey } = require('../lib/input/actions.js');
const { onEscape } = require('../lib/session/files-pane.js');
const { run, loadSession, parseArgv } = require('../lib/cli.js');
const { ReviewStore, flushReview } = require('../lib/review/review.js');
const { RunRecorder } = require('../lib/runs/runs.js');
const helpers = require('./helpers.js');
const { tempDir, removeTree, seedRepo, gitIn: git } = helpers;
const { waitUntil, fakeProc, stopSession, click } = helpers;

const initRepo = (dir) => {
  seedRepo(dir);
  fs.writeFileSync(path.join(dir, 'app.js'), `${'const n = 1;\n'.repeat(40)}`);
  fs.writeFileSync(path.join(dir, 'app.ts'), 'export const n = 1;\n');
  fs.writeFileSync(path.join(dir, 'data.json'), '{}\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-m', 'init']);
};

test('sumNumstat adds and skips binary rows', () => {
  const stat = sumNumstat('2\t1\ta.js\n-\t-\tb.bin\n3\t0\tc.ts\n');
  assert.equal(stat.added, 5);
  assert.equal(stat.removed, 1);
});

test('readDiffStat matches the status bar with untracked lines', async () => {
  const root = tempDir('reslop-diff-');
  const dir = path.join(root, 'repo');
  try {
    initRepo(dir);
    fs.appendFileSync(path.join(dir, 'app.js'), 'next\n');
    fs.writeFileSync(path.join(dir, 'extra.js'), 'a\nb\nc\n');
    const diff = await readDiffStat(dir);
    const loaded = await load(dir);
    const total = fileTotals(fileEntries(loaded.items));
    assert.equal(diff.stagedAdded, total.stagedAdded);
    assert.equal(diff.unstagedAdded, total.unstagedAdded);
    assert.equal(diff.stagedRemoved, total.stagedRemoved);
    assert.equal(diff.unstagedRemoved, total.unstagedRemoved);
    assert.equal(diff.unstagedAdded > 1, true);
  } finally {
    await removeTree(root);
  }
});

test('workspaceAt lists child repositories and skips a git root', () => {
  const root = tempDir('reslop-ws-');
  try {
    initRepo(path.join(root, 'beta'));
    initRepo(path.join(root, 'alpha'));
    fs.mkdirSync(path.join(root, 'notes'));
    fs.writeFileSync(path.join(root, 'readme.txt'), 'hi\n');
    const found = workspaceAt(root);
    assert.equal(found.root, path.resolve(root));
    assert.deepEqual(
      found.repos.map((repo) => repo.name),
      ['alpha', 'beta'],
    );
    assert.equal(workspaceAt(path.join(root, 'alpha')), null);
    assert.equal(workspaceAt(path.join(root, 'notes')), null);
    git(root, ['init', '-b', 'main']);
    assert.equal(workspaceAt(root), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('equal tiles keep one width and height', () => {
  const grid = equalGrid(80, 24, 3, 34, 7);
  const page = pageWindow(3, 0, grid.cap);
  const shown = ['alpha', 'beta', 'gamma'].slice(page.start, page.end);
  const bands = placeEqualTiles(
    shown.map((id) => ({ id })),
    grid,
  );
  const widths = new Set();
  const heights = new Set();
  for (const band of bands) {
    heights.add(band.h);
    for (const tile of band.tiles) widths.add(tile.w);
  }
  assert.equal(widths.size, 1);
  assert.equal(heights.size, 1);
  assert.equal(bands[0].tiles.length, grid.cols);
  const wide = equalGrid(81, 24, 2, 34, 7);
  const pair = placeEqualTiles([{ id: 'a' }, { id: 'b' }], wide);
  const left = pair[0].tiles[0];
  const right = pair[0].tiles[1];
  assert.equal(left.w + 2 + right.w, 81);
  assert.ok(Math.abs(left.w - right.w) <= 1);
  const edge = left.x + left.w + 2 + right.w;
  assert.equal(edge, wide.width);
});

test('a repo tile shows size, extensions, tasks, and diffs', () => {
  const now = Date.now();
  const row = {
    id: 'alpha',
    name: 'alpha',
    bytes: 1536,
    exts: [
      { key: '.js', bytes: 1500 },
      { key: '.ts', bytes: 20 },
      { key: '.json', bytes: 16 },
    ],
    tasks: 4,
    tasksDone: 1,
    commits: 12,
    diff: {
      stagedAdded: 1,
      unstagedAdded: 3,
      stagedRemoved: 2,
      unstagedRemoved: 5,
    },
    run: {
      name: 'test',
      status: 'passed',
      done: 3,
      failed: 0,
      expected: 3,
      result: { tests: 3, failed: 0 },
    },
    activityAt: now,
    filesReady: true,
    commitsReady: true,
    diffReady: true,
    tasksReady: true,
    runsReady: true,
    npmReady: true,
    npm: {
      hasManifest: true,
      deps: 0,
      dev: 5,
      modules: { count: 98, bytes: 20 },
      audit: 2,
      outdated: 5,
    },
    running: false,
  };
  const model = { now, frame: 0, cursor: 0, cols: 1, tiles: [row] };
  const calm = {
    ...model,
    frame: 1,
    tiles: [{ ...row, activityAt: 0 }],
  };
  const hot = paintBodyRepos({ repos: model }, 80, true, 20, 1);
  const still = paintBodyRepos({ repos: calm }, 80, true, 20, 1);
  const text = stripAnsi(hot.body.join('\n'));
  const head = stripAnsi(
    hot.body.find((line) => stripAnsi(line).includes('alpha')),
  );
  assert.match(text, /alpha/);
  assert.ok(head.trimEnd().endsWith(size(1536)));
  assert.match(text, /js /);
  assert.match(text, /ts /);
  assert.match(text, /json /);
  assert.match(text, /tasks: 1\/4/);
  assert.match(text, /commits: 12/);
  assert.match(text, /diff: \+1\/4/);
  assert.match(text, /-2\/7/);
  const summary = `deps: 0  dev: 5  all: 98 (${size(20)})  🚨 2  ⚠️ 5`;
  assert.ok(text.includes(summary));
  assert.equal(text.includes('▶'), false);
  assert.match(text, /test/);
  assert.match(text, /passed/);
  assert.notEqual(hot.body.join('\n'), still.body.join('\n'));
  const pending = {
    ...row,
    activityAt: 0,
    filesReady: false,
    commitsReady: false,
    diffReady: false,
    tasksReady: false,
    runsReady: false,
    npmReady: false,
    running: true,
  };
  const first = paintBodyRepos(
    { repos: { ...model, frame: 0, tiles: [pending] } },
    80,
    true,
    20,
    1,
  );
  const next = paintBodyRepos(
    { repos: { ...model, frame: 1, tiles: [pending] } },
    80,
    true,
    20,
    1,
  );
  assert.notEqual(first.body.join('\n'), next.body.join('\n'));
  assert.match(stripAnsi(first.body.join('\n')), /tasks: /);
  assert.match(stripAnsi(first.body.join('\n')), /diff: /);
  const warm = paintBodyRepos(
    { repos: { ...calm, tiles: [{ ...calm.tiles[0], running: true }] } },
    80,
    true,
    20,
    1,
  );
  const warmText = stripAnsi(warm.body.join('\n'));
  assert.match(warmText, /tasks: 1\/4/);
  assert.match(warmText, /diff: \+1\/4/);
  assert.equal(warm.body.join('\n'), still.body.join('\n'));
  const beta = { ...row, id: 'beta', name: 'beta', activityAt: 0 };
  const pair = paintBodyRepos(
    { repos: { ...model, tiles: [row, beta] } },
    40,
    true,
    20,
    1,
  );
  const code = (rgb) => `48;2;${rgb.join(';')}m`;
  const current = code(ansi.THEME.dashHeadBg);
  const dim = code(ansi.THEME.dashDimHeadBg);
  const alphaLine = pair.body.find((line) => stripAnsi(line).includes('alpha'));
  const betaLine = pair.body.find((line) => stripAnsi(line).includes('beta'));
  assert.ok(alphaLine.includes(current));
  assert.equal(alphaLine.includes(dim), false);
  assert.ok(betaLine.includes(dim));
  assert.equal(betaLine.includes(current), false);
});

test('opening a folder of repositories starts on repo tiles', async () => {
  const root = tempDir('reslop-ws-');
  const alpha = path.join(root, 'alpha');
  const beta = path.join(root, 'beta');
  let session = null;
  try {
    initRepo(alpha);
    initRepo(beta);
    fs.appendFileSync(path.join(alpha, 'app.js'), 'next\n');
    const store = new ReviewStore(
      path.join(alpha, '.plan', '2026-10-02-01.md'),
    );
    store.addTask('TODOs', 'ship tiles', false, 'backlog');
    store.addTask('TODOs', 'check diffs', false, 'issues');
    flushReview(store, true);
    const recorded = new RunRecorder(alpha, 'npm test');
    recorded.finish(0, { tests: 2, failed: 0 });
    const proc = fakeProc(root, { argv: ['node', 'reslop', root] });
    session = await loadSession(proc, {}, parseArgv([root]));
    assert.equal(session.pane, 'repos');
    assert.equal(session.workspaceRoot, path.resolve(root));
    assert.equal(session.repoName, path.basename(root));
    session.workspace.start();
    const ready = await waitUntil(() =>
      session.workspace.rows.every(
        (row) =>
          row.filesReady &&
          row.commitsReady &&
          row.diffReady &&
          row.tasksReady &&
          row.runsReady &&
          row.npmReady,
      ),
    );
    assert.equal(ready, true);
    const alphaRow = session.workspace.byName.get('alpha');
    assert.equal(alphaRow.tasksDone, 0);
    assert.equal(alphaRow.tasks, 2);
    assert.equal(alphaRow.commits, 1);
    assert.equal(alphaRow.diff.unstagedAdded > 0, true);
    assert.equal(alphaRow.run.status, 'passed');
    assert.equal(alphaRow.run.name, 'test');
    assert.equal(await countCommits(beta), 1);
    const diff = await readDiffStat(alpha);
    assert.equal(diff.stagedAdded, 0);
    assert.equal(diff.unstagedAdded > 0, true);
    assert.equal(taskStats(alpha).total, 2);
    assert.equal(pickRun(beta), null);
    const frame = renderFrame(session.view(), {
      width: 100,
      height: 30,
      color: false,
    });
    const text = stripAnsi(frame.text);
    assert.match(text, /alpha/);
    assert.match(text, /beta/);
    assert.match(text, /tasks: 0\/2/);
    assert.match(text, /diff: \+0\//);
    assert.equal(actionFromKey('left', 'repos'), 'repoLeft');
    assert.equal(actionFromKey('down', 'repos'), 'repoDown');
    session.workspace.cols = 2;
    session.workspace.move(1, 0);
    assert.equal(session.workspace.cursor, 1);
    session.workspace.move(-1, 0);
    session.draw();
    const hit = session.lastFrame.fileHits.find(
      (entry) => entry.cursor === 'beta',
    );
    assert.ok(hit);
    click(session, hit.x0 + 2, hit.y);
    assert.equal(session.pane, 'dashboard');
    assert.equal(session.cwd, beta);
    session.loader.abort();
    await session.loader.promise;
    onEscape(session);
    assert.equal(session.pane, 'repos');
    assert.equal(session.cwd, path.resolve(root));
    assert.equal(session.workspace.byName.get('alpha').tasks, 2);
    assert.equal(session.workspace.byName.get('alpha').filesReady, true);
    const back = renderFrame(session.view(), {
      width: 100,
      height: 30,
      color: false,
    });
    const again = stripAnsi(back.text);
    assert.match(again, /tasks: 0\/2/);
    assert.match(again, /diff: \+0\//);
    const quiet = fakeProc(root, { argv: ['node', 'reslop', root] });
    const code = await run(quiet);
    assert.equal(code, 1);
    assert.match(quiet.stderrText(), /interactive terminal required/);
    assert.doesNotMatch(quiet.stderrText(), /not a git repository/);
  } finally {
    if (session) stopSession(session);
    await removeTree(root);
  }
});

test('a deleted repository is removed from the workspace tiles', async () => {
  const root = tempDir('reslop-ws-');
  const alpha = path.join(root, 'alpha');
  const beta = path.join(root, 'beta');
  let session = null;
  try {
    initRepo(alpha);
    initRepo(beta);
    session = await loadSession(
      fakeProc(root, { argv: ['node', 'reslop', root] }),
      {},
      parseArgv([root]),
    );
    session.workspace.start();
    await removeTree(beta);
    session.workspace.notePaths(['beta']);
    await session.ops.idle();
    assert.deepEqual(
      session.workspace.rows.map((row) => row.name),
      ['alpha'],
    );
  } finally {
    if (session) stopSession(session);
    await removeTree(root);
  }
});
