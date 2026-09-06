'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { visibleWidth, codeFg, CODE_FG } = require('../lib/ansi.js');

test('eye logo is one column, matching terminal wcwidth', () => {
  assert.equal(visibleWidth('👁️'), 1);
  assert.equal(visibleWidth('👁'), 1);
});

test('wide East Asian and wide emoji are two columns', () => {
  assert.equal(visibleWidth('中'), 2);
  assert.equal(visibleWidth('💠'), 2);
  assert.equal(visibleWidth('A'), 1);
});

test('codeFg ignores non-string and prototype names', () => {
  assert.deepEqual(codeFg(null), CODE_FG.plain);
  assert.deepEqual(codeFg({}), CODE_FG.plain);
  assert.deepEqual(codeFg(Object.prototype.toString), CODE_FG.plain);
  assert.deepEqual(codeFg('constructor'), CODE_FG.plain);
  assert.deepEqual(codeFg('toString'), CODE_FG.plain);
  assert.deepEqual(codeFg('storage'), CODE_FG.storage);
});
