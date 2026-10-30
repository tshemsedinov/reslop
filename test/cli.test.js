'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { run, parseArgv, resolveScope, loadSession } = require('../lib/cli.js');
const { createGitRepo } = require('../lib/git/git.js');
const helpers = require('./helpers.js');
const { makeRepo, sampleHunk, fakeProc, tempDir, removeTree } = helpers;

test('AC11 not a git directory exits 1', async () => {
  const dir = tempDir('reslop-nogit-');
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

test('an empty .git directory does not identify a repository', async () => {
  const dir = tempDir('reslop-nogit-');
  try {
    fs.mkdirSync(path.join(dir, '.git'));
    fs.mkdirSync(path.join(dir, 'nested'));
    const proc = fakeProc(path.join(dir, 'nested'));
    assert.equal(await run(proc), 1);
    assert.match(proc.stderrText(), /not a git repository/);
    assert.doesNotMatch(proc.stderrText(), /unknown option/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('parseArgv accepts -r and rejects removed switches', () => {
  assert.equal(parseArgv([]).readOnly, false);
  assert.equal(parseArgv(['-r']).readOnly, true);
  assert.deepEqual(parseArgv(['-r', 'lib']).paths, ['lib']);
  const unknown = ['-n', '-light', '--new', '--help', '-h', '--version', '-v'];
  for (const flag of unknown) {
    const message = `unknown option ${flag}`;
    assert.throws(() => parseArgv([flag]), new RegExp(message));
  }
});

test('unknown option exits 1', async () => {
  const proc = fakeProc(process.cwd(), {
    argv: ['node', 'reslop', '--nope'],
  });
  const code = await run(proc);
  assert.equal(code, 1);
  const err = proc.stderrText();
  assert.match(err, /unknown option/);
  const usage = new RegExp(
    [
      'Usage: reslop \\[-r\\]',
      '\\[path \\| commit \\| pr-url \\| mr-url \\| issue-url\\]',
    ].join(' '),
  );
  assert.match(err, usage);
  assert.doesNotMatch(err, /--help/);
});

test('AC22 resolveScope peels a commit from argv', async () => {
  const repo = makeRepo();
  try {
    repo.write('src/a.txt', 'ok\n');
    repo.git(['add', '.']);
    repo.git(['commit', '-m', 'init']);
    const sha = repo.git(['rev-parse', 'HEAD']).trim();
    const peeled = await resolveScope(
      repo.dir,
      [sha.slice(0, 7)],
      createGitRepo(),
    );
    assert.equal(peeled.rev, sha);
    assert.deepEqual(peeled.paths, []);
    await assert.rejects(
      () => resolveScope(repo.dir, [sha.slice(0, 7), 'lib'], createGitRepo()),
      /commit or a path/,
    );
    const pathWins = await resolveScope(repo.dir, ['src'], createGitRepo());
    assert.equal(pathWins.rev, null);
    assert.deepEqual(pathWins.paths, ['src']);
  } finally {
    repo.cleanup();
  }
});

test('AC22 unknown sha exits 1', async () => {
  const repo = makeRepo();
  try {
    repo.write('a.txt', 'ok\n');
    repo.git(['add', 'a.txt']);
    repo.git(['commit', '-m', 'init']);
    const fake = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const proc = fakeProc(repo.dir, {
      argv: ['node', 'reslop', fake],
    });
    const code = await run(proc);
    assert.equal(code, 1);
    assert.match(proc.stderrText(), /bad revision/);
  } finally {
    repo.cleanup();
  }
});

test('commit plus a path exits 1', async () => {
  const repo = makeRepo();
  try {
    repo.write('a.txt', 'ok\n');
    repo.git(['add', 'a.txt']);
    repo.git(['commit', '-m', 'init']);
    const sha = repo.git(['rev-parse', 'HEAD']).trim();
    const proc = fakeProc(repo.dir, {
      argv: ['node', 'reslop', sha, 'a.txt'],
    });
    const code = await run(proc);
    assert.equal(code, 1);
    assert.match(proc.stderrText(), /commit or a path/);
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
    const proc = fakeProc(repo.dir, { argv: ['node', 'reslop', sha] });
    const session = await loadSession(proc, {}, parseArgv([sha]));
    await session.loadReady();
    assert.equal(session.rev, sha);
    assert.equal(session.items.length, 1);
    const [item] = session.items;
    assert.equal(item.origin, 'commit');
    const texts = item.hunk.lines.map((line) => `${line.type}:${line.text}`);
    assert.deepEqual(texts, ['del:one', 'add:two']);
    assert.equal(await run(fakeProc(repo.dir, { argv: proc.argv })), 1);
  } finally {
    repo.cleanup();
  }
});

const prItem = () => ({
  origin: 'pr',
  file: {
    oldPath: 'lib/a.js',
    newPath: 'lib/a.js',
    isNew: false,
    isDeleted: false,
    isBinary: false,
    preamble: ['diff --git a/lib/a.js b/lib/a.js'],
    hunks: [],
  },
  hunk: sampleHunk([
    { type: 'del', text: 'a', noNl: false, blockId: 0 },
    { type: 'add', text: 'b', noNl: false, blockId: 0 },
  ]),
  blockId: 0,
  patchAdd: '',
  patchRevert: '',
});

const mockPrLoad =
  (dir, extra = {}) =>
  async () => ({
    top: dir,
    items: extra.items ?? [prItem()],
    sourceLabel: extra.sourceLabel ?? '#123',
    change: {
      source: 'pr',
      title: extra.title ?? 'Fix parser',
      author: extra.author ?? 'alice',
      repository: extra.repository ?? 'acme/app',
      number: extra.number ?? 123,
      base: extra.base ?? 'main',
      head: extra.head ?? 'fix-parser',
      url: extra.url ?? 'https://github.com/acme/app/pull/123',
      files: extra.files ?? ['lib/a.js'],
    },
  });

test('review is not a subcommand before a GitHub PR URL', async () => {
  const dir = tempDir('reslop-pr-');
  try {
    const url = 'https://github.com/acme/app/pull/123';
    const proc = fakeProc(dir, {
      argv: ['node', 'reslop', 'review', url],
    });
    let loaded = false;
    const code = await run(proc, {
      loadPullRequest: async () => {
        loaded = true;
        return mockPrLoad(dir)();
      },
    });
    assert.equal(loaded, false);
    assert.equal(code, 1);
    assert.match(proc.stderrText(), /not a git repository/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const mockMrLoad =
  (dir, extra = {}) =>
  async () => ({
    top: dir,
    items: extra.items ?? [prItem()],
    sourceLabel: extra.sourceLabel ?? '!123',
    change: {
      source: 'mr',
      title: extra.title ?? 'Fix parser',
      author: extra.author ?? 'alice',
      repository: extra.repository ?? 'acme/app',
      number: extra.number ?? 123,
      base: extra.base ?? 'main',
      head: extra.head ?? 'fix-parser',
      url: extra.url ?? 'https://gitlab.com/acme/app/-/merge_requests/123',
      files: extra.files ?? ['lib/a.js'],
    },
  });

const mockIssueLoad =
  (dir, extra = {}) =>
  async () => ({
    top: dir,
    items: [],
    sourceLabel: '#12',
    change: {
      source: 'issue',
      title: 'Add import',
      author: 'alice',
      repository: 'acme/app',
      number: 12,
      base: '',
      head: '',
      url: 'https://github.com/acme/app/issues/12',
    },
    imported: extra.imported ?? {
      blockTasks: [],
      tasks: [
        {
          file: 'issue',
          text: '@alice review at github: Add import',
          done: false,
        },
      ],
    },
  });

test('GitHub issue URL with notes opens the tasks screen', async () => {
  const dir = tempDir('reslop-issue-');
  try {
    const url = 'https://github.com/acme/app/issues/12';
    const proc = fakeProc(dir, { argv: ['node', 'reslop', url] });
    const session = await loadSession(
      proc,
      {
        loadGithubIssue: mockIssueLoad(dir),
      },
      parseArgv([url]),
    );
    await session.loadReady();
    assert.equal(session.pane, 'tasks');
    assert.equal(session.change.source, 'issue');
    assert.match(session.notes.tasks[0].text, /Add import/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const PR_URL = 'https://github.com/acme/app/pull/123';
const MR_URL = 'https://gitlab.com/acme/app/-/merge_requests/123';
const ISSUE_URL = 'https://github.com/acme/app/issues/12';

const failWith = (message) => async () => {
  throw new Error(message);
};

// Runs reslop on a URL in a directory that is not a repository
const runRemote = async (t, url, loaders) => {
  const dir = tempDir('reslop-remote-');
  t.after(() => removeTree(dir));
  const proc = fakeProc(dir, { argv: ['node', 'reslop', url] });
  const code = await run(proc, loaders(dir));
  return { code, proc };
};

const githubIssue = (dir) => ({ loadGithubIssue: mockIssueLoad(dir) });
const gitlabIssue = (dir) => ({ loadGitlabIssue: mockIssueLoad(dir) });

for (const [url, loaders] of [
  [PR_URL, (dir) => ({ loadPullRequest: mockPrLoad(dir) })],
  [MR_URL, (dir) => ({ loadMergeRequest: mockMrLoad(dir) })],
  [ISSUE_URL, githubIssue],
  ['https://github.com/tshemsedinov/reslop', githubIssue],
  ['https://github.com/tshemsedinov/reslop/issues', githubIssue],
  ['https://gitlab.com/acme/app', gitlabIssue],
  ['https://gitlab.com/acme/app/-/issues', gitlabIssue],
  ['https://gitlab.com/acme/app/-/issues/12', gitlabIssue],
]) {
  test(`${url} opens without a local git repository`, async (t) => {
    const { code, proc } = await runRemote(t, url, loaders);
    assert.equal(code, 1);
    assert.match(proc.stderrText(), /interactive terminal required/);
    assert.doesNotMatch(proc.stderrText(), /not a git repository/);
    assert.equal(proc.stdoutText().includes('nothing to review'), false);
  });
}

const NO_NOTES = { imported: { blockTasks: [], tasks: [] } };

for (const [url, loaders] of [
  [PR_URL, (dir) => ({ loadPullRequest: mockPrLoad(dir, { items: [] }) })],
  [MR_URL, (dir) => ({ loadMergeRequest: mockMrLoad(dir, { items: [] }) })],
  [ISSUE_URL, (dir) => ({ loadGithubIssue: mockIssueLoad(dir, NO_NOTES) })],
]) {
  test(`empty ${url} prints nothing to review`, async (t) => {
    const { code, proc } = await runRemote(t, url, loaders);
    assert.equal(code, 0);
    assert.equal(proc.stdoutText(), 'nothing to review\n');
  });
}

for (const [url, loaders, message] of [
  [
    PR_URL,
    () => ({ loadPullRequest: failWith('GitHub pull request not found') }),
    /GitHub pull request not found/,
  ],
  [
    MR_URL,
    () => ({ loadMergeRequest: failWith('GitLab merge request not found') }),
    /GitLab merge request not found/,
  ],
]) {
  test(`${url} load errors exit 1`, async (t) => {
    const { code, proc } = await runRemote(t, url, loaders);
    assert.equal(code, 1);
    assert.match(proc.stderrText(), message);
  });
}

test('a local session without paths opens on the dashboard', async () => {
  const repo = makeRepo();
  try {
    repo.write('a.js', 'one\n');
    repo.git(['add', '.']);
    repo.git(['commit', '-m', 'first']);
    const proc = fakeProc(repo.dir);
    const plain = await loadSession(proc, {}, parseArgv([]));
    assert.equal(plain.pane, 'dashboard');
    assert.equal(plain.dashboardHome, true);
    const scoped = await loadSession(proc, {}, parseArgv(['a.js']));
    assert.equal(scoped.pane, 'files');
    assert.equal(scoped.dashboardHome, false);
    const rev = await loadSession(proc, {}, parseArgv(['HEAD']));
    assert.equal(rev.pane, 'files');
  } finally {
    repo.cleanup();
  }
});
