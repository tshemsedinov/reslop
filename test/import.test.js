'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const imports = require('../lib/review/import.js');
const { issueKind, issuePriority, parseIssueBody } = imports;
const { ReviewStore, serializeReview } = require('../lib/review/review.js');

const URL_86 = 'https://github.com/tshemsedinov/reslop/issues/86';

// The shape of the body of issue #86: a structured block in a fence, with
// a list under some of the keys
const BODY_86 = [
  'Tasks in a plan are one line; an agent has to guess the rest.',
  '',
  '```',
  'e10: bug high',
  'where: src/pool.js#acquire:84',
  'problem: Released connection can be assigned to two consumers.',
  'evidence:',
  '- test: test/pool-concurrency.js',
  '- fails about 1 of 20 runs',
  'expected: Each connection has at most one active owner.',
  'do: make the ownership transfer atomic',
  'constraints: keep the public API; no new dependencies',
  'check:',
  '- 100 concurrent acquires never share a connection',
  '- [x] all pool tests pass',
  'related: lib/review/task.js',
  '```',
].join('\n');

const issue86 = (extra = {}) => ({
  title: 'Structured feedback/todo',
  body: BODY_86,
  author: 'tshemsedinov',
  url: URL_86,
  labels: ['enhancement'],
  host: 'github',
  comments: [{ author: 'bob', body: 'agree' }],
  ...extra,
});

test('the body of issue #86 imports as fields', () => {
  const store = new ReviewStore('/tmp/x.md');
  store.applyImportedNotes({ tasks: [{ file: 'issue', issue: issue86() }] });
  const [task] = store.tasks;
  assert.equal(task.kind, 'features');
  assert.equal(task.item.title, 'Structured feedback/todo');
  assert.deepEqual(
    task.item.fields.map((field) => field.key),
    [
      'where',
      'problem',
      'evidence',
      'expected',
      'do',
      'constraints',
      'check',
      'related',
    ],
  );
  assert.equal(task.item.value('where'), 'src/pool.js#acquire:84');
  assert.equal(
    task.item.value('evidence'),
    '- test: test/pool-concurrency.js\n- fails about 1 of 20 runs',
  );
  assert.deepEqual(
    task.item.checks.map((check) => [check.done, check.text]),
    [
      [false, '100 concurrent acquires never share a connection'],
      [true, 'all pool tests pass'],
    ],
  );
  assert.equal(task.item.value('related'), `${URL_86}, lib/review/task.js`);
  const text = serializeReview(store);
  assert.match(text, /\n {2}> @tshemsedinov at github:\n {2}> Tasks in a plan/);
  assert.match(text, /\n {2}> e10: bug high\n/);
  assert.match(text, /\n {2}> @bob at github:\n {2}> agree\n/);
});

test('a second import of the same issue is matched by URL', () => {
  const store = new ReviewStore('/tmp/x.md');
  const tasks = [{ file: 'issue', issue: issue86() }];
  store.applyImportedNotes({ tasks });
  const once = serializeReview(store);
  const edited = issue86({ body: 'a new body', title: 'Renamed' });
  store.applyImportedNotes({ tasks: [{ file: 'issue', issue: edited }] });
  assert.equal(store.tasks.length, 1);
  assert.equal(serializeReview(store), once);
  const old = new ReviewStore('/tmp/x.md');
  old.addTask('issue', `@alice at github: Add import\nIssue: ${URL_86}`);
  old.applyImportedNotes({ tasks });
  assert.equal(old.tasks.length, 1);
});

test('labels give the kind and the priority', () => {
  assert.equal(issueKind(['Bug']), 'bugs');
  assert.equal(issueKind(['feature']), 'features');
  assert.equal(issueKind(['security', 'bug']), 'bugs');
  assert.equal(issueKind(['refactor']), 'debt');
  assert.equal(issueKind(['question']), 'research');
  assert.equal(issueKind(['docs']), 'improvements');
  assert.equal(issueKind([]), 'improvements');
  assert.equal(issuePriority(['priority: high']), 'high');
  assert.equal(issuePriority(['critical']), 'critical');
  assert.equal(issuePriority(['bug']), '');
  const store = new ReviewStore('/tmp/x.md');
  const bug = issue86({ labels: ['bug', 'priority/critical'], body: 'x' });
  store.applyImportedNotes({ tasks: [{ file: 'issue', issue: bug }] });
  assert.equal(store.tasks[0].kind, 'bugs');
  assert.equal(store.tasks[0].item.priority, 'critical');
});

test('parseIssueBody keeps lines that are not known fields', () => {
  const { fields, rest } = parseIssueBody(
    'note: free\nwhere: a.js\n  b.js\n\nresult: done by the issue',
  );
  assert.deepEqual([...fields], [['where', 'a.js\nb.js']]);
  assert.deepEqual(rest, ['note: free', '', 'result: done by the issue']);
});
