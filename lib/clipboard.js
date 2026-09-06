'use strict';

const { spawnSync } = require('node:child_process');

const { ESC } = require('./ansi.js');

const osc52 = (text) => {
  const b64 = Buffer.from(text, 'utf8').toString('base64');
  return `${ESC}]52;c;${b64}\x07`;
};

const runClip = (cmd, args, text) => {
  const result = spawnSync(cmd, args, {
    input: text,
    encoding: 'utf8',
    timeout: 1000,
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
  if (runClip('wl-copy', [], text)) ok = true;
  else if (runClip('xclip', ['-selection', 'clipboard'], text)) ok = true;
  else if (runClip('xsel', ['--clipboard', '--input'], text)) ok = true;
  return ok;
};

module.exports = { osc52, copyText, runClip };
