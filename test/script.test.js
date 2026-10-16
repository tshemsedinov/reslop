'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const script = require('../lib/agents/script.js');
const { localBin, scriptUrl, scriptEnv, runScript } = script;

const SCRIPT = {
  unix: 'https://cli.example.dev/install',
  win: 'https://cli.example.dev/install.ps1',
};

test('install scripts are picked per platform and only over https', () => {
  assert.equal(scriptUrl(SCRIPT, 'linux'), SCRIPT.unix);
  assert.equal(scriptUrl(SCRIPT, 'darwin'), SCRIPT.unix);
  assert.equal(scriptUrl(SCRIPT, 'win32'), SCRIPT.win);
  const plain = { unix: 'http://cli.example.dev/install' };
  assert.throws(() => scriptUrl(plain, 'linux'), /https/);
  assert.throws(() => scriptUrl({ unix: SCRIPT.unix }, 'win32'), /platform/);
});

test('an install script finds ~/.local/bin on PATH', () => {
  const home = path.join(path.sep, 'home', 'user');
  const bin = path.join(home, '.local', 'bin');
  assert.equal(localBin({ HOME: home }), bin);
  assert.equal(localBin({}), '');
  const env = scriptEnv({ HOME: home, PATH: '/usr/bin' });
  assert.equal(env.PATH, [bin, '/usr/bin'].join(path.delimiter));
  const kept = scriptEnv({ HOME: home, PATH: bin });
  assert.equal(kept.PATH, bin);
  const windows = scriptEnv({ USERPROFILE: home, Path: 'C:\\bin' });
  assert.equal(windows.Path, [bin, 'C:\\bin'].join(path.delimiter));
  assert.equal(windows.PATH, undefined);
});

test('runScript downloads the script and runs it in a shell', async () => {
  const calls = [];
  const fetch = async (url) => {
    calls.push(url);
    return { ok: true, status: 200, text: async () => 'echo installed\n' };
  };
  const spawned = [];
  const spawn = (cmd, args, options) => {
    const file = args[args.length - 1];
    spawned.push({ cmd, args, options, text: fs.readFileSync(file, 'utf8') });
    const child = new EventEmitter();
    setImmediate(() => child.emit('close', 3));
    return child;
  };
  const env = { HOME: '/home/user', PATH: '/usr/bin' };
  const log = [];
  const options = { fetch, spawn, env, log: (line) => log.push(line) };
  const unix = await runScript(SCRIPT.unix, { ...options, platform: 'linux' });
  assert.equal(unix, 3);
  assert.deepEqual(calls, [SCRIPT.unix]);
  assert.equal(spawned[0].cmd, 'bash');
  assert.equal(spawned[0].text, 'echo installed\n');
  assert.match(spawned[0].options.env.PATH, /\.local/);
  assert.equal(fs.existsSync(spawned[0].args[0]), false);
  assert.match(log[0], /Downloading https:\/\/cli\.example\.dev\/install/);
  await runScript(SCRIPT.win, { ...options, platform: 'win32' });
  assert.equal(spawned[1].cmd, 'powershell.exe');
  assert.deepEqual(spawned[1].args.slice(0, 4), [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
  ]);
  assert.match(spawned[1].args[4], /install\.ps1$/);
});

test('runScript stops when the download fails', async () => {
  const fetch = async () => ({ ok: false, status: 404 });
  const spawn = () => assert.fail('nothing to run');
  await assert.rejects(
    runScript(SCRIPT.unix, { fetch, spawn }),
    /download failed \(404\)/,
  );
  await assert.rejects(
    runScript('http://cli.example.dev/install', { fetch, spawn }),
    /https/,
  );
});
