'use strict';

const fs = require('node:fs');
const path = require('node:path');

const IS_WIN = process.platform === 'win32';

const UNIX_CLIP = [
  { cmd: 'wl-copy', args: [] },
  { cmd: 'xclip', args: ['-selection', 'clipboard'] },
  { cmd: 'xsel', args: ['--clipboard', '--input'] },
];

const npmBin = (platform = process.platform) =>
  platform === 'win32' ? 'npm.cmd' : 'npm';

const spawnBase = (extra = {}) => ({ windowsHide: true, ...extra });

const npmOpts = (extra = {}, platform = process.platform) =>
  spawnBase({ shell: platform === 'win32', ...extra });

const clipTools = (platform = process.platform) => {
  if (platform === 'win32') return [{ cmd: 'clip', args: [] }];
  if (platform === 'darwin') return [{ cmd: 'pbcopy', args: [] }];
  return UNIX_CLIP;
};

const listen = (emitter, event, handler) => {
  if (!emitter || typeof emitter.on !== 'function') return () => {};
  emitter.on(event, handler);
  return () => {
    if (typeof emitter.removeListener === 'function') {
      emitter.removeListener(event, handler);
      return;
    }
    if (typeof emitter.off === 'function') emitter.off(event, handler);
  };
};

const watchResize = (stdout, proc, onResize, signal) => {
  const stopStdout = listen(stdout, 'resize', onResize);
  let stopProc = () => {};
  try {
    stopProc = listen(proc, 'SIGWINCH', onResize);
  } catch {
    // SIGWINCH is not available on Windows
  }
  const stop = () => {
    stopStdout();
    stopProc();
  };
  if (signal) {
    if (signal.aborted) stop();
    else signal.addEventListener('abort', stop, { once: true });
  }
  return stop;
};

const canonPath = (value) => {
  try {
    return fs.realpathSync.native(value);
  } catch {
    return path.resolve(value);
  }
};

const samePath = (left, right) => {
  if (left === right) return true;
  const a = canonPath(left);
  const b = canonPath(right);
  if (a === b) return true;
  return IS_WIN && a.toLowerCase() === b.toLowerCase();
};

module.exports = {
  IS_WIN,
  npmBin,
  spawnBase,
  npmOpts,
  clipTools,
  listen,
  watchResize,
  samePath,
};
