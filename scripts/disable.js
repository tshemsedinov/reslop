#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const home = os.homedir();
const destDir = process.env.METADIFF_BIN_DIR
  ? path.resolve(process.env.METADIFF_BIN_DIR)
  : path.join(home, '.local', 'bin');
const dest = path.join(destDir, 'metadiff');

const MARK_BEGIN = '# >>> metadiff >>>';
const MARK_END = '# <<< metadiff <<<';

try {
  if (fs.existsSync(dest) || fs.lstatSync(dest).isSymbolicLink()) {
    fs.unlinkSync(dest);
    console.log(`metadiff: removed ${dest}`);
  } else {
    console.log(`metadiff: nothing to remove at ${dest}`);
  }
} catch (error) {
  console.log(`metadiff: could not remove bin (${error.message})`);
}

const dropIn = path.join(home, '.bashrc.d', 'metadiff.sh');
if (fs.existsSync(dropIn)) {
  fs.unlinkSync(dropIn);
  console.log(`metadiff: removed ${dropIn}`);
}

const envFile = path.join(home, '.config', 'environment.d', 'metadiff.conf');
if (fs.existsSync(envFile)) {
  fs.unlinkSync(envFile);
  console.log(`metadiff: removed ${envFile}`);
}

const profiles = [
  path.join(home, '.bashrc'),
  path.join(home, '.zshrc'),
  path.join(home, '.profile'),
];

for (const filePath of profiles) {
  if (!fs.existsSync(filePath)) continue;
  try {
    let text = fs.readFileSync(filePath, 'utf8');
    if (!text.includes(MARK_BEGIN)) continue;
    const re = new RegExp(`${MARK_BEGIN}[\\s\\S]*?${MARK_END}\\n?`, 'm');
    text = text.replace(re, '');
    fs.writeFileSync(filePath, text);
    console.log(`metadiff: cleaned ${filePath}`);
  } catch (error) {
    console.log(`metadiff: skip ${filePath} (${error.message})`);
  }
}
