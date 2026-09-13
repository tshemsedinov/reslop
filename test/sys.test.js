'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const sys = require('../lib/sys.js');
const { npmBin, spawnBase, clipTools, watchResize } = sys;

test('npmBin uses npm.cmd on Windows', () => {
  assert.equal(npmBin('win32'), 'npm.cmd');
  assert.equal(npmBin('linux'), 'npm');
  assert.equal(npmBin('darwin'), 'npm');
});

test('spawnBase hides console windows', () => {
  const opts = spawnBase({ cwd: '/tmp' });
  assert.equal(opts.windowsHide, true);
  assert.equal(opts.cwd, '/tmp');
});

test('clipTools picks clip pbcopy and xclip by platform', () => {
  const win = clipTools('win32');
  assert.equal(win.length, 1);
  assert.equal(win[0].cmd, 'clip');
  const mac = clipTools('darwin');
  assert.equal(mac[0].cmd, 'pbcopy');
  const linux = clipTools('linux');
  assert.equal(linux[0].cmd, 'wl-copy');
  assert.equal(linux[1].cmd, 'xclip');
});

test('watchResize listens to stdout resize', () => {
  const stdout = new EventEmitter();
  const proc = new EventEmitter();
  let n = 0;
  const ac = new AbortController();
  watchResize(
    stdout,
    proc,
    () => {
      n += 1;
    },
    ac.signal,
  );
  stdout.emit('resize');
  assert.equal(n, 1);
  ac.abort();
});
