'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const git = require('../../lib/git/git.js');
const { load, addItem, unstageItem, revertItem } = git;
const { commitChanges, hasStaged, lastMessage, createGitRepo } = git;
const { currentBranch } = git;
const { listCommits } = git;
const { Session } = require('../../lib/session/session.js');
const { blockAddText } = require('../../lib/diff/diff.js');
const { makeRepo, sink, seedRepo, sessionFor } = require('../helpers.js');

test('AC4 add stages an unstaged block', async () => {
  const repo = makeRepo();
  try {
    repo.write('f.txt', 'alpha\nbeta\ngamma\n');
    repo.git(['add', 'f.txt']);
    repo.git(['commit', '-m', 'init']);
    repo.write('f.txt', 'alpha\nBETA\ngamma\n');
    const loaded = await load(repo.dir, [], { deferExtras: false });
    assert.equal(loaded.items.length, 1);
    await addItem(loaded.top, loaded.items[0]);
    const cached = repo.git(['diff', '--cached', '--', 'f.txt']);
    const work = repo.git(['diff', '--', 'f.txt']);
    assert.match(cached, /BETA/);
    assert.equal(work, '');
  } finally {
    repo.cleanup();
  }
});

test('load exposes the origin as a browser repository url', async () => {
  const repo = makeRepo();
  try {
    repo.git(['remote', 'add', 'origin', 'git@github.com:acme/demo.git']);
    const loaded = await load(repo.dir, [], { deferExtras: false });
    assert.equal(loaded.repositoryUrl, 'https://github.com/acme/demo');
  } finally {
    repo.cleanup();
  }
});

test('AC5 revert restores worktree to HEAD', async () => {
  const repo = makeRepo();
  try {
    repo.write('f.txt', 'alpha\nbeta\ngamma\n');
    repo.git(['add', 'f.txt']);
    repo.git(['commit', '-m', 'init']);
    repo.write('f.txt', 'alpha\nBETA\ngamma\n');
    const loaded = await load(repo.dir, [], { deferExtras: false });
    await revertItem(loaded.top, loaded.items[0]);
    assert.equal(repo.read('f.txt'), 'alpha\nbeta\ngamma\n');
    const vsHead = repo.git(['diff', 'HEAD', '--', 'f.txt']);
    assert.equal(vsHead, '');
  } finally {
    repo.cleanup();
  }
});

test('AC7 untracked add and revert', async () => {
  const repo = makeRepo();
  try {
    repo.write('keep.txt', 'k\n');
    repo.git(['add', 'keep.txt']);
    repo.git(['commit', '-m', 'init']);
    repo.write('new.txt', 'hello\n');
    const loaded = await load(repo.dir, [], { deferExtras: false });
    const item = loaded.items.find((entry) => entry.origin === 'untracked');
    assert.ok(item);
    await addItem(loaded.top, item);
    const cached = repo.git(['diff', '--cached', '--name-only']);
    assert.match(cached, /new.txt/);
    repo.git(['reset', 'HEAD', '--', 'new.txt']);
    const again = await load(repo.dir, [], { deferExtras: false });
    const untracked = again.items.find((entry) => entry.origin === 'untracked');
    await revertItem(again.top, untracked);
    assert.equal(repo.exists('new.txt'), false);
  } finally {
    repo.cleanup();
  }
});

test('a nested git repository stays out of the worktree load', async () => {
  const repo = makeRepo();
  try {
    repo.write('keep.txt', 'k\n');
    repo.git(['add', 'keep.txt']);
    repo.git(['commit', '-m', 'init']);
    const nested = path.join(repo.dir, 'nested');
    seedRepo(nested);
    repo.write('note.txt', 'hello\n');
    const loaded = await load(repo.dir, [], { deferExtras: false });
    const paths = loaded.items.map((item) => item.file.newPath);
    assert.deepEqual(paths, ['note.txt']);
    const names = await createGitRepo().listFiles(repo.dir);
    assert.equal(names.includes('note.txt'), true);
    assert.equal(names.includes('nested/'), false);
  } finally {
    repo.cleanup();
  }
});

test('AC8 revert staged restores HEAD', async () => {
  const repo = makeRepo();
  try {
    repo.write('f.txt', 'one\n');
    repo.git(['add', 'f.txt']);
    repo.git(['commit', '-m', 'init']);
    repo.write('f.txt', 'two\n');
    repo.git(['add', 'f.txt']);
    const session = await sessionFor(repo.dir);
    assert.equal(session.items[0].origin, 'staged');
    session.dispatch('add');
    assert.equal(session.status, '');
    session.dispatch('revert');
    await session.ops.idle();
    assert.equal(repo.read('f.txt'), 'one\n');
    const cached = repo.git(['diff', '--cached']);
    assert.equal(cached, '');
  } finally {
    repo.cleanup();
  }
});

test('add then unstage a block in a split hunk', async () => {
  const repo = makeRepo();
  try {
    repo.write('f.txt', 'keep\nAAA\nkeep\nBBB\nkeep\n');
    repo.git(['add', 'f.txt']);
    repo.git(['commit', '-m', 'init']);
    repo.write('f.txt', 'keep\naaa\nkeep\nbbb\nkeep\n');
    const session = await sessionFor(repo.dir);
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

test('add both blocks of a split hunk without reload', async () => {
  const repo = makeRepo();
  try {
    repo.write('f.txt', 'keep\nAAA\nkeep\nBBB\nkeep\n');
    repo.git(['add', 'f.txt']);
    repo.git(['commit', '-m', 'init']);
    repo.write('f.txt', 'keep\naaa\nkeep\nbbb\nkeep\n');
    const session = await sessionFor(repo.dir);
    session.dispatch('add');
    await session.ops.idle();
    assert.equal(session.status, 'staged');
    session.index = 1;
    session.dispatch('add');
    await session.ops.idle();
    assert.equal(session.status, 'staged');
    assert.equal(session.items[0].origin, 'staged');
    assert.equal(session.items[1].origin, 'staged');
    const work = repo.git(['diff', '--', 'f.txt']);
    assert.equal(work, '');
  } finally {
    repo.cleanup();
  }
});

test('files pane add stages every remaining hunk', async () => {
  const repo = makeRepo();
  try {
    repo.write('f.txt', 'keep\nAAA\nkeep\nBBB\nkeep\n');
    repo.git(['add', 'f.txt']);
    repo.git(['commit', '-m', 'init']);
    repo.write('f.txt', 'keep\naaa\nkeep\nbbb\nkeep\n');
    const session = await sessionFor(repo.dir);
    assert.equal(session.items.length, 2);
    session.showFiles();
    session.dispatch('add');
    await session.ops.idle();
    assert.equal(session.status, 'staged');
    assert.equal(session.items[0].origin, 'staged');
    assert.equal(session.items[1].origin, 'staged');
    const work = repo.git(['diff', '--', 'f.txt']);
    assert.equal(work, '');
  } finally {
    repo.cleanup();
  }
});

test('files pane unstage restores every staged hunk', async () => {
  const repo = makeRepo();
  try {
    repo.write('f.txt', 'keep\nAAA\nkeep\nBBB\nkeep\n');
    repo.git(['add', 'f.txt']);
    repo.git(['commit', '-m', 'init']);
    repo.write('f.txt', 'keep\naaa\nkeep\nbbb\nkeep\n');
    repo.git(['add', 'f.txt']);
    const session = await sessionFor(repo.dir);
    session.showFiles();
    session.dispatch('unstage');
    await session.ops.idle();
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

test('files pane revert restores the whole file', async () => {
  const repo = makeRepo();
  try {
    repo.write('f.txt', 'keep\nAAA\nkeep\nBBB\nkeep\n');
    repo.git(['add', 'f.txt']);
    repo.git(['commit', '-m', 'init']);
    repo.write('f.txt', 'keep\naaa\nkeep\nbbb\nkeep\n');
    const session = await sessionFor(repo.dir);
    session.showFiles();
    session.dispatch('revert');
    await session.ops.idle();
    assert.equal(repo.read('f.txt'), 'keep\nAAA\nkeep\nBBB\nkeep\n');
    const vsHead = repo.git(['diff', 'HEAD', '--', 'f.txt']);
    assert.equal(vsHead, '');
    assert.equal(session.done, false);
    assert.notEqual(session.status, 'nothing to review');
  } finally {
    repo.cleanup();
  }
});

test('committing the last staged change does not end the review', async () => {
  const repo = makeRepo();
  try {
    repo.write('f.txt', 'one\n');
    repo.git(['add', 'f.txt']);
    repo.git(['commit', '-m', 'init']);
    repo.write('f.txt', 'two\n');
    repo.git(['add', 'f.txt']);
    const session = await sessionFor(repo.dir);
    assert.equal(session.items[0].origin, 'staged');
    session.showFiles();
    session.pushInput('c');
    await session.ops.idle();
    session.handleEvent({ type: 'key', key: 'insert' });
    await session.ops.idle();
    session.pushInput('land the change');
    await session.ops.idle();
    session.handleEvent({ type: 'key', key: 'enter' });
    await session.ops.idle();
    assert.equal(session.done, false);
    assert.equal(session.emptyReview, false);
    assert.equal(session.status, 'committed');
    assert.equal(session.items.length, 0);
    assert.equal(session.pane, 'commits');
  } finally {
    repo.cleanup();
  }
});

test('unstage both blocks of a staged split hunk', async () => {
  const repo = makeRepo();
  try {
    repo.write('f.txt', 'keep\nAAA\nkeep\nBBB\nkeep\n');
    repo.git(['add', 'f.txt']);
    repo.git(['commit', '-m', 'init']);
    repo.write('f.txt', 'keep\naaa\nkeep\nbbb\nkeep\n');
    repo.git(['add', 'f.txt']);
    const session = await sessionFor(repo.dir);
    assert.equal(session.items.length, 2);
    session.dispatch('unstage');
    await session.ops.idle();
    assert.equal(session.status, 'unstaged');
    session.index = 1;
    session.dispatch('unstage');
    await session.ops.idle();
    assert.equal(session.status, 'unstaged');
    const cached = repo.git(['diff', '--cached', '--', 'f.txt']);
    assert.equal(cached, '');
    assert.equal(repo.read('f.txt'), 'keep\naaa\nkeep\nbbb\nkeep\n');
  } finally {
    repo.cleanup();
  }
});

test('add and unstage keep file order', async () => {
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
    const session = await sessionFor(repo.dir);
    const paths = () => session.items.map((item) => item.file.newPath);
    assert.deepEqual(paths(), ['a.txt', 'b.txt', 'c.txt']);
    session.index = 1;
    session.dispatch('add');
    await session.ops.idle();
    assert.equal(session.items[1].origin, 'staged');
    assert.deepEqual(paths(), ['a.txt', 'b.txt', 'c.txt']);
    assert.equal(session.current().file.newPath, 'b.txt');
    session.refreshFromRepo({ keepView: true });
    await session.ops.idle();
    assert.deepEqual(paths(), ['a.txt', 'b.txt', 'c.txt']);
    assert.equal(session.items[1].origin, 'staged');
    assert.equal(session.current().file.newPath, 'b.txt');
    session.dispatch('unstage');
    await session.ops.idle();
    assert.equal(session.items[1].origin, 'unstaged');
    assert.deepEqual(paths(), ['a.txt', 'b.txt', 'c.txt']);
  } finally {
    repo.cleanup();
  }
});

test('staging a later hunk keeps hunk order after reload', async () => {
  const repo = makeRepo();
  try {
    repo.write('f.txt', 'keep\nAAA\nkeep\nBBB\nkeep\n');
    repo.git(['add', 'f.txt']);
    repo.git(['commit', '-m', 'init']);
    repo.write('f.txt', 'keep\naaa\nkeep\nbbb\nkeep\n');
    const session = await sessionFor(repo.dir);
    assert.equal(session.items.length, 2);
    session.index = 1;
    const before = blockAddText(
      session.current().hunk,
      session.current().blockId,
    );
    session.dispatch('add');
    await session.ops.idle();
    assert.equal(session.items[0].origin, 'unstaged');
    assert.equal(session.items[1].origin, 'staged');
    session.refreshFromRepo({ keepView: true });
    await session.ops.idle();
    assert.equal(session.items.length, 2);
    assert.equal(session.items[0].origin, 'unstaged');
    assert.equal(session.items[1].origin, 'staged');
    assert.equal(session.current().origin, 'staged');
    assert.equal(
      blockAddText(session.current().hunk, session.current().blockId),
      before,
    );
  } finally {
    repo.cleanup();
  }
});

test('staging the current hunk keeps it on screen after reload', async () => {
  const repo = makeRepo();
  try {
    repo.write('f.txt', 'keep\nAAA\nkeep\nBBB\nkeep\n');
    repo.git(['add', 'f.txt']);
    repo.git(['commit', '-m', 'init']);
    repo.write('f.txt', 'keep\naaa\nkeep\nbbb\nkeep\n');
    const session = await sessionFor(repo.dir);
    assert.equal(session.items.length, 2);
    const before = blockAddText(
      session.current().hunk,
      session.current().blockId,
    );
    session.dispatch('add');
    await session.ops.idle();
    assert.equal(session.current().origin, 'staged');
    session.refreshFromRepo({ keepView: true });
    await session.ops.idle();
    assert.equal(session.current().origin, 'staged');
    assert.equal(
      blockAddText(session.current().hunk, session.current().blockId),
      before,
    );
    assert.equal(session.items[0].origin, 'staged');
    assert.equal(session.items[1].origin, 'unstaged');
  } finally {
    repo.cleanup();
  }
});

test('AC28 unstage staged keeps worktree', async () => {
  const repo = makeRepo();
  try {
    repo.write('f.txt', 'one\n');
    repo.git(['add', 'f.txt']);
    repo.git(['commit', '-m', 'init']);
    repo.write('f.txt', 'two\n');
    repo.git(['add', 'f.txt']);
    const loaded = await load(repo.dir, [], { deferExtras: false });
    assert.equal(loaded.items[0].origin, 'staged');
    await unstageItem(loaded.top, loaded.items[0]);
    assert.equal(repo.read('f.txt'), 'two\n');
    const cached = repo.git(['diff', '--cached', '--', 'f.txt']);
    assert.equal(cached, '');
    const work = repo.git(['diff', '--', 'f.txt']);
    assert.match(work, /two/);
  } finally {
    repo.cleanup();
  }
});

test('AC15 file argv loads only that file', async () => {
  const repo = makeRepo();
  try {
    repo.write('keep.txt', 'k\n');
    repo.write('src/a.txt', 'a\n');
    repo.git(['add', '.']);
    repo.git(['commit', '-m', 'init']);
    repo.write('keep.txt', 'K\n');
    repo.write('src/a.txt', 'A\n');
    const one = await load(repo.dir, ['keep.txt'], { deferExtras: false });
    assert.equal(one.items.length, 1);
    assert.equal(one.items[0].file.newPath, 'keep.txt');
    const folder = await load(repo.dir, ['src'], { deferExtras: false });
    assert.equal(folder.items.length, 1);
    assert.equal(folder.items[0].file.newPath, 'src/a.txt');
    const session = new Session({
      repo: createGitRepo(),
      cwd: repo.dir,
      paths: ['keep.txt'],
      stdout: sink(),
      color: false,
      startPane: 'diff',
    });
    await session.load();
    assert.equal(session.pane, 'diff');
    const files = session.fileList();
    assert.equal(files.length, 1);
    assert.equal(files[0].path, 'keep.txt');
    assert.match(files[0].date, /^\d+(mo|[smhdwy]) ago$/);
  } finally {
    repo.cleanup();
  }
});

test('AC20 load commit patch ignores dirty worktree', async () => {
  const repo = makeRepo();
  try {
    repo.write('keep.txt', 'k\n');
    repo.write('src/a.txt', 'a\n');
    repo.git(['add', '.']);
    repo.git(['commit', '-m', 'init']);
    repo.write('src/a.txt', 'A\n');
    repo.git(['add', '.']);
    repo.git(['commit', '-m', 'change a']);
    const commit = repo.git(['rev-parse', 'HEAD']).trim();
    repo.write('src/a.txt', 'DIRTY\n');
    repo.write('new.txt', 'untracked\n');
    const loaded = await load(repo.dir, [], {
      deferExtras: false,
      commit,
    });
    assert.deepEqual(
      loaded.items.map((item) => [item.origin, item.file.newPath]),
      [['commit', 'src/a.txt']],
    );
    const blob = JSON.stringify(loaded.items);
    assert.match(blob, /"text":"A"/);
    assert.equal(blob.includes('DIRTY'), false);
    const only = await load(repo.dir, ['src/a.txt'], {
      deferExtras: false,
      commit,
    });
    assert.deepEqual(
      only.items.map((item) => item.file.newPath),
      ['src/a.txt'],
    );
    const elsewhere = await load(repo.dir, ['keep.txt'], {
      deferExtras: false,
      commit,
    });
    assert.deepEqual(elsewhere.items, []);
    const work = await load(repo.dir, [], { deferExtras: false });
    assert.deepEqual(
      work.items.map((item) => [item.origin, item.file.newPath]),
      [
        ['unstaged', 'src/a.txt'],
        ['untracked', 'new.txt'],
      ],
    );
  } finally {
    repo.cleanup();
  }
});

test('load root commit via diff-tree', async () => {
  const repo = makeRepo();
  try {
    repo.write('first.txt', 'hello\n');
    repo.git(['add', '.']);
    repo.git(['commit', '-m', 'root']);
    const commit = repo.git(['rev-parse', 'HEAD']).trim();
    const loaded = await load(repo.dir, [], {
      deferExtras: false,
      commit,
    });
    assert.equal(loaded.items.length, 1);
    assert.equal(loaded.items[0].origin, 'commit');
    assert.equal(loaded.items[0].file.newPath, 'first.txt');
    assert.ok(commit.startsWith(loaded.revShort));
  } finally {
    repo.cleanup();
  }
});

test('load omits files under .plan', async () => {
  const repo = makeRepo();
  try {
    repo.write('keep.txt', 'k\n');
    repo.git(['add', 'keep.txt']);
    repo.git(['commit', '-m', 'init']);
    repo.write('keep.txt', 'K\n');
    repo.write('.plan/2026-09-07-00.md', '---\nstatus: editing\n---\n');
    repo.write('.plan/.templates', '[]\n');
    const dirty = await load(repo.dir, [], { deferExtras: false });
    const dirtyPaths = dirty.items.map((item) => item.file.newPath);
    assert.deepEqual(dirtyPaths, ['keep.txt']);
    repo.git(['add', '.plan/2026-09-07-00.md']);
    const mixed = await load(repo.dir, [], { deferExtras: false });
    assert.deepEqual(
      mixed.items.map((item) => item.file.newPath),
      ['keep.txt'],
    );
    repo.git(['add', '.']);
    repo.git(['commit', '-m', 'notes']);
    const commit = repo.git(['rev-parse', 'HEAD']).trim();
    const committed = await load(repo.dir, [], {
      deferExtras: false,
      commit,
    });
    assert.deepEqual(
      committed.items.map((item) => item.file.newPath),
      ['keep.txt'],
    );
  } finally {
    repo.cleanup();
  }
});

test('commitChanges writes a commit from the message', async () => {
  const repo = makeRepo();
  try {
    repo.write('f.txt', 'a\n');
    repo.git(['add', 'f.txt']);
    repo.git(['commit', '-m', 'init']);
    repo.write('f.txt', 'b\n');
    repo.git(['add', 'f.txt']);
    await commitChanges(repo.dir, 'commit', 'second');
    const subject = repo.git(['log', '-1', '--format=%s']).trim();
    assert.equal(subject, 'second');
  } finally {
    repo.cleanup();
  }
});

test('commitChanges amend replaces the last message', async () => {
  const repo = makeRepo();
  try {
    repo.write('f.txt', 'a\n');
    repo.git(['add', 'f.txt']);
    repo.git(['commit', '-m', 'init']);
    repo.write('f.txt', 'b\n');
    repo.git(['add', 'f.txt']);
    await commitChanges(repo.dir, 'amend', 'rewritten');
    const log = repo.git(['log', '--format=%s']).trim().split('\n');
    assert.equal(log.length, 1);
    assert.equal(log[0], 'rewritten');
    assert.equal(await lastMessage(repo.dir), 'rewritten');
  } finally {
    repo.cleanup();
  }
});

test('hasStaged is false until files are added', async () => {
  const repo = makeRepo();
  try {
    repo.write('f.txt', 'a\n');
    repo.git(['add', 'f.txt']);
    repo.git(['commit', '-m', 'init']);
    assert.equal(await hasStaged(repo.dir), false);
    repo.write('f.txt', 'b\n');
    repo.git(['add', 'f.txt']);
    assert.equal(await hasStaged(repo.dir), true);
  } finally {
    repo.cleanup();
  }
});

test('updateCommit folds staged changes into the selected commit', async () => {
  const repo = makeRepo();
  try {
    repo.write('a.txt', 'one\n');
    repo.git(['add', 'a.txt']);
    repo.git(['commit', '-m', 'one']);
    repo.write('b.txt', 'two\n');
    repo.git(['add', 'b.txt']);
    repo.git(['commit', '-m', 'two\n\nbody']);
    const head = (await listCommits(repo.dir))[0].sha;
    repo.write('b.txt', 'two-more\n');
    repo.git(['add', 'b.txt']);
    await git.updateCommit(repo.dir, head);
    const after = await listCommits(repo.dir);
    assert.deepEqual(
      after.map((entry) => entry.subject),
      ['two', 'one'],
    );
    assert.equal(repo.read('b.txt'), 'two-more\n');
    assert.equal(
      await git.commitMessage(repo.dir, after[0].sha),
      'two\n\nbody',
    );
    repo.write('a.txt', 'one-more\n');
    repo.git(['add', 'a.txt']);
    await git.updateCommit(repo.dir, after[1].sha);
    const folded = await listCommits(repo.dir);
    assert.deepEqual(
      folded.map((entry) => entry.subject),
      ['two', 'one'],
    );
    assert.equal(repo.read('a.txt'), 'one-more\n');
    assert.equal(repo.read('b.txt'), 'two-more\n');
    assert.equal(await git.commitMessage(repo.dir, folded[1].sha), 'one');
  } finally {
    repo.cleanup();
  }
});

test('commitChanges fixup writes the given message', async () => {
  const repo = makeRepo();
  try {
    repo.write('f.txt', 'a\n');
    repo.git(['add', 'f.txt']);
    repo.git(['commit', '-m', 'init']);
    repo.write('f.txt', 'b\n');
    repo.git(['add', 'f.txt']);
    await commitChanges(repo.dir, 'fixup', 'fixup! init');
    const subject = repo.git(['log', '-1', '--format=%s']).trim();
    assert.equal(subject, 'fixup! init');
  } finally {
    repo.cleanup();
  }
});

test('load includes the current branch', async () => {
  const repo = makeRepo();
  try {
    repo.write('f.txt', 'a\n');
    repo.git(['add', 'f.txt']);
    repo.git(['commit', '-m', 'init']);
    const loaded = await load(repo.dir, [], { deferExtras: false });
    assert.equal(loaded.branch, 'main');
    assert.equal(await currentBranch(repo.dir), 'main');
  } finally {
    repo.cleanup();
  }
});
