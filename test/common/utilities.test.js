'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { mergeTexts } = require('../../lib/common/utilities.js');

test('mergeTexts joins edits apart and refuses edits that touch', () => {
  const merged = mergeTexts('abc\ndef\n', 'xabc\ndef\n', 'abc\ndefy\n');
  assert.equal(merged, 'xabc\ndefy\n');
  assert.equal(mergeTexts('abcdef', 'aXcdef', 'abcdYf'), 'aXcdYf');
  assert.equal(mergeTexts('abc', 'aXc', 'aYc'), null);
  assert.equal(mergeTexts('abc', 'abcX', 'abcY'), null);
});
