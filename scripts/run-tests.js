#!/usr/bin/env node
'use strict';

const { spawnSync } = require('node:child_process');

const { spawnBase } = require('../lib/common/process.js');

const FORCE_EXIT = '--test-force-exit';

// Node 18 exits 9 on this flag. It arrived in 20.14 and 22.
const allowsForceExit = (version) => {
  const [major, minor] = version.split('.').map(Number);
  if (major > 21) return true;
  return major === 20 && minor >= 14;
};

const testArgs = (version) => {
  const args = ['--test'];
  if (allowsForceExit(version)) args.push(FORCE_EXIT);
  return args;
};

const args = testArgs(process.versions.node);
const result = spawnSync(process.execPath, args, {
  ...spawnBase(),
  stdio: 'inherit',
});

if (result.error) throw result.error;
process.exit(result.status ?? 1);
