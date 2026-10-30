'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const runs = require('../../lib/runs/runs.js');
const { Tracker, RunRecorder, readRuns, settleRecord } = runs;
const { summarizeDocument, isRunsRel, commandLabel } = runs;
const tree = require('../../lib/dashboard/tree.js');
const { FileIndex, folderOf, extOf } = tree;
const { readGitSummary } = require('../../lib/dashboard/git.js');
const { parseTrack } = require('../../lib/git/branches.js');
const { readNpmSummary } = require('../../lib/dashboard/npm.js');
const tiles = require('../../lib/render/tiles.js');
const { layoutTiles, GAP_X, GAP_Y } = tiles;
const dashboardPaint = require('../../lib/render/dashboard.js');
const { TILES, paintBodyDashboard } = dashboardPaint;
const dashboardSession = require('../../lib/session/dashboard.js');
const { Dashboard, classify, ageDelay } = dashboardSession;
const { UNKNOWN_PATH } = require('../../lib/dashboard/watch.js');
const { actionFromKey, DASH_BLOCKS } = require('../../lib/input/actions.js');
const helpers = require('../helpers.js');
const { makeRepo, tempDir, waitUntil } = helpers;
const { openDashboard, frameText } = helpers;

const PASS = '✔ ok (1ms)';

test('the tracker counts passing and failing test lines', () => {
  const tracker = new Tracker();
  tracker.feed(`${PASS}\n✖ broken (1ms)\nplain\n✔ half`);
  assert.equal(tracker.progress.done, 1);
  assert.equal(tracker.progress.failed, 1);
  assert.equal(tracker.progress.lines, 3);
  tracker.feed(' done (1ms)\n');
  assert.equal(tracker.progress.done, 2);
});

test('command labels use the program base name', () => {
  assert.equal(commandLabel('/usr/bin/node', ['--test']), 'node --test');
  assert.ok(isRunsRel('.log/.runs/1-2.json'));
  assert.ok(isRunsRel('.log/.runs'));
  assert.ok(isRunsRel('.log/2026-10-10-node-01.log'));
  assert.ok(!isRunsRel('.log/other.md'));
});

test('a run record is written, updated, finished and read back', () => {
  const dir = tempDir('reslop-runs-');
  try {
    let now = Date.now();
    const startedAt = now;
    const clock = () => now;
    const run = new RunRecorder(dir, 'node --test', { now: clock });
    const [live] = readRuns(dir);
    assert.equal(live.status, 'running');
    assert.equal(live.command, 'node --test');
    now += 500;
    run.feed(`${PASS}\n${PASS}\n`);
    assert.equal(readRuns(dir)[0].progress.done, 2);
    now += 500;
    run.finish(0, { tests: 2 });
    const [done] = readRuns(dir);
    assert.equal(done.status, 'passed');
    assert.equal(done.exit, 0);
    assert.equal(done.result.tests, 2);
    assert.equal(done.endedAt, startedAt + 1000);
    now += 1000;
    const second = new RunRecorder(dir, 'node --test', { now: clock });
    assert.ok(second.record.id);
    const expected = readRuns(dir).find((r) => r.status === 'running');
    assert.equal(expected.progress.expected, 2);
    second.finish(0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a running record needs a live process and a fresh heartbeat', () => {
  const now = () => 10000;
  const record = { v: 2, status: 'running', pid: 1, activeAt: 9000 };
  assert.equal(settleRecord(record, () => false, now).status, 'aborted');
  assert.equal(settleRecord(record, () => true, now).status, 'running');
  const stale = { ...record, activeAt: 4000 };
  assert.equal(settleRecord(stale, () => true, now).status, 'aborted');
  const legacy = { v: 1, status: 'running', pid: 1 };
  assert.equal(settleRecord(legacy, () => true, now).status, 'aborted');
  const passed = { status: 'passed', pid: 1 };
  assert.equal(settleRecord(passed, () => false, now).status, 'passed');
});

test('an interrupted run ends at its last heartbeat across reads', () => {
  const record = {
    v: 2,
    status: 'running',
    pid: 1,
    startedAt: 1000,
    activeAt: 4000,
    endedAt: 0,
  };
  for (const current of [10000, 70000]) {
    const settled = settleRecord(
      record,
      () => true,
      () => current,
    );
    assert.equal(settled.status, 'aborted');
    assert.equal(settled.endedAt, 4000);
  }
  const dead = settleRecord(
    record,
    () => false,
    () => 5000,
  );
  assert.equal(dead.endedAt, 4000);
  const legacy = { ...record, v: 1, activeAt: undefined };
  assert.equal(settleRecord(legacy).endedAt, 1000);
  assert.equal(record.endedAt, 0);
});

const scriptEnv = (name) => {
  const env = {};
  env['npm_lifecycle_event'] = name;
  return env;
};

test('a run records the npm script that started it', () => {
  const dir = tempDir('reslop-runs-');
  try {
    const run = new RunRecorder(dir, 'node --test', { env: scriptEnv('test') });
    assert.equal(readRuns(dir)[0].script, 'test');
    run.finish(0);
    const lint = new RunRecorder(dir, 'eslint . --fix', {
      env: scriptEnv('fix'),
    });
    const runs = readRuns(dir);
    const saved = runs.find((item) => item.command.startsWith('eslint'));
    assert.equal(saved.script, 'fix');
    lint.finish(0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a failed run keeps its exit code', () => {
  const dir = tempDir('reslop-runs-');
  try {
    const run = new RunRecorder(dir, 'eslint .');
    run.finish(2);
    const [record] = readRuns(dir);
    assert.equal(record.status, 'failed');
    assert.equal(record.exit, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('summarizeDocument sums the report summaries', () => {
  const doc = {
    reports: [
      {
        tool: 'test',
        problems: [{}, {}],
        summary: { tests: 3, passed: 2, failed: 1, duration: '4ms' },
      },
      { tool: 'eslint', problems: [], summary: { errors: 0 } },
    ],
  };
  const sum = summarizeDocument(doc);
  assert.deepEqual(sum.tools, ['test', 'eslint']);
  assert.equal(sum.tests, 3);
  assert.equal(sum.failed, 1);
  assert.equal(sum.errors, 0);
  assert.equal(sum.problems, 2);
  assert.equal(summarizeDocument(null), null);
});

test('folder and extension helpers group root files', () => {
  assert.equal(folderOf('lib/a/b.js'), 'lib');
  assert.equal(folderOf('a.js'), tree.ROOT_DIR);
  assert.equal(extOf('lib/a.test.js'), '.js');
  assert.equal(extOf('Makefile'), tree.NO_EXT);
});

test('FileIndex sizes files per folder and per extension', async () => {
  const repo = makeRepo();
  try {
    repo.write('lib/a.js', 'one\ntwo\n');
    repo.write('lib/b.md', 'x\n');
    repo.write('top.js', 'a\n');
    repo.write('.gitignore', 'skip/\n');
    repo.write('skip/c.js', 'ignored\n');
    const index = new FileIndex(repo.dir);
    await index.rescan();
    const { total, dirs, exts } = index.summary();
    assert.equal(total.files, 4);
    const lib = dirs.find((d) => d.key === 'lib');
    assert.equal(lib.files, 2);
    assert.equal(lib.lines, 3);
    const js = exts.find((e) => e.key === '.js');
    assert.equal(js.files, 2);
    assert.ok(!dirs.some((d) => d.key === 'skip'));
    assert.equal(index.entries.get('lib/a.js').size, 8);
  } finally {
    repo.cleanup();
  }
});

test('FileIndex touch applies edits, additions and removals', async () => {
  const repo = makeRepo();
  try {
    repo.write('a.js', 'one\n');
    const index = new FileIndex(repo.dir);
    await index.rescan();
    const before = index.summary().total;
    assert.equal(before.lines, 1);
    repo.write('a.js', 'one\ntwo\nthree\n');
    assert.equal(await index.touch(['a.js']), true);
    assert.equal(index.summary().total.lines, 3);
    assert.ok(index.hot(Date.now()).exts.has('.js'));
    repo.write('lib/n.js', 'x\n');
    await index.touch(['lib/n.js']);
    assert.equal(index.summary().total.files, 2);
    fs.rmSync(path.join(repo.dir, 'a.js'));
    await index.touch(['a.js']);
    assert.equal(index.summary().total.files, 1);
    assert.equal(await index.touch(['a.js']), false);
  } finally {
    repo.cleanup();
  }
});

test('FileIndex ignores node_modules and git internals on touch', async () => {
  const repo = makeRepo();
  try {
    repo.write('a.js', 'one\n');
    const index = new FileIndex(repo.dir);
    await index.rescan();
    repo.write('node_modules/x/i.js', 'z\n');
    await index.touch(['node_modules/x/i.js', '.git/HEAD']);
    assert.equal(index.summary().total.files, 1);
  } finally {
    repo.cleanup();
  }
});

test('git branch tracking is parsed from the upstream track', () => {
  assert.deepEqual(parseTrack('[ahead 2, behind 1]'), {
    ahead: 2,
    behind: 1,
    gone: false,
  });
  assert.equal(parseTrack('[gone]').gone, true);
});

test('readGitSummary reports commits and branches', async () => {
  const repo = makeRepo();
  try {
    repo.write('a.js', 'one\n');
    repo.git(['add', '.']);
    repo.git(['commit', '-m', 'first']);
    repo.write('a.js', 'two\n');
    repo.git(['commit', '-am', 'fixup! first']);
    repo.git(['branch', 'topic']);
    const summary = await readGitSummary(repo.dir);
    assert.equal(summary.branch, 'main');
    assert.equal(summary.commits.total, 2);
    assert.equal(summary.commits.last.subject, 'fixup! first');
    assert.equal(summary.commits.recent[0].subject, 'fixup! first');
    assert.equal(summary.commits.recent[1].subject, 'first');
    assert.equal(summary.rebase, null);
    const names = summary.branches.map((b) => b.name).sort();
    assert.deepEqual(names, ['main', 'topic']);
    assert.ok(summary.branches.find((b) => b.name === 'main').current);
  } finally {
    repo.cleanup();
  }
});

test('readGitSummary tracks branches against their upstream', async () => {
  const origin = makeRepo();
  const clone = makeRepo();
  try {
    origin.write('a.js', 'one\n');
    origin.git(['add', '.']);
    origin.git(['commit', '-m', 'first']);
    clone.git(['remote', 'add', 'origin', origin.dir]);
    clone.git(['fetch', 'origin']);
    clone.git(['reset', '--hard', 'origin/main']);
    clone.git(['branch', '--set-upstream-to=origin/main', 'main']);
    clone.write('b.js', 'x\n');
    clone.git(['add', '.']);
    clone.git(['commit', '-m', 'local']);
    const summary = await readGitSummary(clone.dir);
    assert.equal(summary.commits.total, 2);
    const main = summary.branches.find((b) => b.name === 'main');
    assert.equal(main.ahead, 1);
    assert.equal(main.behind, 0);
  } finally {
    origin.cleanup();
    clone.cleanup();
  }
});

test('readGitSummary survives a repository without commits', async () => {
  const repo = makeRepo();
  try {
    const summary = await readGitSummary(repo.dir);
    assert.equal(summary.commits.total, 0);
    assert.equal(summary.commits.last, null);
    assert.deepEqual(summary.commits.recent, []);
  } finally {
    repo.cleanup();
  }
});

test('readNpmSummary counts dependencies, scripts and modules', async () => {
  const dir = tempDir('reslop-npm-');
  try {
    const manifest = {
      name: 'demo',
      scripts: { test: 'node --test', lint: 'eslint .' },
      dependencies: { a: '1' },
      devDependencies: { b: '1', c: '1', big: '1' },
    };
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(manifest));
    const modules = path.join(dir, 'node_modules');
    fs.mkdirSync(path.join(modules, 'a'), { recursive: true });
    fs.writeFileSync(path.join(modules, 'a', 'i.js'), '12345');
    fs.mkdirSync(path.join(modules, 'big'), { recursive: true });
    fs.writeFileSync(path.join(modules, 'big', 'i.js'), '123456789');
    const scoped = path.join(modules, '@scope', 'pkg');
    fs.mkdirSync(scoped, { recursive: true });
    fs.writeFileSync(path.join(scoped, 'i.js'), '123456');
    const lock = {
      packages: {
        'node_modules/a': { version: '1.2.3' },
        'node_modules/big': { dev: true },
        'node_modules/@scope/pkg': { dev: true },
      },
    };
    const stamp = path.join(modules, '.package-lock.json');
    fs.writeFileSync(stamp, JSON.stringify(lock));
    const summary = await readNpmSummary(dir, null);
    assert.equal(summary.hasManifest, true);
    assert.equal(summary.deps, 1);
    assert.equal(summary.dev, 3);
    const lockBytes = fs.statSync(stamp).size;
    assert.equal(summary.modules.bytes, 20 + lockBytes);
    assert.equal(summary.modules.count, 3);
    assert.deepEqual(summary.modules.packages, [
      {
        name: 'a',
        bytes: 5,
        dev: false,
        transitive: false,
        chain: '',
        version: '1.2.3',
      },
      {
        name: 'big',
        bytes: 9,
        dev: true,
        transitive: false,
        chain: '',
        version: '',
      },
      {
        name: '@scope/pkg',
        bytes: 6,
        dev: false,
        transitive: true,
        chain: '',
        version: '',
      },
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readNpmSummary chains transitive packages', async () => {
  const dir = tempDir('reslop-npm-');
  try {
    const manifest = { dependencies: { one: '1' } };
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(manifest));
    const modules = path.join(dir, 'node_modules');
    for (const name of ['one', 'two', 'three']) {
      fs.mkdirSync(path.join(modules, name), { recursive: true });
      fs.writeFileSync(path.join(modules, name, 'i.js'), name);
    }
    const lock = {
      packages: {
        '': { dependencies: { one: '1' } },
        'node_modules/one': { version: '1.0.0', dependencies: { two: '1' } },
        'node_modules/two': { version: '1.0.0', dependencies: { three: '1' } },
        'node_modules/three': { version: '1.0.0' },
      },
    };
    const stamp = path.join(modules, '.package-lock.json');
    fs.writeFileSync(stamp, JSON.stringify(lock));
    const summary = await readNpmSummary(dir, null);
    const byName = new Map(
      summary.modules.packages.map((row) => [row.name, row]),
    );
    assert.equal(byName.get('one').transitive, false);
    assert.equal(byName.get('one').dev, false);
    assert.equal(byName.get('two').transitive, true);
    assert.equal(byName.get('two').chain, 'one');
    assert.equal(byName.get('three').chain, 'two 🢒 one');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readNpmSummary reports a project without a manifest', async () => {
  const dir = tempDir('reslop-npm-');
  try {
    const summary = await readNpmSummary(dir, null);
    assert.equal(summary.hasManifest, false);
    assert.equal(summary.deps, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('classify sorts watcher paths into refresh groups', () => {
  const found = classify([
    'lib/a.js',
    '.git/HEAD',
    '.git/objects/ab',
    '.log/.runs/1-2.json',
    'package.json',
  ]);
  assert.deepEqual(found.files, ['lib/a.js', 'package.json']);
  assert.equal(found.git, true);
  assert.equal(found.runs, true);
  assert.equal(found.npm, true);
  assert.equal(found.all, false);
  assert.equal(classify([UNKNOWN_PATH]).all, true);
});

test('the age label refreshes slower as commits get older', () => {
  assert.equal(ageDelay(1000), 1000);
  assert.equal(ageDelay(10 * 60000), 30000);
  assert.equal(ageDelay(5 * 3600000), 600000);
});

const quietDashboard = () => {
  const started = [];
  const stopped = [];
  const timers = [];
  const ui = {
    uiOpen: true,
    nav: { pane: 'dashboard' },
    npm: { lastRun: null },
    progress: {
      start: (id) => started.push(id),
      stop: (id) => stopped.push(id),
    },
    term: {
      later: (name, fn, ms) => timers.push({ name, fn, ms }),
      cancel: () => {},
    },
  };
  const dash = new Dashboard(ui);
  dash.active = true;
  return { dash, started, stopped, timers };
};

test('the current minute blinks for three seconds after activity', () => {
  const { dash } = quietDashboard();
  const now = 5_000_000;
  dash.heat(now, 4);
  assert.equal(dash.liveActivity(now + 2999), true);
  assert.equal(dash.liveActivity(now + 3000), false);
  dash.heat(now + 1000, 1);
  assert.equal(dash.liveActivity(now + 3999), true);
  assert.equal(dash.liveActivity(now + 4000), false);
  dash.mark(now + 2000, 'commit');
  dash.mark(now + 8000, 'commit');
  assert.equal(dash.liveActivity(now + 5000), false);
  dash.heat(now, 2, 9);
  const minute = dash.activityView(now).minutes[0];
  assert.equal(minute.removed > minute.added, true);
  dash.runs = [
    { v: 2, status: 'running', pid: process.pid, activeAt: Date.now() },
  ];
  assert.equal(dash.liveActivity(now + 20_000), true);
});

test('the blink timer stops the current cell after three seconds', () => {
  const { dash, started, stopped, timers } = quietDashboard();
  const now = Date.now();
  dash.activityAt = now - 1000;
  dash.afterDraw();
  const blink = timers.find((row) => row.name === 'dashboard-blink');
  assert.ok(started.includes('dashboard'));
  assert.ok(blink.ms > 1500 && blink.ms <= 2020);
  dash.activityAt = Date.now() - 4000;
  started.length = 0;
  dash.afterDraw();
  assert.ok(stopped.includes('dashboard'));
  assert.equal(started.includes('dashboard'), false);
});

const sampleTiles = () =>
  ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((id, rank) => ({
    id,
    key: id,
    title: id,
    rank,
  }));

test('layoutTiles fills the width and keeps the gaps', () => {
  const bands = layoutTiles(120, 40, sampleTiles());
  const shown = bands.flatMap((band) => band.tiles);
  assert.equal(shown.length, 7);
  assert.ok(bands.length >= 2);
  const first = bands[0];
  const last = first.tiles.at(-1);
  assert.equal(last.x + last.w, 120);
  const [left, right] = first.tiles;
  assert.equal(right.x - (left.x + left.w), GAP_X);
  assert.equal(bands[1].y - (first.y + first.h), GAP_Y);
});

test('layoutTiles drops the least important tiles when short', () => {
  const bands = layoutTiles(80, 14, sampleTiles());
  const ids = bands.flatMap((band) => band.tiles.map((tile) => tile.id));
  assert.ok(ids.length < 7);
  assert.ok(ids.includes('a'));
  assert.ok(!ids.includes('g'));
});

test('layoutTiles stacks tiles in one column on a narrow terminal', () => {
  const bands = layoutTiles(40, 60, sampleTiles());
  for (const band of bands) assert.equal(band.tiles.length, 1);
});

test('wide tiles take half a row instead of a third', () => {
  const bands = layoutTiles(120, 40, TILES);
  const byId = new Map(TILES.map((tile) => [tile.id, tile]));
  for (const band of bands) {
    if (band.tiles.length < 3) continue;
    for (const place of band.tiles) {
      assert.equal(byId.get(place.id).size, 'normal');
    }
  }
  const mid = bands.find((band) =>
    band.tiles.some((place) => place.id === 'branches'),
  );
  assert.equal(mid.tiles.length, 2);
  assert.deepEqual(
    mid.tiles.map((place) => place.id),
    ['branches', 'commits'],
  );
  const [left, right] = mid.tiles;
  assert.equal(right.x - (left.x + left.w), GAP_X);
  assert.ok(left.w >= 50);
  assert.ok(right.w >= 50);
});

test('the dashboard pane without a model paints blank', () => {
  const result = paintBodyDashboard({ dashboard: null }, 60, false, 10, 1);
  assert.equal(result.body.length, 10);
  for (const row of result.body) assert.equal(row.trim(), '');
});

test('dashboard hotkeys map to their blocks', () => {
  const pairs = {
    f: 'files',
    d: 'diffs',
    c: 'commits',
    b: 'branches',
    n: 'npm',
    r: 'run',
    t: 'tasks',
    a: 'agents',
  };
  for (const [key, block] of Object.entries(pairs)) {
    assert.equal(DASH_BLOCKS[actionFromKey(key, 'dashboard')], block);
  }
});

test('a dashboard session shows every block with live data', async () => {
  const { ui, close } = await openDashboard();
  try {
    assert.equal(ui.pane, 'dashboard');
    assert.ok(await waitUntil(() => /first commit/.test(frameText(ui))));
    const text = frameText(ui);
    const body = text.split('\n').slice(1, -2).join('\n');
    const titles = ['files', 'diffs', 'commits', 'branches'];
    titles.push('npm', 'agents', 'run', 'tasks');
    const hits = ui.lastFrame.fileHits.map((hit) => hit.cursor);
    for (const title of titles) {
      assert.match(body, new RegExp(`(^|\\s)${title}[\\s─]`, 'm'), title);
      assert.ok(hits.includes(title), title);
    }
    assert.match(body, /main/);
    assert.match(text, /\+0\/1\s+-0\/0/);
    assert.match(text, /0\/1/);
    assert.match(text, /📁 lib/);
  } finally {
    await close();
  }
});

test('the dashboard follows files changing on disk', async () => {
  const { ui, repo, close } = await openDashboard();
  try {
    assert.ok(await waitUntil(() => /first commit/.test(frameText(ui))));
    const before = ui.dashboard.view().files.total.lines;
    repo.write('lib/a.js', 'one\ntwo\nthree\nfour\nfive\nsix\n');
    const grew = () => ui.dashboard.view().files.total.lines > before;
    assert.ok(await waitUntil(grew));
  } finally {
    await close();
  }
});

test('the dashboard shows a run by script name', async () => {
  const { ui, repo, close } = await openDashboard();
  try {
    assert.ok(await waitUntil(() => /first commit/.test(frameText(ui))));
    const run = new RunRecorder(repo.dir, 'node --test', {
      env: scriptEnv('test'),
    });
    run.feed(`${PASS}\n`);
    const seen = () => {
      const text = frameText(ui);
      const runs = ui.dashboard.view().runs;
      const listed = runs.some((item) => item.name === 'test');
      const hidden = !text.includes('node --test');
      return listed && text.includes('test') && hidden;
    };
    assert.ok(await waitUntil(seen));
    run.finish(0, null);
    const finished = () => {
      const [shown] = ui.dashboard.view().runs;
      return shown.name === 'test' && shown.status === 'passed';
    };
    assert.ok(await waitUntil(finished));
  } finally {
    await close();
  }
});

test('the dashboard run panel shows a newly started command', async () => {
  const { ui, close } = await openDashboard();
  try {
    assert.ok(await waitUntil(() => /first commit/.test(frameText(ui))));
    const now = Date.now();
    ui.npm.runs.push({
      id: 1,
      name: 'test',
      kind: 'script',
      command: 'node --test',
      label: 'npm run test',
      status: 'running',
      exit: '',
      startedAt: now,
      endedAt: 0,
      progress: { done: 2, failed: 1, expected: 6 },
      result: null,
    });
    const listed = ui.dashboard.view().runs.find((run) => run.name === 'test');
    assert.equal(listed.status, 'running');
    assert.equal(listed.done, 2);
    assert.equal(listed.failed, 1);
    ui.npm.runs.push({
      id: 2,
      name: 'lint',
      kind: 'script',
      command: 'eslint .',
      label: 'npm run lint',
      status: 'running',
      exit: '',
      startedAt: now + 5,
      endedAt: 0,
      progress: null,
      result: null,
    });
    const names = ui.dashboard.view().runs.map((run) => run.name);
    assert.equal(names[0], 'lint');
    assert.ok(names.includes('test'));
    const text = frameText(ui);
    assert.match(text, /lint/);
    assert.match(text, /test/);
  } finally {
    await close();
  }
});
