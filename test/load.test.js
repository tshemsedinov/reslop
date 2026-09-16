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
