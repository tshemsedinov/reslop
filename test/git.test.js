'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { load, addItem, unstageItem, revertItem } = require('../lib/git.js');
const { Session } = require('../lib/session.js');
const { makeRepo, sink } = require('./helpers.js');

const sessionFor = (dir) => {
  const { createGitRepo } = require('../lib/git.js');
  const stdout = sink();
  const session = new Session({
    repo: createGitRepo(),
    cwd: dir,
    stdout,
    color: false,
    startPane: 'diff',
    getSize: () => ({ width: 80, height: 16 }),
  });
  session.load();
  return session;
};

test('AC4 add stages an unstaged block', () => {
  const repo = makeRepo();
  try {
    repo.write('f.txt', 'alpha\nbeta\ngamma\n');
    repo.git(['add', 'f.txt']);
    repo.git(['commit', '-m', 'init']);
    repo.write('f.txt', 'alpha\nBETA\ngamma\n');
    const loaded = load(repo.dir);
    assert.equal(loaded.items.length, 1);
    addItem(loaded.top, loaded.items[0]);
    const cached = repo.git(['diff', '--cached', '--', 'f.txt']);
    const work = repo.git(['diff', '--', 'f.txt']);
    assert.match(cached, /BETA/);
    assert.equal(work, '');
  } finally {
    repo.cleanup();
  }
});

test('AC5 revert restores worktree to HEAD', () => {
  const repo = makeRepo();
  try {
    repo.write('f.txt', 'alpha\nbeta\ngamma\n');
    repo.git(['add', 'f.txt']);
    repo.git(['commit', '-m', 'init']);
    repo.write('f.txt', 'alpha\nBETA\ngamma\n');
    const loaded = load(repo.dir);
    revertItem(loaded.top, loaded.items[0]);
    assert.equal(repo.read('f.txt'), 'alpha\nbeta\ngamma\n');
    const vsHead = repo.git(['diff', 'HEAD', '--', 'f.txt']);
    assert.equal(vsHead, '');
  } finally {
    repo.cleanup();
  }
});

test('AC7 untracked add and revert', () => {
  const repo = makeRepo();
  try {
    repo.write('keep.txt', 'k\n');
    repo.git(['add', 'keep.txt']);
    repo.git(['commit', '-m', 'init']);
    repo.write('new.txt', 'hello\n');
    const loaded = load(repo.dir);
    const item = loaded.items.find((entry) => entry.origin === 'untracked');
    assert.ok(item);
    addItem(loaded.top, item);
    const cached = repo.git(['diff', '--cached', '--name-only']);
    assert.match(cached, /new.txt/);
    repo.git(['reset', 'HEAD', '--', 'new.txt']);
    const again = load(repo.dir);
    const untracked = again.items.find((entry) => entry.origin === 'untracked');
    revertItem(again.top, untracked);
    assert.equal(repo.exists('new.txt'), false);
  } finally {
    repo.cleanup();
  }
});

test('AC8 revert staged restores HEAD', () => {
  const repo = makeRepo();
  try {
    repo.write('f.txt', 'one\n');
    repo.git(['add', 'f.txt']);
    repo.git(['commit', '-m', 'init']);
    repo.write('f.txt', 'two\n');
    repo.git(['add', 'f.txt']);
    const session = sessionFor(repo.dir);
    assert.equal(session.items[0].origin, 'staged');
    session.dispatch('add');
    assert.equal(session.status, 'already staged');
    session.dispatch('revert');
    assert.equal(repo.read('f.txt'), 'one\n');
    const cached = repo.git(['diff', '--cached']);
    assert.equal(cached, '');
  } finally {
    repo.cleanup();
  }
});

test('add then unstage a block in a split hunk', () => {
  const repo = makeRepo();
  try {
    repo.write('f.txt', 'keep\nAAA\nkeep\nBBB\nkeep\n');
    repo.git(['add', 'f.txt']);
    repo.git(['commit', '-m', 'init']);
    repo.write('f.txt', 'keep\naaa\nkeep\nbbb\nkeep\n');
    const session = sessionFor(repo.dir);
    assert.equal(session.items.length, 2);
    session.dispatch('add');
    assert.equal(session.status, 'staged');
    session.dispatch('unstage');
    assert.equal(session.status, 'unstaged');
    const cached = repo.git(['diff', '--cached', '--', 'f.txt']);
    assert.equal(cached, '');
    assert.equal(repo.read('f.txt'), 'keep\naaa\nkeep\nbbb\nkeep\n');
  } finally {
    repo.cleanup();
  }
});

test('add both blocks of a split hunk without reload', () => {
  const repo = makeRepo();
  try {
    repo.write('f.txt', 'keep\nAAA\nkeep\nBBB\nkeep\n');
    repo.git(['add', 'f.txt']);
    repo.git(['commit', '-m', 'init']);
    repo.write('f.txt', 'keep\naaa\nkeep\nbbb\nkeep\n');
    const session = sessionFor(repo.dir);
    session.dispatch('add');
    assert.equal(session.status, 'staged');
    session.index = 1;
    session.dispatch('add');
    assert.equal(session.status, 'staged');
    assert.equal(session.items[0].origin, 'staged');
    assert.equal(session.items[1].origin, 'staged');
    const work = repo.git(['diff', '--', 'f.txt']);
    assert.equal(work, '');
  } finally {
    repo.cleanup();
  }
});

test('files pane add stages every remaining hunk', () => {
  const repo = makeRepo();
  try {
    repo.write('f.txt', 'keep\nAAA\nkeep\nBBB\nkeep\n');
    repo.git(['add', 'f.txt']);
    repo.git(['commit', '-m', 'init']);
    repo.write('f.txt', 'keep\naaa\nkeep\nbbb\nkeep\n');
    const session = sessionFor(repo.dir);
    assert.equal(session.items.length, 2);
    session.showFiles();
    session.dispatch('add');
    assert.equal(session.status, 'staged');
    assert.equal(session.items[0].origin, 'staged');
    assert.equal(session.items[1].origin, 'staged');
    const work = repo.git(['diff', '--', 'f.txt']);
    assert.equal(work, '');
  } finally {
    repo.cleanup();
  }
});

test('files pane unstage restores every staged hunk', () => {
  const repo = makeRepo();
  try {
    repo.write('f.txt', 'keep\nAAA\nkeep\nBBB\nkeep\n');
    repo.git(['add', 'f.txt']);
    repo.git(['commit', '-m', 'init']);
    repo.write('f.txt', 'keep\naaa\nkeep\nbbb\nkeep\n');
    repo.git(['add', 'f.txt']);
    const session = sessionFor(repo.dir);
    session.showFiles();
    session.dispatch('unstage');
    assert.equal(session.status, 'unstaged');
    assert.equal(session.items[0].origin, 'unstaged');
    assert.equal(session.items[1].origin, 'unstaged');
    const cached = repo.git(['diff', '--cached', '--', 'f.txt']);
    assert.equal(cached, '');
    assert.equal(repo.read('f.txt'), 'keep\naaa\nkeep\nbbb\nkeep\n');
  } finally {
    repo.cleanup();
  }
});

test('files pane revert restores the whole file', () => {
  const repo = makeRepo();
  try {
    repo.write('f.txt', 'keep\nAAA\nkeep\nBBB\nkeep\n');
    repo.git(['add', 'f.txt']);
    repo.git(['commit', '-m', 'init']);
    repo.write('f.txt', 'keep\naaa\nkeep\nbbb\nkeep\n');
    const session = sessionFor(repo.dir);
    session.showFiles();
    session.dispatch('revert');
    assert.equal(repo.read('f.txt'), 'keep\nAAA\nkeep\nBBB\nkeep\n');
    const vsHead = repo.git(['diff', 'HEAD', '--', 'f.txt']);
    assert.equal(vsHead, '');
  } finally {
    repo.cleanup();
  }
});

test('unstage both blocks of a staged split hunk', () => {
  const repo = makeRepo();
  try {
    repo.write('f.txt', 'keep\nAAA\nkeep\nBBB\nkeep\n');
    repo.git(['add', 'f.txt']);
    repo.git(['commit', '-m', 'init']);
    repo.write('f.txt', 'keep\naaa\nkeep\nbbb\nkeep\n');
    repo.git(['add', 'f.txt']);
    const session = sessionFor(repo.dir);
    assert.equal(session.items.length, 2);
    session.dispatch('unstage');
    assert.equal(session.status, 'unstaged');
    session.index = 1;
    session.dispatch('unstage');
    assert.equal(session.status, 'unstaged');
    const cached = repo.git(['diff', '--cached', '--', 'f.txt']);
    assert.equal(cached, '');
    assert.equal(repo.read('f.txt'), 'keep\naaa\nkeep\nbbb\nkeep\n');
  } finally {
    repo.cleanup();
  }
});

test('add and unstage keep file order', () => {
  const repo = makeRepo();
  try {
    repo.write('a.txt', 'a\n');
    repo.write('b.txt', 'b\n');
    repo.write('c.txt', 'c\n');
    repo.git(['add', '.']);
    repo.git(['commit', '-m', 'init']);
    repo.write('a.txt', 'A\n');
    repo.write('b.txt', 'B\n');
    repo.write('c.txt', 'C\n');
    const session = sessionFor(repo.dir);
    const paths = () => session.items.map((item) => item.file.newPath);
    assert.deepEqual(paths(), ['a.txt', 'b.txt', 'c.txt']);
    session.index = 1;
    session.dispatch('add');
    assert.equal(session.items[1].origin, 'staged');
    assert.deepEqual(paths(), ['a.txt', 'b.txt', 'c.txt']);
    assert.equal(session.current().file.newPath, 'b.txt');
    session.dispatch('unstage');
    assert.equal(session.items[1].origin, 'unstaged');
    assert.deepEqual(paths(), ['a.txt', 'b.txt', 'c.txt']);
  } finally {
    repo.cleanup();
  }
});

test('AC28 unstage staged keeps worktree', () => {
  const repo = makeRepo();
  try {
    repo.write('f.txt', 'one\n');
    repo.git(['add', 'f.txt']);
    repo.git(['commit', '-m', 'init']);
    repo.write('f.txt', 'two\n');
    repo.git(['add', 'f.txt']);
    const loaded = load(repo.dir);
    assert.equal(loaded.items[0].origin, 'staged');
    unstageItem(loaded.top, loaded.items[0]);
    assert.equal(repo.read('f.txt'), 'two\n');
    const cached = repo.git(['diff', '--cached', '--', 'f.txt']);
    assert.equal(cached, '');
    const work = repo.git(['diff', '--', 'f.txt']);
    assert.match(work, /two/);
  } finally {
    repo.cleanup();
  }
});

test('AC15 file argv loads only that file', () => {
  const repo = makeRepo();
  try {
    repo.write('keep.txt', 'k\n');
    repo.write('src/a.txt', 'a\n');
    repo.git(['add', '.']);
    repo.git(['commit', '-m', 'init']);
    repo.write('keep.txt', 'K\n');
    repo.write('src/a.txt', 'A\n');
    const one = load(repo.dir, ['keep.txt']);
    assert.equal(one.items.length, 1);
    assert.equal(one.items[0].file.newPath, 'keep.txt');
    const folder = load(repo.dir, ['src']);
    assert.equal(folder.items.length, 1);
    assert.equal(folder.items[0].file.newPath, 'src/a.txt');
    const { createGitRepo } = require('../lib/git.js');
    const session = new Session({
      repo: createGitRepo(),
      cwd: repo.dir,
      paths: ['keep.txt'],
      stdout: sink(),
      color: false,
      startPane: 'diff',
      getSize: () => ({ width: 80, height: 16 }),
    });
    session.load();
    assert.equal(session.pane, 'diff');
    const files = session.fileList();
    assert.equal(files.length, 1);
    assert.equal(files[0].path, 'keep.txt');
  } finally {
    repo.cleanup();
  }
});

test('AC20 load commit patch ignores dirty worktree', () => {
  const repo = makeRepo();
  try {
    repo.write('keep.txt', 'k\n');
    repo.write('src/a.txt', 'a\n');
    repo.git(['add', '.']);
    repo.git(['commit', '-m', 'init']);
    repo.write('src/a.txt', 'A\n');
    repo.git(['add', '.']);
    repo.git(['commit', '-m', 'change a']);
    const sha = repo.git(['rev-parse', 'HEAD']).trim();
    repo.write('src/a.txt', 'DIRTY\n');
    repo.write('new.txt', 'untracked\n');
    const loaded = load(repo.dir, [], { commit: sha });
    assert.ok(loaded.items.length >= 1);
    for (const item of loaded.items) {
      assert.equal(item.origin, 'commit');
      assert.notEqual(item.file.newPath, 'new.txt');
    }
    const paths = loaded.items.map((item) => item.file.newPath);
    assert.ok(paths.includes('src/a.txt'));
    const blob = JSON.stringify(loaded.items);
    assert.match(blob, /"text":"A"/);
    assert.equal(blob.includes('DIRTY'), false);
    const only = load(repo.dir, ['src/a.txt'], { commit: sha });
    assert.ok(only.items.length >= 1);
    for (const item of only.items) {
      assert.equal(item.file.newPath, 'src/a.txt');
    }
    const work = load(repo.dir);
    const origins = new Set(work.items.map((item) => item.origin));
    assert.ok(origins.has('unstaged') || origins.has('untracked'));
  } finally {
    repo.cleanup();
  }
});

test('load root commit via diff-tree', () => {
  const repo = makeRepo();
  try {
    repo.write('first.txt', 'hello\n');
    repo.git(['add', '.']);
    repo.git(['commit', '-m', 'root']);
    const sha = repo.git(['rev-parse', 'HEAD']).trim();
    const loaded = load(repo.dir, [], { commit: sha });
    assert.ok(loaded.items.length >= 1);
    assert.equal(loaded.items[0].origin, 'commit');
    assert.equal(loaded.items[0].file.newPath, 'first.txt');
    assert.ok(loaded.revShort);
  } finally {
    repo.cleanup();
  }
});

test('load omits files under .review', () => {
  const repo = makeRepo();
  try {
    repo.write('keep.txt', 'k\n');
    repo.git(['add', 'keep.txt']);
    repo.git(['commit', '-m', 'init']);
    repo.write('keep.txt', 'K\n');
    repo.write('.review/2026-09-07-00.md', '---\nstatus: editing\n---\n');
    repo.write('.review/templates.json', '[]\n');
    const dirty = load(repo.dir);
    const dirtyPaths = dirty.items.map((item) => item.file.newPath);
    assert.deepEqual(dirtyPaths, ['keep.txt']);
    repo.git(['add', '.review/2026-09-07-00.md']);
    const mixed = load(repo.dir);
    for (const item of mixed.items) {
      const rel = item.file.newPath || item.file.oldPath;
      assert.equal(rel.startsWith('.review'), false);
    }
    repo.git(['add', '.']);
    repo.git(['commit', '-m', 'notes']);
    const sha = repo.git(['rev-parse', 'HEAD']).trim();
    const committed = load(repo.dir, [], { commit: sha });
    for (const item of committed.items) {
      const rel = item.file.newPath || item.file.oldPath;
      assert.equal(rel.startsWith('.review'), false);
    }
  } finally {
    repo.cleanup();
  }
});
