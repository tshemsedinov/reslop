'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Session } = require('../lib/session/session.js');
const { OpsRunner } = require('../lib/session/ops.js');
const helpers = require('./helpers.js');
const { uiSink, tempDir, press, click } = helpers;
const review = require('../lib/review/review.js');
const { ReviewStore, serializeReview } = review;
const ansi = require('../lib/term/ansi.js');
const { stripAnsi } = ansi;
const { REVIEW_DIR } = require('../lib/common/files.js');
const { setImmediate: settle } = require('node:timers/promises');
const sessionHelpers = require('./session-helpers.js');
const { today, sampleItem, mockRepo, openSession } = sessionHelpers;
const { clickStatusChoice, clickFooter } = sessionHelpers;

const hunkPair = (name) => {
  const file = {
    oldPath: name,
    newPath: name,
    isNew: false,
    isDeleted: false,
    isBinary: false,
    preamble: [`diff --git a/${name} b/${name}`],
    hunks: [],
  };
  const hunk = {
    oldStart: 1,
    oldCount: 3,
    newStart: 1,
    newCount: 3,
    header: '@@ -1,3 +1,3 @@',
    lines: [
      { type: 'del', text: 'a', noNl: false, blockId: 0 },
      { type: 'add', text: 'A', noNl: false, blockId: 0 },
      { type: 'ctx', text: 'mid', noNl: false, blockId: null },
      { type: 'del', text: 'c', noNl: false, blockId: 1 },
      { type: 'add', text: 'C', noNl: false, blockId: 1 },
    ],
  };
  const first = {
    origin: 'unstaged',
    file,
    hunk,
    blockId: 0,
    patchAdd: 'add0',
    patchRevert: 'rev0',
  };
  const second = {
    origin: 'unstaged',
    file,
    hunk,
    blockId: 1,
    patchAdd: 'add1',
    patchRevert: 'rev1',
  };
  return [first, second];
};

test('load applies imported GitHub notes on a new review', async () => {
  const item = sampleItem('lib/parser.js', 'pr');
  const cwd = tempDir('reslop-ui-');
  const imported = {
    blockTasks: [
      {
        where: 'lib/parser.js:1',
        origin: 'pr',
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
      top: cwd,
      items: [item],
      imported,
      sourceLabel: '#123',
    }),
    add: () => {},
    unstage: () => {},
    revert: () => {},
  };
  const { session } = await openSession([item], { cwd, repo });
  const note = session.notes.blockTask('lib/parser.js:1');
  assert.match(note.text, /use const/);
  const texts = session.notes.tasks.map((task) => task.text);
  assert.equal(texts.length, 2);
  assert.match(texts[0], /add tests/);
  assert.equal(
    session.fileList().some((entry) => entry.kind === 'tasks'),
    false,
  );
  await session.load();
  assert.equal(session.notes.tasks.length, 2);
});

test('load skips imported GitHub notes when resuming a review', async () => {
  const cwd = tempDir('reslop-ui-');
  const reviewPath = path.join(cwd, REVIEW_DIR, `${today()}-00.md`);
  const draft = new ReviewStore(reviewPath);
  draft.addTask('a.js', 'rewrite loop');
  fs.mkdirSync(path.dirname(reviewPath), { recursive: true });
  fs.writeFileSync(reviewPath, serializeReview(draft), 'utf8');
  const item = sampleItem('lib/parser.js', 'pr');
  const imported = {
    blockTasks: [],
    todos: [{ file: 'pull request', text: 'from github', done: false }],
  };
  const { session } = await openSession([item], {
    cwd,
    repo: {
      load: () => ({ top: cwd, items: [item], imported }),
      add: () => {},
      unstage: () => {},
      revert: () => {},
    },
  });
  assert.equal(session.notes.tasks.length, 1);
  assert.equal(session.notes.tasks[0].text, 'rewrite loop');
});

test('openLoad paints git items before npm extras arrive', async () => {
  const gitItem = sampleItem('a.js');
  const extraItem = sampleItem('package.json');
  extraItem.dep = { change: { name: 'lodash', block: 'dependencies' } };
  const cwd = tempDir('reslop-ui-');
  let extrasResolve = null;
  const extras = new Promise((resolve) => {
    extrasResolve = resolve;
  });
  let extrasStarted = false;
  const repo = {
    load: async () => ({
      top: cwd,
      items: [gitItem],
      parsed: [gitItem],
      pending: true,
    }),
    loadExtras: async () => {
      extrasStarted = true;
      await extras;
      return {
        top: cwd,
        items: [gitItem, extraItem],
        pending: false,
      };
    },
    add: () => {},
    unstage: () => {},
    revert: () => {},
  };
  const session = new Session({
    cwd,
    stdout: uiSink(),
    color: false,
    repo,
    audit: true,
    startPane: 'files',
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

const openUpdating = async (extra = {}) => {
  const cacheFile = path.join(tempDir('reslop-cache-'), 'update.json');
  const installed = [];
  let fetchResolve = null;
  let fetchGate = null;
  if (extra.gateFetch) {
    fetchGate = new Promise((resolve) => {
      fetchResolve = resolve;
    });
  }
  const update = {
    enabled: true,
    current: extra.current ?? '0.1.5',
    cacheFile,
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
  };
  const { session } = await openSession(
    [sampleItem('a.js'), sampleItem('b.js')],
    {
      startPane: 'files',
      update,
      ...extra.session,
    },
  );
  session.uiOpen = true;
  return { session, installed, fetchResolve, cacheFile, update };
};

test('update check does not block loading', async () => {
  const { session, fetchResolve, installed } = await openUpdating({
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
  const { session, installed } = await openUpdating({ latest: '0.1.6' });
  await session.openUpdate();
  assert.deepEqual(installed, ['0.1.6']);
  assert.equal(session.status, 'updated');
  assert.equal(session.mode, 'review');
});

test('major update asks y or n on the loaded status line', async () => {
  const { session, installed } = await openUpdating({ latest: '1.0.0' });
  await session.openUpdate();
  session.draw();
  assert.equal(session.mode, 'confirmUpdate');
  assert.equal(session.updater.from, '0.1.5');
  assert.equal(session.updater.to, '1.0.0');
  assert.deepEqual(installed, []);
  const text = session.lastFrame.text;
  assert.match(text, /update reslop 0\.1\.5 → 1\.0\.0\? y\/n/);
  press(session, 'n');
  assert.equal(session.mode, 'review');
  assert.deepEqual(installed, []);
  press(session, 'j');
  assert.equal(session.fileCursor, 1);
});

test('major prompt waits until the UI has loaded', async () => {
  const cwd = tempDir('reslop-ui-');
  const session = new Session({
    cwd,
    stdout: uiSink(),
    color: false,
    startPane: 'files',
    repo: mockRepo([sampleItem('a.js')], cwd),
    update: {
      enabled: true,
      current: '0.1.5',
      cacheFile: path.join(tempDir('reslop-cache-'), 'update.json'),
      fetch: async () => ({
        ok: true,
        json: async () => ({ version: '1.0.0' }),
      }),
      install: async () => {},
    },
  });
  session.uiOpen = true;
  await session.openUpdate();
  assert.equal(session.updater.offer, true);
  assert.equal(session.didLoad, false);
  assert.equal(session.mode, 'review');
  await session.openLoad();
  session.draw();
  assert.equal(session.mode, 'confirmUpdate');
});

test('major update y installs the new version', async () => {
  const { session, installed } = await openUpdating({ latest: '1.0.0' });
  await session.openUpdate();
  session.draw();
  press(session, 'y');
  await session.installPromise;
  assert.deepEqual(installed, ['1.0.0']);
  assert.equal(session.status, 'updated');
  assert.equal(session.mode, 'review');
});

test('declined major update is not asked again from cache', async () => {
  const { session, cacheFile, update } = await openUpdating({
    latest: '1.0.0',
  });
  await session.openUpdate();
  session.draw();
  press(session, 'n');
  let fetched = 0;
  const again = (
    await openSession([sampleItem('a.js')], {
      startPane: 'files',
      update: {
        ...update,
        fetch: async () => {
          fetched += 1;
          return { ok: true, json: async () => ({ version: '1.0.0' }) };
        },
      },
    })
  ).session;
  again.uiOpen = true;
  await again.openUpdate();
  again.draw();
  assert.equal(again.mode, 'review');
  assert.equal(fetched, 0);
  assert.equal(fs.existsSync(cacheFile), true);
});

test('click status branch opens the branch list', async () => {
  const { session } = await openSession([sampleItem('a.js')], {
    startPane: 'files',
  });
  session.draw();
  const hit = session.lastFrame.statusHits[0];
  assert.ok(hit);
  click(session, hit.x0 + 1, hit.y);
  await session.ops.idle();
  assert.equal(session.pane, 'branches');
});

test('the 🢐esc button goes back from list screens', async () => {
  const { session } = await openSession([sampleItem('a.js')], {
    startPane: 'files',
  });
  session.dispatch('scrollDown');
  press(session, 'enter');
  assert.equal(session.pane, 'diff');
  assert.notEqual(session.current().origin, 'task');
  press(session, 'escape');
  session.pushInput('b');
  clickFooter(session, 'back');
  assert.equal(session.pane, 'files');
  session.pushInput('c');
  clickFooter(session, 'back');
  assert.equal(session.pane, 'files');
  session.pushInput('n');
  clickFooter(session, 'back');
  assert.equal(session.pane, 'files');
  session.dispatch('tasks');
  session.pushInput('ship');
  press(session, 'escape');
  assert.equal(session.current().origin, 'task');
  clickFooter(session, 'back');
  await session.ops.idle();
  assert.equal(session.pane, 'files');
});

test('files pane b lists branches and enter checks out', async () => {
  const a = sampleItem('a.js');
  const b = sampleItem('b.js');
  const { session, repo } = await openSession([a, b], { startPane: 'files' });
  assert.equal(session.branch, 'main');
  session.pushInput('b');
  await session.ops.idle();
  assert.equal(session.pane, 'branches');
  assert.equal(session.branchCursor, 0);
  press(session, 'right');
  await session.ops.idle();
  assert.equal(session.branchCursor, 0);
  press(session, 'left');
  await session.ops.idle();
  assert.equal(session.branchCursor, 0);
  press(session, 'down');
  await session.ops.idle();
  assert.equal(session.branchCursor, 1);
  press(session, 'up');
  await session.ops.idle();
  assert.equal(session.branchCursor, 0);
  session.pushInput('j');
  await session.ops.idle();
  assert.equal(session.branchCursor, 1);
  press(session, 'home');
  await session.ops.idle();
  assert.equal(session.branchCursor, 0);
  press(session, 'end');
  await session.ops.idle();
  assert.equal(session.branchCursor, session.branches.length - 1);
  press(session, 'enter');
  await session.ops.idle();
  assert.deepEqual(repo.checkouts, ['feat']);
  assert.equal(session.pane, 'branches');
  assert.equal(session.branchCursor, session.branches.length - 1);
  assert.match(session.status, /checked out feat/);
});

test('branch list p pulls and s pushes', async () => {
  const a = sampleItem('a.js');
  const b = sampleItem('b.js');
  const { session, repo } = await openSession([a, b], { startPane: 'files' });
  session.pushInput('b');
  await session.ops.idle();
  assert.equal(repo.listed.length, 1);
  session.pushInput('p');
  await session.ops.idle();
  assert.equal(repo.pulls.length, 1);
  assert.equal(repo.listed.length, 2);
  assert.equal(session.status, 'pulled');
  assert.equal(session.pane, 'branches');
  session.pushInput('s');
  await session.ops.idle();
  assert.equal(repo.pushes.length, 1);
  assert.equal(repo.listed.length, 3);
  assert.equal(session.status, 'pushed');
  press(session, 'down');
  await session.ops.idle();
  session.pushInput('p');
  await session.ops.idle();
  assert.equal(repo.pulls.length, 2);
  session.pushInput('s');
  await session.ops.idle();
  assert.equal(repo.pushes.length, 2);
  press(session, 'up');
  await session.ops.idle();
  session.pushInput('p');
  await session.ops.idle();
  assert.equal(repo.pulls.length, 3);
});

test('rejected push asks f to force or escape to cancel', async () => {
  const { session, repo } = await openSession([sampleItem('a.js')], {
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
  session.pushInput('b');
  await session.ops.idle();
  session.pushInput('s');
  await session.ops.idle();
  assert.equal(session.mode, 'confirmPush');
  assert.equal(repo.pushes.length, 0);
  session.pushInput('x');
  await session.ops.idle();
  assert.equal(session.mode, 'confirmPush');
  press(session, 'escape');
  await session.ops.idle();
  assert.equal(session.mode, 'review');
  assert.equal(repo.pushes.length, 0);
  session.pushInput('s');
  await session.ops.idle();
  session.pushInput('f');
  await session.ops.idle();
  assert.deepEqual(repo.pushes, [true]);
  assert.equal(session.mode, 'review');
  assert.equal(session.status, 'force pushed');
});

test('pull shows progress until git finishes', async () => {
  let finish = null;
  const pending = new Promise((resolve) => {
    finish = resolve;
  });
  const { session, repo } = await openSession([sampleItem('a.js')], {
    startPane: 'files',
  });
  session.repo.pull = () => pending;
  session.pushInput('b');
  session.pushInput('p');
  await settle();
  assert.equal(repo.pulls.length, 0);
  assert.equal(session.busy, 'pulling');
  assert.equal(session.view().status, 'pulling');
  assert.equal(session.progressFrame, 0);
  session.tickProgress();
  assert.equal(session.progressFrame, 1);
  session.pushInput('p');
  finish();
  await session.ops.idle();
  assert.equal(session.status, 'pulled');
  assert.equal(session.busy, '');
  assert.equal(session.gitBusy, false);
});

test('npm i shows progress until install finishes', async () => {
  let finish = null;
  const pending = new Promise((resolve) => {
    finish = resolve;
  });
  const { session } = await openSession([sampleItem('a.js')], {
    startPane: 'diff',
  });
  session.uiOpen = true;
  const item = session.current();
  item.reload = true;
  item.dep = {
    change: { propose: true, name: 'lodash' },
    files: ['package.json'],
  };
  session.repo.add = () => pending;
  session.dispatch('add');
  assert.equal(session.current().origin, 'staged');
  assert.equal(session.busy, 'npm i');
  session.tickProgress();
  assert.equal(session.progressFrame, 1);
  finish();
  await session.ops.idle();
  assert.equal(session.status, 'staged');
  assert.equal(session.busy, '');
});

test('stage moves on while npm install is still running', async () => {
  let finish = null;
  const pending = new Promise((resolve) => {
    finish = resolve;
  });
  const proposed = sampleItem('package.json');
  proposed.reload = true;
  proposed.dep = {
    change: { propose: true, name: 'lodash' },
    files: ['package.json'],
  };
  const other = sampleItem('z.js');
  const { session, repo } = await openSession([proposed, other]);
  session.uiOpen = true;
  let installs = 0;
  session.repo.add = (top, item) => {
    if (item.dep) installs += 1;
    else repo.added.push(item);
    return item.dep ? pending : undefined;
  };
  session.dispatch('add');
  assert.equal(session.items[0].origin, 'staged');
  assert.equal(installs, 0);
  session.dispatch('next');
  session.dispatch('add');
  assert.equal(session.items[1].origin, 'staged');
  assert.equal(repo.added.length, 0);
  await Promise.resolve();
  assert.equal(installs, 1);
  assert.equal(repo.added.length, 0);
  finish();
  await session.ops.idle();
  assert.equal(repo.added.length, 1);
  assert.equal(repo.added[0].file.newPath, 'z.js');
  assert.equal(session.busy, '');
});

test('openLoad shows progress while a remote change loads', async () => {
  let finish = null;
  const pending = new Promise((resolve) => {
    finish = resolve;
  });
  const item = sampleItem('lib/a.js', 'pr');
  const cwd = tempDir('reslop-ui-');
  const session = new Session({
    cwd,
    stdout: uiSink(),
    color: false,
    startPane: 'files',
    repo: {
      load: async () => {
        await pending;
        return {
          items: [item],
          sourceLabel: '#123',
          change: {
            source: 'pr',
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
  session.tickProgress();
  assert.equal(session.progressFrame, 1);
  finish();
  await ready;
  assert.equal(session.busy, '');
  assert.equal(session.items.length, 1);
  assert.equal(session.sourceLabel, '#123');
  assert.equal(session.repoName, 'acme/app');
});

test('checkout shows progress until git finishes', async () => {
  let finish = null;
  const pending = new Promise((resolve) => {
    finish = resolve;
  });
  const { session, repo } = await openSession([sampleItem('a.js')], {
    startPane: 'files',
  });
  session.uiOpen = true;
  session.repo.checkout = async (top, name) => {
    await pending;
    repo.checkouts.push(name);
  };
  session.pushInput('b');
  await session.ops.idle();
  session.pushInput('j');
  await session.ops.idle();
  press(session, 'enter');
  assert.equal(repo.checkouts.length, 0);
  assert.equal(session.busy, 'checking out');
  session.tickProgress();
  assert.equal(session.progressFrame, 1);
  finish();
  await session.ops.idle();
  assert.deepEqual(repo.checkouts, ['feat']);
  assert.match(session.status, /checked out feat/);
  assert.equal(session.pane, 'branches');
  assert.equal(session.busy, '');
});

test('commit shows progress until git finishes', async () => {
  let finish = null;
  const pending = new Promise((resolve) => {
    finish = resolve;
  });
  const { session, repo } = await openSession([sampleItem('a.js', 'staged')], {
    startPane: 'files',
  });
  session.uiOpen = true;
  session.repo.commit = async (top, kind, message) => {
    await pending;
    repo.commits.push({ top, kind, message });
  };
  session.pushInput('c');
  await session.ops.idle();
  press(session, 'insert');
  await session.ops.idle();
  session.pushInput('land the change');
  await session.ops.idle();
  press(session, 'enter');
  await settle();
  assert.equal(repo.commits.length, 0);
  assert.equal(session.busy, 'committing');
  // The timer of the progress may have ticked on a slow machine meanwhile
  const frame = session.progressFrame;
  session.tickProgress();
  assert.equal(session.progressFrame, frame + 1);
  finish();
  await session.ops.idle();
  assert.equal(repo.commits.length, 1);
  assert.equal(session.status, 'committed');
  assert.equal(session.busy, '');
});

test('files pane u unstages', async () => {
  const item = sampleItem('a.js', 'staged');
  const { session, repo } = await openSession([item], { startPane: 'files' });
  session.dispatch('next');
  await session.ops.idle();
  session.pushInput('u');
  await session.ops.idle();
  assert.equal(repo.unstageCalls.length, 1);
  assert.equal(session.status, 'unstaged');
});

test('files pane f opens file scope, d diffs, delete drops', async () => {
  const item = sampleItem('a.js', 'staged');
  const { session, repo } = await openSession([item], { startPane: 'files' });
  session.dispatch('next');
  session.pushInput('f');
  await session.ops.idle();
  assert.equal(session.fileScope, 'file');
  assert.equal(session.pane, 'files');
  assert.equal(repo.unstageCalls.length, 0);
  press(session, 'delete');
  assert.equal(session.fileScope, 'file');
  assert.equal(repo.reverted.length, 1);
  session.pushInput('d');
  assert.equal(session.fileScope, 'diff');
  assert.equal(session.fileCursorEntry().path, 'a.js');
});

test('unit scope lists every file sorted by path', async () => {
  const { session, repo } = await openSession([sampleItem('b.js')], {
    startPane: 'files',
  });
  repo.extraFiles.push('a.js', 'z.js');
  session.dispatch('file');
  await session.ops.idle();
  const names = session.fileList().map((entry) => entry.path);
  assert.deepEqual(names, ['a.js', 'b.js', 'z.js']);
});

test('unit view shows the file with current block marks', async () => {
  const first = sampleItem('a.js');
  const second = sampleItem('a.js');
  second.blockId = 1;
  second.hunk = {
    oldStart: 3,
    oldCount: 1,
    newStart: 3,
    newCount: 1,
    header: '@@ -3,1 +3,1 @@',
    lines: [
      { type: 'del', text: 'c', noNl: false, blockId: 1 },
      { type: 'add', text: 'd', noNl: false, blockId: 1 },
    ],
  };
  const { session, repo } = await openSession([first, second], {
    startPane: 'files',
  });
  repo.fileBodies['a.js'] = 'b\nkeep\nd\n';
  session.dispatch('file');
  session.dispatch('next');
  await session.ops.idle();
  session.dispatch('open');
  await session.ops.idle();
  assert.equal(session.pane, 'unit');
  const view = session.view();
  const types = view.unitLines.map((line) => `${line.type}:${line.text}`);
  assert.deepEqual(types, ['del:a', 'add:b', 'ctx:keep', 'del:c', 'add:d']);
  assert.equal(session.unitLine, 0);
  session.dispatch('next');
  assert.equal(session.unitLine, 3);
  assert.equal(session.current(), second);
  session.dispatch('prev');
  assert.equal(session.unitLine, 0);
  session.scroll = 5;
  press(session, 'up');
  assert.equal(session.scroll, 4);
  press(session, 'down');
  assert.equal(session.scroll, 5);
});

test('unit view marks every block in the current hunk', async () => {
  const [first, second] = hunkPair('a.js');
  const { session, repo } = await openSession([first, second], {
    startPane: 'files',
  });
  repo.fileBodies['a.js'] = 'A\nmid\nC\n';
  session.dispatch('file');
  await session.ops.idle();
  session.dispatch('next');
  await session.ops.idle();
  session.dispatch('open');
  await session.ops.idle();
  session.draw();
  const body = stripAnsi(session.lastFrame.rows.join('\n'));
  assert.match(body, /- a/);
  assert.match(body, /\+ A/);
  assert.match(body, /- c/);
  assert.match(body, /\+ C/);
  session.dispatch('add');
  await session.ops.idle();
  assert.equal(repo.added.length, 2);
  assert.equal(session.items[0].origin, 'staged');
  assert.equal(session.items[1].origin, 'staged');
});

test('file scope next scrolls the whole block into view', async () => {
  const first = sampleItem('a.js');
  const second = sampleItem('a.js');
  second.blockId = 1;
  const adds = [];
  for (let i = 0; i < 5; i++) {
    adds.push({ type: 'add', text: `chg${i}`, noNl: false, blockId: 1 });
  }
  second.hunk = {
    oldStart: 40,
    oldCount: 0,
    newStart: 40,
    newCount: 5,
    header: '@@ -40,0 +40,5 @@',
    lines: adds,
  };
  const rows = ['b'];
  for (let i = 2; i < 40; i++) rows.push(`keep${i}`);
  for (let i = 0; i < 5; i++) rows.push(`chg${i}`);
  rows.push('tail');
  const { session, repo } = await openSession([first, second], {
    startPane: 'files',
  });
  repo.fileBodies['a.js'] = `${rows.join('\n')}\n`;
  session.dispatch('file');
  session.dispatch('next');
  await session.ops.idle();
  session.dispatch('open');
  session.draw();
  await session.ops.idle();
  session.dispatch('next');
  session.draw();
  const body = stripAnsi(session.lastFrame.rows.join('\n'));
  assert.match(body, /chg0/);
  assert.match(body, /chg4/);
  const page = session.lastFrame.bodyH;
  assert.equal(session.scroll, 46 - page + 1);
  assert.match(body, /keep39/);
  assert.match(body, /tail/);
});

test('file scope next pins an oversized block at its start', async () => {
  const first = sampleItem('a.js');
  const second = sampleItem('a.js');
  second.blockId = 1;
  const adds = [];
  for (let i = 0; i < 40; i++) {
    adds.push({ type: 'add', text: `chg${i}`, noNl: false, blockId: 1 });
  }
  second.hunk = {
    oldStart: 40,
    oldCount: 0,
    newStart: 40,
    newCount: 40,
    header: '@@ -40,0 +40,40 @@',
    lines: adds,
  };
  const rows = ['b'];
  for (let i = 2; i < 40; i++) rows.push(`keep${i}`);
  for (let i = 0; i < 40; i++) rows.push(`chg${i}`);
  rows.push('tail');
  const { session, repo } = await openSession([first, second], {
    startPane: 'files',
  });
  repo.fileBodies['a.js'] = `${rows.join('\n')}\n`;
  session.dispatch('file');
  session.dispatch('next');
  await session.ops.idle();
  session.dispatch('open');
  session.draw();
  await session.ops.idle();
  session.dispatch('next');
  session.draw();
  const body = stripAnsi(session.lastFrame.rows.join('\n'));
  assert.match(body, /chg0/);
  assert.equal(body.includes('chg39'), false);
  assert.equal(session.scroll, 41);
});

test('unit view e edits the whole file and autosaves', async () => {
  const { session, repo } = await openSession([sampleItem('a.js')], {
    startPane: 'files',
  });
  repo.fileBodies['a.js'] = 'b\n';
  session.dispatch('file');
  await session.ops.idle();
  session.dispatch('next');
  await session.ops.idle();
  session.dispatch('open');
  await session.ops.idle();
  session.dispatch('code');
  await session.ops.idle();
  assert.equal(session.composeKind, 'file');
  session.editor.replace('edited\n');
  session.autosave();
  assert.equal(repo.writes.length, 1);
  assert.equal(repo.writes[0].text, 'edited\n');
  assert.equal(repo.fileBodies['a.js'], 'edited\n');
  assert.equal(repo.stagedPaths.length, 0);
  session.composer.saveCompose();
  await session.ops.idle();
  assert.deepEqual(repo.stagedPaths, ['a.js']);
  assert.equal(session.status, 'staged');
});

test('file compose keeps del and add highlighting', async () => {
  const { session, repo } = await openSession([sampleItem('a.js')], {
    startPane: 'files',
  });
  repo.fileBodies['a.js'] = 'b\nkeep\n';
  session.dispatch('file');
  session.dispatch('next');
  await session.ops.idle();
  session.dispatch('open');
  session.dispatch('code');
  await session.ops.idle();
  const types = session
    .view()
    .unitLines.map((line) => `${line.type}:${line.text}`);
  assert.deepEqual(types, ['del:a', 'add:b', 'ctx:keep', 'ctx:']);
  const del = session.view().unitLines[0];
  const add = session.view().unitLines[1];
  assert.equal(del.editStart, undefined);
  assert.equal(add.editStart, 0);
  session.editor.insert('x');
  const after = session
    .view()
    .unitLines.map((line) => `${line.type}:${line.text}`);
  assert.deepEqual(after, ['del:a', 'add:xb', 'ctx:keep', 'ctx:']);
});

test('file compose cursor stays on a trailing empty line', async () => {
  const { session, repo } = await openSession([sampleItem('a.js')], {
    startPane: 'files',
  });
  repo.fileBodies['a.js'] = 'b\nkeep\n';
  session.dispatch('file');
  session.dispatch('next');
  await session.ops.idle();
  session.dispatch('open');
  session.dispatch('code');
  await session.ops.idle();
  session.editor.cursor = session.editor.text.length;
  session.draw();
  assert.ok(session.lastFrame.cursor);
  const lines = session.view().unitLines;
  const last = lines[lines.length - 1];
  assert.equal(last.text, '');
  assert.equal(last.editLast, true);
});

test('file compose scroll follows the editor cursor', async () => {
  const { session, repo } = await openSession([sampleItem('a.js')], {
    startPane: 'files',
  });
  const rows = [];
  for (let i = 0; i < 40; i++) rows.push(`line${i}`);
  repo.fileBodies['a.js'] = `${rows.join('\n')}\n`;
  session.dispatch('file');
  session.dispatch('next');
  await session.ops.idle();
  session.dispatch('open');
  session.dispatch('code');
  await session.ops.idle();
  session.scroll = 0;
  session.editor.cursor = 0;
  for (let i = 0; i < 30; i++) session.composer.handleKey('down');
  for (let i = 0; i < 30; i++) await session.ops.idle();
  const downScroll = session.scroll;
  assert.ok(downScroll > 0);
  session.editor.cursor = 0;
  session.composer.handleKey('up');
  assert.ok(session.scroll < downScroll);
  assert.ok(session.unitLine + 1 >= session.scroll);
});

test('unit view reloads disk text in view and edit', async () => {
  const { session, repo } = await openSession([sampleItem('a.js')], {
    startPane: 'files',
  });
  repo.fileBodies['a.js'] = 'b\n';
  session.dispatch('file');
  session.dispatch('next');
  await session.ops.idle();
  session.dispatch('open');
  await session.ops.idle();
  repo.fileBodies['a.js'] = 'from-disk\n';
  session.refreshFromRepo({ keepView: true, quiet: true });
  await session.ops.idle();
  const view = session.view();
  assert.ok(view.unitLines.some((line) => line.text === 'from-disk'));
  session.dispatch('code');
  await session.ops.idle();
  repo.fileBodies['a.js'] = 'later\n';
  session.composer.applyDiskText('later\n');
  assert.equal(session.editor.text, 'later\n');
});

test('insert creates a branch, or commits, amends, or fixups', async () => {
  const branch = await openSession([sampleItem('a.js')], {
    startPane: 'files',
  });
  branch.session.pushInput('b');
  press(branch.session, 'insert');
  await branch.session.ops.idle();
  assert.equal(branch.session.mode, 'compose');
  assert.equal(branch.session.composeKind, 'branch');
  const commits = await openSession([sampleItem('a.js', 'staged')], {
    startPane: 'files',
  });
  commits.session.pushInput('c');
  press(commits.session, 'insert');
  await commits.session.ops.idle();
  assert.equal(commits.session.commitKind, 'commit');
  commits.session.composer.closeCompose();
  commits.session.dispatch('next');
  press(commits.session, 'insert');
  assert.equal(commits.session.mode, 'confirmCommit');
  commits.session.draw();
  const headLine = stripAnsi(commits.session.lastFrame.rows.at(-2));
  assert.match(headLine, /what do you want to do\?/);
  assert.match(headLine, /esc cancel/);
  assert.match(headLine, /update {2}commit {2}amend {2}fixup/);
  press(commits.session, 'c');
  await commits.session.ops.idle();
  assert.equal(commits.session.commitKind, 'commit');
  commits.session.composer.closeCompose();
  commits.session.dispatch('next');
  press(commits.session, 'insert', 'escape');
  assert.equal(commits.session.mode, 'review');
  press(commits.session, 'insert', 'a');
  await commits.session.ops.idle();
  assert.equal(commits.session.commitCursor, 1);
  assert.equal(commits.session.commitKind, 'amend');
  commits.session.composer.closeCompose();
  commits.session.dispatch('next');
  press(commits.session, 'insert');
  assert.equal(commits.session.mode, 'confirmCommit');
  commits.session.draw();
  const older = stripAnsi(commits.session.lastFrame.rows.at(-2));
  assert.match(older, /esc cancel/);
  assert.match(older, /update {2}commit {2}amend {2}fixup/);
  press(commits.session, 'c');
  await commits.session.ops.idle();
  assert.equal(commits.session.commitKind, 'commit');
  assert.equal(commits.session.commitCursor, 0);
  commits.session.composer.closeCompose();
  commits.session.dispatch('next');
  commits.session.dispatch('next');
  press(commits.session, 'insert', 'a');
  await commits.session.ops.idle();
  assert.equal(commits.session.commitCursor, 1);
  assert.equal(commits.session.commitKind, 'amend');
  commits.session.composer.closeCompose();
  commits.session.dispatch('next');
  press(commits.session, 'insert', 'f');
  await commits.session.ops.idle();
  assert.equal(commits.session.commitCursor, 2);
  assert.equal(commits.session.commitKind, 'fixup');
});

test('insert update keeps the commit and takes staged changes', async () => {
  const head = 'aaa1111aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const older = 'bbb2222bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  const { session, repo } = await openSession([sampleItem('a.js', 'staged')], {
    startPane: 'files',
  });
  session.pushInput('c');
  await session.ops.idle();
  session.dispatch('next');
  await session.ops.idle();
  press(session, 'insert');
  await session.ops.idle();
  assert.equal(session.mode, 'confirmCommit');
  press(session, 'enter');
  await session.ops.idle();
  assert.equal(session.mode, 'review');
  assert.equal(session.status, 'updated');
  assert.deepEqual(repo.updates, [head]);
  session.dispatch('next');
  await session.ops.idle();
  press(session, 'insert');
  await session.ops.idle();
  press(session, 'u');
  await session.ops.idle();
  assert.deepEqual(repo.updates, [head, older]);
  press(session, 'insert');
  await session.ops.idle();
  clickStatusChoice(session, 'u');
  await session.ops.idle();
  assert.deepEqual(repo.updates, [head, older, older]);
  const bare = await openSession([sampleItem('a.js')], { startPane: 'files' });
  bare.session.pushInput('c');
  bare.session.dispatch('next');
  press(bare.session, 'insert', 'enter');
  await bare.session.ops.idle();
  assert.equal(bare.session.status, 'nothing to commit');
  assert.deepEqual(bare.repo.updates, []);
});

test('new branch action asks for a name', async () => {
  const { session, repo } = await openSession([sampleItem('a.js')], {
    startPane: 'files',
  });
  session.pushInput('b');
  await session.ops.idle();
  session.dispatch('newBranch');
  await session.ops.idle();
  assert.equal(session.pane, 'branches');
  assert.equal(session.mode, 'compose');
  assert.equal(session.composeKind, 'branch');
  session.pushInput('topic');
  await session.ops.idle();
  press(session, 'enter');
  await session.ops.idle();
  assert.deepEqual(repo.created, ['topic']);
  assert.equal(repo.listed.length, 2);
  assert.equal(session.pane, 'branches');
  assert.equal(session.mode, 'review');
  assert.match(session.status, /created topic/);
});

test('branch list r rebases current onto selected', async () => {
  const { session, repo } = await openSession([sampleItem('a.js')], {
    startPane: 'files',
  });
  session.pushInput('b');
  await session.ops.idle();
  session.pushInput('e');
  await session.ops.idle();
  assert.equal(repo.rebases.length, 0);
  session.dispatch('next');
  await session.ops.idle();
  session.pushInput('e');
  await session.ops.idle();
  assert.deepEqual(repo.rebases, ['feat']);
  assert.equal(repo.listed.length, 2);
  assert.match(session.status, /rebased onto feat/);
  assert.equal(session.pane, 'branches');
});

test('branch list delete asks to delete the selected branch', async () => {
  const { session, repo } = await openSession([sampleItem('a.js')], {
    startPane: 'files',
  });
  session.pushInput('b');
  await session.ops.idle();
  press(session, 'delete');
  await session.ops.idle();
  assert.equal(session.mode, 'review');
  assert.equal(repo.drops.length, 0);
  session.dispatch('next');
  await session.ops.idle();
  press(session, 'delete');
  await session.ops.idle();
  assert.equal(session.mode, 'confirmDrop');
  assert.equal(session.dropName, 'feat');
  session.pushInput('n');
  await session.ops.idle();
  assert.equal(session.mode, 'review');
  assert.equal(repo.drops.length, 0);
  press(session, 'delete');
  await session.ops.idle();
  press(session, 'escape');
  await session.ops.idle();
  assert.equal(session.mode, 'review');
  assert.equal(repo.drops.length, 0);
  press(session, 'delete');
  await session.ops.idle();
  session.pushInput('y');
  await session.ops.idle();
  assert.deepEqual(repo.drops, ['feat']);
  assert.match(session.status, /dropped feat/);
  assert.equal(session.pane, 'branches');
});

test('click drop prompt y and n', async () => {
  const { session, repo } = await openSession([sampleItem('a.js')], {
    startPane: 'files',
  });
  session.pushInput('b');
  await session.ops.idle();
  session.dispatch('next');
  press(session, 'delete');
  clickStatusChoice(session, 'n');
  assert.equal(session.mode, 'review');
  assert.equal(repo.drops.length, 0);
  press(session, 'delete');
  clickStatusChoice(session, 'y');
  assert.deepEqual(repo.drops, ['feat']);
});

test('escape from branch list returns to files', async () => {
  const { session } = await openSession([sampleItem('a.js')], {
    startPane: 'files',
  });
  session.pushInput('b');
  await session.ops.idle();
  assert.equal(session.pane, 'branches');
  press(session, 'escape');
  assert.equal(session.pane, 'files');
});

test('read only keeps the branch screen closed', async () => {
  const { session } = await openSession([sampleItem('a.js')], {
    startPane: 'files',
    readOnly: true,
  });
  session.pushInput('b');
  assert.equal(session.pane, 'files');
  assert.equal(session.status, 'read only');
});

test('ops runner releases busy if after throws', async () => {
  const runner = new OpsRunner({
    top: '/tmp',
    done: false,
    mode: 'review',
    status: '',
    paint: () => {},
    startProgress: () => {},
    stopProgress: () => {},
  });
  await assert.rejects(
    () =>
      runner.runBusy(
        'pulling',
        'pulled',
        async () => {},
        () => {
          throw new Error('follow-up failed');
        },
      ),
    /follow-up failed/,
  );
  assert.equal(runner.gitBusy, false);
  assert.equal(runner.busy, '');
});

test('partial file add reloads after a later hunk fails', async () => {
  const first = sampleItem('a.js');
  const second = sampleItem('a.js');
  second.blockId = 1;
  second.hunk = {
    ...second.hunk,
    oldStart: 10,
    newStart: 10,
    header: '@@ -10,1 +10,1 @@',
  };
  const other = sampleItem('b.js');
  const staged = new Set();
  let loads = 0;
  const snapshot = () => {
    loads += 1;
    const a1 = { ...first, origin: staged.has(0) ? 'staged' : 'unstaged' };
    const a2 = {
      ...second,
      origin: staged.has(1) ? 'staged' : 'unstaged',
      blockId: 1,
      hunk: second.hunk,
    };
    return { top: '/tmp', items: [a1, a2, other], branch: 'main' };
  };
  const repo = {
    load: snapshot,
    add: (top, item) => {
      if (item.blockId === 1) throw new Error('patch failed');
      staged.add(item.blockId ?? 0);
    },
    unstage: () => {},
    revert: () => {},
    revertFile: () => {},
  };
  const { session } = await openSession([first, second, other], {
    startPane: 'files',
    repo,
  });
  const before = loads;
  session.dispatch('add');
  await session.ops.idle();
  assert.equal(session.status, 'patch failed');
  assert.ok(loads > before);
  assert.equal(session.items[0].origin, 'staged');
  assert.equal(session.items[1].origin, 'unstaged');
  assert.equal(session.items[1].blockId, 1);
});

const twoBlockFile = async () => {
  const first = sampleItem('a.js');
  const second = sampleItem('a.js');
  second.blockId = 1;
  second.hunk = {
    oldStart: 3,
    oldCount: 1,
    newStart: 3,
    newCount: 1,
    header: '@@ -3,1 +3,1 @@',
    lines: [
      { type: 'del', text: 'c', noNl: false, blockId: 1 },
      { type: 'add', text: 'd', noNl: false, blockId: 1 },
    ],
  };
  const opened = await openSession([first, second], { startPane: 'files' });
  opened.repo.fileBodies['a.js'] = 'b\nkeep\nd\n';
  opened.session.dispatch('file');
  await opened.session.ops.idle();
  opened.session.dispatch('open');
  await opened.session.ops.idle();
  return opened;
};

const whereOf = (session) =>
  session.notes.tasks.map((task) => task.item.value('where'));

test('ctrl+t in the file view names the line or the block', async () => {
  const { session } = await twoBlockFile();
  assert.equal(session.pane, 'unit');
  session.nav.unitLine = 2;
  press(session, 'ctrl-t');
  assert.equal(session.composeKind, 'blockTask');
  session.pushInput('keep it');
  press(session, 'enter');
  session.nav.unitLine = 4;
  press(session, 'ctrl-t');
  session.pushInput('check d');
  press(session, 'enter');
  assert.deepEqual(whereOf(session), ['a.js:2', 'a.js:3']);
});

test('ctrl+t in the file editor adds a task and goes on editing', async () => {
  const { session } = await twoBlockFile();
  session.dispatch('code');
  await session.ops.idle();
  assert.equal(session.composeKind, 'file');
  session.editor.place(0);
  session.pushInput('x');
  press(session, 'down', 'shift-down');
  press(session, 'ctrl-t');
  assert.equal(session.composeKind, 'blockTask');
  assert.equal(session.view().compose.prompt, 'task: [ ] ');
  session.pushInput('two lines');
  press(session, 'escape');
  assert.equal(session.composeKind, 'file');
  assert.equal(session.editor.text, 'xb\nkeep\nd\n');
  assert.equal(session.editor.hasSelect(), true);
  session.editor.place(1);
  press(session, 'ctrl-t');
  session.pushInput('first block');
  press(session, 'enter');
  assert.equal(session.composeKind, 'file');
  assert.deepEqual(whereOf(session), ['a.js:2-3', 'a.js:1']);
});

test('f and d keep the file the cursor is on', async () => {
  const items = ['lib/a.js', 'src/b.js', 'src/c.js'].map((rel) =>
    sampleItem(rel),
  );
  const { session } = await openSession(items, { startPane: 'files' });
  const shown = () => session.fileCursorEntry().path;
  press(session, 'down');
  session.pushInput('f');
  await session.ops.idle();
  assert.equal(session.fileScope, 'file');
  assert.equal(session.nav.folder, 'src');
  assert.equal(shown(), 'src/b.js');
  press(session, 'down');
  session.pushInput('d');
  assert.equal(session.fileScope, 'diff');
  assert.equal(shown(), 'src/c.js');
  press(session, 'enter');
  assert.equal(session.current().file.newPath, 'src/c.js');
});

test('the files menu selects all and leaves enter to the key', async () => {
  const items = [sampleItem('a.js'), sampleItem('b.js')];
  const { session } = await openSession(items, { startPane: 'files' });
  session.draw();
  const hit = session.lastFrame.fileHits.find((entry) => entry.cursor === 0);
  helpers.rightClick(session, 10, hit.y);
  const { actions } = session.nav.contextMenu;
  assert.ok(!actions.includes('open'));
  assert.equal(actions.at(-1), 'listSelectAll');
  press(session, 'ctrl-a');
  assert.equal(session.nav.contextMenu, null);
  assert.deepEqual(session.view().listSelection, [0, 1]);
});

test('ctrl+t while editing a diff block adds a task and goes on', async () => {
  const { session } = await openSession([sampleItem('a.js')]);
  session.pushInput('e');
  assert.equal(session.composeKind, 'code');
  session.pushInput('2');
  press(session, 'ctrl-t');
  assert.equal(session.composeKind, 'blockTask');
  session.pushInput('name the value');
  press(session, 'enter');
  assert.equal(session.composeKind, 'code');
  assert.equal(session.editor.text, 'b2');
  press(session, 'shift-home', 'ctrl-t');
  assert.equal(session.editor.text, 'name the value');
  session.editor.replace('the line');
  press(session, 'enter');
  assert.deepEqual(whereOf(session), ['a.js:1']);
  assert.equal(session.notes.tasks[0].item.title, 'the line');
});
