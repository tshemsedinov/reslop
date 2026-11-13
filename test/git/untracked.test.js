'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { load } = require('../../lib/git/git.js');
const { stripAnsi } = require('../../lib/term/ansi.js');
const helpers = require('../helpers.js');
const { makeRepo, sessionFor, press, stopSession } = helpers;

for (const linked of [false, true]) {
  test(`untracked navigation works (linked: ${linked})`, async () => {
    const repo = makeRepo();
    let session = null;
    try {
      repo.write('tracked.rs', 'old\n');
      repo.git(['add', '.']);
      repo.git(['commit', '-m', 'base']);
      const top = linked ? path.join(repo.dir, 'linked tree') : repo.dir;
      if (linked) repo.git(['worktree', 'add', '-b', 'review', top]);
      const prefix = linked ? 'linked tree/' : '';
      repo.write(`${prefix}tracked.rs`, 'changed\n');
      repo.write(`${prefix}new file.rs`, 'fn first() {}\r\nfn second() {}\r\n');
      repo.write(`${prefix}новый.rs`, 'fn unicode() {}\n');
      const loaded = await load(top);
      const untracked = loaded.items.filter(
        (item) => item.origin === 'untracked',
      );
      assert.equal(untracked.length, 2);
      const added = untracked.find(
        (item) => item.file.newPath === 'new file.rs',
      );
      assert.ok(added);
      assert.deepEqual(
        added.hunk.lines.map((line) => line.text),
        ['fn first() {}', 'fn second() {}'],
      );
      session = await sessionFor(top);
      session.dispatch('files');
      const list = session.fileList();
      session.fileCursor = list.findIndex(
        (entry) => entry.path === 'new file.rs',
      );
      press(session, 'enter');
      await session.ops.idle();
      assert.equal(session.current().file.newPath, 'new file.rs');
      session.draw();
      let body = stripAnsi(session.lastFrame.rows.join('\n'));
      assert.match(body, /fn first\(\)/);
      assert.ok(!body.includes('\r'));
      press(session, 'right');
      press(session, 'left');
      assert.equal(session.current().file.newPath, 'new file.rs');
      session.dispatch('files');
      session.dispatch('file');
      await session.ops.idle();
      session.fileCursor = session
        .fileList()
        .findIndex((entry) => entry.path === 'new file.rs');
      press(session, 'enter');
      await session.ops.idle();
      assert.equal(session.pane, 'unit');
      session.draw();
      body = stripAnsi(session.lastFrame.rows.join('\n'));
      assert.match(body, /fn second\(\)/);
      assert.ok(!body.includes('\r'));
      assert.equal(
        repo.read(`${prefix}new file.rs`),
        'fn first() {}\r\nfn second() {}\r\n',
      );
    } finally {
      if (session) stopSession(session);
      repo.cleanup();
    }
  });
}
