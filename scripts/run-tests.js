#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { spawnBase } = require('../lib/common/process.js');

const FORCE_EXIT = '--test-force-exit';
const TEST_DIR = path.join(__dirname, '..', 'test');

// These files start git, node, or npm. On Windows that is most of CI, so
// `npm test` leaves them out. Run one with `node --test test/<name>`, or
// all of them with `node scripts/run-tests.js --proc`.
const PROCESS_TESTS = [
  'acp.test.js',
  'agents.test.js',
  'cli.test.js',
  'dashboard.test.js',
  'deps.test.js',
  'git.test.js',
  'report-node.test.js',
  'report.test.js',
  'session.test.js',
  'workspace.test.js',
  'worktrees-npm.test.js',
  'worktrees-runs.test.js',
  'worktrees.test.js',
];

const isTestFile = (name) => name.endsWith('.test.js');

const allowsForceExit = (version) => {
  const [major, minor] = version.split('.').map(Number);
  if (major > 21) return true;
  return major === 20 && minor >= 14;
};

const listedTests = (processTests) => {
  const names = fs.readdirSync(TEST_DIR).filter(isTestFile);
  const wanted = (name) => PROCESS_TESTS.includes(name) === processTests;
  const picked = names.filter(wanted);
  picked.sort();
  return picked.map((name) => path.join('test', name));
};

const testArgs = (version, files) => {
  const args = ['--test'];
  if (allowsForceExit(version)) args.push(FORCE_EXIT);
  args.push(...files);
  return args;
};

const processTests = process.argv.includes('--proc');
const files = listedTests(processTests);
if (!files.length) {
  process.stderr.write('reslop: no test files\n');
  process.exit(1);
}

const args = testArgs(process.versions.node, files);
const result = spawnSync(process.execPath, args, {
  ...spawnBase(),
  stdio: 'inherit',
});

if (result.error) throw result.error;
process.exit(result.status ?? 1);
