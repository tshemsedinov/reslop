'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const cli = require('../lib/cli.js');
const { run, startPaneFromPaths, resolveScope } = cli;
const { parseArgv, helpText } = cli;

const { makeRepo, sink } = require('./helpers.js');

const fakeProc = (cwd, extra = {}) => {
  const stdout = sink();
  const stderr = sink();
  return {
    argv: extra.argv ?? ['node', 'metadiff'],
    cwd: () => cwd,
    stdin: { isTTY: extra.tty ?? false },
    stdout,
    stderr,
    env: extra.env ?? {},
    stdoutText: () => stdout.dump(),
    stderrText: () => stderr.dump(),
  };
};

test('AC11 not a git directory exits 1', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metadiff-nogit-'));
  try {
    const proc = fakeProc(dir);
    const code = await run(proc);
    assert.equal(code, 1);
    assert.match(proc.stderrText(), /not a git repository/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('AC12 clean repo prints nothing to review', async () => {
  const repo = makeRepo();
  try {
    repo.write('a.txt', 'ok\n');
    repo.git(['add', 'a.txt']);
    repo.git(['commit', '-m', 'init']);
    const proc = fakeProc(repo.dir);
    const code = await run(proc);
    assert.equal(code, 0);
    assert.equal(proc.stdoutText(), 'nothing to review\n');
  } finally {
    repo.cleanup();
  }
});

test('parseArgv accepts -n and --new', () => {
  assert.equal(parseArgv([]).newReview, false);
  assert.equal(parseArgv(['-n']).newReview, true);
  assert.equal(parseArgv(['--new', 'lib']).newReview, true);
  assert.deepEqual(parseArgv(['--new', 'lib']).paths, ['lib']);
  assert.match(helpText(), /-n \/ --new/);
});

test('unknown option exits 1', async () => {
  const proc = fakeProc(process.cwd(), {
    argv: ['node', 'metadiff', '--nope'],
  });
  const code = await run(proc);
  assert.equal(code, 1);
  assert.match(proc.stderrText(), /unknown option/);
});

test('AC14 start pane is files with no paths or a directory', () => {
  assert.equal(startPaneFromPaths('/repo', []), 'files');
  const statSync = (full) => {
    if (full.endsWith(`${path.sep}src`)) {
      return { isFile: () => false, isDirectory: () => true };
    }
    return { isFile: () => true, isDirectory: () => false };
  };
  assert.equal(startPaneFromPaths('/repo', ['src'], statSync), 'files');
  assert.equal(startPaneFromPaths('/repo', ['a.js'], statSync), 'diff');
});

test('AC22 resolveScope peels a commit from argv', () => {
  const missing = () => {
    const err = new Error('enoent');
    err.code = 'ENOENT';
    throw err;
  };
  const repo = {
    resolveRev: (cwd, spec) => {
      if (spec === '7ac260c') return '7ac260c3023283715b94337991458667b6c2a14d';
      return null;
    },
  };
  const peeled = resolveScope('/repo', ['7ac260c'], repo, missing);
  assert.equal(peeled.rev, '7ac260c3023283715b94337991458667b6c2a14d');
  assert.deepEqual(peeled.paths, []);
  assert.equal(startPaneFromPaths('/repo', peeled.paths, missing), 'files');
  const scoped = resolveScope('/repo', ['7ac260c', 'lib'], repo, missing);
  assert.equal(scoped.rev, peeled.rev);
  assert.deepEqual(scoped.paths, ['lib']);
  const exists = (full) => {
    if (full.endsWith(`${path.sep}src`)) return { isFile: () => false };
    throw Object.assign(new Error('enoent'), { code: 'ENOENT' });
  };
  const pathWins = resolveScope('/repo', ['src'], repo, exists);
  assert.equal(pathWins.rev, null);
  assert.deepEqual(pathWins.paths, ['src']);
});

test('AC22 unknown sha exits 1', async () => {
  const repo = makeRepo();
  try {
    repo.write('a.txt', 'ok\n');
    repo.git(['add', 'a.txt']);
    repo.git(['commit', '-m', 'init']);
    const fake = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const proc = fakeProc(repo.dir, {
      argv: ['node', 'metadiff', fake],
    });
    const code = await run(proc);
    assert.equal(code, 1);
    assert.match(proc.stderrText(), /bad revision/);
  } finally {
    repo.cleanup();
  }
});

test('AC20 commit argv loads that commit not worktree', async () => {
  const repo = makeRepo();
  try {
    repo.write('a.txt', 'one\n');
    repo.git(['add', 'a.txt']);
    repo.git(['commit', '-m', 'one']);
    repo.write('a.txt', 'two\n');
    repo.git(['add', 'a.txt']);
    repo.git(['commit', '-m', 'two']);
    const sha = repo.git(['rev-parse', 'HEAD']).trim();
    repo.write('a.txt', 'DIRTY\n');
    const proc = fakeProc(repo.dir, {
      argv: ['node', 'metadiff', sha],
    });
    const code = await run(proc);
    assert.equal(code, 1);
    assert.match(proc.stderrText(), /interactive terminal required/);
    assert.equal(proc.stdoutText().includes('nothing to review'), false);
  } finally {
    repo.cleanup();
  }
});
