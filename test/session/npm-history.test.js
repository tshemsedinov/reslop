'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const helpers = require('../helpers.js');
const { press, click } = helpers;
const ansi = require('../../lib/term/ansi.js');
const { stripAnsi } = ansi;
const { logViewRows } = require('../../lib/render/log.js');
const { dateStamp } = require('../../lib/common/utilities.js');
const sessionHelpers = require('../session-helpers.js');
const { sampleItem, openSession, shiftClick, frameBody } = sessionHelpers;

const daysAgoStamp = (ago) => {
  const date = new Date();
  date.setDate(date.getDate() - ago);
  return dateStamp(date);
};

test('the run screen follows an outside reslop t', async () => {
  const { session, cwd } = await openSession([sampleItem('a.js')], {
    startPane: 'files',
  });
  const dir = path.join(cwd, '.log');
  fs.mkdirSync(dir);
  const file = path.join(dir, '2026-10-10-node-01.json');
  const write = (extra) => {
    const record = {
      v: 2,
      id: 'outside',
      pid: process.pid,
      command: 'node --test',
      script: 'test',
      startedAt: 5_000,
      endedAt: 0,
      activeAt: Date.now(),
      status: 'running',
      exit: null,
      progress: { done: 2, failed: 1, lines: 4, expected: 10 },
      result: null,
      log: '2026-10-10-node-01.log',
      raw: '2026-10-10-node-01.raw',
      ...extra,
    };
    fs.writeFileSync(file, `${JSON.stringify(record)}\n`);
  };
  write();
  session.pushInput('r');
  session.dashboard.noteDisk(['.log/2026-10-10-node-01.json']);
  let rows = session.npm.sessionRows();
  assert.equal(rows[0].name, 'test');
  assert.equal(rows[0].live, true);
  assert.equal(rows[0].mark, 'run');
  assert.equal(rows[0].done, '3');
  assert.equal(rows[0].ok, '2');
  assert.equal(rows[0].fail, '1');
  assert.equal(rows[0].total, '10');
  const shown = frameBody(session).join('\n');
  assert.match(shown, /⠋/);
  assert.match(shown, /test/);
  write({
    progress: { done: 4, failed: 1, lines: 8, expected: 10 },
  });
  session.dashboard.noteDisk(['.log/2026-10-10-node-01.json']);
  rows = session.npm.sessionRows();
  assert.equal(rows[0].done, '5');
  assert.equal(rows[0].ok, '4');
  assert.equal(rows[0].live, true);
  write({
    status: 'failed',
    exit: 1,
    endedAt: 8_000,
    progress: { done: 8, failed: 2, lines: 20, expected: 10 },
    result: { tests: 10, passed: 8, failed: 2 },
  });
  session.dashboard.noteDisk(['.log/2026-10-10-node-01.json']);
  rows = session.npm.sessionRows();
  assert.equal(rows[0].live, false);
  assert.equal(rows[0].mark, 'fail');
  assert.equal(rows[0].done, '10');
  assert.equal(rows[0].ok, '8');
  assert.equal(rows[0].fail, '2');
  assert.equal(rows[0].total, '10');
});

test('an interrupted run keeps its duration after a restart', async (t) => {
  const { session, cwd, repo } = await openSession([sampleItem('a.js')], {
    startPane: 'files',
  });
  let activeAt = Date.now();
  t.mock.method(Date, 'now', () => activeAt);
  const dir = path.join(cwd, '.log');
  fs.mkdirSync(dir);
  const record = {
    v: 2,
    id: 'interrupted',
    pid: process.pid,
    command: 'node --test',
    script: 'test',
    startedAt: activeAt - 4000,
    activeAt,
    endedAt: 0,
    status: 'running',
    exit: null,
    progress: { done: 1, failed: 0, lines: 1 },
  };
  fs.writeFileSync(path.join(dir, 'interrupted.json'), JSON.stringify(record));
  session.pushInput('r');
  assert.equal(session.npm.sessionRows()[0].live, true);
  activeAt += 10000;
  session.npm.refreshRecorded();
  const stopped = session.npm.sessionRows()[0];
  assert.equal(stopped.live, false);
  assert.equal(stopped.mark, 'stop');
  assert.equal(stopped.elapsed, '4s');
  activeAt += 60000;
  session.npm.refreshRecorded();
  assert.equal(session.npm.sessionRows()[0].elapsed, '4s');
  const again = await openSession([sampleItem('a.js')], {
    cwd,
    repo,
    startPane: 'files',
  });
  again.session.pushInput('r');
  const restored = again.session.npm.sessionRows()[0];
  assert.equal(restored.live, false);
  assert.equal(restored.elapsed, '4s');
});

test('an open run follows the next reslop t step in its script', async () => {
  const { session, cwd } = await openSession([sampleItem('a.js')], {
    startPane: 'files',
  });
  const dir = path.join(cwd, '.log');
  fs.mkdirSync(dir);
  const write = (id, command, startedAt, endedAt, output) => {
    const record = {
      v: 1,
      id,
      pid: process.pid,
      command,
      script: 'test',
      startedAt,
      endedAt,
      status: 'passed',
      exit: 0,
      progress: { done: 0, failed: 0, lines: 0, expected: 0 },
      result: null,
      log: `${id}.log`,
      raw: `${id}.raw`,
    };
    fs.writeFileSync(
      path.join(dir, `${id}.json`),
      `${JSON.stringify(record)}\n`,
    );
    fs.writeFileSync(path.join(dir, `${id}.log`), `${output}\n`);
    fs.writeFileSync(path.join(dir, `${id}.raw`), `${output}\n`);
  };
  session.pushInput('r');
  write('lint', 'npm run -s lint', 1_000, 3_000, 'lint output');
  session.dashboard.noteDisk(['.log/lint.json', '.log/lint.log']);
  press(session, 'right', 'enter');
  assert.equal(session.npm.viewedRun().externalId, 'lint');
  assert.match(session.npm.output, /lint output/);
  write('tests', 'node --test', 4_000, 9_000, 'test output');
  session.dashboard.noteDisk(['.log/tests.json', '.log/tests.log']);
  assert.equal(session.npm.viewedRun().externalId, 'tests');
  assert.match(session.npm.output, /test output/);
});

test('a finished outside run drops the running line', async () => {
  const { session, cwd } = await openSession([sampleItem('a.js')], {
    startPane: 'files',
  });
  const dir = path.join(cwd, '.log');
  fs.mkdirSync(dir);
  const file = path.join(dir, '2026-10-10-node-01.json');
  const write = (extra) => {
    const record = {
      v: 2,
      id: 'outside',
      pid: process.pid,
      command: 'node --test',
      script: 'test',
      startedAt: 5_000,
      endedAt: 0,
      activeAt: Date.now(),
      status: 'running',
      exit: null,
      progress: { done: 1, failed: 0, lines: 2, expected: 1 },
      result: null,
      log: '2026-10-10-node-01.log',
      raw: '2026-10-10-node-01.raw',
      ...extra,
    };
    fs.writeFileSync(file, `${JSON.stringify(record)}\n`);
  };
  write();
  session.pushInput('r');
  session.dashboard.noteDisk(['.log/2026-10-10-node-01.json']);
  fs.writeFileSync(
    path.join(dir, '2026-10-10-node-01.log'),
    '# test\n\nok: true\n\nexit: 0\n',
  );
  write({
    status: 'passed',
    exit: 0,
    endedAt: 8_000,
    result: { tests: 1, passed: 1, failed: 0 },
  });
  press(session, 'right', 'enter');
  assert.equal(session.view().npmView, true);
  assert.equal(session.view().npmRunning, true);
  let text = frameBody(session).join('\n');
  assert.match(text, /exit: 0/);
  assert.match(text, /running/);
  session.tickProgress();
  assert.equal(session.view().npmRunning, false);
  assert.equal(session.npm.sessionRows()[0].live, false);
  text = frameBody(session).join('\n');
  assert.match(text, /exit: 0/);
  assert.ok(!text.includes('running'));
});

test('chained steps of one script share a history row', async () => {
  const { session, cwd } = await openSession([sampleItem('a.js')], {
    startPane: 'files',
  });
  const dir = path.join(cwd, '.log');
  fs.mkdirSync(dir);
  const record = (id, command, startedAt, endedAt, status) => ({
    v: 2,
    id,
    pid: process.pid,
    command,
    script: 'fix',
    startedAt,
    endedAt,
    activeAt: Date.now(),
    status,
    exit: status === 'running' ? null : 0,
    progress: { done: 0, failed: 0, lines: 0, expected: 0 },
    result: null,
    log: `${id}.log`,
    raw: `${id}.raw`,
  });
  const write = (id, command, startedAt, endedAt, status = 'passed') => {
    fs.writeFileSync(
      path.join(dir, `${id}.json`),
      `${JSON.stringify(record(id, command, startedAt, endedAt, status))}\n`,
    );
  };
  write('eslint', 'eslint . --fix', 1_000, 2_000);
  write('prettier', 'prettier --write .', 2_065, 0, 'running');
  session.pushInput('r');
  session.dashboard.noteDisk(['.log/eslint.json', '.log/prettier.json']);
  let rows = session.npm.sessionRows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'fix');
  assert.equal(rows[0].live, true);
  write('prettier', 'prettier --write .', 2_065, 4_000, 'passed');
  write('eslint-2', 'eslint . --fix', 12_000, 13_000);
  write('prettier-2', 'prettier --write .', 13_080, 15_000);
  session.dashboard.noteDisk(['.log/prettier.json', '.log/eslint-2.json']);
  rows = session.npm.sessionRows();
  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map((row) => row.live),
    [false, false],
  );
});

test('npm test from the ui keeps the two reslop t runs', async () => {
  const { session, cwd, repo } = await openSession([sampleItem('a.js')], {
    startPane: 'files',
  });
  fs.writeFileSync(
    path.join(cwd, 'package.json'),
    `${JSON.stringify({
      scripts: {
        lint: 'eslint .',
        test: 'reslop t -- npm run -s lint && reslop t -- node --test',
      },
    })}\n`,
  );
  let close = null;
  repo.runNpmCommand = (root, entry, onData, onClose) => {
    close = onClose;
    return { kill() {} };
  };
  session.pushInput('r');
  const testAt = session.npm.commands.findIndex(
    (entry) => entry.name === 'test',
  );
  session.nav.npmCursor = testAt;
  press(session, 'enter');
  assert.equal(session.npm.running, true);
  assert.equal(session.npm.sessionRows().length, 0);
  const dir = path.join(cwd, '.log');
  fs.mkdirSync(dir);
  const record = (id, command, script, startedAt, endedAt, extra) => ({
    v: 1,
    id,
    pid: process.pid,
    command,
    script,
    startedAt,
    endedAt,
    status: 'passed',
    exit: 0,
    progress: { done: 0, failed: 0, lines: 0, expected: 0 },
    result: null,
    log: `${id}.log`,
    raw: `${id}.raw`,
    ...extra,
  });
  fs.writeFileSync(
    path.join(dir, 'lint.json'),
    `${JSON.stringify(
      record('lint', 'npm run -s lint', 'test', 1000, 3000),
    )}\n`,
  );
  fs.writeFileSync(
    path.join(dir, 'tests.json'),
    `${JSON.stringify(
      record('tests', 'node --test', 'test', 4000, 9000, {
        result: { tests: 4, passed: 4, failed: 0 },
      }),
    )}\n`,
  );
  session.dashboard.noteDisk(['.log/lint.json', '.log/tests.json']);
  const rows = session.npm.sessionRows();
  assert.deepEqual(
    rows.map((row) => row.name),
    ['test', 'lint'],
  );
  assert.equal(rows[0].done, '4');
  assert.equal(rows[1].total, 'exit 0');
  close({ status: 0, text: 'ok\n' });
  const names = fs.readdirSync(dir);
  assert.equal(
    names.some((name) => name.includes('npm-run') || name.startsWith('2026')),
    false,
  );
  const lintAt = session.npm.commands.findIndex(
    (entry) => entry.name === 'lint',
  );
  session.nav.npmCursor = lintAt;
  let closed = null;
  repo.runNpmCommand = (root, entry, onData, onClose) => {
    closed = onClose;
    return { kill() {} };
  };
  press(session, 'enter');
  const live = session.npm.sessionRows().filter((row) => row.live);
  assert.equal(live.length, 1);
  assert.equal(live[0].name, 'lint');
  closed({ status: 0, text: '' });
  let saved = [];
  for (let i = 0; i < 20; i++) {
    saved = fs.readdirSync(dir).filter((name) => name.endsWith('.json'));
    if (saved.length >= 3) break;
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
  }
  assert.equal(saved.length, 3);
});

test('npm history counts tests and stays on the run screen', async () => {
  const { session, cwd, repo } = await openSession([sampleItem('a.js')], {
    startPane: 'files',
  });
  fs.writeFileSync(
    path.join(cwd, 'package.json'),
    `${JSON.stringify({ scripts: { test: 'node --test' } })}\n`,
  );
  let close = null;
  repo.runNpmCommand = (root, entry, onData, onClose) => {
    onData('ok 1 one\nnot ok 2 two\n');
    close = onClose;
    return { kill() {} };
  };
  session.pushInput('r');
  press(session, 'enter');
  assert.equal(session.view().npmView, false);
  let rows = session.npm.sessionRows();
  assert.equal(rows[0].mark, 'run');
  assert.equal(rows[0].done, '2');
  assert.equal(rows[0].ok, '1');
  assert.equal(rows[0].fail, '1');
  assert.equal(rows[0].exitLabel, false);
  close({ status: 1, text: 'ok 1 one\nnot ok 2 two\n' });
  rows = session.npm.sessionRows();
  assert.equal(rows[0].mark, 'fail');
  assert.equal(rows[0].exitLabel, false);
  assert.equal(rows[0].fail, '1');
  assert.equal(session.view().npmView, false);
});

test('npm output scrolls with the editor hotkeys', async () => {
  const { session, cwd, repo } = await openSession([sampleItem('a.js')], {
    startPane: 'files',
  });
  fs.writeFileSync(
    path.join(cwd, 'package.json'),
    `${JSON.stringify({ scripts: { test: 'node --test' } })}\n`,
  );
  const lines = [];
  for (let i = 0; i < 80; i++) lines.push(`row ${i}`);
  let push = null;
  repo.runNpmCommand = (root, entry, onData, onClose) => {
    push = onData;
    onData(lines.join('\n'));
    onClose({ status: 0, text: lines.join('\n') });
    return { kill() {} };
  };
  session.pushInput('r');
  press(session, 'enter', 'right', 'enter');
  session.draw();
  const page = logViewRows(session.lastFrame.bodyH);
  assert.ok(page > 1);
  const half = Math.max(1, Math.floor(page * 0.5));
  const at = () => session.view().npmScroll;
  press(session, 'home');
  assert.equal(at(), 0);
  assert.equal(session.view().npmFollow, false);
  press(session, 'up');
  assert.equal(at(), 0);
  press(session, 'down');
  assert.equal(at(), 1);
  press(session, 'ctrl-y');
  assert.equal(at(), 0);
  press(session, 'ctrl-e');
  assert.equal(at(), 1);
  press(session, 'home', 'ctrl-f');
  assert.equal(at(), page);
  press(session, 'ctrl-b');
  assert.equal(at(), 0);
  press(session, 'ctrl-d');
  assert.equal(at(), half);
  press(session, 'ctrl-u');
  assert.equal(at(), 0);
  press(session, 'pageDown');
  assert.equal(at(), page);
  press(session, 'pageUp');
  assert.equal(at(), 0);
  press(session, 'end');
  assert.equal(session.view().npmFollow, true);
  press(session, 'up');
  assert.equal(session.view().npmFollow, false);
  const stayed = at();
  push('row extra\n');
  assert.equal(at(), stayed);
  assert.equal(session.view().npmFollow, false);
  const body = frameBody(session);
  assert.equal(body[0].trim(), '');
  assert.equal(body[body.length - 1].trim(), '');
  assert.match(body[1], /^ {2}row /);
});

test('npm output animates progress until the command exits', async () => {
  const { session, cwd, repo } = await openSession([sampleItem('a.js')], {
    startPane: 'files',
  });
  fs.writeFileSync(
    path.join(cwd, 'package.json'),
    `${JSON.stringify({ scripts: { test: 'node --test' } })}\n`,
  );
  let finish = null;
  repo.runNpmCommand = (root, entry, onData, onClose) => {
    onData('hello\n');
    finish = () => onClose({ status: 0, text: 'hello\n' });
    return {
      kill() {
        finish();
      },
    };
  };
  session.pushInput('r');
  press(session, 'enter');
  assert.equal(session.view().npmView, false);
  press(session, 'right', 'enter');
  assert.equal(session.view().npmRunning, true);
  assert.equal(session.progress.size(), 1);
  let body = frameBody(session);
  const hello = body.findIndex((row) => row.includes('hello'));
  assert.match(body[hello + 1], /^ {2}running {2}·•●•·/);
  session.tickProgress();
  body = frameBody(session);
  assert.match(body[hello + 1], /^ {2}running {2}··•●•/);
  finish();
  body = frameBody(session);
  assert.equal(session.view().npmRunning, false);
  assert.equal(session.progress.size(), 0);
  const text = body.join('\n');
  assert.match(text, /hello/);
  assert.match(text, /exit 0/);
  assert.ok(!text.includes('running'));
});

test('npm screen refuses edits when read only', async () => {
  const { session, cwd } = await openSession([sampleItem('a.js')], {
    startPane: 'files',
    readOnly: true,
  });
  fs.writeFileSync(
    path.join(cwd, 'package.json'),
    `${JSON.stringify({ scripts: { test: 'node --test' } })}\n`,
  );
  session.pushInput('r');
  session.pushInput('e');
  assert.equal(session.status, 'read only');
  assert.equal(session.mode, 'review');
  press(session, 'insert');
  assert.equal(session.status, 'read only');
  press(session, 'delete');
  assert.equal(session.mode, 'review');
  press(session, 'l');
  assert.equal(session.status, 'read only');
  assert.equal(session.mode, 'review');
});

test('double click runs the selected npm command', async () => {
  const { session, cwd, repo } = await openSession([sampleItem('a.js')], {
    startPane: 'files',
  });
  fs.writeFileSync(
    path.join(cwd, 'package.json'),
    `${JSON.stringify({
      scripts: { test: 'node --test', lint: 'eslint .' },
    })}\n`,
  );
  const ran = [];
  repo.runNpmCommand = (root, entry, onData, onClose) => {
    ran.push(entry.name);
    onClose({ status: 0, text: '' });
    return { kill() {} };
  };
  session.pushInput('r');
  session.draw();
  const hits = session.lastFrame.fileHits;
  assert.ok(hits.length >= 2);
  click(session, 2, hits[1].y);
  assert.deepEqual(ran, []);
  assert.equal(session.npmCursor, hits[1].cursor);
  click(session, 2, hits[1].y);
  assert.deepEqual(ran, ['lint']);
  assert.equal(session.view().npmView, false);
});

test('delete removes the selected npm script after confirmation', async () => {
  const { session, cwd, stdout } = await openSession([sampleItem('a.js')], {
    startPane: 'files',
  });
  stdout.columns = 160;
  const file = path.join(cwd, 'package.json');
  fs.writeFileSync(
    file,
    `${JSON.stringify({
      scripts: { test: 'node --test', lint: 'eslint .' },
    })}\n`,
  );
  session.pushInput('r');
  session.draw();
  const footer = stripAnsi(session.lastFrame.rows.at(-1));
  assert.match(footer, /edit {2}insert {2}delete {2}cleanup/);
  const ids = session.lastFrame.buttons.map((hit) => hit.id);
  assert.ok(ids.includes('npmEdit'));
  assert.ok(ids.includes('npmNew'));
  assert.ok(ids.includes('npmDrop'));
  press(session, 'delete');
  assert.equal(session.mode, 'confirmDrop');
  session.pushInput('y');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.scripts.test, undefined);
  assert.equal(saved.scripts.lint, 'eslint .');
  assert.equal(session.status, 'dropped test');
});

test('dragging the scroller of a list moves its rows and cursor', async () => {
  const items = Array.from({ length: 40 }, (_, at) => sampleItem(`f${at}.js`));
  const { session } = await openSession(items, { startPane: 'files' });
  session.draw();
  const bar = session.lastFrame.scrollBars[0];
  assert.equal(bar.target, 'list');
  assert.equal(bar.start, 0);
  const mouse = (kind, y) =>
    session.handleEvent({ type: 'mouse', kind, button: 0, x: bar.x, y });
  mouse('press', bar.y + bar.track);
  session.draw();
  mouse('drag', bar.y + bar.height - 1);
  session.draw();
  mouse('release', bar.y + bar.height - 1);
  session.draw();
  const moved = session.lastFrame.scrollBars[0];
  assert.equal(moved.start, 40 - moved.rows);
  assert.equal(session.fileCursor, moved.start);
  const picked = session.fileList()[moved.start].path;
  assert.equal(session.reviewPath, picked);
});

test('dragging the packages scroller moves the package cursor', async () => {
  const packages = Array.from({ length: 40 }, (_, at) => ({
    name: `pkg${at}`,
    bytes: at + 1,
    dev: false,
    version: '1.0.0',
  }));
  const { session } = await openSession([sampleItem('a.js')], {
    startPane: 'files',
  });
  session.dashboard.npm = {
    ready: true,
    hasManifest: true,
    deps: 40,
    dev: 0,
    modules: { bytes: 40, count: 40, packages },
  };
  session.dashboard.openPackages();
  session.draw();
  const bar = session.lastFrame.scrollBars[0];
  assert.equal(bar.target, 'list');
  assert.equal(bar.start, 0);
  const mouse = (kind, y) =>
    session.handleEvent({ type: 'mouse', kind, button: 0, x: bar.x, y });
  mouse('press', bar.y + bar.track);
  session.draw();
  mouse('drag', bar.y + bar.height - 1);
  session.draw();
  mouse('release', bar.y + bar.height - 1);
  session.draw();
  const moved = session.lastFrame.scrollBars[0];
  assert.equal(moved.start, 40 - moved.rows);
  assert.equal(session.nav.packagesCursor, moved.start);
});

test('ctrl+a selects every row of a list', async () => {
  const items = [sampleItem('a.js'), sampleItem('b.js'), sampleItem('c.js')];
  const { session, cwd } = await openSession(items, { startPane: 'files' });
  press(session, 'down', 'ctrl-a');
  assert.deepEqual(session.view().listSelection, [0, 1, 2]);
  assert.equal(session.nav.multiselect, true);
  assert.equal(session.fileCursor, 1);
  press(session, 'down');
  assert.deepEqual(session.view().listSelection, []);
  session.nav.fileScope = 'file';
  session.nav.folderFocus = true;
  press(session, 'ctrl-a');
  assert.equal(session.view().folderFocus, false);
  assert.deepEqual(session.view().listSelection, [0, 1, 2]);
  const file = path.join(cwd, 'package.json');
  const scripts = { test: 'node --test', lint: 'eslint .' };
  fs.writeFileSync(file, `${JSON.stringify({ scripts })}\n`);
  session.npm.open();
  press(session, 'ctrl-a');
  assert.deepEqual(session.view().listSelection, [0, 1]);
});

test('npm and run lists select a range', async () => {
  const { session, cwd } = await openSession([sampleItem('a.js')]);
  const file = path.join(cwd, 'package.json');
  fs.writeFileSync(
    file,
    `${JSON.stringify({
      scripts: {
        test: 'node --test',
        lint: 'eslint .',
        build: 'node build.js',
      },
    })}\n`,
  );
  session.npm.open();
  press(session, 'shift-down');
  assert.deepEqual(session.view().listSelection, [0, 1]);
  session.draw();
  const ids = session.lastFrame.buttons.map((hit) => hit.id);
  assert.ok(ids.includes('npmDrop'));
  assert.ok(!ids.includes('npmEdit'));
  const cell = session.lastFrame.fileHits.find(
    (hit) => hit.side === 'commands' && hit.cursor === 2,
  );
  shiftClick(session, { x: cell.x0 + 2, y: cell.y });
  assert.deepEqual(session.view().listSelection, [0, 1, 2]);
  press(session, 'down');
  assert.deepEqual(session.view().listSelection, []);
  press(session, 'home', 'shift-down', 'delete', 'y');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(saved.scripts), ['build']);
  session.npm.runs.push(
    {
      id: 1,
      name: 'one',
      command: 'echo one',
      status: 'exited',
      startedAt: 1,
      endedAt: 2,
    },
    {
      id: 2,
      name: 'two',
      command: 'echo two',
      status: 'exited',
      startedAt: 10,
      endedAt: 12,
    },
    {
      id: 3,
      name: 'three',
      command: 'echo three',
      status: 'exited',
      startedAt: 20,
      endedAt: 22,
    },
  );
  session.npm.focusRuns();
  session.npm.runCursor = 0;
  press(session, 'shift-down');
  assert.deepEqual(session.view().listSelection, [0, 1]);
  press(session, 'delete');
  assert.equal(session.mode, 'review');
  const kept = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(kept.scripts.build, 'node build.js');
  press(session, 'down');
  assert.deepEqual(session.view().listSelection, []);
});

test('npm screen deletes logs older than 5 days', async () => {
  const { session, cwd } = await openSession([sampleItem('a.js')], {
    startPane: 'files',
  });
  fs.writeFileSync(
    path.join(cwd, 'package.json'),
    `${JSON.stringify({ scripts: { test: 'node --test' } })}\n`,
  );
  const dir = path.join(cwd, '.log');
  fs.mkdirSync(dir);
  const stale = path.join(dir, `${daysAgoStamp(6)}-test-01.log`);
  const kept = path.join(dir, `${daysAgoStamp(5)}-test-01.log`);
  fs.writeFileSync(stale, 'abcdef');
  fs.writeFileSync(kept, 'keep');
  session.pushInput('r');
  session.draw();
  const status = () => stripAnsi(session.lastFrame.rows.at(-2));
  assert.match(status(), /old logs 6/);
  press(session, 'l');
  assert.equal(session.mode, 'confirmDrop');
  session.draw();
  assert.match(status(), /drop logs older than 5 days \(6\)\? y\/n/);
  session.pushInput('n');
  assert.equal(fs.existsSync(stale), true);
  press(session, 'l');
  session.pushInput('y');
  assert.equal(fs.existsSync(stale), false);
  assert.equal(fs.existsSync(kept), true);
  session.draw();
  assert.ok(!status().includes('old logs'));
  assert.equal(session.status, 'dropped logs');
  const hits = session.lastFrame.buttons.map((hit) => hit.id);
  assert.ok(!hits.includes('npmLogs'));
  press(session, 'l');
  assert.equal(session.status, 'dropped logs');
  assert.equal(session.mode, 'review');
});
