'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createComposer } = require('../lib/session/compose.js');
const { createNavigation } = require('../lib/session/navigation.js');
const { createStore } = require('../lib/review.js');

const setup = (extra = {}) => {
  const notes = extra.notes ?? createStore('/tmp/review.md');
  const nav = extra.nav ?? createNavigation({ startPane: 'diff' });
  let mode = 'review';
  let status = '';
  const flushed = [];
  const options = {
    getNotes: () => notes,
    currentItem: () => extra.item ?? null,
    nav,
    flushReview: (force) => {
      flushed.push(force === true);
      return true;
    },
    setStatus: (value) => {
      status = value;
    },
    setMode: (value) => {
      mode = value;
    },
    getMode: () => mode,
    draw: () => {},
    restartBlink: () => {},
    getViewSize: () => ({ width: 80, height: 24 }),
    getLayout: () => 'unified',
    fileCursorEntry: () => null,
    afterClose: () => {},
    syncReviewPath: () => {},
    syncFileCursor: () => {},
  };
  const composer = createComposer(options);
  return {
    composer,
    notes,
    nav,
    flushed,
    getMode: () => mode,
    getStatus: () => status,
  };
};

test('commit save returns a command and does not close compose', () => {
  const { composer, flushed, getMode } = setup();
  composer.commitKind = 'commit';
  composer.openCompose('commit', 'land it');
  const result = composer.saveCompose();
  assert.deepEqual(result, { kind: 'commit' });
  assert.equal(composer.composeKind, 'commit');
  assert.equal(getMode(), 'compose');
  assert.equal(flushed.length, 0);
});

test('autosave never returns a git command for commit or branch', () => {
  const { composer, flushed } = setup();
  composer.commitKind = 'commit';
  composer.openCompose('commit', 'land it');
  assert.equal(composer.autosave(), undefined);
  assert.equal(composer.composeKind, 'commit');
  assert.equal(flushed.length, 0);
  composer.closeCompose();
  composer.openCompose('branch', 'feat');
  assert.equal(composer.autosave(), undefined);
  assert.equal(composer.composeKind, 'branch');
  assert.equal(flushed.length, 0);
});

test('page home and end move in a multiline compose editor', () => {
  const { composer } = setup();
  composer.openCompose('code', 'aaa\nbbb\nccc');
  assert.equal(composer.editor.cursor, 11);
  composer.handleKey('home');
  assert.equal(composer.editor.cursor, 8);
  composer.handleKey('end');
  assert.equal(composer.editor.cursor, 11);
  composer.handleKey('pageUp');
  assert.equal(composer.editor.linePos().line, 0);
  composer.handleKey('pageDown');
  assert.equal(composer.editor.linePos().line, 2);
});

test('ctrl arrows move by word in compose editors', () => {
  const kinds = ['feedback', 'code', 'todo', 'commit', 'branch'];
  for (const kind of kinds) {
    const { composer } = setup();
    composer.openCompose(kind, 'hello world');
    composer.editor.home();
    composer.handleKey('ctrl-right');
    assert.equal(composer.editor.cursor, 5);
    composer.handleKey('ctrl-right');
    assert.equal(composer.editor.cursor, 11);
    composer.handleKey('ctrl-left');
    assert.equal(composer.editor.cursor, 6);
    composer.handleKey('ctrl-left');
    assert.equal(composer.editor.cursor, 0);
  }
});

test('escape cancels branch compose without a command', () => {
  const { composer, getMode, getStatus } = setup();
  composer.openCompose('branch', 'feat');
  const result = composer.handleKey('escape');
  assert.equal(result, null);
  assert.equal(composer.composeKind, null);
  assert.equal(getMode(), 'review');
  assert.equal(getStatus(), '');
});
