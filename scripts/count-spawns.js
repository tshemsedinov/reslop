'use strict';

// Counts the processes that tests start, to see what is costly where starting
// a process is slow, as on Windows. Preload it into the tests, then read it:
//   node --require ./scripts/count-spawns.js --test
//   node scripts/count-spawns.js
// Every process appends its counts to the file in SPAWN_COUNTS, or in the
// temporary directory

const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const FILE = process.env.SPAWN_COUNTS || path.join(os.tmpdir(), 'spawns.log');
const TOP = 25;
const KEY_MAX = 60;
const NAMES = ['spawn', 'spawnSync', 'execFile', 'execFileSync'];

const keyOf = (cmd, args) => {
  const list = Array.isArray(args) ? args : [];
  const sub = list.find((arg) => !`${arg}`.startsWith('-')) ?? '';
  const name = path.basename(`${cmd}`).replace(/\.(exe|cmd)$/, '');
  return `${name} ${sub}`.trim().slice(0, KEY_MAX);
};

const record = () => {
  const counts = {};
  for (const name of NAMES) {
    const original = cp[name];
    cp[name] = function patched(cmd, args, ...rest) {
      const key = keyOf(cmd, args);
      counts[key] = (counts[key] ?? 0) + 1;
      return original.call(this, cmd, args, ...rest);
    };
  }
  process.on('exit', () => {
    fs.appendFileSync(FILE, `${JSON.stringify(counts)}\n`);
  });
};

const summary = () => {
  const total = {};
  const text = fs.existsSync(FILE) ? fs.readFileSync(FILE, 'utf8') : '';
  const lines = text.split('\n').filter(Boolean);
  for (const line of lines) {
    for (const [key, count] of Object.entries(JSON.parse(line))) {
      total[key] = (total[key] ?? 0) + count;
    }
  }
  const list = Object.entries(total).sort((a, b) => b[1] - a[1]);
  const all = list.reduce((sum, [, count]) => sum + count, 0);
  console.log(`# processes started: ${all} by ${lines.length} node processes`);
  for (const [key, count] of list.slice(0, TOP)) {
    console.log(`${`${count}`.padStart(7)}  ${key}`);
  }
  fs.rmSync(FILE, { force: true });
};

if (require.main === module) summary();
else record();
