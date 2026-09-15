'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const sys = require('../lib/sys.js');
const { npmBin, spawnBase, npmOpts, clipTools, watchResize, samePath } = sys;

test('npmBin uses npm.cmd on Windows', () => {
  assert.equal(npmBin('win32'), 'npm.cmd');
  assert.equal(npmBin('linux'), 'npm');
  assert.equal(npmBin('darwin'), 'npm');
});

test('spawnBase hides console windows', () => {
  const opts = spawnBase({ cwd: '/tmp' });
  assert.equal(opts.windowsHide, true);
  assert.equal(opts.cwd, '/tmp');
  assert.equal(opts.shell, undefined);
});

test('npmOpts uses a shell only on Windows', () => {
  const win = npmOpts({ cwd: 'C:\\repo' }, 'win32');
  assert.equal(win.shell, true);
  assert.equal(win.windowsHide, true);
  assert.equal(win.cwd, 'C:\\repo');
  const unix = npmOpts({ cwd: '/tmp' }, 'linux');
  assert.equal(unix.shell, false);
  assert.equal(unix.windowsHide, true);
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

test('samePath matches slash and symlink variants', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reslop-path-'));
  try {
    const posix = dir.split(path.sep).join('/');
    assert.equal(samePath(dir, dir), true);
    assert.equal(samePath(dir, posix), true);
    assert.equal(samePath(dir, path.join(dir, 'missing')), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
