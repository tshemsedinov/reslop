'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const runs = require('../lib/runs/runs.js');
const { RunRecorder, readRuns } = runs;
const dashModel = require('../lib/dashboard/model.js');
const { runName, buildModel, mergeRuns, groupChanges } = dashModel;
const tiles = require('../lib/render/tiles.js');
const { seg, paintTile } = tiles;
const dashTable = require('../lib/render/table.js');
const { ago } = require('../lib/common/format.js');
const { titleAside } = dashTable;
const dashboardPaint = require('../lib/render/dashboard.js');
const { runMetrics, branchesBlock, runsBlock, commitsBlock } = dashboardPaint;
const { agentsBlock } = require('../lib/render/agents.js');
const dashBlocks = require('../lib/render/dashboard-blocks.js');
const { filesBlock, diffsBlock, npmBlock, npmContent, tasksBlock } = dashBlocks;
const { parseReview } = require('../lib/review/review.js');
const ansi = require('../lib/term/ansi.js');
const { stripAnsi, visibleWidth, THEME, seq } = ansi;
const helpers = require('./helpers.js');
const { tempDir } = helpers;

test('npm packages take wanted and latest from the outdated report', () => {
  const outdatedMap = new Map([
    [
      'big',
      {
        current: '1.0.0',
        wanted: '1.2.0',
        latest: '2.0.0',
        type: 'dependencies',
      },
    ],
  ]);
  const model = buildModel({
    now: 1,
    frame: 0,
    busy: false,
    index: null,
    fileDelta: null,
    entries: [],
    totals: { added: 0, removed: 0 },
    activity: { minutes: [], live: false },
    diffDelta: null,
    git: null,
    switches: [],
    branchAt: new Map(),
    marks: { npm: 0, commit: 0, branches: 0 },
    npm: {
      hasManifest: true,
      deps: 2,
      dev: 0,
      modules: {
        bytes: 20,
        count: 2,
        packages: [
          { name: 'big', bytes: 14, dev: false, version: '1.0.0' },
          { name: 'small', bytes: 6, dev: false, version: '3.1.0' },
        ],
      },
    },
    npmExtras: {
      auditMap: new Map([['small', { severity: 'high' }]]),
      outdatedMap,
    },
    npmRun: null,
    runs: [],
    notes: { tasks: 0, tasksDone: 0, feedback: 0, code: 0 },
    store: { tasks: [] },
  });
  const packages = model.npm.modules.packages;
  assert.deepEqual(packages[0], {
    name: 'big',
    bytes: 14,
    dev: false,
    transitive: false,
    chain: '',
    audit: false,
    fix: '',
    range: '',
    severity: '',
    title: '',
    current: '1.0.0',
    wanted: '1.2.0',
    latest: '2.0.0',
  });
  assert.deepEqual(packages[1], {
    name: 'small',
    bytes: 6,
    dev: false,
    transitive: false,
    chain: '',
    audit: true,
    fix: '',
    range: '',
    severity: 'high',
    title: '',
    current: '3.1.0',
    wanted: '3.1.0',
    latest: '3.1.0',
  });
});

test('a fixed version is green and a still vulnerable one stays red', () => {
  const tile = { key: 'n', title: 'npm' };
  const model = {
    npm: {
      ready: true,
      hasManifest: true,
      deps: 1,
      dev: 0,
      modules: {
        bytes: 10,
        count: 1,
        packages: [
          {
            name: 'lodash',
            bytes: 10,
            current: '4.17.15',
            wanted: '4.17.20',
            latest: '4.17.21',
            audit: true,
            fix: '4.17.21',
            range: '<4.17.21',
            severity: 'high',
          },
        ],
      },
      audit: 1,
      outdated: 1,
      running: '',
    },
  };
  const block = npmContent(model.npm, 96, null, { now: 1, frame: 0 }, tile);
  const row = block.lines.find((line) =>
    line.some((part) => part.text === 'lodash'),
  );
  const tone = (value) => {
    const part = row.find((item) => item.text === value);
    return part ? part.tone : '';
  };
  assert.equal(tone('🛑 vulnerability detected'), 'error');
  assert.equal(tone('⚠️ outdated'), 'warn');
  assert.equal(tone('4.17.15'), 'error');
  assert.equal(tone('4.17.20'), 'error');
  assert.equal(tone('4.17.21'), 'add');
});

test('a transitive package is grey and shows its parent chain', () => {
  const tile = { key: 'n', title: 'npm' };
  const model = {
    npm: {
      ready: true,
      hasManifest: true,
      deps: 1,
      dev: 1,
      modules: {
        bytes: 9,
        count: 3,
        packages: [
          {
            name: 'one',
            bytes: 3,
            dev: false,
            transitive: false,
            chain: '',
            current: '1.0.0',
            wanted: '1.0.0',
            latest: '1.0.0',
          },
          {
            name: 'eslint',
            bytes: 3,
            dev: true,
            transitive: false,
            chain: '',
            current: '8.0.0',
            wanted: '8.0.0',
            latest: '8.0.0',
          },
          {
            name: 'three',
            bytes: 3,
            dev: false,
            transitive: true,
            chain: 'two 🢒 one',
            current: '1.0.0',
            wanted: '1.0.0',
            latest: '1.0.0',
          },
        ],
      },
      audit: 0,
      outdated: 0,
      running: '',
    },
  };
  const block = npmBlock(model, 80, 8, { now: 1, frame: 0 }, tile);
  const tone = (name) => {
    const row = block.lines.find((line) =>
      line.some((part) => part.text === name),
    );
    const part = row.find((item) => item.text === name);
    return part ? part.tone : '';
  };
  const text = (line) => line.map((part) => part.text).join('');
  const nested = block.lines.find((line) =>
    line.some((part) => part.text === 'three'),
  );
  assert.equal(tone('one'), 'dep');
  assert.equal(tone('eslint'), 'dev');
  assert.equal(tone('three'), 'pkg');
  const via = nested.find((part) => part.text.includes('🢒'));
  assert.equal(via.tone, 'chain');
  assert.match(text(nested), /three 🢒 two 🢒 one/);
  const chain = 'js-yaml 🢒 @eslint/eslintrc 🢒 eslint';
  const long = {
    ...model,
    npm: {
      ...model.npm,
      modules: {
        ...model.npm.modules,
        packages: [
          {
            ...model.npm.modules.packages[2],
            name: 'argparse',
            chain,
          },
        ],
      },
    },
  };
  const tight = npmBlock(long, 72, 6, { now: 1, frame: 0 }, tile);
  const tightRow = tight.lines
    .find((line) => line.some((part) => part.text.startsWith('argparse')))
    .map((part) => part.text)
    .join('');
  assert.match(tightRow, /argparse 🢒 js-yaml 🢒 @eslint\/eslintrc/);
  assert.match(tightRow, /1\.0\.0/);
});

test('the tasks header shows done against the total', () => {
  const tile = { key: 't', title: 'tasks' };
  const model = {
    tasks: {
      done: 3,
      total: 8,
      kinds: [
        { id: 'features', title: 'Feature requests', done: 1, total: 4 },
        { id: 'bugs', title: 'Bug reports', done: 1, total: 2 },
        { id: 'debt', title: 'Technical debt', done: 1, total: 1 },
        { id: 'research', title: 'Research', done: 0, total: 1 },
        { id: 'security', title: 'Security', done: 0, total: 0 },
      ],
      plan: '2026-10-09-00.md',
    },
  };
  const block = tasksBlock(model, 48, 6, { now: 1, frame: 0 }, tile);
  const text = (line) => line.map((part) => part.text).join('');
  const header = text(block.titleLine);
  const lines = block.lines.map(text);
  const body = lines.join('\n');
  const backlog = lines.find((line) => line.includes('Feature requests'));
  const total = lines.at(-1);
  const barAt = (line) => line.indexOf('─');
  assert.equal(header.startsWith('tasks'), true);
  assert.equal(header.endsWith('2026-10-09-00.md'), true);
  assert.equal(header.length, 48);
  const name = block.titleLine.find((part) => part.text === '2026-10-09-00.md');
  assert.equal(name.tone, 'caption');
  assert.equal(name.bold, false);
  const painted = paintTile(tile, block, 50, 8, true);
  const head = painted[0];
  const ink = seq(THEME.dashCaptionFg, THEME.dashHeadBg);
  assert.ok(head.includes(`${ink}2026-10-09-00.md`));
  assert.equal(stripAnsi(head).endsWith('2026-10-09-00.md '), true);
  assert.equal(header.includes('3/8'), false);
  assert.equal(header.includes('─'), false);
  assert.match(total, /^Total/);
  assert.equal(total.trimEnd().endsWith('3/8'), true);
  const caption = block.lines.at(-1).find((part) => part.text === 'Total');
  assert.equal(caption.tone, 'add');
  assert.equal(caption.bold, false);
  assert.ok(barAt(total) > 0);
  assert.ok(barAt(total) < total.lastIndexOf('3/8'));
  assert.ok(!total.includes('█'));
  assert.ok(!total.includes('░'));
  const securityAt = lines.findIndex((line) => line.includes('Security'));
  assert.equal(lines.indexOf(total), securityAt + 1);
  assert.match(body, /Bug reports/);
  assert.match(body, /1\/2/);
  assert.match(body, /Technical debt/);
  assert.match(body, /Research/);
  assert.match(body, /Security/);
  assert.equal(backlog.trimEnd().endsWith('1/4'), true);
  assert.ok(backlog.indexOf('Feature requests') < barAt(backlog));
  assert.ok(barAt(backlog) < backlog.lastIndexOf('1/4'));
  assert.ok(!backlog.includes('█'));
  assert.ok(!backlog.includes('░'));
  assert.match(body, /0\/1/);
  const row = block.lines.find((line) =>
    line.some((part) => `${part.text}`.includes('Feature requests')),
  );
  const dash = row.find((part) => part.text.includes('─'));
  const at = row.indexOf(dash);
  assert.equal(dash.tone, 'add');
  assert.equal(dash.bg ?? null, null);
  assert.equal(row[at - 1].text, ' ');
  const track = row[at + 1];
  assert.equal(track.tone, 'track');
  assert.match(track.text, /^─+$/);
  assert.equal(row[at + 2].text, ' ');
  const black = seq([0, 0, 0], THEME.dashTileBg);
  const paintedRow = painted.find((line) => line.includes('Feature requests'));
  assert.ok(paintedRow.includes(`${black}${track.text}`));
  const ratio = row.find((part) => part.text === '1/4');
  let gapAt = row.indexOf(ratio) - 1;
  while (gapAt > 0 && row[gapAt].text === '') gapAt -= 1;
  assert.equal(row[gapAt].text, ' ');
});

test('task tracks show zero, partial, and full completion', () => {
  const tile = { key: 't', title: 'tasks' };
  const kinds = [
    { title: 'Zero', done: 0, total: 4 },
    { title: 'Half', done: 2, total: 4 },
    { title: 'Full', done: 4, total: 4 },
  ];
  const model = { tasks: { done: 6, total: 12, kinds, plan: '' } };
  for (const width of [13, 14, 24, 48, 96]) {
    const block = tasksBlock(model, width, 4, {}, tile);
    for (const [index, kind] of kinds.entries()) {
      const line = block.lines[index];
      const text = line.map((part) => part.text).join('');
      assert.equal(visibleWidth(text), width);
      assert.match(text, new RegExp(`${kind.title} +─+ +${kind.done}/4$`));
      const bars = line.filter((part) => /─/.test(part.text));
      const total = bars.reduce((sum, part) => sum + part.text.length, 0);
      const green = bars.find((part) => part.tone === 'add');
      const black = bars.find((part) => part.tone === 'track');
      const completed = Math.round((kind.done / kind.total) * total);
      assert.equal(green?.text.length ?? 0, completed);
      assert.equal(black?.text.length ?? 0, total - completed);
    }
  }
});

test('dashboard tasks use short captions', () => {
  const model = buildModel({
    entries: [],
    runs: [],
    now: 1,
    frame: 0,
    marks: { commit: 0 },
    store: {
      reviewPath: '/repo/.plan/2026-10-09-00.md',
      tasks: [
        { text: 'ship', kind: 'features', done: true },
        { text: 'fix', kind: 'bugs', done: false },
      ],
    },
  });
  assert.equal(model.tasks.plan, '2026-10-09-00.md');
  const titles = model.tasks.kinds.map((kind) => kind.title);
  assert.deepEqual(titles, ['Features', 'Bug Reports']);
  const tile = { key: 't', title: 'tasks' };
  const block = tasksBlock(model, 48, 8, { now: 1, frame: 0 }, tile);
  const text = (line) => line.map((part) => part.text).join('');
  const body = block.lines.map(text).join('\n');
  assert.match(body, /Features/);
  assert.equal(body.includes('Feature requests'), false);
  assert.match(body, /Bug Reports/);
  assert.doesNotMatch(body, /Refactoring/);
  const painted = paintTile(tile, block, 50, 8, false);
  const shown = painted.find((line) => line.includes('Features'));
  assert.equal(shown.endsWith('1/1 '), true);
  assert.equal(shown.endsWith('1/1  '), false);
});

test('the tasks tile counts tasks of other blocks', () => {
  const text = [
    '# Notes',
    '',
    '- [ ] data loss on save',
    '- [x] high: already fixed',
    '- [ ] low: polish',
    '',
    '## Later',
    '',
    '- [ ] high: retry the handshake',
    '',
  ].join('\n');
  const store = parseReview(text, '/repo/specs/notes.md');
  const model = buildModel({
    entries: [],
    runs: [],
    now: 1,
    frame: 0,
    marks: { commit: 0 },
    store,
  });
  assert.deepEqual(model.tasks.kinds, [
    { id: 'other', title: 'Other', done: 1, total: 4 },
  ]);
  const tile = { key: 't', title: 'tasks' };
  const block = tasksBlock(model, 48, 8, { now: 1, frame: 0 }, tile);
  const line = (parts) => parts.map((part) => part.text).join('');
  assert.equal(line(block.titleLine).endsWith(' notes.md'), true);
  const rows = block.lines.map(line);
  assert.match(rows[0], /^Other .* 1\/4$/);
  assert.match(rows[1], /^Total .* 1\/4$/);
  assert.equal(rows.length, 2);
});

test('a title aside sits on the right of the header', () => {
  const tile = { key: 'c', title: 'commits' };
  const line = titleAside(tile, [seg('12', 'text', true)], 20);
  const text = line.map((item) => item.text).join('');
  assert.equal(text.length, 20);
  assert.equal(text.startsWith('commits'), true);
  assert.equal(text.endsWith('12'), true);
});

test('dashboard ages stay at minutes', () => {
  const now = 1_000_000;
  assert.equal(ago(now - 5000, now), '<1m ago');
  assert.equal(ago(now - 45 * 1000, now), '<1m ago');
  assert.equal(ago(now - 30 * 60 * 1000, now), '30m ago');
  assert.equal(ago(now - 3 * 3600 * 1000, now), '3h ago');
});

const metricText = (cells) =>
  cells.map((item) => item.segs.map((part) => part.text).join('')).join('|');

test('run rows show passed, failed and total counts', () => {
  const passed = runMetrics({
    status: 'passed',
    source: 'reslop t',
    result: { tests: 10, passed: 8, failed: 2 },
  });
  assert.equal(metricText(passed), '8|2|10');
  assert.equal(passed[1].align, 'r');
  const live = runMetrics({
    status: 'running',
    source: 'reslop t',
    done: 3,
    failed: 1,
    expected: 12,
    result: null,
  });
  assert.equal(metricText(live), '3|1|12');
  const session = runMetrics({
    status: 'running',
    source: 'reslop',
    done: 2,
    failed: 1,
    expected: 6,
    result: null,
  });
  assert.equal(metricText(session), '2|1|6');
  const failed = runMetrics({
    status: 'failed',
    source: 'reslop t',
    exit: 1,
    result: null,
    done: 0,
    failed: 0,
  });
  assert.equal(metricText(failed).includes('exit'), false);
});

test('run captions sit in the header with total and spent', () => {
  const now = 1_000_000;
  const model = {
    busy: '',
    runs: [
      {
        name: 'test',
        status: 'passed',
        source: 'reslop t',
        startedAt: now - 3200,
        endedAt: now - 200,
        done: 8,
        failed: 2,
        expected: 10,
        result: { tests: 10, passed: 8, failed: 2 },
      },
    ],
  };
  const tile = { key: 'r', title: 'run' };
  const block = runsBlock(model, 48, 4, { now, frame: 0 }, tile);
  const text = (line) => line.map((part) => part.text).join('');
  const header = text(block.titleLine);
  const row = text(block.lines[0]);
  const end = (line, value, from = 0) => {
    const at = line.indexOf(value, from);
    return visibleWidth(line.slice(0, at + value.length));
  };
  assert.equal(header.startsWith('run'), true);
  const spent = block.titleLine.find((part) => part.text === 'spent');
  assert.equal(spent.tone, 'caption');
  assert.equal(header.includes('done'), false);
  assert.equal(header.includes('duration'), false);
  assert.equal(row.includes('done'), false);
  assert.equal(end(header, 'ok'), end(row, '8'));
  assert.equal(end(header, 'fail'), end(row, '2'));
  assert.equal(end(header, 'total'), end(row, '10'));
  assert.equal(end(header, 'spent'), end(row, '3.0s'));
});

test('a running command spins on its row and not in the caption', () => {
  const now = 1_000_000;
  const model = {
    busy: 'npm test',
    runs: [
      {
        name: 'test',
        status: 'running',
        source: 'node --test',
        startedAt: now - 1000,
        endedAt: 0,
        done: 1,
        failed: 0,
        expected: 4,
        result: null,
      },
    ],
  };
  const tile = { key: 'r', title: 'run' };
  const block = runsBlock(model, 48, 6, { now, frame: 0 }, tile);
  const text = (line) => line.map((part) => part.text).join('');
  const header = text(block.titleLine);
  const body = block.lines.map(text).join('\n');
  assert.equal(header.includes('⠋'), false);
  assert.ok(body.includes('⠋'));
  assert.ok(body.includes('npm test'));
  assert.ok(body.includes('test'));
});

test('a long run command keeps the columns and shows an ellipsis', () => {
  const now = 1_000_000;
  const name = 'node --test test/dashboard.test.js';
  const model = {
    busy: '',
    runs: [
      {
        name,
        status: 'passed',
        source: 'reslop t',
        startedAt: now - 3200,
        endedAt: now - 200,
        done: 8,
        failed: 2,
        expected: 10,
        result: { tests: 10, passed: 8, failed: 2 },
      },
    ],
  };
  const tile = { key: 'r', title: 'run' };
  const block = runsBlock(model, 40, 4, { now, frame: 0 }, tile);
  const text = (line) => line.map((part) => part.text).join('');
  const header = text(block.titleLine);
  const row = text(block.lines[0]);
  assert.ok(header.includes('spent'));
  assert.equal(header.includes('duration'), false);
  assert.ok(row.includes('3.0s'));
  assert.ok(row.includes('…'));
  assert.equal(row.includes(name), false);
  assert.equal(visibleWidth(row), 40);
});

const runRecord = (command, script, startedAt, endedAt, extra = {}) => ({
  id: `${startedAt}`,
  command,
  script,
  status: extra.status || 'passed',
  exit: extra.exit ?? 0,
  startedAt,
  endedAt,
  progress: { done: 0, failed: 0, lines: 0, expected: 0 },
  result: extra.result ?? null,
});

test('chained npm script steps share one run row', () => {
  const lint = { errors: 1, warnings: 2, problems: 1 };
  const list = mergeRuns(
    [
      runRecord('eslint .', 'lint', 1000, 2000, { result: lint }),
      runRecord('prettier -c **/*.js', 'lint', 2086, 3000),
      runRecord('eslint . --fix', 'fix', 8000, 9000),
      runRecord('prettier --write **/*.js', 'fix', 9100, 10000, {
        status: 'failed',
        exit: 1,
      }),
      runRecord('npm run -s lint', 'test', 20000, 23000),
      runRecord('eslint .', 'lint', 20100, 21000),
      runRecord('prettier -c **/*.js', 'lint', 21100, 22900),
      runRecord('node --test', 'test', 23100, 28000, {
        result: { tests: 2, passed: 2, failed: 0 },
      }),
      runRecord('eslint .', 'lint', 40000, 41000),
    ],
    null,
  );
  assert.deepEqual(
    list.map((run) => run.name),
    ['lint', 'test', 'lint', 'fix', 'lint'],
  );
  const fix = list.find((run) => run.name === 'fix');
  assert.equal(fix.status, 'failed');
  assert.equal(fix.exit, 1);
  const first = list.at(-1);
  assert.equal(first.startedAt, 1000);
  assert.equal(first.endedAt, 3000);
  assert.equal(first.result.errors, 1);
  assert.equal(first.result.warnings, 2);
});

test('a new npm run refreshes the dashboard row', () => {
  const disk = runRecord('node --test', 'test', 5000, 0, {
    status: 'running',
  });
  disk.progress = { done: 1, failed: 0, lines: 1, expected: 4 };
  const live = {
    label: 'npm run test',
    name: 'test',
    running: true,
    exit: '',
    startedAt: 4900,
    endedAt: 0,
    progress: { done: 3, failed: 1, expected: 4 },
    result: null,
  };
  const started = {
    label: 'npm run lint',
    name: 'lint',
    running: true,
    exit: '',
    startedAt: 9000,
    endedAt: 0,
    progress: null,
    result: null,
  };
  const list = mergeRuns([disk], [live, started]);
  assert.deepEqual(
    list.map((run) => run.name),
    ['lint', 'test'],
  );
  assert.equal(list[1].done, 3);
  assert.equal(list[1].failed, 1);
  assert.equal(list[1].status, 'running');
  const saved = runRecord('node --test', 'test', 5000, 8000, {
    result: { tests: 4, passed: 3, failed: 1 },
  });
  const finished = { ...live, running: false, exit: 1, endedAt: 8000 };
  const kept = mergeRuns([saved], [finished, started]);
  assert.equal(kept.find((run) => run.name === 'test').source, 'reslop t');
  assert.equal(kept.find((run) => run.name === 'test').result.tests, 4);
});

test('diff groups keep staged lines apart from the total', () => {
  const groups = groupChanges([
    {
      path: 'lib/a.js',
      added: 5,
      removed: 2,
      stagedAdded: 3,
      stagedRemoved: 1,
      staged: 1,
      remaining: 2,
      date: '1 hour ago',
    },
  ]);
  const folder = groups.dirs[0];
  assert.equal(folder.stagedAdded, 3);
  assert.equal(folder.added, 5);
  assert.equal(folder.stagedRemoved, 1);
  assert.equal(folder.removed, 2);
  assert.equal(groups.exts[0].stagedAdded, 3);
});

test('run names use the npm script, or the command', () => {
  assert.equal(runName({ command: 'node --test', script: 'test' }), 'test');
  const nested = { command: 'npm run -s lint', script: 'test' };
  assert.equal(runName(nested), 'lint');
  assert.equal(runName({ command: 'eslint .', script: 'lint' }), 'lint');
  assert.equal(runName({ command: 'node --test', script: '' }), 'node --test');
});

test('commit counts use the header hotkey color', () => {
  const tile = { key: 'c', title: 'commits' };
  const model = {
    commits: {
      ready: true,
      info: { total: 12, recent: [] },
      rebase: null,
      changedAt: 0,
    },
  };
  const block = commitsBlock(model, 24, 4, { now: 1, frame: 0 }, tile);
  const count = block.titleLine.find((part) => part.text === '12');
  assert.equal(count.tone, 'key');
  assert.equal(count.bold, true);
});

test('agent status sits in the table and the header totals sessions', () => {
  const tile = { key: 'a', title: 'agents' };
  const model = {
    agents: {
      ready: true,
      installed: 2,
      total: 2,
      running: 3,
      items: [
        { name: 'claude', bin: '/bin/claude', model: 'sonnet', running: 2 },
        { name: 'cursor', bin: '', model: 'composer', running: 0 },
      ],
    },
  };
  const text = (line) => line.map((part) => part.text).join('');
  // The parts of one agent: its bubble, name, and optional session count
  const entryOf = (block, name) => {
    for (const line of block.lines) {
      const at = line.findIndex((part) => part.text === name);
      if (at < 0) continue;
      const before = line.slice(0, at + 1);
      const start = before.findLastIndex((part) => part.text === '●');
      return line.slice(start, at + 2);
    }
    return null;
  };
  for (let frame = 0; frame < 4; frame++) {
    const block = agentsBlock(model, 40, 4, { now: 1, frame }, tile);
    const header = text(block.titleLine);
    assert.equal(header.startsWith('agents'), true);
    assert.equal(header.endsWith('3'), true);
    assert.equal(header.includes('run'), false);
    assert.equal(header.includes('/'), false);
    const total = block.titleLine.find((part) => part.text === '3');
    assert.equal(total.tone, 'key');
    assert.equal(total.bold, true);
    const claude = entryOf(block, 'claude');
    const lit = frame % 2 === 0;
    assert.equal(claude[0].tone, lit ? 'add' : 'muted');
    const name = claude.find((part) => part.text === 'claude');
    assert.equal(name.tone, lit ? 'sha' : 'muted');
    const sessions = claude.find((part) => part.text === ' (2)');
    assert.equal(sessions.tone, lit ? 'add' : 'muted');
    assert.equal(sessions.bold, true);
    assert.equal(text(claude), '● claude (2)');
    const cursor = entryOf(block, 'cursor');
    assert.equal(cursor[0].tone, 'muted');
    assert.equal(cursor.find((part) => part.text === 'cursor').tone, 'muted');
    assert.equal(text(cursor).includes('0'), false);
    const shown = text(block.lines[0]);
    assert.equal(shown.includes('sonnet'), false);
    assert.equal(shown.includes('missing'), false);
  }
});

test('the agents panel lists agents in two columns', () => {
  const tile = { key: 'a', title: 'agents' };
  const names = ['claude', 'codex', 'cursor', 'junie', 'kilo'];
  const items = names.map((name) => ({ name, bin: `/bin/${name}` }));
  const model = { agents: { ready: true, running: 0, items } };
  const text = (line) => line.map((part) => part.text).join('');
  const ctx = { now: 1, frame: 0 };
  const block = agentsBlock(model, 40, 4, ctx, tile);
  const lines = block.lines.map(text);
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^● claude +● junie +$/);
  assert.match(lines[1], /^● codex +● kilo +$/);
  assert.match(lines[2], /^● cursor +$/);
  assert.equal(lines[0].indexOf('junie'), lines[1].indexOf('kilo'));
  for (const line of block.lines) assert.ok(visibleWidth(text(line)) <= 40);
  const low = agentsBlock(model, 40, 2, ctx, tile).lines.map(text);
  assert.equal(low.length, 2);
  assert.match(low[0], /claude.*cursor/);
  assert.match(low[1], /codex.*junie/);
  const narrow = agentsBlock(model, 12, 6, ctx, tile).lines.map(text);
  assert.equal(narrow.length, 5);
  assert.match(narrow[0], /^● claude +$/);
  assert.match(narrow[4], /^● kilo +$/);
});

const lineText = (line) => line.map((part) => part.text).join('');

const messageAt = (rows, message) =>
  rows.findIndex((row) => row.includes(message));

const assertCentered = (rows, message) => {
  const body = rows.slice(1);
  const at = messageAt(body, message);
  assert.ok(at >= 0, message);
  assert.equal(at, Math.floor((body.length - 1) / 2), message);
  const start = body[at].indexOf(message);
  const after = body[at].length - start - message.length;
  assert.ok(Math.abs(start - after) <= 1, message);
};

test('empty dashboard panels center their message', () => {
  const ctx = { now: 1, frame: 0 };
  const paint = (block, tile) => paintTile(tile, block, 42, 6, false);
  const diffTile = { key: 'd', title: 'diffs' };
  const diff = diffsBlock(
    { diffs: { files: 0, dirs: [], exts: [], activity: { minutes: [] } } },
    40,
    5,
    ctx,
    diffTile,
  );
  assert.equal(lineText(diff.lines[0]), 'working tree clean');
  assert.equal(diff.lines[0][0].tone, 'muted');
  assertCentered(paint(diff, diffTile), 'working tree clean');

  const fileTile = { key: 'f', title: 'files' };
  const files = filesBlock(
    {
      files: {
        ready: true,
        total: { files: 0, bytes: 0, lines: 0 },
        dirs: [],
        exts: [],
      },
    },
    40,
    5,
    ctx,
    fileTile,
  );
  assertCentered(paint(files, fileTile), 'no files');

  const taskTile = { key: 't', title: 'tasks' };
  const tasks = tasksBlock(
    { tasks: { done: 0, total: 0, kinds: [], plan: '2026-10-10-00.md' } },
    40,
    5,
    ctx,
    taskTile,
  );
  assert.match(lineText(tasks.titleLine), /2026-10-10-00\.md/);
  assertCentered(paint(tasks, taskTile), 'no tasks');

  const branchTile = { key: 'b', title: 'branches' };
  const branches = branchesBlock(
    {
      branches: {
        ready: true,
        list: [],
        rebase: null,
        switches: [],
        hot: new Map(),
      },
    },
    40,
    5,
    ctx,
    branchTile,
  );
  assert.match(lineText(branches.titleLine), /^branches/);
  assertCentered(paint(branches, branchTile), 'no branches');

  const commitTile = { key: 'c', title: 'commits' };
  const commits = commitsBlock(
    {
      commits: {
        ready: true,
        info: { total: 0, recent: [] },
        rebase: null,
        changedAt: 0,
      },
    },
    40,
    5,
    ctx,
    commitTile,
  );
  assertCentered(paint(commits, commitTile), 'no commits');

  const runTile = { key: 'r', title: 'run' };
  const idleRun = runsBlock({ busy: '', runs: [] }, 40, 5, ctx, runTile);
  const idleLines = idleRun.lines.map(lineText);
  assert.deepEqual(idleLines, ['idle', 'reslop t -- <command>']);
  const runRows = paint(idleRun, runTile).slice(1);
  assert.equal(messageAt(runRows, 'idle'), 1);
  assert.equal(messageAt(runRows, 'reslop t -- <command>'), 2);
  const idle = runRows[1];
  const idleAt = idle.indexOf('idle');
  assert.ok(Math.abs(idleAt - (idle.length - idleAt - 4)) <= 1);

  const npmTile = { key: 'n', title: 'npm' };
  const npm = npmBlock(
    {
      npm: {
        ready: true,
        hasManifest: true,
        deps: 0,
        dev: 0,
        modules: { count: 0, bytes: 0, packages: [] },
        audit: 0,
        outdated: 0,
        running: '',
      },
    },
    40,
    5,
    ctx,
    npmTile,
  );
  assertCentered(paint(npm, npmTile), 'no packages');

  const agentTile = { key: 'a', title: 'agents' };
  const agents = agentsBlock(
    { agents: { ready: true, running: 0, items: [] } },
    40,
    5,
    ctx,
    agentTile,
  );
  assertCentered(paint(agents, agentTile), 'no agents');

  const scan = filesBlock({ files: { ready: false } }, 40, 5, ctx, fileTile);
  assertCentered(paint(scan, fileTile), 'scanning…');
});

test('diff groups show the age of the newest file', () => {
  const groups = groupChanges([
    { path: 'lib/a.js', date: '2h ago' },
    { path: 'lib/b.js', date: '5m ago' },
    { path: 'lib/c.js', date: '3 days ago' },
  ]);
  assert.equal(groups.dirs[0].date, '5m ago');
  assert.equal(groups.exts[0].date, '5m ago');
});

test('pruning keeps the newest run records whatever their names', () => {
  const dir = tempDir('reslop-runs-');
  try {
    const startedAt = Date.now();
    let now = startedAt;
    const clock = () => now;
    for (let i = 0; i < 30; i++) {
      now += 1000;
      new RunRecorder(dir, 'zeta --check', { now: clock }).finish(0);
    }
    now += 1000;
    const newest = new RunRecorder(dir, 'alpha --lint', { now: clock });
    now += 1000;
    new RunRecorder(dir, 'zeta --check', { now: clock }).finish(0);
    const kept = readRuns(dir);
    const found = kept.find((record) => record.id === newest.record.id);
    assert.ok(found, 'the newest alpha record was pruned');
    assert.equal(found.status, 'running');
    const oldest = Math.min(...kept.map((record) => record.startedAt));
    assert.ok(oldest > startedAt + 1000);
    newest.finish(0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
