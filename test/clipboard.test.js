'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { osc52 } = require('../lib/clipboard.js');
const { ESC } = require('../lib/ansi.js');

test('osc52 encodes UTF-8 as base64', () => {
  const seq = osc52('hi');
  const b64 = Buffer.from('hi', 'utf8').toString('base64');
  assert.equal(seq, `${ESC}]52;c;${b64}\x07`);
});
