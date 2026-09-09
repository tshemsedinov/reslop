'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const keys = require('../lib/keys.js');
const { ACTIONS, decodeChunk, actionFromKey, hitAction } = keys;
const { actionLetter, buttonWord } = keys;
const { layoutButtons } = require('../lib/render.js');

test('decodeChunk maps letters and arrows', () => {
  const keys = decodeChunk('ar').events.map((event) => event.key);
  assert.deepEqual(keys, ['a', 'r']);
  const up = decodeChunk('\x1b[A').events[0];
  assert.equal(up.key, 'up');
  const pending = decodeChunk('\x1b');
  assert.equal(pending.events.length, 0);
  assert.equal(pending.carry, '\x1b');
  const completed = decodeChunk('[A', pending.carry);
  assert.equal(completed.events[0].key, 'up');
  const enter = decodeChunk('\r').events[0];
  assert.equal(enter.key, 'enter');
  const back = decodeChunk('\x7f').events[0];
  assert.equal(back.key, 'backspace');
  const tab = decodeChunk('\t').events[0];
  assert.equal(tab.key, 'tab');
  const save = decodeChunk('\x13').events[0];
  assert.equal(save.key, 'ctrl-s');
  const undo = decodeChunk('\x1a').events[0];
  assert.equal(undo.key, 'ctrl-z');
  const del = decodeChunk('\x1b[3~').events[0];
  assert.equal(del.key, 'delete');
});

test('decodeChunk parses SGR mouse press', () => {
  const event = decodeChunk('\x1b[<0;4;12M').events[0];
  assert.equal(event.type, 'mouse');
  assert.equal(event.button, 0);
  assert.equal(event.x, 4);
  assert.equal(event.y, 12);
  assert.equal(event.press, true);
  assert.equal(event.kind, 'press');
});

test('decodeChunk parses SGR mouse drag and release', () => {
  const drag = decodeChunk('\x1b[<32;10;5M').events[0];
  assert.equal(drag.kind, 'drag');
  assert.equal(drag.btn, 0);
  const up = decodeChunk('\x1b[<0;10;5m').events[0];
  assert.equal(up.kind, 'release');
  assert.equal(up.press, false);
});

test('actionFromKey matches ACTIONS', () => {
  assert.equal(actionFromKey('a'), 'add');
  assert.equal(actionFromKey('u'), 'unstage');
  assert.equal(actionFromKey('r'), 'revert');
  assert.equal(actionFromKey('s'), 'skip');
  assert.equal(actionFromKey('n'), 'next');
  assert.equal(actionFromKey('right'), 'next');
  assert.equal(actionFromKey('p'), 'prev');
  assert.equal(actionFromKey('l'), 'files');
  assert.equal(actionFromKey('m'), 'layout');
  assert.equal(actionFromKey('f'), 'feedback');
  assert.equal(actionFromKey('t'), 'todo');
  assert.equal(actionFromKey('v'), null);
  assert.equal(actionFromKey('g'), null);
  assert.equal(actionFromKey('enter'), 'open');
  assert.equal(actionFromKey('backspace'), 'removeTodo');
  assert.equal(actionFromKey('delete'), 'removeTodo');
  assert.equal(actionFromKey('q'), 'quit');
  assert.equal(actionFromKey('escape'), null);
});

test('layoutButtons hitboxes cover labels', () => {
  const layout = layoutButtons(160, false);
  assert.equal(layout.hits[0].id, 'add');
  assert.equal(layout.parts[0].label, 'add');
  assert.equal(layout.parts[0].letter, 'a');
  assert.equal(layout.parts[0].piece, '  add');
  assert.ok(!layout.parts[0].piece.includes('['));
  assert.equal(layout.parts[1].action.id, 'unstage');
  assert.equal(layout.parts[4].action.id, 'prev');
  assert.equal(layout.parts[5].action.id, 'next');
  assert.equal(hitAction(layout.hits, layout.hits[0].x0), 'add');
  assert.equal(ACTIONS[0].id, 'add');
  const ids = ACTIONS.map((action) => action.id);
  assert.deepEqual(ids.slice(0, 3), ['add', 'unstage', 'revert']);
  assert.deepEqual(ids.slice(4, 6), ['prev', 'next']);
  const letters = layoutButtons(20, true);
  assert.equal(letters.parts[0].label, 'a');
  assert.equal(letters.parts[0].piece, '  a');
  assert.ok(!letters.parts[0].piece.includes('['));
  const prev = letters.parts.find((part) => part.action.id === 'prev');
  assert.equal(prev.label, '←');
});

test('actionLetter is the bound letter inside the word', () => {
  const byId = Object.fromEntries(ACTIONS.map((a) => [a.id, a]));
  assert.equal(actionLetter(byId.add), 'a');
  assert.equal(actionLetter(byId.unstage), 'u');
  assert.equal(actionLetter(byId.revert), 'r');
  assert.equal(actionLetter(byId.files), 'l');
  assert.equal(actionLetter(byId.next), '→');
  assert.equal(actionLetter(byId.prev), '←');
  assert.equal(buttonWord(byId.add), 'add');
  assert.equal(buttonWord(byId.unstage), 'unstage');
  assert.equal(buttonWord(byId.next), '→next');
  assert.equal(buttonWord(byId.prev), '←prev');
});
