'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const helpers = require('./helpers.js');
const { uiSink, press, click, rightClick } = helpers;
const ansi = require('../lib/term/ansi.js');
const { stripAnsi, THEME, BOLD, seq, bg } = ansi;
const { REVIEW_DIR } = require('../lib/common/files.js');
const clipboard = require('../lib/term/select.js');
const sessionHelpers = require('./session-helpers.js');
const { rowOf, focusedRow, focusTask, today, sampleItem } = sessionHelpers;
const { openSession } = sessionHelpers;

test('compose arrows move by visual wrap rows', async () => {
  const stdout = uiSink();
  stdout.columns = 10;
  const { session } = await openSession([sampleItem('a.js')], { stdout });
  session.dispatch('feedback');
  session.pushInput('hello world');
  press(session, 'up');
  assert.equal(session.editor.cursor, 5);
  press(session, 'down');
  assert.equal(session.editor.cursor, 11);
});

test('compose cursor uses the terminal blinking cursor', async () => {
  const item = sampleItem('a.js');
  const { session, stdout } = await openSession([item]);
  session.dispatch('feedback');
  session.draw();
  const on = stdout.dump();
  assert.ok(on.includes('[1 q'));
  assert.ok(on.includes('[?12h'));
  assert.ok(on.includes('[?25h'));
  session.draw();
  assert.equal(stdout.dump(), on);
});

test('enter and escape save feedback and return to browse', async () => {
  const item = sampleItem('a.js');
  const { session } = await openSession([item]);
  session.dispatch('feedback');
  session.pushInput('note');
  press(session, 'enter');
  assert.equal(session.mode, 'review');
  assert.equal(session.done, false);
  const key = 'a.js:1:1:0';
  assert.equal(session.notes.feedback.get(key).text, 'note');
  session.dispatch('feedback');
  session.pushInput(' two');
  press(session, 'escape');
  assert.equal(session.mode, 'review');
  assert.equal(session.done, false);
  assert.equal(session.notes.feedback.get(key).text, 'note two');
  assert.equal(session.status, 'saved');
});

test('editing feedback keeps one latest version', async () => {
  const item = sampleItem('a.js');
  const { session } = await openSession([item]);
  session.dispatch('feedback');
  session.pushInput('first');
  press(session, 'ctrl-s');
  session.dispatch('feedback');
  session.pushInput(' more');
  session.autosave();
  press(session, 'ctrl-s');
  const key = 'a.js:1:1:0';
  assert.equal(session.notes.feedback.size, 1);
  assert.equal(session.notes.feedback.get(key).text, 'first more');
  session.dispatch('feedback');
  assert.equal(session.editor.text, 'first more');
  const view = session.view();
  assert.equal(view.compose.text, 'first more');
  assert.ok(!view.compose.text.includes('\n1 '));
});

test('feedback templates count reuse on another hunk, not a save', async () => {
  const a = sampleItem('a.js');
  const b = sampleItem('b.js');
  const { session } = await openSession([a, b]);
  session.dispatch('feedback');
  session.pushInput('extract helper');
  press(session, 'ctrl-s');
  session.dispatch('feedback');
  press(session, 'ctrl-s');
  assert.equal(session.notes.templates.length, 1);
  assert.equal(session.notes.templates[0].count, 1);
  session.dispatch('next');
  session.dispatch('feedback');
  session.pushInput('extract helper');
  press(session, 'ctrl-s');
  assert.equal(session.notes.templates.length, 1);
  assert.equal(session.notes.templates[0].text, 'extract helper');
  assert.equal(session.notes.templates[0].count, 2);
});

test('feedback templates pick with tab arrows enter and click', async () => {
  const { session } = await openSession([
    sampleItem('a.js'),
    sampleItem('b.js'),
  ]);
  session.notes.templates = [
    { text: 'extract helper', count: 2 },
    { text: 'add tests', count: 1 },
  ];
  const feedKey = 'a.js:1:1:0';
  session.dispatch('feedback');
  assert.equal(session.mode, 'compose');
  session.draw();
  const body = stripAnsi(session.lastFrame.rows.join('\n'));
  assert.match(body, /extract helper/);
  assert.match(body, /add tests/);
  press(session, 'tab');
  assert.equal(session.mode, 'review');
  assert.equal(session.notes.feedback.get(feedKey).text, 'extract helper');
  session.dispatch('feedback');
  session.editor.replace('');
  press(session, 'down');
  assert.equal(session.mode, 'compose');
  assert.equal(session.templateFocus, true);
  assert.equal(session.templateIndex, 0);
  press(session, 'enter');
  assert.equal(session.mode, 'review');
  assert.equal(session.notes.feedback.get(feedKey).text, 'extract helper');
  session.dispatch('feedback');
  session.editor.replace('');
  session.draw();
  const hit = session.lastFrame.templateHits.find((row) => row.cursor === 1);
  assert.ok(hit);
  click(session, 2, hit.y);
  assert.equal(session.mode, 'review');
  assert.equal(session.notes.feedback.get(feedKey).text, 'add tests');
});

test('feedback templates filter by prefix and hide if none match', async () => {
  const { session } = await openSession([sampleItem('a.js')]);
  session.notes.templates = [
    { text: 'extract helper', count: 2 },
    { text: 'add tests', count: 1 },
  ];
  session.dispatch('feedback');
  session.draw();
  let body = stripAnsi(session.lastFrame.rows.join('\n'));
  assert.match(body, /extract helper/);
  assert.match(body, /add tests/);
  session.pushInput('ex');
  session.draw();
  body = stripAnsi(session.lastFrame.rows.join('\n'));
  assert.match(body, /extract helper/);
  assert.ok(!body.includes('add tests'));
  assert.equal(session.lastFrame.templateHits.length, 1);
  press(session, 'tab');
  assert.equal(session.mode, 'review');
  assert.equal(session.notes.feedback.get('a.js:1:1:0').text, 'extract helper');
  session.dispatch('feedback');
  session.draw();
  body = stripAnsi(session.lastFrame.rows.join('\n'));
  assert.match(body, /extract helper/);
  assert.ok(!body.includes('add tests'));
  assert.equal(session.lastFrame.templateHits.length, 0);
  session.editor.replace('');
  session.pushInput('z');
  session.draw();
  body = stripAnsi(session.lastFrame.rows.join('\n'));
  assert.ok(!body.includes('extract helper'));
  assert.ok(!body.includes('add tests'));
  assert.equal(session.lastFrame.templateHits.length, 0);
  press(session, 'tab');
  assert.equal(session.editor.text, 'z');
  press(session, 'backspace');
  session.draw();
  body = stripAnsi(session.lastFrame.rows.join('\n'));
  assert.match(body, /extract helper/);
  assert.match(body, /add tests/);
});

test('e edits added lines in the reviewed file', async () => {
  const item = sampleItem('a.js');
  const { session, repo } = await openSession([item]);
  session.pushInput('e');
  assert.equal(session.mode, 'compose');
  assert.equal(session.composeKind, 'code');
  assert.equal(session.editor.text, 'b');
  assert.equal(session.view().compose, null);
  session.draw();
  const body = stripAnsi(session.lastFrame.rows.join('\n'));
  assert.match(body, /\+ b/);
  assert.ok(session.lastFrame.cursor);
  assert.equal(session.lastFrame.cursor.x, 4);
  session.pushInput('2');
  press(session, 'enter');
  assert.equal(session.mode, 'compose');
  assert.equal(session.editor.text, 'b2\n');
  press(session, 'escape');
  await session.ops.idle();
  assert.equal(session.mode, 'review');
  assert.equal(session.notes.code.size, 0);
  assert.equal(session.view().counts.code, 0);
  assert.equal(repo.edited.length, 1);
  assert.equal(repo.edited[0].text, 'b2\n');
  assert.equal(repo.edited[0].item.file.newPath, 'a.js');
  assert.deepEqual(repo.stagedPaths, ['a.js']);
});

test('e on a read-only commit keeps a code proposal', async () => {
  const item = sampleItem('a.js', 'commit');
  const { session, repo } = await openSession([item], { rev: 'abc1234' });
  session.pushInput('e');
  session.pushInput('2');
  press(session, 'escape');
  assert.equal(repo.edited.length, 0);
  const note = session.notes.code.get('a.js:1:1:0');
  assert.equal(note.text, 'b2');
  assert.equal(session.view().counts.code, 1);
});

test('code save equal to original drops the proposal', async () => {
  const item = sampleItem('a.js');
  const { session, repo } = await openSession([item]);
  session.dispatch('code');
  press(session, 'escape');
  assert.equal(session.notes.code.size, 0);
  assert.equal(session.view().counts.code, 0);
  assert.equal(repo.stagedPaths.length, 0);
});

test('todos screen ignores commit and todo hotkeys', async () => {
  const { session } = await openSession([sampleItem('a.js')]);
  session.dispatch('tasks');
  assert.equal(session.tasksOpen, true);
  assert.equal(session.composeKind, 'tasks');
  session.dispatch('commit');
  assert.equal(session.composeKind, 'tasks');
  session.dispatch('tasks');
  assert.equal(session.composeKind, 'tasks');
});

test('right click opens task operations with their hotkeys', async () => {
  const { session } = await openSession([sampleItem('a.js')]);
  session.notes.addTask('a.js', 'context target');
  session.composer.tasks.openTasksPage();
  session.draw();
  const at = rowOf(session, 'context target');
  const hit = session.lastFrame.taskHits.find(
    (entry) => entry.cursor === at && !entry.check,
  );
  rightClick(session, 10, hit.y);
  assert.equal(session.tasksFocus, at);
  assert.deepEqual(session.nav.contextMenu.actions, [
    'taskNew',
    'taskDone',
    'taskPriority',
    'taskField',
    'taskOpen',
    'taskDrop',
  ]);
  const shown = session.lastFrame.contextHits.map((entry) =>
    stripAnsi(session.lastFrame.rows[entry.y - 1]),
  );
  assert.ok(shown.some((row) => row.includes('ins  new task below')));
  assert.ok(shown.some((row) => row.includes('^d   done')));
  assert.ok(shown.some((row) => row.includes('^l   priority…')));
  assert.ok(shown.some((row) => row.includes('^r   delete')));
  press(session, 'ctrl-l', 'h');
  assert.equal(focusedRow(session), '[ ] high: context target');
  focusTask(session, rowOf(session, 'Feature requests'));
  session.draw();
  const head = session.lastFrame.taskHits.find(
    (entry) => entry.cursor === session.tasksFocus,
  );
  rightClick(session, 10, head.y);
  assert.deepEqual(session.nav.contextMenu.actions, [
    'taskNew',
    'blockMenu',
    'taskExpand',
    'taskDrop',
  ]);
  press(session, 'tab');
  assert.equal(session.nav.contextMenu, null);
  assert.equal(rowOf(session, 'context target'), -1);
});

test('blank branch space offers screen commands', async () => {
  const { session } = await openSession([sampleItem('a.js')]);
  session.pane = 'files';
  session.draw();
  rightClick(session, 20, session.lastFrame.height - 3);
  assert.equal(session.nav.contextMenu, null);
  session.pane = 'branches';
  session.gitBranches.branches = [{ name: 'main', current: true }];
  session.draw();
  rightClick(session, 20, session.lastFrame.height - 3);
  assert.deepEqual(session.nav.contextMenu.actions, [
    'newBranch',
    'worktreeBranch',
    'pull',
    'push',
  ]);
  assert.equal(session.nav.contextMenu.actions.includes('back'), false);
  press(session, 'insert');
  assert.equal(session.composeKind, 'branch');
});

test('dashboard and combo boxes suppress context menus', async () => {
  const { session } = await openSession([sampleItem('a.js')]);
  session.pane = 'dashboard';
  session.draw();
  rightClick(session, 10, 3);
  assert.equal(session.nav.contextMenu, null);
  session.pane = 'agents';
  session.draw();
  session.lastFrame.fileHits = [];
  rightClick(session, 10, session.lastFrame.height - 3);
  assert.equal(session.nav.contextMenu, null);
  session.lastFrame.fileHits = [
    { y: 3, x0: 0, x1: 20, cursor: 0, field: 'effort' },
  ];
  rightClick(session, 10, 3);
  assert.equal(session.nav.contextMenu, null);
  session.lastFrame.fileHits = [
    { y: 3, x0: 0, x1: 20, cursor: 0, field: 'name' },
  ];
  rightClick(session, 10, 3);
  const actions = session.nav.contextMenu.actions;
  for (const id of [
    'agentEffort',
    'agentModel',
    'agentContext',
    'agentReview',
  ]) {
    assert.equal(actions.includes(id), false);
  }
});

test('context menus track hover and refuse disabled actions', async () => {
  const { session, repo } = await openSession([sampleItem('a.js')]);
  session.pane = 'branches';
  session.gitBranches.branches = [{ name: 'main', current: true }];
  session.draw();
  const row = session.lastFrame.fileHits[0];
  rightClick(session, 10, row.y);
  assert.ok(session.nav.contextMenu.disabled.includes('drop'));
  const drop = session.lastFrame.contextHits.find((hit) => hit.id === 'drop');
  assert.equal(drop.disabled, true);
  press(session, 'delete');
  assert.equal(session.mode, 'review');
  assert.ok(session.nav.contextMenu);
  click(session, drop.x0 + 2, drop.y);
  assert.ok(session.nav.contextMenu);
  const pull = session.lastFrame.contextHits.find((hit) => hit.id === 'pull');
  session.pushInput(`\x1b[<35;${pull.x0 + 2};${pull.y}M`);
  assert.equal(session.nav.contextMenu.cursor, pull.cursor);
  assert.equal(repo.drops.length, 0);
  press(session, 'escape');
  assert.equal(session.nav.contextMenu, null);
});

test('editor context commands preserve and edit selected text', async () => {
  const { session, stdout } = await openSession([sampleItem('a.js')]);
  session.dispatch('tasks');
  session.pushInput('keep this text');
  const editor = session.editor;
  editor.anchor = 5;
  editor.cursor = 9;
  session.draw();
  const hit = session.lastFrame.editHits.find((entry) => entry.live);
  rightClick(session, hit.textX, hit.y);
  assert.deepEqual(session.nav.contextMenu.actions, [
    'textCut',
    'textCopy',
    'textPaste',
    'textDelete',
    'textSelectAll',
  ]);
  press(session, 'ctrl-c');
  assert.ok(stdout.dump().includes(Buffer.from('this').toString('base64')));
  assert.equal(editor.selectedText(), 'this');
  rightClick(session, hit.textX, hit.y);
  press(session, 'delete');
  assert.equal(editor.text, 'keep  text');
  assert.equal(session.mode, 'compose');
  session.draw();
  rightClick(session, hit.textX, hit.y);
  press(session, 'ctrl-a');
  assert.equal(editor.selectedText(), 'keep  text');
  rightClick(session, hit.textX, hit.y);
  press(session, 'ctrl-x');
  assert.equal(editor.text, '');
});

test('import textbox context paste keeps the textbox focused', async (t) => {
  const { session } = await openSession([sampleItem('a.js')]);
  session.composer.tasks.openTasksPage();
  session.dispatch('taskImport');
  session.draw();
  const statusY = session.lastFrame.height - 1;
  t.mock.method(clipboard, 'pasteText', () => 'https://example.com/a\n');
  rightClick(session, 10, statusY);
  const paste = session.lastFrame.contextHits.find(
    (hit) => hit.id === 'textPaste',
  );
  click(session, paste.x0 + 2, paste.y);
  assert.equal(session.mode, 'import');
  assert.equal(session.nav.import.url, 'https://example.com/a');
  assert.equal(session.nav.contextMenu, null);
});

test('todo list scrolls the focused row into view', async () => {
  const { session, stdout } = await openSession([sampleItem('a.js')]);
  stdout.rows = 12;
  for (let i = 0; i < 30; i++) session.notes.addTask('a.js', `item ${i}`);
  session.composer.tasks.openTasksPage();
  focusTask(session, rowOf(session, 'item 0'));
  session.draw();
  const top = stripAnsi(session.lastFrame.rows.join('\n'));
  assert.match(top, /item 0(?!\d)/);
  assert.ok(!/item 29(?!\d)/.test(top));
  assert.equal(session.scroll, 0);
  for (let i = 0; i < 25; i++) session.dispatch('scrollDown');
  session.draw();
  const down = stripAnsi(session.lastFrame.rows.join('\n'));
  assert.match(down, /item 25(?!\d)/);
  assert.ok(!/item 0(?!\d)/.test(down));
  assert.ok(session.scroll > 0);
  session.handleEvent({
    type: 'mouse',
    kind: 'wheelUp',
    button: 64,
    x: 2,
    y: 4,
    press: true,
  });
  session.draw();
  const up = stripAnsi(session.lastFrame.rows.join('\n'));
  assert.equal(focusedRow(session), '[ ] item 24');
  assert.match(up, /item 24(?!\d)/);
  session.dispatch('pageDown');
  session.draw();
  const paged = stripAnsi(session.lastFrame.rows.join('\n'));
  assert.equal(focusedRow(session), '[ ] item 29');
  assert.match(paged, /item 29/);
  assert.ok(!/item 0(?!\d)/.test(paged));
});

test('scrolling to the top shows the first header and blank line', async () => {
  const { session, stdout } = await openSession([sampleItem('a.js')]);
  stdout.rows = 12;
  for (let i = 0; i < 30; i++) session.notes.addTask('a.js', `item ${i}`);
  session.composer.tasks.openTasksPage();
  focusTask(session, 0);
  for (let i = 0; i < 25; i++) session.dispatch('scrollDown');
  session.draw();
  assert.ok(session.scroll > 0);
  session.dispatch('home');
  session.draw();
  assert.equal(session.tasksFocus, 0);
  assert.equal(session.scroll, 0);
  const rows = session.lastFrame.rows.map((row) => stripAnsi(row));
  assert.equal(rows[1].trim(), '');
  assert.match(rows[2], /Agent instructions/);
  assert.match(rows[3], /Work through unchecked items/);
});

test('tasks list ends with a blank line after the blocks', async () => {
  const { session, stdout } = await openSession([sampleItem('a.js')]);
  stdout.rows = 12;
  for (let i = 0; i < 30; i++) session.notes.addTask('a.js', `item ${i}`);
  session.composer.tasks.openTasksPage();
  session.draw();
  const statusAt = session.lastFrame.rows.length - 2;
  const plain = () => session.lastFrame.rows.map((row) => stripAnsi(row));
  assert.ok(session.lastFrame.scrollMax > 0);
  assert.notEqual(plain()[statusAt - 1].trim(), '');
  session.dispatch('end');
  session.draw();
  assert.equal(session.scroll, session.lastFrame.scrollMax);
  const endRows = plain();
  assert.equal(endRows[statusAt - 1].trim(), '');
  assert.notEqual(endRows[statusAt - 2].trim(), '');
  session.dispatch('home');
  session.draw();
  assert.equal(session.scroll, 0);
  assert.notEqual(plain()[statusAt - 1].trim(), '');
});

test('a short tasks list does not scroll for a trailing blank', async () => {
  const { session, stdout } = await openSession([sampleItem('a.js')]);
  stdout.rows = 40;
  session.composer.tasks.openTasksPage();
  session.draw();
  assert.equal(session.lastFrame.scrollMax, 0);
});

test('ctrl+up and ctrl+down reorder tasks and stay inside a file', async () => {
  const { session, stdout } = await openSession([sampleItem('a.js')]);
  stdout.columns = 140;
  session.dispatch('tasks');
  session.pushInput('first');
  press(session, 'insert');
  session.pushInput('second');
  focusTask(session, rowOf(session, 'first'));
  press(session, 'ctrl-down');
  assert.deepEqual(
    session.notes.tasks.map((task) => task.text),
    ['second', 'first'],
  );
  press(session, 'ctrl-down');
  const moved = session.notes.tasks.find((task) => task.text === 'first');
  assert.equal(moved.kind, 'features');
  session.notes.setFeedback('a.js:1:1:0', {
    file: 'a.js',
    oldStart: 1,
    newStart: 1,
    blockId: 0,
    text: 'quote one',
  });
  session.notes.setFeedback('a.js:2:2:0', {
    file: 'a.js',
    oldStart: 2,
    newStart: 2,
    blockId: 0,
    text: 'quote two',
  });
  for (const task of session.notes.tasks) session.notes.removeTask(task.id);
  session.notes.addTask('TODOs', 'only', false, 'security');
  const rows = session.composer.tasks.rows();
  const security = rows.findIndex(
    (row) => row.task && row.task.text === 'only',
  );
  focusTask(session, security);
  press(session, 'ctrl-down');
  assert.equal(session.notes.tasks[0].kind, 'security');
  const quote = session.composer.tasks
    .rows()
    .findIndex((row) => row.quote && row.note.text === 'quote one');
  focusTask(session, quote);
  press(session, 'ctrl-down');
  const quoted = [];
  for (const note of session.notes.feedback.values()) quoted.push(note.text);
  assert.deepEqual(quoted, ['quote two', 'quote one']);
  press(session, 'ctrl-up', 'ctrl-up');
  const stayed = [];
  for (const note of session.notes.feedback.values()) stayed.push(note.text);
  assert.deepEqual(stayed, ['quote one', 'quote two']);
  assert.equal(session.notes.tasks[0].kind, 'security');
  session.draw();
  const body = stripAnsi(session.lastFrame.rows.join('\n'));
  assert.match(body, /a\.js/);
  assert.match(body, /quote one/);
  assert.match(body, /ctrl\+up\/dn/);
  assert.equal(body.includes('ctrl+down'), false);
});

test('quoted feedback can be edited from the tasks screen', async () => {
  const { session } = await openSession([sampleItem('a.js')]);
  session.notes.setFeedback('a.js:1:1:0', {
    file: 'a.js',
    oldStart: 1,
    newStart: 1,
    blockId: 0,
    text: 'quote',
  });
  session.composer.tasks.openTasksPage();
  const quote = session.composer.tasks.rows().findIndex((row) => row.quote);
  focusTask(session, quote);
  session.pushInput(' more');
  press(session, 'ctrl-d');
  const note = session.notes.feedback.get('a.js:1:1:0');
  assert.equal(note.text, 'quote more');
  assert.equal(note.done, true);
});

test('tasks status switches plan files, defaults to the last', async () => {
  const { session, cwd } = await openSession([sampleItem('a.js')]);
  const dir = path.join(cwd, REVIEW_DIR);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, '2020-01-01-00.md'),
    [
      '---',
      'status: editing',
      '---',
      '',
      '## Feature requests',
      '',
      '- [ ] from older',
      '',
    ].join('\n'),
  );
  session.dispatch('tasks');
  session.draw();
  const status = stripAnsi(session.lastFrame.rows.at(-2));
  const current = session.composer.tasks.planName();
  const names = session.composer.tasks.planNames();
  assert.equal(names.at(-1), current);
  assert.ok(names.includes('2020-01-01-00.md'));
  assert.ok(status.includes(current));
  assert.equal(status.includes('▾'), false);
  assert.match(status, /open \d+ · done \d+\/\d+\s*$/);
  const ratios = status.match(/\d+\/\d+/g);
  assert.deepEqual(ratios, [status.match(/done (\d+\/\d+)/)[1]]);
  session.composer.tasks.togglePlanMenu();
  session.draw();
  const menu = stripAnsi(session.lastFrame.rows.join('\n'));
  assert.match(menu, /2020-01-01-00\.md\s+editing/);
  const hit = session.lastFrame.statusHits.find(
    (entry) => entry.id === 'plan-item' && entry.cursor === 0,
  );
  assert.ok(hit);
  click(session, hit.x0 + 1, hit.y);
  assert.equal(session.composer.tasks.planOpen, false);
  assert.match(session.composer.tasks.planName(), /2020-01-01-00\.md/);
  assert.equal(session.notes.tasks[0].text, 'from older');
});

test('tasks plan combo filters in place and keeps the agent menu', async () => {
  const { session, cwd } = await openSession([sampleItem('a.js')], {
    color: true,
  });
  const dir = path.join(cwd, REVIEW_DIR);
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < 12; i++) {
    const name = `note-${String(i).padStart(2, '0')}.md`;
    fs.writeFileSync(path.join(dir, name), `# ${name}\n`);
  }
  fs.writeFileSync(path.join(dir, 'beta-plan.md'), '# beta\n');
  fs.writeFileSync(path.join(dir, 'main-plan.md'), '# main\n');
  session.dispatch('tasks');
  press(session, 'ctrl-p');
  session.draw();
  const menuRows = () =>
    session.lastFrame.rows.filter(
      (row) =>
        row.includes(bg(THEME.noteBg)) || row.includes(bg(THEME.checkBg)),
    );
  const open = menuRows();
  assert.ok(open.length > 1);
  assert.ok(open.some((row) => row.includes(bg(THEME.checkBg))));
  assert.ok(open.some((row) => row.includes(bg(THEME.noteBg))));
  const opened = stripAnsi(session.lastFrame.rows.join('\n'));
  assert.match(opened, /note-11\.md/);
  assert.match(opened, /<new plan>/);
  assert.equal(opened.includes('beta-plan'), false);
  const current = session.composer.tasks.planName();
  const selected = open.find((row) => row.includes(bg(THEME.checkBg)));
  assert.ok(stripAnsi(selected).includes(current));
  press(session, 'home');
  session.draw();
  const top = stripAnsi(session.lastFrame.rows.join('\n'));
  assert.match(top, /beta-plan\.md/);
  assert.equal(top.includes('note-11'), false);
  press(session, 'm');
  session.draw();
  const status = stripAnsi(session.lastFrame.rows.at(-2));
  const afterBranch = status.slice(status.indexOf('main') + 'main'.length);
  assert.match(afterBranch, /^ {2}\^plan file: m/);
  const hit = session.lastFrame.statusHits.find(
    (entry) => entry.id === 'plan-item',
  );
  assert.ok(hit);
  assert.ok(hit.x0 >= status.indexOf('main') + 'main'.length);
  const statusRow = session.lastFrame.rows.at(-2);
  const typedMark = seq(THEME.warnFg, THEME.chromeBg);
  assert.ok(statusRow.includes(`${typedMark}m`));
  assert.equal(statusRow.includes(bg(THEME.searchBg)), false);
  press(session, 'backspace', 'b', 'e');
  session.draw();
  const shown = stripAnsi(session.lastFrame.rows.join('\n'));
  assert.match(shown, /beta-plan\.md/);
  assert.equal(shown.includes('note-00'), false);
  assert.equal(shown.includes('main-plan'), false);
  const lines = shown.split('\n').map((line) => line.trim());
  assert.equal(lines.includes('be'), false);
  const beta = session.lastFrame.rows.find((row) =>
    stripAnsi(row).includes('beta-plan.md'),
  );
  assert.ok(beta.includes(seq(THEME.warnFg, THEME.checkBg)));
  assert.equal(beta.includes(bg(THEME.searchBg)), false);
  press(session, 'enter');
  assert.equal(session.composer.tasks.planName(), 'beta-plan.md');
});

test('tasks plan hotkey opens the combo and can start a new plan', async () => {
  const opened = await openSession([sampleItem('a.js')], { color: true });
  const { session } = opened;
  opened.stdout.columns = 120;
  session.dispatch('tasks');
  session.draw();
  const footer = stripAnsi(session.lastFrame.rows.at(-1));
  assert.match(
    footer,
    /🢐esc {2}insert {2}\^remove {2}tab {2}\^block {2}\^done {2}\^level/,
  );
  assert.doesNotMatch(footer, /space|files/);
  assert.match(footer, /ctrl\+up\/dn/);
  const nudge = `${BOLD}${seq(THEME.buttonHotFg, THEME.buttonBg)}up/dn`;
  assert.ok(session.lastFrame.rows.at(-1).includes(nudge));
  const priority = `${BOLD}${seq(THEME.buttonHotFg, THEME.buttonBg)}t`;
  assert.ok(session.lastFrame.rows.at(-1).includes(priority));
  const closed = session.lastFrame.rows.at(-2);
  const name = session.composer.tasks.planName();
  const mark = `${BOLD}${seq(THEME.shaFg, THEME.chromeBg)}${name}`;
  const key = `${BOLD}${seq(THEME.buttonHotFg, THEME.chromeBg)}^p`;
  assert.ok(closed.includes(key));
  assert.match(stripAnsi(closed), / {2}\^plan file: /);
  assert.ok(closed.includes(mark));
  assert.equal(closed.includes('▾'), false);
  const hits = session.lastFrame.statusHits;
  const place = hits.find((entry) => entry.id === 'plan');
  assert.ok(place);
  const row = stripAnsi(closed);
  assert.equal(row.slice(place.x0, place.x0 + 12), '^plan file: ');
  click(session, place.x0 + 1, place.y);
  assert.equal(session.composer.tasks.planOpen, true);
  press(session, 'escape', 'ctrl-p');
  assert.equal(session.composer.tasks.planOpen, true);
  session.draw();
  const menu = stripAnsi(session.lastFrame.rows.join('\n'));
  assert.match(menu, /<new plan>/);
  press(session, 'end', 'enter');
  assert.equal(session.composer.tasks.planOpen, false);
  const created = session.composer.tasks.planName();
  assert.match(created, new RegExp(`^${today()}-\\d+\\.md$`));
  assert.notEqual(created, name);
});
