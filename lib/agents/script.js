'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

// Where the install scripts of agent CLIs put their command
const localBin = (env = process.env) => {
  const home = env.HOME || env.USERPROFILE;
  return home ? path.join(home, '.local', 'bin') : '';
};

const httpsUrl = (href) => {
  if (!href) throw new Error('no install script for this platform');
  const url = new URL(href);
  if (url.protocol !== 'https:') {
    throw new Error('install script must use https');
  }
  return url.href;
};

// The script a vendor publishes for this platform
const scriptUrl = (script, platform = process.platform) =>
  httpsUrl(platform === 'win32' ? script.win : script.unix);

const shellOf = (file, platform) => {
  if (platform !== 'win32') return ['bash', [file]];
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file];
  return ['powershell.exe', args];
};

// The script finds the directory it installs to on PATH and does not fail
const scriptEnv = (env) => {
  const bin = localBin(env);
  const key = Object.keys(env).find((name) => name.toUpperCase() === 'PATH');
  const name = key ?? 'PATH';
  const dirs = `${env[name] ?? ''}`.split(path.delimiter).filter(Boolean);
  if (!bin || dirs.includes(bin)) return { ...env };
  return { ...env, [name]: [bin, ...dirs].join(path.delimiter) };
};

const runFile = (cmd, args, env, spawnImpl) =>
  new Promise((resolve, reject) => {
    const stdio = ['ignore', 'inherit', 'inherit'];
    const child = spawnImpl(cmd, args, { env, stdio, windowsHide: true });
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 1));
  });

const runScript = async (url, options = {}) => {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('fetch is not available');
  }
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const log = options.log ?? (() => {});
  const href = httpsUrl(url);
  log(`Downloading ${href}…`);
  const response = await fetchImpl(href);
  if (!response || !response.ok) {
    const status = response ? ` (${response.status})` : '';
    throw new Error(`download failed${status}`);
  }
  const text = await response.text();
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'reslop-'));
  try {
    const name = platform === 'win32' ? 'install.ps1' : 'install.sh';
    const file = path.join(dir, name);
    await fs.promises.writeFile(file, text, { mode: 0o600 });
    const [cmd, args] = shellOf(file, platform);
    const spawnImpl = options.spawn ?? spawn;
    return await runFile(cmd, args, scriptEnv(env), spawnImpl);
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
};

const main = async () => {
  try {
    process.exitCode = await runScript(process.argv[2], {
      log: (line) => process.stdout.write(`${line}\n`),
    });
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
};

if (require.main === module) void main();

module.exports = { localBin, scriptUrl, scriptEnv, runScript };
