'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { Dashboard } = require('../../lib/session/dashboard.js');
const helpers = require('../helpers.js');
const { uiSink, press, click } = helpers;
const review = require('../../lib/review/review.js');
const { serializeReview } = review;
const { parseReview } = review;
const ansi = require('../../lib/term/ansi.js');
const { stripAnsi } = ansi;
const { setTheme, themeName } = ansi;
const { TABLE_KEY } = require('../../lib/runs/output.js');
const sessionHelpers = require('../session-helpers.js');
const { focusedRow, today, sampleItem, openSession } = sessionHelpers;
const { clickFooter, frameBody } = sessionHelpers;

for (const kind of ['script', 'command']) {
  test(`solve saves a failed ${kind} in the current plan`, async () => {
    const { session, cwd } = await openSession([sampleItem('a.js')], {
      startPane: 'files',
    });
    const tasks = session.composer.tasks;
    tasks.createPlan();
    const reviewPath = session.notes.reviewPath;
    session.notes.addTask('tasks', 'Keep existing task');
    const raw = [
      'TAP version 13',
      'ok 1 passing test',
      'not ok 2 broken parser',
      '  ---',
      '  error: parser exploded',
      '  code: ERR_ASSERTION',
      '  ...',
      '1..2',
      '# tests 2',
      '# pass 1',
      '# fail 1',
    ].join('\n');
    session.npm.runs.push({
      id: 1,
      name: 'test',
      kind,
      command: kind === 'command' ? 'node --test test/parser.test.js' : '',
      label: 'npm run test',
      status: 'exited',
      exit: 1,
      raw: kind === 'command' ? `\x1b[31m${cwd}/app.js:4: boom\x1b[0m` : raw,
      top: cwd,
    });
    session.npm.open();
    session.npm.openView(1);
    session.npm.verbose = true;
    session.draw();
    const ids = session.lastFrame.buttons.map((hit) => hit.id);
    assert.ok(ids.includes('npmTask'));
    assert.ok(!ids.includes('npmStop'));
    if (kind === 'command') clickFooter(session, 'npmTask');
    else press(session, 'ctrl-t');
    assert.equal(session.pane, 'tasks');
    assert.equal(session.mode, 'compose');
    assert.equal(session.notes.reviewPath, reviewPath);
    const bug = session.notes.tasks.find((task) => task.kind === 'bugs');
    assert.ok(bug);
    assert.equal(bug.done, false);
    assert.equal(tasks.rowAt(session.tasksFocus).task.id, bug.id);
    const command = kind === 'command' ? 'node --test test/parser.test.js' : '';
    if (kind === 'command') {
      assert.deepEqual(bug.text.split('\n'), [
        `\`${command}\` fails`,
        '- where: app.js:4',
        '- problem: app.js:4: boom',
        `- check: \`${command}\` passes`,
      ]);
      assert.ok(!bug.text.includes(cwd));
    } else {
      assert.deepEqual(bug.text.split('\n'), [
        'broken parser',
        '- problem: parser exploded',
        '- check: `npm run test` passes',
      ]);
    }
    const disk = parseReview(fs.readFileSync(reviewPath, 'utf8'), reviewPath);
    assert.equal(disk.tasks.length, 2);
    assert.ok(disk.tasks.some((task) => task.kind === 'bugs'));
  });
}

test('ctrl+d and a checkbox click toggle a task', async () => {
  const { session, stdout } = await openSession([sampleItem('a.js')]);
  stdout.columns = 100;
  session.dispatch('tasks');
  session.pushInput('ship it');
  press(session, 'ctrl-d');
  assert.equal(session.notes.tasks[0].done, true);
  assert.equal(session.editor.text, 'ship it');
  session.draw();
  const body = stripAnsi(session.lastFrame.rows.join('\n'));
  assert.match(body, /\[x\] ship it/);
  assert.doesNotMatch(body.split('\n').at(-1), /space/);
  press(session, 'ctrl-d');
  assert.equal(session.notes.tasks[0].done, false);
  session.draw();
  const box = session.lastFrame.taskHits.find((row) => row.check);
  assert.ok(box);
  click(session, box.x0 + 1, box.y);
  assert.equal(session.notes.tasks[0].done, true);
  assert.equal(session.notes.tasks[0].text, 'ship it');
  const loaded = parseReview(
    serializeReview(session.notes),
    session.notes.reviewPath,
  );
  assert.equal(loaded.tasks[0].done, true);
  assert.equal(loaded.tasks[0].text, 'ship it');
  press(session, 'end', 'x', ' ');
  assert.equal(session.mode, 'compose');
  assert.equal(session.editor.text, 'ship itx ');
  assert.equal(session.notes.tasks[0].done, true);
});

test('l toggles the theme and is typed as text while composing', async () => {
  const { session } = await openSession([sampleItem('a.js')]);
  try {
    session.pushInput('l');
    assert.equal(themeName(), 'light');
    assert.equal(session.status, 'light');
    session.pushInput('l');
    assert.equal(themeName(), 'dark');
    assert.equal(session.status, 'dark');
    session.dispatch('blockTask');
    press(session, 'l');
    assert.equal(session.mode, 'compose');
    assert.equal(session.editor.text, 'l');
    assert.equal(themeName(), 'dark');
  } finally {
    setTheme('dark');
  }
});

test('packages screen manages dependencies', async () => {
  const stdout = uiSink();
  stdout.columns = 160;
  stdout.rows = 24;
  const { session, repo } = await openSession([sampleItem('a.js')], {
    startPane: 'files',
    stdout,
    outdatedMap: new Map([
      ['leftpad', { current: '1.0.0', wanted: '1.2.0', latest: '2.0.0' }],
    ]),
  });
  session.dashboard.npm = {
    ready: true,
    hasManifest: true,
    deps: 1,
    dev: 1,
    modules: {
      bytes: 20,
      count: 2,
      packages: [
        { name: 'leftpad', bytes: 14, version: '1.0.0', dev: false },
        { name: 'eslint', bytes: 6, version: '8.0.0', dev: true },
      ],
    },
  };
  const calls = [];
  let gate = null;
  repo.runPackage = (cwd, args) => {
    calls.push(args);
    if (!gate) return Promise.resolve({ status: 0, stdout: '', stderr: '' });
    const pending = gate;
    gate = null;
    return pending;
  };
  session.dashboard.openPackages();
  session.draw();
  const rows = session.lastFrame.rows.map((row) => stripAnsi(row));
  const table = rows.slice(1, -2).join('\n');
  const status = rows.at(-2);
  assert.match(status, /deps: 1 {2}dev: 1 {2}all: 2 \(20\) {2}⚠️ 1\s*$/);
  assert.match(status, /^ \S+\s{2,}deps: 1/);
  assert.equal(table.includes('deps:'), false);
  assert.match(table, /^ {2}name/m);
  assert.match(table, /current/);
  assert.match(table, /^ {2}leftpad/m);
  assert.equal(table.includes('▶'), false);
  assert.match(rows.at(-1), /insert/);
  assert.match(rows.at(-1), /delete/);
  assert.match(rows.at(-1), /wanted/);
  assert.match(rows.at(-1), /latest/);
  let release = null;
  gate = new Promise((resolve) => {
    release = resolve;
  });
  press(session, 'w');
  assert.equal(session.busy, 'npm i');
  release({ status: 0, stdout: '', stderr: '' });
  await session.packages.job;
  assert.deepEqual(calls[0], ['update', 'leftpad']);
  press(session, 'l');
  await session.packages.job;
  assert.deepEqual(calls.at(-1), ['install', 'leftpad@latest']);
  press(session, 'j', 'l');
  await session.packages.job;
  assert.deepEqual(calls.at(-1), ['install', 'eslint@latest', '--save-dev']);
  press(session, 'k', 'delete');
  assert.equal(session.mode, 'confirmDrop');
  session.draw();
  const prompt = stripAnsi(session.lastFrame.rows.at(-2));
  assert.match(prompt, /drop leftpad\? y\/n/);
  session.pushInput('n');
  assert.equal(session.mode, 'review');
  assert.equal(calls.length, 3);
  press(session, 'delete');
  session.pushInput('y');
  await session.packages.job;
  assert.deepEqual(calls.at(-1), ['uninstall', 'leftpad']);
  press(session, 'insert');
  assert.equal(session.composeKind, 'package');
  session.draw();
  const editing = session.lastFrame.rows.map((row) => stripAnsi(row));
  const editY = session.lastFrame.editHits[0].y - 1;
  const leftY = editing.findIndex((line) => line.includes('leftpad'));
  const eslintY = editing.findIndex((line) => line.includes('eslint'));
  assert.equal(editY, leftY - 1);
  assert.ok(leftY < eslintY);
  session.pushInput('ms');
  press(session, 'enter');
  await session.packages.job;
  assert.deepEqual(calls.at(-1), ['install', 'ms']);
  press(session, 'j', 'insert');
  session.draw();
  const devEdit = session.lastFrame.rows.map((row) => stripAnsi(row));
  const devY = session.lastFrame.editHits[0].y - 1;
  const leftDev = devEdit.findIndex((line) => line.includes('leftpad'));
  const eslintDev = devEdit.findIndex((line) => line.includes('eslint'));
  assert.ok(leftDev < devY);
  assert.equal(devY, eslintDev - 1);
  session.pushInput('chalk');
  press(session, 'enter');
  await session.packages.job;
  assert.deepEqual(calls.at(-1), ['install', 'chalk', '--save-dev']);
  press(session, 'insert', 'enter');
  assert.equal(session.status, 'name');
  assert.equal(calls.length, 6);
});

test('package ranges batch updates and preserve dev groups', async () => {
  const { session, repo } = await openSession([sampleItem('a.js')]);
  session.dashboard.npm = {
    hasManifest: true,
    deps: 2,
    dev: 1,
    modules: {
      bytes: 30,
      count: 3,
      packages: [
        { name: 'one', bytes: 10, version: '1.0.0' },
        { name: 'two', bytes: 10, version: '1.0.0' },
        { name: 'dev', bytes: 10, version: '1.0.0', dev: true },
      ],
    },
  };
  const calls = [];
  repo.runPackage = async (top, args) => {
    calls.push(args);
    return { status: 0 };
  };
  const select = () => press(session, 'home', 'shift-end');
  session.dashboard.openPackages();
  select();
  session.draw();
  assert.ok(!session.lastFrame.buttons.some((hit) => hit.id === 'packageNew'));
  press(session, 'insert');
  assert.equal(session.mode, 'review');
  press(session, 'w');
  await session.packages.job;
  await session.ops.idle();
  assert.deepEqual(calls, [['update', 'one', 'two', 'dev']]);
  select();
  press(session, 'l');
  await session.packages.job;
  await session.ops.idle();
  assert.deepEqual(calls.slice(1), [
    ['install', 'one@latest', 'two@latest'],
    ['install', 'dev@latest', '--save-dev'],
  ]);
  select();
  press(session, 'delete', 'n');
  assert.equal(calls.length, 3);
  press(session, 'delete', 'y');
  await session.packages.job;
  await session.ops.idle();
  assert.deepEqual(calls.at(-1), ['uninstall', 'one', 'two', 'dev']);
});

test('package operations refresh installed versions and rows', async () => {
  const { session, repo, cwd } = await openSession([sampleItem('a.js')]);
  const lock = path.join(cwd, 'node_modules', '.package-lock.json');
  const manifest = path.join(cwd, 'package.json');
  const packageDir = path.join(cwd, 'node_modules', 'one');
  fs.mkdirSync(packageDir, { recursive: true });
  fs.writeFileSync(path.join(packageDir, 'index.js'), 'module.exports = 1;');
  const write = (version) => {
    const packages = version ? { 'node_modules/one': { version } } : {};
    const dependencies = version ? { one: '^1.0.0' } : {};
    fs.writeFileSync(manifest, JSON.stringify({ dependencies }));
    fs.writeFileSync(lock, JSON.stringify({ packages }));
  };
  write('1.0.0');
  session.dashboard.runNpm = Dashboard.prototype.runNpm;
  await session.dashboard.runNpm(true);
  session.dashboard.openPackages();
  session.outdatedMap = new Map([
    ['one', { current: '0.9.0', wanted: '1.1.0', latest: '2.0.0' }],
  ]);
  repo.runPackage = async (top, args) => {
    if (args[0] === 'update') write('1.1.0');
    if (args[0] === 'install') write('2.0.0');
    if (args[0] === 'uninstall') {
      write(null);
      fs.rmSync(packageDir, { recursive: true });
    }
    return { status: 0 };
  };
  for (const entry of [
    ['w', '1.1.0'],
    ['l', '2.0.0'],
  ]) {
    const key = entry[0];
    const version = entry[1];
    press(session, key);
    await session.packages.job;
    await session.ops.idle();
    assert.equal(session.view().packages.modules.packages[0].current, version);
  }
  press(session, 'delete', 'y');
  await session.packages.job;
  await session.ops.idle();
  assert.deepEqual(session.view().packages.modules.packages, []);
  assert.equal(session.nav.packagesCursor, 0);
});

test('delete refuses a transitive package', async () => {
  const { session } = await openSession([sampleItem('a.js')], {
    startPane: 'files',
  });
  session.dashboard.npm = {
    ready: true,
    hasManifest: true,
    deps: 1,
    dev: 0,
    modules: {
      bytes: 4,
      count: 1,
      packages: [
        {
          name: 'three',
          bytes: 4,
          version: '1.0.0',
          dev: false,
          transitive: true,
          chain: 'one 🢒 two 🢒 three',
        },
      ],
    },
  };
  session.dashboard.openPackages();
  press(session, 'delete');
  assert.equal(session.mode, 'review');
  assert.equal(session.status, 'transitive');
  press(session, 'insert');
  assert.equal(session.mode, 'review');
  assert.equal(session.composeKind, null);
  assert.equal(session.status, 'transitive');
  session.draw();
  const insert = session.lastFrame.buttons.find(
    (hit) => hit.id === 'packageNew',
  );
  assert.equal(insert, undefined);
});

test('files pane r opens npm scripts and bins', async () => {
  const { session, cwd, repo, stdout } = await openSession(
    [sampleItem('a.js')],
    {
      startPane: 'files',
    },
  );
  stdout.columns = 120;
  fs.writeFileSync(
    path.join(cwd, 'package.json'),
    `${JSON.stringify({
      scripts: { test: 'node --test', lint: 'eslint .' },
      dependencies: { leftpad: '1.0.0' },
    })}\n`,
  );
  const dep = path.join(cwd, 'node_modules', 'leftpad');
  fs.mkdirSync(dep, { recursive: true });
  fs.writeFileSync(
    path.join(dep, 'package.json'),
    `${JSON.stringify({ name: 'leftpad', bin: { leftpad: 'bin.js' } })}\n`,
  );
  session.pushInput('r');
  assert.equal(session.pane, 'npm');
  session.draw();
  let body = stripAnsi(session.lastFrame.rows.join('\n'));
  assert.match(body, /test/);
  assert.match(body, /lint/);
  assert.match(body, /leftpad/);
  assert.match(body, /: run /);
  assert.ok(!body.includes(' q'));
  session.pushInput('e');
  assert.equal(session.mode, 'compose');
  assert.equal(session.editor.text, 'test');
  session.draw();
  body = stripAnsi(session.lastFrame.rows.join('\n'));
  assert.match(body, /node --test/);
  session.editor.replace('bad name');
  press(session, 'enter');
  assert.equal(session.mode, 'compose');
  assert.equal(session.status, 'name');
  session.editor.replace('test');
  press(session, 'enter');
  assert.equal(session.mode, 'compose');
  assert.equal(session.editor.text, 'node --test');
  const nameCursor = session.lastFrame.cursor;
  session.draw();
  assert.ok(session.lastFrame.cursor.x > (nameCursor?.x ?? 0));
  session.editor.replace('node --test test');
  press(session, 'enter');
  assert.equal(session.mode, 'review');
  const file = path.join(cwd, 'package.json');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.scripts.test, 'node --test test');
  press(session, 'ctrl-down');
  const order = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(order.scripts), ['lint', 'test']);
  press(session, 'delete');
  assert.equal(session.mode, 'confirmDrop');
  session.pushInput('n');
  assert.equal(session.mode, 'review');
  const kept = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(kept.scripts.lint, 'eslint .');
  press(session, 'end');
  session.pushInput('e');
  assert.equal(session.status, 'not a script');
  press(session, 'home');
  const ran = [];
  let written = null;
  repo.runNpmCommand = (root, entry, onData, onClose) => {
    ran.push(entry.name);
    const lines = [
      '✔ passes',
      `${root}/lib/app.js:4`,
      '✖ fails',
      'Error: boom',
    ];
    const text = lines.join('\n');
    onData(text);
    written = onClose({ status: 1, text });
    return { kill() {} };
  };
  press(session, 'enter');
  assert.deepEqual(ran, ['lint']);
  assert.equal(session.view().npmView, false);
  press(session, 'right', 'enter');
  session.draw();
  body = stripAnsi(session.lastFrame.rows.join('\n'));
  assert.match(body, /lib\/app\.js:4/);
  assert.match(body, /Error: boom/);
  assert.match(body, /exit 1/);
  assert.ok(!body.includes('✔'));
  assert.ok(!body.includes(cwd));
  const stamp = today();
  await written;
  const logPath = path.join(cwd, '.log', `${stamp}-lint-01.log`);
  const log = fs.readFileSync(logPath, 'utf8');
  assert.match(log, /exit 1/);
  assert.ok(!log.includes('✔'));
  press(session, 'escape');
  assert.equal(session.pane, 'npm');
  assert.equal(session.view().npmView, false);
  press(session, 'ctrl-c');
  assert.equal(session.done, false);
  session.dispatch('quit');
  assert.equal(session.done, true);
});

test('npm output v toggles raw text until the screen closes', async () => {
  const { session, cwd, repo, stdout } = await openSession(
    [sampleItem('a.js')],
    {
      startPane: 'files',
    },
  );
  stdout.columns = 400;
  fs.writeFileSync(
    path.join(cwd, 'package.json'),
    `${JSON.stringify({ scripts: { test: 'node --test' } })}\n`,
  );
  const text = ['✔ passes', `${cwd}/lib/app.js:4`, '✖ fails'].join('\n');
  repo.runNpmCommand = (root, entry, onData, onClose) => {
    onData(text);
    onClose({ status: 1, text });
    return { kill() {} };
  };
  session.pushInput('r');
  press(session, 'enter');
  assert.equal(session.view().npmView, false);
  press(session, 'right', 'enter');
  session.draw();
  let body = stripAnsi(session.lastFrame.rows.join('\n'));
  assert.ok(!body.includes('✔'));
  assert.match(body, /exit 1/);
  const footer = () => stripAnsi(session.lastFrame.rows.at(-1));
  assert.match(footer(), /verbose/);
  press(session, 'v');
  assert.equal(session.status, 'verbose');
  session.draw();
  body = stripAnsi(session.lastFrame.rows.join('\n'));
  assert.match(body, /✔ passes/);
  assert.match(body, /lib\/app\.js:4/);
  press(session, 'v');
  assert.equal(session.status, 'filtered');
  session.draw();
  body = stripAnsi(session.lastFrame.rows.join('\n'));
  assert.ok(!body.includes('✔'));
  press(session, 'v', 'r');
  session.draw();
  body = stripAnsi(session.lastFrame.rows.join('\n'));
  assert.match(body, /✔ passes/);
  press(session, 'escape');
  assert.equal(session.view().npmView, false);
  press(session, 'enter');
  session.draw();
  body = stripAnsi(session.lastFrame.rows.join('\n'));
  assert.ok(!body.includes('✔'));
  assert.match(body, /exit 1/);
});

test('solve bounds output, skips passed runs, adds no duplicate', async () => {
  const { session } = await openSession([sampleItem('a.js')]);
  session.npm.runs.push({
    id: 1,
    name: 'build',
    kind: 'script',
    status: 'exited',
    exit: 0,
    output: `build failed\n${'x'.repeat(10000)}`,
  });
  session.npm.open();
  session.npm.openView(1);
  press(session, 'ctrl-t');
  assert.equal(session.pane, 'npm');
  assert.equal(session.notes.tasks.length, 0);
  const run = session.npm.viewedRun();
  run.status = 'stopped';
  run.exit = '';
  press(session, 'ctrl-t');
  assert.equal(session.notes.tasks.length, 0);
  run.status = 'exited';
  run.exit = '1';
  press(session, 'ctrl-t');
  assert.equal(session.pane, 'tasks');
  const bug = session.notes.tasks[0];
  assert.equal(bug.item.title, '`npm run build` fails');
  assert.equal(bug.item.value('problem'), 'build failed …');
  assert.ok(bug.text.length < 400);
  session.composer.tasks.closeEditor();
  session.npm.open();
  session.npm.openView(1);
  press(session, 'ctrl-t');
  assert.equal(session.pane, 'tasks');
  assert.equal(session.notes.tasks.length, 1);
  assert.ok(focusedRow(session).startsWith(`[ ] ${bug.item.title}`));
});

test('a saved test run shows the styled report, not Markdown', async () => {
  const { session, cwd } = await openSession([sampleItem('a.js')]);
  const tap = [
    'TAP version 13',
    'not ok 1 - broken parser',
    '  ---',
    '  name: AssertionError',
    '  error: Expected 3, got 4',
    '  code: ERR_ASSERTION',
    '  operator: strictEqual',
    '  expected: 3',
    '  actual: 4',
    '  ...',
    '1..1',
  ].join('\n');
  const dir = path.join(cwd, '.log');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 't-01.log'), 'Reduced output;\n\n# test\n');
  fs.writeFileSync(path.join(dir, 't-01.raw'), tap);
  session.npm.runs.push({
    id: 1,
    name: 'test',
    kind: 'script',
    command: 'node --test',
    label: 'npm run test',
    status: 'exited',
    exit: 1,
    logName: 't-01.log',
    rawName: 't-01.raw',
    top: cwd,
  });
  session.npm.open();
  session.npm.openView(1);
  const output = session.npm.output;
  assert.ok(output.includes(TABLE_KEY));
  assert.ok(!output.includes('Reduced output'));
  assert.match(stripAnsi(output), /✖ test/);
});

test('esc leaves a running npm command in the background', async () => {
  const { session, cwd, repo } = await openSession([sampleItem('a.js')], {
    startPane: 'files',
  });
  fs.writeFileSync(
    path.join(cwd, 'package.json'),
    `${JSON.stringify({ scripts: { test: 'node --test' } })}\n`,
  );
  let close = null;
  let push = null;
  let killed = false;
  let starts = 0;
  repo.runNpmCommand = (root, entry, onData, onClose) => {
    starts += 1;
    push = onData;
    onData('hello\n');
    close = onClose;
    return {
      kill() {
        killed = true;
      },
    };
  };
  session.pushInput('r');
  press(session, 'enter');
  assert.equal(session.view().npmView, false);
  assert.equal(session.view().npmRunning, true);
  press(session, 'right', 'enter');
  session.draw();
  const footer = () => stripAnsi(session.lastFrame.rows.at(-1));
  const hitIds = () => session.lastFrame.buttons.map((hit) => hit.id);
  assert.match(footer(), /^ 🢐esc {2}/);
  assert.match(footer(), /verbose {2}stop {2}re-run/);
  assert.ok(!footer().includes('edit'));
  assert.ok(!footer().includes('new'));
  assert.equal(hitIds()[0], 'back');
  assert.ok(hitIds().includes('npmStop'));
  assert.ok(hitIds().includes('npmRerun'));
  press(session, 'r');
  assert.equal(starts, 2);
  assert.equal(session.view().npmRunning, true);
  assert.equal(session.npm.runs.length, 2);
  press(session, 'escape');
  assert.equal(killed, false);
  assert.equal(session.view().npmView, false);
  assert.equal(session.npm.running, true);
  assert.equal(session.status, '');
  let text = frameBody(session).join('\n');
  assert.match(text, /test/);
  assert.equal(text.match(/⠋/g).length, 2);
  press(session, 'right', 'enter');
  assert.equal(session.view().npmView, true);
  press(session, 's');
  assert.equal(killed, true);
  assert.equal(session.view().npmView, true);
  assert.equal(session.view().npmRunning, false);
  assert.equal(session.status, 'terminated');
  text = frameBody(session).join('\n');
  assert.match(text, /hello/);
  assert.match(text, /terminated/);
  push('hello\nmore\n');
  text = frameBody(session).join('\n');
  assert.match(text, /hello/);
  assert.match(text, /terminated/);
  assert.ok(!text.includes('more'));
  close({ status: null, text: 'hello\nlate\n' });
  assert.equal(session.view().npmView, true);
  text = frameBody(session).join('\n');
  assert.match(text, /hello/);
  assert.match(text, /terminated/);
  assert.ok(!text.includes('late'));
  assert.ok(!text.includes('more'));
  assert.ok(!text.includes('exit null'));
  session.draw();
  assert.match(footer(), /🢐esc/);
  assert.match(footer(), /stop/);
  assert.ok(!footer().includes('⊗'));
  let hits = hitIds();
  assert.equal(hits[0], 'back');
  assert.ok(!hits.includes('npmStop'));
  assert.ok(hits.includes('npmRerun'));
  assert.ok(!hits.includes('npmEdit'));
  const runs = [];
  repo.runNpmCommand = (root, entry, onData, onClose) => {
    runs.push(entry.name);
    onData('again\n');
    return {
      kill() {
        onClose({ status: null, text: 'again\n' });
      },
    };
  };
  press(session, 'r');
  assert.deepEqual(runs, ['test']);
  assert.equal(session.view().npmRunning, true);
  press(session, 's');
  assert.equal(session.view().npmView, true);
  assert.equal(session.status, 'terminated');
  session.draw();
  hits = hitIds();
  assert.ok(!hits.includes('npmStop'));
  assert.ok(hits.includes('npmRerun'));
  press(session, 'escape');
  assert.equal(session.view().npmView, false);
  assert.equal(session.pane, 'npm');
  text = frameBody(session).join('\n');
  assert.match(text, /⠋/);
  assert.match(text, /⊘/);
});

test('npm sessions survive a restart', async () => {
  const { session, cwd, repo } = await openSession([sampleItem('a.js')], {
    startPane: 'files',
  });
  fs.writeFileSync(
    path.join(cwd, 'package.json'),
    `${JSON.stringify({
      scripts: { test: 'node --test', lint: 'eslint .' },
    })}\n`,
  );
  let written = null;
  repo.runNpmCommand = (root, entry, onData, onClose) => {
    onData('hello from test\n');
    written = onClose({ status: 0, text: 'hello from test\n' });
    return { kill() {} };
  };
  session.pushInput('r');
  press(session, 'enter');
  await written;
  press(session, 'escape');
  const again = await openSession([sampleItem('a.js')], {
    cwd,
    repo,
    startPane: 'files',
  });
  again.session.pushInput('r');
  let body = frameBody(again.session).join('\n');
  assert.match(body, /✔/);
  assert.match(body, /exit 0/);
  assert.ok(!body.includes('hello from test'));
  press(again.session, 'right', 'enter');
  assert.equal(again.session.view().npmView, true);
  body = frameBody(again.session).join('\n');
  assert.match(body, /hello from test/);
  assert.match(body, /exit 0/);
  press(again.session, 'v');
  body = frameBody(again.session).join('\n');
  assert.match(body, /hello from test/);
});

test('npm history keeps the newest 50 runs', async () => {
  const { session, cwd } = await openSession([sampleItem('a.js')], {
    startPane: 'files',
  });
  fs.writeFileSync(
    path.join(cwd, 'package.json'),
    `${JSON.stringify({ scripts: { test: 'node --test' } })}\n`,
  );
  session.pushInput('r');
  for (let exit = 0; exit < 51; exit++) {
    session.npm.runs.push({
      id: exit + 1,
      name: 'test',
      kind: 'script',
      command: 'node --test',
      status: 'exited',
      exit,
      startedAt: exit + 1,
      endedAt: exit + 2,
    });
  }
  const rows = session.npm.sessionRows();
  assert.equal(rows.length, 50);
  assert.equal(rows[0].total, 'exit 50');
  assert.equal(rows[0].mark, 'fail');
  assert.equal(rows[0].name, 'test');
  assert.equal(rows.at(-1).total, 'exit 1');
  assert.ok(rows[0].elapsed);
  assert.ok(rows[0].when);
});

test('npm history shows a command when it has no script name', async () => {
  const { session, cwd } = await openSession([sampleItem('a.js')], {
    startPane: 'files',
  });
  fs.writeFileSync(
    path.join(cwd, 'package.json'),
    `${JSON.stringify({ scripts: { lint: 'eslint .' } })}\n`,
  );
  const dir = path.join(cwd, '.log');
  fs.mkdirSync(dir);
  const record = {
    v: 1,
    id: 'earlier',
    command: 'reslop t -- node --test test/a.js',
    script: '',
    startedAt: 10,
    endedAt: 20,
    status: 'failed',
    exit: 1,
    progress: { done: 0, failed: 1, lines: 1 },
    log: '2026-10-10-node-01.log',
  };
  fs.writeFileSync(
    path.join(dir, '2026-10-10-node-01.json'),
    `${JSON.stringify(record)}\n`,
  );
  session.pushInput('r');
  session.npm.runs.push({
    id: 2,
    name: 'lint',
    kind: 'script',
    command: 'eslint .',
    status: 'exited',
    exit: 0,
    startedAt: 30,
    endedAt: 40,
  });
  const rows = session.npm.sessionRows();
  assert.equal(rows[0].name, 'lint');
  assert.equal(rows[0].total, 'exit 0');
  assert.equal(rows[0].mark, 'pass');
  assert.equal(rows[1].name, 'node --test test/a.js');
  assert.equal(rows[1].total, '');
  assert.equal(rows[1].done, '1');
  assert.equal(rows[1].ok, '0');
  assert.equal(rows[1].fail, '1');
  session.draw();
  const width = session.lastSize.width;
  const leftW = width - Math.floor(width * 0.7);
  const history = frameBody(session)
    .map((line) => line.slice(leftW))
    .join('\n');
  const passAt = history.indexOf('✔');
  const failAt = history.indexOf('✖');
  assert.ok(passAt >= 0 && failAt > passAt);
  assert.match(history, /exit 0/);
  assert.match(history, /command +done +ok +fail +total +duration +time/);
  assert.ok(!history.includes('reslop t'));
  assert.ok(!history.includes('……'));
});

test('a history row opens the captured log if the file is gone', async () => {
  const { session, cwd } = await openSession([sampleItem('a.js')], {
    startPane: 'files',
  });
  fs.writeFileSync(
    path.join(cwd, 'package.json'),
    `${JSON.stringify({ scripts: { test: 'reslop t -- node --test' } })}\n`,
  );
  const dir = path.join(cwd, '.log');
  fs.mkdirSync(dir);
  const failure = 'not ok 1 npm history caption\nassert.ok(failedRow)\n';
  fs.writeFileSync(path.join(dir, '2026-10-10-test-01.log'), failure);
  fs.writeFileSync(path.join(dir, '2026-10-10-test-01.raw'), failure);
  const saved = {
    reslop: 'npm-run',
    name: 'test',
    kind: 'script',
    command: 'reslop t -- node --test',
    status: 'exited',
    exit: 1,
    startedAt: 1000,
    endedAt: 5000,
    log: '2026-10-10-test-01.log',
    raw: '2026-10-10-test-01.raw',
    result: { tests: 950, passed: 949, failed: 1 },
  };
  fs.writeFileSync(
    path.join(dir, '2026-10-10-test-01.json'),
    `${JSON.stringify(saved)}\n`,
  );
  const recorded = {
    v: 1,
    id: 'inner',
    command: 'node --test',
    script: 'test',
    startedAt: 2000,
    endedAt: 4000,
    status: 'failed',
    exit: 1,
    progress: { done: 949, failed: 1, lines: 1, expected: 0 },
    result: { tests: 950, passed: 949, failed: 1 },
    log: '2026-10-10-node-01.log',
    raw: '2026-10-10-node-01.raw',
  };
  fs.writeFileSync(
    path.join(dir, '2026-10-10-node-01.json'),
    `${JSON.stringify(recorded)}\n`,
  );
  session.pushInput('r');
  const rows = session.npm.sessionRows();
  assert.equal(rows[0].name, 'test');
  assert.equal(rows[0].mark, 'fail');
  press(session, 'right', 'enter');
  assert.equal(session.view().npmView, true);
  assert.match(stripAnsi(session.npm.output), /✖ npm history caption/);
});
