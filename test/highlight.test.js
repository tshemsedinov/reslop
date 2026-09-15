'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { detectLang } = require('../lib/detect.js');
const { tokenize, overlayTokens, tokensText } = require('../lib/highlight.js');

const stylesOf = (tokens, text) =>
  tokens.filter((t) => t.text === text).map((t) => t.style);

test('AC24 detectLang prefers .d.ts and dotfile rules', () => {
  assert.equal(detectLang('src/a.d.ts'), 'dts');
  assert.equal(detectLang('src/a.ts'), 'ts');
  assert.equal(detectLang('src/a.jsx'), 'jsx');
  assert.equal(detectLang('src/a.tsx'), 'tsx');
  assert.equal(detectLang('lib/main.dart'), 'dart');
  assert.equal(detectLang('.env'), 'dot');
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

test('jsx highlights tags attrs and expressions', () => {
  const src = '<div className="card">{title}</div>';
  const tokens = tokenize('jsx', src);
  assert.equal(tokensText(tokens), src);
  assert.equal(stylesOf(tokens, 'div')[0], 'tag');
  assert.equal(stylesOf(tokens, 'className')[0], 'attr');
  assert.equal(stylesOf(tokens, '"card"')[0], 'string');
  assert.equal(stylesOf(tokens, 'title')[0], 'variable');
});

test('jsx keeps less-than as an operator', () => {
  const src = 'if (a < b) return a;';
  const tokens = tokenize('jsx', src);
  assert.equal(tokensText(tokens), src);
  assert.equal(stylesOf(tokens, '<')[0], 'operator');
});

test('tsx highlights components and keeps types', () => {
  const src = 'const n: number = 1;\nconst el = <Card title={n} />;';
  const tokens = tokenize('tsx', src);
  assert.equal(tokensText(tokens), src);
  assert.equal(stylesOf(tokens, 'number')[0], 'type');
  assert.equal(stylesOf(tokens, 'Card')[0], 'className');
  assert.equal(stylesOf(tokens, 'title')[0], 'attr');
});

test('tsx does not treat generics as jsx', () => {
  const src = 'useState<number>(0)';
  const tokens = tokenize('tsx', src);
  assert.equal(tokensText(tokens), src);
  assert.equal(stylesOf(tokens, 'number')[0], 'type');
  assert.equal(stylesOf(tokens, '<')[0], 'operator');
});

test('dart highlights keywords types and interpolation', () => {
  const interp = '$name';
  const src = `final n = 1;\nString hi = 'Hello ${interp}';`;
  const tokens = tokenize('dart', src);
  assert.equal(tokensText(tokens), src);
  assert.equal(stylesOf(tokens, 'final')[0], 'storage');
  assert.equal(stylesOf(tokens, 'n')[0], 'variable');
  assert.ok(stylesOf(tokens, '1').includes('number'));
  assert.equal(stylesOf(tokens, 'String')[0], 'className');
  assert.equal(stylesOf(tokens, '$name')[0], 'interpolation');
});

test('dart highlights class names comments and annotations', () => {
  const src = '@override\nclass Foo {}\n// note';
  const tokens = tokenize('dart', src);
  assert.equal(tokensText(tokens), src);
  assert.equal(stylesOf(tokens, '@override')[0], 'decorator');
  assert.equal(stylesOf(tokens, 'class')[0], 'storage');
  assert.equal(stylesOf(tokens, 'Foo')[0], 'className');
  assert.equal(stylesOf(tokens, '// note')[0], 'comment');
});

test('toString identifier does not crash tokenize', () => {
  const tokens = tokenize('js', 'foo.toString()');
  assert.equal(tokensText(tokens), 'foo.toString()');
  const name = tokens.find((t) => t.text === 'toString');
  assert.ok(name);
  const pieces = overlayTokens(tokens, [
    { text: 'foo.toString()', changed: false },
  ]);
  assert.equal(tokensText(pieces), 'foo.toString()');
});
