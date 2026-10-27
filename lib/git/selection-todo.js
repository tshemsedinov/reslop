'use strict';

const fs = require('node:fs');

const file = process.argv.at(-1);
const selection = JSON.parse(process.env.RESLOP_SELECTION || '{}');
const { shas, action, messageFile, target } = selection;

const commitLine = (row) => {
  const picked = /^(pick|p)\s+(\S+)/.exec(row);
  if (picked) return { kind: 'pick', sha: picked[2] };
  const merged = /^(merge|m)\s+-[Cc]\s+(\S+)/.exec(row);
  if (merged) return { kind: 'merge', sha: merged[2] };
  if (/^reset\b/.test(row)) return { kind: 'reset', sha: '' };
  return null;
};

const chosen = (sha) => shas.some((full) => full.startsWith(sha));

const sameCommit = (full, abbrev) => full === abbrev || full.startsWith(abbrev);

const fail = (message) => {
  process.stderr.write(`${message}\n`);
  process.exit(1);
};

const dropped = (row, command) => {
  if (command.kind === 'merge') return 'noop';
  return row.replace(/^(pick|p)\s+/, 'drop ');
};

// Later selected commits move next to the oldest. Commits between them stay.
const squashTodo = (rows) => {
  if (!messageFile) fail('missing squash message');
  const commands = rows.map(commitLine);
  const hits = [];
  for (let index = 0; index < commands.length; index++) {
    const command = commands[index];
    if (command && command.sha && chosen(command.sha)) hits.push(index);
  }
  if (hits.length < 2) fail('cannot squash these commits');
  const base = hits[0];
  const later = hits.slice(1);
  const merging = later.some((index) => commands[index].kind === 'merge');
  if (merging) fail('cannot squash a merge');
  const span = commands.slice(base + 1, later.at(-1));
  const crossed = span.some((command) => command && command.kind === 'reset');
  if (crossed) fail('cannot squash across a rebase reset');
  const moved = new Set(later);
  const fixups = later.map((index) =>
    rows[index].replace(/^(pick|p)\s+/, 'fixup '),
  );
  const quoted = JSON.stringify(messageFile);
  const amend = `exec git commit --amend --only -F ${quoted}`;
  const output = [];
  for (let index = 0; index < rows.length; index++) {
    if (moved.has(index)) continue;
    output.push(rows[index]);
    if (index !== base) continue;
    output.push(...fixups, amend);
  }
  return output;
};

const applyTodo = (rows) => {
  if (!target) fail('no fixup target');
  const commands = rows.map(commitLine);
  let fixupAt = -1;
  let targetAt = -1;
  for (let index = 0; index < commands.length; index++) {
    const command = commands[index];
    if (!command || !command.sha) continue;
    if (fixupAt < 0 && chosen(command.sha)) fixupAt = index;
    if (targetAt < 0 && sameCommit(target, command.sha)) targetAt = index;
  }
  const found = fixupAt >= 0 && targetAt >= 0 && fixupAt > targetAt;
  if (!found) fail('cannot apply fixup');
  if (commands[fixupAt].kind !== 'pick') fail('cannot apply a merge');
  const span = commands.slice(targetAt + 1, fixupAt);
  const crossed = span.some((command) => command && command.kind === 'reset');
  if (crossed) fail('cannot apply across a rebase reset');
  const line = rows[fixupAt].replace(/^(pick|p)\s+/, 'fixup ');
  const output = [];
  for (let index = 0; index < rows.length; index++) {
    if (index === fixupAt) continue;
    output.push(rows[index]);
    if (index !== targetAt) continue;
    output.push(line);
  }
  return output;
};

const editTodo = (rows) => {
  if (action === 'squash') return squashTodo(rows);
  if (action === 'apply') return applyTodo(rows);
  const output = [];
  for (const row of rows) {
    const command = commitLine(row);
    const selected = command && command.sha && chosen(command.sha);
    if (selected && action === 'drop') {
      output.push(dropped(row, command));
      continue;
    }
    output.push(row);
    if (selected && action === 'time') {
      output.push('exec git commit --amend --only --no-edit --date=now');
    }
  }
  return output;
};

if (!file || !Array.isArray(shas)) process.exit(1);
const rows = fs.readFileSync(file, 'utf8').split('\n');
fs.writeFileSync(file, editTodo(rows).join('\n'));
