'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { Session } = require('../lib/session.js');
const { CHECK_INTERVAL_MS } = require('../lib/update.js');
const { hitAction } = require('../lib/keys.js');
const { sink } = require('./helpers.js');
const { createStore, addTodo, serializeReview } = require('../lib/review.js');
const { stripAnsi, THEME, BOLD, seq } = require('../lib/ansi.js');
const { REVIEW_DIR } = require('../lib/files.js');

const reviewFile = (name) => path.join('/tmp', REVIEW_DIR, name);

const sampleItem = (name, origin = 'unstaged') => ({
  origin,
  file: {
    oldPath: name,
    newPath: name,
    isNew: false,
    isDeleted: false,
    isBinary: false,
    preamble: [`diff --git a/${name} b/${name}`],
    hunks: [],
  },
  hunk: {
    oldStart: 1,
    oldCount: 1,
    newStart: 1,
    newCount: 1,
    header: '@@ -1,1 +1,1 @@',
    lines: [
      { type: 'del', text: 'a', noNl: false, blockId: 0 },
      { type: 'add', text: 'b', noNl: false, blockId: 0 },
    ],
  },
  blockId: 0,
  patchAdd: 'add',
  patchRevert: 'rev',
});

const mockRepo = (initial) => {
  let items = [...initial];
  const added = [];
  const reverted = [];
  const unstageCalls = [];
  const commits = [];
  const pulls = [];
  const pushes = [];
  const checkouts = [];
  const created = [];
  return {
    added,
    reverted,
    unstageCalls,
    commits,
    pulls,
    pushes,
    checkouts,
    created,
    load: () => ({ top: '/tmp', items: [...items], branch: 'main' }),
    add: (top, item) => {
      added.push(item);
      items = items.filter((entry) => entry !== item);
    },
    unstage: (top, item) => {
      unstageCalls.push(item);
      items = items.filter((entry) => entry !== item);
    },
    revert: (top, item) => {
      reverted.push(item);
      items = items.filter((entry) => entry !== item);
    },
    revertFile: (top, rel, group) => {
      const targets = group && group.length ? group : [];
      for (const item of targets) {
        reverted.push(item);
        items = items.filter((entry) => entry !== item);
      }
    },
    commit: (top, kind, message) => {
      commits.push({ top, kind, message });
    },
    lastMessage: () => 'previous message',
    listBranches: () => [
      { name: 'main', current: true },
      { name: 'feat', current: false },
    ],
    checkout: (top, name) => checkouts.push(name),
    createBranch: (top, name) => created.push(name),
    pull: () => pulls.push(true),
    push: () => pushes.push(true),
  };
};

const missingFile = () => {
  const error = new Error('ENOENT');
  error.code = 'ENOENT';
  throw error;
};

const reviewReader = (md) => (file) => {
  const name = `${file ?? ''}`;
  if (name.endsWith('.md')) return md;
  return missingFile();
};

const reviewFs = {
  readdirSync: () => [],
  readFileSync: () => missingFile(),
  writeFileSync: () => {},
  mkdirSync: () => {},
  now: () => new Date(2026, 8, 7),
};

const openSession = (items, extra = {}) => {
  const repo = extra.repo ?? mockRepo(items);
  const stdout = sink();
  const session = new Session({
    cwd: '/tmp',
    stdout,
    color: false,
    getSize: () => ({ width: 80, height: 16 }),
    startPane: 'diff',
    ...reviewFs,
    ...extra,
    repo,
  });
  session.load();
  return { session, repo, stdout };
};

test('prev at first block opens todos and next reaches last', () => {
  const a = sampleItem('a.js');
  const b = sampleItem('b.js');
  const c = sampleItem('c.js');
  const { session } = openSession([a, b, c]);
  session.dispatch('prev');
  assert.equal(session.current().origin, 'todo');
  session.dispatch('next');
  assert.equal(session.current().file.newPath, 'a.js');
  session.dispatch('next');
  assert.equal(session.current().file.newPath, 'b.js');
  session.dispatch('next');
  assert.equal(session.current().file.newPath, 'c.js');
  session.dispatch('next');
  assert.equal(session.current().file.newPath, 'c.js');
});

test('AC8 add on staged is a no-op', () => {
  const item = sampleItem('s.js', 'staged');
  const { session, repo } = openSession([item]);
  session.dispatch('add');
  assert.equal(session.status, '');
  assert.equal(repo.added.length, 0);
  assert.equal(session.items.length, 1);
  assert.equal(session.items[0].origin, 'staged');
});

test('diff screen dims a on staged and u on unstaged', () => {
  const stagedItem = sampleItem('s.js', 'staged');
  const staged = openSession([stagedItem], { color: true });
  staged.session.draw();
  const stagedRow = staged.session.lastFrame.rows.at(-1);
  const rest = seq(THEME.buttonFg, THEME.buttonBg);
  const hot = seq(THEME.buttonHotFg, THEME.buttonBg);
  const stagedHits = staged.session.lastFrame.buttons;
  assert.equal(
    stagedHits.find((hit) => hit.id === 'add'),
    undefined,
  );
  assert.ok(stagedHits.find((hit) => hit.id === 'unstage'));
  assert.ok(stagedRow.includes(`${rest}add`));
  assert.ok(!stagedRow.includes(`${BOLD}${hot}a`));
  assert.ok(stagedRow.includes(`${BOLD}${hot}u`));
  staged.session.handleEvent({ type: 'key', key: 'a' });
  assert.equal(staged.repo.added.length, 0);
  assert.equal(staged.session.status, '');

  const unstaged = openSession([sampleItem('u.js')], { color: true });
  unstaged.session.draw();
  const unstagedRow = unstaged.session.lastFrame.rows.at(-1);
  assert.ok(unstaged.session.lastFrame.buttons.find((hit) => hit.id === 'add'));
  assert.equal(
    unstaged.session.lastFrame.buttons.find((hit) => hit.id === 'unstage'),
    undefined,
  );
  assert.ok(unstagedRow.includes(`${BOLD}${hot}a`));
  assert.ok(unstagedRow.includes(`${rest}unstage`));
  unstaged.session.handleEvent({ type: 'key', key: 'u' });
  assert.equal(unstaged.repo.unstageCalls.length, 0);
  assert.equal(unstaged.session.status, '');
});

test('add and unstage keep block order', () => {
  const a = sampleItem('a.js');
  const b = sampleItem('b.js');
  const c = sampleItem('c.js');
  const { session, repo } = openSession([a, b, c]);
  let loads = 0;
  const inner = repo.load;
  repo.load = () => {
    loads += 1;
    return inner();
  };
  session.index = 1;
  session.dispatch('add');
  assert.equal(loads, 0);
  assert.equal(repo.added.length, 1);
  assert.deepEqual(
    session.items.map((item) => item.file.newPath),
    ['a.js', 'b.js', 'c.js'],
  );
  assert.equal(session.items[1].origin, 'staged');
  assert.equal(session.current().file.newPath, 'b.js');
  session.dispatch('unstage');
  assert.equal(loads, 0);
  assert.equal(session.items[1].origin, 'unstaged');
  assert.deepEqual(
    session.items.map((item) => item.file.newPath),
    ['a.js', 'b.js', 'c.js'],
  );
});

test('AC28 unstage drops index keeps worktree', () => {
  const staged = sampleItem('s.js', 'staged');
  const other = sampleItem('a.js');
  const { session, repo } = openSession([staged, other]);
  session.dispatch('unstage');
  assert.equal(repo.unstageCalls.length, 1);
  assert.equal(session.status, 'unstaged');
});

test('AC28 unstage on unstaged is a no-op', () => {
  const item = sampleItem('a.js');
  const { session, repo } = openSession([item]);
  session.dispatch('unstage');
  assert.equal(session.status, '');
  assert.equal(repo.unstageCalls.length, 0);
  assert.equal(session.items.length, 1);
});

test('AC21 commit add and revert are read only', () => {
  const item = sampleItem('c.js', 'commit');
  const { session, repo } = openSession([item]);
  session.revShort = '7ac260c';
  session.dispatch('add');
  assert.equal(session.status, 'read only');
  assert.equal(repo.added.length, 0);
  session.dispatch('revert');
  assert.equal(session.status, 'read only');
  assert.equal(repo.reverted.length, 0);
  session.dispatch('unstage');
  assert.equal(session.status, 'read only');
  assert.equal(repo.unstageCalls.length, 0);
  session.dispatch('commit');
  assert.equal(session.status, 'read only');
  assert.equal(repo.commits.length, 0);
  const files = session.fileList();
  assert.equal(files[0].kind, 'todos');
  assert.equal(files[1].status, '7ac260c');
  session.dispatch('next');
  assert.equal(session.status, 'read only');
  assert.equal(repo.added.length, 0);
});

test('PR add and revert are read only and feedback attaches', () => {
  const item = sampleItem('lib/a.js', 'pr');
  const { session, repo } = openSession([item], {
    sourceLabel: '#12',
    change: {
      source: 'github-pr',
      repository: 'acme/app',
      title: 'Fix',
      author: 'alice',
      number: 12,
    },
    repoName: 'acme/app',
  });
  session.dispatch('add');
  assert.equal(session.status, 'read only');
  assert.equal(repo.added.length, 0);
  session.dispatch('revert');
  assert.equal(session.status, 'read only');
  assert.equal(repo.reverted.length, 0);
  session.dispatch('unstage');
  assert.equal(session.status, 'read only');
  session.dispatch('commit');
  assert.equal(session.status, 'read only');
  assert.equal(repo.commits.length, 0);
  const files = session.fileList();
  assert.equal(files[0].kind, 'todos');
  assert.equal(files[1].status, '#12');
  session.dispatch('feedback');
  session.pushInput('prefer const');
  session.handleEvent({ type: 'key', key: 'ctrl-s' });
  const note = session.notes.feedback.get('lib/a.js:1:1:0');
  assert.equal(note.text, 'prefer const');
  assert.equal(session.counts().pr, 1);
  assert.equal(session.counts().feedback, 1);
  session.dispatch('next');
  assert.equal(session.status, 'saved');
  session.dispatch('prev');
  assert.equal(session.current().origin, 'todo');
  session.dispatch('next');
  assert.equal(session.current().file.newPath, 'lib/a.js');
  const view = session.view();
  assert.equal(view.sourceKind, 'pr');
  assert.equal(view.sourceLabel, '#12');
  assert.equal(view.repoName, 'acme/app');
});

test('MR add and revert are read only and feedback attaches', () => {
  const item = sampleItem('lib/a.js', 'pr');
  const { session, repo } = openSession([item], {
    sourceLabel: '!12',
    change: {
      source: 'gitlab-mr',
      repository: 'acme/app',
      title: 'Fix',
      author: 'alice',
      number: 12,
    },
    repoName: 'acme/app',
  });
  session.dispatch('add');
  assert.equal(session.status, 'read only');
  assert.equal(repo.added.length, 0);
  session.dispatch('revert');
  assert.equal(session.status, 'read only');
  const files = session.fileList();
  assert.equal(files[0].kind, 'todos');
  assert.equal(files[1].status, '!12');
  const view = session.view();
  assert.equal(view.sourceKind, 'mr');
  assert.equal(view.sourceLabel, '!12');
  assert.equal(view.repoName, 'acme/app');
});

test('-r blocks add unstage revert and still takes feedback', () => {
  const item = sampleItem('a.js');
  const { session, repo } = openSession([item], { readOnly: true });
  session.dispatch('add');
  assert.equal(session.status, 'read only');
  assert.equal(repo.added.length, 0);
  session.dispatch('unstage');
  assert.equal(session.status, 'read only');
  assert.equal(repo.unstageCalls.length, 0);
  session.dispatch('revert');
  assert.equal(session.status, 'read only');
  assert.equal(repo.reverted.length, 0);
  session.dispatch('commit');
  assert.equal(session.status, 'read only');
  assert.equal(repo.commits.length, 0);
  session.pane = 'files';
  session.dispatch('add');
  assert.equal(session.status, 'read only');
  assert.equal(repo.added.length, 0);
  session.pane = 'diff';
  session.dispatch('feedback');
  session.pushInput('keep this');
  session.handleEvent({ type: 'key', key: 'ctrl-s' });
  const note = session.notes.feedback.get('a.js:1:1:0');
  assert.equal(note.text, 'keep this');
});

test('AC9 hotkeys dispatch add revert next prev quit', () => {
  const a = sampleItem('a.js');
  const b = sampleItem('b.js');
  const c = sampleItem('c.js');
  const { session, repo } = openSession([a, b, c]);
  assert.equal(session.layout, 'unified');
  session.pushInput('n');
  assert.equal(session.current().file.newPath, 'b.js');
  session.pushInput('p');
  assert.equal(session.current().file.newPath, 'a.js');
  session.pushInput('a');
  assert.equal(repo.added.length, 1);
  assert.equal(repo.added[0].file.newPath, 'a.js');
  session.pushInput('d');
  assert.equal(repo.reverted.length, 1);
  session.pushInput('m');
  assert.equal(session.layout, 'mixed');
  assert.equal(session.status, 'mixed');
  session.pushInput('m');
  assert.equal(session.layout, 'side');
  assert.equal(session.status, 'side-by-side');
  session.pushInput('m');
  assert.equal(session.layout, 'unified');
  session.pushInput('r');
  assert.equal(session.pane, 'diff');
  session.handleEvent({ type: 'key', key: 'escape' });
  assert.equal(session.pane, 'files');
  session.pushInput('q');
  assert.equal(session.done, true);
});

test('j and k move next and prev on the diff', () => {
  const a = sampleItem('a.js');
  const b = sampleItem('b.js');
  const { session } = openSession([a, b]);
  session.pushInput('j');
  assert.equal(session.current().file.newPath, 'b.js');
  session.pushInput('k');
  assert.equal(session.current().file.newPath, 'a.js');
  session.pushInput('k');
  assert.equal(session.current().origin, 'todo');
  session.pushInput('j');
  assert.equal(session.current().file.newPath, 'a.js');
});

test('j and k move the files cursor', () => {
  const a = sampleItem('a.js');
  const b = sampleItem('b.js');
  const { session } = openSession([a, b], { startPane: 'files' });
  assert.equal(session.fileCursor, 0);
  session.pushInput('j');
  assert.equal(session.fileCursor, 1);
  session.pushInput('k');
  assert.equal(session.fileCursor, 0);
});

test('vim ctrl keys scroll the diff by line and page', () => {
  const { session } = openSession([sampleItem('a.js')]);
  session.draw();
  const page = session.lastFrame.bodyH;
  assert.ok(page > 1);
  session.handleEvent({ type: 'key', key: 'ctrl-e' });
  assert.equal(session.scroll, 1);
  session.handleEvent({ type: 'key', key: 'ctrl-y' });
  assert.equal(session.scroll, 0);
  session.handleEvent({ type: 'key', key: 'ctrl-f' });
  assert.equal(session.scroll, page);
  session.handleEvent({ type: 'key', key: 'ctrl-b' });
  assert.equal(session.scroll, 0);
  session.handleEvent({ type: 'key', key: 'ctrl-d' });
  assert.equal(session.scroll, Math.max(1, Math.floor(page * 0.5)));
  session.handleEvent({ type: 'key', key: 'ctrl-u' });
  assert.equal(session.scroll, 0);
});

test('vim ctrl-f pages down the files list', () => {
  const items = [];
  for (let i = 0; i < 20; i++) items.push(sampleItem(`f${i}.js`));
  const { session } = openSession(items, { startPane: 'files' });
  session.draw();
  const page = session.lastFrame.bodyH;
  assert.equal(session.fileCursor, 0);
  session.handleEvent({ type: 'key', key: 'ctrl-f' });
  assert.equal(session.fileCursor, page);
  session.handleEvent({ type: 'key', key: 'ctrl-b' });
  assert.equal(session.fileCursor, 0);
});

test('AC10 footer Add hitbox dispatches add', () => {
  const item = sampleItem('c.js');
  const { session, repo } = openSession([item]);
  session.draw();
  const hit = session.lastFrame.buttons.find((entry) => entry.id === 'add');
  assert.ok(hit);
  assert.equal(hitAction(session.lastFrame.buttons, hit.x0), 'add');
  session.handleEvent({
    type: 'mouse',
    button: 0,
    btn: 0,
    kind: 'press',
    x: hit.x0 + 1,
    y: session.lastFrame.height,
    press: true,
  });
  session.handleEvent({
    type: 'mouse',
    button: 0,
    btn: 0,
    kind: 'release',
    x: hit.x0 + 1,
    y: session.lastFrame.height,
    press: false,
  });
  assert.equal(repo.added.length, 1);
});

test('AC13 drag copies selected text', () => {
  const copied = [];
  const item = sampleItem('c.js');
  const repo = mockRepo([item]);
  const stdout = sink();
  const session = new Session({
    repo,
    cwd: '/tmp',
    stdout,
    color: false,
    startPane: 'diff',
    getSize: () => ({ width: 80, height: 16 }),
    copyText: (text) => {
      copied.push(text);
      return true;
    },
    ...reviewFs,
  });
  session.load();
  session.draw();
  session.handleEvent({
    type: 'mouse',
    kind: 'press',
    btn: 0,
    button: 0,
    x: 1,
    y: 3,
    press: true,
  });
  session.handleEvent({
    type: 'mouse',
    kind: 'drag',
    btn: 0,
    button: 32,
    x: 40,
    y: 5,
    press: true,
  });
  session.handleEvent({
    type: 'mouse',
    kind: 'release',
    btn: 0,
    button: 0,
    x: 40,
    y: 5,
    press: false,
  });
  assert.equal(copied.length, 1);
  assert.ok(copied[0].length > 0);
  assert.equal(session.status, 'copied');
});

test('draw writes once for an unchanged frame', () => {
  const item = sampleItem('c.js');
  const { session, stdout } = openSession([item]);
  session.draw();
  const first = stdout.dump();
  session.draw();
  assert.equal(stdout.dump(), first);
  assert.ok(first.includes('[?2026h'));
  assert.ok(first.includes('[2J'));
  session.dispatch('layout');
  session.draw();
  const second = stdout.dump();
  assert.ok(second.length > first.length);
  const extra = second.slice(first.length);
  assert.ok(extra.includes('[?2026h'));
  assert.ok(!extra.includes('[2J'));
});

test('escape from diff opens the file list, then quits', () => {
  const { session } = openSession([sampleItem('a.js'), sampleItem('b.js')]);
  assert.equal(session.pane, 'diff');
  session.handleEvent({ type: 'key', key: 'escape' });
  assert.equal(session.pane, 'files');
  assert.equal(session.done, false);
  session.handleEvent({ type: 'key', key: 'escape' });
  assert.equal(session.done, true);
});

test('escape from files with notes asks to finish or continue', () => {
  const { session } = openSession([sampleItem('a.js')]);
  session.dispatch('feedback');
  session.pushInput('nits');
  session.handleEvent({ type: 'key', key: 'ctrl-s' });
  session.handleEvent({ type: 'key', key: 'escape' });
  assert.equal(session.pane, 'files');
  assert.equal(session.done, false);
  session.handleEvent({ type: 'key', key: 'escape' });
  assert.equal(session.done, false);
  assert.equal(session.mode, 'confirmQuit');
  session.pushInput('c');
  assert.equal(session.done, true);
  assert.equal(session.notes.status, 'editing');
});

test('starts on the file list', () => {
  const item = sampleItem('a.js');
  const repo = mockRepo([item]);
  const stdout = sink();
  const session = new Session({
    repo,
    cwd: '/tmp',
    stdout,
    color: false,
    getSize: () => ({ width: 80, height: 16 }),
    ...reviewFs,
  });
  session.load();
  assert.equal(session.pane, 'files');
  assert.equal(session.fileCursor, 0);
  assert.equal(session.fileList()[0].kind, 'todos');
  session.dispatch('open');
  assert.equal(session.pane, 'diff');
  assert.equal(session.current().origin, 'todo');
});

test('AC14 files pane lists paths and enter opens', () => {
  const a = sampleItem('a.js');
  const b = sampleItem('b.js');
  const repo = mockRepo([a, b]);
  const stdout = sink();
  const session = new Session({
    repo,
    cwd: '/tmp',
    stdout,
    color: false,
    startPane: 'files',
    getSize: () => ({ width: 80, height: 16 }),
    ...reviewFs,
  });
  session.load();
  assert.equal(session.pane, 'files');
  session.draw();
  const text = stdout.dump();
  assert.match(text, /reslop: tmp\/TODOs\s+todo 1\/3/);
  assert.ok(!text.includes('@@'));
  assert.match(text, /Repository TODOs and Issues/);
  assert.match(text, /a\.js/);
  assert.match(text, /b\.js/);
  session.dispatch('scrollDown');
  assert.equal(session.fileCursor, 1);
  session.dispatch('open');
  assert.equal(session.pane, 'diff');
  assert.equal(session.current().file.newPath, 'a.js');
  session.dispatch('files');
  assert.equal(session.pane, 'files');
  assert.equal(session.fileCursor, 1);
});

test('enter on a partial file opens the first unstaged hunk', () => {
  const staged = sampleItem('a.js', 'staged');
  const unstaged = sampleItem('a.js');
  unstaged.blockId = 1;
  const { session } = openSession([staged, unstaged], { startPane: 'files' });
  session.dispatch('next');
  session.dispatch('open');
  assert.equal(session.pane, 'diff');
  assert.equal(session.current().origin, 'unstaged');
  assert.equal(session.index, 1);
});

test('files pane add moves to the next file', () => {
  const { session } = openSession(
    [sampleItem('a.js'), sampleItem('b.js'), sampleItem('c.js')],
    { startPane: 'files' },
  );
  session.dispatch('next');
  session.dispatch('add');
  assert.equal(session.fileCursor, 2);
  assert.equal(session.fileList()[2].path, 'b.js');
  assert.equal(session.items[0].origin, 'staged');
  session.dispatch('prev');
  session.dispatch('unstage');
  assert.equal(session.fileCursor, 2);
  assert.equal(session.items[0].origin, 'unstaged');
});

test('files pane add on last file keeps the cursor', () => {
  const { session } = openSession(
    [sampleItem('a.js'), sampleItem('b.js'), sampleItem('c.js')],
    { startPane: 'files' },
  );
  session.dispatch('next');
  session.dispatch('next');
  session.dispatch('next');
  assert.equal(session.fileCursor, 3);
  session.reviewPath = 'a.js';
  session.dispatch('add');
  assert.equal(session.fileCursor, 3);
  assert.equal(session.fileList()[3].path, 'c.js');
  assert.equal(session.items[2].origin, 'staged');
  session.dispatch('unstage');
  assert.equal(session.fileCursor, 3);
  assert.equal(session.items[2].origin, 'unstaged');
});

test('files pane add unstage revert apply to the whole file', () => {
  const first = sampleItem('a.js');
  const second = sampleItem('a.js');
  second.blockId = 1;
  second.hunk = {
    ...second.hunk,
    oldStart: 10,
    newStart: 10,
    header: '@@ -10,1 +10,1 @@',
    blockId: 1,
  };
  const other = sampleItem('b.js');
  const { session, repo } = openSession([first, second, other], {
    startPane: 'files',
  });
  session.dispatch('next');
  session.dispatch('add');
  assert.equal(repo.added.length, 2);
  assert.equal(repo.added[0].file.newPath, 'a.js');
  assert.equal(repo.added[1].file.newPath, 'a.js');
  assert.equal(session.items[0].origin, 'staged');
  assert.equal(session.items[1].origin, 'staged');
  assert.equal(session.items[2].origin, 'unstaged');
  assert.equal(session.fileCursor, 2);
  session.dispatch('prev');
  session.dispatch('unstage');
  assert.equal(repo.unstageCalls.length, 2);
  assert.equal(session.items[0].origin, 'unstaged');
  assert.equal(session.items[1].origin, 'unstaged');
  assert.equal(session.fileCursor, 2);
  session.dispatch('prev');
  session.dispatch('revert');
  assert.equal(repo.reverted.length, 2);
  assert.equal(repo.reverted[0].file.newPath, 'a.js');
  assert.equal(repo.reverted[1].file.newPath, 'a.js');
  assert.equal(session.fileCursor, 1);
  assert.equal(session.fileList()[1].path, 'b.js');
});

test('files pane disables mode and feedback', () => {
  const { session } = openSession([sampleItem('a.js')], {
    startPane: 'files',
  });
  session.dispatch('layout');
  assert.equal(session.layout, 'unified');
  assert.equal(session.status, '');
  session.dispatch('feedback');
  assert.equal(session.mode, 'review');
  assert.equal(session.pane, 'files');
  session.dispatch('code');
  assert.equal(session.mode, 'review');
  assert.equal(session.notes.code.size, 0);
});

test('files pane todos row ignores add unstage drop', () => {
  const { session } = openSession([sampleItem('a.js')], {
    startPane: 'files',
  });
  assert.equal(session.fileCursor, 0);
  assert.equal(session.fileList()[0].kind, 'todos');
  session.dispatch('add');
  session.dispatch('unstage');
  session.dispatch('revert');
  assert.equal(session.status, '');
  assert.equal(session.pane, 'files');
  assert.equal(session.fileCursor, 0);
  session.dispatch('next');
  session.dispatch('add');
  assert.equal(session.status, 'staged');
});

test('reload picks up disk changes and keeps the current hunk', () => {
  const a = sampleItem('a.js');
  const b = sampleItem('b.js');
  const c = sampleItem('c.js');
  const { session, repo } = openSession([a, b]);
  session.dispatch('next');
  assert.equal(session.current().file.newPath, 'b.js');
  session.notes.feedback.set('b.js:1:1:0', {
    file: 'b.js',
    oldStart: 1,
    newStart: 1,
    blockId: 0,
    text: 'keep me',
  });
  repo.load = () => ({ top: '/tmp', items: [a, b, c] });
  session.dispatch('reload');
  assert.equal(session.status, '');
  assert.equal(session.items.length, 2);
  session.handleEvent({ type: 'key', key: 'escape' });
  session.dispatch('reload');
  assert.equal(session.status, 'reloaded');
  assert.equal(session.pane, 'files');
  assert.equal(session.current().file.newPath, 'b.js');
  assert.equal(session.items.length, 3);
  assert.equal(session.notes.feedback.get('b.js:1:1:0').text, 'keep me');
});

test('reload brings back dismissed hunks', () => {
  const a = sampleItem('a.js');
  const b = sampleItem('b.js');
  const { session } = openSession([a, b], { startPane: 'files' });
  session.dismissed.add('unstaged:a.js:1:1:0');
  session.items = session.items.filter((item) => item.file.newPath !== 'a.js');
  session.index = 0;
  assert.equal(session.current().file.newPath, 'b.js');
  session.dispatch('reload');
  assert.equal(session.status, 'reloaded');
  assert.equal(session.dismissed.size, 0);
  assert.equal(session.items.length, 2);
  assert.equal(session.current().file.newPath, 'b.js');
});

test('reload from the file list still refreshes', () => {
  const a = sampleItem('a.js');
  const b = sampleItem('b.js');
  const { session, repo } = openSession([a], { startPane: 'files' });
  repo.load = () => ({ top: '/tmp', items: [a, b] });
  session.handleEvent({ type: 'key', key: 'r' });
  assert.equal(session.status, 'reloaded');
  assert.equal(session.pane, 'files');
  assert.equal(session.items.length, 2);
});

test('compose r inserts a letter and does not reload', () => {
  const a = sampleItem('a.js');
  const { session, repo } = openSession([a]);
  let loads = 0;
  const orig = repo.load;
  repo.load = (...args) => {
    loads += 1;
    return orig(...args);
  };
  session.dispatch('feedback');
  session.handleEvent({ type: 'key', key: 'r' });
  assert.equal(session.mode, 'compose');
  assert.equal(session.editor.text, 'r');
  assert.equal(loads, 0);
});

test('files pane add on a staged file still moves down', () => {
  const item = sampleItem('a.js', 'staged');
  const next = sampleItem('b.js');
  const { session, repo } = openSession([item, next], { startPane: 'files' });
  session.dispatch('next');
  session.dispatch('add');
  assert.equal(session.status, 'already staged');
  assert.equal(repo.added.length, 0);
  assert.equal(session.fileCursor, 2);
  assert.equal(session.fileList()[2].path, 'b.js');
});

test('files pane unstage on an unstaged file still moves down', () => {
  const { session, repo } = openSession(
    [sampleItem('a.js'), sampleItem('b.js')],
    { startPane: 'files' },
  );
  session.dispatch('next');
  session.dispatch('unstage');
  assert.equal(session.status, 'not staged');
  assert.equal(repo.unstageCalls.length, 0);
  assert.equal(session.fileCursor, 2);
  assert.equal(session.fileList()[2].path, 'b.js');
});

test('f maps feedback to the hunk location', () => {
  const item = sampleItem('a.js');
  const { session } = openSession([item]);
  session.dispatch('feedback');
  assert.equal(session.mode, 'compose');
  assert.equal(session.composeKind, 'feedback');
  session.pushInput('extract helper');
  session.handleEvent({ type: 'key', key: 'ctrl-s' });
  assert.equal(session.mode, 'review');
  const note = session.notes.feedback.get('a.js:1:1:0');
  assert.equal(note.text, 'extract helper');
  assert.equal(note.file, 'a.js');
  assert.equal(note.newStart, 1);
  assert.equal(session.counts().feedback, 1);
  assert.equal(session.counts().todo, 0);
  assert.equal(session.idleNoteText(), '[ ] extract helper');
});

test('compose arrows move by visual wrap rows', () => {
  const item = sampleItem('a.js');
  const { session } = openSession([item], {
    getSize: () => ({ width: 10, height: 16 }),
  });
  session.dispatch('feedback');
  session.pushInput('hello world');
  session.handleEvent({ type: 'key', key: 'up' });
  assert.equal(session.editor.cursor, 5);
  session.handleEvent({ type: 'key', key: 'down' });
  assert.equal(session.editor.cursor, 11);
});

test('compose cursor blinks by hiding and showing', () => {
  const item = sampleItem('a.js');
  const { session, stdout } = openSession([item]);
  session.dispatch('feedback');
  session.draw();
  const on = stdout.dump();
  assert.ok(on.includes('[1 q'));
  assert.ok(on.includes('[?12h'));
  assert.ok(on.includes('[?25h'));
  session.tickBlink();
  const hidden = stdout.dump().slice(on.length);
  assert.ok(hidden.includes('[?25l'));
  assert.ok(!hidden.includes('[?2026h'));
  session.tickBlink();
  const shown = stdout.dump().slice(on.length + hidden.length);
  assert.ok(shown.includes('[?25h'));
  assert.ok(!shown.includes('[?2026h'));
});

test('enter and escape save feedback and return to browse', () => {
  const item = sampleItem('a.js');
  const { session } = openSession([item]);
  session.dispatch('feedback');
  session.pushInput('note');
  session.handleEvent({ type: 'key', key: 'enter' });
  assert.equal(session.mode, 'review');
  assert.equal(session.done, false);
  const key = 'a.js:1:1:0';
  assert.equal(session.notes.feedback.get(key).text, 'note');
  session.dispatch('feedback');
  session.pushInput(' two');
  session.handleEvent({ type: 'key', key: 'escape' });
  assert.equal(session.mode, 'review');
  assert.equal(session.done, false);
  assert.equal(session.notes.feedback.get(key).text, 'note two');
  assert.equal(session.status, 'saved');
});

test('editing feedback keeps one latest version', () => {
  const item = sampleItem('a.js');
  const { session } = openSession([item]);
  session.dispatch('feedback');
  session.pushInput('first');
  session.handleEvent({ type: 'key', key: 'ctrl-s' });
  session.dispatch('feedback');
  session.pushInput(' more');
  session.autosave();
  session.handleEvent({ type: 'key', key: 'ctrl-s' });
  const key = 'a.js:1:1:0';
  assert.equal(session.notes.feedback.size, 1);
  assert.equal(session.notes.feedback.get(key).text, 'first more');
  session.dispatch('feedback');
  assert.equal(session.editor.text, 'first more');
  const view = session.view();
  assert.equal(view.compose.text, 'first more');
  assert.ok(!view.compose.text.includes('\n1 '));
});

test('feedback templates count reuse on another hunk not a re-save', () => {
  const a = sampleItem('a.js');
  const b = sampleItem('b.js');
  const { session } = openSession([a, b]);
  session.dispatch('feedback');
  session.pushInput('extract helper');
  session.handleEvent({ type: 'key', key: 'ctrl-s' });
  session.dispatch('feedback');
  session.handleEvent({ type: 'key', key: 'ctrl-s' });
  assert.equal(session.notes.templates.length, 1);
  assert.equal(session.notes.templates[0].count, 1);
  session.dispatch('next');
  session.dispatch('feedback');
  session.pushInput('extract helper');
  session.handleEvent({ type: 'key', key: 'ctrl-s' });
  assert.equal(session.notes.templates.length, 1);
  assert.equal(session.notes.templates[0].text, 'extract helper');
  assert.equal(session.notes.templates[0].count, 2);
});

test('feedback templates are picked with tab arrows enter and click', () => {
  const { session } = openSession([sampleItem('a.js'), sampleItem('b.js')]);
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
  session.handleEvent({ type: 'key', key: 'tab' });
  assert.equal(session.mode, 'review');
  assert.equal(session.notes.feedback.get(feedKey).text, 'extract helper');
  session.dispatch('feedback');
  session.editor.replace('');
  session.handleEvent({ type: 'key', key: 'down' });
  assert.equal(session.mode, 'compose');
  assert.equal(session.templateFocus, true);
  assert.equal(session.templateIndex, 0);
  session.handleEvent({ type: 'key', key: 'enter' });
  assert.equal(session.mode, 'review');
  assert.equal(session.notes.feedback.get(feedKey).text, 'extract helper');
  session.dispatch('feedback');
  session.editor.replace('');
  session.draw();
  const hit = session.lastFrame.templateHits.find((row) => row.cursor === 1);
  assert.ok(hit);
  session.handleEvent({
    type: 'mouse',
    kind: 'press',
    btn: 0,
    button: 0,
    x: 2,
    y: hit.y,
    press: true,
  });
  session.handleEvent({
    type: 'mouse',
    kind: 'release',
    btn: 0,
    button: 0,
    x: 2,
    y: hit.y,
    press: false,
  });
  assert.equal(session.mode, 'review');
  assert.equal(session.notes.feedback.get(feedKey).text, 'add tests');
});

test('feedback templates filter by prefix and hide if none match', () => {
  const { session } = openSession([sampleItem('a.js')]);
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
  session.handleEvent({ type: 'key', key: 'tab' });
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
  session.handleEvent({ type: 'key', key: 'tab' });
  assert.equal(session.editor.text, 'z');
  session.handleEvent({ type: 'key', key: 'backspace' });
  session.draw();
  body = stripAnsi(session.lastFrame.rows.join('\n'));
  assert.match(body, /extract helper/);
  assert.match(body, /add tests/);
});

test('exact template text hides the template list', () => {
  const { session } = openSession([sampleItem('a.js')]);
  session.notes.templates = [
    { text: 'extract helper', count: 2 },
    { text: 'add tests', count: 1 },
  ];
  session.dispatch('feedback');
  session.pushInput('extract helper');
  session.draw();
  const body = stripAnsi(session.lastFrame.rows.join('\n'));
  assert.match(body, /extract helper/);
  assert.ok(!body.includes('add tests'));
  assert.equal(session.lastFrame.templateHits.length, 0);
  assert.deepEqual(session.shownTemplates(), []);
});

test('existing unique feedback hides the template list', () => {
  const { session } = openSession([sampleItem('a.js')]);
  session.notes.templates = [
    { text: 'extract helper', count: 2 },
    { text: 'add tests', count: 1 },
  ];
  session.notes.feedback.set('a.js:1:1:0', {
    file: 'a.js',
    oldStart: 1,
    newStart: 1,
    blockId: 0,
    text: 'unique note',
  });
  session.dispatch('feedback');
  session.draw();
  const body = stripAnsi(session.lastFrame.rows.join('\n'));
  assert.match(body, /unique note/);
  assert.ok(!body.includes('extract helper'));
  assert.ok(!body.includes('add tests'));
  assert.equal(session.lastFrame.templateHits.length, 0);
});

test('e edits added lines in place as a code proposal', () => {
  const item = sampleItem('a.js');
  const { session } = openSession([item]);
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
  session.handleEvent({ type: 'key', key: 'enter' });
  assert.equal(session.mode, 'compose');
  assert.equal(session.editor.text, 'b2\n');
  session.handleEvent({ type: 'key', key: 'escape' });
  assert.equal(session.mode, 'review');
  const note = session.notes.code.get('a.js:1:1:0');
  assert.equal(note.text, 'b2\n');
  assert.equal(session.counts().code, 1);
  session.draw();
  const saved = stripAnsi(session.lastFrame.rows.join('\n'));
  assert.match(saved, /\+ b2/);
});

test('code save equal to original drops the proposal', () => {
  const item = sampleItem('a.js');
  const { session } = openSession([item]);
  session.dispatch('code');
  session.handleEvent({ type: 'key', key: 'escape' });
  assert.equal(session.notes.code.size, 0);
  assert.equal(session.counts().code, 0);
});

test('todos screen ignores commit and todo hotkeys', () => {
  const { session } = openSession([sampleItem('a.js')]);
  session.dispatch('todo');
  session.handleEvent({ type: 'key', key: 'escape' });
  assert.equal(session.todoOpen, true);
  assert.equal(session.mode, 'review');
  session.dispatch('commit');
  assert.equal(session.mode, 'review');
  session.dispatch('todo');
  assert.equal(session.mode, 'review');
});

test('todo edits in the list not the note line', () => {
  const { session } = openSession([sampleItem('a.js')]);
  session.dispatch('todo');
  session.pushInput('in the list');
  session.draw();
  const body = stripAnsi(session.lastFrame.rows.join('\n'));
  assert.match(body, /\[ \] in the list/);
  assert.equal(body.split('in the list').length - 1, 1);
  assert.equal(session.view().compose, null);
  assert.ok(session.view().todoEdit);
  const hit = session.lastFrame.todoHits.find((row) => row.cursor === 0);
  assert.ok(hit);
  assert.equal(session.lastFrame.cursor.y, hit.y);
});

test('t from any file adds a repo todo and starts editing', () => {
  const { session } = openSession([sampleItem('a.js'), sampleItem('b.js')], {
    startPane: 'files',
  });
  session.dispatch('scrollDown');
  assert.equal(session.fileCursor, 1);
  session.dispatch('todo');
  assert.equal(session.pane, 'diff');
  assert.equal(session.current().origin, 'todo');
  assert.equal(session.current().file.newPath, 'TODOs');
  assert.equal(session.mode, 'compose');
  assert.equal(session.composeKind, 'todo');
  assert.equal(session.todoFocus, 0);
  assert.deepEqual(session.view().todos, ['[ ] ']);
  session.handleEvent({ type: 'key', key: 'escape' });
  session.dispatch('files');
  session.fileCursor = 0;
  session.dispatch('todo');
  assert.equal(session.current().file.newPath, 'TODOs');
  assert.equal(session.mode, 'compose');
  assert.equal(session.editor.text, '');
});

test('t opens the repo todo page and lets you edit it', () => {
  const a = sampleItem('a.js');
  const b = sampleItem('b.js');
  const { session } = openSession([a, b]);
  const files = session.fileList();
  assert.equal(files[0].kind, 'todos');
  assert.equal(files[0].path, 'Repository TODOs and Issues');
  assert.equal(files[0].remaining, 0);
  assert.equal(files[0].staged, 0);
  session.dispatch('todo');
  assert.equal(session.current().origin, 'todo');
  assert.equal(session.current().file.newPath, 'TODOs');
  assert.equal(session.mode, 'compose');
  assert.equal(session.items[0].origin, 'unstaged');
  session.pushInput('rewrite loop');
  session.handleEvent({ type: 'key', key: 'ctrl-s' });
  assert.equal(session.items[0].file.newPath, 'a.js');
  assert.equal(session.items[1].file.newPath, 'b.js');
  assert.equal(session.current().origin, 'todo');
  assert.deepEqual(session.view().todos, ['[ ] rewrite loop', '[ ] ']);
  assert.equal(session.view().total, 2);
  assert.equal(session.counts().todo, 1);
  assert.equal(session.counts().feedback, 0);
  assert.equal(session.fileList()[0].remaining, 1);
  assert.equal(session.fileList()[0].staged, 0);
  assert.equal(session.todoFocus, 0);
  session.handleEvent({ type: 'key', key: 'enter' });
  assert.equal(session.mode, 'compose');
  assert.equal(session.editor.text, 'rewrite loop');
  session.handleEvent({ type: 'key', key: 'escape' });
  assert.equal(session.mode, 'review');
  assert.equal(session.todoFocus, 0);
  session.dispatch('next');
  assert.equal(session.current().origin, 'unstaged');
  assert.equal(session.current().file.newPath, 'a.js');
  assert.equal(session.idleNoteText(), '');
  session.dispatch('todo');
  assert.equal(session.current().origin, 'todo');
  assert.equal(session.mode, 'compose');
  assert.equal(session.editor.text, '');
  assert.deepEqual(session.view().todos, ['[ ] rewrite loop', '[ ] ']);
  assert.equal(session.todoFocus, 1);
  session.pushInput('add tests');
  session.handleEvent({ type: 'key', key: 'ctrl-s' });
  assert.equal(session.todoOpen, true);
  assert.deepEqual(session.view().todos, [
    '[ ] rewrite loop',
    '[ ] add tests',
    '[ ] ',
  ]);
  assert.equal(session.todoFocus, 1);
  session.dispatch('next');
  assert.equal(session.current().origin, 'unstaged');
  assert.equal(session.current().file.newPath, 'a.js');
  session.dispatch('next');
  assert.equal(session.current().file.newPath, 'b.js');
  assert.equal(session.idleNoteText(), '');
  session.dispatch('prev');
  session.dispatch('prev');
  assert.equal(session.current().origin, 'todo');
});

test('todo list keeps a blank row to start a new item', () => {
  const { session } = openSession([sampleItem('a.js')]);
  session.dispatch('todo');
  session.pushInput('first note');
  session.handleEvent({ type: 'key', key: 'ctrl-s' });
  assert.equal(session.mode, 'review');
  assert.deepEqual(session.view().todos, ['[ ] first note', '[ ] ']);
  session.dispatch('scrollDown');
  assert.equal(session.todoFocus, 1);
  session.handleEvent({ type: 'key', key: 'enter' });
  assert.equal(session.mode, 'compose');
  assert.equal(session.composeTodoId, null);
  assert.equal(session.editor.text, '');
  session.handleEvent({ type: 'key', key: 'escape' });
  session.draw();
  const draft = session.lastFrame.todoHits.find((row) => row.cursor === 1);
  assert.ok(draft);
  session.handleEvent({
    type: 'mouse',
    kind: 'press',
    btn: 0,
    button: 0,
    x: 2,
    y: draft.y,
    press: true,
  });
  session.handleEvent({
    type: 'mouse',
    kind: 'release',
    btn: 0,
    button: 0,
    x: 2,
    y: draft.y,
    press: false,
  });
  assert.equal(session.todoFocus, 1);
  assert.equal(session.mode, 'compose');
  assert.equal(session.composeTodoId, null);
  session.pushInput('second note');
  session.handleEvent({ type: 'key', key: 'enter' });
  assert.deepEqual(session.view().todos, [
    '[ ] first note',
    '[ ] second note',
    '[ ] ',
  ]);
  assert.equal(session.mode, 'compose');
  assert.equal(session.todoFocus, 2);
  assert.equal(session.editor.text, '');
});

test('enter and click edit the focused todo', () => {
  const { session } = openSession([sampleItem('a.js')]);
  session.dispatch('todo');
  session.pushInput('first note');
  session.handleEvent({ type: 'key', key: 'ctrl-s' });
  session.startDraftCompose();
  session.pushInput('second note');
  session.handleEvent({ type: 'key', key: 'ctrl-s' });
  assert.equal(session.mode, 'review');
  assert.equal(session.todoFocus, 1);
  session.handleEvent({ type: 'key', key: 'enter' });
  assert.equal(session.mode, 'compose');
  assert.equal(session.editor.text, 'second note');
  session.handleEvent({ type: 'key', key: 'escape' });
  session.dispatch('scrollUp');
  assert.equal(session.todoFocus, 0);
  session.draw();
  const hit = session.lastFrame.todoHits.find((row) => row.cursor === 0);
  assert.ok(hit);
  session.handleEvent({
    type: 'mouse',
    kind: 'press',
    btn: 0,
    button: 0,
    x: 2,
    y: hit.y,
    press: true,
  });
  session.handleEvent({
    type: 'mouse',
    kind: 'release',
    btn: 0,
    button: 0,
    x: 2,
    y: hit.y,
    press: false,
  });
  assert.equal(session.todoFocus, 0);
  assert.equal(session.mode, 'compose');
  assert.equal(session.editor.text, 'first note');
  session.handleEvent({ type: 'key', key: 'escape' });
  session.draw();
  const other = session.lastFrame.todoHits.find((row) => row.cursor === 1);
  assert.ok(other);
  session.handleEvent({
    type: 'mouse',
    kind: 'press',
    btn: 0,
    button: 0,
    x: 2,
    y: other.y,
    press: true,
  });
  session.handleEvent({
    type: 'mouse',
    kind: 'release',
    btn: 0,
    button: 0,
    x: 2,
    y: other.y,
    press: false,
  });
  assert.equal(session.todoFocus, 1);
  assert.equal(session.mode, 'compose');
  assert.equal(session.editor.text, 'second note');
});

test('todo list stays on screen while composing', () => {
  const { session } = openSession([sampleItem('a.js')]);
  session.dispatch('todo');
  session.pushInput('first note');
  session.handleEvent({ type: 'key', key: 'ctrl-s' });
  session.startDraftCompose();
  session.pushInput('draft two');
  assert.equal(session.mode, 'compose');
  session.draw();
  const body = stripAnsi(session.lastFrame.rows.join('\n'));
  assert.match(body, /\[ \] first note/);
  const hit = session.lastFrame.todoHits.find((row) => row.cursor === 0);
  assert.ok(hit);
  session.handleEvent({
    type: 'mouse',
    kind: 'press',
    btn: 0,
    button: 0,
    x: 2,
    y: hit.y,
    press: true,
  });
  session.handleEvent({
    type: 'mouse',
    kind: 'release',
    btn: 0,
    button: 0,
    x: 2,
    y: hit.y,
    press: false,
  });
  assert.equal(session.mode, 'compose');
  assert.equal(session.editor.text, 'first note');
  assert.equal(session.notes.todos.length, 2);
  assert.equal(session.notes.todos[1].text, 'draft two');
});

test('delete and backspace remove the selected todo', () => {
  const { session } = openSession([sampleItem('a.js')]);
  session.dispatch('todo');
  session.pushInput('first note');
  session.handleEvent({ type: 'key', key: 'ctrl-s' });
  session.startDraftCompose();
  session.pushInput('second note');
  session.handleEvent({ type: 'key', key: 'ctrl-s' });
  assert.equal(session.mode, 'review');
  assert.equal(session.todoFocus, 1);
  session.handleEvent({ type: 'key', key: 'delete' });
  assert.deepEqual(session.view().todos, ['[ ] first note', '[ ] ']);
  assert.equal(session.todoFocus, 0);
  assert.equal(session.current().origin, 'todo');
  session.handleEvent({ type: 'key', key: 'backspace' });
  assert.deepEqual(session.view().todos, ['[ ] ']);
  assert.equal(session.current().origin, 'todo');
});

test('empty autosave does not persist a draft todo', () => {
  const { session } = openSession([sampleItem('a.js')]);
  session.dispatch('todo');
  assert.equal(session.composeTodoId, null);
  session.autosave();
  assert.equal(session.notes.todos.length, 0);
  session.pushInput('keep this');
  session.handleEvent({ type: 'key', key: 'enter' });
  assert.equal(session.mode, 'compose');
  assert.equal(session.editor.text, '');
  assert.equal(session.todoFocus, 1);
  assert.equal(session.notes.todos[0].text, 'keep this');
  assert.equal(session.current().origin, 'todo');
});

test('todo autosave updates one draft instead of duplicating', () => {
  const { session } = openSession([sampleItem('a.js')]);
  session.dispatch('todo');
  session.pushInput('keep this');
  session.autosave();
  assert.equal(session.notes.todos.length, 1);
  assert.equal(session.composeTodoId, session.notes.todos[0].id);
  session.autosave();
  assert.equal(session.notes.todos.length, 1);
  session.pushInput(' more');
  session.autosave();
  assert.equal(session.notes.todos.length, 1);
  assert.equal(session.notes.todos[0].text, 'keep this more');
  session.handleEvent({ type: 'key', key: 'enter' });
  assert.equal(session.mode, 'compose');
  assert.equal(session.editor.text, '');
  assert.equal(session.todoFocus, 1);
  assert.deepEqual(session.view().todos, ['[ ] keep this more', '[ ] ']);
});

test('typing a todo starts editing at the end of the line', () => {
  const { session } = openSession([sampleItem('a.js')]);
  session.dispatch('todo');
  session.pushInput('first');
  session.handleEvent({ type: 'key', key: 'escape' });
  assert.equal(session.mode, 'review');
  assert.equal(session.todoFocus, 0);
  session.pushInput(' more');
  assert.equal(session.mode, 'compose');
  assert.equal(session.editor.text, 'first more');
  assert.equal(session.editor.cursor, 'first more'.length);
});

test('todo edit arrows move across todos without leaving edit', () => {
  const { session } = openSession([sampleItem('a.js')]);
  session.dispatch('todo');
  session.pushInput('first');
  session.handleEvent({ type: 'key', key: 'enter' });
  session.pushInput('second');
  session.handleEvent({ type: 'key', key: 'up' });
  assert.equal(session.mode, 'compose');
  assert.equal(session.todoFocus, 0);
  assert.equal(session.editor.text, 'first');
  assert.equal(session.editor.cursor, 'first'.length);
  session.handleEvent({ type: 'key', key: 'up' });
  assert.equal(session.mode, 'compose');
  assert.equal(session.todoFocus, 0);
  session.handleEvent({ type: 'key', key: 'down' });
  assert.equal(session.mode, 'compose');
  assert.equal(session.todoFocus, 1);
  assert.equal(session.editor.text, 'second');
  session.handleEvent({ type: 'key', key: 'down' });
  assert.equal(session.mode, 'compose');
  assert.equal(session.todoFocus, 2);
  assert.equal(session.editor.text, '');
  session.handleEvent({ type: 'key', key: 'down' });
  assert.equal(session.mode, 'compose');
  assert.equal(session.todoFocus, 2);
  assert.deepEqual(session.view().todos, ['[ ] first', '[ ] second', '[ ] ']);
});

test('enter edits the next todo and escape stays on it', () => {
  const { session } = openSession([sampleItem('a.js')]);
  session.dispatch('todo');
  session.pushInput('first');
  session.handleEvent({ type: 'key', key: 'enter' });
  assert.equal(session.mode, 'compose');
  assert.equal(session.todoFocus, 1);
  assert.equal(session.editor.text, '');
  session.pushInput('second');
  session.handleEvent({ type: 'key', key: 'escape' });
  assert.equal(session.mode, 'review');
  assert.equal(session.todoFocus, 1);
  assert.deepEqual(session.view().todos, ['[ ] first', '[ ] second', '[ ] ']);
});

test('todo save recovers if the stub was dropped', () => {
  const { session } = openSession([sampleItem('a.js')]);
  session.dispatch('todo');
  session.notes.todos = [];
  session.pushInput('still here');
  session.handleEvent({ type: 'key', key: 'escape' });
  assert.equal(session.notes.todos.length, 1);
  assert.equal(session.notes.todos[0].text, 'still here');
  assert.equal(session.current().origin, 'todo');
});

test('quit with notes asks f to finish or c to continue', () => {
  const writes = [];
  const item = sampleItem('a.js');
  const { session } = openSession([item], {
    writeFileSync: (file, body) => writes.push({ file, body }),
    mkdirSync: () => {},
  });
  session.dispatch('feedback');
  session.pushInput('nits');
  session.handleEvent({ type: 'key', key: 'ctrl-s' });
  session.dispatch('quit');
  assert.equal(session.done, false);
  assert.equal(session.mode, 'confirmQuit');
  session.handleEvent({ type: 'key', key: 'escape' });
  assert.equal(session.done, false);
  assert.equal(session.mode, 'review');
  session.dispatch('quit');
  session.pushInput('f');
  assert.equal(session.done, true);
  assert.ok(writes.some((entry) => entry.file.endsWith('2026-09-07-00.md')));
  const mdWrites = writes.filter((entry) => entry.file.endsWith('.md'));
  assert.match(mdWrites[0].body, /status: editing/);
  const last = mdWrites[mdWrites.length - 1];
  assert.match(last.body, /nits/);
  assert.match(last.body, /status: ready/);
});

test('quit continue keeps editing so the next run can resume', () => {
  const writes = [];
  const item = sampleItem('a.js');
  const { session } = openSession([item], {
    writeFileSync: (file, body) => writes.push({ file, body }),
    mkdirSync: () => {},
  });
  session.dispatch('feedback');
  session.pushInput('nits');
  session.handleEvent({ type: 'key', key: 'ctrl-s' });
  session.dispatch('quit');
  session.pushInput('c');
  assert.equal(session.done, true);
  assert.equal(session.notes.status, 'editing');
  const mdWrites = writes.filter((entry) => entry.file.endsWith('.md'));
  const last = mdWrites[mdWrites.length - 1];
  assert.match(last.body, /status: editing/);
  assert.match(last.body, /nits/);
});

test('initReview resumes latest editing file', () => {
  const draft = createStore(reviewFile('2026-09-07-00.md'));
  addTodo(draft, 'a.js', 'rewrite loop');
  const md = serializeReview(draft);
  const a = sampleItem('a.js');
  const { session } = openSession([a], {
    readdirSync: () => ['2026-09-07-00.md'],
    readFileSync: reviewReader(md),
  });
  assert.equal(session.notes.reviewPath, reviewFile('2026-09-07-00.md'));
  assert.equal(session.notes.status, 'editing');
  assert.equal(session.notes.todos[0].text, 'rewrite loop');
  assert.equal(
    session.fileList().some((entry) => entry.kind === 'todos'),
    true,
  );
});

test('initReview starts a new file when latest is ready', () => {
  const draft = createStore(reviewFile('2026-09-07-00.md'));
  draft.status = 'ready';
  addTodo(draft, 'a.js', 'rewrite loop');
  const md = serializeReview(draft);
  const { session } = openSession([sampleItem('a.js')], {
    readdirSync: () => ['2026-09-07-00.md'],
    readFileSync: reviewReader(md),
  });
  assert.equal(session.notes.reviewPath, reviewFile('2026-09-07-01.md'));
  assert.equal(session.notes.todos.length, 0);
});

test('newReview starts a new file even if latest is editing', () => {
  const draft = createStore(reviewFile('2026-09-07-00.md'));
  addTodo(draft, 'a.js', 'rewrite loop');
  const md = serializeReview(draft);
  const { session } = openSession([sampleItem('a.js')], {
    newReview: true,
    readdirSync: () => ['2026-09-07-00.md'],
    readFileSync: reviewReader(md),
  });
  assert.equal(session.notes.reviewPath, reviewFile('2026-09-07-01.md'));
  assert.equal(session.notes.todos.length, 0);
});

test('c asks commit amend or fixup then commits the message', () => {
  const { session, repo } = openSession([sampleItem('a.js', 'staged')], {
    startPane: 'files',
  });
  session.pushInput('c');
  assert.equal(session.mode, 'confirmCommit');
  session.handleEvent({ type: 'key', key: 'escape' });
  assert.equal(session.mode, 'review');
  assert.equal(repo.commits.length, 0);
  session.pushInput('c');
  session.pushInput('c');
  assert.equal(session.mode, 'compose');
  assert.equal(session.composeKind, 'commit');
  assert.equal(session.commitKind, 'commit');
  session.handleEvent({ type: 'key', key: 'enter' });
  assert.equal(session.mode, 'compose');
  assert.equal(session.status, 'empty commit message');
  assert.equal(repo.commits.length, 0);
  session.pushInput('land the change');
  session.handleEvent({ type: 'key', key: 'enter' });
  assert.equal(session.mode, 'review');
  assert.equal(session.status, 'committed');
  assert.equal(repo.commits.length, 1);
  assert.equal(repo.commits[0].kind, 'commit');
  assert.equal(repo.commits[0].message, 'land the change');
});

test('c then a amends with the previous message', () => {
  const { session, repo } = openSession([sampleItem('a.js')], {
    startPane: 'files',
  });
  session.pushInput('c');
  session.pushInput('a');
  assert.equal(session.composeKind, 'commit');
  assert.equal(session.commitKind, 'amend');
  assert.equal(session.editor.text, 'previous message');
  session.handleEvent({ type: 'key', key: 'enter' });
  assert.equal(session.status, 'amended');
  assert.equal(repo.commits[0].kind, 'amend');
  assert.equal(repo.commits[0].message, 'previous message');
});

test('c then f fixups HEAD', () => {
  const { session, repo } = openSession([sampleItem('a.js', 'staged')], {
    startPane: 'files',
  });
  session.pushInput('c');
  session.pushInput('f');
  assert.equal(session.editor.text, 'HEAD');
  session.handleEvent({ type: 'key', key: 'enter' });
  assert.equal(session.status, 'fixup');
  assert.equal(repo.commits[0].kind, 'fixup');
  assert.equal(repo.commits[0].message, 'HEAD');
});

test('escape from commit message does not run git', () => {
  const { session, repo } = openSession([sampleItem('a.js', 'staged')], {
    startPane: 'files',
  });
  session.pushInput('c');
  session.pushInput('c');
  session.pushInput('draft');
  session.handleEvent({ type: 'key', key: 'escape' });
  assert.equal(session.mode, 'review');
  assert.equal(repo.commits.length, 0);
});

test('compose c inserts a letter and does not open commit', () => {
  const { session, repo } = openSession([sampleItem('a.js')]);
  session.dispatch('feedback');
  session.pushInput('c');
  assert.equal(session.mode, 'compose');
  assert.equal(session.composeKind, 'feedback');
  assert.equal(session.editor.text, 'c');
  assert.equal(repo.commits.length, 0);
});

test('files pane c still opens commit', () => {
  const { session } = openSession([sampleItem('a.js', 'staged')], {
    startPane: 'files',
  });
  session.pushInput('c');
  assert.equal(session.mode, 'confirmCommit');
  session.pushInput('c');
  assert.equal(session.mode, 'compose');
  assert.equal(session.composeKind, 'commit');
});

test('diff pane c does not open commit', () => {
  const { session } = openSession([sampleItem('a.js', 'staged')]);
  session.pushInput('c');
  assert.equal(session.mode, 'review');
  assert.equal(session.pane, 'diff');
});

test('c skips commit when nothing is staged', () => {
  const { session, repo } = openSession([sampleItem('a.js')], {
    startPane: 'files',
  });
  session.pushInput('c');
  assert.equal(session.mode, 'confirmCommit');
  session.pushInput('c');
  assert.equal(session.mode, 'review');
  assert.equal(session.status, 'nothing to commit');
  assert.equal(repo.commits.length, 0);
  session.pushInput('c');
  session.pushInput('f');
  assert.equal(session.mode, 'review');
  assert.equal(session.status, 'nothing to commit');
  assert.equal(repo.commits.length, 0);
});

test('quit without notes does not write a review file', () => {
  const writes = [];
  const item = sampleItem('a.js');
  const { session } = openSession([item], {
    writeFileSync: (file, body) => writes.push({ file, body }),
    mkdirSync: () => {},
  });
  session.dispatch('quit');
  assert.equal(session.done, true);
  assert.equal(writes.length, 0);
});

test('load applies imported GitHub notes on a new review', () => {
  const item = sampleItem('lib/parser.js', 'pr');
  const imported = {
    feedback: [
      {
        file: 'lib/parser.js',
        oldStart: 1,
        newStart: 1,
        blockId: 0,
        origin: 'pr',
        header: '@@ -1,1 +1,1 @@',
        text: '@alice review at github: use const',
        done: false,
      },
    ],
    todos: [
      {
        file: 'pull request',
        text: '@bob review at github: add tests',
        done: false,
      },
    ],
  };
  const repo = {
    load: () => ({
      top: '/tmp',
      items: [item],
      imported,
      sourceLabel: '#123',
    }),
    add: () => {},
    unstage: () => {},
    revert: () => {},
  };
  const { session } = openSession([item], { repo });
  const notes = [...session.notes.feedback.values()];
  assert.equal(notes.length, 1);
  assert.match(notes[0].text, /use const/);
  assert.equal(session.notes.todos.length, 1);
  assert.equal(session.notes.todos[0].file, 'pull request');
  assert.equal(
    session.fileList().some((entry) => entry.kind === 'todos'),
    true,
  );
  session.load();
  assert.equal(session.notes.todos.length, 1);
});

test('load skips imported GitHub notes when resuming a review', () => {
  const draft = createStore('/tmp/.review/2026-09-07-00.md');
  addTodo(draft, 'a.js', 'rewrite loop');
  const md = serializeReview(draft);
  const item = sampleItem('lib/parser.js', 'pr');
  const imported = {
    feedback: [],
    todos: [{ file: 'pull request', text: 'from github', done: false }],
  };
  const { session } = openSession([item], {
    repo: {
      load: () => ({ top: '/tmp', items: [item], imported }),
      add: () => {},
      unstage: () => {},
      revert: () => {},
    },
    readdirSync: () => ['2026-09-07-00.md'],
    readFileSync: reviewReader(md),
  });
  assert.equal(session.notes.todos.length, 1);
  assert.equal(session.notes.todos[0].text, 'rewrite loop');
});

test('openLoad paints git items before npm extras arrive', async () => {
  const gitItem = sampleItem('a.js');
  const extraItem = sampleItem('package.json');
  extraItem.dep = { change: { name: 'lodash', section: 'dependencies' } };
  let extrasResolve;
  const extras = new Promise((resolve) => {
    extrasResolve = resolve;
  });
  let extrasStarted = false;
  const repo = {
    loadAsync: async () => ({
      top: '/tmp',
      items: [gitItem],
      parsed: [gitItem],
      pending: true,
    }),
    loadExtras: async () => {
      extrasStarted = true;
      await extras;
      return {
        top: '/tmp',
        items: [gitItem, extraItem],
        pending: false,
      };
    },
    load: () => ({ top: '/tmp', items: [gitItem] }),
    add: () => {},
    unstage: () => {},
    revert: () => {},
  };
  const stdout = sink();
  const session = new Session({
    repo,
    cwd: '/tmp',
    stdout,
    color: false,
    audit: true,
    startPane: 'files',
    getSize: () => ({ width: 80, height: 16 }),
    ...reviewFs,
  });
  session.uiOpen = true;
  const pending = session.openLoad();
  await new Promise((resolve, reject) => {
    const tick = (left) => {
      if (extrasStarted) {
        resolve();
        return;
      }
      if (left <= 0) {
        reject(new Error('extras did not start'));
        return;
      }
      setImmediate(() => tick(left - 1));
    };
    tick(50);
  });
  assert.equal(session.items.length, 1);
  assert.equal(session.items[0].file.newPath, 'a.js');
  assert.equal(session.busy, 'checking npm');
  session.dispatch('next');
  extrasResolve();
  await pending;
  assert.equal(session.items.length, 2);
  assert.equal(session.busy, '');
});

const memoryUpdateFs = () => {
  const files = new Map();
  return {
    cacheFile: '/tmp/reslop-cache/update.json',
    readFileSync: (file) => {
      if (!files.has(file)) {
        const error = new Error('ENOENT');
        error.code = 'ENOENT';
        throw error;
      }
      return files.get(file);
    },
    writeFileSync: (file, body) => {
      files.set(file, body);
    },
    mkdirSync: () => {},
    files,
  };
};

const openUpdating = (extra = {}) => {
  const cache = memoryUpdateFs();
  const installed = [];
  let fetchResolve;
  const fetchGate = extra.gateFetch
    ? new Promise((resolve) => {
        fetchResolve = resolve;
      })
    : null;
  const update = {
    enabled: true,
    current: extra.current ?? '0.1.5',
    now: extra.now ?? 1000,
    fetch:
      extra.fetch ??
      (async () => {
        if (fetchGate) await fetchGate;
        return {
          ok: true,
          json: async () => ({ version: extra.latest ?? '0.1.6' }),
        };
      }),
    install:
      extra.install ??
      (async (version) => {
        installed.push(version);
      }),
    ...cache,
  };
  const { session } = openSession([sampleItem('a.js'), sampleItem('b.js')], {
    startPane: 'files',
    update,
    ...extra.session,
  });
  session.uiOpen = true;
  return { session, installed, fetchResolve, cache, update };
};

test('update check does not block loading', async () => {
  const { session, fetchResolve, installed } = openUpdating({
    gateFetch: true,
    latest: '0.1.6',
  });
  const updateP = session.openUpdate();
  assert.equal(session.didLoad, true);
  assert.equal(session.items.length, 2);
  assert.equal(session.mode, 'review');
  assert.deepEqual(installed, []);
  fetchResolve();
  await updateP;
  assert.deepEqual(installed, ['0.1.6']);
});

test('patch update installs in the background', async () => {
  const { session, installed } = openUpdating({ latest: '0.1.6' });
  await session.openUpdate();
  assert.deepEqual(installed, ['0.1.6']);
  assert.equal(session.status, 'updated');
  assert.equal(session.mode, 'review');
});

test('major update asks y or n on the loaded status line', async () => {
  const { session, installed } = openUpdating({ latest: '1.0.0' });
  await session.openUpdate();
  session.draw();
  assert.equal(session.mode, 'confirmUpdate');
  assert.equal(session.updateFrom, '0.1.5');
  assert.equal(session.updateTo, '1.0.0');
  assert.deepEqual(installed, []);
  const text = session.lastFrame.text;
  assert.match(text, /update reslop 0\.1\.5 → 1\.0\.0\? y {2}n/);
  session.handleEvent({ type: 'key', key: 'n' });
  assert.equal(session.mode, 'review');
  assert.deepEqual(installed, []);
  session.handleEvent({ type: 'key', key: 'n' });
  assert.equal(session.fileCursor, 1);
});

test('major prompt waits until the UI has loaded', async () => {
  const cache = memoryUpdateFs();
  const session = new Session({
    cwd: '/tmp',
    stdout: sink(),
    color: false,
    getSize: () => ({ width: 80, height: 16 }),
    startPane: 'files',
    ...reviewFs,
    repo: mockRepo([sampleItem('a.js')]),
    update: {
      enabled: true,
      current: '0.1.5',
      now: 1000,
      fetch: async () => ({
        ok: true,
        json: async () => ({ version: '1.0.0' }),
      }),
      install: async () => {},
      ...cache,
    },
  });
  session.uiOpen = true;
  await session.openUpdate();
  assert.equal(session.updateOffer, true);
  assert.equal(session.didLoad, false);
  assert.equal(session.mode, 'review');
  session.didLoad = true;
  session.draw();
  assert.equal(session.mode, 'confirmUpdate');
});

test('major update y installs the new version', async () => {
  const { session, installed } = openUpdating({ latest: '1.0.0' });
  await session.openUpdate();
  session.draw();
  session.handleEvent({ type: 'key', key: 'y' });
  await session.installPromise;
  assert.deepEqual(installed, ['1.0.0']);
  assert.equal(session.status, 'updated');
  assert.equal(session.mode, 'review');
});

test('declined major update is not asked again from cache', async () => {
  const { session, cache, update } = openUpdating({ latest: '1.0.0' });
  await session.openUpdate();
  session.draw();
  session.handleEvent({ type: 'key', key: 'n' });
  let fetched = 0;
  const again = new Session({
    cwd: '/tmp',
    stdout: sink(),
    color: false,
    getSize: () => ({ width: 80, height: 16 }),
    startPane: 'files',
    ...reviewFs,
    repo: mockRepo([sampleItem('a.js')]),
    update: {
      ...update,
      fetch: async () => {
        fetched += 1;
        return { ok: true, json: async () => ({ version: '1.0.0' }) };
      },
    },
  });
  again.load();
  again.uiOpen = true;
  await again.openUpdate();
  again.draw();
  assert.equal(again.mode, 'review');
  assert.equal(fetched, 0);
  assert.ok(cache.files.has(cache.cacheFile));
});

test('declined major still auto-installs a later patch', async () => {
  const { session, installed, update } = openUpdating({ latest: '1.0.0' });
  await session.openUpdate();
  session.draw();
  session.handleEvent({ type: 'key', key: 'n' });
  const next = new Session({
    cwd: '/tmp',
    stdout: sink(),
    color: false,
    getSize: () => ({ width: 80, height: 16 }),
    startPane: 'files',
    ...reviewFs,
    repo: mockRepo([sampleItem('a.js')]),
    update: {
      ...update,
      now: 1000 + CHECK_INTERVAL_MS,
      fetch: async () => ({
        ok: true,
        json: async () => ({
          versions: { '0.1.5': {}, '0.1.6': {}, '1.0.0': {} },
        }),
      }),
    },
  });
  next.load();
  next.uiOpen = true;
  await next.openUpdate();
  assert.deepEqual(installed, ['0.1.6']);
  assert.equal(next.status, 'updated');
  assert.equal(next.mode, 'review');
});

test('declined major asks again when 1.0.1 appears', async () => {
  const { session, installed, update } = openUpdating({ latest: '1.0.0' });
  await session.openUpdate();
  session.draw();
  session.handleEvent({ type: 'key', key: 'n' });
  const next = new Session({
    cwd: '/tmp',
    stdout: sink(),
    color: false,
    getSize: () => ({ width: 80, height: 16 }),
    startPane: 'files',
    ...reviewFs,
    repo: mockRepo([sampleItem('a.js')]),
    update: {
      ...update,
      now: 1000 + CHECK_INTERVAL_MS,
      fetch: async () => ({
        ok: true,
        json: async () => ({
          versions: { '0.1.5': {}, '1.0.0': {}, '1.0.1': {} },
        }),
      }),
    },
  });
  next.load();
  next.uiOpen = true;
  await next.openUpdate();
  next.draw();
  assert.deepEqual(installed, []);
  assert.equal(next.mode, 'confirmUpdate');
  assert.equal(next.updateTo, '1.0.1');
});

test('click status branch opens the branch list', () => {
  const { session } = openSession([sampleItem('a.js')], { startPane: 'files' });
  session.draw();
  const hit = session.lastFrame.statusHits[0];
  assert.ok(hit);
  session.handleEvent({
    type: 'mouse',
    button: 0,
    btn: 0,
    kind: 'press',
    x: hit.x0 + 1,
    y: hit.y,
    press: true,
  });
  session.handleEvent({
    type: 'mouse',
    button: 0,
    btn: 0,
    kind: 'release',
    x: hit.x0 + 1,
    y: hit.y,
    press: false,
  });
  assert.equal(session.pane, 'branches');
});

test('files pane b lists branches and enter checks out', () => {
  const a = sampleItem('a.js');
  const b = sampleItem('b.js');
  const { session, repo } = openSession([a, b], { startPane: 'files' });
  assert.equal(session.branch, 'main');
  session.pushInput('b');
  assert.equal(session.pane, 'branches');
  assert.equal(session.branchCursor, 0);
  session.pushInput('j');
  assert.equal(session.branchCursor, 1);
  session.handleEvent({ type: 'key', key: 'enter' });
  assert.deepEqual(repo.checkouts, ['feat']);
  assert.equal(session.pane, 'files');
  assert.match(session.status, /checked out feat/);
});

test('files pane p pulls and s pushes', () => {
  const a = sampleItem('a.js');
  const b = sampleItem('b.js');
  const { session, repo } = openSession([a, b], { startPane: 'files' });
  session.pushInput('p');
  assert.equal(repo.pulls.length, 1);
  assert.equal(session.status, 'pulled');
  assert.equal(session.fileCursor, 0);
  session.pushInput('s');
  assert.equal(repo.pushes.length, 1);
  assert.equal(session.status, 'pushed');
});

test('rejected push asks f to force or escape to cancel', () => {
  const { session, repo } = openSession([sampleItem('a.js')], {
    startPane: 'files',
  });
  session.repo.push = (top, force) => {
    if (force) {
      repo.pushes.push(true);
      return;
    }
    const error = new Error('non-fast-forward');
    error.rejected = true;
    throw error;
  };
  session.pushInput('s');
  assert.equal(session.mode, 'confirmPush');
  assert.equal(repo.pushes.length, 0);
  session.pushInput('x');
  assert.equal(session.mode, 'confirmPush');
  session.handleEvent({ type: 'key', key: 'escape' });
  assert.equal(session.mode, 'review');
  assert.equal(repo.pushes.length, 0);
  session.pushInput('s');
  session.pushInput('f');
  assert.deepEqual(repo.pushes, [true]);
  assert.equal(session.mode, 'review');
  assert.equal(session.status, 'force pushed');
});

test('pull shows progress until git finishes', async () => {
  let finish;
  const pending = new Promise((resolve) => {
    finish = resolve;
  });
  const ticks = [];
  const { session, repo } = openSession([sampleItem('a.js')], {
    startPane: 'files',
    setInterval: (fn) => {
      ticks.push(fn);
      return ticks.length;
    },
    clearInterval: () => {},
  });
  session.repo.pullAsync = () => pending;
  session.pushInput('p');
  assert.equal(repo.pulls.length, 0);
  assert.equal(session.busy, 'pulling');
  assert.equal(session.viewStatus(), 'pulling');
  assert.equal(session.progressFrame, 0);
  ticks[0]();
  assert.equal(session.progressFrame, 1);
  session.pushInput('p');
  finish();
  await pending;
  await Promise.resolve();
  assert.equal(session.status, 'pulled');
  assert.equal(session.busy, '');
  assert.equal(session.gitBusy, false);
});

test('npm i shows progress until install finishes', async () => {
  let finish;
  const pending = new Promise((resolve) => {
    finish = resolve;
  });
  const ticks = [];
  const { session } = openSession([sampleItem('a.js')], {
    startPane: 'diff',
    setInterval: (fn) => {
      ticks.push(fn);
      return ticks.length;
    },
    clearInterval: () => {},
  });
  session.uiOpen = true;
  const item = session.current();
  item.reload = true;
  item.dep = {
    change: { propose: true, name: 'lodash' },
    files: ['package.json'],
  };
  session.repo.addAsync = () => pending;
  session.dispatch('add');
  assert.equal(session.busy, 'npm i');
  ticks[0]();
  assert.equal(session.progressFrame, 1);
  finish();
  await pending;
  await Promise.resolve();
  assert.equal(session.status, 'staged');
  assert.equal(session.busy, '');
});

test('openLoad shows progress while a remote change loads', async () => {
  let finish;
  const pending = new Promise((resolve) => {
    finish = resolve;
  });
  const ticks = [];
  const item = sampleItem('lib/a.js', 'pr');
  const session = new Session({
    cwd: '/tmp',
    stdout: sink(),
    color: false,
    getSize: () => ({ width: 80, height: 16 }),
    startPane: 'files',
    ...reviewFs,
    setInterval: (fn) => {
      ticks.push(fn);
      return ticks.length;
    },
    clearInterval: () => {},
    repo: {
      load: () => ({ items: [] }),
      loadAsync: async () => {
        await pending;
        return {
          items: [item],
          sourceLabel: '#123',
          change: {
            source: 'github-pr',
            repository: 'acme/app',
            number: 123,
          },
        };
      },
    },
  });
  session.uiOpen = true;
  const ready = session.openLoad();
  assert.equal(session.busy, 'loading');
  ticks[0]();
  assert.equal(session.progressFrame, 1);
  finish();
  await ready;
  assert.equal(session.busy, '');
  assert.equal(session.items.length, 1);
  assert.equal(session.sourceLabel, '#123');
  assert.equal(session.repoName, 'acme/app');
});

test('checkout shows progress until git finishes', async () => {
  let finish;
  const pending = new Promise((resolve) => {
    finish = resolve;
  });
  const ticks = [];
  const { session, repo } = openSession([sampleItem('a.js')], {
    startPane: 'files',
    setInterval: (fn) => {
      ticks.push(fn);
      return ticks.length;
    },
    clearInterval: () => {},
  });
  session.uiOpen = true;
  session.repo.checkoutAsync = async (top, name) => {
    await pending;
    repo.checkouts.push(name);
  };
  session.pushInput('b');
  session.pushInput('j');
  session.handleEvent({ type: 'key', key: 'enter' });
  assert.equal(repo.checkouts.length, 0);
  assert.equal(session.busy, 'checking out');
  ticks[0]();
  assert.equal(session.progressFrame, 1);
  finish();
  await pending;
  await Promise.resolve();
  assert.deepEqual(repo.checkouts, ['feat']);
  assert.match(session.status, /checked out feat/);
  assert.equal(session.busy, '');
});

test('commit shows progress until git finishes', async () => {
  let finish;
  const pending = new Promise((resolve) => {
    finish = resolve;
  });
  const ticks = [];
  const { session, repo } = openSession([sampleItem('a.js', 'staged')], {
    startPane: 'files',
    setInterval: (fn) => {
      ticks.push(fn);
      return ticks.length;
    },
    clearInterval: () => {},
  });
  session.uiOpen = true;
  session.repo.commitAsync = async (top, kind, message) => {
    await pending;
    repo.commits.push({ top, kind, message });
  };
  session.pushInput('c');
  session.pushInput('c');
  session.pushInput('land the change');
  session.handleEvent({ type: 'key', key: 'enter' });
  assert.equal(repo.commits.length, 0);
  assert.equal(session.busy, 'committing');
  ticks[0]();
  assert.equal(session.progressFrame, 1);
  finish();
  await pending;
  await Promise.resolve();
  assert.equal(repo.commits.length, 1);
  assert.equal(session.status, 'committed');
  assert.equal(session.busy, '');
});

test('files pane u unstages', () => {
  const item = sampleItem('a.js', 'staged');
  const { session, repo } = openSession([item], { startPane: 'files' });
  session.dispatch('next');
  session.pushInput('u');
  assert.equal(repo.unstageCalls.length, 1);
  assert.equal(session.status, 'unstaged');
});

test('branch list n creates a new branch', () => {
  const { session, repo } = openSession([sampleItem('a.js')], {
    startPane: 'files',
  });
  session.pushInput('b');
  session.pushInput('n');
  assert.equal(session.pane, 'branches');
  assert.equal(session.mode, 'compose');
  assert.equal(session.composeKind, 'branch');
  session.pushInput('topic');
  session.handleEvent({ type: 'key', key: 'enter' });
  assert.deepEqual(repo.created, ['topic']);
  assert.equal(session.pane, 'files');
  assert.equal(session.mode, 'review');
  assert.match(session.status, /created topic/);
});

test('escape from branch list returns to files', () => {
  const { session } = openSession([sampleItem('a.js')], { startPane: 'files' });
  session.pushInput('b');
  assert.equal(session.pane, 'branches');
  session.handleEvent({ type: 'key', key: 'escape' });
  assert.equal(session.pane, 'files');
});

test('read only blocks branch pull and push', () => {
  const { session, repo } = openSession([sampleItem('a.js')], {
    startPane: 'files',
    readOnly: true,
  });
  session.pushInput('b');
  assert.equal(session.pane, 'files');
  assert.equal(session.status, 'read only');
  session.pushInput('p');
  assert.equal(repo.pulls.length, 0);
  session.pushInput('s');
  assert.equal(repo.pushes.length, 0);
});
