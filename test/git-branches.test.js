'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const git = require('../lib/git/git.js');
const { load } = git;
const { hasStaged, createGitRepo } = git;
const { currentBranch, listBranches, checkoutBranch } = git;
const { createBranch, dropBranch, pullChanges } = git;
const { listCommits, dropCommit, applyFixup } = git;
const { pushChanges, editItem } = git;
const { runProc } = require('../lib/common/process.js');
const { Session } = require('../lib/session/session.js');
const helpers = require('./helpers.js');
const { makeRepo, sink, configureRepo, tempDir, sessionFor } = helpers;

const makeBare = () => {
  const dir = tempDir('reslop-bare-');
  const result = spawnSync('git', ['init', '--bare', '-b', 'main'], {
    cwd: dir,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status !== 0) {
    const msg = result.stderr || result.stdout || 'git init failed';
    throw new Error(msg.trim());
  }
  const cleanup = () => fs.rmSync(dir, { recursive: true, force: true });
  return { dir, cleanup };
};

test('listBranches createBranch and checkoutBranch', async () => {
  const repo = makeRepo();
  try {
    repo.write('f.txt', 'a\n');
    repo.git(['add', 'f.txt']);
    repo.git(['commit', '-m', 'init']);
    const before = await listBranches(repo.dir);
    assert.equal(before.length, 1);
    assert.equal(before[0].name, 'main');
    assert.equal(before[0].current, true);
    assert.equal(before[0].isDefault, true);
    assert.equal(before[0].subject, 'init');
    assert.equal(before[0].ahead, 0);
    assert.equal(before[0].behind, 0);
    assert.equal(before[0].gone, false);
    assert.match(before[0].sha, /^[0-9a-f]{7,}$/);
    assert.ok(before[0].date);
    await createBranch(repo.dir, 'feat');
    assert.equal(await currentBranch(repo.dir), 'feat');
    const onFeat = await listBranches(repo.dir);
    const featNow = onFeat.find((entry) => entry.name === 'feat');
    const mainNow = onFeat.find((entry) => entry.name === 'main');
    assert.equal(featNow.current, true);
    assert.equal(featNow.isDefault, false);
    assert.equal(mainNow.current, false);
    assert.equal(mainNow.isDefault, true);
    await checkoutBranch(repo.dir, 'main');
    assert.equal(await currentBranch(repo.dir), 'main');
    const after = await listBranches(repo.dir);
    const names = after.map((entry) => entry.name);
    assert.ok(names.includes('main'));
    assert.ok(names.includes('feat'));
    const feat = after.find((entry) => entry.name === 'feat');
    const main = after.find((entry) => entry.name === 'main');
    assert.equal(feat.current, false);
    assert.equal(feat.isDefault, false);
    assert.equal(main.isDefault, true);
    assert.equal(feat.subject, 'init');
    assert.match(feat.sha, /^[0-9a-f]{7,}$/);
  } finally {
    repo.cleanup();
  }
});

test('rebaseBranch replays onto the selected branch', async () => {
  const repo = makeRepo();
  try {
    repo.write('f.txt', 'base\n');
    repo.git(['add', 'f.txt']);
    repo.git(['commit', '-m', 'init']);
    await createBranch(repo.dir, 'feat');
    repo.write('f.txt', 'feat\n');
    repo.git(['add', 'f.txt']);
    repo.git(['commit', '-m', 'feat']);
    await checkoutBranch(repo.dir, 'main');
    repo.write('g.txt', 'main\n');
    repo.git(['add', 'g.txt']);
    repo.git(['commit', '-m', 'on-main']);
    await checkoutBranch(repo.dir, 'feat');
    await git.rebaseBranch(repo.dir, 'main');
    assert.equal(await currentBranch(repo.dir), 'feat');
    assert.equal(repo.read('g.txt'), 'main\n');
    assert.equal(repo.read('f.txt'), 'feat\n');
    const log = repo.git(['log', '--oneline']);
    assert.match(log, /on-main/);
    assert.match(log, /feat/);
  } finally {
    repo.cleanup();
  }
});

const conflictingRepo = async () => {
  const repo = makeRepo();
  repo.write('f.txt', 'base\n');
  repo.git(['add', 'f.txt']);
  repo.git(['commit', '-m', 'init']);
  await createBranch(repo.dir, 'feat');
  repo.write('f.txt', 'feat\n');
  repo.git(['add', 'f.txt']);
  repo.git(['commit', '-m', 'feat']);
  await checkoutBranch(repo.dir, 'main');
  repo.write('f.txt', 'main\n');
  repo.git(['add', 'f.txt']);
  repo.git(['commit', '-m', 'on-main']);
  await checkoutBranch(repo.dir, 'feat');
  return repo;
};

test('rebaseBranch merges a conflicting rebase', async () => {
  const repo = await conflictingRepo();
  try {
    await git.rebaseBranch(repo.dir, 'main');
    assert.equal(await currentBranch(repo.dir), 'feat');
    assert.equal(repo.read('f.txt'), 'main\nfeat\n');
  } finally {
    repo.cleanup();
  }
});

test('rebaseBranch aborts when a conflict has no merge markers', async () => {
  const repo = makeRepo();
  try {
    repo.write('f.txt', 'base\n');
    repo.git(['add', 'f.txt']);
    repo.git(['commit', '-m', 'init']);
    await createBranch(repo.dir, 'feat');
    repo.write('f.txt', 'feat\n');
    repo.git(['add', 'f.txt']);
    repo.git(['commit', '-m', 'feat']);
    await checkoutBranch(repo.dir, 'main');
    repo.git(['rm', 'f.txt']);
    repo.git(['commit', '-m', 'remove']);
    await checkoutBranch(repo.dir, 'feat');
    await assert.rejects(async () => git.rebaseBranch(repo.dir, 'main'));
    assert.equal(await currentBranch(repo.dir), 'feat');
    assert.equal(repo.read('f.txt'), 'feat\n');
  } finally {
    repo.cleanup();
  }
});

test('rebaseBranch rolls back when writing a resolution fails', async (t) => {
  const repo = await conflictingRepo();
  try {
    const head = repo.git(['rev-parse', 'HEAD']);
    const write = fs.promises.writeFile;
    t.mock.method(fs.promises, 'writeFile', (file, ...args) => {
      if (file === path.join(repo.dir, 'f.txt')) {
        return Promise.reject(new Error('resolution write failed'));
      }
      return write(file, ...args);
    });
    await assert.rejects(git.rebaseBranch(repo.dir, 'main'), /write failed/);
    assert.equal(repo.git(['rev-parse', 'HEAD']), head);
    assert.equal(await currentBranch(repo.dir), 'feat');
    assert.equal(repo.read('f.txt'), 'feat\n');
    assert.equal(repo.git(['status', '--porcelain']), '');
    assert.equal(repo.exists('.git/rebase-merge'), false);
  } finally {
    repo.cleanup();
  }
});

test('rebaseBranch preserves an existing rebase and resolution', async () => {
  const repo = await conflictingRepo();
  try {
    assert.throws(() => repo.git(['rebase', 'main']));
    const head = repo.git(['rev-parse', 'HEAD']);
    repo.write('f.txt', 'manual resolution\n');
    repo.git(['add', 'f.txt']);
    await assert.rejects(
      git.rebaseBranch(repo.dir, 'main'),
      /already in progress/,
    );
    assert.equal(repo.git(['rev-parse', 'HEAD']), head);
    assert.equal(repo.read('f.txt'), 'manual resolution\n');
    assert.equal(repo.exists('.git/rebase-merge'), true);
    assert.match(repo.git(['diff', '--cached']), /manual resolution/);
  } finally {
    repo.cleanup();
  }
});

test('rebaseBranch rolls back if a later conflict cannot merge', async () => {
  const repo = await conflictingRepo();
  try {
    repo.write('f.txt', 'feat\0binary\n');
    repo.git(['add', 'f.txt']);
    repo.git(['commit', '-m', 'binary change']);
    const head = repo.git(['rev-parse', 'HEAD']);
    await assert.rejects(git.rebaseBranch(repo.dir, 'main'));
    assert.equal(repo.git(['rev-parse', 'HEAD']), head);
    assert.equal(repo.read('f.txt'), 'feat\0binary\n');
    assert.equal(await currentBranch(repo.dir), 'feat');
    assert.equal(repo.git(['status', '--porcelain']), '');
    assert.equal(repo.exists('.git/rebase-merge'), false);
  } finally {
    repo.cleanup();
  }
});

test('rebaseBranch rejects conflict markers inside binary files', async () => {
  const repo = await conflictingRepo();
  try {
    repo.write('f.txt', '\0\nfeature data\n');
    repo.git(['add', 'f.txt']);
    repo.git(['commit', '-m', 'binary feature']);
    const head = repo.git(['rev-parse', 'HEAD']);
    await checkoutBranch(repo.dir, 'main');
    const markers = '\0\n<<<<<<< HEAD\nleft\n=======\nright\n>>>>>>> end\n';
    repo.write('f.txt', markers);
    repo.git(['add', 'f.txt']);
    repo.git(['commit', '-m', 'binary main']);
    await checkoutBranch(repo.dir, 'feat');
    await assert.rejects(git.rebaseBranch(repo.dir, 'main'));
    assert.equal(repo.git(['rev-parse', 'HEAD']), head);
    assert.equal(repo.read('f.txt'), '\0\nfeature data\n');
    assert.equal(repo.git(['status', '--porcelain']), '');
    assert.equal(repo.exists('.git/rebase-merge'), false);
  } finally {
    repo.cleanup();
  }
});

test('listCommits is newest first with author date and hash', async () => {
  const repo = makeRepo();
  try {
    repo.write('f.txt', 'a\n');
    repo.git(['add', 'f.txt']);
    repo.git(['commit', '-m', 'init']);
    repo.write('f.txt', 'b\n');
    repo.git(['add', 'f.txt']);
    repo.git(['commit', '-m', 'next']);
    const listed = await listCommits(repo.dir);
    assert.equal(listed.length, 2);
    assert.equal(listed[0].subject, 'next');
    assert.equal(listed[0].head, true);
    assert.equal(listed[1].subject, 'init');
    assert.equal(listed[1].head, false);
    assert.equal(listed[0].author, 'Test');
    assert.equal(listed[0].email, 'test@example.com');
    assert.ok(listed[0].date);
    assert.match(listed[0].sha, /^[0-9a-f]{40}$/);
    assert.match(listed[0].shortSha, /^[0-9a-f]{7,}$/);
    assert.match(listed[0].when, /^\d{4}-\d{2}-\d{2}/);
    assert.match(listed[0].refs, /HEAD -> main/);
    assert.equal(listed[0].added, 1);
    assert.equal(listed[0].removed, 1);
    assert.equal(listed[1].added, 1);
    assert.equal(listed[1].removed, 0);
  } finally {
    repo.cleanup();
  }
});

test('listCommits shows branch tips and the full message', async () => {
  const repo = makeRepo();
  try {
    repo.write('f.txt', 'a\n');
    repo.git(['add', 'f.txt']);
    repo.git(['commit', '-m', 'init']);
    repo.write('f.txt', 'b\n');
    repo.git(['add', 'f.txt']);
    repo.git(['commit', '-m', 'next', '-m', 'body line']);
    repo.git(['branch', 'feature']);
    repo.git(['tag', 'v1']);
    repo.git(['branch', 'old', 'HEAD~1']);
    repo.git(['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    repo.git([
      'symbolic-ref',
      'refs/remotes/origin/HEAD',
      'refs/remotes/origin/main',
    ]);
    repo.write('f.txt', 'c\n');
    repo.git(['add', 'f.txt']);
    repo.git(['commit', '-m', 'third']);
    const listed = await listCommits(repo.dir);
    assert.equal(listed[0].subject, 'third');
    assert.equal(listed[0].refs, 'HEAD -> main');
    assert.equal(listed[1].subject, 'next');
    assert.match(listed[1].refs, /feature/);
    assert.match(listed[1].refs, /origin\/main/);
    assert.equal(listed[1].refs.includes('HEAD ->'), false);
    assert.equal(listed[1].refs.includes('tag:'), false);
    assert.equal(listed[1].refs.includes('origin/HEAD'), false);
    assert.equal(listed[1].refs.includes('old'), false);
    assert.match(listed[1].body, /^next\n\nbody line/);
    assert.equal(listed[2].refs, 'old');
  } finally {
    repo.cleanup();
  }
});

test('dropCommit soft-resets HEAD', async () => {
  const repo = makeRepo();
  try {
    repo.write('f.txt', 'a\n');
    repo.git(['add', 'f.txt']);
    repo.git(['commit', '-m', 'one']);
    repo.write('f.txt', 'b\n');
    repo.git(['add', 'f.txt']);
    repo.git(['commit', '-m', 'two']);
    const listed = await listCommits(repo.dir);
    await git.dropCommit(repo.dir, listed[0].sha);
    const subjects = (await listCommits(repo.dir)).map(
      (entry) => entry.subject,
    );
    assert.deepEqual(subjects, ['one']);
    assert.equal(repo.read('f.txt'), 'b\n');
  } finally {
    repo.cleanup();
  }
});

test('dropCommit rebases out an older commit', async () => {
  const repo = makeRepo();
  try {
    repo.write('a.txt', 'a\n');
    repo.git(['add', 'a.txt']);
    repo.git(['commit', '-m', 'one']);
    repo.write('b.txt', 'b\n');
    repo.git(['add', 'b.txt']);
    repo.git(['commit', '-m', 'two']);
    repo.write('c.txt', 'c\n');
    repo.git(['add', 'c.txt']);
    repo.git(['commit', '-m', 'three']);
    const older = (await listCommits(repo.dir))[1].sha;
    await git.dropCommit(repo.dir, older);
    const subjects = (await listCommits(repo.dir)).map(
      (entry) => entry.subject,
    );
    assert.deepEqual(subjects, ['three', 'one']);
    assert.equal(repo.read('a.txt'), 'a\n');
    assert.equal(repo.read('c.txt'), 'c\n');
    assert.equal(repo.exists('b.txt'), false);
  } finally {
    repo.cleanup();
  }
});

test('dropCommit refuses the root commit', async () => {
  const repo = makeRepo();
  try {
    repo.write('f.txt', 'a\n');
    repo.git(['add', 'f.txt']);
    repo.git(['commit', '-m', 'init']);
    const root = (await listCommits(repo.dir))[0].sha;
    await assert.rejects(() => dropCommit(repo.dir, root));
    assert.equal((await listCommits(repo.dir))[0].subject, 'init');
  } finally {
    repo.cleanup();
  }
});

test('applyFixup squashes a fixup into its target', async () => {
  const repo = makeRepo();
  try {
    repo.write('a.txt', 'one\n');
    repo.git(['add', 'a.txt']);
    repo.git(['commit', '-m', 'one']);
    repo.write('b.txt', 'two\n');
    repo.git(['add', 'b.txt']);
    repo.git(['commit', '-m', 'two']);
    repo.write('b.txt', 'two-fix\n');
    repo.git(['add', 'b.txt']);
    repo.git(['commit', '-m', 'fixup! two']);
    const listed = await listCommits(repo.dir);
    assert.deepEqual(
      listed.map((entry) => entry.subject),
      ['fixup! two', 'two', 'one'],
    );
    await git.applyFixup(repo.dir, listed[0].sha);
    const after = (await listCommits(repo.dir)).map((entry) => entry.subject);
    assert.deepEqual(after, ['two', 'one']);
    assert.equal(repo.read('b.txt'), 'two-fix\n');
  } finally {
    repo.cleanup();
  }
});

test('applyFixup folds only the selected fixup into its target', async () => {
  const repo = makeRepo();
  try {
    repo.write('a.txt', 'one\n');
    repo.git(['add', 'a.txt']);
    repo.git(['commit', '-m', 'one']);
    repo.write('b.txt', 'two\n');
    repo.git(['add', 'b.txt']);
    repo.git(['commit', '-m', 'two']);
    repo.write('b.txt', 'two-fix\n');
    repo.git(['add', 'b.txt']);
    repo.git(['commit', '-m', 'fixup! two']);
    repo.write('a.txt', 'one-fix\n');
    repo.git(['add', 'a.txt']);
    repo.git(['commit', '-m', 'fixup! one']);
    const listed = await listCommits(repo.dir);
    await git.applyFixup(repo.dir, listed[1].sha);
    const after = await listCommits(repo.dir);
    assert.deepEqual(
      after.map((entry) => entry.subject),
      ['fixup! one', 'two', 'one'],
    );
    assert.equal(repo.read('a.txt'), 'one-fix\n');
    assert.equal(repo.read('b.txt'), 'two-fix\n');
    assert.equal(repo.git(['status', '--porcelain']), '');
  } finally {
    repo.cleanup();
  }
});

test('applyFixup refuses a non-fixup commit', async () => {
  const repo = makeRepo();
  try {
    repo.write('f.txt', 'a\n');
    repo.git(['add', 'f.txt']);
    repo.git(['commit', '-m', 'init']);
    const sha = (await listCommits(repo.dir))[0].sha;
    await assert.rejects(() => applyFixup(repo.dir, sha), /not a fixup commit/);
  } finally {
    repo.cleanup();
  }
});

test('rewordCommit changes HEAD message and preserves the index', async () => {
  const repo = makeRepo();
  try {
    repo.write('a.txt', 'a\n');
    repo.git(['add', 'a.txt']);
    repo.git(['commit', '-m', 'one']);
    repo.write('b.txt', 'b\n');
    repo.git(['add', 'b.txt']);
    repo.git(['commit', '-m', 'two']);
    repo.write('s.txt', 'staged\n');
    repo.git(['add', 's.txt']);
    const head = (await listCommits(repo.dir))[0].sha;
    await git.rewordCommit(repo.dir, head, 'TWO');
    const listed = (await listCommits(repo.dir)).map((entry) => entry.subject);
    assert.deepEqual(listed, ['TWO', 'one']);
    assert.equal(await hasStaged(repo.dir), true);
    assert.equal(repo.exists('s.txt'), true);
    const cached = repo.git(['diff', '--cached', '--', 's.txt']);
    assert.match(cached, /staged/);
  } finally {
    repo.cleanup();
  }
});

test('rewordCommit rewrites an older message', async () => {
  const repo = makeRepo();
  try {
    repo.write('a.txt', 'a\n');
    repo.git(['add', 'a.txt']);
    repo.git(['commit', '-m', 'one']);
    repo.write('b.txt', 'b\n');
    repo.git(['add', 'b.txt']);
    repo.git(['commit', '-m', 'two']);
    repo.write('c.txt', 'c\n');
    repo.git(['add', 'c.txt']);
    repo.git(['commit', '-m', 'three']);
    const older = (await listCommits(repo.dir))[1].sha;
    await git.rewordCommit(repo.dir, older, 'TWO');
    const listed = (await listCommits(repo.dir)).map((entry) => entry.subject);
    assert.deepEqual(listed, ['three', 'TWO', 'one']);
    assert.equal(repo.read('a.txt'), 'a\n');
    assert.equal(repo.read('b.txt'), 'b\n');
    assert.equal(repo.read('c.txt'), 'c\n');
  } finally {
    repo.cleanup();
  }
});

const OLD_DATE = '2001-01-01T00:00:00Z';

const authorYear = (repo, rev) =>
  repo.git(['log', '-1', '--format=%ad', '--date=format:%Y', rev]).trim();

test('rewordCommit with now resets the author date of HEAD', async () => {
  const repo = makeRepo();
  try {
    repo.write('a.txt', 'a\n');
    repo.git(['add', 'a.txt']);
    repo.git(['commit', '--date', OLD_DATE, '-m', 'one']);
    const head = (await listCommits(repo.dir))[0].sha;
    await git.rewordCommit(repo.dir, head, 'kept', { now: true });
    assert.notEqual(authorYear(repo, 'HEAD'), '2001');
    await git.rewordCommit(repo.dir, head, 'old');
    assert.equal(repo.git(['log', '-1', '--format=%s']).trim(), 'old');
  } finally {
    repo.cleanup();
  }
});

test('rewordCommit with now resets an older author date only', async () => {
  const repo = makeRepo();
  try {
    for (const name of ['one', 'two', 'three']) {
      repo.write(`${name}.txt`, `${name}\n`);
      repo.git(['add', `${name}.txt`]);
      repo.git(['commit', '--date', OLD_DATE, '-m', name]);
    }
    const older = (await listCommits(repo.dir))[1].sha;
    await git.rewordCommit(repo.dir, older, 'TWO', { now: true });
    const listed = (await listCommits(repo.dir)).map((entry) => entry.subject);
    assert.deepEqual(listed, ['three', 'TWO', 'one']);
    assert.equal(authorYear(repo, 'HEAD'), '2001');
    assert.notEqual(authorYear(repo, 'HEAD~1'), '2001');
    assert.equal(authorYear(repo, 'HEAD~2'), '2001');
  } finally {
    repo.cleanup();
  }
});

test('dropCommits removes a range including HEAD', async () => {
  const repo = makeRepo();
  try {
    for (const name of ['root', 'one', 'two', 'three']) {
      repo.write(`${name}.txt`, `${name}\n`);
      repo.git(['add', `${name}.txt`]);
      repo.git(['commit', '-m', name]);
    }
    const commits = await listCommits(repo.dir);
    await git.dropCommits(
      repo.dir,
      commits.slice(0, 2).map((entry) => entry.sha),
    );
    assert.deepEqual(
      (await listCommits(repo.dir)).map((entry) => entry.subject),
      ['one', 'root'],
    );
    assert.equal(fs.existsSync(path.join(repo.dir, 'two.txt')), false);
    assert.equal(fs.existsSync(path.join(repo.dir, 'three.txt')), false);
    assert.equal(repo.git(['status', '--porcelain']), '');
  } finally {
    repo.cleanup();
  }
});

test('dropCommits retains unselected entries and refuses root', async () => {
  const repo = makeRepo();
  try {
    for (const name of ['root', 'one', 'two', 'three', 'four']) {
      repo.write(`${name}.txt`, `${name}\n`);
      repo.git(['add', `${name}.txt`]);
      repo.git(['commit', '-m', name]);
    }
    const commits = await listCommits(repo.dir);
    await assert.rejects(
      git.dropCommits(repo.dir, [commits[0].sha, commits[4].sha]),
      /root/,
    );
    assert.equal(repo.git(['rev-parse', 'HEAD']).trim(), commits[0].sha);
    await git.dropCommits(repo.dir, [commits[1].sha, commits[3].sha]);
    assert.deepEqual(
      (await listCommits(repo.dir)).map((entry) => entry.subject),
      ['four', 'two', 'root'],
    );
    assert.equal(repo.git(['status', '--porcelain']), '');
  } finally {
    repo.cleanup();
  }
});

test('updateCommitTimes preserves messages and trees', async () => {
  const repo = makeRepo();
  try {
    for (const name of ['root', 'one', 'two', 'three']) {
      repo.write(`${name}.txt`, `${name}\n`);
      repo.git(['add', `${name}.txt`]);
      repo.git([
        'commit',
        '--date',
        OLD_DATE,
        '-m',
        `${name}\n\nbody for ${name}`,
      ]);
    }
    const tree = repo.git(['rev-parse', 'HEAD^{tree}']);
    const before = await listCommits(repo.dir);
    await git.updateCommitTimes(repo.dir, [before[0].sha, before[2].sha]);
    const after = await listCommits(repo.dir);
    assert.deepEqual(
      after.map((entry) => entry.body),
      before.map((entry) => entry.body),
    );
    for (const rev of ['HEAD', 'HEAD~2']) {
      assert.notEqual(authorYear(repo, rev), '2001');
    }
    for (const rev of ['HEAD~1', 'HEAD~3']) {
      assert.equal(authorYear(repo, rev), '2001');
    }
    assert.equal(repo.git(['rev-parse', 'HEAD^{tree}']), tree);
    assert.equal(repo.git(['status', '--porcelain']), '');
  } finally {
    repo.cleanup();
  }
});

test('updateCommitTimes supports root and a staged index', async () => {
  const repo = makeRepo();
  try {
    repo.write('one.txt', 'one\n');
    repo.git(['add', 'one.txt']);
    repo.git(['commit', '--date', OLD_DATE, '-m', 'root']);
    repo.write('two.txt', 'two\n');
    repo.git(['add', 'two.txt']);
    repo.git(['commit', '--date', OLD_DATE, '-m', 'second']);
    const before = await listCommits(repo.dir);
    await git.updateCommitTimes(repo.dir, [before[1].sha]);
    assert.notEqual(authorYear(repo, 'HEAD~1'), '2001');
    assert.equal(authorYear(repo, 'HEAD'), '2001');
    repo.write('one.txt', 'staged\n');
    repo.git(['add', 'one.txt']);
    const staged = repo.git(['diff', '--cached']);
    const head = (await listCommits(repo.dir))[0].sha;
    await git.updateCommitTimes(repo.dir, [head]);
    assert.notEqual(authorYear(repo, 'HEAD'), '2001');
    assert.equal(repo.git(['diff', '--cached']), staged);
    assert.equal(repo.git(['log', '-1', '--format=%s']).trim(), 'second');
  } finally {
    repo.cleanup();
  }
});

test('updateCommitTimes preserves merge topology', async () => {
  const repo = makeRepo();
  try {
    repo.write('root.txt', 'root\n');
    repo.git(['add', 'root.txt']);
    repo.git(['commit', '--date', OLD_DATE, '-m', 'root']);
    const main = await currentBranch(repo.dir);
    repo.git(['checkout', '-b', 'side']);
    repo.write('side.txt', 'side\n');
    repo.git(['add', 'side.txt']);
    repo.git(['commit', '--date', OLD_DATE, '-m', 'side']);
    repo.git(['checkout', main]);
    repo.write('main.txt', 'main\n');
    repo.git(['add', 'main.txt']);
    repo.git(['commit', '--date', OLD_DATE, '-m', 'main']);
    repo.git(['merge', '--no-ff', '-m', 'merge', 'side']);
    repo.git(['commit', '--amend', '--no-edit', '--date', OLD_DATE]);
    const before = await listCommits(repo.dir);
    const tree = repo.git(['rev-parse', 'HEAD^{tree}']);
    const root = before.find((entry) => entry.subject === 'root');
    await git.updateCommitTimes(repo.dir, [before[0].sha, root.sha]);
    const parents = repo
      .git(['rev-list', '--parents', '-1', 'HEAD'])
      .trim()
      .split(' ');
    assert.equal(parents.length, 3);
    assert.equal(repo.git(['rev-parse', 'HEAD^{tree}']), tree);
    assert.notEqual(authorYear(repo, 'HEAD'), '2001');
    assert.notEqual(authorYear(repo, 'HEAD~2'), '2001');
    assert.equal(authorYear(repo, 'HEAD~1'), '2001');
    assert.equal(authorYear(repo, 'HEAD^2'), '2001');
  } finally {
    repo.cleanup();
  }
});

test('commit selection writes leave an existing rebase alone', async () => {
  const repo = makeRepo();
  try {
    repo.write('one.txt', 'one\n');
    repo.git(['add', 'one.txt']);
    repo.git(['commit', '-m', 'one']);
    const head = repo.git(['rev-parse', 'HEAD']).trim();
    const rebaseDir = path.join(repo.dir, '.git', 'rebase-merge');
    fs.mkdirSync(rebaseDir);
    const writes = [
      (dir, shas) => git.updateCommitTimes(dir, shas),
      (dir, shas) => git.dropCommits(dir, shas),
      (dir, shas) => git.squashCommits(dir, shas, 'joined'),
      (dir, shas) => git.applyFixup(dir, shas[0]),
    ];
    for (const write of writes) {
      await assert.rejects(
        write(repo.dir, [head]),
        /rebase already in progress/,
      );
      assert.ok(fs.existsSync(rebaseDir));
      assert.equal(repo.git(['rev-parse', 'HEAD']).trim(), head);
    }
  } finally {
    repo.cleanup();
  }
});

const commitNamed = (repo, name) => {
  repo.write(`${name}.txt`, `${name}\n`);
  repo.git(['add', `${name}.txt`]);
  repo.git(['commit', '-m', `${name}\n\nbody ${name}`]);
};

const namesAt = (repo, rev) =>
  repo.git(['ls-tree', '--name-only', rev]).trim().split('\n').sort();

test('squashCommits folds a range into one message', async () => {
  const repo = makeRepo();
  try {
    for (const name of ['root', 'one', 'two', 'three']) commitNamed(repo, name);
    const before = await listCommits(repo.dir);
    const picked = [before[2].sha, before[1].sha];
    await git.squashCommits(repo.dir, picked, 'joined\n\nkept');
    const after = await listCommits(repo.dir);
    assert.deepEqual(
      after.map((entry) => entry.subject),
      ['three', 'joined', 'root'],
    );
    assert.equal(after[1].body, 'joined\n\nkept');
    assert.deepEqual(namesAt(repo, 'HEAD~1'), [
      'one.txt',
      'root.txt',
      'two.txt',
    ]);
    assert.equal(repo.git(['status', '--porcelain']), '');
    assert.equal(repo.read('two.txt'), 'two\n');
  } finally {
    repo.cleanup();
  }
});

test('squashCommits keeps commits that were not selected', async () => {
  const repo = makeRepo();
  try {
    for (const name of ['root', 'one', 'two', 'three']) commitNamed(repo, name);
    const before = await listCommits(repo.dir);
    const picked = [before[0].sha, before[2].sha];
    await git.squashCommits(repo.dir, picked, 'ends');
    const after = await listCommits(repo.dir);
    assert.deepEqual(
      after.map((entry) => entry.subject),
      ['two', 'ends', 'root'],
    );
    assert.equal(after[1].body, 'ends');
    assert.equal(after[0].body, 'two\n\nbody two');
    assert.deepEqual(namesAt(repo, 'HEAD~1'), [
      'one.txt',
      'root.txt',
      'three.txt',
    ]);
    assert.equal(repo.read('two.txt'), 'two\n');
    assert.equal(repo.git(['status', '--porcelain']), '');
  } finally {
    repo.cleanup();
  }
});

test('dropBranch deletes a branch that is not current', async () => {
  const repo = makeRepo();
  try {
    repo.write('f.txt', 'a\n');
    repo.git(['add', 'f.txt']);
    repo.git(['commit', '-m', 'init']);
    await createBranch(repo.dir, 'feat');
    await checkoutBranch(repo.dir, 'main');
    await dropBranch(repo.dir, 'feat');
    const names = (await listBranches(repo.dir)).map((entry) => entry.name);
    assert.equal(names.includes('feat'), false);
    assert.equal(await currentBranch(repo.dir), 'main');
  } finally {
    repo.cleanup();
  }
});

test('listBranches reports ahead and behind vs upstream', async () => {
  const repo = makeRepo();
  const bare = makeBare();
  try {
    repo.write('f.txt', 'a\n');
    repo.git(['add', 'f.txt']);
    repo.git(['commit', '-m', 'init']);
    repo.git(['remote', 'add', 'origin', bare.dir]);
    repo.git(['push', '-u', 'origin', 'HEAD']);
    const synced = (await listBranches(repo.dir)).find(
      (entry) => entry.current,
    );
    assert.equal(synced.ahead, 0);
    assert.equal(synced.behind, 0);
    assert.equal(synced.gone, false);
    repo.write('f.txt', 'b\n');
    repo.git(['add', 'f.txt']);
    repo.git(['commit', '-m', 'next']);
    const ahead = (await listBranches(repo.dir)).find((entry) => entry.current);
    assert.equal(ahead.ahead, 1);
    assert.equal(ahead.behind, 0);
    assert.equal(ahead.subject, 'next');
  } finally {
    repo.cleanup();
    bare.cleanup();
  }
});

test('listBranches prefers origin HEAD then master', async () => {
  const repo = makeRepo();
  const bare = makeBare();
  try {
    repo.write('f.txt', 'a\n');
    repo.git(['add', 'f.txt']);
    repo.git(['commit', '-m', 'init']);
    repo.git(['branch', '-m', 'master']);
    const renamed = await listBranches(repo.dir);
    assert.equal(renamed[0].name, 'master');
    assert.equal(renamed[0].isDefault, true);
    repo.git(['branch', 'main']);
    repo.git(['remote', 'add', 'origin', bare.dir]);
    repo.git(['push', 'origin', 'main', 'master']);
    repo.git(['remote', 'set-head', 'origin', 'master']);
    const listed = await listBranches(repo.dir);
    const main = listed.find((entry) => entry.name === 'main');
    const master = listed.find((entry) => entry.name === 'master');
    assert.equal(master.isDefault, true);
    assert.equal(main.isDefault, false);
  } finally {
    repo.cleanup();
    bare.cleanup();
  }
});

test('createBranch rejects an empty name', async () => {
  const repo = makeRepo();
  try {
    repo.write('f.txt', 'a\n');
    repo.git(['add', 'f.txt']);
    repo.git(['commit', '-m', 'init']);
    await assert.rejects(
      () => createBranch(repo.dir, '  '),
      /empty branch name/,
    );
  } finally {
    repo.cleanup();
  }
});

test('pushChanges sets origin upstream for the current branch', async () => {
  const repo = makeRepo();
  const bare = makeBare();
  try {
    repo.write('f.txt', 'a\n');
    repo.git(['add', 'f.txt']);
    repo.git(['commit', '-m', 'init']);
    repo.git(['checkout', '-b', 'autoreload']);
    repo.git(['remote', 'add', 'origin', bare.dir]);
    await pushChanges(repo.dir);
    const tracking = repo.git([
      'rev-parse',
      '--abbrev-ref',
      '--symbolic-full-name',
      '@{upstream}',
    ]);
    assert.equal(tracking.trim(), 'origin/autoreload');
    const remoteLog = spawnSync(
      'git',
      ['log', 'autoreload', '-1', '--format=%s'],
      { cwd: bare.dir, encoding: 'utf8', windowsHide: true },
    );
    assert.equal(remoteLog.stdout.trim(), 'init');
  } finally {
    repo.cleanup();
    bare.cleanup();
  }
});

test('pushChanges sets upstream then push and pull update', async () => {
  const repo = makeRepo();
  const bare = makeBare();
  let cloneDir = '';
  try {
    repo.write('f.txt', 'a\n');
    repo.git(['add', 'f.txt']);
    repo.git(['commit', '-m', 'init']);
    repo.git(['remote', 'add', 'origin', bare.dir]);
    await pushChanges(repo.dir);
    const remoteLog = spawnSync('git', ['log', '-1', '--format=%s'], {
      cwd: bare.dir,
      encoding: 'utf8',
      windowsHide: true,
    });
    assert.equal(remoteLog.stdout.trim(), 'init');
    cloneDir = tempDir('reslop-cl-');
    const cloned = spawnSync('git', ['clone', bare.dir, cloneDir], {
      encoding: 'utf8',
      windowsHide: true,
    });
    assert.equal(cloned.status, 0, cloned.stderr);
    const cloneGit = (args) => {
      const result = spawnSync('git', args, {
        cwd: cloneDir,
        encoding: 'utf8',
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 'Test',
          GIT_AUTHOR_EMAIL: 'test@example.com',
          GIT_COMMITTER_NAME: 'Test',
          GIT_COMMITTER_EMAIL: 'test@example.com',
        },
        windowsHide: true,
      });
      if (result.status !== 0) {
        const msg = result.stderr || result.stdout || 'git failed';
        throw new Error(msg.trim());
      }
      return result.stdout;
    };
    configureRepo(cloneDir);
    fs.writeFileSync(path.join(cloneDir, 'f.txt'), 'b\n');
    cloneGit(['add', 'f.txt']);
    cloneGit(['commit', '-m', 'from clone']);
    cloneGit(['push']);
    await pullChanges(repo.dir);
    assert.equal(repo.read('f.txt'), 'b\n');
  } finally {
    repo.cleanup();
    bare.cleanup();
    if (cloneDir) fs.rmSync(cloneDir, { recursive: true, force: true });
  }
});

test('pushChanges force-with-lease after a rewritten commit', async () => {
  const repo = makeRepo();
  const bare = makeBare();
  try {
    repo.write('f.txt', 'a\n');
    repo.git(['add', 'f.txt']);
    repo.git(['commit', '-m', 'init']);
    repo.git(['remote', 'add', 'origin', bare.dir]);
    await pushChanges(repo.dir);
    repo.write('f.txt', 'b\n');
    repo.git(['add', 'f.txt']);
    repo.git(['commit', '--amend', '-m', 'amended']);
    await assert.rejects(
      () => pushChanges(repo.dir),
      (error) => {
        assert.equal(error.rejected, true);
        assert.match(error.message, /push rejected/);
        return true;
      },
    );
    await pushChanges(repo.dir, true);
    const remoteLog = spawnSync('git', ['log', '-1', '--format=%s'], {
      cwd: bare.dir,
      encoding: 'utf8',
      windowsHide: true,
    });
    assert.equal(remoteLog.stdout.trim(), 'amended');
  } finally {
    repo.cleanup();
    bare.cleanup();
  }
});

const mockSignal = () => {
  const listeners = new Set();
  return {
    aborted: false,
    listeners,
    addEventListener(type, fn) {
      if (type === 'abort') listeners.add(fn);
    },
    removeEventListener(type, fn) {
      listeners.delete(fn);
    },
    abort() {
      this.aborted = true;
      for (const fn of [...listeners]) fn();
    },
  };
};

test('runProc finish removes abort listener on success', async () => {
  const signal = mockSignal();
  const result = await runProc(process.execPath, ['-e', 'process.exit(0)'], {
    signal,
  });
  assert.equal(result.status, 0);
  assert.equal(signal.listeners.size, 0);
});

test('runProc finish removes abort listener on abort', async () => {
  const signal = mockSignal();
  const pending = runProc(
    process.execPath,
    ['-e', 'setInterval(() => {}, 1000)'],
    { signal, timeout: 30000 },
  );
  signal.abort();
  const result = await pending;
  assert.equal(result.error.code, 'ABORT');
  assert.equal(signal.listeners.size, 0);
});

test('runProc finish removes abort listener on timeout', async () => {
  const signal = mockSignal();
  const result = await runProc(
    process.execPath,
    ['-e', 'setInterval(() => {}, 1000)'],
    { signal, timeout: 30 },
  );
  assert.equal(result.error.code, 'ETIMEDOUT');
  assert.equal(signal.listeners.size, 0);
});

test('editItem writes added lines into the reviewed file', async () => {
  const repo = makeRepo();
  try {
    repo.write('f.txt', 'alpha\nbeta\ngamma\n');
    repo.git(['add', 'f.txt']);
    repo.git(['commit', '-m', 'init']);
    repo.write('f.txt', 'alpha\nBETA\ngamma\n');
    const loaded = await load(repo.dir, [], { deferExtras: false });
    assert.equal(loaded.items.length, 1);
    await editItem(loaded.top, loaded.items[0], 'BETA-edited');
    assert.equal(repo.read('f.txt'), 'alpha\nBETA-edited\ngamma\n');
    const again = await load(repo.dir, [], { deferExtras: false });
    const lines = again.items[0].hunk.lines;
    const adds = lines.filter((line) => line.type === 'add');
    assert.equal(adds.length, 1);
    assert.equal(adds[0].text, 'BETA-edited');
  } finally {
    repo.cleanup();
  }
});

test('e saves added lines to the reviewed file and reloads', async () => {
  const repo = makeRepo();
  try {
    repo.write('f.txt', 'alpha\nbeta\ngamma\n');
    repo.git(['add', 'f.txt']);
    repo.git(['commit', '-m', 'init']);
    repo.write('f.txt', 'alpha\nBETA\ngamma\n');
    const session = await sessionFor(repo.dir);
    session.dispatch('code');
    await session.ops.idle();
    assert.equal(session.composeKind, 'code');
    session.editor.replace('BETA-edited');
    session.handleEvent({ type: 'key', key: 'escape' });
    await session.ops.idle();
    assert.equal(session.mode, 'review');
    assert.equal(repo.read('f.txt'), 'alpha\nBETA-edited\ngamma\n');
    assert.equal(session.notes.code.size, 0);
    const cached = repo.git(['diff', '--cached', '--', 'f.txt']);
    const work = repo.git(['diff', '--', 'f.txt']);
    assert.match(cached, /\+BETA-edited/);
    assert.equal(work, '');
    assert.equal(session.current().origin, 'staged');
    assert.equal(session.status, 'staged');
    const adds = session
      .current()
      .hunk.lines.filter((line) => line.type === 'add');
    assert.equal(adds[0].text, 'BETA-edited');
  } finally {
    repo.cleanup();
  }
});

test('editItem updates staged added lines in the index', async () => {
  const repo = makeRepo();
  try {
    repo.write('f.txt', 'alpha\nbeta\ngamma\n');
    repo.git(['add', 'f.txt']);
    repo.git(['commit', '-m', 'init']);
    repo.write('f.txt', 'alpha\nBETA\ngamma\n');
    repo.git(['add', 'f.txt']);
    const loaded = await load(repo.dir, [], { deferExtras: false });
    const item = loaded.items.find((entry) => entry.origin === 'staged');
    assert.ok(item);
    await editItem(loaded.top, item, 'STAGED');
    assert.equal(repo.read('f.txt'), 'alpha\nSTAGED\ngamma\n');
    const cached = repo.git(['diff', '--cached', '--', 'f.txt']);
    assert.match(cached, /\+STAGED/);
    const work = repo.git(['diff', '--', 'f.txt']);
    assert.equal(work, '');
  } finally {
    repo.cleanup();
  }
});

test('listFiles includes tracked and untracked paths', async () => {
  const repo = makeRepo();
  try {
    repo.write('b.js', 'b\n');
    repo.write('a.js', 'a\n');
    repo.git(['add', '.']);
    repo.git(['commit', '-m', 'init']);
    repo.write('z.js', 'z\n');
    const names = await createGitRepo().listFiles(repo.dir);
    assert.deepEqual(names, ['a.js', 'b.js', 'z.js']);
    assert.equal(await createGitRepo().fileText(repo.dir, 'a.js'), 'a\n');
    await createGitRepo().writeFile(repo.dir, 'nested/x.js', 'x\n');
    assert.equal(repo.read('nested/x.js'), 'x\n');
  } finally {
    repo.cleanup();
  }
});

test('file edit save stages the whole file', async () => {
  const repo = makeRepo();
  try {
    repo.write(
      'a.js',
      'alpha\nbeta\nkeep1\nkeep2\nkeep3\nkeep4\nkeep5\ngamma\n',
    );
    repo.git(['add', 'a.js']);
    repo.git(['commit', '-m', 'init']);
    repo.write(
      'a.js',
      'alpha\nBETA\nkeep1\nkeep2\nkeep3\nkeep4\nkeep5\ngamma\n',
    );
    const stdout = sink();
    const session = new Session({
      repo: createGitRepo(),
      cwd: repo.dir,
      stdout,
      color: false,
      startPane: 'files',
    });
    await session.load();
    session.dispatch('file');
    await session.ops.idle();
    session.dispatch('next');
    await session.ops.idle();
    session.dispatch('open');
    await session.ops.idle();
    session.dispatch('code');
    await session.ops.idle();
    session.editor.replace(
      'alpha\nBETA\nkeep1\nkeep2\nkeep3\nkeep4\nkeep5\nGAMMA\n',
    );
    session.composer.saveCompose();
    await session.ops.idle();
    const cached = repo.git(['diff', '--cached', '--', 'a.js']);
    const work = repo.git(['diff', '--', 'a.js']);
    assert.match(cached, /BETA/);
    assert.match(cached, /GAMMA/);
    assert.equal(work, '');
    assert.ok(session.items.every((entry) => entry.origin === 'staged'));
    assert.equal(session.status, 'staged');
  } finally {
    repo.cleanup();
  }
});

for (const first of ['git', 'branches', 'deps']) {
  test(`Git repository works when ${first} is imported first`, () => {
    const script = `
      const assert = require('node:assert/strict');
      require('./lib/git/' + process.argv[1] + '.js');
      const repo = require('./lib/git/git.js').createGitRepo();
      for (const name of ['load', 'add', 'revertFile', 'commit', 'rebase']) {
        assert.equal(typeof repo[name], 'function', name);
      }
    `;
    const result = spawnSync(process.execPath, ['-e', script, first], {
      cwd: path.resolve(__dirname, '..'),
      encoding: 'utf8',
      windowsHide: true,
    });
    assert.equal(result.status, 0, result.stderr);
  });
}

test('repo reads answer through promises', async () => {
  const repo = makeRepo();
  try {
    repo.write('a.js', 'a\n');
    repo.git(['add', '.']);
    repo.git(['commit', '-m', 'init']);
    const source = createGitRepo();
    const reads = {
      toplevel: source.toplevel(repo.dir),
      resolveRev: source.resolveRev(repo.dir, 'HEAD'),
      listFiles: source.listFiles(repo.dir),
      fileText: source.fileText(repo.dir, 'a.js', 'HEAD'),
      hasStaged: source.hasStaged(repo.dir),
      lastMessage: source.lastMessage(repo.dir),
      listBranches: source.listBranches(repo.dir),
      listCommits: source.listCommits(repo.dir),
      currentBranch: source.currentBranch(repo.dir),
    };
    for (const name of Object.keys(reads)) {
      assert.ok(reads[name] instanceof Promise, name);
    }
    assert.equal(await reads.fileText, 'a\n');
    assert.equal(await reads.hasStaged, false);
    assert.equal(await reads.lastMessage, 'init');
    assert.equal((await reads.listCommits).length, 1);
    assert.match(await reads.resolveRev, /^[0-9a-f]{40}$/);
    await Promise.all(Object.values(reads));
  } finally {
    repo.cleanup();
  }
});

test('runProc survives a child that exits before reading input', async () => {
  const input = 'x'.repeat(4 * 1024 * 1024);
  const errors = [];
  const onError = (error) => errors.push(error);
  process.on('uncaughtException', onError);
  try {
    const args = ['-e', 'process.exit(3)'];
    const result = await runProc(process.execPath, args, { input });
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
    assert.equal(result.status, 3);
    assert.deepEqual(errors, []);
  } finally {
    process.off('uncaughtException', onError);
  }
});
