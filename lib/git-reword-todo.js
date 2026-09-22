'use strict';

const fs = require('node:fs');

const file = process.argv[process.argv.length - 1];
const msg = process.env.RESLOP_REWORD_FILE;
if (!file || !msg) process.exit(1);
const text = fs.readFileSync(file, 'utf8');
const rows = text.split('\n');
const out = [];
let seen = false;
for (const row of rows) {
  out.push(row);
  if (seen) continue;
  if (!/^(pick|p)\s+/.test(row)) continue;
  const spec = JSON.stringify(msg);
  out.push(`exec git commit --amend --only -F ${spec}`);
  seen = true;
}
fs.writeFileSync(file, out.join('\n'));
