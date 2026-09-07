#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const binSrc = path.join(root, 'bin', 'metadiff.js');
const home = os.homedir();
const destDir = process.env.METADIFF_BIN_DIR
  ? path.resolve(process.env.METADIFF_BIN_DIR)
  : path.join(home, '.local', 'bin');
const dest = path.join(destDir, 'metadiff');

const MARK_BEGIN = '# >>> metadiff >>>';
const MARK_END = '# <<< metadiff <<<';

const shellBlock = `${MARK_BEGIN}
export PATH="$HOME/.local/bin:$PATH"
${MARK_END}
`;

const stripMarkedBlock = (text) => {
  if (!text.includes(MARK_BEGIN)) return text;
  return text.replace(
    new RegExp(`${MARK_BEGIN}[\\s\\S]*?${MARK_END}\\n?`, 'm'),
    '',
  );
};

const readTextOrEmpty = (filePath) => {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
};

const upsertShellConfig = (filePath) => {
  let text = readTextOrEmpty(filePath);
  text = stripMarkedBlock(text);
  if (text.length && !text.endsWith('\n')) text += '\n';
  text += `\n${shellBlock}`;
  fs.writeFileSync(filePath, text);
  console.log(`metadiff: updated ${filePath}`);
};

const removeMarkedBlock = (filePath) => {
  if (!fs.existsSync(filePath)) return;
  try {
    let text = fs.readFileSync(filePath, 'utf8');
    if (!text.includes(MARK_BEGIN)) return;
    text = stripMarkedBlock(text);
    fs.writeFileSync(filePath, text);
    console.log(`metadiff: cleaned old block from ${filePath}`);
  } catch (error) {
    console.log(`metadiff: skip ${filePath} (${error.message})`);
  }
};

const installBin = () => {
  fs.chmodSync(binSrc, 0o755);
  fs.mkdirSync(destDir, { recursive: true });

  try {
    fs.lstatSync(dest);
    fs.unlinkSync(dest);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  try {
    fs.symlinkSync(binSrc, dest);
    console.log(`metadiff: linked ${dest} → ${binSrc}`);
  } catch (error) {
    try {
      fs.unlinkSync(dest);
    } catch (unlinkError) {
      void unlinkError;
    }
    const wrapper = `#!/usr/bin/env bash
exec node ${JSON.stringify(binSrc)} "$@"
`;
    try {
      fs.writeFileSync(dest, wrapper, { mode: 0o755, flag: 'wx' });
      console.log(`metadiff: installed wrapper ${dest}`);
      console.log(`(symlink failed: ${error.message}; used wrapper instead)`);
    } catch (writeError) {
      console.error(
        `metadiff: could not install bin at ${dest}: ${writeError.message}`,
      );
      process.exit(1);
    }
  }
};

installBin();

const bashrcd = path.join(home, '.bashrc.d');
const dropIn = path.join(bashrcd, 'metadiff.sh');
try {
  if (fs.existsSync(bashrcd) || fs.existsSync(path.join(home, '.bashrc'))) {
    fs.mkdirSync(bashrcd, { recursive: true });
    fs.writeFileSync(dropIn, shellBlock, { mode: 0o644 });
    console.log(`metadiff: wrote ${dropIn}`);
    removeMarkedBlock(path.join(home, '.bashrc'));
  }
} catch (error) {
  console.log(`metadiff: skip shell drop-in (${error.message})`);
}

try {
  const envDir = path.join(home, '.config', 'environment.d');
  fs.mkdirSync(envDir, { recursive: true });
  const envFile = path.join(envDir, 'metadiff.conf');
  fs.writeFileSync(envFile, `PATH=${destDir}:$PATH\n`);
  console.log(`metadiff: wrote ${envFile}`);
} catch (error) {
  console.log(`metadiff: skip environment.d (${error.message})`);
}

for (const rc of [path.join(home, '.zshrc'), path.join(home, '.profile')]) {
  if (!fs.existsSync(rc)) continue;
  try {
    upsertShellConfig(rc);
  } catch (error) {
    console.log(`metadiff: skip ${rc} (${error.message})`);
  }
}

const check = spawnSync(dest, ['--help'], { encoding: 'utf8' });
if (check.status !== 0) {
  console.error('metadiff: enable finished but binary failed to run:');
  console.error(check.stderr || check.stdout || check.error);
  process.exit(1);
}

const ready = [
  '',
  'Ready. Apply in this terminal:',
  '',
  '  source ~/.bashrc.d/metadiff.sh',
  '',
  'Then run metadiff from any git repository.',
  '',
];
console.log(ready.join('\n'));
