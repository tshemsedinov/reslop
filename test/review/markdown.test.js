'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { MarkdownDoc } = require('../../lib/review/markdown.js');
const review = require('../../lib/review/review.js');
const { parseReview, serializeReview, ReviewStore } = review;

const ROOT = path.join(__dirname, '..', '..');

const markdownIn = (dir) => {
  try {
    return fs
      .readdirSync(path.join(ROOT, dir))
      .filter((name) => name.endsWith('.md'))
      .map((name) => path.join(dir, name));
  } catch {
    return [];
  }
};

// A reslop plan with a block reslop does not model, like the one an agent
// leaves after a run
const AGENT_PLAN = [
  '---',
  'status: done',
  '---',
  '',
  '# reslop review 2026-10-26-00',
  '',
  '## Agent instructions',
  '',
  'Work through unchecked items.',
  '',
  '- Run reviews with status `editing` or `partial`',
  '',
  '## Improvements',
  '',
  '- [x] f1: whole items only in the commits screen',
  '- [ ] f2: multiselect in the commits screen',
  '- [x] f3: multiselect for branches',
  '',
  '## Verification',
  '',
  '- F1–F3: focused session and rendering tests pass.',
  '- `npm t` passes lint.',
  '',
].join('\n');

// A hand-written document with no reslop structure at all
const FREE_FORM = [
  '# Live dashboard',
  '',
  '## Goal',
  '',
  'Add a live dashboard that opens first.',
  '',
  'Blocks:',
  '',
  '- files - size and count',
  '- diffs - lines added and removed',
  '',
  '```',
  'f - files',
  '# not a heading',
  '```',
  '',
  '| key | screen |',
  '| --- | ------ |',
  '| f   | files  |',
  '',
  '## 1. Entry screen',
  '',
  'Pressing `Esc` returns to the dashboard.',
  '',
].join('\n');

const SYNTHETIC = {
  crlf:
    '---\r\nstatus: editing\r\n---\r\n\r\n## Improvements\r\n\r\n' +
    '- [ ] a\r\n',
  noFinalNewline: '# Title\n\n- [ ] last',
  frontmatterOnly: '---\nstatus: editing\n---\n',
  empty: '',
  newlineOnly: '\n',
  nestedFence:
    '- [ ] task\n  ````\n  ```\n  # inside\n  ```\n  ````\n# after\n',
  tildeFence: '~~~~ js\n~~~\n## not a heading\n~~~~\ntext\n',
  unclosedFence: '```\n# open\n- [ ] not a task\n',
  tabs: '- [ ] tabbed\n\t- where: a.js\n\tmore\n\n\tcode\n',
  unicode: '## Задачи ✓\n\n- [ ] 修正 bug — «quotes» 🚀\n',
  blankRuns: '\n\n\n# a\n\n\n\nb\n\n\n',
  mixedEnds: 'a\r\nb\nc\r\n',
};

const roundTrip = (text) => MarkdownDoc.parse(text).toString();

test('MarkdownDoc prints repository Markdown back byte for byte', () => {
  const names = [
    'README.md',
    'CHANGELOG.md',
    'CONTRIBUTING.md',
    'SECURITY.md',
    ...markdownIn(path.join('test', 'fixtures')),
    ...markdownIn('docs'),
    ...markdownIn('.plan'),
  ];
  for (const name of names) {
    const text = fs.readFileSync(path.join(ROOT, name), 'utf8');
    assert.equal(roundTrip(text), text, name);
    assert.equal(serializeReview(parseReview(text, name)), text, name);
  }
});

test('MarkdownDoc round-trips edge cases', () => {
  const cases = { AGENT_PLAN, FREE_FORM, ...SYNTHETIC };
  for (const [name, text] of Object.entries(cases)) {
    assert.equal(roundTrip(text), text, name);
    assert.equal(serializeReview(parseReview(text, '/x.md')), text, name);
  }
});

test('MarkdownDoc keeps fences, headings, and items apart', () => {
  const types = (text) => MarkdownDoc.parse(text).blocks.map((b) => b.type);
  assert.deepEqual(types(SYNTHETIC.tildeFence), ['text', 'text']);
  assert.deepEqual(types(SYNTHETIC.nestedFence), ['item', 'heading']);
  assert.deepEqual(types(SYNTHETIC.unclosedFence), ['text']);
  const doc = MarkdownDoc.parse(SYNTHETIC.tabs);
  assert.equal(doc.blocks.length, 1);
  assert.equal(doc.blocks[0].lines.length, 5);
});

const changedLines = (before, after) => {
  const a = before.split('\n');
  const b = after.split('\n');
  assert.equal(a.length, b.length);
  return a.filter((line, i) => line !== b[i]).length;
};

test('toggling one task changes exactly one line', () => {
  const store = parseReview(AGENT_PLAN, '/repo/.plan/2026-10-26-00.md');
  const task = store.tasks.find((item) => item.text.startsWith('f2'));
  store.setTaskDone(task.id, true);
  const out = serializeReview(store);
  assert.equal(changedLines(AGENT_PLAN, out), 1);
  assert.match(out, /## Verification\n\n- F1–F3/);
});

test('the fixture plan reads its blocks and edits one line at a time', () => {
  const file = path.join(ROOT, 'test', 'fixtures', 'plan.md');
  const text = fs.readFileSync(file, 'utf8');
  const store = parseReview(text, file);
  const kinds = store.tasks.map((task) => task.kind);
  assert.deepEqual(kinds, ['bugs', 'bugs', 'bugs', 'debt', 'debt']);
  assert.match(store.tasks[4].text, /Free text after a blank line/);
  assert.equal(store.feedback.size, 1);
  const code = store.code.get('lib/diff/align.js:40:40:1');
  assert.equal(code.text, 'const gap = 1;');
  store.setTaskDone(store.tasks[2].id, true);
  store.setTaskDone(store.tasks[0].id, true);
  store.setFeedbackDone('lib/diff/align.js:12:12:0', true);
  const out = serializeReview(store);
  assert.equal(changedLines(text, out), 3);
  assert.equal(parseReview(out, file).tasks[2].done, true);
});

test('a CRLF plan keeps its line ends when a task is added', () => {
  const store = parseReview(SYNTHETIC.crlf, '/x.md');
  store.addTask('TODOs', 'b', false, 'improvements');
  const out = serializeReview(store);
  assert.equal(out, `${SYNTHETIC.crlf}- [ ] b\r\n`);
});

test('adding a task to a free-form file keeps every line', () => {
  const store = parseReview(FREE_FORM, '/repo/.plan/LIVE.md');
  store.addTask('TODOs', 'first task', false, 'features');
  const out = serializeReview(store);
  assert.ok(out.startsWith(FREE_FORM));
  const added = out.slice(FREE_FORM.length);
  assert.equal(
    added,
    '\n## Feature requests and Enhancements\n\n- [ ] first task\n',
  );
  assert.equal(parseReview(out, '/x.md').tasks.length, 1);
});

test('editing a structured task rewrites only its changed lines', () => {
  const text = [
    '## Bug Reports and Fixes',
    '',
    '- [ ] B1 high: Released connection can be assigned twice',
    '    - where: `lib/pool.js` acquire:84',
    '    - check:',
    '      - [ ] no shared connection',
    '- [ ] Timeout error message names the pool',
    '',
  ].join('\n');
  const store = parseReview(text, '/x.md');
  const [first] = store.tasks;
  assert.equal(first.kind, 'bugs');
  const edited = first.text.replace('acquire:84', 'acquire:90');
  store.setTaskText(first.id, edited);
  const out = serializeReview(store);
  assert.equal(changedLines(text, out), 1);
  assert.match(out, /^ {4}- where: `lib\/pool\.js` acquire:90$/m);
  assert.match(out, /^ {6}- \[ \] no shared connection$/m);
});

test('a task in a custom block has no kind and stays in place', () => {
  const store = parseReview(
    FREE_FORM.replace('Blocks:', '- [ ] add blocks'),
    '/x.md',
  );
  assert.equal(store.tasks.length, 1);
  assert.equal(store.tasks[0].kind, '');
  store.setTaskText(store.tasks[0].id, 'add all blocks');
  assert.match(
    serializeReview(store),
    /## Goal\n\n.*\n\n- \[ \] add all blocks\n/,
  );
});

test('removing a task leaves one blank line between blocks', () => {
  const store = parseReview(AGENT_PLAN, '/x.md');
  for (const task of store.tasks) store.removeTask(task.id);
  const out = serializeReview(store);
  assert.match(out, /## Improvements\n\n## Verification/);
});

test('edited instructions are kept when the plan is saved', () => {
  const open = AGENT_PLAN.replace('status: done', 'status: editing');
  const store = parseReview(open, '/repo/.plan/2026-10-26-00.md');
  store.addTask('TODOs', 'more', false, 'improvements');
  const out = serializeReview(store);
  assert.match(out, /- Run reviews with status `editing` or `partial`\n/);
  assert.doesNotMatch(out, /Tick each `check` item/);
  const fresh = new ReviewStore('/repo/.plan/2026-10-27-00.md');
  assert.match(serializeReview(fresh), /Tick each `check` item/);
});

test('the README task example round-trips and reads as fields', () => {
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const start = readme.indexOf('```md\n## Bug Reports and Fixes') + 6;
  const example = readme.slice(start, readme.indexOf('```\n', start));
  assert.equal(roundTrip(example), example);
  const store = parseReview(example, '/repo/specs/example.md');
  assert.equal(serializeReview(store), example);
  const [task, plain] = store.tasks;
  assert.equal(task.kind, 'bugs');
  assert.equal(task.item.id, 'B1');
  assert.equal(task.item.priority, 'high');
  assert.deepEqual(
    task.item.fields.map((field) => field.key),
    ['where', 'problem', 'expected', 'check'],
  );
  assert.equal(task.item.checks.length, 2);
  assert.equal(plain.item.title, 'Timeout error message names the pool');
});
