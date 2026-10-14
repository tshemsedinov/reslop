'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const dir = require('../lib/git/dir.js');
const linked = require('../lib/git/linked.js');
const { parseWorktrees, listWorktrees, addWorktree } = linked;
const { removeWorktree, isDirty, dirKey } = linked;
const dashboard = require('../lib/dashboard/worktrees.js');
const { expandWorkspace, readWorkspace } = dashboard;
const { workspaceAt } = require('../lib/dashboard/workspace.js');
const watch = require('../lib/dashboard/watch.js');
const { DiskWatcher, ignoredRel } = watch;
const { run, loadSession, parseArgv } = require('../lib/cli.js');
const { renderFrame } = require('../lib/render/render.js');
const { actionFromKey } = require('../lib/input/actions.js');
const { stripAnsi } = require('../lib/term/ansi.js');
const { sink, tempDir, removeTree } = require('./helpers.js');

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};

const wait = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const waitUntil = async (check, ms = 4000) => {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (check()) return true;
    await wait(25);
  }
  return false;
};

const git = (cwd, args) => {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: gitEnv,
  });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || 'git failed').trim());
  }
  return result.stdout;
};

const initRepo = (where) => {
  fs.mkdirSync(where, { recursive: true });
  git(where, ['init', '-b', 'main']);
  git(where, ['config', 'user.email', 'test@example.com']);
  git(where, ['config', 'user.name', 'Test']);
  git(where, ['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(where, 'app.js'), 'const n = 1;\n');
  git(where, ['add', '.']);
  git(where, ['commit', '-m', 'init']);
};

const fakeProc = (cwd, argv) => {
  const stdout = sink();
  const stderr = sink();
  return {
    argv,
    cwd: () => cwd,
    stdin: { isTTY: false },
    stdout,
    stderr,
    env: {},
  };
};

const stopSession = (session) => {
  session.loader.abort();
  session.lifecycle.stopWatch();
  session.dashboard.stop();
  session.workspace.stop();
  session.progress.clear();
  session.term.clearTimers();
};

const same = (left, right) => assert.equal(dirKey(left), dirKey(right));

const PORCELAIN = [
  'worktree /repo/app',
  'HEAD 1111111111111111111111111111111111111111',
  'branch refs/heads/main',
  '',
  'worktree /repo/app-feature',
  'HEAD 2222222222222222222222222222222222222222',
  'branch refs/heads/feature/x',
  'locked in use',
  '',
  'worktree /repo/app-detached',
  'HEAD 3333333333333333333333333333333333333333',
  'detached',
  'prunable gitdir file points to non-existent location',
  '',
].join('\n');

test('worktree list is parsed from the porcelain output', () => {
  const list = parseWorktrees(PORCELAIN);
  assert.equal(list.length, 3);
  assert.equal(list[0].main, true);
  assert.equal(list[0].branch, 'main');
  assert.equal(list[1].main, false);
  assert.equal(list[1].branch, 'feature/x');
  assert.equal(list[1].locked, true);
  assert.equal(list[1].lockReason, 'in use');
  assert.equal(list[2].detached, true);
  assert.equal(list[2].branch, '');
  assert.equal(list[2].prunable, true);
  assert.deepEqual(parseWorktrees(''), []);
  const bare = parseWorktrees('worktree /repo.git\nbare\n');
  assert.equal(bare[0].bare, true);
});

test('git directories are resolved when .git is a file', async () => {
  const root = tempDir('reslop-wt-');
  try {
    const app = path.join(root, 'app');
    initRepo(app);
    const other = await addWorktree(app, path.join(root, 'other'), 'topic');
    const main = dir.resolveGitDirs(app);
    assert.equal(main.linked, false);
    assert.equal(main.gitDir, path.join(app, '.git'));
    assert.ok(fs.statSync(path.join(other, '.git')).isFile());
    const found = dir.resolveGitDirs(other);
    assert.equal(found.linked, true);
    same(found.commonDir, path.join(app, '.git'));
    assert.match(found.gitDir.split(path.sep).join('/'), /\.git\/worktrees\//);
    assert.equal(dir.resolveGitDirs(root), null);
  } finally {
    await removeTree(root);
  }
});

test('worktrees are added, listed and removed with git', async () => {
  const root = tempDir('reslop-wt-');
  try {
    const app = path.join(root, 'app');
    initRepo(app);
    const first = await addWorktree(app, path.join(root, 'one'), 'feature/one');
    same(first, path.join(root, 'one'));
    git(app, ['branch', 'older']);
    await addWorktree(app, path.join(root, 'two'), 'older');
    const list = await listWorktrees(app);
    assert.deepEqual(
      list.map((it) => [path.basename(it.path), it.branch, it.main]),
      [
        ['app', 'main', true],
        ['one', 'feature/one', false],
        ['two', 'older', false],
      ],
    );
    await assert.rejects(
      addWorktree(app, path.join(root, 'three'), 'older'),
      /already (checked out|used by worktree)/,
    );
    await assert.rejects(addWorktree(app, path.join(root, 'x'), '-bad'), /bad/);
    await assert.rejects(addWorktree(app, path.join(root, 'x'), ' '), /empty/);
    const inside = await listWorktrees(first);
    assert.equal(inside.length, 3);
    assert.equal(inside[0].main, true);
    await removeWorktree(app, first);
    assert.equal(fs.existsSync(first), false);
    assert.equal((await listWorktrees(app)).length, 2);
    assert.match(git(app, ['branch', '--list', 'feature/one']), /feature\/one/);
  } finally {
    await removeTree(root);
  }
});

test('a worktree with changes, a lock or the main one is kept', async () => {
  const root = tempDir('reslop-wt-');
  try {
    const app = path.join(root, 'app');
    initRepo(app);
    const one = await addWorktree(app, path.join(root, 'one'), 'one');
    assert.equal(await isDirty(one), false);
    fs.writeFileSync(path.join(one, 'app.js'), 'changed\n');
    assert.equal(await isDirty(one), true);
    await assert.rejects(removeWorktree(app, one), /uncommitted changes/);
    git(one, ['checkout', '--', 'app.js']);
    fs.writeFileSync(path.join(one, 'new.js'), 'new\n');
    await assert.rejects(removeWorktree(app, one), /uncommitted changes/);
    fs.rmSync(path.join(one, 'new.js'));
    fs.mkdirSync(path.join(one, '.plan'));
    fs.writeFileSync(path.join(one, '.plan', 'x.md'), 'plan\n');
    fs.mkdirSync(path.join(one, '.log'));
    fs.writeFileSync(path.join(one, '.log', 'x.log'), 'log\n');
    fs.writeFileSync(path.join(one, '.gitignore'), '.plan\n.log\n');
    git(one, ['add', '.gitignore']);
    git(one, ['commit', '-m', 'ignore']);
    assert.equal(await isDirty(one), false);
    git(app, ['worktree', 'lock', '--reason', 'busy', one]);
    await assert.rejects(removeWorktree(app, one), /locked: busy/);
    assert.equal(fs.existsSync(one), true);
    git(app, ['worktree', 'unlock', one]);
    await assert.rejects(removeWorktree(app, app), /main worktree/);
    await assert.rejects(removeWorktree(app, root), /not a worktree/);
    await removeWorktree(app, one);
    assert.equal(fs.existsSync(one), false);
  } finally {
    await removeTree(root);
  }
});

test('a detached head worktree is listed without a branch', async () => {
  const root = tempDir('reslop-wt-');
  try {
    const app = path.join(root, 'app');
    initRepo(app);
    git(app, ['worktree', 'add', '--detach', path.join(root, 'loose')]);
    const list = await listWorktrees(app);
    assert.equal(list[1].detached, true);
    assert.equal(list[1].branch, '');
    const info = await expandWorkspace(workspaceAt(root));
    const loose = info.repos.find((row) => row.name === 'loose');
    assert.equal(loose.detached, true);
    assert.equal(loose.head.length, 7);
  } finally {
    await removeTree(root);
  }
});

test('a folder lists worktrees in groups, in and out of it', async () => {
  const root = tempDir('reslop-wt-');
  const away = tempDir('reslop-wt-away-');
  try {
    initRepo(path.join(root, 'beta'));
    initRepo(path.join(root, 'app'));
    await addWorktree(path.join(root, 'app'), path.join(root, 'app-a'), 'a');
    await addWorktree(path.join(root, 'app'), path.join(away, 'far'), 'far');
    const info = await readWorkspace(workspaceAt(root));
    assert.deepEqual(
      info.repos.map((row) => [row.name, row.group, row.main]),
      [
        ['app', 'app', true],
        ['app-a', 'app', false],
        ['far', 'app', false],
        ['beta', 'beta', true],
      ],
    );
    same(info.repos[2].dir, path.join(away, 'far'));
    assert.equal(info.repos[1].linked, true);
    assert.equal(info.repos[1].branch, 'a');
    assert.equal(info.repos[2].branch, 'far');
    assert.equal(info.repos[3].linked, false);
    assert.equal(new Set(info.repos.map((row) => row.name)).size, 4);
  } finally {
    await removeTree(root);
    await removeTree(away);
  }
});

test('a repository that is no worktree list stays one tile', async () => {
  const root = tempDir('reslop-wt-');
  try {
    initRepo(path.join(root, 'solo'));
    const info = await expandWorkspace(workspaceAt(root));
    assert.equal(info.repos.length, 1);
    assert.equal(info.repos[0].main, true);
    assert.equal(info.repos[0].branch, 'main');
  } finally {
    await removeTree(root);
  }
});

test('the watcher sees the git changes of a linked worktree', async () => {
  const root = tempDir('reslop-wt-');
  let watcher = null;
  try {
    const app = path.join(root, 'app');
    initRepo(app);
    const one = await addWorktree(app, path.join(root, 'one'), 'one');
    let changes = 0;
    await wait(20);
    watcher = new DiskWatcher({ root: one, onChange: () => (changes += 1) });
    assert.equal(watcher.gitBases.length, 2);
    fs.writeFileSync(path.join(one, 'later.js'), 'x\n');
    git(one, ['add', 'later.js']);
    assert.equal(await waitUntil(() => changes > 0, 2000), true);
    const seen = changes;
    git(one, ['commit', '-m', 'later']);
    assert.equal(await waitUntil(() => changes > seen, 2000), true);
    const index = path.join(watcher.gitBases[0], 'index');
    assert.equal(watcher.relOf(index), '.git/index');
    assert.equal(
      watcher.relOf(path.join(watcher.gitBases[1], 'refs', 'heads')),
      '.git/refs/heads',
    );
    assert.equal(watcher.relOf(path.join(one, 'later.js')), 'later.js');
  } finally {
    if (watcher) watcher.close();
    await removeTree(root);
  }
});

test('git files of linked worktrees are told from their noise', () => {
  assert.equal(ignoredRel('.git/worktrees/one/index'), false);
  assert.equal(ignoredRel('.git/worktrees/one/HEAD'), false);
  assert.equal(ignoredRel('.git/worktrees/one/index.lock'), true);
  assert.equal(ignoredRel('.git/worktrees/one/COMMIT_EDITMSG'), true);
  assert.equal(ignoredRel('../app/.git/worktrees/one/index'), false);
  assert.equal(ignoredRel('../app/.git/objects/aa/bb'), true);
  assert.equal(ignoredRel('app/.git/index'), false);
  assert.equal(ignoredRel('app/.git/objects/pack/x'), true);
});

test('the keys of worktrees belong to the repos and dashboard screens', () => {
  assert.equal(actionFromKey('insert', 'repos'), 'worktreeNew');
  assert.equal(actionFromKey('delete', 'repos'), 'worktreeDrop');
  assert.equal(actionFromKey('w', 'dashboard'), 'worktrees');
  assert.equal(actionFromKey('w', 'packages'), 'packageWanted');
});

const readyRows = (session) =>
  session.workspace.rows.every(
    (row) => row.filesReady && row.commitsReady && row.diffReady,
  );

test('worktrees are created and removed on the repos screen', async () => {
  const root = tempDir('reslop-wt-');
  let session = null;
  try {
    const app = path.join(root, 'app');
    initRepo(app);
    initRepo(path.join(root, 'beta'));
    const proc = fakeProc(root, ['node', 'reslop', root]);
    session = await loadSession(proc, {}, parseArgv([root]));
    assert.equal(session.pane, 'repos');
    session.workspace.start();
    assert.equal(await waitUntil(() => readyRows(session)), true);
    assert.deepEqual(
      session.workspace.rows.map((row) => row.name),
      ['app', 'beta'],
    );
    session.handleEvent({ type: 'key', key: 'insert' });
    assert.equal(session.mode, 'compose');
    session.draw();
    session.pushInput('feature/x');
    session.handleEvent({ type: 'key', key: 'enter' });
    await session.ops.idle();
    assert.equal(session.mode, 'review');
    assert.equal(session.status, 'created feature/x');
    const names = session.workspace.rows.map((row) => row.name);
    assert.deepEqual(names, ['app', 'app-feature-x', 'beta']);
    const made = session.workspace.rows[1];
    assert.equal(session.workspace.cursor, 1);
    assert.equal(made.linked, true);
    assert.equal(made.group, 'app');
    assert.equal(made.branch, 'feature/x');
    assert.ok(fs.statSync(path.join(root, 'app-feature-x', '.git')).isFile());
    assert.equal(await waitUntil(() => readyRows(session)), true);
    const frame = renderFrame(session.view(), {
      width: 120,
      height: 30,
      color: false,
    });
    const text = stripAnsi(frame.text);
    assert.match(text, /↳ app-feature-x +⎇ feature\/x/);
    assert.match(text, /app +⎇ main/);
    fs.writeFileSync(path.join(made.dir, 'extra.js'), 'x\n');
    session.workspace.notePaths(['app-feature-x/extra.js']);
    assert.equal(await waitUntil(() => made.dirty), true);
    assert.equal(session.workspace.rows[0].dirty, false);
    session.dispatch('worktreeDrop');
    assert.equal(session.mode, 'confirmWorktree');
    session.draw();
    const asked = stripAnsi(session.lastFrame.rows.join('\n'));
    assert.match(asked, /remove worktree app-feature-x\?/);
    session.handleEvent({ type: 'key', key: 'y' });
    await session.ops.idle();
    assert.equal(session.mode, 'review');
    assert.match(session.status, /uncommitted changes/);
    assert.equal(session.workspace.rows.length, 3);
    assert.equal(fs.existsSync(made.dir), true);
    fs.rmSync(path.join(made.dir, 'extra.js'));
    session.dispatch('worktreeDrop');
    session.handleEvent({ type: 'key', key: 'n' });
    assert.equal(session.mode, 'review');
    assert.equal(fs.existsSync(made.dir), true);
    session.dispatch('worktreeDrop');
    session.handleEvent({ type: 'key', key: 'y' });
    await session.ops.idle();
    assert.equal(session.status, 'removed app-feature-x');
    assert.deepEqual(
      session.workspace.rows.map((row) => row.name),
      ['app', 'beta'],
    );
    assert.equal(fs.existsSync(made.dir), false);
    session.workspace.cursor = 0;
    session.dispatch('worktreeDrop');
    assert.equal(session.mode, 'review');
    assert.equal(session.status, 'the main worktree stays');
  } finally {
    if (session) stopSession(session);
    await removeTree(root);
  }
});

test('a linked worktree opens like a repository of its own', async () => {
  const root = tempDir('reslop-wt-');
  let session = null;
  try {
    const app = path.join(root, 'app');
    initRepo(app);
    const one = await addWorktree(app, path.join(root, 'one'), 'one');
    fs.writeFileSync(path.join(one, 'app.js'), 'const n = 2;\n');
    fs.mkdirSync(path.join(one, '.plan'));
    fs.writeFileSync(path.join(one, '.plan', '2026-10-14-00.md'), '# one\n');
    const proc = fakeProc(root, ['node', 'reslop', root]);
    session = await loadSession(proc, {}, parseArgv([root]));
    session.workspace.start();
    assert.equal(await waitUntil(() => readyRows(session)), true);
    const row = session.workspace.byName.get('one');
    assert.equal(row.diff.unstagedAdded > 0, true);
    assert.equal(session.workspace.byName.get('app').diff.unstagedAdded, 0);
    assert.equal(row.dirty, true);
    assert.equal(row.tasksReady, true);
    await session.workspace.enter('one');
    assert.equal(session.pane, 'dashboard');
    same(session.cwd, one);
    same(session.top, one);
    await session.loader.promise;
    assert.equal(session.items.length, 1);
    assert.equal(session.items[0].file.newPath, 'app.js');
    assert.equal(session.branch, 'one');
    const planned = session.review.store.reviewPath;
    same(path.dirname(planned), path.join(one, '.plan'));
    session.loader.abort();
    await session.loader.promise;
    await session.workspace.show();
    assert.equal(session.pane, 'repos');
    await session.workspace.enter('app');
    assert.equal(await waitUntil(() => session.loader.didLoad), true);
    assert.equal(fs.existsSync(path.join(app, '.plan')), false);
  } finally {
    if (session) stopSession(session);
    await removeTree(root);
  }
});

test('the worktrees of a repository open from its dashboard', async () => {
  const root = tempDir('reslop-wt-');
  let session = null;
  try {
    const app = path.join(root, 'app');
    initRepo(app);
    const one = await addWorktree(app, path.join(root, 'one'), 'one');
    const proc = fakeProc(one, ['node', 'reslop']);
    session = await loadSession(proc, {}, parseArgv([]));
    assert.equal(session.pane, 'dashboard');
    assert.equal(session.workspaceRoot, '');
    session.handleEvent({ type: 'key', key: 'w' });
    await session.ops.idle();
    assert.equal(session.pane, 'repos');
    const rows = session.workspace.rows;
    assert.deepEqual(
      rows.map((row) => row.name),
      ['app', 'one'],
    );
    assert.equal(rows[session.workspace.cursor].linked, true);
    session.handleEvent({ type: 'key', key: 'escape' });
    await session.ops.idle();
    assert.equal(session.pane, 'dashboard');
    same(session.cwd, one);
    session.loader.abort();
    await session.loader.promise;
    session.handleEvent({ type: 'key', key: 'w' });
    await session.ops.idle();
    session.handleEvent({ type: 'key', key: 'left' });
    session.handleEvent({ type: 'key', key: 'enter' });
    await session.ops.idle();
    assert.equal(session.pane, 'dashboard');
    same(session.cwd, app);
    session.loader.abort();
    await session.loader.promise;
    session.handleEvent({ type: 'key', key: 'escape' });
    assert.equal(session.done, true);
  } finally {
    if (session) stopSession(session);
    await removeTree(root);
  }
});

test('a read only session does not change worktrees', async () => {
  const root = tempDir('reslop-wt-');
  let session = null;
  try {
    const app = path.join(root, 'app');
    initRepo(app);
    await addWorktree(app, path.join(root, 'one'), 'one');
    const proc = fakeProc(root, ['node', 'reslop', '-r', root]);
    session = await loadSession(proc, {}, parseArgv(['-r', root]));
    assert.equal(session.pane, 'repos');
    assert.equal(session.workspace.rows.length, 0);
    session.workspace.start();
    session.dispatch('worktreeNew');
    assert.equal(session.mode, 'review');
    assert.equal(session.status, 'read only');
    session.workspace.cursor = 1;
    session.dispatch('worktreeDrop');
    assert.equal(session.mode, 'review');
    assert.equal(session.status, 'read only');
    assert.equal(fs.existsSync(path.join(root, 'one')), true);
  } finally {
    if (session) stopSession(session);
    await removeTree(root);
  }
});

test('the output of cli stays the same for a plain folder', async () => {
  const root = tempDir('reslop-wt-');
  try {
    initRepo(path.join(root, 'solo'));
    const quiet = fakeProc(root, ['node', 'reslop', root]);
    assert.equal(await run(quiet), 1);
    assert.match(quiet.stderr.dump(), /interactive terminal required/);
  } finally {
    await removeTree(root);
  }
});
