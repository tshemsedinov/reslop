'use strict';

const { spawnSync } = require('node:child_process');

const { ESC } = require('./ansi.js');

const CLIP_TIMEOUT_MS = 1000;
const CLIP_TOOLS = [
  { cmd: 'wl-copy', args: [] },
  { cmd: 'xclip', args: ['-selection', 'clipboard'] },
  { cmd: 'xsel', args: ['--clipboard', '--input'] },
];

const osc52 = (text) => {
  const b64 = Buffer.from(text, 'utf8').toString('base64');
  return `${ESC}]52;c;${b64}\x07`;
};

const runClip = (cmd, args, text) => {
  const result = spawnSync(cmd, args, {
    input: text,
    encoding: 'utf8',
    timeout: CLIP_TIMEOUT_MS,
  });
  if (result.error) return false;
  return result.status === 0;
};

const copyText = (text, stdout) => {
  if (!text) return false;
  let ok = false;
  if (stdout && stdout.write) {
    stdout.write(osc52(text));
    ok = true;
  }
  for (const tool of CLIP_TOOLS) {
    if (runClip(tool.cmd, tool.args, text)) return true;
  }
  return ok;
};

module.exports = { osc52, copyText, runClip };
