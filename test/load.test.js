'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  isAbortError,
  createLoadCoordinator,
} = require('../lib/session/load.js');
const { Session } = require('../lib/session.js');
const { sink } = require('./helpers.js');

const sampleItem = (name) => ({
  origin: 'unstaged',
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
    lines: [{ type: 'add', text: 'x', noNl: false, blockId: 0 }],
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

test('isAbortError recognizes ABORT codes', () => {
  assert.equal(isAbortError({ code: 'ABORT' }), true);
  assert.equal(isAbortError(new Error('nope')), false);
});

test('stale generation is not accepted after bump', () => {
  const loader = createLoadCoordinator();
  const first = loader.bump();
  const tagged = loader.tag({ items: [1] }, first);
  assert.equal(tagged.generation, first);
  const second = loader.bump();
  assert.equal(loader.accept(first), false);
  assert.equal(loader.accept(second), true);
  assert.equal(loader.isCurrent(first), false);
});

test('abort replaces the signal and marks the old one aborted', () => {
  const loader = createLoadCoordinator();
  loader.bump();
  const first = loader.signal;
  loader.bump();
  assert.equal(first.aborted, true);
  assert.equal(loader.signal.aborted, false);
});

test('a slow load cannot replace a newer load', async () => {
  let finishA;
  const gateA = new Promise((resolve) => {
    finishA = resolve;
  });
  let calls = 0;
  const oldItem = sampleItem('old.js');
  const newItem = sampleItem('new.js');
  const session = new Session({
    cwd: '/tmp',
    stdout: sink(),
    color: false,
    getSize: () => ({ width: 80, height: 16 }),
    startPane: 'files',
    setInterval: () => 1,
    clearInterval: () => {},
    ...reviewFs,
    repo: {
      load: () => ({ top: '/tmp', items: [newItem] }),
      loadAsync: async () => {
        calls += 1;
        if (calls === 1) {
          await gateA;
          return { top: '/tmp', items: [oldItem] };
        }
        return { top: '/tmp', items: [newItem] };
      },
    },
  });
  session.uiOpen = true;
  const first = session.openLoad();
  session.refreshFromRepo();
  finishA();
  await first;
  await new Promise((resolve) => {
    setImmediate(resolve);
  });
  assert.equal(session.items[0].file.newPath, 'new.js');
  assert.notEqual(session.status, 'old');
});

test('reset invalidates generations without reusing them', () => {
  const loader = createLoadCoordinator();
  const old = loader.bump();
  const signal = loader.signal;

  loader.reset();
  const current = loader.bump();

  assert.equal(signal.aborted, true);
  assert.equal(loader.accept(old), false);
  assert.equal(loader.accept(current), true);
});

test('resetState allows a second openLoad after a completed load', async () => {
  let calls = 0;
  const item = sampleItem('a.js');
  const session = new Session({
    cwd: '/tmp',
    stdout: sink(),
    color: false,
    getSize: () => ({ width: 80, height: 16 }),
    startPane: 'files',
    setInterval: () => 1,
    clearInterval: () => {},
    ...reviewFs,
    repo: {
      load: () => ({ top: '/tmp', items: [item] }),
      loadAsync: async () => {
        calls += 1;
        return { top: '/tmp', items: [item] };
      },
    },
  });
  session.uiOpen = true;
  await session.openLoad();
  assert.equal(calls, 1);
  assert.equal(session.items.length, 1);
  assert.equal(Object.hasOwn(session.loader, 'loadPromise'), false);
  session.resetState();
  session.uiOpen = true;
  await session.openLoad();
  assert.equal(calls, 2);
  assert.equal(session.items.length, 1);
  assert.equal(session.items[0].file.newPath, 'a.js');
});

test('openLoad shares one in-flight promise without reset', async () => {
  let finish;
  const gate = new Promise((resolve) => {
    finish = resolve;
  });
  let calls = 0;
  const item = sampleItem('a.js');
  const session = new Session({
    cwd: '/tmp',
    stdout: sink(),
    color: false,
    getSize: () => ({ width: 80, height: 16 }),
    setInterval: () => 1,
    clearInterval: () => {},
    ...reviewFs,
    repo: {
      load: () => ({ top: '/tmp', items: [item] }),
      loadAsync: async () => {
        calls += 1;
        await gate;
        return { top: '/tmp', items: [item] };
      },
    },
  });
  session.uiOpen = true;
  const first = session.openLoad();
  const second = session.openLoad();
  assert.equal(first, second);
  finish();
  await first;
  await second;
  assert.equal(calls, 1);
});

test('reset rejects a late snapshot that ignores abort', async () => {
  let finishA;
  const gateA = new Promise((resolve) => {
    finishA = resolve;
  });
  let calls = 0;
  const oldItem = sampleItem('old.js');
  const newItem = sampleItem('new.js');
  const session = new Session({
    cwd: '/tmp',
    stdout: sink(),
    color: false,
    getSize: () => ({ width: 80, height: 16 }),
    setInterval: () => 1,
    clearInterval: () => {},
    ...reviewFs,
    repo: {
      load: () => ({ top: '/tmp', items: [newItem] }),
      loadAsync: async () => {
        calls += 1;
        if (calls === 1) {
          await gateA;
          return { top: '/tmp', items: [oldItem] };
        }
        return { top: '/tmp', items: [newItem] };
      },
    },
  });
  session.uiOpen = true;
  const first = session.openLoad();
  session.resetState();
  session.uiOpen = true;
  await session.openLoad();
  session.status = 'kept';
  finishA();
  await first;
  assert.equal(session.items[0].file.newPath, 'new.js');
  assert.equal(session.status, 'kept');
});

test('reset ignores extras from a previous load', async () => {
  const gitItem = sampleItem('a.js');
  const extraItem = sampleItem('package.json');
  extraItem.dep = { change: { name: 'lodash', section: 'dependencies' } };
  const newItem = sampleItem('new.js');
  let extrasResolve;
  const extras = new Promise((resolve) => {
    extrasResolve = resolve;
  });
  let extrasStarted = false;
  let calls = 0;
  const session = new Session({
    cwd: '/tmp',
    stdout: sink(),
    color: false,
    audit: true,
    getSize: () => ({ width: 80, height: 16 }),
    setInterval: () => 1,
    clearInterval: () => {},
    ...reviewFs,
    repo: {
      load: () => ({ top: '/tmp', items: [gitItem] }),
      loadAsync: async () => {
        calls += 1;
        if (calls === 1) {
          return {
            top: '/tmp',
            items: [gitItem],
            parsed: [gitItem],
            pending: true,
          };
        }
        return { top: '/tmp', items: [newItem], pending: false };
      },
      loadExtras: async () => {
        extrasStarted = true;
        await extras;
        return {
          top: '/tmp',
          items: [gitItem, extraItem],
          pending: false,
        };
      },
    },
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
  session.resetState();
  session.uiOpen = true;
  await session.openLoad();
  session.progress.start('loading');
  extrasResolve();
  await pending;
  assert.equal(session.items.length, 1);
  assert.equal(session.items[0].file.newPath, 'new.js');
  assert.equal(session.progress.size(), 1);
  assert.equal(session.busy, '');
});

test('close while loading ignores the late snapshot', async () => {
  let finish;
  const gate = new Promise((resolve) => {
    finish = resolve;
  });
  const item = sampleItem('late.js');
  const session = new Session({
    cwd: '/tmp',
    stdout: sink(),
    color: false,
    getSize: () => ({ width: 80, height: 16 }),
    setInterval: () => 1,
    clearInterval: () => {},
    ...reviewFs,
    repo: {
      load: () => ({ top: '/tmp', items: [] }),
      loadAsync: async () => {
        await gate;
        return { top: '/tmp', items: [item] };
      },
    },
  });
  session.uiOpen = true;
  const pending = session.openLoad();
  session.done = true;
  session.loader.abort();
  finish();
  await pending;
  assert.equal(session.items.length, 0);
});

const emptySession = (asyncLoad = false) => {
  const load = () => ({ top: '/tmp', items: [] });
  const repo = { load };
  if (asyncLoad) repo.loadAsync = async () => load();
  return new Session({
    cwd: '/tmp',
    stdout: sink(),
    color: false,
    getSize: () => ({ width: 80, height: 16 }),
    setInterval: () => 1,
    clearInterval: () => {},
    ...reviewFs,
    repo,
  });
};

test('opening an empty review finishes without an error', async () => {
  const session = emptySession(true);
  session.uiOpen = true;
  await session.openLoad();
  assert.equal(session.done, true);
  assert.equal(session.emptyReview, true);
  assert.equal(session.exitCode, 0);
  assert.equal(session.status, 'nothing to review');
  assert.equal(session.busy, '');
});

test('an empty async reload preserves its final status', async () => {
  const session = emptySession(true);
  session.uiOpen = true;
  await new Promise((resolve) => {
    session.refreshFromRepo({ doneStatus: 'reloaded', afterLoad: resolve });
  });
  assert.equal(session.done, true);
  assert.equal(session.emptyReview, false);
  assert.equal(session.status, 'nothing to review');
  assert.equal(session.busy, '');
});

test('async reload can keep an empty branch review open', async () => {
  const session = emptySession(true);
  session.uiOpen = true;
  session.scroll = 8;
  session.selection = { start: { x: 1, y: 1 }, end: { x: 2, y: 1 } };
  await new Promise((resolve) => {
    session.refreshFromRepo({
      keepEmpty: true,
      doneStatus: 'checked out',
      afterLoad: resolve,
    });
  });
  assert.equal(session.done, false);
  assert.equal(session.status, 'checked out');
  assert.equal(session.scroll, 0);
  assert.equal(session.selection, null);
  assert.equal(session.busy, '');
});

test('sync refresh applies data and its callback before returning', () => {
  const session = emptySession();
  let afterLoad = false;
  const result = session.refreshFromRepo({
    keepEmpty: true,
    afterLoad: () => {
      afterLoad = true;
    },
  });
  assert.equal(result, undefined);
  assert.equal(afterLoad, true);
  assert.equal(session.didLoad, true);
  assert.equal(session.done, false);
  assert.equal(session.busy, '');
});

test('deferred extras keep an empty branch review open', async () => {
  const session = emptySession(true);
  let finishExtras;
  const extras = new Promise((resolve) => {
    finishExtras = resolve;
  });
  let startExtras;
  const started = new Promise((resolve) => {
    startExtras = resolve;
  });
  session.repo.loadAsync = async () => ({
    top: '/tmp',
    items: [],
    pending: true,
  });
  session.repo.loadExtras = async () => {
    startExtras();
    return extras;
  };
  session.uiOpen = true;
  session.refreshFromRepo({ keepEmpty: true });
  await started;
  assert.equal(session.done, false);
  assert.equal(session.busy, 'checking npm');
  assert.equal(session.pendingExtras, true);
  finishExtras({ top: '/tmp', items: [], pending: false });
  await new Promise((resolve) => {
    setImmediate(resolve);
  });
  assert.equal(session.done, false);
  assert.equal(session.busy, '');
  assert.equal(session.pendingExtras, false);
});
