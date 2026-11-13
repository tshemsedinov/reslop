'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const branches = require('../../lib/git/branches.js');
const { resolveConflictText, resolveWorktreeFile } = branches;
const { load } = require('../../lib/git/git.js');
const { makeRepo, sessionFor, press, stopSession } = require('../helpers.js');
const { openSession, sampleItem } = require('../session-helpers.js');
const { dimFooterActions } = require('../../lib/render/footer.js');

const CONFLICT = [
  'before',
  '<<<<<<< HEAD',
  'ours',
  '=======',
  'theirs',
  '>>>>>>> topic',
  'after',
  '',
].join('\n');

test('conflict choices preserve surrounding text and line endings', () => {
  for (const eol of ['\n', '\r\n']) {
    const source = CONFLICT.replaceAll('\n', eol);
    assert.equal(
      resolveConflictText(source, 'ours'),
      ['before', 'ours', 'after', ''].join(eol),
    );
    assert.equal(
      resolveConflictText(source, 'theirs'),
      ['before', 'theirs', 'after', ''].join(eol),
    );
    assert.equal(
      resolveConflictText(source, 'both'),
      ['before', 'ours', 'theirs', 'after', ''].join(eol),
    );
  }
  const twice = CONFLICT + CONFLICT;
  const expected = 'before\nours\nafter\nbefore\nours\nafter\n';
  assert.equal(resolveConflictText(twice, 'ours'), expected);
  const noEnd = CONFLICT.trimEnd();
  assert.equal(resolveConflictText(noEnd, 'theirs'), 'before\ntheirs\nafter');
});

test('conflict resolution rejects incomplete, nested and binary input', () => {
  const invalid = [
    'plain text',
    CONFLICT.replace('=======', '======'),
    CONFLICT.replace('>>>>>>> topic', ''),
    CONFLICT.replace('ours', '<<<<<<< nested'),
    CONFLICT.replace('ours', '||||||| base\noriginal'),
    `${CONFLICT}\0`,
  ];
  for (const text of invalid) {
    assert.equal(resolveConflictText(text, 'ours'), null);
  }
  assert.equal(resolveConflictText(CONFLICT, 'unknown'), null);
});

test('empty sides and custom marker widths resolve', () => {
  const source = '<<<<<<<< ours\n========\ntheirs\n>>>>>>>> theirs\n';
  assert.equal(resolveConflictText(source, 'ours'), '');
  assert.equal(resolveConflictText(source, 'theirs'), 'theirs\n');
  const shared = CONFLICT.replace('ours', 'same').replace('theirs', 'same');
  assert.equal(resolveConflictText(shared, 'both'), 'before\nsame\nafter\n');
});

const mergeConflict = (repo) => {
  repo.write('f.txt', 'base\n');
  repo.git(['add', '.']);
  repo.git(['commit', '-m', 'base']);
  repo.git(['checkout', '-b', 'topic']);
  repo.write('f.txt', 'theirs\n');
  repo.git(['commit', '-am', 'theirs']);
  repo.git(['checkout', 'main']);
  repo.write('f.txt', 'ours\n');
  repo.git(['commit', '-am', 'ours']);
  assert.throws(() => repo.git(['merge', 'topic']), /CONFLICT/);
};

for (const pane of ['diff', 'files', 'unit']) {
  test(`resolve in ${pane} removes markers and stages the file`, async () => {
    const repo = makeRepo();
    let session = null;
    try {
      mergeConflict(repo);
      const loaded = await load(repo.dir);
      assert.ok(
        loaded.items.some((item) => item.file.newPath === 'f.txt'),
        repo.git(['status', '-vv']) + repo.git(['diff', '--ours']),
      );
      session = await sessionFor(repo.dir);
      if (pane !== 'diff') {
        session.dispatch('files');
        if (pane === 'unit') {
          session.dispatch('file');
          await session.ops.idle();
          session.dispatch('open');
          await session.ops.idle();
        }
      }
      assert.equal(session.pane, pane);
      assert.ok(!dimFooterActions(session.view()).includes('resolve'));
      const before = repo.read('f.txt');
      press(session, 's');
      assert.equal(session.mode, 'confirmResolve');
      press(session, 'escape');
      assert.equal(session.mode, 'review');
      assert.equal(repo.read('f.txt'), before);
      press(session, 's');
      const keys = { diff: 'o', files: 't', unit: 'b' };
      const expected = {
        diff: 'ours\n',
        files: 'theirs\n',
        unit: 'ours\ntheirs\n',
      };
      press(session, keys[pane]);
      await session.ops.idle();
      assert.equal(session.mode, 'review');
      assert.equal(repo.read('f.txt'), expected[pane]);
      assert.equal(repo.git(['ls-files', '-u']), '');
      assert.equal(repo.git(['show', ':f.txt']), expected[pane]);
      assert.equal(repo.git(['diff']), '');
      assert.equal(session.status, 'resolved');
    } finally {
      if (session) stopSession(session);
      repo.cleanup();
    }
  });
}

test('resolve refuses read-only snapshots', async () => {
  for (const origin of ['unstaged', 'commit', 'pr']) {
    const { session } = await openSession([sampleItem('a.js', origin)], {
      readOnly: true,
    });
    press(session, 's');
    assert.equal(session.mode, 'review');
    assert.equal(session.status, 'read only');
  }
});

test('unsupported conflicts leave the file and index intact', async () => {
  const repo = makeRepo();
  try {
    repo.write('f.txt', 'original\n');
    repo.git(['add', '.']);
    repo.git(['commit', '-m', 'base']);
    const text = CONFLICT.replace('=======', '======');
    repo.write('f.txt', text);
    await assert.rejects(resolveWorktreeFile(repo.dir, 'f.txt', 'ours'));
    assert.equal(repo.read('f.txt'), text);
    assert.equal(repo.git(['show', ':f.txt']), 'original\n');
  } finally {
    repo.cleanup();
  }
});
