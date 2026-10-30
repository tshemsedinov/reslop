'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const helpers = require('../helpers.js');
const { press } = helpers;
const review = require('../../lib/review/review.js');
const { serializeReview } = review;
const ansi = require('../../lib/term/ansi.js');
const { stripAnsi, THEME, BOLD, seq, bg, fg } = ansi;
const { REVIEW_DIR } = require('../../lib/common/files.js');
const { showFile } = require('../../lib/session/unit.js');
const clipboard = require('../../lib/term/select.js');
const sessionHelpers = require('../session-helpers.js');
const { rowOf, focusedRow, focusTask, pageTo, typeTasks } = sessionHelpers;
const { sampleItem, openSession } = sessionHelpers;

const PLAN_SCREEN = [
  '---',
  'status: editing',
  '---',
  '',
  '# reslop review 2026-10-27-00',
  '',
  '## Agent instructions',
  '',
  'Work through unchecked items.',
  '',
  '## Bug Reports and Fixes',
  '',
  '- [x] B1 high: Released connection can be assigned to two consumers',
  '- [ ] B2: Escape ends the read loop on the file list',
  '  - where: lib/session/terminal.js#readLoop',
  '  - check:',
  '    - [ ] read loop survives a lone Escape',
  '    - [ ] terminal tests pass',
  '- [ ] high: Timeout error message names the pool',
  '',
  '## Notes',
  '',
  'Anything else: paragraphs, lists, code, tables.',
  '',
  '```js',
  'const x = 1;',
  '```',
  '',
].join('\n');

const SECTIONS = [
  '## Bug Reports and Fixes',
  '',
  '- [ ] B1: pool hands a connection out twice',
  '- [ ] B2: timeout names the pool',
  '',
  '## Notes',
  '',
  'Context for the agent.',
  '',
  '## Security and Compliance',
  '',
  '- [ ] S1: keep paths inside the root',
  '',
].join('\n');

const STRUCTURED = [
  '## Bug Reports and Fixes',
  '',
  '- [ ] B1 high: Escape ends the read loop',
  '  - where: lib/session/terminal.js#readLoop',
  '  - check:',
  '    - [ ] read loop survives a lone Escape',
  '    - [ ] terminal tests pass',
  '  - result: guarded the timer',
  '- [ ] B2: Timeout names the pool',
  '',
].join('\n');

const KIND_ORDER = [
  '## Feature requests and Enhancements',
  '',
  '- [ ] F1: dark mode',
  '',
  '## Refactoring and Technical debt',
  '',
  '- [ ] D1: split the store',
  '',
  '## Notes',
  '',
  'Text.',
  '',
].join('\n');

const FIXTURE_PLAN = fs.readFileSync(
  path.join(__dirname, '..', 'fixtures', 'plan.md'),
  'utf8',
);

const LINKED = [
  '## Bug Reports and Fixes',
  '',
  '- [ ] B1: Escape ends the read loop',
  '  - where: `lib/term.js` readLoop:3, lib/term.js#readLoop',
  '  - related: https://github.com/tshemsedinov/reslop/issues/86',
  '- [ ] B2: Lines and missing symbols',
  '  - where: lib/term.js:4',
  '  - related: lib/term.js#nowhere',
  '- [ ] B3: Outside the root',
  '  - where: ../../.ssh/id_rsa',
  '',
].join('\n');

const TERM = [
  '// terminal',
  '',
  'const x = 1;',
  'const readLoop = () => {};',
  '',
];

const cursorAt = (session, text) => {
  session.composer.tasks.settle();
  const at = session.editor.text.indexOf(text);
  assert.ok(at >= 0, text);
  session.editor.place(at);
  return session.editor;
};

// The tasks screen of a plan file, as plain text rows of its body
const planScreen = async (name, text, rows = 24, extra = {}) => {
  const items = [sampleItem('a.js')];
  const { session, stdout, cwd, repo } = await openSession(items, extra);
  stdout.rows = rows;
  const dir = path.join(cwd, REVIEW_DIR);
  fs.mkdirSync(dir, { recursive: true });
  if (text !== null) fs.writeFileSync(path.join(dir, name), text);
  session.composer.tasks.openTasksPage();
  session.composer.tasks.openPlan(name);
  session.draw();
  const body = session.lastFrame.rows.slice(1, -2);
  const lines = body.map((row) => stripAnsi(row).trimEnd());
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  return { session, lines, repo };
};

const pickSection = (session, query) => {
  press(session, 'ctrl-b');
  session.pushInput(query);
  press(session, 'enter');
};

const withTerm = (screen) => {
  const dir = path.join(screen.session.root, 'lib');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'term.js'), TERM.join('\n'));
  screen.repo.fileBodies['lib/term.js'] = TERM.join('\n');
  return screen;
};

const linkedScreen = async (text = LINKED) =>
  withTerm(await planScreen('linked.md', text));

// The foreground in force where a text starts in a painted row
const colorBefore = (row, text) => {
  const head = row.slice(0, row.indexOf(text));
  const at = head.lastIndexOf('\x1b[38;');
  return head.slice(at, head.indexOf('m', at) + 1);
};

test('tasks screen snapshot of a reslop plan', async () => {
  const { lines } = await planScreen('2026-10-27-00.md', PLAN_SCREEN);
  assert.deepEqual(lines, [
    '',
    ' Agent instructions',
    '   Work through unchecked items.',
    '',
    ` Bug Reports and Fixes${' '.repeat(54)}1/3`,
    ' [x] B1 high: Released connection can be assigned to two consumers',
    ' [ ] B2: Escape ends the read loop on the file list  (where, check: 0/2)',
    ' [ ] high: Timeout error message names the pool',
    '',
    ' Notes',
    '   Anything else: paragraphs, lists, code, tables.',
    '   ```js',
    '   const x = 1;',
    '   ```',
  ]);
});

test('tasks screen snapshot of a free-form Markdown file', async () => {
  const text = [
    '# Live dashboard',
    '',
    '## Goal',
    '',
    'Add a live dashboard that opens first.',
    '',
    '- files - size and count',
    '- diffs - lines added and removed',
    '',
    '## 1. Entry screen',
    '',
    'Pressing `Esc` returns to the dashboard.',
    '',
  ].join('\n');
  const { session, lines } = await planScreen('LIVE.md', text);
  assert.deepEqual(lines, [
    '',
    ' Live dashboard',
    '',
    ' Goal',
    '   Add a live dashboard that opens first.',
    '   - files - size and count',
    '   - diffs - lines added and removed',
    '',
    ' 1. Entry screen',
    '   Pressing `Esc` returns to the dashboard.',
  ]);
  const file = path.join(session.root, REVIEW_DIR, 'LIVE.md');
  session.notes.addTask('TODOs', 'first', false, 'features');
  session.flushReview(true);
  assert.ok(fs.readFileSync(file, 'utf8').startsWith(text));
});

test('tasks screen snapshot of an empty file', async () => {
  const { session, lines } = await planScreen('empty.md', '');
  assert.deepEqual(lines, []);
  press(session, 'enter');
  assert.equal(session.mode, 'compose');
});

test('insert adds a task below the focused block in its block', async () => {
  const { session } = await planScreen('blocks.md', SECTIONS);
  focusTask(session, rowOf(session, 'B1:'));
  press(session, 'insert');
  assert.equal(session.mode, 'compose');
  assert.equal(session.editor.text, '');
  session.pushInput('B3: retry the handshake');
  press(session, 'down');
  const texts = session.notes.tasks.map((task) => [task.text, task.kind]);
  assert.deepEqual(texts, [
    ['B1: pool hands a connection out twice', 'bugs'],
    ['B3: retry the handshake', 'bugs'],
    ['B2: timeout names the pool', 'bugs'],
    ['S1: keep paths inside the root', 'security'],
  ]);
  assert.equal(focusedRow(session), '[ ] B2: timeout names the pool');
  focusTask(session, rowOf(session, 'Context for'));
  press(session, 'insert');
  session.pushInput('read the notes');
  press(session, 'up');
  const notes = session.notes.tasks.find(
    (task) => task.text === 'read the notes',
  );
  assert.equal(notes.kind, '');
});

test('ctrl+up and ctrl+down move a block or a task across them', async () => {
  const { session } = await planScreen('blocks.md', SECTIONS);
  const s1 = session.notes.tasks.find((task) => task.item.id === 'S1');
  focusTask(session, rowOf(session, 'S1:'));
  press(session, 'ctrl-up');
  const moved = session.notes.tasks.find((task) => task.id === s1.id);
  assert.equal(moved.kind, '');
  assert.equal(moved.item.id, 'S1');
  assert.equal(focusedRow(session), '[ ] S1: keep paths inside the root');
  press(session, 'ctrl-down');
  assert.equal(session.notes.tasks.at(-1).kind, 'security');
  focusTask(session, rowOf(session, 'Security and Compliance'));
  press(session, 'ctrl-up', 'ctrl-up');
  const text = serializeReview(session.notes);
  assert.ok(text.startsWith('## Security and Compliance\n\n- [ ] S1'));
  assert.match(text, /S1: keep paths inside the root\n\n## Bug Reports/);
  assert.match(text, /\n\nContext for the agent\.\n$/);
  assert.equal(focusedRow(session), 'Security and Compliance');
});

test('ctrl+r on a heading with blocks under it asks first', async () => {
  const { session } = await planScreen('blocks.md', SECTIONS);
  focusTask(session, rowOf(session, 'Bug Reports and Fixes'));
  press(session, 'ctrl-r');
  assert.equal(session.mode, 'confirmDrop');
  session.draw();
  const status = stripAnsi(session.lastFrame.rows.at(-2));
  assert.match(status, /drop block Bug Reports and Fixes\?/);
  press(session, 'n');
  assert.equal(session.mode, 'compose');
  assert.equal(session.notes.tasks.length, 3);
  press(session, 'ctrl-r', 'y');
  assert.equal(session.notes.tasks.length, 1);
  assert.ok(serializeReview(session.notes).startsWith('## Notes\n'));
  session.notes.addTask('TODOs', 'x', false, 'features');
  focusTask(session, rowOf(session, 'Notes'));
  press(session, 'ctrl-r');
  assert.equal(session.mode, 'confirmDrop');
  press(session, 'escape');
  const empty = '## Empty\n\n## Notes\n\ntext\n';
  const { session: other } = await planScreen('empty-block.md', empty);
  other.tasksFocus = rowOf(other, 'Empty');
  press(other, 'ctrl-r');
  assert.notEqual(other.mode, 'confirmDrop');
  assert.equal(serializeReview(other.notes), '## Notes\n\ntext\n');
});

test('enter on a heading goes below, insert starts a task', async () => {
  const { session } = await planScreen('blocks.md', SECTIONS);
  focusTask(session, rowOf(session, 'Notes'));
  press(session, 'end');
  session.pushInput(' and links');
  press(session, 'enter');
  assert.match(serializeReview(session.notes), /^## Notes and links$/m);
  assert.equal(session.editor.text, 'Context for the agent.');
  press(session, 'up', 'insert');
  assert.equal(session.editor.text, '');
  session.pushInput('a task under notes');
  press(session, 'down');
  const text = serializeReview(session.notes);
  assert.match(text, /## Notes and links\n\n- \[ \] a task under notes\n\n/);
});

test('a closed task names what it hides, an open one is its text', async () => {
  const { session, lines } = await planScreen('structured.md', STRUCTURED);
  assert.deepEqual(lines, [
    '',
    ` Bug Reports and Fixes${' '.repeat(54)}0/2`,
    ' [ ] B1 high: Escape ends the read loop',
    '     - where: lib/session/terminal.js#readLoop',
    '     - check:',
    '       - [ ] read loop survives a lone Escape',
    '       - [ ] terminal tests pass',
    '     - result: guarded the timer',
    ' [ ] B2: Timeout names the pool',
  ]);
  focusTask(session, rowOf(session, 'B2:'));
  session.draw();
  const body = session.lastFrame.rows.map((row) => stripAnsi(row).trimEnd());
  assert.ok(
    body.includes(
      ' [ ] B1 high: Escape ends the read loop  (where, result, check: 0/2)',
    ),
  );
  assert.ok(!body.some((row) => row.includes('lib/session/terminal.js')));
});

test('ctrl+d on a check line ticks that check, not the task', async () => {
  const { session } = await planScreen('structured.md', STRUCTURED);
  assert.equal(focusedRow(session), '[ ] B1 high: Escape ends the read loop');
  cursorAt(session, 'terminal tests');
  press(session, 'ctrl-d');
  assert.match(session.editor.text, / {2}- \[x\] terminal tests pass/);
  session.composer.tasks.closeEditor();
  const task = session.notes.tasks[0];
  assert.equal(task.done, false);
  assert.deepEqual(
    task.item.checks.map((check) => check.done),
    [false, true],
  );
  focusTask(session, rowOf(session, 'B1 high'));
  cursorAt(session, 'Escape ends');
  press(session, 'ctrl-d');
  assert.equal(session.notes.tasks[0].done, true);
  assert.match(
    focusedRow(session),
    /^\[x\] B1 high: Escape ends the read loop/,
  );
});

test('shift+tab opens and closes every task', async () => {
  const { session } = await planScreen('structured.md', STRUCTURED);
  const shown = () => {
    session.draw();
    return session.lastFrame.rows.some((row) =>
      stripAnsi(row).includes('lib/session/terminal.js'),
    );
  };
  focusTask(session, rowOf(session, 'B2:'));
  assert.equal(shown(), false);
  press(session, 'shift-tab');
  assert.equal(shown(), true);
  press(session, 'shift-tab');
  assert.equal(shown(), false);
});

test('tab opens a field menu and its keys add fields', async () => {
  const opened = await planScreen('structured.md', STRUCTURED, 24, {
    color: true,
  });
  const { session } = opened;
  focusTask(session, rowOf(session, 'B2:'));
  session.composer.tasks.settle();
  session.draw();
  const body = session.lastFrame.rows.map((row) => stripAnsi(row));
  assert.ok(!body.some((row) => row.includes('░')));
  press(session, 'tab');
  const menu = session.nav.contextMenu;
  assert.deepEqual(menu.actions, [
    'field:where',
    'field:problem',
    'field:expected',
    'field:check',
    'field:do',
    'field:related',
  ]);
  session.draw();
  const lines = session.lastFrame.rows.map((row) => stripAnsi(row));
  assert.ok(lines.some((row) => row.includes(' where: path, path:line')));
  assert.ok(lines.some((row) => row.includes(' expected: how it behaves')));
  const hot = `${BOLD}${seq(THEME.buttonHotFg, THEME.popupHotBg)}w`;
  assert.ok(session.lastFrame.rows.some((row) => row.includes(hot)));
  press(session, 'w');
  assert.equal(session.nav.contextMenu, null);
  assert.equal(session.mode, 'compose');
  assert.equal(session.editor.text, 'B2: Timeout names the pool\n- where: ');
  session.autosave();
  const saved = fs.readFileSync(session.notes.reviewPath, 'utf8');
  assert.doesNotMatch(saved.split('B2:')[1], /where/);
  session.pushInput('lib/pool.js');
  press(session, 'tab');
  assert.ok(session.nav.contextMenu);
  assert.ok(!session.nav.contextMenu.actions.includes('field:where'));
  press(session, 'p');
  assert.equal(
    session.editor.text,
    'B2: Timeout names the pool\n- where: lib/pool.js\n- problem: ',
  );
  press(session, 'tab', 'escape');
  assert.equal(session.nav.contextMenu, null);
  assert.equal(session.mode, 'compose');
  press(session, 'escape');
  const text = fs.readFileSync(session.notes.reviewPath, 'utf8');
  assert.match(text, /- \[ \] B2: Timeout names the pool\n {2}- where: lib/);
  assert.doesNotMatch(text.split('B2:')[1], /problem/);
});

test('the block menu adds a missing kind in kind order', async () => {
  const { session } = await planScreen('kinds.md', KIND_ORDER);
  press(session, 'ctrl-b');
  assert.equal(session.composer.tasks.planOpen, true);
  assert.deepEqual(session.view().planNames, [
    'Feature requests and Enhancements',
    'Improvements',
    'Bug Reports and Fixes',
    'Refactoring and Technical debt',
    'Research and Experiments',
    'Security and Compliance',
    'custom…',
  ]);
  session.draw();
  assert.match(stripAnsi(session.lastFrame.rows.at(-2)), /Block: /);
  session.pushInput('secur');
  assert.deepEqual(session.view().planNames, ['Security and Compliance']);
  press(session, 'enter');
  assert.equal(session.composer.tasks.planOpen, false);
  const file = fs.readFileSync(session.notes.reviewPath, 'utf8');
  assert.match(
    file,
    /D1: split the store\n\n## Security and Compliance\n\n## Notes/,
  );
  assert.equal(session.mode, 'compose');
  assert.equal(focusedRow(session), '[ ] ');
  assert.equal(
    session.composer.tasks.taskTexts()[session.tasksFocus - 1],
    'Security and Compliance',
  );
  session.pushInput('S1: keep paths inside the root');
  press(session, 'escape');
  const text = serializeReview(session.notes);
  const task = '- [ ] S1: keep paths inside the root';
  assert.ok(text.includes(`## Security and Compliance\n\n${task}\n\n## Notes`));
  assert.equal(session.notes.tasks.at(-1).kind, 'security');
});

test('the block menu jumps to a kind and closes on escape', async () => {
  const { session } = await planScreen('kinds.md', KIND_ORDER);
  const before = session.tasksFocus;
  press(session, 'ctrl-b');
  session.pushInput('ref');
  press(session, 'escape');
  assert.equal(session.composer.tasks.planOpen, false);
  assert.equal(session.tasksFocus, before);
  assert.equal(session.mode, 'compose');
  pickSection(session, 'refactor');
  assert.equal(focusedRow(session), 'Refactoring and Technical debt');
  assert.equal(serializeReview(session.notes), KIND_ORDER);
});

test('a custom block goes at the cursor and is named at once', async () => {
  const { session } = await planScreen('kinds.md', KIND_ORDER);
  focusTask(session, rowOf(session, 'F1:'));
  pickSection(session, 'custom');
  assert.equal(session.mode, 'compose');
  assert.equal(session.editor.selectedText(), 'New block');
  session.pushInput('Open questions');
  press(session, 'down');
  const text = serializeReview(session.notes);
  assert.match(text, /F1: dark mode\n\n## Open questions\n\n## Refactoring/);
  assert.equal(focusedRow(session), 'Refactoring and Technical debt');
});

test('the plan menus list .plan files, which keep their bytes', async () => {
  const { session, cwd } = await openSession([sampleItem('a.js')]);
  const dir = path.join(cwd, REVIEW_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'structured-plan.md');
  fs.writeFileSync(file, FIXTURE_PLAN);
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'not a plan');
  const specs = path.join(cwd, 'specs');
  fs.mkdirSync(specs, { recursive: true });
  fs.writeFileSync(path.join(specs, 'spec.md'), '# spec\n');
  session.dispatch('tasks');
  press(session, 'ctrl-p');
  const labels = session.view().planNames;
  const at = labels.findIndex((label) => label.startsWith('structured'));
  assert.ok(at >= 0);
  assert.ok(!labels.some((label) => /notes\.txt|spec/.test(label)));
  assert.match(labels[at], /editing {2}2\/7$/);
  session.composer.tasks.choosePlan(at);
  assert.equal(session.notes.reviewPath, file);
  assert.equal(
    focusedRow(session),
    '[ ] B1 high: A lone Escape ends the read loop on the file list',
  );
  cursorAt(session, 'B1 high');
  press(session, 'ctrl-d');
  const after = fs.readFileSync(file, 'utf8');
  const before = FIXTURE_PLAN.split('\n');
  const changed = after.split('\n').filter((line, i) => line !== before[i]);
  assert.deepEqual(changed, [
    '- [x] B1 high: A lone Escape ends the read loop on the file list',
  ]);
  const agents = session.agents.planMenu();
  assert.ok(agents.some((label) => label.startsWith('structured')));
  assert.ok(!agents.some((label) => label.includes('spec')));
});

test('ctrl+w opens the location on the cursor line', async () => {
  const { session } = await linkedScreen();
  assert.equal(focusedRow(session), '[ ] B1: Escape ends the read loop');
  cursorAt(session, '- where');
  press(session, 'ctrl-w');
  await session.ops.idle();
  assert.equal(session.pane, 'unit');
  assert.equal(session.nav.reviewPath, 'lib/term.js');
  assert.equal(session.nav.unitLine, 0);
  press(session, 'escape');
  assert.equal(session.pane, 'tasks');
  assert.match(focusedRow(session), /^\[ \] B1: Escape ends the read loop/);
  cursorAt(session, '- related');
  press(session, 'ctrl-w');
  assert.equal(session.pane, 'tasks');
  assert.match(session.status, /^not opened: https:\/\/github\.com/);
});

test('escape goes back to the task only from its own location', async () => {
  const { session } = await linkedScreen();
  cursorAt(session, '- where');
  press(session, 'ctrl-w');
  await session.ops.idle();
  assert.equal(session.pane, 'unit');
  await showFile(session, { path: 'lib/term.js' });
  press(session, 'escape');
  assert.notEqual(session.pane, 'tasks');
});

test('a line or a symbol opens there; a missing one at the top', async () => {
  const { session } = await linkedScreen();
  focusTask(session, rowOf(session, 'B2:'));
  cursorAt(session, '- where');
  press(session, 'ctrl-w');
  await session.ops.idle();
  assert.equal(session.pane, 'unit');
  assert.equal(session.nav.unitLine, 3);
  press(session, 'escape');
  cursorAt(session, '- related');
  press(session, 'ctrl-w');
  await session.ops.idle();
  assert.equal(session.nav.unitLine, 0);
  assert.equal(session.status, 'not found: nowhere');
  press(session, 'escape');
  const text = LINKED.replace('lib/term.js:4', 'lib/term.js#readLoop');
  const { session: other } = await linkedScreen(text);
  other.tasksFocus = rowOf(other, 'B2:');
  cursorAt(other, '- where');
  press(other, 'ctrl-w');
  await other.ops.idle();
  assert.equal(other.nav.unitLine, 3);
});

test('a location outside the root is named, never opened', async () => {
  const { session } = await linkedScreen();
  focusTask(session, rowOf(session, 'B3:'));
  press(session, 'ctrl-w');
  await session.ops.idle();
  assert.equal(session.pane, 'tasks');
  assert.equal(session.status, 'outside the repository: ../../.ssh/id_rsa');
});

test('editing a heading keeps the blank line above it', async () => {
  const { session } = await planScreen('blocks.md', SECTIONS);
  focusTask(session, rowOf(session, 'Notes'));
  session.draw();
  const before = session.lastFrame.rows.map((row) => stripAnsi(row));
  press(session, 'enter');
  session.draw();
  const after = session.lastFrame.rows.map((row) => stripAnsi(row));
  const at = before.findIndex((row) => row.trim() === 'Notes');
  assert.equal(after[at - 1].trim(), '');
  assert.equal(after[at].trim(), 'Notes');
});

test('the agent instructions open on focus and close after it', async () => {
  const { session } = await openSession([sampleItem('a.js')]);
  typeTasks(session, 'add tests');
  const shown = () => {
    session.draw();
    return session.lastFrame.rows.some((row) =>
      stripAnsi(row).includes('Read the fields under an item'),
    );
  };
  assert.equal(shown(), false);
  press(session, 'pageUp');
  assert.equal(focusedRow(session), 'Agent instructions');
  assert.equal(shown(), true);
  press(session, 'down');
  assert.match(focusedRow(session), /^Work through unchecked/);
  assert.equal(shown(), true);
  pageTo(session, '[ ] add tests');
  assert.equal(focusedRow(session), '[ ] add tests');
  assert.equal(shown(), false);
});

test('done tasks recede', async () => {
  const colored = { color: true };
  const { session } = await planScreen('linked.md', LINKED, 24, colored);
  session.notes.setTaskDone(session.notes.tasks[1].id, true);
  session.draw();
  const rows = session.lastFrame.rows;
  const row = (text) => rows.find((one) => stripAnsi(one).includes(text));
  const on = seq(THEME.chromeFg, THEME.buttonBg);
  assert.ok(row('B1: Escape ends').includes(on));
  const off = `${seq(THEME.mutedFg, THEME.ctxBg)}B2: `;
  assert.ok(row('B2: Lines and').includes(off));
});

test('the tasks footer keeps its words on 80 columns', async () => {
  const { session } = await planScreen('blocks.md', SECTIONS);
  session.draw();
  const footer = stripAnsi(session.lastFrame.rows.at(-1));
  assert.match(
    footer,
    /insert {2}\^remove {2}tab {2}\^block {2}\^done {2}\^level/,
  );
  assert.doesNotMatch(footer, /files|f {2}d {2}t/);
});

test('the title is bold text and finished checks turn green', async () => {
  const text = [
    '# Pool fixes',
    '',
    '## Bug Reports and Fixes',
    '',
    '- [ ] B1: all checks done',
    '  - check:',
    '    - [x] one',
    '- [ ] B2: one check left',
    '  - check:',
    '    - [ ] two',
    '',
  ].join('\n');
  const colored = { color: true };
  const { session } = await planScreen('title.md', text, 24, colored);
  focusTask(session, rowOf(session, 'B2:'));
  session.draw();
  const rows = session.lastFrame.rows;
  const row = (part) => rows.find((one) => stripAnsi(one).includes(part));
  const title = row('Pool fixes');
  assert.ok(title.includes(`${BOLD}${seq(THEME.chromeFg, THEME.ctxBg)}`));
  assert.ok(!title.includes(bg(THEME.taskHeadBg)));
  assert.ok(row('Bug Reports').includes(bg(THEME.taskHeadBg)));
  assert.ok(row('B1: all').includes(fg(THEME.addLineFg)));
  assert.ok(!row('B2: one').includes(fg(THEME.addLineFg)));
});

test('notes show their line and code proposals their place', async () => {
  const { lines } = await planScreen(
    'notes.md',
    fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'plan.md'), 'utf8'),
    60,
  );
  const note = lines.find((line) => line.includes('keep the gap'));
  assert.match(note, /^ \[ \] keep the gap between the two sides +:12$/);
  const code = lines.find((line) => line.includes('code lib'));
  assert.match(code, /^ \[x\] code lib\/diff\/align\.js:40 {3}const gap = 1;$/);
});

test('a draft in a new kind shows the heading it will go under', async () => {
  const { session } = await openSession([sampleItem('a.js')]);
  session.dispatch('tasks');
  session.draw();
  const plain = () => session.lastFrame.rows.map((row) => stripAnsi(row));
  const at = plain().findIndex((row) => row.includes('Feature requests'));
  assert.ok(at > 0);
  assert.match(plain()[at + 1], /^ \[ \] /);
  assert.equal(focusedRow(session), '[ ] ');
  press(session, 'escape');
  session.draw();
  assert.ok(!plain().some((row) => row.includes('Feature requests')));
});

test('ctrl+z brings back the last dropped task or block', async () => {
  const { session } = await planScreen('blocks.md', SECTIONS);
  focusTask(session, rowOf(session, 'B2:'));
  press(session, 'ctrl-r');
  assert.equal(session.status, 'dropped · ctrl+z to undo');
  assert.equal(rowOf(session, 'B2:'), -1);
  press(session, 'ctrl-z');
  assert.equal(session.status, 'restored');
  assert.equal(focusedRow(session), '[ ] B2: timeout names the pool');
  assert.equal(fs.readFileSync(session.notes.reviewPath, 'utf8'), SECTIONS);
  focusTask(session, rowOf(session, 'Bug Reports and Fixes'));
  press(session, 'ctrl-r', 'y', 'ctrl-z');
  assert.equal(serializeReview(session.notes), SECTIONS);
  press(session, 'ctrl-r', 'y');
  focusTask(session, rowOf(session, 'S1:'));
  press(session, 'x', 'ctrl-z');
  assert.equal(session.editor.text, 'S1: keep paths inside the root');
  press(session, 'ctrl-d', 'ctrl-z');
  assert.equal(session.status, 'nothing to undo');
});

test('ctrl+l sets the priority of the focused task from a pop-up', async () => {
  const { session } = await planScreen('blocks.md', SECTIONS);
  focusTask(session, rowOf(session, 'B2:'));
  press(session, 'ctrl-l');
  assert.deepEqual(Object.values(session.nav.contextMenu.keys), [
    'h',
    'n',
    'l',
  ]);
  press(session, 'h');
  assert.equal(focusedRow(session), '[ ] B2 high: timeout names the pool');
  press(session, 'ctrl-l', 'n');
  assert.equal(focusedRow(session), '[ ] B2: timeout names the pool');
  press(session, 'ctrl-l', 'escape', '!');
  assert.equal(session.nav.contextMenu, null);
  assert.equal(session.editor.text, 'B2: timeout names the pool!');
});

test('ctrl+g puts the focused task into a commit group', async () => {
  const { session } = await planScreen('blocks.md', SECTIONS);
  const captions = () => Object.values(session.nav.contextMenu.captions);
  focusTask(session, rowOf(session, 'B2:'));
  press(session, 'ctrl-g');
  assert.deepEqual(captions(), [
    'b1  1 task',
    'b2  1 task',
    's1  1 task',
    'new f1',
    'ungroup',
  ]);
  assert.equal(session.nav.contextMenu.cursor, 1);
  press(session, 'n');
  assert.equal(focusedRow(session), '[ ] f1: timeout names the pool');
  focusTask(session, rowOf(session, 'S1:'));
  press(session, 'ctrl-g');
  assert.deepEqual(captions(), [
    'b1  1 task',
    'f1  1 task',
    's1  1 task',
    'new f2',
    'ungroup',
  ]);
  press(session, '1');
  assert.equal(focusedRow(session), '[ ] f1: keep paths inside the root');
  press(session, 'ctrl-g');
  assert.equal(captions()[1], 'f1  2 tasks');
  press(session, 'u');
  assert.equal(focusedRow(session), '[ ] keep paths inside the root');
});

test('ctrl+f jumps between the blocks that match', async () => {
  const { session } = await planScreen('blocks.md', SECTIONS);
  const all = session.composer.tasks.taskTexts();
  press(session, 'ctrl-f');
  assert.equal(session.mode, 'find');
  session.draw();
  assert.match(stripAnsi(session.lastFrame.rows.at(-2)), /^ find: {2}/);
  session.pushInput('pool');
  assert.deepEqual(session.composer.tasks.taskTexts(), all);
  assert.equal(
    focusedRow(session),
    '[ ] B1: pool hands a connection out twice',
  );
  press(session, 'down');
  assert.equal(focusedRow(session), '[ ] B2: timeout names the pool');
  press(session, 'down');
  assert.equal(
    focusedRow(session),
    '[ ] B1: pool hands a connection out twice',
  );
  press(session, 'up', 'enter');
  assert.equal(session.mode, 'compose');
  assert.equal(session.editor.text, 'B2: timeout names the pool');
  press(session, 'ctrl-f');
  assert.equal(session.nav.find.query, 'pool');
  session.pushInput('zzz');
  assert.equal(session.nav.find.miss, true);
  assert.equal(focusedRow(session), '[ ] B2: timeout names the pool');
  press(session, 'escape');
  assert.equal(session.pane, 'tasks');
  assert.equal(session.mode, 'compose');
});

test('tab folds a block under its heading', async () => {
  const { session } = await planScreen('blocks.md', SECTIONS);
  focusTask(session, rowOf(session, 'Bug Reports and Fixes'));
  press(session, 'tab');
  assert.equal(rowOf(session, 'B1:'), -1);
  session.draw();
  const body = () => session.lastFrame.rows.map((row) => stripAnsi(row));
  assert.ok(body().some((row) => row.trim() === '(2 tasks)'));
  assert.equal(focusedRow(session), 'Bug Reports and Fixes');
  press(session, 'down');
  session.draw();
  const folded = ' Bug Reports and Fixes  (2 tasks)';
  assert.ok(body().some((row) => row.includes(folded)));
  press(session, 'up');
  assert.equal(serializeReview(session.notes), SECTIONS);
  press(session, 'tab');
  assert.ok(rowOf(session, 'B1:') > 0);
});

test('the status line counts open and done tasks', async () => {
  const { session } = await planScreen('s.md', STRUCTURED);
  session.draw();
  const status = stripAnsi(session.lastFrame.rows.at(-2));
  assert.match(status, /open 2 · done 0\/2 $/);
});

test('a plan opened again comes back as it was left', async () => {
  const { session } = await planScreen('blocks.md', SECTIONS);
  const other = path.join(session.root, REVIEW_DIR, 'other.md');
  fs.writeFileSync(other, '- [ ] x\n');
  focusTask(session, rowOf(session, 'Security and Compliance'));
  press(session, 'tab');
  focusTask(session, rowOf(session, 'B2:'));
  session.composer.tasks.openPlan('other.md');
  assert.equal(focusedRow(session), '[ ] x');
  session.composer.tasks.openPlan('blocks.md');
  assert.equal(focusedRow(session), '[ ] B2: timeout names the pool');
  assert.equal(rowOf(session, 'S1:'), -1);
});

test('ctrl+w opens the file of a note and ctrl+c copies a task', async (t) => {
  const plan = fs.readFileSync(
    path.join(__dirname, '..', 'fixtures', 'plan.md'),
  );
  const { session, repo } = await planScreen('notes.md', `${plan}`, 60);
  const dir = path.join(session.root, 'lib', 'diff');
  fs.mkdirSync(dir, { recursive: true });
  const code = Array.from({ length: 20 }, (_, at) => `line ${at + 1}`);
  fs.writeFileSync(path.join(dir, 'align.js'), code.join('\n'));
  repo.fileBodies['lib/diff/align.js'] = code.join('\n');
  focusTask(session, rowOf(session, 'keep the gap'));
  press(session, 'ctrl-w');
  await session.ops.idle();
  assert.equal(session.pane, 'unit');
  assert.equal(session.nav.unitLine, 11);
  press(session, 'escape');
  assert.equal(session.pane, 'tasks');
  const copied = t.mock.method(clipboard, 'copyText', (text) => !!text);
  focusTask(session, rowOf(session, 'D1:'));
  press(session, 'ctrl-c');
  assert.equal(session.status, 'copied');
  assert.match(copied.mock.calls.at(-1).arguments[0], /^- \[ \] D1: Split/);
  press(session, 'o');
  assert.equal(session.mode, 'compose');
  assert.match(session.editor.text, /escape kindo\n/);
});

test('ctrl+s starts on the agents screen with the plan chosen', async () => {
  const { session } = await planScreen('blocks.md', SECTIONS);
  // No agent CLI of this machine is found, so none is started
  session.agents.env = { PATH: '' };
  press(session, 'ctrl-s');
  assert.equal(session.pane, 'agents');
  assert.equal(session.mode, 'review');
  assert.equal(session.agents.planPath, session.notes.reviewPath);
  assert.equal(session.agents.jobs.length, 0);
});

test('a block stays in place when it opens in the editor', async () => {
  const plan = fs.readFileSync(
    path.join(__dirname, '..', 'fixtures', 'plan.md'),
  );
  const { session } = await planScreen('notes.md', `${plan}`, 60);
  session.stdout.columns = 40;
  const tasks = session.composer.tasks;
  const frame = () => {
    session.draw();
    return session.lastFrame.rows.map((row) => stripAnsi(row).trimEnd());
  };
  const shapes = ['text', 'heading'];
  const blocks = tasks
    .rows()
    .filter((row) => shapes.includes(row.type))
    .filter((row) => row.block.text !== 'Agent instructions');
  assert.ok(blocks.some((row) => row.block.fence));
  for (const row of blocks) {
    focusTask(session, tasks.rowIndex(row));
    const shown = frame();
    tasks.settle();
    assert.equal(session.mode, 'compose');
    const edited = frame();
    const at = shown.findIndex((line, i) => line !== edited[i]);
    assert.equal(at, -1, `${row.block.lines[0]}: ${shown[at]}`);
  }
});

test('delete takes letters and ctrl+r removes the block', async () => {
  const { session } = await planScreen('blocks.md', SECTIONS);
  focusTask(session, rowOf(session, 'B2:'));
  press(session, 'home', 'delete');
  assert.equal(session.editor.text, '2: timeout names the pool');
  press(session, 'end', 'delete');
  assert.equal(session.editor.text, '2: timeout names the pool');
  press(session, 'ctrl-r');
  assert.equal(rowOf(session, 'timeout names'), -1);
  assert.equal(session.status, 'dropped · ctrl+z to undo');
});

test('a folded block of text shows its first lines', async () => {
  const text = [
    '## Notes',
    '',
    'one',
    'two',
    '',
    'three',
    'four',
    '',
    '## Bug Reports and Fixes',
    '',
    '- [ ] B1: x',
    '',
  ].join('\n');
  const { session } = await planScreen('peek.md', text);
  focusTask(session, rowOf(session, 'Notes'));
  press(session, 'tab', 'down');
  session.draw();
  const rows = session.lastFrame.rows.map((row) => stripAnsi(row).trimEnd());
  const at = rows.indexOf(' Notes');
  assert.ok(at > 0);
  assert.deepEqual(rows.slice(at + 1, at + 4), [
    '   one',
    '   two',
    '   three ...',
  ]);
  focusTask(session, rowOf(session, 'Bug Reports'));
  press(session, 'tab');
  session.draw();
  const folded = session.lastFrame.rows.map((row) => stripAnsi(row));
  assert.ok(folded.some((row) => row.trim() === '(1 task)'));
});

test('a long title gives way to what the task hides', async () => {
  const text = [
    '## Bug Reports and Fixes',
    '',
    `- [ ] B1: ${'a long title '.repeat(8)}`,
    '  - where: lib/a.js',
    '  - do: fix it',
    '- [ ] B2: other',
    '',
  ].join('\n');
  const { session } = await planScreen('long.md', text);
  session.stdout.columns = 60;
  focusTask(session, rowOf(session, 'B2:'));
  session.draw();
  const row = session.lastFrame.rows
    .map((one) => stripAnsi(one))
    .find((one) => one.includes('B1:'));
  assert.match(row, /… {2}\(where, do\)\s*$/);
});

test('field names are blue, values green, and a priority yellow', async () => {
  const colored = { color: true };
  const { session } = await planScreen('s.md', STRUCTURED, 24, colored);
  session.composer.tasks.settle();
  const row = (text) => {
    session.draw();
    return session.lastFrame.rows.find((one) => stripAnsi(one).includes(text));
  };
  const where = row('- where: lib/session');
  assert.ok(where.includes(`${fg(THEME.shaFg)}`));
  assert.ok(where.includes(`${fg(THEME.addLineFg)}`));
  assert.ok(row('read loop survives').includes(`${fg(THEME.addLineFg)}`));
  assert.ok(row('B1 high:').includes(`${fg(THEME.warnFg)}`));
  focusTask(session, rowOf(session, 'B2:'));
  assert.ok(row('B1 high:').includes(`${fg(THEME.warnFg)}`));
  assert.equal(row('(where'), row('B1 high:'));
});

test('each list item and paragraph is edited on its own', async () => {
  const text = [
    '## Notes',
    '',
    'The watcher skips:',
    '- node_modules',
    '- dist, and the',
    '  build output',
    '',
    'A paragraph',
    'on two lines.',
    '',
  ].join('\n');
  const { session } = await planScreen('notes.md', text);
  assert.deepEqual(session.composer.tasks.taskTexts(), [
    'Notes',
    'The watcher skips:',
    '- node_modules',
    '- dist, and the\n  build output',
    'A paragraph\non two lines.',
  ]);
  focusTask(session, rowOf(session, '- node_modules'));
  press(session, 'end', 'enter');
  session.pushInput('- coverage');
  press(session, 'down');
  assert.equal(
    serializeReview(session.notes),
    text.replace('- node_modules\n', '- node_modules\n- coverage\n'),
  );
  assert.ok(rowOf(session, '- coverage') > 0);
});

test('an item typed under another is saved once, however often', async () => {
  const text = '## Notes\n\n1. one\n- a\n';
  const { session } = await planScreen('items.md', text);
  focusTask(session, rowOf(session, '- a'));
  press(session, 'end', 'enter');
  session.pushInput('- b');
  session.autosave();
  session.autosave();
  session.pushInput('x');
  session.autosave();
  assert.equal(
    serializeReview(session.notes),
    '## Notes\n\n1. one\n- a\n- bx\n',
  );
  assert.equal(session.editor.text, '- bx');
});

test('every field of an open task has its name and value colors', async () => {
  const text = [
    '## Bug Reports and Fixes',
    '',
    '- [ ] B1: first',
    '  - where: lib/a.js',
    '  - problem: it breaks',
    '  - do: fix it',
    '',
  ].join('\n');
  const colored = { color: true };
  const { session } = await planScreen('tones.md', text, 24, colored);
  session.composer.tasks.settle();
  session.draw();
  const row = (part) =>
    session.lastFrame.rows.find((one) => stripAnsi(one).includes(part));
  for (const entry of [
    ['- where:', 'where', 'lib/a.js'],
    ['- problem:', 'problem', 'it breaks'],
    ['- do:', 'do', 'fix it'],
  ]) {
    const line = entry[0];
    const key = entry[1];
    const value = entry[2];
    const painted = row(line);
    assert.equal(colorBefore(painted, key), fg(THEME.shaFg), line);
    assert.equal(colorBefore(painted, value), fg(THEME.addLineFg), line);
  }
});
