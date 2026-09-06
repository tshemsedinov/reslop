'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { Session } = require('../lib/session.js');
const { hitAction } = require('../lib/keys.js');
const { sink } = require('./helpers.js');

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
  return {
    added,
    reverted,
    unstageCalls,
    load: () => ({ top: '/tmp', items: [...items] }),
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
  };
};

const openSession = (items) => {
  const repo = mockRepo(items);
  const stdout = sink();
  const session = new Session({
    repo,
    cwd: '/tmp',
    stdout,
    color: false,
    getSize: () => ({ width: 80, height: 16 }),
  });
  session.load();
  return { session, repo, stdout };
};

test('AC6 skip then prev keeps first unstaged', () => {
  const a = sampleItem('a.js');
  const b = sampleItem('b.js');
  const c = sampleItem('c.js');
  const { session, repo } = openSession([a, b, c]);
  session.dispatch('skip');
  assert.equal(session.current().file.newPath, 'b.js');
  assert.equal(repo.added.length, 0);
  session.dispatch('prev');
  assert.equal(session.current().file.newPath, 'b.js');
  assert.equal(session.status, 'first block');
  session.dispatch('next');
  assert.equal(session.current().file.newPath, 'c.js');
  session.dispatch('prev');
  assert.equal(session.current().file.newPath, 'b.js');
});

test('skip last remaining leaves git unchanged', () => {
  const a = sampleItem('a.js');
  const { session, repo } = openSession([a]);
  session.dispatch('skip');
  assert.equal(session.current(), null);
  assert.equal(session.status, 'all skipped');
  assert.equal(repo.added.length, 0);
  session.dispatch('next');
  assert.equal(session.status, 'all skipped');
  session.dispatch('add');
  assert.equal(repo.added.length, 0);
});

test('AC8 add on staged is a no-op with status', () => {
  const item = sampleItem('s.js', 'staged');
  const { session, repo } = openSession([item]);
  session.dispatch('add');
  assert.equal(session.status, 'already staged');
  assert.equal(repo.added.length, 0);
  assert.equal(session.items.length, 1);
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
  assert.equal(session.status, 'not staged');
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
  const files = session.fileList();
  assert.equal(files[0].status, '7ac260c');
  session.dispatch('skip');
  assert.equal(session.status, 'all skipped');
  assert.equal(repo.added.length, 0);
});

test('AC9 hotkeys dispatch add revert skip next prev quit', () => {
  const a = sampleItem('a.js');
  const b = sampleItem('b.js');
  const c = sampleItem('c.js');
  const { session, repo } = openSession([a, b, c]);
  assert.equal(session.layout, 'unified');
  session.pushInput('n');
  assert.equal(session.current().file.newPath, 'b.js');
  session.pushInput('p');
  assert.equal(session.current().file.newPath, 'a.js');
  session.pushInput('s');
  assert.equal(session.current().file.newPath, 'b.js');
  session.pushInput('a');
  assert.equal(repo.added.length, 1);
  assert.equal(repo.added[0].file.newPath, 'b.js');
  session.pushInput('r');
  assert.equal(repo.reverted.length, 1);
  session.pushInput('m');
  assert.equal(session.layout, 'mixed');
  assert.equal(session.status, 'mixed');
  session.pushInput('m');
  assert.equal(session.layout, 'side');
  assert.equal(session.status, 'side-by-side');
  session.pushInput('m');
  assert.equal(session.layout, 'unified');
  session.pushInput('l');
  assert.equal(session.pane, 'files');
  session.pushInput('q');
  assert.equal(session.done, true);
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
    getSize: () => ({ width: 80, height: 16 }),
    copyText: (text) => {
      copied.push(text);
      return true;
    },
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
  session.dispatch('skip');
  session.draw();
  const second = stdout.dump();
  assert.ok(second.length > first.length);
  const extra = second.slice(first.length);
  assert.ok(extra.includes('[?2026h'));
  assert.ok(!extra.includes('[2J'));
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
  });
  session.load();
  assert.equal(session.pane, 'files');
  session.draw();
  const text = stdout.dump();
  assert.match(text, /metadiff: tmp\/a\.js\s+unstaged 1\/2/);
  assert.ok(!text.includes('@@'));
  assert.match(text, /a\.js/);
  assert.match(text, /b\.js/);
  session.dispatch('add');
  assert.equal(repo.added.length, 0);
  session.dispatch('scrollDown');
  assert.equal(session.fileCursor, 1);
  session.dispatch('open');
  assert.equal(session.pane, 'diff');
  assert.equal(session.current().file.newPath, 'b.js');
  session.dispatch('files');
  assert.equal(session.pane, 'files');
  assert.equal(session.fileCursor, 1);
});
