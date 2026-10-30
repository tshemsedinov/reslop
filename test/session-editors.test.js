'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const helpers = require('./helpers.js');
const { tempDir, press, click, rightClick } = helpers;
const ansi = require('../lib/term/ansi.js');
const { stripAnsi } = ansi;
const { setTheme, themeName } = ansi;
const clipboard = require('../lib/term/select.js');
const { setImmediate: settle } = require('node:timers/promises');
const sessionHelpers = require('./session-helpers.js');
const { saveTask, sampleItem, openSession } = sessionHelpers;
const { clickFooter, dragBetween } = sessionHelpers;

const clickCaret = (session, dx, dy) => {
  const caret = session.lastFrame.cursor;
  assert.ok(caret);
  click(session, caret.x + dx, caret.y + dy);
};

test('click moves the caret in the code and file editors', async () => {
  const { session, repo } = await openSession([sampleItem('a.js')]);
  session.pushInput('e');
  session.editor.replace('ab\ncd');
  session.draw();
  const undo = session.editor.undo.length;
  clickCaret(session, -1, -1);
  assert.equal(session.mode, 'compose');
  assert.equal(session.editor.cursor, 1);
  assert.equal(session.editor.undo.length, undo);
  session.layout = 'side';
  session.editor.place(session.editor.text.length);
  session.draw();
  clickCaret(session, -1, 0);
  assert.equal(session.editor.cursor, 4);
  press(session, 'escape', 'escape');
  await session.ops.idle();
  repo.fileBodies['a.js'] = 'ab\ncd\n';
  session.dispatch('file');
  session.dispatch('next');
  await session.ops.idle();
  session.dispatch('open');
  session.dispatch('code');
  await session.ops.idle();
  assert.equal(session.composeKind, 'file');
  session.editor.place(2);
  session.draw();
  clickCaret(session, -2, 1);
  assert.equal(session.editor.cursor, 3);
});

test('click moves the caret in feedback and todo editors', async () => {
  const { session } = await openSession([sampleItem('a.js')]);
  session.dispatch('feedback');
  session.editor.replace('ab\ncd');
  session.draw();
  clickCaret(session, -1, -1);
  assert.equal(session.editor.cursor, 1);
  assert.equal(session.composeKind, 'feedback');
  press(session, 'escape');
  session.dispatch('tasks');
  session.pushInput('ship');
  saveTask(session);
  session.editor.replace('ab\ncd');
  session.draw();
  const box = session.lastFrame.taskHits.find((row) => row.check);
  assert.ok(box);
  click(session, box.x0 + 1, box.y);
  assert.equal(session.mode, 'compose');
  assert.equal(session.editor.text, 'ab\ncd');
  assert.equal(session.notes.tasks[0].done, true);
  session.draw();
  clickCaret(session, -1, -1);
  assert.equal(session.editor.cursor, 1);
});

test('click moves the caret in commit, branch, and npm editors', async () => {
  const { session, cwd } = await openSession([sampleItem('a.js', 'staged')], {
    startPane: 'files',
  });
  session.pushInput('c');
  press(session, 'insert');
  session.pushInput('hello');
  await session.ops.idle();
  session.draw();
  clickCaret(session, -4, 0);
  assert.equal(session.editor.cursor, 1);
  press(session, 'escape');
  session.pushInput('v');
  press(session, 'insert');
  await session.ops.idle();
  session.editor.replace('ab\ncd');
  session.draw();
  clickCaret(session, -1, -1);
  assert.equal(session.editor.cursor, 1);
  assert.equal(session.editor.text, 'ab\ncd');
  press(session, 'escape', 'escape');
  session.pushInput('b');
  await session.ops.idle();
  session.dispatch('newBranch');
  session.pushInput('topic');
  session.draw();
  clickCaret(session, -3, 0);
  assert.equal(session.composeKind, 'branch');
  assert.equal(session.editor.cursor, 2);
  press(session, 'escape', 'escape');
  fs.writeFileSync(
    path.join(cwd, 'package.json'),
    `${JSON.stringify({ scripts: { test: 'node --test' } })}\n`,
  );
  session.pushInput('r');
  session.pushInput('e');
  assert.equal(session.editor.text, 'test');
  session.draw();
  clickCaret(session, -3, 0);
  assert.equal(session.npm.editField, 'name');
  assert.equal(session.editor.cursor, 1);
  const command = session.lastFrame.editHits.find(
    (hit) => hit.field === 'command',
  );
  assert.ok(command);
  click(session, command.textX, command.y);
  assert.equal(session.npm.editField, 'command');
  assert.equal(session.editor.text, 'node --test');
  assert.equal(session.editor.cursor, 0);
  click(session, command.textX + 5, command.y);
  assert.equal(session.editor.cursor, 5);
});

const editRow = (session) => {
  const hit = session.lastFrame.editHits[0];
  if (!hit) return '';
  return stripAnsi(session.lastFrame.rows[hit.y - 1] ?? '');
};

const longValue = (head, tail) => `${head}${'m'.repeat(120)}${tail}`;

test('table editors scroll long lines horizontally', async () => {
  const { session, stdout, cwd } = await openSession(
    [sampleItem('a.js', 'staged')],
    {
      startPane: 'files',
    },
  );
  stdout.columns = 80;
  stdout.rows = 24;
  fs.writeFileSync(
    path.join(cwd, 'package.json'),
    `${JSON.stringify({ scripts: { test: 'node --test' } })}\n`,
  );
  const showsTail = (head, tail) => {
    session.draw();
    const row = editRow(session);
    assert.ok(row);
    assert.ok(session.editor.scrollCol > 0);
    assert.ok(row.includes(tail));
    assert.ok(!row.includes(head));
    return row;
  };
  session.pushInput('b');
  await session.ops.idle();
  session.dispatch('newBranch');
  session.editor.replace(longValue('Q', 'Z'));
  showsTail('Q', 'Z');
  const stuck = session.editor.scrollCol;
  const caret = session.lastFrame.cursor.x;
  press(session, 'left');
  session.draw();
  assert.equal(session.editor.scrollCol, stuck);
  assert.ok(session.lastFrame.cursor.x < caret);
  assert.ok(editRow(session).includes('Z'));
  const origin = session.lastFrame.cursor.x - session.editor.visibleLineCol();
  click(session, origin + session.editor.scrollCol, session.lastFrame.cursor.y);
  assert.equal(session.editor.cursor, stuck);
  press(session, 'home');
  session.draw();
  assert.equal(session.editor.scrollCol, 0);
  assert.ok(editRow(session).includes('Q'));
  press(session, 'escape', 'escape');
  session.pushInput('c');
  press(session, 'insert');
  await session.ops.idle();
  session.editor.replace(longValue('Q', 'Z'));
  showsTail('Q', 'Z');
  press(session, 'escape', 'escape');
  session.pushInput('r');
  session.pushInput('e');
  session.editor.replace(longValue('Q', 'Z'));
  showsTail('Q', 'Z');
  press(session, 'enter');
  session.editor.replace(longValue('A', 'B'));
  showsTail('A', 'B');
  assert.equal(session.npm.editField, 'command');
});

test('line numbers persist in .reslop', async () => {
  const cwd = tempDir('reslop-ui-');
  const file = path.join(cwd, '.reslop');
  fs.writeFileSync(
    file,
    `${JSON.stringify({ agents: { claude: { model: 'sonnet' } } })}\n`,
  );
  try {
    const { session } = await openSession([sampleItem('a.js')], { cwd });
    assert.equal(session.lineNumbers, false);
    press(session, 'ctrl-l');
    const on = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(on.editor.lineNumbers, true);
    assert.equal(on.lineNumbers, undefined);
    assert.deepEqual(on.agents.claude, { model: 'sonnet' });
    const again = await openSession([sampleItem('a.js')], { cwd });
    assert.equal(again.session.lineNumbers, true);
    press(again.session, 'ctrl-l');
    const off = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(off.editor.lineNumbers, false);
    assert.equal(off.lineNumbers, undefined);
    assert.deepEqual(off.agents.claude, { model: 'sonnet' });
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('editor general and commits settings persist in .reslop', async () => {
  const cwd = tempDir('reslop-ui-');
  const file = path.join(cwd, '.reslop');
  const legacy = { lineNumbers: true, agents: { claude: { model: 'sonnet' } } };
  fs.writeFileSync(file, `${JSON.stringify(legacy)}\n`);
  try {
    const { session } = await openSession([sampleItem('a.js')], { cwd });
    assert.equal(session.lineNumbers, true);
    assert.equal(session.layout, 'unified');
    assert.equal(themeName(), 'dark');
    press(session, 'm', 'l');
    session.pushInput('c');
    press(session, 'v');
    await session.ops.idle();
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(saved.lineNumbers, undefined);
    assert.equal(saved.editor.lineNumbers, true);
    assert.equal(saved.editor.mode, 'mixed');
    assert.equal(saved.general.theme, 'light');
    assert.equal(saved.commits.view, 'full');
    assert.deepEqual(saved.agents.claude, { model: 'sonnet' });
    setTheme('dark');
    const again = await openSession([sampleItem('a.js')], { cwd });
    assert.equal(again.session.lineNumbers, true);
    assert.equal(again.session.layout, 'mixed');
    assert.equal(again.session.commits.commitView, 'full');
    assert.equal(themeName(), 'light');
  } finally {
    setTheme('dark');
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('ctrl-l toggles line numbers on a diff and while editing', async () => {
  const { session } = await openSession([sampleItem('a.js')]);
  assert.equal(session.lineNumbers, false);
  press(session, 'ctrl-l');
  assert.equal(session.lineNumbers, true);
  assert.equal(session.status, 'line numbers');
  session.draw();
  const shown = stripAnsi(session.lastFrame.rows.join('\n'));
  assert.match(shown, / 1 - a/);
  assert.match(shown, / 1 \+ b/);
  press(session, 'ctrl-l');
  assert.equal(session.lineNumbers, false);
  assert.equal(session.status, 'no line numbers');
  session.pane = 'files';
  press(session, 'ctrl-l');
  assert.equal(session.lineNumbers, false);
  session.pane = 'diff';
  session.dispatch('code');
  const before = session.editor.text;
  press(session, 'ctrl-l');
  assert.equal(session.editor.text, before);
  assert.equal(session.lineNumbers, true);
  assert.equal(session.mode, 'compose');
  clickFooter(session, 'lines');
  assert.equal(session.lineNumbers, false);
  assert.equal(session.editor.text, before);
});

test('ctrl-c stays in every screen when no text is selected', async () => {
  const { session } = await openSession([sampleItem('a.js')]);
  for (const pane of [
    'dashboard',
    'repos',
    'files',
    'diff',
    'unit',
    'branches',
    'commits',
    'tasks',
    'npm',
    'packages',
    'agents',
  ]) {
    session.pane = pane;
    session.pushInput('\x03');
    assert.equal(session.done, false, pane);
    const editing = pane === 'tasks' ? 'compose' : 'review';
    assert.equal(session.mode, editing, pane);
    session.composer.tasks.closeEditor();
  }
});

test('ctrl-c copies the screen selection without quitting', async (t) => {
  const { session } = await openSession([sampleItem('a.js')]);
  session.draw();
  const at = session.lastFrame.rows.findIndex((row) => row.includes('a.js'));
  const plain = stripAnsi(session.lastFrame.rows[at]);
  const x = ansi.visibleWidth(plain.slice(0, plain.indexOf('a.js'))) + 1;
  session.nav.selection = {
    start: { x, y: at + 1 },
    end: { x: x + 3, y: at + 1 },
  };
  const copied = [];
  t.mock.method(clipboard, 'copyText', (text) => {
    copied.push(text);
    return true;
  });
  session.pushInput('\x1b[27;5;99~');
  assert.deepEqual(copied, ['a.js']);
  assert.equal(session.status, 'copied');
  assert.equal(session.done, false);
});

test('editors select with shift and copy cut paste', async () => {
  const { session, stdout } = await openSession([sampleItem('a.js')]);
  session.dispatch('feedback');
  session.editor.replace('hello');
  session.color = true;
  session.draw();
  const rowOf = (text) =>
    session.lastFrame.rows.find((row) => stripAnsi(row).includes(text));
  const before = rowOf('hello');
  press(session, 'shift-left', 'shift-left');
  assert.equal(session.editor.selectedText(), 'lo');
  session.draw();
  const after = rowOf('hello');
  assert.equal(stripAnsi(before), stripAnsi(after));
  assert.notEqual(before, after);
  const dumped = stdout.dump().length;
  press(session, 'ctrl-c');
  assert.equal(session.done, false);
  assert.equal(session.status, 'copied');
  assert.match(stdout.dump().slice(dumped), /\]52;/);
  press(session, 'ctrl-x');
  assert.equal(session.editor.text, 'hel');
  press(session, 'ctrl-c');
  assert.equal(session.done, false);
  assert.equal(session.editor.text, 'hel');
  press(session, 'ctrl-v');
  assert.equal(session.editor.text, 'hello');
  press(session, 'escape', 'e');
  session.editor.replace('abcd');
  press(session, 'shift-left');
  assert.equal(session.composeKind, 'code');
  assert.equal(session.editor.selectedText(), 'd');
  press(session, 'shift-up');
  assert.equal(session.editor.hasSelect(), true);
  press(session, 'escape', 'escape', 'b');
  await session.ops.idle();
  session.dispatch('newBranch');
  session.pushInput('topic');
  press(session, 'shift-home');
  assert.equal(session.composeKind, 'branch');
  assert.equal(session.editor.selectedText(), 'topic');
  press(session, 'escape', 'escape');
  session.dispatch('tasks');
  session.pushInput('ship');
  saveTask(session);
  session.editor.replace('ab\ncd');
  press(session, 'shift-up');
  assert.equal(session.editor.text, 'ab\ncd');
  assert.equal(session.editor.hasSelect(), true);
  assert.equal(session.composeKind, 'tasks');
  session.editor.replace('zxqv');
  session.draw();
  const taskBefore = rowOf('zxqv');
  press(session, 'shift-left', 'shift-left');
  assert.equal(session.editor.selectedText(), 'qv');
  assert.equal(session.view().taskEdit.anchor, 4);
  session.draw();
  const taskAfter = rowOf('zxqv');
  assert.equal(stripAnsi(taskBefore), stripAnsi(taskAfter));
  assert.notEqual(taskBefore, taskAfter);
});

for (const [kind, pane] of [
  ['feedback', 'diff'],
  ['branch', 'branches'],
  ['worktree', 'branches'],
  ['commit', 'commits'],
  ['package', 'packages'],
  ['npm', 'npm'],
  ['tasks', 'tasks'],
]) {
  test(`mouse and keyboard share selection in the ${kind} editor`, async () => {
    const { session, stdout } = await openSession([sampleItem('a.js')]);
    session.pane = pane;
    if (kind === 'tasks') {
      session.composer.tasks.onTasks();
      session.editor.replace('hello world');
    } else {
      session.composer.openCompose(kind, 'hello world');
    }
    if (kind === 'npm') session.npm.editField = 'name';
    session.editor.place(0);
    session.draw();
    const hit = session.lastFrame.editHits.find((entry) => entry.live);
    assert.ok(hit, kind);
    const before = stdout.dump().length;
    dragBetween(
      session,
      { x: hit.textX, y: hit.y },
      { x: hit.textX + 5, y: hit.y },
    );
    assert.equal(session.editor.selectedText(), 'hello');
    assert.equal(session.nav.selection, null);
    assert.equal(session.nav.editDrag, null);
    assert.equal(stdout.dump().length, before);
    press(session, 'shift-right');
    assert.equal(session.editor.selectedText(), 'hello ');
    press(session, 'ctrl-c');
    assert.equal(session.status, 'copied');
    assert.ok(stdout.dump().includes(Buffer.from('hello ').toString('base64')));
    rightClick(session, hit.textX + 1, hit.y);
    press(session, 'ctrl-c');
    assert.equal(session.editor.selectedText(), 'hello ');
    assert.equal(session.nav.contextMenu, null);
    assert.equal(session.mode, 'compose');
  });
}

test('code mouse selection spans lines and whole wide characters', async () => {
  const { session, stdout } = await openSession([sampleItem('a.js')]);
  session.dispatch('code');
  session.editor.replace('ab中👁️\ncd');
  session.editor.place(0);
  session.draw();
  const hits = session.lastFrame.editHits;
  assert.equal(hits.length, 2);
  dragBetween(
    session,
    { x: hits[0].textX + 1, y: hits[0].y },
    { x: hits[1].textX + 1, y: hits[1].y },
  );
  assert.equal(session.editor.selectedText(), 'b中👁️\nc');
  press(session, 'ctrl-c');
  assert.ok(stdout.dump().includes(Buffer.from('b中👁️\nc').toString('base64')));
  press(session, 'shift-right');
  assert.equal(session.editor.selectedText(), 'b中👁️\ncd');
  assert.equal(session.nav.selection, null);
});

test('reverse mouse drags select scrolled file text', async () => {
  const { session } = await openSession([sampleItem('a.js')]);
  session.pane = 'unit';
  session.nav.reviewPath = 'a.js';
  session.composer.openCompose('file', '0123456789'.repeat(20));
  session.composer.afterEdit();
  session.draw();
  const hit = session.lastFrame.editHits[0];
  const scroll = hit.scroll;
  assert.ok(scroll > 0);
  dragBetween(
    session,
    { x: hit.textX + 5, y: hit.y },
    { x: hit.textX + 1, y: hit.y },
  );
  assert.equal(
    session.editor.selectedText(),
    session.editor.text.slice(scroll + 1, scroll + 5),
  );
  assert.ok(session.editor.anchor > session.editor.cursor);
  assert.equal(session.nav.selection, null);
});

test('mouse selection spans visually wrapped feedback', async () => {
  const { session, stdout } = await openSession([sampleItem('a.js')]);
  stdout.columns = 20;
  session.composer.openCompose('feedback', 'alpha beta gamma delta epsilon');
  session.editor.place(0);
  session.draw();
  const hits = session.lastFrame.editHits;
  assert.equal(hits.length, 2);
  dragBetween(
    session,
    { x: hits[0].textX + 6, y: hits[0].y },
    { x: hits[1].textX + 2, y: hits[1].y },
  );
  assert.equal(session.editor.selectedText(), 'beta gamma de');
  assert.equal(session.nav.selection, null);
});

test('find and import mouse selections use their line editors', async () => {
  const { session } = await openSession([sampleItem('hello-world.js')]);
  session.pane = 'files';
  press(session, '/');
  session.pushInput('hello');
  session.draw();
  let hit = session.lastFrame.editHits.find((entry) => entry.editor);
  dragBetween(
    session,
    { x: hit.textX + 1, y: hit.y },
    { x: hit.textX + 4, y: hit.y },
  );
  assert.equal(session.nav.find.editor.selectedText(), 'ell');
  press(session, 'shift-right');
  assert.equal(session.nav.find.editor.selectedText(), 'ello');
  press(session, 'ctrl-c');
  assert.equal(session.status, 'copied');
  press(session, 'escape');
  session.composer.tasks.openTasksPage();
  session.dispatch('taskImport');
  session.pushInput('https://example.com');
  session.draw();
  hit = session.lastFrame.editHits.find((entry) => entry.editor);
  dragBetween(
    session,
    { x: hit.textX + 8, y: hit.y },
    { x: hit.textX + 15, y: hit.y },
  );
  assert.equal(session.nav.import.editor.selectedText(), 'example');
  rightClick(session, hit.textX + 10, hit.y);
  press(session, 'ctrl-c');
  assert.equal(session.nav.import.editor.selectedText(), 'example');
  assert.equal(session.mode, 'import');
  assert.equal(session.nav.selection, null);
});

test('the plan query keeps mouse selection in the open combo', async () => {
  const { session } = await openSession([sampleItem('a.js')]);
  session.composer.tasks.openTasksPage();
  session.composer.tasks.togglePlanMenu();
  session.pushInput('plan');
  session.draw();
  const hit = session.lastFrame.editHits.find((entry) => entry.editor);
  assert.ok(hit);
  dragBetween(
    session,
    { x: hit.textX, y: hit.y },
    { x: hit.textX + 2, y: hit.y },
  );
  assert.equal(session.composer.tasks.planPick.editor.selectedText(), 'pl');
  press(session, 'shift-right');
  assert.equal(session.composer.tasks.planPick.editor.selectedText(), 'pla');
  press(session, 'ctrl-c');
  assert.equal(session.status, 'copied');
  assert.equal(session.composer.tasks.planOpen, true);
  assert.equal(session.nav.selection, null);
});

test('find import and plan lines select and use the clipboard', async () => {
  const items = [
    sampleItem('src/app.js'),
    sampleItem('lib/find.js'),
    sampleItem('lib/files.js'),
  ];
  const { session, stdout } = await openSession(items);
  press(session, 'escape', '/');
  session.pushInput('lib/f');
  press(session, 'down');
  assert.equal(session.reviewPath, 'lib/find.js');
  session.pushInput('iles');
  press(session, 'ctrl-left');
  assert.equal(session.nav.find.editor.cursor, 4);
  press(session, 'shift-left');
  assert.equal(session.nav.find.editor.selectedText(), '/');
  const dumped = stdout.dump().length;
  press(session, 'ctrl-c');
  assert.equal(session.done, false);
  assert.equal(session.mode, 'find');
  assert.match(stdout.dump().slice(dumped), /\]52;/);
  press(session, 'left');
  assert.equal(session.nav.find.editor.cursor, 3);
  press(session, 'ctrl-right');
  assert.equal(session.nav.find.editor.cursor, 9);
  press(session, 'escape');
  session.dispatch('tasks');
  press(session, 'ctrl-i');
  session.pushInput('https://example.com/a');
  press(session, 'shift-left', 'shift-left');
  assert.equal(session.nav.import.editor.selectedText(), '/a');
  press(session, 'ctrl-x');
  assert.equal(session.nav.import.url, 'https://example.com');
  press(session, 'ctrl-v');
  assert.equal(session.nav.import.url, 'https://example.com/a');
  assert.equal(session.mode, 'import');
  press(session, 'escape', 'ctrl-p');
  session.pushInput('plan');
  press(session, 'ctrl-left');
  assert.equal(session.composer.tasks.planPick.editor.cursor, 0);
  press(session, 'shift-right', 'shift-right');
  assert.equal(session.composer.tasks.planPick.editor.selectedText(), 'pl');
  press(session, 'end');
  assert.equal(session.composer.tasks.planOpen, true);
});

test('slash searches paths on the files and diff screens', async () => {
  const items = [
    sampleItem('src/app.js'),
    sampleItem('lib/find.js'),
    sampleItem('lib/files.js'),
  ];
  const { session } = await openSession(items);
  press(session, 'escape');
  assert.equal(session.pane, 'files');
  press(session, '/');
  assert.equal(session.mode, 'find');
  session.pushInput('lib/f');
  assert.equal(session.view().find.query, 'lib/f');
  assert.equal(session.reviewPath, 'lib/files.js');
  press(session, 'down');
  assert.equal(session.reviewPath, 'lib/find.js');
  press(session, 'down');
  assert.equal(session.reviewPath, 'lib/files.js');
  press(session, 'up');
  assert.equal(session.reviewPath, 'lib/find.js');
  session.pushInput('j');
  assert.equal(session.view().find.query, 'lib/fj');
  assert.equal(session.reviewPath, 'lib/find.js');
  press(session, 'backspace');
  assert.equal(session.view().find.query, 'lib/f');
  assert.equal(session.reviewPath, 'lib/files.js');
  press(session, 'escape');
  assert.equal(session.mode, 'review');
  assert.equal(session.view().find, null);
  assert.equal(session.reviewPath, 'lib/files.js');
  session.pane = 'diff';
  session.scroll = 4;
  press(session, '/');
  session.pushInput('app');
  assert.equal(session.pane, 'diff');
  assert.equal(session.reviewPath, 'src/app.js');
  assert.equal(session.scroll, 0);
  press(session, 'escape');
  session.pane = 'branches';
  press(session, '/');
  assert.equal(session.mode, 'review');
  assert.equal(session.view().find, null);
});

test('the file view reads a file once, not on every frame', async () => {
  const { FileReads } = require('../lib/session/lifecycle.js');
  let calls = 0;
  const repo = {
    fileText: async (top, rel, rev) => {
      calls += 1;
      return `${rev}:${rel}`;
    },
  };
  const pending = [];
  const ops = { track: (promise) => pending.push(promise) };
  const ui = { repo, ops, top: '/repo', rev: 'abc123', paint: () => {} };
  const reads = new FileReads(ui);
  assert.equal(await reads.loadText('a.js'), 'abc123:a.js');
  assert.equal(reads.textOf('a.js'), 'abc123:a.js');
  assert.equal(reads.textOf('a.js'), 'abc123:a.js');
  assert.equal(calls, 1);
  assert.equal(reads.textOf('b.js'), '');
  assert.equal(reads.textOf('b.js'), '');
  await Promise.all(pending);
  assert.equal(reads.textOf('b.js'), 'abc123:b.js');
  assert.equal(calls, 2);
  ui.rev = 'def456';
  assert.equal(reads.cached('b.js'), null);
  assert.equal(await reads.loadText('b.js'), 'def456:b.js');
  assert.equal(calls, 3);
});

test('an external run whose record disappears stops spinning', async () => {
  const { RunRecorder } = require('../lib/runs/runs.js');
  const { session, cwd } = await openSession([sampleItem('a.js')], {
    startPane: 'npm',
  });
  const recorder = new RunRecorder(cwd, 'eslint .');
  session.npm.refreshRecorded();
  const run = session.npm.runs.find((entry) => entry.externalId);
  assert.equal(run.status, 'running');
  assert.equal(session.npm.running, true);
  fs.rmSync(recorder.slot.jsonFull, { force: true });
  session.npm.refreshRecorded();
  assert.equal(run.status, 'stopped');
  assert.equal(session.npm.running, false);
  assert.ok(run.endedAt > 0);
  recorder.finish(1);
  fs.rmSync(recorder.slot.jsonFull, { force: true });
});

test('repo writes run one at a time and in order', async () => {
  const { session } = await openSession([sampleItem('a.js')]);
  const seen = [];
  let release = null;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const slow = async () => {
    seen.push('slow start');
    await held;
    seen.push('slow end');
  };
  const failing = async () => {
    seen.push('failing');
    throw new Error('no');
  };
  const first = session.ops.exclusive(slow);
  const second = session.ops.exclusive(failing);
  const third = session.ops.exclusive(async () => seen.push('last'));
  assert.deepEqual(seen, ['slow start']);
  release();
  await first;
  await assert.rejects(second, /no/);
  await third;
  assert.deepEqual(seen, ['slow start', 'slow end', 'failing', 'last']);
  session.ops.exclusive(async () => seen.push('free'));
  assert.equal(seen.at(-1), 'free');
});

test('keys typed while a list loads are handled after it opens', async () => {
  const { session, repo } = await openSession([sampleItem('a.js')], {
    startPane: 'files',
  });
  let deliver = null;
  const list = repo.listCommits();
  repo.listCommits = () =>
    new Promise((resolve) => {
      deliver = () => resolve(list);
    });
  session.pushInput('c');
  session.pushInput('\x1b[B');
  await settle();
  assert.equal(session.pane, 'files');
  assert.equal(session.commitCursor, 0);
  deliver();
  await session.ops.idle();
  assert.equal(session.pane, 'commits');
  assert.equal(session.commitCursor, 1);
});

test('the file list and file view read the repo only once', async () => {
  const { session, repo } = await openSession([sampleItem('a.js')], {
    startPane: 'files',
  });
  const calls = { names: 0, text: 0 };
  const { listFiles, fileText } = repo;
  repo.listFiles = (...args) => {
    calls.names += 1;
    return listFiles(...args);
  };
  repo.fileText = (...args) => {
    calls.text += 1;
    return fileText(...args);
  };
  repo.extraFiles.push('z.js');
  session.dispatch('file');
  await session.ops.idle();
  for (let i = 0; i < 5; i++) session.view();
  const names = session.fileList().map((entry) => entry.path);
  assert.deepEqual(names, ['a.js', 'z.js']);
  assert.equal(calls.names, 1);
  session.dispatch('open');
  await session.ops.idle();
  assert.equal(session.pane, 'unit');
  for (let i = 0; i < 5; i++) session.view();
  assert.equal(calls.text, 1);
});

test('an action taken while editing code waits for the save', async () => {
  const items = [sampleItem('a.js'), sampleItem('b.js')];
  const { session, repo } = await openSession(items);
  let land = null;
  repo.edit = (top, item, text) =>
    new Promise((resolve) => {
      land = () => {
        repo.edited.push({ top, item, text });
        resolve();
      };
    });
  session.pushInput('e');
  session.pushInput('2');
  session.dispatch('next');
  await settle();
  assert.equal(session.mode, 'compose');
  assert.equal(session.index, 0);
  assert.equal(repo.edited.length, 0);
  land();
  await session.ops.idle();
  assert.equal(repo.edited.length, 1);
  assert.equal(repo.edited[0].text, 'b2');
  assert.equal(session.mode, 'review');
  assert.equal(session.index, 1);
});

test('a failed code save keeps the editor and drops the action', async () => {
  const items = [sampleItem('a.js'), sampleItem('b.js')];
  const { session, repo } = await openSession(items);
  repo.edit = async () => {
    throw new Error('disk full');
  };
  session.pushInput('e');
  session.pushInput('2');
  session.dispatch('next');
  await session.ops.idle();
  assert.equal(session.status, 'disk full');
  assert.equal(session.mode, 'compose');
  assert.equal(session.editor.text, 'b2');
  assert.equal(session.index, 0);
});

test('quitting while editing a file writes it before leaving', async () => {
  const { session, repo } = await openSession([sampleItem('a.js')], {
    startPane: 'files',
  });
  session.dispatch('file');
  await session.ops.idle();
  session.dispatch('open');
  session.dispatch('code');
  await session.ops.idle();
  assert.equal(session.composeKind, 'file');
  session.editor.replace('kept\n');
  session.onQuit();
  assert.equal(session.done, false);
  await session.ops.idle();
  assert.equal(repo.fileBodies['a.js'], 'kept\n');
  assert.equal(session.done, true);
});

test('an autosave and a save write the file in the order begun', async () => {
  const { session, repo } = await openSession([sampleItem('a.js')], {
    startPane: 'files',
  });
  session.dispatch('file');
  await session.ops.idle();
  session.dispatch('open');
  session.dispatch('code');
  await session.ops.idle();
  const order = [];
  const gates = [];
  repo.writeFile = (top, rel, text) =>
    new Promise((resolve) => {
      order.push(`start ${text}`);
      gates.push(() => {
        repo.fileBodies[rel] = text;
        order.push(`end ${text}`);
        resolve();
      });
    });
  session.editor.replace('one');
  session.autosave();
  session.editor.replace('two');
  press(session, 'ctrl-s');
  await settle();
  assert.deepEqual(order, ['start one']);
  gates[0]();
  await settle();
  gates[1]();
  await session.ops.idle();
  assert.deepEqual(order, ['start one', 'end one', 'start two', 'end two']);
  assert.equal(repo.fileBodies['a.js'], 'two');
  assert.equal(session.mode, 'review');
});

test('a file edit reloads once and later saves do not stage', async () => {
  const items = [sampleItem('a.js'), sampleItem('b.js')];
  const { session, repo } = await openSession(items);
  let loads = 0;
  const { load } = repo;
  repo.load = (...args) => {
    loads += 1;
    return load(...args);
  };
  session.pushInput('e');
  session.pushInput('2');
  press(session, 'escape');
  await session.ops.idle();
  assert.equal(repo.edited.length, 1);
  assert.deepEqual(repo.stagedPaths, ['a.js']);
  assert.equal(loads, 1);
  session.dispatch('next');
  session.pushInput('e');
  press(session, 'escape');
  await session.ops.idle();
  assert.equal(session.mode, 'review');
  assert.equal(repo.edited.length, 1);
  assert.deepEqual(repo.stagedPaths, ['a.js']);
  assert.equal(loads, 1);
  session.dispatch('feedback');
  session.pushInput('note');
  press(session, 'enter');
  await session.ops.idle();
  assert.equal(session.mode, 'review');
  assert.equal(session.notes.feedback.size, 1);
  assert.equal(loads, 1);
});

test('a package command that rejects shows the error and stops', async () => {
  const { session, repo } = await openSession([sampleItem('a.js')]);
  repo.runPackage = () => Promise.reject(new Error('registry down'));
  await session.packages.exec(['update', 'leftpad'], 'npm i', 'updated');
  assert.equal(session.status, 'registry down');
  assert.equal(session.packages.running, false);
  assert.equal(session.busy, '');
  repo.runPackage = () => {
    throw new Error('no npm');
  };
  await session.packages.exec(['update', 'leftpad'], 'npm i', 'updated');
  assert.equal(session.status, 'no npm');
  assert.equal(session.busy, '');
});

const editFile = async (items) => {
  const opened = await openSession(items, { startPane: 'files' });
  const { session } = opened;
  session.dispatch('file');
  await session.ops.idle();
  session.dispatch('open');
  session.dispatch('code');
  await session.ops.idle();
  assert.equal(session.composeKind, 'file');
  return opened;
};

const heldLoad = (repo) => {
  const { load } = repo;
  let release = null;
  repo.load = (...args) =>
    new Promise((resolve) => {
      release = () => resolve(load(...args));
    });
  return () => release();
};

test('a reload does not undo an autosave that landed meanwhile', async () => {
  const { session, repo } = await editFile([sampleItem('a.js')]);
  const finishLoad = heldLoad(repo);
  session.refreshFromRepo({ keepView: true, quiet: true });
  await settle();
  session.editor.replace('typed\n');
  session.autosave();
  await settle();
  assert.equal(repo.fileBodies['a.js'], 'typed\n');
  finishLoad();
  await session.ops.idle();
  assert.equal(session.editor.text, 'typed\n');
  assert.equal(session.composer.composeBaseline, 'typed\n');
  assert.equal(session.reads.textOf('a.js'), 'typed\n');
});

test('a reload keeps unsaved typing when the disk is unchanged', async () => {
  const { session, repo } = await editFile([sampleItem('a.js')]);
  const opened = session.editor.text;
  let land = null;
  const { writeFile } = repo;
  repo.writeFile = (...args) =>
    new Promise((resolve) => {
      land = () => resolve(writeFile(...args));
    });
  session.editor.replace('typed\n');
  session.autosave();
  session.refreshFromRepo({ keepView: true, quiet: true });
  await settle();
  assert.equal(session.editor.text, 'typed\n');
  land();
  await session.ops.idle();
  assert.equal(session.editor.text, 'typed\n');
  assert.equal(repo.fileBodies['a.js'], 'typed\n');
  repo.fileBodies['a.js'] = `${opened}outside\n`;
  session.refreshFromRepo({ keepView: true, quiet: true });
  await session.ops.idle();
  assert.equal(session.editor.text, `${opened}outside\n`);
});

test('a code save does not wait for a running install', async () => {
  const proposed = sampleItem('package.json');
  proposed.reload = true;
  proposed.dep = {
    change: { propose: true, name: 'lodash' },
    files: ['package.json'],
  };
  const { session, repo } = await openSession([proposed, sampleItem('z.js')]);
  let finish = null;
  const installing = new Promise((resolve) => {
    finish = resolve;
  });
  const options = [];
  repo.add = (top, item, extra) => {
    options.push(extra);
    return item.dep ? installing : undefined;
  };
  session.dispatch('add');
  await settle();
  assert.equal(session.busy, 'npm i');
  assert.equal(typeof options[0].locked, 'function');
  session.dispatch('next');
  session.pushInput('e');
  session.pushInput('2');
  press(session, 'escape');
  await settle();
  assert.equal(repo.edited.length, 1);
  assert.equal(session.mode, 'review');
  assert.equal(session.ops.holds, 0);
  finish();
  await session.ops.idle();
  assert.equal(session.busy, '');
});

const gatedAdds = (repo) => {
  const gates = [];
  const done = [];
  repo.add = (top, item) =>
    new Promise((resolve) => {
      gates.push(() => {
        done.push(item);
        resolve();
      });
    });
  return { gates, done };
};

test('quitting lets a running stage finish every hunk first', async () => {
  const second = sampleItem('a.js');
  second.blockId = 1;
  const { session, repo } = await openSession([sampleItem('a.js'), second], {
    startPane: 'files',
  });
  const { gates, done } = gatedAdds(repo);
  session.dispatch('add');
  await settle();
  assert.equal(gates.length, 1);
  session.onQuit();
  session.pushInput('u');
  assert.equal(session.done, false);
  gates[0]();
  await settle();
  assert.equal(session.done, false);
  assert.equal(gates.length, 2);
  gates[1]();
  await session.ops.idle();
  assert.equal(done.length, 2);
  assert.equal(session.done, true);
  assert.equal(repo.unstageCalls.length, 0);
});

test('quitting does not wait for an install or a stuck write', async () => {
  const proposed = sampleItem('package.json');
  proposed.reload = true;
  proposed.dep = {
    change: { propose: true, name: 'lodash' },
    files: ['package.json'],
  };
  const { session, repo } = await openSession([proposed]);
  repo.add = () => new Promise(() => {});
  session.dispatch('add');
  await settle();
  assert.equal(session.busy, 'npm i');
  session.onQuit();
  assert.equal(session.done, true);
  const stuck = await openSession([sampleItem('a.js')]);
  stuck.repo.add = () => new Promise(() => {});
  stuck.session.dispatch('add');
  await settle();
  assert.equal(stuck.session.ops.unlanded(), true);
  const before = Date.now();
  await stuck.session.ops.landed(30);
  assert.ok(Date.now() - before < 1000);
  assert.equal(stuck.session.ops.unlanded(), true);
});

test('leaving the editor does not stage a change made outside', async () => {
  const { session, repo } = await editFile([sampleItem('a.js')]);
  repo.fileBodies['a.js'] = 'outside\n';
  session.refreshFromRepo({ keepView: true, quiet: true });
  await session.ops.idle();
  assert.equal(session.editor.text, 'outside\n');
  press(session, 'escape');
  await session.ops.idle();
  assert.equal(session.mode, 'review');
  assert.equal(session.status, 'saved');
  assert.deepEqual(repo.stagedPaths, []);
  session.dispatch('code');
  await session.ops.idle();
  repo.fileBodies['a.js'] = 'again\n';
  session.refreshFromRepo({ keepView: true, quiet: true });
  await session.ops.idle();
  session.editor.replace('again\nmine\n');
  press(session, 'escape');
  await session.ops.idle();
  assert.equal(session.status, 'staged');
  assert.deepEqual(repo.stagedPaths, ['a.js']);
});
