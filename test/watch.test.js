'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { Session } = require('../lib/session.js');
const items = require('../lib/session/items.js');
const { restoredIndex } = items;
const watch = require('../lib/session/watch.js');
const { ignoredRel, createDiskWatcher } = watch;
const { sink } = require('./helpers.js');

const sampleItem = (name, extra = {}) => ({
  origin: extra.origin ?? 'unstaged',
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
    oldStart: extra.oldStart ?? 1,
    oldCount: 1,
    newStart: extra.newStart ?? 1,
    newCount: 1,
    header: '@@ -1,1 +1,1 @@',
    lines: [{ type: 'add', text: extra.text ?? 'x', noNl: false, blockId: 0 }],
  },
  blockId: 0,
});

const reviewFs = {
  readdirSync: () => [],
  readFileSync: () => {
    const error = new Error('ENOENT');
    error.code = 'ENOENT';
    throw error;
  },
  writeFileSync: () => {},
  mkdirSync: () => {},
  now: () => new Date(2026, 8, 7),
};

const fakeWatch = () => {
  const watchers = [];
  const watchFn = (target, opts, listener) => {
    const watcher = {
      target,
      opts,
      listener,
      closed: false,
      close() {
        watcher.closed = true;
      },
    };
    watchers.push(watcher);
    return watcher;
  };
  return { watch: watchFn, watchers };
};

const fakeClock = () => {
  const queued = [];
  const setTimeoutFn = (fn) => {
    queued.push(fn);
    return queued.length;
  };
  const clearTimeoutFn = (id) => {
    queued[id - 1] = null;
  };
  const flush = () => {
    const fns = queued.splice(0);
    for (const fn of fns) {
      if (fn) fn();
    }
  };
  return {
    queued,
    setTimeout: setTimeoutFn,
    clearTimeout: clearTimeoutFn,
    flush,
  };
};

const mockRepo = (initial) => {
  let current = [...initial];
  return {
    load: () => ({ top: '/tmp/repo', items: [...current], branch: 'main' }),
    setItems: (next) => {
      current = [...next];
    },
  };
};

const openWatched = (list, extra = {}) => {
  const repo = extra.repo ?? mockRepo(list);
  const clock = extra.clock ?? fakeClock();
  const fsWatch = extra.fsWatch ?? fakeWatch();
  const session = new Session({
    cwd: '/tmp/repo',
    stdout: sink(),
    color: false,
    getSize: () => ({ width: 80, height: 16 }),
    startPane: extra.startPane ?? 'diff',
    setInterval: () => 1,
    clearInterval: () => {},
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    watch: fsWatch.watch,
    watchReaddir: extra.watchReaddir ?? (() => []),
    watchStat: extra.watchStat ?? (() => ({ isDirectory: () => true })),
    watchRecursive: false,
    watchDebounceMs: extra.watchDebounceMs ?? 20,
    ...reviewFs,
    ...extra,
    repo,
  });
  session.load();
  return { session, repo, clock, fsWatch };
};

test('linux recursive watch is available from Node 19.1', () => {
  const { canWatchRecursive } = watch;
  assert.equal(canWatchRecursive('linux', '18.20.0'), false);
  assert.equal(canWatchRecursive('linux', '19.0.0'), false);
  assert.equal(canWatchRecursive('linux', '19.1.0'), true);
  assert.equal(canWatchRecursive('linux', '22.11.0'), true);
  assert.equal(canWatchRecursive('win32', '18.20.0'), true);
});

test('startWatch also watches parent dirs of review files', () => {
  const nested = sampleItem('src/nested.js');
  const { session, fsWatch } = openWatched([nested]);
  session.uiOpen = true;
  session.lifecycle.startWatch();
  const parent = path.join('/tmp/repo', 'src');
  assert.ok(fsWatch.watchers.some((entry) => entry.target === parent));
  session.lifecycle.stopWatch();
});

test('ignoredRel skips review, modules, and git internals', () => {
  assert.equal(ignoredRel('.review/x.md'), true);
  assert.equal(ignoredRel('node_modules/x'), true);
  assert.equal(ignoredRel('.git/objects/aa'), true);
  assert.equal(ignoredRel('.git/index.lock'), true);
  assert.equal(ignoredRel('.git/COMMIT_EDITMSG'), true);
  assert.equal(ignoredRel('.git/index'), false);
  assert.equal(ignoredRel('.git/HEAD'), false);
  assert.equal(ignoredRel('.git/refs/heads/main'), false);
  assert.equal(ignoredRel('src/a.js'), false);
  assert.equal(ignoredRel('a.js.swp'), true);
});

test('disk watcher debounces changes and ignores lock files', () => {
  const clock = fakeClock();
  const fsWatch = fakeWatch();
  let n = 0;
  const watcher = createDiskWatcher({
    root: '/tmp/repo',
    watch: fsWatch.watch,
    readdirSync: () => [],
    statSync: () => ({ isDirectory: () => true }),
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    debounceMs: 20,
    recursive: false,
    onChange: () => {
      n += 1;
    },
  });
  const gitDir = path.join('/tmp/repo', '.git');
  const git = fsWatch.watchers.find((entry) => entry.target === gitDir);
  const root = fsWatch.watchers.find((entry) => entry.target === '/tmp/repo');
  assert.ok(git);
  assert.ok(root);
  git.listener('change', 'index.lock');
  assert.equal(clock.queued.filter(Boolean).length, 0);
  git.listener('change', 'index');
  root.listener('change', 'a.js');
  assert.equal(clock.queued.filter(Boolean).length, 1);
  clock.flush();
  assert.equal(n, 1);
  watcher.close();
  assert.equal(
    fsWatch.watchers.every((entry) => entry.closed),
    true,
  );
});

test('restoredIndex keeps a shifted hunk on the same file', () => {
  const before = sampleItem('a.js', { oldStart: 1, newStart: 1 });
  const moved = sampleItem('a.js', { oldStart: 40, newStart: 40 });
  const other = sampleItem('b.js');
  assert.equal(restoredIndex([moved, other], before), 0);
  assert.equal(restoredIndex([other, moved], before), 1);
});

test('disk watch reloads without leaving the current screen', () => {
  const a = sampleItem('a.js');
  const b = sampleItem('b.js');
  const c = sampleItem('c.js');
  const { session, repo } = openWatched([a, b]);
  session.uiOpen = true;
  session.dispatch('next');
  session.scroll = 6;
  session.selection = { start: { x: 1, y: 1 }, end: { x: 2, y: 1 } };
  session.dismissed.add('unstaged:gone.js:1:1:0');
  session.status = 'staged';
  repo.setItems([a, b, c]);
  session.lifecycle.onDiskChange();
  assert.equal(session.pane, 'diff');
  assert.equal(session.current().file.newPath, 'b.js');
  assert.equal(session.scroll, 6);
  assert.deepEqual(session.selection, {
    start: { x: 1, y: 1 },
    end: { x: 2, y: 1 },
  });
  assert.equal(session.items.length, 3);
  assert.equal(session.dismissed.size, 1);
  assert.equal(session.status, 'staged');
  assert.equal(session.busy, '');
  assert.equal(session.mode, 'review');
});

test('disk watch keeps the files pane on the same path', () => {
  const a = sampleItem('a.js');
  const b = sampleItem('b.js');
  const extra = sampleItem('0.js');
  const { session, repo } = openWatched([a, b], { startPane: 'files' });
  session.uiOpen = true;
  session.dispatch('next');
  assert.equal(session.fileList()[session.fileCursor].path, 'a.js');
  repo.setItems([extra, a, b]);
  session.lifecycle.onDiskChange();
  assert.equal(session.pane, 'files');
  assert.equal(session.fileList()[session.fileCursor].path, 'a.js');
  assert.equal(session.busy, '');
});

test('disk watch follows a hunk whose line numbers moved', () => {
  const before = sampleItem('a.js', { oldStart: 1, newStart: 1 });
  const moved = sampleItem('a.js', { oldStart: 12, newStart: 12, text: 'y' });
  const { session, repo } = openWatched([before]);
  session.uiOpen = true;
  session.scroll = 4;
  repo.setItems([moved]);
  session.lifecycle.onDiskChange();
  assert.equal(session.current().hunk.newStart, 12);
  assert.equal(session.current().file.newPath, 'a.js');
  assert.equal(session.scroll, 4);
  assert.equal(session.pane, 'diff');
});

test('compose defers disk reload until the editor closes', () => {
  const a = sampleItem('a.js');
  const b = sampleItem('b.js');
  const { session, repo, clock } = openWatched([a]);
  session.uiOpen = true;
  session.dispatch('feedback');
  repo.setItems([a, b]);
  session.lifecycle.onDiskChange();
  assert.equal(session.mode, 'compose');
  assert.equal(session.items.length, 1);
  assert.equal(session.editor.text, '');
  session.handleEvent({ type: 'key', key: 'escape' });
  assert.equal(session.mode, 'review');
  clock.flush();
  assert.equal(session.items.length, 2);
  assert.equal(session.current().file.newPath, 'a.js');
});

test('busy git work defers disk reload', () => {
  const a = sampleItem('a.js');
  const b = sampleItem('b.js');
  const { session, repo, clock } = openWatched([a]);
  session.uiOpen = true;
  session.gitBusy = true;
  repo.setItems([a, b]);
  session.lifecycle.onDiskChange();
  assert.equal(session.items.length, 1);
  session.gitBusy = false;
  clock.flush();
  assert.equal(session.items.length, 2);
});

test('commit reviews do not start a disk watcher', () => {
  const fsWatch = fakeWatch();
  const { session } = openWatched([sampleItem('a.js')], {
    rev: 'abc1234',
    fsWatch,
  });
  session.uiOpen = true;
  session.lifecycle.startWatch();
  assert.equal(fsWatch.watchers.length, 0);
});

test('worktree watch starts and stops fs watchers', () => {
  const fsWatch = fakeWatch();
  const { session } = openWatched([sampleItem('a.js')], { fsWatch });
  session.uiOpen = true;
  session.lifecycle.startWatch();
  assert.ok(fsWatch.watchers.length > 0);
  session.lifecycle.stopWatch();
  assert.equal(
    fsWatch.watchers.every((entry) => entry.closed),
    true,
  );
});

test('npm extras do not block a disk reload', () => {
  const a = sampleItem('a.js');
  const b = sampleItem('b.js');
  const { session, repo } = openWatched([a]);
  session.uiOpen = true;
  session.busy = 'checking npm';
  repo.setItems([a, b]);
  session.lifecycle.onDiskChange();
  assert.equal(session.items.length, 2);
  assert.equal(session.pane, 'diff');
});

test('diff pane poll reloads when the current file changes', () => {
  const before = sampleItem('a.js', { text: 'old' });
  const after = sampleItem('a.js', { text: 'new' });
  const stats = new Map();
  stats.set(path.join('/tmp/repo', 'a.js'), { mtimeMs: 1, size: 3 });
  const { session, repo } = openWatched([before], {
    watchStat: (target) => {
      const st = stats.get(target);
      if (!st) return { isDirectory: () => true, mtimeMs: 0, size: 0 };
      return { isDirectory: () => false, ...st };
    },
  });
  session.uiOpen = true;
  session.lifecycle.pollCurrentFile();
  assert.equal(session.current().hunk.lines[0].text, 'old');
  repo.setItems([after]);
  stats.set(path.join('/tmp/repo', 'a.js'), { mtimeMs: 2, size: 3 });
  session.lifecycle.pollCurrentFile();
  assert.equal(session.current().hunk.lines[0].text, 'new');
  assert.equal(session.pane, 'diff');
  assert.equal(session.busy, '');
});

test('files pane poll does not reload', () => {
  const a = sampleItem('a.js');
  const b = sampleItem('b.js');
  const { session, repo } = openWatched([a], { startPane: 'files' });
  session.uiOpen = true;
  session.lifecycle.pollCurrentFile();
  repo.setItems([a, b]);
  session.lifecycle.pollCurrentFile();
  assert.equal(session.items.length, 1);
});

test('async disk watch does not flash a loading state', async () => {
  const a = sampleItem('a.js');
  const b = sampleItem('b.js');
  let items = [a];
  const { session } = openWatched([a], {
    repo: {
      load: () => ({ top: '/tmp/repo', items: [...items], branch: 'main' }),
      loadAsync: async () => ({
        top: '/tmp/repo',
        items: [...items],
        branch: 'main',
      }),
    },
  });
  session.uiOpen = true;
  session.scroll = 3;
  items = [a, b];
  await new Promise((resolve) => {
    session.refreshFromRepo({
      keepView: true,
      quiet: true,
      afterLoad: resolve,
    });
  });
  assert.equal(session.items.length, 2);
  assert.equal(session.scroll, 3);
  assert.equal(session.busy, '');
  assert.equal(session.status, '');
  assert.equal(session.pane, 'diff');
});

test('watch reload skips npm extras if package files are same', async () => {
  const gitItem = sampleItem('a.js');
  const extraItem = sampleItem('package.json');
  extraItem.dep = { change: { name: 'lodash', section: 'dependencies' } };
  let extras = 0;
  const pkg = { mtimeMs: 1, size: 10, isDirectory: () => false };
  const { session } = openWatched([gitItem], {
    audit: true,
    watchStat: (target) => {
      if (`${target}`.endsWith('package.json')) return pkg;
      if (`${target}`.endsWith('package-lock.json')) return pkg;
      return { isDirectory: () => true, mtimeMs: 0, size: 0 };
    },
    repo: {
      load: () => ({ top: '/tmp/repo', items: [gitItem], branch: 'main' }),
      loadAsync: async (_cwd, _paths, options = {}) => {
        const items = [gitItem];
        if (options.auditMap || options.outdatedMap) items.push(extraItem);
        return {
          top: '/tmp/repo',
          items,
          pending: options.deferExtras === true,
        };
      },
      loadExtras: async () => {
        extras += 1;
        return {
          top: '/tmp/repo',
          items: [gitItem, extraItem],
          pending: false,
          auditMap: { lodash: 1 },
          outdatedMap: null,
        };
      },
    },
  });
  session.uiOpen = true;
  session.loader.didLoad = false;
  await session.openLoad();
  assert.equal(extras, 1);
  assert.equal(session.items.length, 2);
  await new Promise((resolve) => {
    session.refreshFromRepo({
      keepView: true,
      quiet: true,
      afterLoad: resolve,
    });
  });
  assert.equal(extras, 1);
  assert.equal(session.items.length, 2);
  assert.equal(session.busy, '');
});

test('watch reload runs npm extras when package.json changes', async () => {
  const gitItem = sampleItem('a.js');
  let extras = 0;
  const pkg = { mtimeMs: 1, size: 10, isDirectory: () => false };
  const { session } = openWatched([gitItem], {
    audit: true,
    watchStat: (target) => {
      if (`${target}`.endsWith('package.json')) return pkg;
      if (`${target}`.endsWith('package-lock.json')) return pkg;
      return { isDirectory: () => true, mtimeMs: 0, size: 0 };
    },
    repo: {
      load: () => ({ top: '/tmp/repo', items: [gitItem], branch: 'main' }),
      loadAsync: async (_cwd, _paths, options = {}) => ({
        top: '/tmp/repo',
        items: [gitItem],
        pending: options.deferExtras === true,
      }),
      loadExtras: async () => {
        extras += 1;
        return {
          top: '/tmp/repo',
          items: [gitItem],
          pending: false,
          auditMap: { lodash: extras },
          outdatedMap: null,
        };
      },
    },
  });
  session.uiOpen = true;
  session.loader.didLoad = false;
  await session.openLoad();
  assert.equal(extras, 1);
  pkg.mtimeMs = 2;
  await new Promise((resolve) => {
    session.refreshFromRepo({
      keepView: true,
      quiet: true,
      afterLoad: resolve,
    });
  });
  assert.equal(extras, 2);
});
