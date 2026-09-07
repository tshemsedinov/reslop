'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const review = require('../lib/review.js');
const { allocateReviewPath, dateStamp, rankedTemplates } = review;
const { prefixTemplates, upsertTemplate, createStore } = review;
const { hasNotes, setFeedback, noteCounts, rememberTemplate } = review;
const { addTodo, removeTodo, setTodoText, serializeReview } = review;
const { flushReview, mergeTodos, loadTemplates, parseReview } = review;
const { resolveReviewPath, latestReviewName } = review;
const { REVIEW_STATUSES, parseFrontmatterStatus } = review;

test('allocateReviewPath uses 00 then 01 on the same day', () => {
  const date = new Date(2026, 8, 7);
  const dir = '/repo';
  const first = allocateReviewPath(dir, date, []);
  assert.equal(first, path.join('/repo', '.review', '2026-09-07-00.md'));
  const second = allocateReviewPath(dir, date, ['2026-09-07-00.md']);
  assert.equal(second, path.join('/repo', '.review', '2026-09-07-01.md'));
  const other = allocateReviewPath(dir, date, ['2026-09-06-09.md']);
  assert.equal(other, path.join('/repo', '.review', '2026-09-07-00.md'));
});

test('latestReviewName picks the newest date then index', () => {
  assert.equal(latestReviewName([]), '');
  assert.equal(
    latestReviewName([
      'templates.json',
      '2026-09-06-09.md',
      '2026-09-07-00.md',
    ]),
    '2026-09-07-00.md',
  );
  assert.equal(
    latestReviewName(['2026-09-07-09.md', '2026-09-07-10.md']),
    '2026-09-07-10.md',
  );
});

test('resolveReviewPath resumes editing and starts new otherwise', () => {
  const dir = '/repo';
  const date = new Date(2026, 8, 7);
  const names = ['2026-09-07-00.md'];
  const editing = resolveReviewPath(dir, date, names, {
    readFileSync: () => '---\nstatus: editing\n---\n',
  });
  assert.equal(editing.resume, true);
  assert.equal(
    editing.reviewPath,
    path.join(dir, '.review', '2026-09-07-00.md'),
  );
  const pending = resolveReviewPath(dir, date, names, {
    readFileSync: () => '---\nstatus: pending\n---\n',
  });
  assert.equal(pending.resume, false);
  assert.equal(
    pending.reviewPath,
    path.join(dir, '.review', '2026-09-07-01.md'),
  );
  const partial = resolveReviewPath(dir, date, names, {
    readFileSync: () => '---\nstatus: partial\n---\n',
  });
  assert.equal(partial.resume, false);
  const done = resolveReviewPath(dir, date, names, {
    readFileSync: () => '---\nstatus: done\n---\n',
  });
  assert.equal(done.resume, false);
  const forced = resolveReviewPath(dir, date, names, {
    forceNew: true,
    readFileSync: () => '---\nstatus: editing\n---\n',
  });
  assert.equal(forced.resume, false);
  assert.equal(
    forced.reviewPath,
    path.join(dir, '.review', '2026-09-07-01.md'),
  );
});

test('dateStamp pads month and day', () => {
  assert.equal(dateStamp(new Date(2026, 0, 5)), '2026-01-05');
});

test('rankedTemplates sorts by frequency then text', () => {
  const ranked = rankedTemplates([
    { text: 'b', count: 1 },
    { text: 'a', count: 3 },
    { text: 'c', count: 3 },
  ]);
  assert.deepEqual(
    ranked.map((entry) => entry.text),
    ['a', 'c', 'b'],
  );
});

test('prefixTemplates keeps entries that start with the typed text', () => {
  const all = [
    { text: 'extract helper', count: 2 },
    { text: 'add tests', count: 1 },
    { text: 'extract type', count: 1 },
  ];
  assert.equal(prefixTemplates(all, ''), all);
  assert.deepEqual(
    prefixTemplates(all, 'extract').map((entry) => entry.text),
    ['extract helper', 'extract type'],
  );
  assert.deepEqual(prefixTemplates(all, 'z'), []);
});

test('upsertTemplate increments matching text', () => {
  const once = upsertTemplate([], 'extract helper');
  assert.deepEqual(once, [{ text: 'extract helper', count: 1 }]);
  const twice = upsertTemplate(once, 'extract helper');
  assert.deepEqual(twice, [{ text: 'extract helper', count: 2 }]);
  assert.deepEqual(once[0].count, 1);
});

test('rememberTemplate skips when the same hunk text is saved again', () => {
  const store = createStore('/tmp/x.md');
  rememberTemplate(store, '', 'extract helper');
  assert.deepEqual(store.templates, [{ text: 'extract helper', count: 1 }]);
  rememberTemplate(store, 'extract helper', 'extract helper');
  assert.equal(store.templates[0].count, 1);
  rememberTemplate(store, 'extract helper', 'extract helper\n');
  assert.equal(store.templates[0].count, 1);
});

test('rememberTemplate increments when reused on a new hunk', () => {
  const store = createStore('/tmp/x.md');
  rememberTemplate(store, '', 'extract helper');
  rememberTemplate(store, '', 'extract helper');
  assert.equal(store.templates[0].count, 2);
});

test('serializeReview groups todos then feedback with position', () => {
  const store = createStore('/repo/.review/2026-09-07-00.md');
  addTodo(store, 'lib/session.js', 'rewrite the retry loop');
  setFeedback(store, 'unstaged:lib/session.js:84:84:0', {
    file: 'lib/session.js',
    oldStart: 84,
    newStart: 84,
    blockId: 0,
    origin: 'unstaged',
    header: '@@ -84,12 +84,20 @@',
    text: 'extract a helper',
  });
  const md = serializeReview(store);
  assert.match(md, /status: editing/);
  assert.match(md, /# metadiff review 2026-09-07-00/);
  assert.match(md, /## Agent instructions/);
  assert.match(md, /^## lib\/session\.js$/m);
  assert.ok(!md.includes('> lib/session.js'));
  assert.ok(!md.includes('### Todo'));
  assert.ok(!md.includes('### Feedback'));
  assert.match(md, /- \[ \] rewrite the retry loop/);
  assert.match(md, /- \[ \] extract a helper - lib\/session\.js:84:84:0/);
  assert.ok(!md.includes('<!-- metadiff:'));
  assert.ok(!md.includes('Feedback `'));
  assert.ok(!md.includes('@@ -84,12 +84,20 @@'));
  assert.equal(hasNotes(store), true);
});

test('serializeReview writes pending when status is pending', () => {
  const store = createStore('/repo/.review/2026-09-07-00.md');
  store.status = 'pending';
  addTodo(store, 'a.js', 'follow up');
  const md = serializeReview(store);
  assert.match(md, /status: pending/);
  assert.deepEqual(REVIEW_STATUSES, ['editing', 'pending', 'partial', 'done']);
});

test('parseReview restores todos and feedback keys', () => {
  const store = createStore('/repo/.review/2026-09-07-00.md');
  addTodo(store, 'lib/session.js', 'rewrite the retry loop');
  const key = 'lib/session.js:84:84:0';
  setFeedback(store, key, {
    file: 'lib/session.js',
    oldStart: 84,
    newStart: 84,
    blockId: 0,
    origin: 'unstaged',
    header: '@@ -84,12 +84,20 @@',
    text: 'extract a helper',
  });
  const md = serializeReview(store);
  assert.equal(parseFrontmatterStatus(md), 'editing');
  const loaded = parseReview(md, store.reviewPath);
  assert.equal(loaded.status, 'editing');
  assert.equal(loaded.todos.length, 1);
  assert.equal(loaded.todos[0].file, 'lib/session.js');
  assert.equal(loaded.todos[0].text, 'rewrite the retry loop');
  assert.equal(loaded.todos[0].done, false);
  assert.equal(loaded.feedback.get(key).text, 'extract a helper');
  assert.equal(loaded.feedback.get(key).done, false);
  assert.equal(loaded.feedback.get(key).file, 'lib/session.js');
  assert.equal(loaded.feedback.get(key).oldStart, 84);
  assert.equal(loaded.feedback.get(key).blockId, 0);
  assert.equal(loaded.dirty, false);
});

test('parseReview reads the old HTML comment feedback format', () => {
  const md = [
    '---',
    'status: editing',
    '---',
    '',
    '## lib/database.js',
    '',
    '### Feedback `lib/database.js` +41 (@@ -41,1 +41,1 @@, block 0)',
    '',
    '<!-- metadiff:staged:lib/database.js:41:41:0 -->',
    '- [ ] old note',
    '',
  ].join('\n');
  const loaded = parseReview(md, '/repo/.review/x.md');
  const note = loaded.feedback.get('lib/database.js:41:41:0');
  assert.equal(note.text, 'old note');
  assert.equal(note.file, 'lib/database.js');
  assert.equal(note.origin, 'staged');
  assert.equal(note.oldStart, 41);
  assert.equal(note.newStart, 41);
  assert.equal(note.blockId, 0);
  assert.equal(note.done, false);
});

test('parseReview keeps checked todos and feedback', () => {
  const md = [
    '---',
    'status: partial',
    '---',
    '',
    '> a.js',
    '',
    '- [x] rewrite loop',
    '- [ ] still open',
    '- [X] extract helper - a.js:1:1:0',
    '',
  ].join('\n');
  const loaded = parseReview(md, '/repo/.review/x.md');
  assert.equal(loaded.todos[0].done, true);
  assert.equal(loaded.todos[0].text, 'rewrite loop');
  assert.equal(loaded.todos[1].done, false);
  assert.equal(loaded.feedback.get('a.js:1:1:0').done, true);
  const out = serializeReview(loaded);
  assert.match(out, /^## a\.js$/m);
  assert.ok(!out.includes('> a.js'));
  assert.match(out, /- \[x\] rewrite loop/);
  assert.match(out, /- \[ \] still open/);
  assert.match(out, /- \[x\] extract helper - a\.js:1:1:0/);
});

test('noteCounts counts filled feedback and todos', () => {
  const store = createStore('/repo/.review/x.md');
  assert.deepEqual(noteCounts(null), { feedback: 0, todo: 0 });
  assert.deepEqual(noteCounts(store), { feedback: 0, todo: 0 });
  addTodo(store, 'a.js', '');
  assert.deepEqual(noteCounts(store), { feedback: 0, todo: 0 });
  addTodo(store, 'a.js', 'rewrite loop');
  setFeedback(store, 'a.js:1:1:0', {
    file: 'a.js',
    oldStart: 1,
    newStart: 1,
    blockId: 0,
    text: 'extract helper',
  });
  assert.deepEqual(noteCounts(store), { feedback: 1, todo: 1 });
  assert.equal(hasNotes(store), true);
});

test('empty text is omitted from markdown and hasNotes', () => {
  const store = createStore('/repo/.review/2026-09-07-00.md');
  addTodo(store, 'a.js', '   ');
  setFeedback(store, 'k', {
    file: 'a.js',
    newStart: 1,
    text: '',
  });
  assert.equal(hasNotes(store), false);
  const md = serializeReview(store);
  assert.ok(!md.includes('### Todo'));
  assert.ok(!md.includes('### Feedback'));
  assert.ok(!md.includes('## a.js'));
  assert.ok(!md.includes('> a.js'));
});

test('setFeedback keeps one latest note per key', () => {
  const store = createStore('/tmp/x.md');
  setFeedback(store, 'k', {
    file: 'a.js',
    newStart: 1,
    text: 'first draft',
  });
  setFeedback(store, 'k', {
    file: 'a.js',
    newStart: 1,
    text: 'latest',
  });
  assert.equal(store.feedback.size, 1);
  assert.equal(store.feedback.get('k').text, 'latest');
  assert.equal(store.templates.length, 0);
  const md = serializeReview(store);
  assert.equal([...md.matchAll(/^## a\.js$/gm)].length, 1);
  assert.match(md, /- \[ \] latest - a\.js:0:1:0/);
  assert.ok(!md.includes('first draft'));
  assert.ok(!md.includes('### Feedback'));
});

test('removeTodo drops a todo by id', () => {
  const store = createStore('/tmp/x.md');
  const first = addTodo(store, 'a.js', 'keep');
  const second = addTodo(store, 'a.js', 'drop');
  assert.equal(removeTodo(store, second.id), true);
  assert.deepEqual(
    store.todos.map((todo) => todo.id),
    [first.id],
  );
  assert.equal(removeTodo(store, 99), false);
  assert.equal(store.todos.length, 1);
});

test('setTodoText deletes empty todos without template history', () => {
  const store = createStore('/tmp/x.md');
  const todo = addTodo(store, 'a.js', '');
  setTodoText(store, todo.id, 'add tests');
  setTodoText(store, todo.id, 'add tests please');
  assert.equal(store.todos.length, 1);
  assert.equal(store.todos[0].text, 'add tests please');
  assert.equal(store.templates.length, 0);
  setTodoText(store, todo.id, '');
  assert.equal(store.todos.length, 0);
});

test('flushReview writes markdown and templates when notes exist', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metadiff-review-'));
  try {
    const reviewPath = path.join(dir, '.review', '2026-09-07-00.md');
    const store = createStore(reviewPath);
    setFeedback(store, 'k', {
      file: 'a.js',
      newStart: 3,
      blockId: 0,
      header: '@@ -3,1 +3,1 @@',
      text: 'rename this',
    });
    const wrote = flushReview(store, {
      writeFileSync: fs.writeFileSync,
      mkdirSync: fs.mkdirSync,
    });
    assert.equal(wrote, true);
    assert.equal(store.dirty, false);
    const md = fs.readFileSync(reviewPath, 'utf8');
    assert.match(md, /rename this/);
    const templates = loadTemplates(dir);
    assert.equal(templates.length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('flushReview skips write when there are no notes', () => {
  const writes = [];
  const store = createStore('/repo/.review/2026-09-07-00.md');
  store.dirty = true;
  const wrote = flushReview(store, {
    writeFileSync: (file, body) => writes.push({ file, body }),
    mkdirSync: () => {},
  });
  assert.equal(wrote, false);
  assert.equal(writes.length, 0);
  assert.equal(store.dirty, false);
});

test('mergeTodos puts one assigned todo page first per file', () => {
  const hunk = {
    origin: 'unstaged',
    file: { newPath: 'a.js', oldPath: 'a.js' },
    hunk: { oldStart: 1, newStart: 1 },
    blockId: 0,
  };
  const more = {
    origin: 'unstaged',
    file: { newPath: 'a.js', oldPath: 'a.js' },
    hunk: { oldStart: 4, newStart: 4 },
    blockId: 1,
  };
  const other = {
    origin: 'unstaged',
    file: { newPath: 'b.js', oldPath: 'b.js' },
    hunk: { oldStart: 1, newStart: 1 },
    blockId: 0,
  };
  const merged = mergeTodos(
    [hunk, more, other],
    [
      { id: 1, file: 'a.js', text: 'todo a' },
      { id: 2, file: 'a.js', text: 'todo a2' },
      { id: 3, file: 'a.js', text: '' },
    ],
  );
  assert.equal(merged[0].origin, 'todo');
  assert.equal(merged[0].file.newPath, 'a.js');
  assert.equal(merged[1], hunk);
  assert.equal(merged[2], more);
  assert.equal(merged[3], other);
  assert.equal(merged.filter((item) => item.origin === 'todo').length, 1);
  const empty = mergeTodos([hunk], [{ id: 1, file: 'a.js', text: '' }]);
  assert.equal(empty[0].origin, 'todo');
  assert.equal(empty[1], hunk);
});
