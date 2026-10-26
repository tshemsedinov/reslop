'use strict';

const fs = require('node:fs');

const file = process.argv.at(-1);
const { shas, action } = JSON.parse(process.env.RESLOP_SELECTION);
const rows = fs.readFileSync(file, 'utf8').split('\n');
const output = [];
for (const row of rows) {
  const picked = /^(pick|p)\s+(\S+)/.exec(row);
  const merged = /^(merge|m)\s+-[Cc]\s+(\S+)/.exec(row);
  const commit = picked || merged;
  const selected = commit && shas.some((sha) => sha.startsWith(commit[2]));
  if (selected && action === 'drop') {
    output.push(merged ? 'noop' : row.replace(/^(pick|p)\s+/, 'drop '));
    continue;
  }
  output.push(row);
  if (selected && action === 'time') {
    output.push('exec git commit --amend --only --no-edit --date=now');
  }
}
fs.writeFileSync(file, output.join('\n'));
