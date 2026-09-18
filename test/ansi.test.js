'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const ansi = require('../lib/ansi.js');

const { visibleWidth, codeFg, CODE_FG, THEME, PALETTES } = ansi;
const { setTheme, themeName } = ansi;

test('eye logo is one column, matching terminal wcwidth', () => {
  assert.equal(visibleWidth('👁️'), 1);
  assert.equal(visibleWidth('👁'), 1);
});

test('wide East Asian and wide emoji are two columns', () => {
  assert.equal(visibleWidth('中'), 2);
  assert.equal(visibleWidth('💠'), 2);
});

test('codeFg ignores non-string and prototype names', () => {
  assert.deepEqual(codeFg(null), CODE_FG.plain);
  assert.deepEqual(codeFg({}), CODE_FG.plain);
  assert.deepEqual(codeFg(Object.prototype.toString), CODE_FG.plain);
  assert.deepEqual(codeFg('constructor'), CODE_FG.plain);
  assert.deepEqual(codeFg('toString'), CODE_FG.plain);
  assert.deepEqual(codeFg('storage'), CODE_FG.storage);
});

test('light and dark palettes define the same colors', () => {
  const { dark, light } = PALETTES;
  assert.deepEqual(Object.keys(light.ui).sort(), Object.keys(dark.ui).sort());
  const codeKeys = Object.keys(dark.code).sort();
  assert.deepEqual(Object.keys(light.code).sort(), codeKeys);
  assert.equal(light.logCols.length, dark.logCols.length);
});

test('setTheme swaps colors in place and rejects unknown names', () => {
  const theme = THEME;
  try {
    setTheme('light');
    assert.equal(themeName(), 'light');
    assert.equal(THEME, theme);
    assert.deepEqual(THEME.ctxBg, PALETTES.light.ui.ctxBg);
    assert.deepEqual(codeFg('logCol1'), PALETTES.light.logCols[1]);
    assert.throws(() => setTheme('blue'), /unknown theme blue/);
    setTheme('dark');
    assert.deepEqual(THEME.ctxBg, PALETTES.dark.ui.ctxBg);
    assert.deepEqual(CODE_FG.plain, PALETTES.dark.code.plain);
  } finally {
    setTheme('dark');
  }
});
