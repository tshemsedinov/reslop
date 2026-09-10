'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const keys = require('../lib/keys.js');
const { ACTIONS, FILES_DISABLED, decodeChunk, actionFromKey, hitAction } = keys;
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

test('actionFromKey maps aliases and ignores unbound keys', () => {
  assert.equal(actionFromKey('right'), 'next');
  assert.equal(actionFromKey('up'), 'scrollUp');
  assert.equal(actionFromKey('down'), 'scrollDown');
  assert.equal(actionFromKey('enter'), 'open');
  assert.equal(actionFromKey('backspace'), 'removeTodo');
  assert.equal(actionFromKey('delete'), 'removeTodo');
  assert.equal(actionFromKey('j'), null);
  assert.equal(actionFromKey('k'), null);
  assert.equal(actionFromKey('s'), null);
  assert.equal(actionFromKey('h'), null);
  assert.equal(actionFromKey('?'), null);
  assert.equal(actionFromKey('v'), null);
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
  assert.equal(layout.parts[3].action.id, 'prev');
  assert.equal(layout.parts[4].action.id, 'next');
  assert.equal(hitAction(layout.hits, layout.hits[0].x0), 'add');
  const letters = layoutButtons(20, true);
  assert.equal(letters.parts[0].label, 'a');
  assert.equal(letters.parts[0].piece, '  a');
  assert.ok(!letters.parts[0].piece.includes('['));
  const prev = letters.parts.find((part) => part.action.id === 'prev');
  assert.equal(prev.label, '←');
  const off = layoutButtons(160, false, FILES_DISABLED);
  const hitIds = off.hits.map((hit) => hit.id);
  assert.equal(hitIds.includes('layout'), false);
  assert.equal(hitIds.includes('feedback'), false);
  assert.equal(hitIds.includes('add'), true);
  const mode = off.parts.find((part) => part.action.id === 'layout');
  assert.equal(mode.disabled, true);
});

test('buttonWord prefixes a hot mark when it is not in the label', () => {
  assert.equal(actionLetter(ACTIONS.next), '→');
  assert.equal(actionLetter(ACTIONS.prev), '←');
  assert.equal(buttonWord(ACTIONS.next), '→next');
  assert.equal(buttonWord(ACTIONS.prev), '←prev');
});
