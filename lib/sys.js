'use strict';

const IS_WIN = process.platform === 'win32';

const UNIX_CLIP = [
  { cmd: 'wl-copy', args: [] },
  { cmd: 'xclip', args: ['-selection', 'clipboard'] },
  { cmd: 'xsel', args: ['--clipboard', '--input'] },
];

const npmBin = (platform = process.platform) =>
  platform === 'win32' ? 'npm.cmd' : 'npm';

const spawnBase = (extra = {}) => ({ windowsHide: true, ...extra });

const clipTools = (platform = process.platform) => {
  if (platform === 'win32') return [{ cmd: 'clip', args: [] }];
  if (platform === 'darwin') return [{ cmd: 'pbcopy', args: [] }];
  return UNIX_CLIP;
};

const watchResize = (stdout, proc, onResize, signal) => {
  if (stdout && typeof stdout.on === 'function') {
    stdout.on('resize', onResize, { signal });
  }
  try {
    proc.on('SIGWINCH', onResize, { signal });
  } catch {
    // SIGWINCH is not available on Windows
  }
};

module.exports = { IS_WIN, npmBin, spawnBase, clipTools, watchResize };
