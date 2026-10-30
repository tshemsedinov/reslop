'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { hitAction } = require('../../lib/input/keys.js');
const helpers = require('../helpers.js');
const { tempDir, press, click } = helpers;
const ansi = require('../../lib/term/ansi.js');
const { stripAnsi, THEME, bg } = ansi;
const sessionHelpers = require('../session-helpers.js');
const { sampleItem, openSession, clickFooter, listCell } = sessionHelpers;
const { shiftClick, ctrlClick } = sessionHelpers;

const tallItem = (name, count) => {
  const item = sampleItem(name);
  const lines = [];
  for (let i = 0; i < count; i++) {
    lines.push({ type: 'add', text: `line${i}`, noNl: false, blockId: 0 });
  }
  const hunk = { ...item.hunk, lines, oldCount: 0, newCount: count };
  return { ...item, hunk };
};

test('prev at first block stays put and next reaches last', async () => {
  const a = sampleItem('a.js');
  const b = sampleItem('b.js');
  const c = sampleItem('c.js');
  const { session } = await openSession([a, b, c]);
  session.dispatch('prev');
  assert.equal(session.current().file.newPath, 'a.js');
  session.dispatch('next');
  assert.equal(session.current().file.newPath, 'b.js');
  session.dispatch('next');
  assert.equal(session.current().file.newPath, 'c.js');
  session.dispatch('next');
  assert.equal(session.current().file.newPath, 'c.js');
});

test('a on staged and u on unstaged do nothing', async () => {
  const staged = await openSession([sampleItem('s.js', 'staged')]);
  press(staged.session, 'a');
  assert.equal(staged.repo.added.length, 0);
  assert.equal(staged.session.status, '');
  assert.equal(staged.session.items[0].origin, 'staged');
  const unstaged = await openSession([sampleItem('u.js')]);
  press(unstaged.session, 'u');
  assert.equal(unstaged.repo.unstageCalls.length, 0);
  assert.equal(unstaged.session.status, '');
});

test('add and unstage keep block order', async () => {
  const a = sampleItem('a.js');
  const b = sampleItem('b.js');
  const c = sampleItem('c.js');
  const { session, repo } = await openSession([a, b, c]);
  let loads = 0;
  const inner = repo.load;
  repo.load = () => {
    loads += 1;
    return inner();
  };
  session.index = 1;
  session.dispatch('add');
  await session.ops.idle();
  assert.equal(loads, 0);
  assert.equal(repo.added.length, 1);
  assert.deepEqual(
    session.items.map((item) => item.file.newPath),
    ['a.js', 'b.js', 'c.js'],
  );
  assert.equal(session.items[1].origin, 'staged');
  assert.equal(session.current().file.newPath, 'b.js');
  const stagedFirst = [session.items[1], session.items[0], session.items[2]];
  repo.load = () => ({ top: '/tmp', items: stagedFirst, branch: 'main' });
  session.refreshFromRepo({ keepView: true });
  await session.ops.idle();
  assert.deepEqual(
    session.items.map((item) => item.file.newPath),
    ['a.js', 'b.js', 'c.js'],
  );
  assert.equal(session.items[1].origin, 'staged');
  assert.equal(session.current().file.newPath, 'b.js');
  session.dispatch('unstage');
  await session.ops.idle();
  assert.equal(loads, 0);
  assert.equal(session.items[1].origin, 'unstaged');
  assert.deepEqual(
    session.items.map((item) => item.file.newPath),
    ['a.js', 'b.js', 'c.js'],
  );
});

test('unstage acts on the current block and keeps it listed', async () => {
  const staged = sampleItem('a.js', 'staged');
  const other = sampleItem('b.js');
  const { session, repo } = await openSession([staged, other]);
  session.dispatch('unstage');
  await session.ops.idle();
  assert.equal(repo.unstageCalls.length, 1);
  assert.equal(repo.unstageCalls[0].file.newPath, 'a.js');
  assert.equal(session.status, 'unstaged');
  assert.deepEqual(
    session.items.map((item) => [item.file.newPath, item.origin]),
    [
      ['a.js', 'unstaged'],
      ['b.js', 'unstaged'],
    ],
  );
});

test('AC28 unstage on unstaged is a no-op', async () => {
  const item = sampleItem('a.js');
  const { session, repo } = await openSession([item]);
  session.dispatch('unstage');
  assert.equal(session.status, '');
  assert.equal(repo.unstageCalls.length, 0);
  assert.equal(session.items.length, 1);
});

// Each edit says read only and reaches no repository call
const assertEditsRefused = (session, repo) => {
  for (const action of ['add', 'revert', 'unstage', 'commit']) {
    session.dispatch(action);
    assert.equal(session.status, 'read only', action);
  }
  assert.equal(repo.added.length, 0);
  assert.equal(repo.reverted.length, 0);
  assert.equal(repo.unstageCalls.length, 0);
  assert.equal(repo.commits.length, 0);
};

test('AC21 commit add and revert are read only', async () => {
  const item = sampleItem('c.js', 'commit');
  const { session, repo } = await openSession([item]);
  session.revShort = '7ac260c';
  assertEditsRefused(session, repo);
  const files = session.fileList();
  assert.equal(files[0].status, '7ac260c');
  session.dispatch('next');
  assert.equal(session.status, 'read only');
  assert.equal(repo.added.length, 0);
});

test('PR add and revert are read only and feedback attaches', async () => {
  const item = sampleItem('lib/a.js', 'pr');
  const { session, repo } = await openSession([item], {
    sourceLabel: '#12',
    change: {
      source: 'pr',
      repository: 'acme/app',
      title: 'Fix',
      author: 'alice',
      number: 12,
    },
    repoName: 'acme/app',
  });
  assertEditsRefused(session, repo);
  const files = session.fileList();
  assert.equal(files[0].status, '#12');
  session.dispatch('blockTask');
  session.pushInput('prefer const');
  press(session, 'ctrl-s');
  const note = session.notes.blockTask('lib/a.js:1');
  assert.equal(note.text, 'prefer const');
  assert.equal(session.view().counts.pr, 1);
  assert.equal(session.view().counts.tasks, 1);
  session.dispatch('next');
  assert.equal(session.status, 'saved');
  session.dispatch('prev');
  assert.equal(session.current().file.newPath, 'lib/a.js');
  const view = session.view();
  assert.equal(view.sourceKind, 'pr');
  assert.equal(view.sourceLabel, '#12');
  assert.equal(view.repoName, 'acme/app');
});

test('-r blocks add unstage revert and still takes feedback', async () => {
  const item = sampleItem('a.js');
  const { session, repo } = await openSession([item], { readOnly: true });
  assertEditsRefused(session, repo);
  session.pane = 'files';
  session.dispatch('add');
  assert.equal(session.status, 'read only');
  assert.equal(repo.added.length, 0);
  session.pane = 'diff';
  session.dispatch('blockTask');
  session.pushInput('keep this');
  press(session, 'ctrl-s');
  const note = session.notes.blockTask('a.js:1');
  assert.equal(note.text, 'keep this');
});

test('AC9 hotkeys dispatch add revert next prev quit', async () => {
  const a = sampleItem('a.js');
  const b = sampleItem('b.js');
  const c = sampleItem('c.js');
  const { session, repo } = await openSession([a, b, c]);
  assert.equal(session.layout, 'unified');
  session.pushInput('j');
  await session.ops.idle();
  assert.equal(session.current().file.newPath, 'b.js');
  session.pushInput('k');
  await session.ops.idle();
  assert.equal(session.current().file.newPath, 'a.js');
  session.pushInput('a');
  await session.ops.idle();
  assert.equal(repo.added.length, 1);
  assert.equal(repo.added[0].file.newPath, 'a.js');
  press(session, 'delete');
  await session.ops.idle();
  assert.equal(repo.reverted.length, 1);
  session.pushInput('m');
  await session.ops.idle();
  assert.equal(session.layout, 'mixed');
  assert.equal(session.status, 'mixed');
  session.pushInput('m');
  await session.ops.idle();
  assert.equal(session.layout, 'side');
  assert.equal(session.status, 'side-by-side');
  session.pushInput('m');
  await session.ops.idle();
  assert.equal(session.layout, 'unified');
  press(session, 'escape');
  await session.ops.idle();
  assert.equal(session.pane, 'files');
  press(session, 'ctrl-c');
  await session.ops.idle();
  assert.equal(session.done, false);
  session.dispatch('quit');
  assert.equal(session.done, true);
});

test('next walks the diff in the order of the file list', async () => {
  const names = ['a.js', 'b.js', 'c.js', 'd.js'];
  const items = [
    sampleItem('d.js'),
    sampleItem('b.js', 'staged'),
    sampleItem('a.js'),
    sampleItem('c.js'),
  ];
  const { session } = await openSession(items);
  const walked = [session.current().file.newPath];
  for (let i = 1; i < names.length; i++) {
    press(session, 'right');
    walked.push(session.current().file.newPath);
  }
  assert.deepEqual(walked, names);
});

test('next enters a file on its first unstaged block', async () => {
  const at = (name, origin, newStart) => {
    const item = sampleItem(name, origin);
    return { ...item, hunk: { ...item.hunk, newStart } };
  };
  const items = [
    at('a.js', 'unstaged', 1),
    at('b.js', 'unstaged', 30),
    at('b.js', 'staged', 10),
    at('b.js', 'unstaged', 20),
  ];
  const { session } = await openSession(items);
  press(session, 'right');
  const here = session.current();
  assert.equal(here.file.newPath, 'b.js');
  assert.equal(here.origin, 'unstaged');
  assert.equal(here.hunk.newStart, 20);
  press(session, 'right');
  assert.equal(session.current().hunk.newStart, 30);
});

test('j and k move the files cursor', async () => {
  const a = sampleItem('a.js');
  const b = sampleItem('b.js');
  const { session } = await openSession([a, b], { startPane: 'files' });
  assert.equal(session.fileCursor, 0);
  press(session, 'right');
  assert.equal(session.fileCursor, 0);
  press(session, 'left');
  assert.equal(session.fileCursor, 0);
  session.pushInput('j');
  assert.equal(session.fileCursor, 1);
  session.pushInput('k');
  assert.equal(session.fileCursor, 0);
  press(session, 'down');
  assert.equal(session.fileCursor, 1);
});

test('files screen picks a folder and lists its files', async () => {
  const items = [
    sampleItem('README.md'),
    sampleItem('lib/a.js'),
    sampleItem('lib/b.js'),
    sampleItem('lib/deep/c.js'),
    sampleItem('test/x.js'),
  ];
  const { session } = await openSession(items, { startPane: 'files' });
  session.nav.fileScope = 'file';
  const view = () => session.view();
  const names = () => session.fileList().map((entry) => entry.path);
  const folders = () => view().folders.map((row) => row.key);
  assert.deepEqual(folders(), ['.', 'lib', 'lib/deep', 'test']);
  assert.equal(view().folderCursor, 0);
  assert.deepEqual(names(), ['README.md']);
  press(session, 'left');
  assert.equal(view().folderFocus, true);
  press(session, 'down');
  assert.deepEqual(names(), ['lib/a.js', 'lib/b.js']);
  assert.equal(session.reviewPath, 'lib/a.js');
  assert.equal(view().folders[view().folderCursor].files, 3);
  press(session, 'tab');
  assert.equal(view().folderFocus, false);
  press(session, 'down');
  assert.equal(session.reviewPath, 'lib/b.js');
  press(session, 'shift-tab', 'down', 'right');
  assert.deepEqual(names(), ['lib/deep/c.js']);
  assert.equal(session.fileCursor, 0);
  press(session, 'left', 'end');
  assert.deepEqual(names(), ['test/x.js']);
  press(session, 'enter');
  assert.equal(view().folderFocus, false);
  assert.equal(session.pane, 'files');
  press(session, 'enter');
  await session.ops.idle();
  assert.equal(session.pane, 'unit');
  press(session, 'escape');
  assert.equal(session.pane, 'files');
  assert.deepEqual(names(), ['test/x.js']);
  assert.equal(view().folderFocus, false);
});

test('file actions are off while the folder tree has the focus', async () => {
  const { session, repo } = await openSession(
    [sampleItem('lib/a.js'), sampleItem('b.js')],
    { startPane: 'files' },
  );
  session.nav.fileScope = 'file';
  press(session, 'left');
  session.dispatch('add');
  await session.ops.idle();
  assert.equal(repo.added.length, 0);
  press(session, 'right');
  session.dispatch('add');
  await session.ops.idle();
  assert.deepEqual(
    repo.added.map((item) => item.file.newPath),
    ['b.js'],
  );
});

test('a folder that empties falls back to its parent', async () => {
  const { session } = await openSession(
    [sampleItem('lib/a.js'), sampleItem('b.js')],
    { startPane: 'files' },
  );
  session.nav.fileScope = 'file';
  press(session, 'left', 'down', 'right');
  assert.deepEqual(
    session.fileList().map((entry) => entry.path),
    ['lib/a.js'],
  );
  session.dispatch('revert');
  await session.ops.idle();
  assert.deepEqual(
    session.fileList().map((entry) => entry.path),
    ['b.js'],
  );
  assert.equal(session.view().folderCursor, 0);
});

test('the files screen shows the size and lines read from disk', async () => {
  const cwd = tempDir('reslop-ui-');
  fs.mkdirSync(path.join(cwd, 'lib'));
  fs.writeFileSync(path.join(cwd, 'lib', 'a.js'), 'one\ntwo\nthree\n');
  const { session } = await openSession([sampleItem('lib/a.js')], {
    startPane: 'files',
    cwd,
  });
  session.nav.fileScope = 'file';
  session.view();
  await session.ops.idle();
  press(session, 'left', 'down');
  const view = session.view();
  assert.equal(view.files[0].bytes, 14);
  assert.equal(view.files[0].lines, 3);
  const lib = view.folders.find((row) => row.key === 'lib');
  assert.equal(lib.bytes, 14);
  assert.equal(lib.lines, 3);
  assert.equal(view.folders[0].lines, 3);
});

test('the list of changes stays a plain list of paths', async () => {
  const { session } = await openSession(
    [sampleItem('lib/a.js'), sampleItem('b.js')],
    { startPane: 'files' },
  );
  const view = session.view();
  assert.equal(view.folders, undefined);
  assert.deepEqual(
    view.files.map((entry) => entry.path),
    ['b.js', 'lib/a.js'],
  );
  press(session, 'left', 'tab', 'down');
  assert.equal(session.fileCursor, 1);
  session.color = true;
  session.draw();
  const hit = session.lastFrame.fileHits.find((entry) => entry.cursor === 1);
  const picked = session.lastFrame.rows[hit.y - 1];
  assert.ok(stripAnsi(picked).includes('lib/a.js'));
  assert.ok(picked.includes(bg(THEME.buttonBg)));
  assert.equal(stripAnsi(picked).includes('▶'), false);
  assert.ok(!session.lastFrame.fileHits.some((entry) => entry.folder));
});

test('vim ctrl keys scroll the diff by line and page', async () => {
  const { session } = await openSession([tallItem('a.js', 80)]);
  session.draw();
  const page = session.lastFrame.bodyH;
  assert.ok(page > 1);
  press(session, 'ctrl-e');
  assert.equal(session.scroll, 1);
  press(session, 'ctrl-y');
  assert.equal(session.scroll, 0);
  press(session, 'ctrl-f');
  assert.equal(session.scroll, page);
  press(session, 'ctrl-b');
  assert.equal(session.scroll, 0);
  press(session, 'ctrl-d');
  assert.equal(session.scroll, Math.max(1, Math.floor(page * 0.5)));
  press(session, 'ctrl-u');
  assert.equal(session.scroll, 0);
  press(session, 'pageDown');
  assert.equal(session.scroll, page);
  press(session, 'end');
  assert.equal(session.scroll, session.lastFrame.scrollMax);
  press(session, 'home');
  assert.equal(session.scroll, 0);
  press(session, 'pageUp');
  assert.equal(session.scroll, 0);
});

test('diff up scrolls immediately after the last line', async () => {
  const { session } = await openSession([tallItem('a.js', 80)]);
  session.draw();
  const max = session.lastFrame.scrollMax;
  assert.ok(max > 1);
  for (let i = 0; i < max + 10; i++) session.dispatch('scrollDown');
  assert.equal(session.scroll, max);
  session.dispatch('scrollUp');
  assert.equal(session.scroll, max - 1);
});

test('vim ctrl-f pages down the files list', async () => {
  const items = [];
  for (let i = 0; i < 20; i++) items.push(sampleItem(`f${i}.js`));
  const { session } = await openSession(items, { startPane: 'files' });
  session.draw();
  const page = session.lastFrame.bodyH;
  assert.equal(session.fileCursor, 0);
  press(session, 'ctrl-f');
  assert.equal(session.fileCursor, page);
  press(session, 'ctrl-b');
  assert.equal(session.fileCursor, 0);
});

test('files list up moves the cursor before scrolling', async () => {
  const items = [];
  for (let i = 0; i < 20; i++) items.push(sampleItem(`f${i}.js`));
  const { session } = await openSession(items, {
    startPane: 'files',
    color: true,
  });
  const last = session.fileList().length - 1;
  for (let i = 0; i < last; i++) session.dispatch('next');
  session.draw();
  assert.equal(session.fileCursor, last);
  const markRow = (frame) => {
    for (let i = 0; i < frame.rows.length; i++) {
      const plain = stripAnsi(frame.rows[i]);
      if (!/f\d+\.js/.test(plain)) continue;
      if (frame.rows[i].includes(bg(THEME.buttonBg))) return i;
    }
    return -1;
  };
  const listNames = (frame) => {
    const names = [];
    for (const hit of frame.fileHits) {
      const match = /f\d+\.js/.exec(stripAnsi(frame.rows[hit.y - 1]));
      if (match) names.push(match[0]);
    }
    return names;
  };
  const bottom = session.lastFrame;
  const bottomMark = markRow(bottom);
  const bottomNames = listNames(bottom);
  assert.ok(bottomMark > 0);
  assert.ok(bottomNames.length > 1);
  session.dispatch('prev');
  session.draw();
  assert.equal(session.fileCursor, last - 1);
  assert.deepEqual(listNames(session.lastFrame), bottomNames);
  assert.equal(markRow(session.lastFrame), bottomMark - 1);
});

test('home end and page keys jump the files list', async () => {
  const items = [];
  for (let i = 0; i < 20; i++) items.push(sampleItem(`f${i}.js`));
  const { session } = await openSession(items, { startPane: 'files' });
  session.draw();
  const page = session.lastFrame.bodyH;
  const last = session.fileList().length - 1;
  press(session, 'pageDown');
  assert.equal(session.fileCursor, page);
  press(session, 'pageUp');
  assert.equal(session.fileCursor, 0);
  press(session, 'end');
  assert.equal(session.fileCursor, last);
  press(session, 'home');
  assert.equal(session.fileCursor, 0);
});

test('AC10 footer Add hitbox dispatches add', async () => {
  const item = sampleItem('c.js');
  const { session, repo } = await openSession([item]);
  session.draw();
  const hit = session.lastFrame.buttons.find((entry) => entry.id === 'add');
  assert.ok(hit);
  assert.equal(hitAction(session.lastFrame.buttons, hit.x0), 'add');
  session.handleEvent({
    type: 'mouse',
    button: 0,
    btn: 0,
    kind: 'press',
    x: hit.x0 + 1,
    y: session.lastFrame.height,
    press: true,
  });
  await session.ops.idle();
  session.handleEvent({
    type: 'mouse',
    button: 0,
    btn: 0,
    kind: 'release',
    x: hit.x0 + 1,
    y: session.lastFrame.height,
    press: false,
  });
  await session.ops.idle();
  assert.equal(repo.added.length, 1);
});

test('AC13 drag copies selected text', async () => {
  const item = sampleItem('c.js');
  const { session, stdout } = await openSession([item]);
  session.draw();
  session.handleEvent({
    type: 'mouse',
    kind: 'press',
    btn: 0,
    button: 0,
    x: 1,
    y: 3,
    press: true,
  });
  session.handleEvent({
    type: 'mouse',
    kind: 'drag',
    btn: 0,
    button: 32,
    x: 40,
    y: 5,
    press: true,
  });
  session.handleEvent({
    type: 'mouse',
    kind: 'release',
    btn: 0,
    button: 0,
    x: 40,
    y: 5,
    press: false,
  });
  const [, payload] = /\]52;c;([A-Za-z0-9+/=]+)/.exec(stdout.dump());
  const copied = Buffer.from(payload, 'base64').toString('utf8');
  assert.match(copied, /- a/);
  assert.match(copied, /\+ b/);
  assert.equal(session.status, 'copied');
});

test('draw writes once for an unchanged frame', async () => {
  const item = sampleItem('c.js');
  const { session, stdout } = await openSession([item]);
  session.draw();
  const first = stdout.dump();
  session.draw();
  assert.equal(stdout.dump(), first);
  assert.ok(first.includes('[?2026h'));
  assert.ok(first.includes('[2J'));
  session.dispatch('layout');
  session.draw();
  const second = stdout.dump();
  assert.ok(second.length > first.length);
  const extra = second.slice(first.length);
  assert.ok(extra.includes('[?2026h'));
  assert.ok(!extra.includes('[2J'));
});

test('escape from diff opens the file list, then quits', async () => {
  const { session } = await openSession([
    sampleItem('a.js'),
    sampleItem('b.js'),
  ]);
  assert.equal(session.pane, 'diff');
  press(session, 'escape');
  assert.equal(session.pane, 'files');
  assert.equal(session.done, false);
  press(session, 'escape');
  assert.equal(session.done, true);
});

test('escape from files with notes quits and keeps the status', async () => {
  const { session } = await openSession([sampleItem('a.js')]);
  session.dispatch('blockTask');
  session.pushInput('nits');
  press(session, 'ctrl-s', 'escape');
  assert.equal(session.pane, 'files');
  assert.equal(session.done, false);
  session.notes.status = 'partial';
  press(session, 'escape');
  assert.equal(session.done, true);
  assert.equal(session.mode, 'review');
  assert.equal(session.notes.status, 'partial');
});

test('AC14 files pane lists paths and enter opens', async () => {
  const a = sampleItem('a.js');
  const b = sampleItem('b.js');
  const { session, stdout } = await openSession([a, b], { startPane: 'files' });
  assert.equal(session.pane, 'files');
  session.draw();
  const text = stdout.dump();
  assert.ok(!text.includes('@@'));
  assert.match(text, /a\.js/);
  assert.match(text, /b\.js/);
  session.dispatch('open');
  assert.equal(session.pane, 'diff');
  assert.equal(session.current().file.newPath, 'a.js');
  session.dispatch('files');
  assert.equal(session.pane, 'files');
  assert.equal(session.fileCursor, 0);
});

test('enter on a partial file opens the first unstaged hunk', async () => {
  const staged = sampleItem('a.js', 'staged');
  const unstaged = sampleItem('a.js');
  unstaged.blockId = 1;
  const { session } = await openSession([staged, unstaged], {
    startPane: 'files',
  });
  session.dispatch('next');
  session.dispatch('open');
  assert.equal(session.pane, 'diff');
  assert.equal(session.current().origin, 'unstaged');
  assert.equal(session.index, 1);
});

test('files pane add moves to the next file', async () => {
  const { session } = await openSession(
    [sampleItem('a.js'), sampleItem('b.js'), sampleItem('c.js')],
    { startPane: 'files' },
  );
  session.dispatch('add');
  assert.equal(session.fileCursor, 1);
  assert.equal(session.fileList()[1].path, 'b.js');
  assert.equal(session.items[0].origin, 'staged');
  session.dispatch('prev');
  session.dispatch('unstage');
  assert.equal(session.fileCursor, 1);
  assert.equal(session.items[0].origin, 'unstaged');
});

test('files pane add on last file keeps the cursor', async () => {
  const { session } = await openSession(
    [sampleItem('a.js'), sampleItem('b.js'), sampleItem('c.js')],
    { startPane: 'files' },
  );
  session.dispatch('next');
  session.dispatch('next');
  assert.equal(session.fileCursor, 2);
  session.reviewPath = 'a.js';
  session.dispatch('add');
  assert.equal(session.fileCursor, 2);
  assert.equal(session.fileList()[2].path, 'c.js');
  assert.equal(session.items[2].origin, 'staged');
  session.dispatch('unstage');
  assert.equal(session.fileCursor, 2);
  assert.equal(session.items[2].origin, 'unstaged');
});

test('files pane add unstage revert apply to the whole file', async () => {
  const first = sampleItem('a.js');
  const second = sampleItem('a.js');
  second.blockId = 1;
  second.hunk = {
    ...second.hunk,
    oldStart: 10,
    newStart: 10,
    header: '@@ -10,1 +10,1 @@',
    blockId: 1,
  };
  const other = sampleItem('b.js');
  const { session, repo } = await openSession([first, second, other], {
    startPane: 'files',
  });
  session.dispatch('add');
  await session.ops.idle();
  assert.equal(repo.added.length, 2);
  assert.equal(repo.added[0].file.newPath, 'a.js');
  assert.equal(repo.added[1].file.newPath, 'a.js');
  assert.equal(session.items[0].origin, 'staged');
  assert.equal(session.items[1].origin, 'staged');
  assert.equal(session.items[2].origin, 'unstaged');
  assert.equal(session.fileCursor, 1);
  session.dispatch('prev');
  await session.ops.idle();
  session.dispatch('unstage');
  await session.ops.idle();
  assert.equal(repo.unstageCalls.length, 2);
  assert.equal(session.items[0].origin, 'unstaged');
  assert.equal(session.items[1].origin, 'unstaged');
  assert.equal(session.fileCursor, 1);
  session.dispatch('prev');
  await session.ops.idle();
  session.dispatch('revert');
  await session.ops.idle();
  assert.equal(repo.reverted.length, 2);
  assert.equal(repo.reverted[0].file.newPath, 'a.js');
  assert.equal(repo.reverted[1].file.newPath, 'a.js');
  assert.equal(session.fileCursor, 0);
  assert.equal(session.fileList()[0].path, 'b.js');
});

const laterHunk = (name) => {
  const item = sampleItem(name);
  item.blockId = 1;
  item.hunk = {
    ...item.hunk,
    oldStart: 10,
    newStart: 10,
    header: '@@ -10,1 +10,1 @@',
    blockId: 1,
  };
  return item;
};

test('file selection stages unstages and drops the chosen files', async () => {
  const { session, repo } = await openSession(
    [sampleItem('a.js'), sampleItem('b.js'), sampleItem('c.js')],
    { startPane: 'files' },
  );
  press(session, 'shift-down');
  assert.deepEqual(session.view().listSelection, [0, 1]);
  session.draw();
  const ids = session.lastFrame.buttons.map((hit) => hit.id);
  assert.ok(ids.includes('add'));
  assert.ok(!ids.includes('code'));
  session.dispatch('code');
  assert.equal(session.pane, 'files');
  session.dispatch('add');
  await session.ops.idle();
  assert.deepEqual(
    session.items.map((item) => item.origin),
    ['staged', 'staged', 'unstaged'],
  );
  assert.equal(session.nav.multiselect, false);
  assert.equal(session.fileCursor, 2);
  assert.equal(repo.added.length, 2);
  press(session, 'home', 'shift-down');
  session.dispatch('unstage');
  await session.ops.idle();
  assert.deepEqual(
    session.items.map((item) => item.origin),
    ['unstaged', 'unstaged', 'unstaged'],
  );
  press(session, 'home', 'shift-end');
  session.dispatch('revert');
  await session.ops.idle();
  assert.equal(repo.reverted.length, 3);
  assert.equal(session.fileList().length, 0);
});

test('a click leaves multiselect on files and diffs', async () => {
  const { session, repo } = await openSession(
    [sampleItem('a.js'), laterHunk('a.js'), sampleItem('b.js')],
    { startPane: 'files' },
  );
  press(session, 'shift-down');
  assert.equal(session.nav.multiselect, true);
  const kept = session.fileCursor;
  session.draw();
  click(session, 4, 1);
  assert.equal(session.nav.multiselect, false);
  assert.equal(session.fileCursor, kept);
  press(session, 'shift-end');
  assert.equal(session.nav.multiselect, true);
  session.draw();
  const listed = session.lastFrame.fileHits.filter((hit) => !hit.folder);
  const row = listed.at(-1);
  click(session, 5, row.y);
  assert.equal(session.nav.multiselect, false);
  assert.equal(session.fileCursor, row.cursor);
  session.nav.fileScope = 'file';
  press(session, 'home', 'shift-down');
  assert.equal(session.nav.multiselect, true);
  session.draw();
  const files = session.lastFrame.fileHits.filter((hit) => !hit.folder);
  const file = files.find((hit) => hit.cursor !== session.fileCursor);
  click(session, 5, file.y);
  assert.equal(session.nav.multiselect, false);
  assert.equal(session.fileCursor, file.cursor);
  session.nav.pane = 'diff';
  session.nav.index = 0;
  press(session, 'shift-right');
  assert.equal(session.nav.multiselect, true);
  assert.deepEqual(session.view().listSelection, [0, 1]);
  session.draw();
  click(session, 4, 3);
  assert.equal(session.nav.multiselect, false);
  session.nav.pane = 'files';
  session.nav.fileScope = 'diff';
  press(session, 'home', 'shift-down');
  assert.equal(session.nav.multiselect, true);
  clickFooter(session, 'add');
  await session.ops.idle();
  assert.equal(repo.added.length, 3);
});

test('sgr shift click selects the file span', async () => {
  const { session } = await openSession(
    [sampleItem('a.js'), sampleItem('b.js'), sampleItem('c.js')],
    { startPane: 'files' },
  );
  const cell = listCell(session, 2);
  const down = `\x1b[<4;${cell.x};${cell.y}M`;
  const up = `\x1b[<4;${cell.x};${cell.y}m`;
  session.pushInput(down + up);
  assert.deepEqual(session.view().listSelection, [0, 1, 2]);
});

test('ctrl-click stages only the files left selected', async () => {
  const { session, repo } = await openSession(
    [sampleItem('a.js'), sampleItem('b.js'), sampleItem('c.js')],
    { startPane: 'files' },
  );
  shiftClick(session, listCell(session, 2));
  assert.deepEqual(session.view().listSelection, [0, 1, 2]);
  ctrlClick(session, listCell(session, 1));
  assert.deepEqual(session.view().listSelection, [0, 2]);
  session.dispatch('add');
  await session.ops.idle();
  assert.deepEqual(
    repo.added.map((item) => item.file.newPath),
    ['a.js', 'c.js'],
  );
  press(session, 'down');
  assert.deepEqual(session.view().listSelection, []);
});

test('file selection ignore writes every chosen path', async () => {
  const { session, cwd } = await openSession(
    [sampleItem('a.log'), sampleItem('b.log')],
    { startPane: 'files' },
  );
  fs.writeFileSync(path.join(cwd, '.npmignore'), 'dist/\n');
  press(session, 'shift-down');
  session.dispatch('ignore');
  const gitignore = fs.readFileSync(path.join(cwd, '.gitignore'), 'utf8');
  assert.match(gitignore, /^a\.log\nb\.log\n$/);
  const npmignore = fs.readFileSync(path.join(cwd, '.npmignore'), 'utf8');
  assert.match(npmignore, /dist\/\na\.log\nb\.log\n$/);
  assert.equal(session.nav.multiselect, false);
});

test('staged file cursor does not block adding the selection', async () => {
  const { session } = await openSession(
    [sampleItem('a.js', 'staged'), sampleItem('b.js'), sampleItem('c.js')],
    { startPane: 'files' },
  );
  press(session, 'shift-end');
  session.dispatch('add');
  assert.deepEqual(
    session.items.map((item) => item.origin),
    ['staged', 'staged', 'staged'],
  );
  press(session, 'home', 'shift-end');
  session.dispatch('add');
  assert.equal(session.status, 'already staged');
  assert.equal(session.nav.multiselect, true);
  assert.equal(session.fileCursor, 2);
});

test('diff selection stages one hunk of a file', async () => {
  const { session, repo } = await openSession([
    sampleItem('a.js'),
    laterHunk('a.js'),
    sampleItem('b.js'),
  ]);
  press(session, 'shift-down', 'shift-up');
  assert.deepEqual(session.view().listSelection, [0]);
  assert.equal(session.nav.multiselect, true);
  session.dispatch('add');
  await session.ops.idle();
  assert.deepEqual(
    session.items.map((item) => item.origin),
    ['staged', 'unstaged', 'unstaged'],
  );
  assert.equal(repo.added.length, 1);
});

test('diff selection stages unstages and drops the chosen blocks', async () => {
  const { session, repo } = await openSession([
    sampleItem('a.js'),
    laterHunk('a.js'),
    sampleItem('b.js'),
  ]);
  press(session, 'shift-right');
  assert.deepEqual(session.view().listSelection, [0, 1]);
  session.draw();
  const ids = session.lastFrame.buttons.map((hit) => hit.id);
  assert.ok(ids.includes('add'));
  assert.ok(!ids.includes('code'));
  session.dispatch('blockTask');
  assert.equal(session.pane, 'diff');
  session.dispatch('add');
  await session.ops.idle();
  assert.deepEqual(
    session.items.map((item) => item.origin),
    ['staged', 'staged', 'unstaged'],
  );
  assert.equal(repo.added.length, 2);
  press(session, 'left', 'shift-right');
  session.dispatch('unstage');
  await session.ops.idle();
  assert.deepEqual(
    session.items.map((item) => item.origin),
    ['unstaged', 'unstaged', 'unstaged'],
  );
  press(session, 'left', 'shift-down');
  assert.deepEqual(session.view().listSelection, [0, 1]);
  press(session, 'right');
  assert.deepEqual(session.view().listSelection, []);
  press(session, 'shift-home');
  session.dispatch('revert');
  await session.ops.idle();
  assert.equal(repo.reverted.length, 3);
});

test('files pane i appends the path to gitignore and npmignore', async () => {
  const { session, cwd } = await openSession([sampleItem('noise.log')], {
    startPane: 'files',
  });
  fs.writeFileSync(path.join(cwd, '.npmignore'), 'dist/\n');
  session.dispatch('next');
  session.pushInput('i');
  assert.equal(session.status, 'ignored');
  const gitignore = fs.readFileSync(path.join(cwd, '.gitignore'), 'utf8');
  assert.match(gitignore, /^noise\.log\n$/);
  const npmignore = fs.readFileSync(path.join(cwd, '.npmignore'), 'utf8');
  assert.match(npmignore, /dist\/\nnoise\.log\n$/);
  session.pushInput('i');
  assert.equal(session.status, 'already ignored');
});

test('files pane disables mode and feedback', async () => {
  const { session } = await openSession([sampleItem('a.js')], {
    startPane: 'files',
  });
  session.dispatch('layout');
  assert.equal(session.layout, 'unified');
  assert.equal(session.status, '');
  session.dispatch('blockTask');
  assert.equal(session.mode, 'review');
  assert.equal(session.pane, 'files');
  session.dispatch('code');
  await session.ops.idle();
  assert.equal(session.pane, 'unit');
  assert.equal(session.composeKind, 'file');
});

test('files pane lists paths without a tasks row', async () => {
  const { session } = await openSession([sampleItem('a.js')], {
    startPane: 'files',
  });
  assert.equal(session.fileCursor, 0);
  assert.equal(session.fileList()[0].path, 'a.js');
  assert.equal(
    session.fileList().some((entry) => entry.kind === 'tasks'),
    false,
  );
  session.dispatch('add');
  assert.equal(session.status, 'staged');
});

test('reload picks up disk changes and keeps the current hunk', async () => {
  const a = sampleItem('a.js');
  const b = sampleItem('b.js');
  const c = sampleItem('c.js');
  const { session, repo } = await openSession([a, b]);
  session.dispatch('next');
  await session.ops.idle();
  assert.equal(session.current().file.newPath, 'b.js');
  session.notes.setBlockTask('b.js:1', { text: 'keep me' });
  repo.load = () => ({ top: '/tmp', items: [a, b, c] });
  session.dispatch('reload');
  await session.ops.idle();
  assert.equal(session.status, 'reloaded');
  assert.equal(session.pane, 'diff');
  assert.equal(session.current().file.newPath, 'b.js');
  assert.equal(session.items.length, 3);
  assert.equal(session.notes.blockTask('b.js:1').text, 'keep me');
});

test('reload brings back dismissed hunks', async () => {
  const a = sampleItem('a.js');
  const b = sampleItem('b.js');
  const { session } = await openSession([a, b], { startPane: 'files' });
  session.dismissed.add('unstaged:a.js:1:1:0');
  session.items = session.items.filter((item) => item.file.newPath !== 'a.js');
  session.index = 0;
  assert.equal(session.current().file.newPath, 'b.js');
  session.dispatch('reload');
  await session.ops.idle();
  assert.equal(session.status, 'reloaded');
  assert.equal(session.dismissed.size, 0);
  assert.equal(session.items.length, 2);
  assert.equal(session.current().file.newPath, 'b.js');
});

test('reload from the file list still refreshes', async () => {
  const a = sampleItem('a.js');
  const b = sampleItem('b.js');
  const { session, repo } = await openSession([a], { startPane: 'files' });
  repo.load = () => ({ top: '/tmp', items: [a, b] });
  session.dispatch('reload');
  await session.ops.idle();
  assert.equal(session.status, 'reloaded');
  assert.equal(session.pane, 'files');
  assert.equal(session.items.length, 2);
});

test('compose r inserts a letter and does not reload', async () => {
  const a = sampleItem('a.js');
  const { session, repo } = await openSession([a]);
  let loads = 0;
  const orig = repo.load;
  repo.load = (...args) => {
    loads += 1;
    return orig(...args);
  };
  session.dispatch('blockTask');
  press(session, 'r');
  assert.equal(session.mode, 'compose');
  assert.equal(session.editor.text, 'r');
  assert.equal(loads, 0);
});

test('files pane add on a staged file still moves down', async () => {
  const item = sampleItem('a.js', 'staged');
  const next = sampleItem('b.js');
  const { session, repo } = await openSession([item, next], {
    startPane: 'files',
  });
  session.dispatch('add');
  assert.equal(session.status, 'already staged');
  assert.equal(repo.added.length, 0);
  assert.equal(session.fileCursor, 1);
  assert.equal(session.fileList()[1].path, 'b.js');
});

test('files pane unstage on an unstaged file still moves down', async () => {
  const { session, repo } = await openSession(
    [sampleItem('a.js'), sampleItem('b.js')],
    { startPane: 'files' },
  );
  session.dispatch('unstage');
  assert.equal(session.status, 'not staged');
  assert.equal(repo.unstageCalls.length, 0);
  assert.equal(session.fileCursor, 1);
  assert.equal(session.fileList()[1].path, 'b.js');
});

test('ctrl+t adds a task on a diff and insert an npm command', async () => {
  const diff = await openSession([sampleItem('a.js')]);
  press(diff.session, 'ctrl-t');
  assert.equal(diff.session.composeKind, 'blockTask');
  const npm = await openSession([sampleItem('a.js')], { startPane: 'files' });
  fs.writeFileSync(
    path.join(npm.cwd, 'package.json'),
    `${JSON.stringify({ scripts: { test: 'node --test' } })}\n`,
  );
  npm.session.pushInput('r');
  press(npm.session, 'insert');
  assert.equal(npm.session.composeKind, 'npm');
  assert.equal(npm.session.npm.editField, 'name');
});

test('f writes feedback as a task where the block is', async () => {
  const item = sampleItem('a.js');
  const { session } = await openSession([item]);
  session.dispatch('blockTask');
  assert.equal(session.mode, 'compose');
  assert.equal(session.composeKind, 'blockTask');
  session.pushInput('extract helper');
  press(session, 'ctrl-s');
  assert.equal(session.mode, 'review');
  const note = session.notes.blockTask('a.js:1');
  assert.equal(note.text, 'extract helper');
  const [task] = session.notes.tasks;
  assert.equal(task.kind, 'improvements');
  assert.equal(task.text, 'extract helper\n- where: a.js:1');
  assert.equal(session.view().counts.feedback, 0);
  assert.equal(session.view().counts.tasks, 1);
  assert.equal(session.composer.idleNoteText(), 'task: [ ] extract helper');
});
