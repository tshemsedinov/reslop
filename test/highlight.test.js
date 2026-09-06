'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { detectLang } = require('../lib/detect.js');
const { tokenize, overlayTokens, tokensText } = require('../lib/highlight.js');

const stylesOf = (tokens, text) =>
  tokens.filter((t) => t.text === text).map((t) => t.style);

test('AC24 detectLang follows metascope path map', () => {
  assert.equal(detectLang('src/a.js'), 'js');
  assert.equal(detectLang('src/a.mjs'), 'mjs');
  assert.equal(detectLang('src/a.ts'), 'ts');
  assert.equal(detectLang('src/a.d.ts'), 'dts');
  assert.equal(detectLang('pkg.json'), 'json');
  assert.equal(detectLang('app.css'), 'css');
  assert.equal(detectLang('index.html'), 'html');
  assert.equal(detectLang('data.csv'), 'csv');
  assert.equal(detectLang('run.sh'), 'bash');
  assert.equal(detectLang('.env'), 'dot');
  assert.equal(detectLang('notes.txt'), 'txt');
  assert.equal(detectLang('app.py'), 'py');
});

test('AC24 js tokens for const assignment', () => {
  const tokens = tokenize('js', 'const x = 1;');
  assert.deepEqual(stylesOf(tokens, 'const'), ['storage']);
  assert.deepEqual(stylesOf(tokens, 'x'), ['variable']);
  assert.ok(stylesOf(tokens, '1').includes('number'));
  assert.equal(tokensText(tokens), 'const x = 1;');
});

test('AC24 overlay keeps syntax on changed pieces', () => {
  const tokens = tokenize('js', 'const x = 1;');
  const spans = [
    { text: 'const x = ', changed: false },
    { text: '1', changed: true },
    { text: ';', changed: false },
  ];
  const pieces = overlayTokens(tokens, spans);
  const one = pieces.find((p) => p.text === '1');
  assert.ok(one);
  assert.equal(one.style, 'number');
  assert.equal(one.changed, true);
  const cst = pieces.find((p) => p.text === 'const');
  assert.equal(cst.style, 'storage');
  assert.equal(cst.changed, false);
});

test('json property vs string', () => {
  const tokens = tokenize('json', '{"a":"b"}');
  assert.equal(stylesOf(tokens, '"a"')[0], 'property');
  assert.equal(stylesOf(tokens, '"b"')[0], 'string');
});

test('bash highlights echo as function', () => {
  const tokens = tokenize('bash', 'echo "hi"');
  assert.equal(stylesOf(tokens, 'echo')[0], 'function');
});

test('toString identifier does not crash tokenize', () => {
  const tokens = tokenize('js', 'foo.toString()');
  assert.equal(tokensText(tokens), 'foo.toString()');
  const name = tokens.find((t) => t.text === 'toString');
  assert.ok(name);
  assert.equal(typeof name.style, 'string');
  const pieces = overlayTokens(tokens, [
    { text: 'foo.toString()', changed: false },
  ]);
  assert.equal(tokensText(pieces), 'foo.toString()');
});
