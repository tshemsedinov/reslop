'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');

const { Session } = require('../lib/session/session.js');
const { OpsRunner } = require('../lib/session/ops.js');
const { Dashboard } = require('../lib/session/dashboard.js');
const { hitAction } = require('../lib/input/keys.js');
const helpers = require('./helpers.js');
const { uiSink, sampleHunk, tempDir, press, click, rightClick } = helpers;
const review = require('../lib/review/review.js');
const { ReviewStore, serializeReview } = review;
const { parseReview } = review;
const ansi = require('../lib/term/ansi.js');
const { stripAnsi, THEME, BOLD, seq, bg, fg } = ansi;
const { logViewRows } = require('../lib/render/log.js');
const { setTheme, themeName } = ansi;
const { REVIEW_DIR } = require('../lib/common/files.js');
const { TABLE_KEY } = require('../lib/runs/output.js');
const { showFile } = require('../lib/session/unit.js');

// The checkbox rows of the tasks screen, without headings and text
const taskRows = (session) =>
  session.composer.tasks.taskTexts().filter((text) => /^\[[ xX]\] /.test(text));

// The row of the tasks screen whose label includes a text
const rowOf = (session, text) =>
  session.composer.tasks.taskTexts().findIndex((label) => label.includes(text));

// The row of the nth checkbox on the tasks screen
const taskAt = (session, n) => {
  const labels = session.composer.tasks.taskTexts();
  const rows = labels.map((label, at) => (/^\[[ xX]\] /.test(label) ? at : -1));
  return rows.filter((at) => at >= 0)[n] ?? -1;
};

// The label of the focused row of the tasks screen
const focusedRow = (session) =>
  session.composer.tasks.taskTexts()[session.tasksFocus];

// Focus on a row of the tasks screen; the block in the editor is written
// back first, as moving the focus does
const focusTask = (session, at) => {
  session.composer.tasks.closeEditor();
  session.tasksFocus = at;
};

// The editor of the focused block, with the cursor at a text in it
const cursorAt = (session, text) => {
  session.composer.tasks.settle();
  const at = session.editor.text.indexOf(text);
  assert.ok(at >= 0, text);
  session.editor.place(at);
  return session.editor;
};

// Writes the edited task back and edits it again, as a move away and back
const saveTask = (session) => {
  session.composer.tasks.closeEditor();
  session.composer.tasks.settle();
};

// Page Down until a row has the focus, as many times as the list needs
const pageTo = (session, label) => {
  for (let at = 0; at < 10 && focusedRow(session) !== label; at++) {
    press(session, 'pageDown');
  }
};

// Types tasks one below another on the tasks screen; the focus stays on
// the last one, out of the editor until the next key
const typeTasks = (session, ...texts) => {
  session.dispatch('tasks');
  texts.forEach((text, at) => {
    if (at) press(session, 'insert');
    session.pushInput(text);
  });
  session.composer.tasks.closeEditor();
};
const clipboard = require('../lib/term/clipboard.js');

const { dateStamp } = require('../lib/common/utilities.js');
const { setImmediate: settle } = require('node:timers/promises');

const today = () => dateStamp(new Date());

const sampleItem = (name, origin = 'unstaged') => ({
  origin,
  file: {
    oldPath: name,
    newPath: name,
    isNew: false,
    isDeleted: false,
    isBinary: false,
    preamble: [`diff --git a/${name} b/${name}`],
    hunks: [],
  },
  hunk: sampleHunk([
    { type: 'del', text: 'a', noNl: false, blockId: 0 },
    { type: 'add', text: 'b', noNl: false, blockId: 0 },
  ]),
  blockId: 0,
  patchAdd: 'add',
  patchRevert: 'rev',
});

const tallItem = (name, count) => {
  const item = sampleItem(name);
  const lines = [];
  for (let i = 0; i < count; i++) {
    lines.push({ type: 'add', text: `line${i}`, noNl: false, blockId: 0 });
  }
  const hunk = { ...item.hunk, lines, oldCount: 0, newCount: count };
  return { ...item, hunk };
};

const hunkPair = (name) => {
  const file = {
    oldPath: name,
    newPath: name,
    isNew: false,
    isDeleted: false,
    isBinary: false,
    preamble: [`diff --git a/${name} b/${name}`],
    hunks: [],
  };
  const hunk = {
    oldStart: 1,
    oldCount: 3,
    newStart: 1,
    newCount: 3,
    header: '@@ -1,3 +1,3 @@',
    lines: [
      { type: 'del', text: 'a', noNl: false, blockId: 0 },
      { type: 'add', text: 'A', noNl: false, blockId: 0 },
      { type: 'ctx', text: 'mid', noNl: false, blockId: null },
      { type: 'del', text: 'c', noNl: false, blockId: 1 },
      { type: 'add', text: 'C', noNl: false, blockId: 1 },
    ],
  };
  const first = {
    origin: 'unstaged',
    file,
    hunk,
    blockId: 0,
    patchAdd: 'add0',
    patchRevert: 'rev0',
  };
  const second = {
    origin: 'unstaged',
    file,
    hunk,
    blockId: 1,
    patchAdd: 'add1',
    patchRevert: 'rev1',
  };
  return [first, second];
};

const mockRepo = (initial, top) => {
  let items = [...initial];
  const added = [];
  const reverted = [];
  const unstageCalls = [];
  const commits = [];
  const commitDrops = [];
  const applyFixups = [];
  const updates = [];
  const rewords = [];
  const pulls = [];
  const pushes = [];
  const checkouts = [];
  const created = [];
  const rebases = [];
  const drops = [];
  const edited = [];
  const listed = [];
  const writes = [];
  const stagedPaths = [];
  const fileBodies = Object.create(null);
  const extraFiles = [];
  let commitList = [
    {
      sha: 'aaa1111aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      shortSha: 'aaa1111',
      author: 'Ada',
      date: '2 hours ago',
      subject: 'land the change',
    },
    {
      sha: 'bbb2222bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      shortSha: 'bbb2222',
      author: 'Bob',
      date: 'yesterday',
      subject: 'init',
    },
  ];
  return {
    added,
    reverted,
    unstageCalls,
    commits,
    pulls,
    pushes,
    checkouts,
    created,
    rebases,
    drops,
    edited,
    listed,
    writes,
    stagedPaths,
    fileBodies,
    extraFiles,
    commitDrops,
    applyFixups,
    updates,
    rewords,
    load: () => ({ top, items: [...items], branch: 'main' }),
    add: (top, item) => {
      added.push(item);
      items = items.filter((entry) => entry !== item);
    },
    unstage: (top, item) => {
      unstageCalls.push(item);
      items = items.filter((entry) => entry !== item);
    },
    revert: (top, item) => {
      reverted.push(item);
      items = items.filter((entry) => entry !== item);
    },
    revertFile: (top, rel, group) => {
      const targets = group && group.length ? group : [];
      for (const item of targets) {
        reverted.push(item);
        items = items.filter((entry) => entry !== item);
      }
    },
    commit: (top, kind, message) => {
      commits.push({ top, kind, message });
    },
    lastMessage: () => 'previous message',
    listBranches: () => {
      listed.push(true);
      return [
        { name: 'main', current: true },
        { name: 'feat', current: false },
      ];
    },
    checkout: (top, name) => checkouts.push(name),
    createBranch: (top, name) => created.push(name),
    rebase: (top, onto) => rebases.push(onto),
    drop: (top, name) => drops.push(name),
    listCommits: () =>
      commitList.map((entry, index) => ({ ...entry, head: index === 0 })),
    dropCommit: (top, sha) => {
      commitDrops.push(sha);
      commitList = commitList.filter((entry) => entry.sha !== sha);
    },
    applyFixup: (top, sha) => {
      applyFixups.push(sha);
      commitList = commitList.filter((entry) => entry.sha !== sha);
    },
    updateCommit: (top, sha) => {
      updates.push(sha);
    },
    commitMessage: (top, sha) => {
      const entry = commitList.find((item) => item.sha === sha);
      if (entry && entry.subject) return entry.subject;
      return 'previous message';
    },
    reword: (top, sha, message, options = {}) => {
      rewords.push(
        options.now ? { sha, message, now: true } : { sha, message },
      );
      commitList = commitList.map((entry) => {
        if (entry.sha !== sha) return entry;
        const subject = `${message}`.split('\n')[0];
        return { ...entry, subject };
      });
    },
    setCommits: (next) => {
      commitList = next;
    },
    pull: () => pulls.push(true),
    push: () => pushes.push(true),
    edit: (top, item, text) => {
      edited.push({ top, item, text });
    },
    listFiles: () => {
      const names = new Set(extraFiles);
      for (const item of items) names.add(item.file.newPath);
      return [...names].sort();
    },
    fileText: (top, rel) => {
      if (Object.hasOwn(fileBodies, rel)) return fileBodies[rel];
      return 'b\n';
    },
    writeFile: (top, rel, text) => {
      fileBodies[rel] = text;
      writes.push({ top, rel, text });
    },
    stagePath: (top, rel) => {
      stagedPaths.push(rel);
    },
  };
};

const openSession = async (items, extra = {}) => {
  const stdout = extra.stdout ?? uiSink();
  const cwd = extra.cwd ?? tempDir('reslop-ui-');
  const repo = extra.repo ?? mockRepo(items, cwd);
  const session = new Session({
    color: false,
    startPane: 'diff',
    ...extra,
    cwd,
    stdout,
    repo,
  });
  // The worktree tiles and npm outdated would start git and npm
  session.worktrees.refreshTrees = async () => {};
  session.dashboard.tasks.npm.request = () => {};
  session.dashboard.runNpm = async () => {};
  await session.load();
  return { session, repo, stdout, cwd };
};

const clickStatusChoice = (session, id) => {
  session.draw();
  const hit = session.lastFrame.statusHits.find((entry) => entry.id === id);
  assert.ok(hit);
  click(session, hit.x0 + 1, hit.y);
};

const clickFooter = (session, id) => {
  session.draw();
  const hit = session.lastFrame.buttons.find((entry) => entry.id === id);
  assert.ok(hit);
  const y = session.lastFrame.height;
  click(session, hit.x0 + 1, y);
};

const dragBetween = (session, start, end) => {
  const base = { type: 'mouse', btn: 0 };
  session.handleEvent({ ...base, kind: 'press', button: 0, ...start });
  session.handleEvent({ ...base, kind: 'drag', button: 32, ...end });
  session.handleEvent({ ...base, kind: 'release', button: 0, ...end });
};

const listCell = (session, cursor, last = false) => {
  session.draw();
  const hits = session.lastFrame.fileHits.filter(
    (hit) => !hit.tree && hit.cursor === cursor,
  );
  const hit = last ? hits.at(-1) : hits[0];
  assert.ok(hit);
  return { x: 5, y: hit.y };
};

const modifiedClick = (session, cell, button) => {
  const event = { type: 'mouse', button, btn: 0, ...cell };
  session.handleEvent({ ...event, kind: 'press' });
  session.draw();
  session.handleEvent({ ...event, kind: 'release' });
};

const shiftClick = (session, cell) => modifiedClick(session, cell, 4);

const ctrlClick = (session, cell) => modifiedClick(session, cell, 16);

const ctrlShiftClick = (session, cell) => modifiedClick(session, cell, 20);

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

test('AC28 unstage drops index keeps worktree', async () => {
  const staged = sampleItem('a.js', 'staged');
  const other = sampleItem('b.js');
  const { session, repo } = await openSession([staged, other]);
  session.dispatch('unstage');
  await session.ops.idle();
  assert.equal(repo.unstageCalls.length, 1);
  assert.equal(session.status, 'unstaged');
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
  session.dispatch('feedback');
  session.pushInput('prefer const');
  press(session, 'ctrl-s');
  const note = session.notes.feedback.get('lib/a.js:1:1:0');
  assert.equal(note.text, 'prefer const');
  assert.equal(session.view().counts.pr, 1);
  assert.equal(session.view().counts.feedback, 1);
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
  session.dispatch('feedback');
  session.pushInput('keep this');
  press(session, 'ctrl-s');
  const note = session.notes.feedback.get('a.js:1:1:0');
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
  session.pushInput('d');
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
  assert.ok(stdout.dump().includes(']52;c;'));
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
  session.dispatch('feedback');
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
  session.dispatch('feedback');
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
  session.dispatch('feedback');
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
  session.notes.feedback.set('b.js:1:1:0', {
    file: 'b.js',
    oldStart: 1,
    newStart: 1,
    blockId: 0,
    text: 'keep me',
  });
  repo.load = () => ({ top: '/tmp', items: [a, b, c] });
  session.dispatch('reload');
  await session.ops.idle();
  assert.equal(session.status, 'reloaded');
  assert.equal(session.pane, 'diff');
  assert.equal(session.current().file.newPath, 'b.js');
  assert.equal(session.items.length, 3);
  assert.equal(session.notes.feedback.get('b.js:1:1:0').text, 'keep me');
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
  session.dispatch('feedback');
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

test('q quotes a diff and insert adds an npm command', async () => {
  const diff = await openSession([sampleItem('a.js')]);
  press(diff.session, 'q');
  assert.equal(diff.session.composeKind, 'feedback');
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

test('f maps feedback to the hunk location', async () => {
  const item = sampleItem('a.js');
  const { session } = await openSession([item]);
  session.dispatch('feedback');
  assert.equal(session.mode, 'compose');
  assert.equal(session.composeKind, 'feedback');
  session.pushInput('extract helper');
  press(session, 'ctrl-s');
  assert.equal(session.mode, 'review');
  const note = session.notes.feedback.get('a.js:1:1:0');
  assert.equal(note.text, 'extract helper');
  assert.equal(note.file, 'a.js');
  assert.equal(note.newStart, 1);
  assert.equal(session.view().counts.feedback, 1);
  assert.equal(session.view().counts.tasks, 0);
  assert.equal(session.composer.idleNoteText(), '[ ] extract helper');
});

test('compose arrows move by visual wrap rows', async () => {
  const stdout = uiSink();
  stdout.columns = 10;
  const { session } = await openSession([sampleItem('a.js')], { stdout });
  session.dispatch('feedback');
  session.pushInput('hello world');
  press(session, 'up');
  assert.equal(session.editor.cursor, 5);
  press(session, 'down');
  assert.equal(session.editor.cursor, 11);
});

test('compose cursor uses the terminal blinking cursor', async () => {
  const item = sampleItem('a.js');
  const { session, stdout } = await openSession([item]);
  session.dispatch('feedback');
  session.draw();
  const on = stdout.dump();
  assert.ok(on.includes('[1 q'));
  assert.ok(on.includes('[?12h'));
  assert.ok(on.includes('[?25h'));
  session.draw();
  assert.equal(stdout.dump(), on);
});

test('enter and escape save feedback and return to browse', async () => {
  const item = sampleItem('a.js');
  const { session } = await openSession([item]);
  session.dispatch('feedback');
  session.pushInput('note');
  press(session, 'enter');
  assert.equal(session.mode, 'review');
  assert.equal(session.done, false);
  const key = 'a.js:1:1:0';
  assert.equal(session.notes.feedback.get(key).text, 'note');
  session.dispatch('feedback');
  session.pushInput(' two');
  press(session, 'escape');
  assert.equal(session.mode, 'review');
  assert.equal(session.done, false);
  assert.equal(session.notes.feedback.get(key).text, 'note two');
  assert.equal(session.status, 'saved');
});

test('editing feedback keeps one latest version', async () => {
  const item = sampleItem('a.js');
  const { session } = await openSession([item]);
  session.dispatch('feedback');
  session.pushInput('first');
  press(session, 'ctrl-s');
  session.dispatch('feedback');
  session.pushInput(' more');
  session.autosave();
  press(session, 'ctrl-s');
  const key = 'a.js:1:1:0';
  assert.equal(session.notes.feedback.size, 1);
  assert.equal(session.notes.feedback.get(key).text, 'first more');
  session.dispatch('feedback');
  assert.equal(session.editor.text, 'first more');
  const view = session.view();
  assert.equal(view.compose.text, 'first more');
  assert.ok(!view.compose.text.includes('\n1 '));
});

test('feedback templates count reuse on another hunk, not a save', async () => {
  const a = sampleItem('a.js');
  const b = sampleItem('b.js');
  const { session } = await openSession([a, b]);
  session.dispatch('feedback');
  session.pushInput('extract helper');
  press(session, 'ctrl-s');
  session.dispatch('feedback');
  press(session, 'ctrl-s');
  assert.equal(session.notes.templates.length, 1);
  assert.equal(session.notes.templates[0].count, 1);
  session.dispatch('next');
  session.dispatch('feedback');
  session.pushInput('extract helper');
  press(session, 'ctrl-s');
  assert.equal(session.notes.templates.length, 1);
  assert.equal(session.notes.templates[0].text, 'extract helper');
  assert.equal(session.notes.templates[0].count, 2);
});

test('feedback templates pick with tab arrows enter and click', async () => {
  const { session } = await openSession([
    sampleItem('a.js'),
    sampleItem('b.js'),
  ]);
  session.notes.templates = [
    { text: 'extract helper', count: 2 },
    { text: 'add tests', count: 1 },
  ];
  const feedKey = 'a.js:1:1:0';
  session.dispatch('feedback');
  assert.equal(session.mode, 'compose');
  session.draw();
  const body = stripAnsi(session.lastFrame.rows.join('\n'));
  assert.match(body, /extract helper/);
  assert.match(body, /add tests/);
  press(session, 'tab');
  assert.equal(session.mode, 'review');
  assert.equal(session.notes.feedback.get(feedKey).text, 'extract helper');
  session.dispatch('feedback');
  session.editor.replace('');
  press(session, 'down');
  assert.equal(session.mode, 'compose');
  assert.equal(session.templateFocus, true);
  assert.equal(session.templateIndex, 0);
  press(session, 'enter');
  assert.equal(session.mode, 'review');
  assert.equal(session.notes.feedback.get(feedKey).text, 'extract helper');
  session.dispatch('feedback');
  session.editor.replace('');
  session.draw();
  const hit = session.lastFrame.templateHits.find((row) => row.cursor === 1);
  assert.ok(hit);
  click(session, 2, hit.y);
  assert.equal(session.mode, 'review');
  assert.equal(session.notes.feedback.get(feedKey).text, 'add tests');
});

test('feedback templates filter by prefix and hide if none match', async () => {
  const { session } = await openSession([sampleItem('a.js')]);
  session.notes.templates = [
    { text: 'extract helper', count: 2 },
    { text: 'add tests', count: 1 },
  ];
  session.dispatch('feedback');
  session.draw();
  let body = stripAnsi(session.lastFrame.rows.join('\n'));
  assert.match(body, /extract helper/);
  assert.match(body, /add tests/);
  session.pushInput('ex');
  session.draw();
  body = stripAnsi(session.lastFrame.rows.join('\n'));
  assert.match(body, /extract helper/);
  assert.ok(!body.includes('add tests'));
  assert.equal(session.lastFrame.templateHits.length, 1);
  press(session, 'tab');
  assert.equal(session.mode, 'review');
  assert.equal(session.notes.feedback.get('a.js:1:1:0').text, 'extract helper');
  session.dispatch('feedback');
  session.draw();
  body = stripAnsi(session.lastFrame.rows.join('\n'));
  assert.match(body, /extract helper/);
  assert.ok(!body.includes('add tests'));
  assert.equal(session.lastFrame.templateHits.length, 0);
  session.editor.replace('');
  session.pushInput('z');
  session.draw();
  body = stripAnsi(session.lastFrame.rows.join('\n'));
  assert.ok(!body.includes('extract helper'));
  assert.ok(!body.includes('add tests'));
  assert.equal(session.lastFrame.templateHits.length, 0);
  press(session, 'tab');
  assert.equal(session.editor.text, 'z');
  press(session, 'backspace');
  session.draw();
  body = stripAnsi(session.lastFrame.rows.join('\n'));
  assert.match(body, /extract helper/);
  assert.match(body, /add tests/);
});

test('e edits added lines in the reviewed file', async () => {
  const item = sampleItem('a.js');
  const { session, repo } = await openSession([item]);
  session.pushInput('e');
  assert.equal(session.mode, 'compose');
  assert.equal(session.composeKind, 'code');
  assert.equal(session.editor.text, 'b');
  assert.equal(session.view().compose, null);
  session.draw();
  const body = stripAnsi(session.lastFrame.rows.join('\n'));
  assert.match(body, /\+ b/);
  assert.ok(session.lastFrame.cursor);
  assert.equal(session.lastFrame.cursor.x, 4);
  session.pushInput('2');
  press(session, 'enter');
  assert.equal(session.mode, 'compose');
  assert.equal(session.editor.text, 'b2\n');
  press(session, 'escape');
  await session.ops.idle();
  assert.equal(session.mode, 'review');
  assert.equal(session.notes.code.size, 0);
  assert.equal(session.view().counts.code, 0);
  assert.equal(repo.edited.length, 1);
  assert.equal(repo.edited[0].text, 'b2\n');
  assert.equal(repo.edited[0].item.file.newPath, 'a.js');
  assert.deepEqual(repo.stagedPaths, ['a.js']);
});

test('e on a read-only commit keeps a code proposal', async () => {
  const item = sampleItem('a.js', 'commit');
  const { session, repo } = await openSession([item], { rev: 'abc1234' });
  session.pushInput('e');
  session.pushInput('2');
  press(session, 'escape');
  assert.equal(repo.edited.length, 0);
  const note = session.notes.code.get('a.js:1:1:0');
  assert.equal(note.text, 'b2');
  assert.equal(session.view().counts.code, 1);
});

test('code save equal to original drops the proposal', async () => {
  const item = sampleItem('a.js');
  const { session, repo } = await openSession([item]);
  session.dispatch('code');
  press(session, 'escape');
  assert.equal(session.notes.code.size, 0);
  assert.equal(session.view().counts.code, 0);
  assert.equal(repo.stagedPaths.length, 0);
});

test('todos screen ignores commit and todo hotkeys', async () => {
  const { session } = await openSession([sampleItem('a.js')]);
  session.dispatch('tasks');
  assert.equal(session.tasksOpen, true);
  assert.equal(session.composeKind, 'tasks');
  session.dispatch('commit');
  assert.equal(session.composeKind, 'tasks');
  session.dispatch('tasks');
  assert.equal(session.composeKind, 'tasks');
});

test('right click opens task operations with their hotkeys', async () => {
  const { session } = await openSession([sampleItem('a.js')]);
  session.notes.addTask('a.js', 'context target');
  session.composer.tasks.openTasksPage();
  session.draw();
  const at = rowOf(session, 'context target');
  const hit = session.lastFrame.taskHits.find(
    (entry) => entry.cursor === at && !entry.check,
  );
  rightClick(session, 10, hit.y);
  assert.equal(session.tasksFocus, at);
  assert.deepEqual(session.nav.contextMenu.actions, [
    'taskNew',
    'taskDone',
    'taskPriority',
    'taskField',
    'taskOpen',
    'taskDrop',
  ]);
  const shown = session.lastFrame.contextHits.map((entry) =>
    stripAnsi(session.lastFrame.rows[entry.y - 1]),
  );
  assert.ok(shown.some((row) => row.includes('ins  new task below')));
  assert.ok(shown.some((row) => row.includes('^d   done')));
  assert.ok(shown.some((row) => row.includes('^l   priority…')));
  assert.ok(shown.some((row) => row.includes('^r   delete')));
  press(session, 'ctrl-l', 'h');
  assert.equal(focusedRow(session), '[ ] high: context target');
  focusTask(session, rowOf(session, 'Feature requests'));
  session.draw();
  const head = session.lastFrame.taskHits.find(
    (entry) => entry.cursor === session.tasksFocus,
  );
  rightClick(session, 10, head.y);
  assert.deepEqual(session.nav.contextMenu.actions, [
    'taskNew',
    'blockMenu',
    'taskExpand',
    'taskDrop',
  ]);
  press(session, 'tab');
  assert.equal(session.nav.contextMenu, null);
  assert.equal(rowOf(session, 'context target'), -1);
});

test('blank branch space offers screen commands', async () => {
  const { session } = await openSession([sampleItem('a.js')]);
  session.pane = 'files';
  session.draw();
  rightClick(session, 20, session.lastFrame.height - 3);
  assert.equal(session.nav.contextMenu, null);
  session.pane = 'branches';
  session.gitBranches.branches = [{ name: 'main', current: true }];
  session.draw();
  rightClick(session, 20, session.lastFrame.height - 3);
  assert.deepEqual(session.nav.contextMenu.actions, [
    'newBranch',
    'worktreeBranch',
    'pull',
    'push',
  ]);
  assert.equal(session.nav.contextMenu.actions.includes('back'), false);
  press(session, 'insert');
  assert.equal(session.composeKind, 'branch');
});

test('dashboard and combo boxes suppress context menus', async () => {
  const { session } = await openSession([sampleItem('a.js')]);
  session.pane = 'dashboard';
  session.draw();
  rightClick(session, 10, 3);
  assert.equal(session.nav.contextMenu, null);
  session.pane = 'agents';
  session.draw();
  session.lastFrame.fileHits = [];
  rightClick(session, 10, session.lastFrame.height - 3);
  assert.equal(session.nav.contextMenu, null);
  session.lastFrame.fileHits = [
    { y: 3, x0: 0, x1: 20, cursor: 0, field: 'effort' },
  ];
  rightClick(session, 10, 3);
  assert.equal(session.nav.contextMenu, null);
  session.lastFrame.fileHits = [
    { y: 3, x0: 0, x1: 20, cursor: 0, field: 'name' },
  ];
  rightClick(session, 10, 3);
  const actions = session.nav.contextMenu.actions;
  for (const id of [
    'agentEffort',
    'agentModel',
    'agentContext',
    'agentReview',
  ]) {
    assert.equal(actions.includes(id), false);
  }
});

test('context menus track hover and refuse disabled actions', async () => {
  const { session, repo } = await openSession([sampleItem('a.js')]);
  session.pane = 'branches';
  session.gitBranches.branches = [{ name: 'main', current: true }];
  session.draw();
  const row = session.lastFrame.fileHits[0];
  rightClick(session, 10, row.y);
  assert.ok(session.nav.contextMenu.disabled.includes('drop'));
  const drop = session.lastFrame.contextHits.find((hit) => hit.id === 'drop');
  assert.equal(drop.disabled, true);
  press(session, 'delete');
  assert.equal(session.mode, 'review');
  assert.ok(session.nav.contextMenu);
  click(session, drop.x0 + 2, drop.y);
  assert.ok(session.nav.contextMenu);
  const pull = session.lastFrame.contextHits.find((hit) => hit.id === 'pull');
  session.pushInput(`\x1b[<35;${pull.x0 + 2};${pull.y}M`);
  assert.equal(session.nav.contextMenu.cursor, pull.cursor);
  assert.equal(repo.drops.length, 0);
  press(session, 'escape');
  assert.equal(session.nav.contextMenu, null);
});

test('editor context commands preserve and edit selected text', async () => {
  const { session, stdout } = await openSession([sampleItem('a.js')]);
  session.dispatch('tasks');
  session.pushInput('keep this text');
  const editor = session.editor;
  editor.anchor = 5;
  editor.cursor = 9;
  session.draw();
  const hit = session.lastFrame.editHits.find((entry) => entry.live);
  rightClick(session, hit.textX, hit.y);
  assert.deepEqual(session.nav.contextMenu.actions, [
    'textCut',
    'textCopy',
    'textPaste',
    'textDelete',
    'textSelectAll',
  ]);
  press(session, 'ctrl-c');
  assert.ok(stdout.dump().includes(Buffer.from('this').toString('base64')));
  assert.equal(editor.selectedText(), 'this');
  rightClick(session, hit.textX, hit.y);
  press(session, 'delete');
  assert.equal(editor.text, 'keep  text');
  assert.equal(session.mode, 'compose');
  session.draw();
  rightClick(session, hit.textX, hit.y);
  press(session, 'ctrl-a');
  assert.equal(editor.selectedText(), 'keep  text');
  rightClick(session, hit.textX, hit.y);
  press(session, 'ctrl-x');
  assert.equal(editor.text, '');
});

test('import textbox context paste keeps the textbox focused', async (t) => {
  const { session } = await openSession([sampleItem('a.js')]);
  session.composer.tasks.openTasksPage();
  session.dispatch('taskImport');
  session.draw();
  const statusY = session.lastFrame.height - 1;
  t.mock.method(clipboard, 'pasteText', () => 'https://example.com/a\n');
  rightClick(session, 10, statusY);
  const paste = session.lastFrame.contextHits.find(
    (hit) => hit.id === 'textPaste',
  );
  click(session, paste.x0 + 2, paste.y);
  assert.equal(session.mode, 'import');
  assert.equal(session.nav.import.url, 'https://example.com/a');
  assert.equal(session.nav.contextMenu, null);
});

test('todo list scrolls the focused row into view', async () => {
  const { session, stdout } = await openSession([sampleItem('a.js')]);
  stdout.rows = 12;
  for (let i = 0; i < 30; i++) session.notes.addTask('a.js', `item ${i}`);
  session.composer.tasks.openTasksPage();
  focusTask(session, rowOf(session, 'item 0'));
  session.draw();
  const top = stripAnsi(session.lastFrame.rows.join('\n'));
  assert.match(top, /item 0(?!\d)/);
  assert.ok(!/item 29(?!\d)/.test(top));
  assert.equal(session.scroll, 0);
  for (let i = 0; i < 25; i++) session.dispatch('scrollDown');
  session.draw();
  const down = stripAnsi(session.lastFrame.rows.join('\n'));
  assert.match(down, /item 25(?!\d)/);
  assert.ok(!/item 0(?!\d)/.test(down));
  assert.ok(session.scroll > 0);
  session.handleEvent({
    type: 'mouse',
    kind: 'wheelUp',
    button: 64,
    x: 2,
    y: 4,
    press: true,
  });
  session.draw();
  const up = stripAnsi(session.lastFrame.rows.join('\n'));
  assert.equal(focusedRow(session), '[ ] item 24');
  assert.match(up, /item 24(?!\d)/);
  session.dispatch('pageDown');
  session.draw();
  const paged = stripAnsi(session.lastFrame.rows.join('\n'));
  assert.equal(focusedRow(session), '[ ] item 29');
  assert.match(paged, /item 29/);
  assert.ok(!/item 0(?!\d)/.test(paged));
});

test('scrolling to the top shows the first header and blank line', async () => {
  const { session, stdout } = await openSession([sampleItem('a.js')]);
  stdout.rows = 12;
  for (let i = 0; i < 30; i++) session.notes.addTask('a.js', `item ${i}`);
  session.composer.tasks.openTasksPage();
  focusTask(session, 0);
  for (let i = 0; i < 25; i++) session.dispatch('scrollDown');
  session.draw();
  assert.ok(session.scroll > 0);
  session.dispatch('home');
  session.draw();
  assert.equal(session.tasksFocus, 0);
  assert.equal(session.scroll, 0);
  const rows = session.lastFrame.rows.map((row) => stripAnsi(row));
  assert.equal(rows[1].trim(), '');
  assert.match(rows[2], /Agent instructions/);
  assert.match(rows[3], /Work through unchecked items/);
});

test('tasks list ends with a blank line after the blocks', async () => {
  const { session, stdout } = await openSession([sampleItem('a.js')]);
  stdout.rows = 12;
  for (let i = 0; i < 30; i++) session.notes.addTask('a.js', `item ${i}`);
  session.composer.tasks.openTasksPage();
  session.draw();
  const statusAt = session.lastFrame.rows.length - 2;
  const plain = () => session.lastFrame.rows.map((row) => stripAnsi(row));
  assert.ok(session.lastFrame.scrollMax > 0);
  assert.notEqual(plain()[statusAt - 1].trim(), '');
  session.dispatch('end');
  session.draw();
  assert.equal(session.scroll, session.lastFrame.scrollMax);
  const endRows = plain();
  assert.equal(endRows[statusAt - 1].trim(), '');
  assert.notEqual(endRows[statusAt - 2].trim(), '');
  session.dispatch('home');
  session.draw();
  assert.equal(session.scroll, 0);
  assert.notEqual(plain()[statusAt - 1].trim(), '');
});

test('a short tasks list does not scroll for a trailing blank', async () => {
  const { session, stdout } = await openSession([sampleItem('a.js')]);
  stdout.rows = 40;
  session.composer.tasks.openTasksPage();
  session.draw();
  assert.equal(session.lastFrame.scrollMax, 0);
});

test('ctrl+up and ctrl+down reorder tasks and stay inside a file', async () => {
  const { session, stdout } = await openSession([sampleItem('a.js')]);
  stdout.columns = 140;
  session.dispatch('tasks');
  session.pushInput('first');
  press(session, 'insert');
  session.pushInput('second');
  focusTask(session, rowOf(session, 'first'));
  press(session, 'ctrl-down');
  assert.deepEqual(
    session.notes.tasks.map((task) => task.text),
    ['second', 'first'],
  );
  press(session, 'ctrl-down');
  const moved = session.notes.tasks.find((task) => task.text === 'first');
  assert.equal(moved.kind, 'features');
  session.notes.setFeedback('a.js:1:1:0', {
    file: 'a.js',
    oldStart: 1,
    newStart: 1,
    blockId: 0,
    text: 'quote one',
  });
  session.notes.setFeedback('a.js:2:2:0', {
    file: 'a.js',
    oldStart: 2,
    newStart: 2,
    blockId: 0,
    text: 'quote two',
  });
  for (const task of session.notes.tasks) session.notes.removeTask(task.id);
  session.notes.addTask('TODOs', 'only', false, 'security');
  const rows = session.composer.tasks.rows();
  const security = rows.findIndex(
    (row) => row.task && row.task.text === 'only',
  );
  focusTask(session, security);
  press(session, 'ctrl-down');
  assert.equal(session.notes.tasks[0].kind, 'security');
  const quote = session.composer.tasks
    .rows()
    .findIndex((row) => row.quote && row.note.text === 'quote one');
  focusTask(session, quote);
  press(session, 'ctrl-down');
  const quoted = [];
  for (const note of session.notes.feedback.values()) quoted.push(note.text);
  assert.deepEqual(quoted, ['quote two', 'quote one']);
  press(session, 'ctrl-up', 'ctrl-up');
  const stayed = [];
  for (const note of session.notes.feedback.values()) stayed.push(note.text);
  assert.deepEqual(stayed, ['quote one', 'quote two']);
  assert.equal(session.notes.tasks[0].kind, 'security');
  session.draw();
  const body = stripAnsi(session.lastFrame.rows.join('\n'));
  assert.match(body, /a\.js/);
  assert.match(body, /quote one/);
  assert.match(body, /ctrl\+up\/dn/);
  assert.equal(body.includes('ctrl+down'), false);
});

test('quoted feedback can be edited from the tasks screen', async () => {
  const { session } = await openSession([sampleItem('a.js')]);
  session.notes.setFeedback('a.js:1:1:0', {
    file: 'a.js',
    oldStart: 1,
    newStart: 1,
    blockId: 0,
    text: 'quote',
  });
  session.composer.tasks.openTasksPage();
  const quote = session.composer.tasks.rows().findIndex((row) => row.quote);
  focusTask(session, quote);
  session.pushInput(' more');
  press(session, 'ctrl-d');
  const note = session.notes.feedback.get('a.js:1:1:0');
  assert.equal(note.text, 'quote more');
  assert.equal(note.done, true);
});

test('tasks status switches plan files, defaults to the last', async () => {
  const { session, cwd } = await openSession([sampleItem('a.js')]);
  const dir = path.join(cwd, REVIEW_DIR);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, '2020-01-01-00.md'),
    [
      '---',
      'status: editing',
      '---',
      '',
      '## Feature requests',
      '',
      '- [ ] from older',
      '',
    ].join('\n'),
  );
  session.dispatch('tasks');
  session.draw();
  const status = stripAnsi(session.lastFrame.rows.at(-2));
  const current = session.composer.tasks.planName();
  const names = session.composer.tasks.planNames();
  assert.equal(names.at(-1), current);
  assert.ok(names.includes('2020-01-01-00.md'));
  assert.ok(status.includes(current));
  assert.equal(status.includes('▾'), false);
  assert.match(status, /open \d+ · done \d+\/\d+\s*$/);
  const ratios = status.match(/\d+\/\d+/g);
  assert.deepEqual(ratios, [status.match(/done (\d+\/\d+)/)[1]]);
  session.composer.tasks.togglePlanMenu();
  session.draw();
  const menu = stripAnsi(session.lastFrame.rows.join('\n'));
  assert.match(menu, /2020-01-01-00\.md\s+editing/);
  const hit = session.lastFrame.statusHits.find(
    (entry) => entry.id === 'plan-item' && entry.cursor === 0,
  );
  assert.ok(hit);
  click(session, hit.x0 + 1, hit.y);
  assert.equal(session.composer.tasks.planOpen, false);
  assert.match(session.composer.tasks.planName(), /2020-01-01-00\.md/);
  assert.equal(session.notes.tasks[0].text, 'from older');
});

test('tasks plan combo filters in place and keeps the agent menu', async () => {
  const { session, cwd } = await openSession([sampleItem('a.js')], {
    color: true,
  });
  const dir = path.join(cwd, REVIEW_DIR);
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < 12; i++) {
    const name = `note-${String(i).padStart(2, '0')}.md`;
    fs.writeFileSync(path.join(dir, name), `# ${name}\n`);
  }
  fs.writeFileSync(path.join(dir, 'beta-plan.md'), '# beta\n');
  fs.writeFileSync(path.join(dir, 'main-plan.md'), '# main\n');
  session.dispatch('tasks');
  press(session, 'ctrl-p');
  session.draw();
  const menuRows = () =>
    session.lastFrame.rows.filter(
      (row) =>
        row.includes(bg(THEME.noteBg)) || row.includes(bg(THEME.checkBg)),
    );
  const open = menuRows();
  assert.ok(open.length > 1);
  assert.ok(open.some((row) => row.includes(bg(THEME.checkBg))));
  assert.ok(open.some((row) => row.includes(bg(THEME.noteBg))));
  const opened = stripAnsi(session.lastFrame.rows.join('\n'));
  assert.match(opened, /note-11\.md/);
  assert.match(opened, /<new plan>/);
  assert.equal(opened.includes('beta-plan'), false);
  const current = session.composer.tasks.planName();
  const selected = open.find((row) => row.includes(bg(THEME.checkBg)));
  assert.ok(stripAnsi(selected).includes(current));
  press(session, 'home');
  session.draw();
  const top = stripAnsi(session.lastFrame.rows.join('\n'));
  assert.match(top, /beta-plan\.md/);
  assert.equal(top.includes('note-11'), false);
  press(session, 'm');
  session.draw();
  const status = stripAnsi(session.lastFrame.rows.at(-2));
  const afterBranch = status.slice(status.indexOf('main') + 'main'.length);
  assert.match(afterBranch, /^ {2}\^plan file: m/);
  const hit = session.lastFrame.statusHits.find(
    (entry) => entry.id === 'plan-item',
  );
  assert.ok(hit);
  assert.ok(hit.x0 >= status.indexOf('main') + 'main'.length);
  const statusRow = session.lastFrame.rows.at(-2);
  const typedMark = seq(THEME.warnFg, THEME.chromeBg);
  assert.ok(statusRow.includes(`${typedMark}m`));
  assert.equal(statusRow.includes(bg(THEME.searchBg)), false);
  press(session, 'backspace', 'b', 'e');
  session.draw();
  const shown = stripAnsi(session.lastFrame.rows.join('\n'));
  assert.match(shown, /beta-plan\.md/);
  assert.equal(shown.includes('note-00'), false);
  assert.equal(shown.includes('main-plan'), false);
  const lines = shown.split('\n').map((line) => line.trim());
  assert.equal(lines.includes('be'), false);
  const beta = session.lastFrame.rows.find((row) =>
    stripAnsi(row).includes('beta-plan.md'),
  );
  assert.ok(beta.includes(seq(THEME.warnFg, THEME.checkBg)));
  assert.equal(beta.includes(bg(THEME.searchBg)), false);
  press(session, 'enter');
  assert.equal(session.composer.tasks.planName(), 'beta-plan.md');
});

test('tasks plan hotkey opens the combo and can start a new plan', async () => {
  const opened = await openSession([sampleItem('a.js')], { color: true });
  const { session } = opened;
  opened.stdout.columns = 120;
  session.dispatch('tasks');
  session.draw();
  const footer = stripAnsi(session.lastFrame.rows.at(-1));
  assert.match(
    footer,
    /🢐esc {2}insert {2}\^remove {2}tab {2}\^block {2}\^done {2}\^level/,
  );
  assert.doesNotMatch(footer, /space|files/);
  assert.match(footer, /ctrl\+up\/dn/);
  const nudge = `${BOLD}${seq(THEME.buttonHotFg, THEME.buttonBg)}up/dn`;
  assert.ok(session.lastFrame.rows.at(-1).includes(nudge));
  const priority = `${BOLD}${seq(THEME.buttonHotFg, THEME.buttonBg)}t`;
  assert.ok(session.lastFrame.rows.at(-1).includes(priority));
  const closed = session.lastFrame.rows.at(-2);
  const name = session.composer.tasks.planName();
  const mark = `${BOLD}${seq(THEME.shaFg, THEME.chromeBg)}${name}`;
  const key = `${BOLD}${seq(THEME.buttonHotFg, THEME.chromeBg)}^p`;
  assert.ok(closed.includes(key));
  assert.match(stripAnsi(closed), / {2}\^plan file: /);
  assert.ok(closed.includes(mark));
  assert.equal(closed.includes('▾'), false);
  const hits = session.lastFrame.statusHits;
  const place = hits.find((entry) => entry.id === 'plan');
  assert.ok(place);
  const row = stripAnsi(closed);
  assert.equal(row.slice(place.x0, place.x0 + 12), '^plan file: ');
  click(session, place.x0 + 1, place.y);
  assert.equal(session.composer.tasks.planOpen, true);
  press(session, 'escape', 'ctrl-p');
  assert.equal(session.composer.tasks.planOpen, true);
  session.draw();
  const menu = stripAnsi(session.lastFrame.rows.join('\n'));
  assert.match(menu, /<new plan>/);
  press(session, 'end', 'enter');
  assert.equal(session.composer.tasks.planOpen, false);
  const created = session.composer.tasks.planName();
  assert.match(created, new RegExp(`^${today()}-\\d+\\.md$`));
  assert.notEqual(created, name);
});

test('import url closes when focus leaves the field', async () => {
  const { session } = await openSession([sampleItem('a.js')]);
  const begin = () => {
    session.dispatch('tasks');
    press(session, 'ctrl-i');
    session.pushInput('https://example.com');
    session.draw();
  };
  const closed = () => {
    assert.equal(session.view().import, null);
    assert.notEqual(session.mode, 'import');
    session.draw();
    const status = stripAnsi(session.lastFrame.rows.at(-2));
    assert.equal(status.startsWith(' url '), false);
  };
  begin();
  click(session, 4, session.lastFrame.height - 1);
  assert.equal(session.mode, 'import');
  assert.match(session.view().import.url, /example\.com/);
  const task = session.lastFrame.taskHits.find((hit) => hit.y);
  assert.ok(task);
  click(session, 2, task.y);
  closed();
  begin();
  press(session, 'ctrl-down');
  closed();
  begin();
  clickFooter(session, 'back');
  assert.notEqual(session.pane, 'tasks');
  closed();
});

test('tasks import asks for a url and applies the pull request', async () => {
  const { session } = await openSession([sampleItem('a.js')], {
    loadPullRequest: async () => ({
      imported: {
        feedback: [],
        tasks: [
          {
            file: 'pull request',
            text: '@bob review at github: add tests',
            done: false,
          },
        ],
      },
    }),
  });
  session.dispatch('tasks');
  press(session, 'ctrl-i');
  assert.equal(session.mode, 'import');
  session.draw();
  const asking = stripAnsi(session.lastFrame.rows.at(-2));
  assert.match(asking, /^ url /);
  session.pushInput('notaurl');
  press(session, 'enter');
  assert.notEqual(session.mode, 'import');
  assert.equal(session.status, 'bad url');
  press(session, 'ctrl-i');
  session.pushInput('https://github.com/acme/demo/pull/7');
  session.draw();
  const typed = stripAnsi(session.lastFrame.rows.at(-2));
  assert.match(typed, /github\.com\/acme\/demo\/pull\/7/);
  press(session, 'enter');
  await session.importPromise;
  assert.equal(session.status, 'imported');
  assert.equal(session.notes.tasks.length, 1);
  assert.match(session.notes.tasks[0].text, /add tests/);
});

test('an empty import url stays focused after backspace', async () => {
  const { session } = await openSession([sampleItem('a.js')]);
  session.dispatch('tasks');
  press(session, 'ctrl-i');
  session.pushInput('x');
  press(session, 'backspace');
  assert.equal(session.nav.import.url, '');
  press(session, 'backspace');
  assert.equal(session.mode, 'import');
  assert.equal(session.nav.import.url, '');
});

test('tasks import prefills an editable repository url', async () => {
  const item = sampleItem('a.js');
  const cwd = tempDir('reslop-ui-');
  const repo = mockRepo([item], cwd);
  const load = repo.load;
  repo.load = () => ({
    ...load(),
    repositoryUrl: 'https://github.com/acme/demo',
  });
  const { session } = await openSession([item], { cwd, repo });
  session.dispatch('tasks');
  press(session, 'ctrl-i');
  assert.equal(session.nav.import.url, 'https://github.com/acme/demo');
  session.pushInput('/issues/4');
  assert.equal(session.nav.import.url, 'https://github.com/acme/demo/issues/4');
});

test('tasks import accepts a github or gitlab issue url', async () => {
  const { session } = await openSession([sampleItem('a.js')], {
    loadGithubIssue: async () => ({
      imported: {
        feedback: [],
        tasks: [
          {
            file: 'issue',
            text: '@alice review at github: add the flag',
            done: false,
          },
        ],
      },
    }),
    loadGitlabIssue: async () => ({
      imported: {
        feedback: [],
        tasks: [
          {
            file: 'issue',
            text: '@bob review at gitlab: from gitlab',
            done: false,
          },
        ],
      },
    }),
  });
  session.dispatch('tasks');
  press(session, 'ctrl-i');
  session.pushInput('https://github.com/acme/demo/issues/4');
  press(session, 'enter');
  await session.importPromise;
  assert.equal(session.status, 'imported');
  assert.match(session.notes.tasks[0].text, /add the flag/);
  press(session, 'ctrl-i');
  session.pushInput('https://gitlab.com/acme/demo/-/issues/8');
  press(session, 'enter');
  await session.importPromise;
  assert.equal(session.notes.tasks.length, 2);
  assert.match(session.notes.tasks[1].text, /from gitlab/);
});

test('tasks import accepts a github or gitlab issue list', async () => {
  let githubTarget = null;
  let gitlabTarget = null;
  const { session } = await openSession([sampleItem('a.js')], {
    loadGithubIssue: async (issue) => {
      githubTarget = issue;
      return {
        imported: {
          feedback: [],
          tasks: [
            {
              file: 'issue',
              text: '@ScriptHound at github: line numbers',
              done: false,
            },
          ],
        },
      };
    },
    loadGitlabIssue: async (issue) => {
      gitlabTarget = issue;
      return {
        imported: {
          feedback: [],
          tasks: [
            {
              file: 'issue',
              text: '@bob at gitlab: from the list',
              done: false,
            },
          ],
        },
      };
    },
  });
  session.dispatch('tasks');
  press(session, 'ctrl-i');
  session.pushInput('https://github.com/tshemsedinov/reslop/issues');
  press(session, 'enter');
  await session.importPromise;
  assert.equal(session.status, 'imported');
  assert.deepEqual(githubTarget, {
    owner: 'tshemsedinov',
    repo: 'reslop',
    list: true,
  });
  assert.match(session.notes.tasks[0].text, /@ScriptHound at github:/);
  press(session, 'ctrl-i');
  session.pushInput('https://gitlab.com/acme/demo');
  press(session, 'enter');
  await session.importPromise;
  assert.equal(gitlabTarget.project, 'acme/demo');
  assert.equal(gitlabTarget.list, true);
  assert.match(session.notes.tasks[1].text, /@bob at gitlab:/);
});

test('todo edits in the list not the note line', async () => {
  const { session, stdout } = await openSession([sampleItem('a.js')]);
  stdout.rows = 24;
  session.dispatch('tasks');
  session.pushInput('in the list');
  session.draw();
  const body = stripAnsi(session.lastFrame.rows.join('\n'));
  assert.match(body, /\[ \] in the list/);
  assert.doesNotMatch(body, /Bug Reports and Fixes/);
  assert.doesNotMatch(body, /Security/);
  assert.equal(body.split('in the list').length - 1, 1);
  assert.equal(session.view().compose, null);
  assert.ok(session.view().taskEdit);
  const focus = session.tasksFocus;
  const hit = session.lastFrame.taskHits.find((row) => row.cursor === focus);
  assert.ok(hit);
  assert.equal(session.lastFrame.cursor.y, hit.y);
});

test('t from any file adds a repo todo and starts editing', async () => {
  const { session } = await openSession(
    [sampleItem('a.js'), sampleItem('b.js')],
    {
      startPane: 'files',
    },
  );
  session.dispatch('scrollDown');
  assert.equal(session.fileCursor, 1);
  session.dispatch('tasks');
  assert.equal(session.pane, 'tasks');
  assert.equal(session.current().origin, 'task');
  assert.equal(session.current().file.newPath, 'TODOs');
  assert.equal(session.mode, 'compose');
  assert.equal(session.composeKind, 'tasks');
  assert.equal(focusedRow(session), '[ ] ');
  assert.deepEqual(taskRows(session), ['[ ] ']);
  press(session, 'escape');
  session.dispatch('files');
  session.fileCursor = 0;
  session.dispatch('tasks');
  assert.equal(session.current().file.newPath, 'TODOs');
  assert.equal(session.mode, 'compose');
  assert.equal(session.editor.text, '');
});

test('t opens the repo todo page and lets you edit it', async () => {
  const a = sampleItem('a.js');
  const b = sampleItem('b.js');
  const { session } = await openSession([a, b]);
  const files = session.fileList();
  assert.equal(files[0].path, 'a.js');
  assert.equal(
    files.some((entry) => entry.kind === 'tasks'),
    false,
  );
  session.dispatch('tasks');
  assert.equal(session.pane, 'tasks');
  assert.equal(session.current().origin, 'task');
  assert.equal(session.current().file.newPath, 'TODOs');
  assert.equal(session.mode, 'compose');
  assert.equal(session.items[0].origin, 'unstaged');
  session.pushInput('rewrite loop');
  press(session, 'insert');
  assert.equal(session.items[0].file.newPath, 'a.js');
  assert.equal(session.items[1].file.newPath, 'b.js');
  assert.equal(session.current().origin, 'task');
  assert.deepEqual(taskRows(session), ['[ ] rewrite loop', '[ ] ']);
  assert.equal(session.view().total, 2);
  assert.equal(session.view().counts.tasks, 1);
  assert.equal(session.view().counts.feedback, 0);
  assert.equal(session.mode, 'compose');
  assert.equal(session.editor.text, '');
  assert.equal(session.composer.idleNoteText(), '');
  session.pushInput('add tests');
  press(session, 'up');
  assert.equal(session.editor.text, 'rewrite loop');
  assert.deepEqual(taskRows(session), ['[ ] rewrite loop', '[ ] add tests']);
  assert.equal(focusedRow(session), '[ ] rewrite loop');
  press(session, 'escape');
  assert.equal(session.pane, 'files');
  assert.equal(session.current().file.newPath, 'a.js');
});

test('an empty plan has a new task to type into', async () => {
  const { session } = await openSession([sampleItem('a.js')]);
  session.composer.tasks.openTasksPage();
  assert.deepEqual(session.composer.tasks.taskTexts(), ['Agent instructions']);
  session.pushInput('write tests');
  assert.equal(session.mode, 'compose');
  assert.equal(session.composeTaskId, null);
  press(session, 'insert');
  assert.deepEqual(session.composer.tasks.taskTexts(), [
    'Agent instructions',
    'Feature requests and Enhancements',
    '[ ] write tests',
    '[ ] ',
  ]);
  press(session, 'backspace');
  assert.equal(focusedRow(session), '[ ] write tests');
  assert.equal(session.editor.text, 'write tests');
});

test('the agent instructions open on focus to read and edit', async () => {
  const { session } = await openSession([sampleItem('a.js')]);
  session.composer.tasks.openTasksPage();
  session.draw();
  const plain = () => session.lastFrame.rows.map((row) => stripAnsi(row));
  const open = () =>
    session.composer.tasks
      .taskTexts()
      .some((row) => row.includes('Read the fields'));
  assert.equal(open(), false);
  press(session, 'up');
  session.draw();
  assert.equal(open(), true);
  assert.match(focusedRow(session), /^- A task with a quoted/);
  assert.equal(session.mode, 'compose');
  session.dispatch('home');
  assert.equal(focusedRow(session), 'Agent instructions');
  assert.equal(session.mode, 'review');
  press(session, 'down');
  assert.match(focusedRow(session), /^Work through unchecked/);
  assert.equal(session.mode, 'compose');
  session.pushInput(' Ask first.');
  press(session, 'up');
  const text = fs.readFileSync(session.notes.reviewPath, 'utf8');
  assert.match(text, /^Work through unchecked items\. Ask first\.$/m);
  press(session, 'tab');
  session.draw();
  assert.equal(open(), false);
  const peek = plain().filter((row) => row.includes('Work through unchecked'));
  assert.deepEqual(
    peek.map((row) => row.trim()),
    ['Work through unchecked items. Ask first.'],
  );
});

test('a click on a task edits it at once', async () => {
  const { session } = await openSession([sampleItem('a.js')]);
  session.dispatch('tasks');
  session.pushInput('first note');
  press(session, 'insert');
  session.pushInput('second note');
  press(session, 'up');
  const first = rowOf(session, 'first note');
  const second = rowOf(session, 'second note');
  assert.equal(session.tasksFocus, first);
  assert.equal(session.editor.text, 'first note');
  session.draw();
  const other = session.lastFrame.taskHits.find((row) => row.cursor === second);
  assert.ok(other);
  click(session, 8, other.y);
  assert.equal(session.tasksFocus, second);
  assert.equal(session.mode, 'compose');
  assert.equal(session.editor.text, 'second note');
});

test('alt+enter adds lines and escape saves and leaves', async () => {
  const { session } = await openSession([sampleItem('a.js')]);
  session.dispatch('tasks');
  session.pushInput('first\x1b\rsecond');
  assert.equal(session.mode, 'compose');
  assert.equal(session.tasksFocus, taskAt(session, 0));
  assert.equal(session.editor.text, 'first\nsecond');
  press(session, 'insert');
  session.pushInput('another');
  press(session, 'up');
  const ids = session.notes.tasks.map((task) => task.id);
  assert.equal(session.tasksFocus, taskAt(session, 0));
  const editor = session.editor;
  editor.place(2);
  session.pushInput('\x1b\rA\x1b\rB');
  assert.equal(session.editor, editor);
  assert.equal(session.editor.text, 'fi\nA\nBrst\nsecond');
  assert.equal(session.tasksFocus, taskAt(session, 0));
  assert.equal(session.composeTaskId, ids[0]);
  press(session, 'escape');
  assert.equal(session.mode, 'review');
  assert.notEqual(session.pane, 'tasks');
  assert.equal(session.editor, null);
  assert.deepEqual(
    session.notes.tasks.map((task) => task.id),
    ids,
  );
  const saved = fs.readFileSync(session.notes.reviewPath, 'utf8');
  assert.deepEqual(
    parseReview(saved).tasks.map((task) => task.text),
    ['fi\nA\nBrst\nsecond', 'another'],
  );
});

for (const sequence of [
  '\x1b[13;2u',
  '\x1b[13;5u',
  '\x1b[13;6u',
  '\x1b[27;2;13~',
  '\x1b[27;5;13~',
  '\x1b[27;6;13~',
]) {
  test(`fragmented ${JSON.stringify(sequence)} stays in the task`, async () => {
    const { session } = await openSession([sampleItem('a.js')]);
    session.dispatch('tasks');
    session.pushInput('beforeafter');
    saveTask(session);
    const editor = session.editor;
    editor.place(6);
    for (const byte of sequence) {
      session.pushInput(byte);
      assert.equal(session.mode, 'compose');
      assert.equal(session.editor, editor);
    }
    assert.equal(editor.text, 'before\nafter');
    saveTask(session);
    assert.equal(session.notes.tasks.length, 1);
    assert.equal(session.notes.tasks[0].text, 'before\nafter');
  });
}

test('a standalone Escape still saves and leaves the task editor', async () => {
  const { session } = await openSession([sampleItem('a.js')]);
  session.dispatch('tasks');
  session.pushInput('task text\x1b');
  assert.equal(session.mode, 'compose');
  await new Promise((resolve) => {
    setTimeout(resolve, 100);
  });
  assert.equal(session.mode, 'review');
  assert.equal(session.notes.tasks[0].text, 'task text');
  assert.equal(session.term.carry, '');
});

test('one standalone Escape ends the read loop on the file list', async (t) => {
  const stdin = new EventEmitter();
  const { session } = await openSession([sampleItem('a.js')], {
    startPane: 'files',
    stdin,
  });
  const ended = session.readLoop();
  t.after(() => session.finishInput());
  stdin.emit('data', Buffer.from('\x1b'));
  assert.equal(session.term.timers.get('input-escape').hasRef(), true);
  await ended;
  assert.equal(session.done, true);
  assert.equal(session.finishReadLoop, null);
  assert.equal(stdin.listenerCount('data'), 0);
  assert.equal(session.term.timers.size, 0);
});

for (const [name, shift, ctrl] of [
  ['kitty', '\x1b[13;2u', '\x1b[13;5u'],
  ['xterm', '\x1b[27;2;13~', '\x1b[27;5;13~'],
  ['line feed', '\n', '\n'],
]) {
  test(`${name} adds lines inside an existing task`, async () => {
    const { session } = await openSession([sampleItem('a.js')]);
    session.dispatch('tasks');
    session.pushInput('alphaomega');
    saveTask(session);
    const id = session.notes.tasks[0].id;
    const editor = session.editor;
    editor.place(5);
    session.pushInput(`${shift}middle`);
    session.autosave();
    assert.equal(session.editor, editor);
    assert.equal(session.mode, 'compose');
    assert.equal(session.notes.tasks.length, 1);
    assert.equal(session.notes.tasks[0].id, id);
    session.pushInput(`${ctrl}tail`);
    assert.equal(session.editor, editor);
    assert.equal(session.tasksFocus, taskAt(session, 0));
    saveTask(session);
    assert.equal(session.notes.tasks.length, 1);
    assert.equal(session.notes.tasks[0].text, 'alpha\nmiddle\ntailomega');
    const saved = fs.readFileSync(session.notes.reviewPath, 'utf8');
    assert.equal(parseReview(saved).tasks[0].text, 'alpha\nmiddle\ntailomega');
  });
}

test('todo list stays on screen while composing', async () => {
  const { session } = await openSession([sampleItem('a.js')]);
  session.dispatch('tasks');
  session.pushInput('first note');
  saveTask(session);
  session.composer.tasks.newTask();
  session.pushInput('draft two');
  assert.equal(session.mode, 'compose');
  session.draw();
  const body = stripAnsi(session.lastFrame.rows.join('\n'));
  assert.match(body, /\[ \] first note/);
  const first = rowOf(session, 'first note');
  const hit = session.lastFrame.taskHits.find((row) => row.cursor === first);
  assert.ok(hit);
  click(session, 8, hit.y);
  click(session, 8, hit.y);
  assert.equal(session.mode, 'compose');
  assert.equal(session.editor.text, 'first note');
  assert.equal(session.notes.tasks.length, 2);
  assert.equal(session.notes.tasks[1].text, 'draft two');
});

test('ctrl+r removes a task and backspace an emptied one', async () => {
  const { session } = await openSession([sampleItem('a.js')]);
  session.dispatch('tasks');
  session.pushInput('first note');
  press(session, 'insert');
  session.pushInput('second note');
  press(session, 'ctrl-r');
  assert.deepEqual(taskRows(session), ['[ ] first note']);
  assert.equal(session.tasksFocus, taskAt(session, 0));
  assert.equal(session.editor.text, 'first note');
  assert.equal(session.current().origin, 'task');
  press(session, 'ctrl-a', 'backspace');
  assert.deepEqual(taskRows(session), ['[ ] ']);
  press(session, 'backspace');
  assert.deepEqual(taskRows(session), []);
  assert.equal(focusedRow(session), 'Feature requests and Enhancements');
  assert.equal(session.editor.text, 'Feature requests and Enhancements');
  assert.equal(session.current().origin, 'task');
});

test('empty autosave does not persist a draft todo', async () => {
  const { session } = await openSession([sampleItem('a.js')]);
  session.dispatch('tasks');
  assert.equal(session.composeTaskId, null);
  session.autosave();
  assert.equal(session.notes.tasks.length, 0);
  session.pushInput('keep this');
  press(session, 'enter');
  assert.equal(session.composeTaskId, null);
  session.autosave();
  assert.deepEqual(
    session.notes.tasks.map((task) => task.text),
    ['keep this'],
  );
  assert.equal(session.current().origin, 'task');
});

test('todo autosave updates one draft instead of duplicating', async () => {
  const { session } = await openSession([sampleItem('a.js')]);
  session.dispatch('tasks');
  session.pushInput('keep this');
  session.autosave();
  assert.equal(session.notes.tasks.length, 1);
  assert.equal(session.composeTaskId, session.notes.tasks[0].id);
  session.autosave();
  assert.equal(session.notes.tasks.length, 1);
  session.pushInput(' more');
  session.autosave();
  assert.equal(session.notes.tasks.length, 1);
  assert.equal(session.notes.tasks[0].text, 'keep this more');
  press(session, 'escape');
  assert.equal(session.mode, 'review');
  assert.equal(session.editor, null);
  assert.deepEqual(
    session.notes.tasks.map((task) => task.text),
    ['keep this more'],
  );
});

test('up edits the task above from the end of its text', async () => {
  const { session } = await openSession([sampleItem('a.js')]);
  session.dispatch('tasks');
  session.pushInput('first');
  press(session, 'insert', 'up');
  assert.equal(session.tasksFocus, taskAt(session, 0));
  session.pushInput('+more');
  assert.equal(session.mode, 'compose');
  assert.equal(session.editor.text, 'first+more');
  assert.equal(session.editor.cursor, 'first+more'.length);
});

test('page keys jump the tasks list', async () => {
  const { session } = await openSession([sampleItem('a.js')]);
  typeTasks(session, 'one', 'two', 'three');
  press(session, 'pageUp');
  assert.equal(session.tasksFocus, 0);
  assert.equal(focusedRow(session), 'Agent instructions');
  press(session, 'pageDown');
  assert.ok(session.tasksFocus > 0);
  pageTo(session, '[ ] three');
  assert.equal(focusedRow(session), '[ ] three');
  assert.equal(session.editor.text, 'three');
});

test('todo edit arrows move across todos without leaving edit', async () => {
  const { session } = await openSession([sampleItem('a.js')]);
  typeTasks(session, 'first', 'second');
  press(session, 'up');
  assert.equal(session.mode, 'compose');
  assert.equal(session.tasksFocus, taskAt(session, 0));
  assert.equal(session.editor.text, 'first');
  assert.equal(session.editor.cursor, 'first'.length);
  press(session, 'up');
  assert.equal(session.mode, 'compose');
  assert.equal(focusedRow(session), 'Feature requests and Enhancements');
  assert.equal(session.editor.text, 'Feature requests and Enhancements');
  press(session, 'down');
  assert.equal(session.tasksFocus, taskAt(session, 0));
  press(session, 'down');
  assert.equal(session.mode, 'compose');
  assert.equal(session.tasksFocus, taskAt(session, 1));
  assert.equal(session.editor.text, 'second');
  press(session, 'down');
  assert.equal(session.mode, 'compose');
  assert.equal(session.tasksFocus, taskAt(session, 1));
  assert.equal(session.editor.text, 'second');
  assert.deepEqual(taskRows(session), ['[ ] first', '[ ] second']);
});

test('todo edit arrows move inside a multiline todo', async () => {
  const { session } = await openSession([sampleItem('a.js')]);
  typeTasks(session, 'first', 'second');
  session.notes.setTaskText(session.notes.tasks[1].id, 'one\ntwo\nthree');
  session.composer.tasks.settle();
  assert.equal(session.mode, 'compose');
  assert.equal(session.editor.linePos().line, 0);
  press(session, 'down', 'down');
  assert.equal(session.tasksFocus, taskAt(session, 1));
  assert.equal(session.editor.linePos().line, 2);
  press(session, 'down');
  assert.equal(session.tasksFocus, taskAt(session, 1));
  assert.equal(session.editor.linePos().line, 2);
  press(session, 'up', 'up', 'up');
  assert.equal(session.tasksFocus, taskAt(session, 0));
  assert.equal(session.editor.text, 'first');
  press(session, 'down');
  assert.equal(session.tasksFocus, taskAt(session, 1));
  assert.equal(session.editor.text, 'one\ntwo\nthree');
  assert.equal(session.editor.linePos().line, 0);
});

test('todo edit arrows move across wrapped lines', async () => {
  const { session } = await openSession([sampleItem('a.js')]);
  typeTasks(session, 'first', 'second');
  const long = 'x'.repeat(90);
  session.notes.setTaskText(session.notes.tasks[1].id, long);
  press(session, 'up');
  assert.equal(session.tasksFocus, taskAt(session, 1));
  assert.ok(session.editor.cursor < long.length);
  press(session, 'down');
  assert.equal(session.tasksFocus, taskAt(session, 1));
  assert.equal(session.editor.cursor, long.length);
  press(session, 'up', 'up');
  assert.equal(session.tasksFocus, taskAt(session, 0));
});

test('todo edit page keys jump across todos', async () => {
  const { session } = await openSession([sampleItem('a.js')]);
  typeTasks(session, 'first', 'second', 'third');
  press(session, 'pageUp');
  assert.equal(focusedRow(session), 'Agent instructions');
  pageTo(session, '[ ] third');
  assert.equal(session.tasksFocus, taskAt(session, 2));
  assert.equal(session.editor.text, 'third');
});

test('enter breaks the line, insert starts a task below', async () => {
  const { session } = await openSession([sampleItem('a.js')]);
  session.dispatch('tasks');
  assert.deepEqual(taskRows(session), ['[ ] ']);
  session.pushInput('first');
  press(session, 'insert');
  assert.equal(session.editor.text, '');
  assert.deepEqual(taskRows(session), ['[ ] first', '[ ] ']);
  assert.equal(session.tasksFocus, taskAt(session, 1));
  session.pushInput('second');
  press(session, 'up', 'home', 'right', 'right', 'enter');
  assert.equal(session.editor.text, 'fi\nrst');
  press(session, 'end', 'enter');
  session.pushInput('- where: lib/a.js');
  press(session, 'down');
  assert.equal(session.notes.tasks[0].text, 'fi\nrst\n- where: lib/a.js');
  assert.equal(session.notes.tasks[0].item.value('where'), 'lib/a.js');
  assert.deepEqual(
    session.notes.tasks.map((task) => task.item.title),
    ['fi', 'second'],
  );
});

test('todo save recovers if the stub was dropped', async () => {
  const { session } = await openSession([sampleItem('a.js')]);
  session.dispatch('tasks');
  for (const task of session.notes.tasks) session.notes.removeTask(task.id);
  session.pushInput('still here');
  press(session, 'insert');
  assert.equal(session.notes.tasks.length, 1);
  assert.equal(session.notes.tasks[0].text, 'still here');
  assert.equal(session.current().origin, 'task');
});

test('quit with notes keeps the review status', async () => {
  const item = sampleItem('a.js');
  const { session } = await openSession([item]);
  session.dispatch('feedback');
  session.pushInput('nits');
  press(session, 'ctrl-s');
  session.notes.status = 'partial';
  session.notes.dirty = true;
  session.dispatch('quit');
  assert.equal(session.done, true);
  assert.equal(session.mode, 'review');
  const md = fs.readFileSync(session.notes.reviewPath, 'utf8');
  assert.match(md, /nits/);
  assert.match(md, /status: partial/);
});

test('quit warns before terminating a running test or agent', async () => {
  const { session } = await openSession([sampleItem('a.js')]);
  let testsKilled = false;
  let agentsKilled = false;
  session.npm.runs.push({
    id: 1,
    name: 'test',
    kind: 'script',
    status: 'running',
    stopping: false,
    raw: '',
    output: '',
    startedAt: Date.now(),
    endedAt: 0,
    exit: '',
    child: {
      kill() {
        testsKilled = true;
      },
    },
  });
  session.agents.jobs.push({
    status: 'running',
    child: {
      kill() {
        agentsKilled = true;
      },
    },
  });
  session.notes.status = 'editing';
  session.dispatch('quit');
  assert.equal(session.done, false);
  assert.equal(session.mode, 'confirmQuit');
  session.draw();
  const asking = stripAnsi(session.lastFrame.rows.at(-2));
  assert.match(asking, /exit will terminate tests and agents/);
  assert.match(asking, /y\/n/);
  session.pushInput('n');
  assert.equal(session.done, false);
  assert.equal(session.mode, 'review');
  assert.equal(testsKilled, false);
  session.dispatch('quit');
  clickStatusChoice(session, 'y');
  assert.equal(session.done, true);
  assert.equal(testsKilled, true);
  assert.equal(agentsKilled, true);
  assert.equal(session.notes.status, 'editing');
});

test('initReview resumes latest editing file', async () => {
  const cwd = tempDir('reslop-ui-');
  const name = `${today()}-00.md`;
  const reviewPath = path.join(cwd, REVIEW_DIR, name);
  const draft = new ReviewStore(reviewPath);
  draft.addTask('a.js', 'rewrite loop');
  fs.mkdirSync(path.dirname(reviewPath), { recursive: true });
  fs.writeFileSync(reviewPath, serializeReview(draft), 'utf8');
  const { session } = await openSession([sampleItem('a.js')], { cwd });
  assert.equal(session.notes.reviewPath, reviewPath);
  assert.equal(session.notes.status, 'editing');
  assert.equal(session.notes.tasks[0].text, 'rewrite loop');
  assert.equal(
    session.fileList().some((entry) => entry.kind === 'tasks'),
    false,
  );
});

test('initReview starts a new file when latest is partial', async () => {
  const cwd = tempDir('reslop-ui-');
  const name = `${today()}-00.md`;
  const reviewPath = path.join(cwd, REVIEW_DIR, name);
  const draft = new ReviewStore(reviewPath);
  draft.status = 'partial';
  draft.addTask('a.js', 'rewrite loop');
  fs.mkdirSync(path.dirname(reviewPath), { recursive: true });
  fs.writeFileSync(reviewPath, serializeReview(draft), 'utf8');
  const { session } = await openSession([sampleItem('a.js')], { cwd });
  assert.equal(
    session.notes.reviewPath,
    path.join(cwd, REVIEW_DIR, `${today()}-01.md`),
  );
  assert.equal(session.notes.tasks.length, 0);
});

test('newReview starts a new file even if latest is editing', async () => {
  const cwd = tempDir('reslop-ui-');
  const name = `${today()}-00.md`;
  const reviewPath = path.join(cwd, REVIEW_DIR, name);
  const draft = new ReviewStore(reviewPath);
  draft.addTask('a.js', 'rewrite loop');
  fs.mkdirSync(path.dirname(reviewPath), { recursive: true });
  fs.writeFileSync(reviewPath, serializeReview(draft), 'utf8');
  const { session } = await openSession([sampleItem('a.js')], {
    cwd,
    newReview: true,
  });
  assert.equal(
    session.notes.reviewPath,
    path.join(cwd, REVIEW_DIR, `${today()}-01.md`),
  );
  assert.equal(session.notes.tasks.length, 0);
});

test('files pane c lists commits and c commits the message', async () => {
  const { session, repo } = await openSession([sampleItem('a.js', 'staged')], {
    startPane: 'files',
  });
  session.pushInput('c');
  await session.ops.idle();
  assert.equal(session.pane, 'commits');
  assert.equal(session.mode, 'review');
  assert.equal(session.commitCursor, 0);
  assert.equal(session.view().commits[0].subject, 'uncommitted changes');
  assert.equal(session.view().commits[1].subject, 'land the change');
  press(session, 'escape');
  await session.ops.idle();
  assert.equal(session.pane, 'files');
  assert.equal(repo.commits.length, 0);
  session.pushInput('c');
  await session.ops.idle();
  press(session, 'insert');
  await session.ops.idle();
  assert.equal(session.mode, 'compose');
  assert.equal(session.composeKind, 'commit');
  assert.equal(session.commitKind, 'commit');
  press(session, 'enter');
  await session.ops.idle();
  assert.equal(session.mode, 'compose');
  assert.equal(session.status, 'empty commit message');
  assert.equal(repo.commits.length, 0);
  session.pushInput('land the change');
  await session.ops.idle();
  press(session, 'enter');
  await session.ops.idle();
  assert.equal(session.mode, 'review');
  assert.equal(session.status, 'committed');
  assert.equal(repo.commits.length, 1);
  assert.equal(repo.commits[0].kind, 'commit');
  assert.equal(repo.commits[0].message, 'land the change');
});

test('dashboard p pulls and s pushes', async () => {
  const { session, repo } = await openSession([sampleItem('a.js')], {
    startPane: 'dashboard',
  });
  session.pushInput('p');
  await session.ops.idle();
  assert.equal(repo.pulls.length, 1);
  assert.equal(session.status, 'pulled');
  assert.equal(session.pane, 'dashboard');
  session.pushInput('s');
  await session.ops.idle();
  assert.equal(repo.pushes.length, 1);
  assert.equal(session.status, 'pushed');
});

test('escape from a commit diff returns to the dashboard', async () => {
  const { session } = await openSession([sampleItem('a.js', 'staged')], {
    startPane: 'dashboard',
  });
  session.pushInput('c');
  await session.ops.idle();
  session.dispatch('next');
  await session.ops.idle();
  press(session, 'enter');
  await session.ops.idle();
  assert.equal(session.pane, 'diff');
  assert.equal(session.rev.startsWith('aaa1111'), true);
  press(session, 'escape');
  await session.ops.idle();
  assert.equal(session.pane, 'dashboard');
  assert.equal(session.rev, '');
  assert.equal(session.revShort, '');
});

test('enter on uncommitted changes leaves a viewed commit', async () => {
  const { session } = await openSession([sampleItem('a.js', 'staged')], {
    startPane: 'files',
  });
  const sha = 'aaa1111aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  session.pushInput('c');
  await session.ops.idle();
  session.dispatch('next');
  await session.ops.idle();
  press(session, 'enter');
  await session.ops.idle();
  assert.equal(session.pane, 'diff');
  assert.equal(session.rev, sha);
  press(session, 'escape');
  await session.ops.idle();
  session.pushInput('c');
  await session.ops.idle();
  assert.equal(session.commitCursor, 0);
  press(session, 'enter');
  await session.ops.idle();
  assert.equal(session.rev, '');
  assert.equal(session.revShort, '');
  assert.equal(session.mode, 'review');
  assert.equal(session.pane, 'diff');
  assert.notEqual(session.items[0].origin, 'commit');
});

test('enter on uncommitted changes opens the commit editor', async () => {
  const { session } = await openSession([sampleItem('a.js', 'staged')], {
    startPane: 'files',
  });
  session.pushInput('c');
  press(session, 'enter');
  await session.ops.idle();
  assert.equal(session.pane, 'commits');
  assert.equal(session.mode, 'compose');
  assert.equal(session.commitKind, 'commit');
  assert.equal(session.commitCursor, 0);
});

test('click commit footer chooses commit amend or fixup', async () => {
  const clickKind = async (steps, kind) => {
    const { session } = await openSession([sampleItem('a.js', 'staged')], {
      startPane: 'files',
    });
    session.pushInput('c');
    await session.ops.idle();
    for (let i = 0; i < steps; i++) session.dispatch('next');
    for (let i = 0; i < steps; i++) await session.ops.idle();
    clickFooter(session, 'newCommit');
    await session.ops.idle();
    if (steps === 1) session.handleEvent({ type: 'key', key: 'a' });
    if (steps === 1) await session.ops.idle();
    if (steps === 2) session.handleEvent({ type: 'key', key: 'f' });
    if (steps === 2) await session.ops.idle();
    assert.equal(session.pane, 'commits');
    assert.equal(session.mode, 'compose');
    assert.equal(session.commitKind, kind);
  };
  await clickKind(0, 'commit');
  await clickKind(1, 'amend');
  await clickKind(2, 'fixup');
});

test('commits pane v toggles brief on and off', async () => {
  const { session } = await openSession([sampleItem('a.js')], {
    startPane: 'files',
  });
  session.pushInput('c');
  assert.equal(session.view().commitView, 'brief');
  session.pushInput('v');
  await session.ops.idle();
  assert.equal(session.view().commitView, 'full');
  assert.equal(session.status, 'full');
  session.pushInput('v');
  assert.equal(session.view().commitView, 'brief');
  assert.equal(session.status, 'brief');
});

test('full mode commit enter inserts a newline', async () => {
  const { session, repo } = await openSession([sampleItem('a.js', 'staged')], {
    startPane: 'files',
  });
  session.pushInput('c');
  session.pushInput('v');
  press(session, 'insert');
  session.pushInput('one');
  press(session, 'enter');
  session.pushInput('two');
  await session.ops.idle();
  assert.equal(session.mode, 'compose');
  assert.equal(session.editor.text, 'one\ntwo');
  assert.equal(repo.commits.length, 0);
  press(session, 'up');
  assert.equal(session.editor.cursor, 3);
  assert.equal(session.commitCursor, 0);
});

test('full mode ctrl-s saves the message', async () => {
  const { session, repo } = await openSession([sampleItem('a.js', 'staged')], {
    startPane: 'files',
  });
  session.pushInput('c');
  session.pushInput('v');
  press(session, 'insert');
  session.pushInput('one');
  press(session, 'enter');
  session.pushInput('two');
  press(session, 'ctrl-s');
  await session.ops.idle();
  assert.equal(session.mode, 'review');
  assert.equal(repo.commits.length, 1);
  assert.equal(repo.commits[0].message, 'one\ntwo');
});

test('full mode enter keeps the blank line after the subject', async () => {
  const { session, repo } = await openSession([sampleItem('a.js', 'staged')], {
    startPane: 'files',
  });
  session.pushInput('c');
  session.pushInput('v');
  press(session, 'insert');
  session.pushInput('ship it');
  press(session, 'enter');
  await session.ops.idle();
  assert.equal(session.mode, 'compose');
  assert.equal(session.editor.text, 'ship it\n');
  press(session, 'enter');
  assert.equal(session.mode, 'compose');
  assert.equal(session.editor.text, 'ship it\n\n');
  assert.equal(repo.commits.length, 0);
  session.pushInput('explain');
  press(session, 'enter');
  assert.equal(session.mode, 'compose');
  press(session, 'enter');
  await session.ops.idle();
  assert.equal(session.mode, 'review');
  assert.equal(repo.commits[0].message, 'ship it\n\nexplain');
});

test('full mode enter three times saves a one-line message', async () => {
  const { session, repo } = await openSession([sampleItem('a.js', 'staged')], {
    startPane: 'files',
  });
  session.pushInput('c');
  session.pushInput('v');
  press(session, 'insert');
  session.pushInput('  ship it  ');
  press(session, 'enter', 'enter');
  await session.ops.idle();
  assert.equal(session.mode, 'compose');
  assert.equal(session.editor.text, '  ship it  \n\n');
  press(session, 'enter');
  await session.ops.idle();
  assert.equal(session.mode, 'review');
  assert.equal(repo.commits[0].message, 'ship it');
});

test('saving a commit trims spaces and surrounding newlines', async () => {
  const { session, repo } = await openSession([sampleItem('a.js', 'staged')], {
    startPane: 'files',
  });
  session.pushInput('c');
  session.pushInput('v');
  press(session, 'insert');
  await session.ops.idle();
  session.editor.replace('  ship it  \n \n  explain  \n\n');
  press(session, 'ctrl-s');
  await session.ops.idle();
  assert.equal(session.mode, 'review');
  assert.equal(repo.commits[0].message, 'ship it\n\nexplain');
});

test('editing a commit ignores clicks and scrolls elsewhere', async () => {
  const { session, stdout } = await openSession(
    [sampleItem('a.js', 'staged')],
    {
      startPane: 'files',
    },
  );
  stdout.rows = 32;
  session.pushInput('c');
  session.pushInput('v');
  await session.ops.idle();
  session.dispatch('next');
  session.dispatch('next');
  session.pushInput('e');
  session.pushInput('x');
  await session.ops.idle();
  assert.equal(session.mode, 'compose');
  assert.equal(session.commitCursor, 2);
  assert.equal(session.editor.text, 'initx');
  const cursor = session.editor.cursor;
  session.draw();
  const other = session.lastFrame.fileHits.find((hit) => hit.cursor === 0);
  assert.ok(other);
  click(session, 4, other.y);
  session.handleEvent({
    type: 'mouse',
    kind: 'wheelDown',
    x: 4,
    y: other.y,
  });
  assert.equal(session.commitCursor, 2);
  assert.equal(session.editor.text, 'initx');
  assert.equal(session.editor.cursor, cursor);
  assert.equal(session.mode, 'compose');
});

test('brief reword edits the first line and keeps the body', async () => {
  const { session, repo } = await openSession([sampleItem('a.js', 'staged')], {
    startPane: 'files',
  });
  repo.setCommits([
    {
      sha: 'aaa1111aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      shortSha: 'aaa1111',
      author: 'Ada',
      date: '2 hours ago',
      subject: 'land the change\n\nexplain the change',
    },
  ]);
  session.pushInput('c');
  await session.ops.idle();
  session.dispatch('next');
  await session.ops.idle();
  session.pushInput('e');
  await session.ops.idle();
  assert.equal(session.editor.text, 'land the change');
  assert.equal(session.editor.cursor, 'land the change'.length);
  session.editor.replace('ship it');
  press(session, 'enter');
  await session.ops.idle();
  assert.equal(session.status, 'reworded');
  assert.deepEqual(repo.rewords, [
    {
      sha: 'aaa1111aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      message: 'ship it\n\nexplain the change',
    },
  ]);
});

test('brief amend edits the first line and keeps the body', async () => {
  const { session, repo } = await openSession([sampleItem('a.js')], {
    startPane: 'files',
  });
  repo.lastMessage = () => 'land the change\n\nexplain the change';
  session.pushInput('c');
  await session.ops.idle();
  session.dispatch('next');
  await session.ops.idle();
  press(session, 'insert');
  await session.ops.idle();
  press(session, 'a');
  await session.ops.idle();
  assert.equal(session.editor.text, 'land the change');
  assert.equal(session.editor.cursor, 'land the change'.length);
  session.editor.replace('ship it');
  press(session, 'enter');
  await session.ops.idle();
  assert.equal(session.status, 'amended');
  assert.equal(repo.commits[0].kind, 'amend');
  assert.equal(repo.commits[0].message, 'ship it\n\nexplain the change');
});

test('full mode reword edits the whole message', async () => {
  const { session, repo } = await openSession([sampleItem('a.js', 'staged')], {
    startPane: 'files',
  });
  repo.setCommits([
    {
      sha: 'aaa1111aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      shortSha: 'aaa1111',
      author: 'Ada',
      date: '2 hours ago',
      subject: 'land the change\n\nexplain the change',
    },
  ]);
  session.pushInput('c');
  session.pushInput('v');
  await session.ops.idle();
  session.dispatch('next');
  session.pushInput('e');
  await session.ops.idle();
  assert.equal(session.editor.text, 'land the change\n\nexplain the change');
  session.editor.replace('ship it\n\nnew body');
  press(session, 'ctrl-s');
  await session.ops.idle();
  assert.deepEqual(repo.rewords, [
    {
      sha: 'aaa1111aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      message: 'ship it\n\nnew body',
    },
  ]);
});

test('commits pane a amends with the previous message', async () => {
  const { session, repo } = await openSession([sampleItem('a.js')], {
    startPane: 'files',
  });
  session.pushInput('c');
  await session.ops.idle();
  session.dispatch('next');
  await session.ops.idle();
  press(session, 'insert');
  await session.ops.idle();
  press(session, 'a');
  await session.ops.idle();
  assert.equal(session.commitCursor, 1);
  assert.equal(session.composeKind, 'commit');
  assert.equal(session.commitKind, 'amend');
  assert.equal(session.editor.text, 'previous message');
  press(session, 'enter');
  await session.ops.idle();
  assert.equal(session.status, 'amended');
  assert.equal(repo.commits[0].kind, 'amend');
  assert.equal(repo.commits[0].message, 'previous message');
});

test('commits pane r rewords the selected commit', async () => {
  const { session, repo } = await openSession([sampleItem('a.js')], {
    startPane: 'files',
  });
  session.pushInput('c');
  await session.ops.idle();
  session.dispatch('next');
  await session.ops.idle();
  session.dispatch('next');
  await session.ops.idle();
  session.pushInput('e');
  await session.ops.idle();
  assert.equal(session.commitCursor, 2);
  assert.equal(session.composeKind, 'commit');
  assert.equal(session.commitKind, 'reword');
  assert.equal(session.editor.text, 'init');
  session.editor.replace('rewritten init');
  press(session, 'enter');
  await session.ops.idle();
  assert.equal(session.status, 'reworded');
  assert.deepEqual(repo.rewords, [
    {
      sha: 'bbb2222bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      message: 'rewritten init',
    },
  ]);
  assert.equal(session.view().commits[2].subject, 'rewritten init');
});

test('commits u updates the date without editing', async () => {
  const { session, repo } = await openSession([sampleItem('a.js')], {
    startPane: 'files',
  });
  session.pushInput('c');
  await session.ops.idle();
  session.dispatch('next');
  await session.ops.idle();
  session.dispatch('next');
  await session.ops.idle();
  const calls = [];
  repo.updateCommitTimes = (top, shas) => calls.push(shas);
  press(session, 'ctrl-e');
  assert.equal(session.commitCursor, 2);
  assert.equal(session.mode, 'review');
  press(session, 'u');
  await session.ops.idle();
  assert.equal(session.mode, 'review');
  assert.equal(session.status, 'updated');
  assert.deepEqual(calls, [['bbb2222bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb']]);
  session.pushInput('e');
  await session.ops.idle();
  press(session, 'enter');
  await session.ops.idle();
  assert.equal(repo.rewords[0].now, undefined);
});

test('commit ranges shrink, clear and restrict actions', async () => {
  const { session } = await openSession([sampleItem('a.js')]);
  session.commits.onCommit();
  await session.ops.idle();
  press(session, 'down', 'shift-down');
  assert.deepEqual(session.view().listSelection, [1, 2]);
  session.draw();
  const ids = session.lastFrame.buttons.map((hit) => hit.id);
  for (const id of ['newCommit', 'apply', 'reword']) {
    assert.ok(!ids.includes(id));
  }
  assert.ok(ids.includes('updateTime'));
  for (const key of ['insert', 'p', 'e', 'enter']) press(session, key);
  assert.equal(session.mode, 'review');
  assert.equal(session.pane, 'commits');
  press(session, 'shift-up');
  assert.deepEqual(session.view().listSelection, [1]);
  press(session, 'shift-end');
  assert.deepEqual(session.view().listSelection, [1, 2]);
  press(session, 'down');
  assert.deepEqual(session.view().listSelection, []);
  assert.equal(session.commitCursor, 2);
  press(session, 'shift-home');
  assert.deepEqual(session.view().listSelection, [1, 2]);
  session.showFiles();
  assert.deepEqual(session.view().listSelection, []);
});

test('ranges omit current rows and suppress cursor markers', async () => {
  const { session, repo } = await openSession([sampleItem('a.js')]);
  session.commits.onCommit();
  await session.ops.idle();
  press(session, 'home', 'shift-end');
  assert.deepEqual(session.view().listSelection, [1, 2]);
  session.rev = session.commits.commits[0].sha;
  assert.deepEqual(session.view().listSelection, [2]);
  assert.deepEqual(
    session.commits.selectedRows().map((row) => row.subject),
    ['init'],
  );
  const noMarkers = () => {
    session.draw();
    const body = session.lastFrame.rows.slice(1, -2).join('\n');
    assert.ok(!stripAnsi(body).includes('▶'));
  };
  for (const mode of ['brief', 'full']) {
    session.commits.commitView = mode;
    noMarkers();
  }
  repo.listBranches = async () => [
    { name: 'one' },
    { name: 'main', current: true },
    { name: 'two' },
  ];
  session.gitBranches.onBranch();
  await session.ops.idle();
  press(session, 'home', 'shift-end');
  assert.deepEqual(session.view().listSelection, [0, 2]);
  assert.deepEqual(
    session.gitBranches.selectedRows().map((row) => row.name),
    ['one', 'two'],
  );
  noMarkers();
  session.dashboard.npm = {
    hasManifest: true,
    deps: 1,
    dev: 0,
    modules: {
      bytes: 1,
      count: 1,
      packages: [{ name: 'one', version: '1.0.0', bytes: 1 }],
    },
  };
  session.dashboard.openPackages();
  press(session, 'shift-end');
  assert.deepEqual(session.view().listSelection, [0]);
  assert.equal(session.view().multiselect, true);
  noMarkers();
  assert.ok(!session.lastFrame.buttons.some((hit) => hit.id === 'packageNew'));
  press(session, 'down');
  assert.equal(session.view().multiselect, false);
});

test('an empty range cannot fall back to the current branch', async () => {
  const { session, repo } = await openSession([sampleItem('a.js')]);
  repo.listBranches = async () => [{ name: 'main', current: true }];
  session.gitBranches.onBranch();
  await session.ops.idle();
  press(session, 'shift-up');
  assert.equal(session.view().multiselect, true);
  assert.deepEqual(session.view().listSelection, []);
  assert.deepEqual(session.gitBranches.selectedRows(), []);
  press(session, 'delete', 's', 'insert');
  assert.equal(session.mode, 'review');
  assert.deepEqual(repo.drops, []);
  assert.deepEqual(repo.pushes, []);
});

test('uncommitted changes stay outside every commit range', async () => {
  const { session, repo } = await openSession([sampleItem('a.js')]);
  const calls = [];
  repo.updateCommitTimes = (top, shas) => calls.push(shas);
  session.commits.onCommit();
  await session.ops.idle();
  session.rev = session.commits.commits[0].sha;
  press(session, 'home', 'shift-up');
  assert.equal(session.view().multiselect, true);
  assert.deepEqual(session.view().listSelection, []);
  assert.deepEqual(session.commits.selectedRows(), []);
  press(session, 'delete', 'u');
  await session.ops.idle();
  assert.equal(session.mode, 'review');
  assert.deepEqual(repo.commitDrops, []);
  assert.deepEqual(calls, []);
  press(session, 'down');
  assert.equal(session.view().multiselect, false);
});

test('mouse ranges work across commits, branches and packages', async () => {
  const { session, repo } = await openSession([sampleItem('a.js')]);
  session.commits.onCommit();
  await session.ops.idle();
  shiftClick(session, listCell(session, 2));
  assert.deepEqual(session.view().listSelection, [1, 2]);
  assert.equal(session.mode, 'review');
  assert.equal(session.nav.listDrag, null);
  const first = listCell(session, 1);
  click(session, first.x, first.y);
  assert.equal(session.nav.multiselect, false);
  dragBetween(session, listCell(session, 1), listCell(session, 2));
  assert.deepEqual(session.view().listSelection, [1, 2]);
  assert.equal(session.nav.selection, null);
  repo.listBranches = async () => [
    { name: 'one' },
    { name: 'main', current: true },
    { name: 'two' },
  ];
  session.gitBranches.onBranch();
  await session.ops.idle();
  dragBetween(session, listCell(session, 2), listCell(session, 0));
  assert.deepEqual(session.view().listSelection, [0, 2]);
  shiftClick(session, listCell(session, 1));
  assert.deepEqual(session.view().listSelection, [2]);
  session.dashboard.npm = {
    hasManifest: true,
    deps: 2,
    dev: 0,
    modules: {
      bytes: 2,
      count: 2,
      packages: [
        { name: 'one', version: '1.0.0', bytes: 1 },
        { name: 'two', version: '1.0.0', bytes: 1 },
      ],
    },
  };
  session.dashboard.openPackages();
  dragBetween(session, listCell(session, 1), listCell(session, 0));
  assert.deepEqual(session.view().listSelection, [0, 1]);
  const calls = [];
  repo.runPackage = async (top, args) => {
    calls.push(args);
    return { status: 0 };
  };
  clickFooter(session, 'packageWanted');
  await session.packages.job;
  assert.deepEqual(calls, [['update', 'one', 'two']]);
});

test('full commit mouse ranges include multiline rows and gaps', async () => {
  const { session, repo, stdout } = await openSession([sampleItem('a.js')]);
  stdout.rows = 30;
  repo.setCommits([
    { sha: 'one', body: 'one\nbody\nlast', subject: 'one' },
    { sha: 'two', body: 'two\nbody\nlast', subject: 'two' },
  ]);
  session.commits.onCommit();
  await session.ops.idle();
  session.commits.commitView = 'full';
  const start = listCell(session, 1, true);
  const end = listCell(session, 2);
  dragBetween(session, start, end);
  assert.deepEqual(session.view().listSelection, [1, 2]);
  assert.equal(session.pane, 'commits');
  assert.equal(session.nav.selection, null);
  shiftClick(session, listCell(session, 1));
  assert.deepEqual(session.view().listSelection, [1]);
});

test('mouse ranges extend past visible rows', async () => {
  const { session, repo, stdout } = await openSession([sampleItem('a.js')]);
  stdout.rows = 10;
  repo.setCommits(
    Array.from({ length: 20 }, (_, i) => ({
      sha: `sha${i}`,
      subject: `commit ${i}`,
    })),
  );
  session.commits.onCommit();
  await session.ops.idle();
  const start = listCell(session, 1);
  session.handleEvent({
    type: 'mouse',
    kind: 'press',
    button: 0,
    btn: 0,
    ...start,
  });
  for (let i = 0; i < 6; i++) {
    session.draw();
    session.handleEvent({
      type: 'mouse',
      kind: 'drag',
      button: 32,
      btn: 0,
      x: 5 + i,
      y: session.lastFrame.height - 1,
    });
  }
  session.draw();
  session.handleEvent({
    type: 'mouse',
    kind: 'release',
    button: 0,
    btn: 0,
    x: 10,
    y: session.lastFrame.height - 1,
  });
  assert.ok(session.nav.commitCursor > 6);
  assert.ok(session.nav.listScroll > 0);
  assert.ok(session.view().listSelection.length > 6);
  assert.equal(session.mode, 'review');
  assert.equal(session.pane, 'commits');
  assert.equal(session.nav.listDrag, null);
});

test('ctrl-click toggles rows and shift selects the anchor span', async () => {
  const { session, repo } = await openSession([sampleItem('a.js')]);
  repo.setCommits([
    {
      sha: '1111111111111111111111111111111111111111',
      shortSha: '1111111',
      subject: 'one',
    },
    {
      sha: '2222222222222222222222222222222222222222',
      shortSha: '2222222',
      subject: 'two',
    },
    {
      sha: '3333333333333333333333333333333333333333',
      shortSha: '3333333',
      subject: 'three',
    },
    {
      sha: '4444444444444444444444444444444444444444',
      shortSha: '4444444',
      subject: 'four',
    },
  ]);
  session.commits.onCommit();
  await session.ops.idle();
  const at = (cursor) => listCell(session, cursor);
  const clickAt = (cursor) => {
    const cell = at(cursor);
    click(session, cell.x, cell.y);
  };
  clickAt(1);
  assert.equal(session.nav.multiselect, false);
  assert.deepEqual(session.view().listSelection, []);
  shiftClick(session, at(4));
  assert.deepEqual(session.view().listSelection, [1, 2, 3, 4]);
  ctrlClick(session, at(2));
  assert.deepEqual(session.view().listSelection, [1, 3, 4]);
  ctrlClick(session, at(3));
  assert.deepEqual(session.view().listSelection, [1, 4]);
  ctrlClick(session, at(2));
  assert.deepEqual(session.view().listSelection, [1, 2, 4]);
  assert.deepEqual(
    session.commits.selectedRows().map((row) => row.subject),
    ['one', 'two', 'four'],
  );
  ctrlClick(session, at(0));
  assert.deepEqual(session.view().listSelection, [1, 2, 4]);
  const kept = at(1);
  rightClick(session, kept.x, kept.y);
  assert.deepEqual(session.view().listSelection, [1, 2, 4]);
  assert.ok(!session.nav.contextMenu.actions.includes('reword'));
  press(session, 'escape');
  assert.deepEqual(session.view().listSelection, [1, 2, 4]);
  ctrlShiftClick(session, at(3));
  assert.deepEqual(session.view().listSelection, [1, 2, 3, 4]);
  clickAt(1);
  assert.equal(session.nav.multiselect, false);
  ctrlClick(session, at(4));
  assert.deepEqual(session.view().listSelection, [1, 4]);
  press(session, 'shift-up');
  assert.deepEqual(session.view().listSelection, [3, 4]);
  press(session, 'down');
  assert.equal(session.nav.multiselect, false);
  assert.deepEqual(session.view().listSelection, []);
  clickAt(2);
  ctrlClick(session, at(2));
  assert.equal(session.view().multiselect, true);
  assert.deepEqual(session.view().listSelection, []);
});

test('ctrl-click toggles branch rows and skips the current one', async () => {
  const { session, repo } = await openSession([sampleItem('a.js')]);
  repo.listBranches = async () => [
    { name: 'one' },
    { name: 'main', current: true },
    { name: 'two' },
    { name: 'three' },
  ];
  session.gitBranches.onBranch();
  await session.ops.idle();
  const at = (cursor) => listCell(session, cursor);
  const clickAt = (cursor) => {
    const cell = at(cursor);
    click(session, cell.x, cell.y);
  };
  clickAt(0);
  ctrlClick(session, at(3));
  assert.deepEqual(session.view().listSelection, [0, 3]);
  ctrlClick(session, at(1));
  assert.deepEqual(session.view().listSelection, [0, 3]);
  ctrlClick(session, at(0));
  assert.deepEqual(session.view().listSelection, [3]);
  assert.deepEqual(
    session.gitBranches.selectedRows().map((row) => row.name),
    ['three'],
  );
});

test('a context action preserves the mouse-selected range', async () => {
  const { session, repo } = await openSession([sampleItem('a.js')]);
  const calls = [];
  repo.updateCommitTimes = async (top, shas) => calls.push(shas);
  session.commits.onCommit();
  await session.ops.idle();
  shiftClick(session, listCell(session, 2));
  const row = listCell(session, 1);
  rightClick(session, row.x, row.y);
  assert.deepEqual(session.view().listSelection, [1, 2]);
  assert.ok(!session.nav.contextMenu.actions.includes('reword'));
  press(session, 'u');
  await session.ops.idle();
  assert.deepEqual(calls, [session.commits.commits.map((entry) => entry.sha)]);
  assert.equal(session.mode, 'review');
});

test('commit ranges update timestamps and delete together', async () => {
  const { session, repo } = await openSession([sampleItem('a.js')]);
  const updated = [];
  const dropped = [];
  repo.updateCommitTimes = (top, shas) => updated.push(shas);
  repo.dropCommits = (top, shas) => dropped.push(shas);
  session.commits.onCommit();
  await session.ops.idle();
  const shas = session
    .view()
    .commits.slice(1)
    .map((entry) => entry.sha);
  press(session, 'down', 'shift-down', 'u');
  await session.ops.idle();
  assert.deepEqual(updated, [shas]);
  assert.equal(session.mode, 'review');
  press(session, 'home', 'shift-end', 'delete');
  assert.equal(session.mode, 'confirmDrop');
  press(session, 'n');
  assert.deepEqual(dropped, []);
  press(session, 'delete', 'y');
  await session.ops.idle();
  assert.deepEqual(dropped, [shas]);
});

test('commit ranges squash into one message for editing', async () => {
  const { session, repo } = await openSession([sampleItem('a.js')]);
  const squashed = [];
  repo.setCommits([
    {
      sha: 'ccc3333ccccccccccccccccccccccccccccccc',
      shortSha: 'ccc3333',
      author: 'Ada',
      date: 'now',
      subject: 'three',
      body: 'three\n\nthird',
    },
    {
      sha: 'bbb2222bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      shortSha: 'bbb2222',
      author: 'Ada',
      date: 'yesterday',
      subject: 'two',
      body: 'two\n\nsecond',
    },
    {
      sha: 'aaa1111aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      shortSha: 'aaa1111',
      author: 'Ada',
      date: '2 days ago',
      subject: 'one',
      body: 'one\n\nfirst',
    },
  ]);
  repo.squashCommits = (top, shas, message) => {
    squashed.push({ shas, message });
  };
  session.commits.onCommit();
  await session.ops.idle();
  press(session, 'shift-down', 's');
  await session.ops.idle();
  assert.equal(session.mode, 'review');
  assert.deepEqual(squashed, []);
  assert.deepEqual(repo.pushes, []);
  press(session, 'home', 'shift-end');
  session.draw();
  const ids = session.lastFrame.buttons.map((hit) => hit.id);
  assert.ok(ids.includes('squash'));
  assert.ok(!ids.includes('push'));
  assert.ok(!ids.includes('reword'));
  press(session, 's');
  await session.ops.idle();
  assert.equal(session.mode, 'compose');
  assert.equal(session.commitKind, 'squash');
  assert.equal(session.commitCursor, 3);
  const combined = 'one\n\nfirst\n\ntwo\n\nsecond\n\nthree\n\nthird';
  assert.equal(session.editor.text, combined);
  session.draw();
  const header = stripAnsi(session.lastFrame.rows[0]);
  const footer = stripAnsi(session.lastFrame.rows.at(-1));
  assert.match(header, /commits full/);
  assert.match(footer, /Ctrl-S/);
  press(session, 'enter');
  assert.equal(session.mode, 'compose');
  press(session, 'escape');
  assert.equal(session.mode, 'review');
  assert.deepEqual(squashed, []);
  press(session, 'home', 'shift-end', 's');
  await session.ops.idle();
  session.editor.replace('joined\n\nbody');
  press(session, 'ctrl-s');
  await session.ops.idle();
  assert.equal(session.status, 'squashed');
  assert.equal(session.mode, 'review');
  assert.deepEqual(squashed, [
    {
      shas: [
        'ccc3333ccccccccccccccccccccccccccccccc',
        'bbb2222bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        'aaa1111aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      ],
      message: 'joined\n\nbody',
    },
  ]);
});

test('branch ranges delete noncurrent branches', async () => {
  const { session, repo } = await openSession([sampleItem('a.js')]);
  const branches = [
    { name: 'one' },
    { name: 'main', current: true },
    { name: 'two' },
  ];
  repo.listBranches = async () => branches;
  session.gitBranches.onBranch();
  await session.ops.idle();
  press(session, 'home', 'shift-end');
  session.draw();
  const ids = session.lastFrame.buttons.map((hit) => hit.id);
  assert.ok(!ids.includes('squash'));
  assert.ok(ids.includes('drop'));
  assert.ok(!ids.includes('newBranch'));
  assert.ok(!ids.includes('rebase'));
  press(session, 'insert', 'e', 's');
  assert.equal(session.mode, 'review');
  assert.deepEqual(repo.rebases, []);
  assert.deepEqual(repo.pushes, []);
  press(session, 'home', 'shift-end', 'delete', 'y');
  await session.ops.idle();
  assert.deepEqual(repo.drops, ['one', 'two']);
});

test('commits pane a applies a selected fixup', async () => {
  const { session, repo } = await openSession([sampleItem('a.js')], {
    startPane: 'files',
  });
  session.pushInput('c');
  await session.ops.idle();
  repo.setCommits([
    {
      sha: 'fff0000fffffffffffffffffffffffffffffff',
      shortSha: 'fff0000',
      author: 'Ada',
      date: 'now',
      subject: 'fixup! land the change',
    },
    {
      sha: 'aaa1111aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      shortSha: 'aaa1111',
      author: 'Ada',
      date: '2 hours ago',
      subject: 'land the change',
    },
  ]);
  session.commits.refresh();
  await session.ops.idle();
  session.draw();
  assert.equal(
    session.lastFrame.buttons.some((hit) => hit.id === 'apply'),
    false,
  );
  session.dispatch('next');
  await session.ops.idle();
  session.draw();
  assert.ok(session.lastFrame.buttons.find((hit) => hit.id === 'apply'));
  const other = listCell(session, 2);
  rightClick(session, other.x, other.y);
  assert.equal(session.nav.contextMenu.actions.includes('apply'), false);
  press(session, 'escape');
  press(session, 'p');
  await session.ops.idle();
  session.draw();
  assert.deepEqual(repo.applyFixups, []);
  assert.equal(session.mode, 'review');
  assert.equal(
    session.lastFrame.buttons.some((hit) => hit.id === 'apply'),
    false,
  );
  session.dispatch('prev');
  await session.ops.idle();
  const fixup = listCell(session, 1);
  rightClick(session, fixup.x, fixup.y);
  assert.ok(session.nav.contextMenu.actions.includes('apply'));
  press(session, 'escape');
  session.pushInput('p');
  await session.ops.idle();
  assert.deepEqual(repo.applyFixups, [
    'fff0000fffffffffffffffffffffffffffffff',
  ]);
  assert.equal(session.status, 'applied');
  assert.equal(session.mode, 'review');
  assert.equal(session.composeKind, null);
});

test('click apply footer squashes the selected fixup', async () => {
  const { session, repo } = await openSession([sampleItem('a.js')], {
    startPane: 'files',
  });
  session.pushInput('c');
  await session.ops.idle();
  repo.setCommits([
    {
      sha: 'fff0000fffffffffffffffffffffffffffffff',
      shortSha: 'fff0000',
      author: 'Ada',
      date: 'now',
      subject: 'fixup! land the change',
    },
    {
      sha: 'aaa1111aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      shortSha: 'aaa1111',
      author: 'Ada',
      date: '2 hours ago',
      subject: 'land the change',
    },
  ]);
  session.commits.refresh();
  session.dispatch('next');
  await session.ops.idle();
  clickFooter(session, 'apply');
  await session.ops.idle();
  assert.deepEqual(repo.applyFixups, [
    'fff0000fffffffffffffffffffffffffffffff',
  ]);
  assert.equal(session.status, 'applied');
});

test('c on an older commit writes a fixup', async () => {
  const { session, repo } = await openSession([sampleItem('a.js', 'staged')], {
    startPane: 'files',
  });
  session.pushInput('c');
  await session.ops.idle();
  session.dispatch('next');
  await session.ops.idle();
  session.dispatch('next');
  await session.ops.idle();
  press(session, 'insert');
  await session.ops.idle();
  press(session, 'f');
  await session.ops.idle();
  assert.equal(session.editor.text, 'fixup! init');
  press(session, 'enter');
  await session.ops.idle();
  assert.equal(session.status, 'fixup');
  assert.equal(repo.commits[0].kind, 'fixup');
  assert.equal(repo.commits[0].message, 'fixup! init');
});

test('escape from commit message does not run git', async () => {
  const { session, repo } = await openSession([sampleItem('a.js', 'staged')], {
    startPane: 'files',
  });
  session.pushInput('c');
  press(session, 'insert');
  session.pushInput('draft');
  press(session, 'escape');
  assert.equal(session.mode, 'review');
  assert.equal(repo.commits.length, 0);
});

test('compose c inserts a letter and does not open commit', async () => {
  const { session, repo } = await openSession([sampleItem('a.js')]);
  session.dispatch('feedback');
  session.pushInput('c');
  assert.equal(session.mode, 'compose');
  assert.equal(session.composeKind, 'feedback');
  assert.equal(session.editor.text, 'c');
  assert.equal(repo.commits.length, 0);
});

test('diff pane c opens commits', async () => {
  const { session } = await openSession([sampleItem('a.js', 'staged')]);
  session.pushInput('c');
  await session.ops.idle();
  assert.equal(session.mode, 'review');
  assert.equal(session.pane, 'commits');
});

test('commits pane skips commit when nothing is staged', async () => {
  const { session, repo } = await openSession([sampleItem('a.js')], {
    startPane: 'files',
  });
  session.pushInput('c');
  await session.ops.idle();
  assert.equal(session.pane, 'commits');
  press(session, 'insert');
  await session.ops.idle();
  assert.equal(session.mode, 'review');
  assert.equal(session.status, 'nothing to commit');
  assert.equal(repo.commits.length, 0);
  press(session, 'x');
  assert.equal(session.mode, 'review');
  assert.equal(session.status, 'nothing to commit');
  assert.equal(repo.commits.length, 0);
});

test('commits pane opens on the viewed revision', async () => {
  const { session } = await openSession([sampleItem('a.js')], {
    startPane: 'files',
  });
  session.pushInput('c');
  await session.ops.idle();
  press(session, 'end');
  await session.ops.idle();
  assert.equal(session.commitCursor, 2);
  press(session, 'enter');
  await session.ops.idle();
  session.draw();
  assert.equal(session.pane, 'diff');
  press(session, 'escape');
  await session.ops.idle();
  assert.equal(session.pane, 'files');
  session.pushInput('c');
  await session.ops.idle();
  assert.equal(session.pane, 'commits');
  assert.equal(session.commitCursor, 2);
});

test('commits pane lists newest first', async () => {
  const { session } = await openSession([sampleItem('a.js')], {
    startPane: 'files',
  });
  session.pushInput('c');
  await session.ops.idle();
  const listed = session.view().commits.map((entry) => entry.subject);
  assert.deepEqual(listed, ['uncommitted changes', 'land the change', 'init']);
  press(session, 'right');
  await session.ops.idle();
  assert.equal(session.commitCursor, 0);
  press(session, 'down');
  await session.ops.idle();
  assert.equal(session.commitCursor, 1);
  press(session, 'up');
  await session.ops.idle();
  assert.equal(session.commitCursor, 0);
  session.pushInput('j');
  await session.ops.idle();
  assert.equal(session.commitCursor, 1);
  press(session, 'home');
  await session.ops.idle();
  assert.equal(session.commitCursor, 0);
  press(session, 'enter');
  await session.ops.idle();
  assert.equal(session.pane, 'commits');
  assert.equal(session.mode, 'review');
  assert.equal(session.status, 'nothing to commit');
  press(session, 'escape');
  await session.ops.idle();
  session.pushInput('c');
  await session.ops.idle();
  press(session, 'end');
  await session.ops.idle();
  assert.equal(session.commitCursor, 2);
  press(session, 'enter');
  await session.ops.idle();
  assert.equal(session.pane, 'diff');
  assert.equal(session.rev, 'bbb2222bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
});

test('commits pane delete asks to delete the selected commit', async () => {
  const { session, repo } = await openSession([sampleItem('a.js')], {
    startPane: 'files',
  });
  session.pushInput('c');
  await session.ops.idle();
  session.dispatch('next');
  await session.ops.idle();
  press(session, 'delete');
  await session.ops.idle();
  assert.equal(session.mode, 'confirmDrop');
  assert.equal(session.view().dropName, 'aaa1111');
  session.pushInput('n');
  await session.ops.idle();
  assert.equal(session.mode, 'review');
  assert.equal(repo.commitDrops.length, 0);
  press(session, 'delete');
  await session.ops.idle();
  press(session, 'escape');
  await session.ops.idle();
  assert.equal(session.mode, 'review');
  assert.equal(repo.commitDrops.length, 0);
  press(session, 'delete');
  await session.ops.idle();
  session.pushInput('y');
  await session.ops.idle();
  assert.deepEqual(repo.commitDrops, [
    'aaa1111aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  ]);
  assert.match(session.status, /dropped aaa1111/);
  assert.equal(session.pane, 'commits');
  assert.equal(session.view().commits[1].subject, 'init');
});

test('click commit row selects it', async () => {
  const { session } = await openSession([sampleItem('a.js')], {
    startPane: 'files',
  });
  session.pushInput('c');
  await session.ops.idle();
  session.draw();
  const hit = session.lastFrame.fileHits.find((entry) => entry.cursor === 1);
  assert.ok(hit);
  click(session, 4, hit.y);
  assert.equal(session.commitCursor, 1);
  assert.equal(session.pane, 'commits');
});

test('double click commit row opens its diff', async () => {
  const { session } = await openSession([sampleItem('a.js')], {
    startPane: 'files',
  });
  session.pushInput('c');
  await session.ops.idle();
  session.draw();
  const hit = session.lastFrame.fileHits.find((entry) => entry.cursor === 2);
  assert.ok(hit);
  click(session, 4, hit.y);
  assert.equal(session.commitCursor, 2);
  assert.equal(session.pane, 'commits');
  click(session, 4, hit.y);
  await session.ops.idle();
  assert.equal(session.pane, 'diff');
  assert.equal(session.rev, 'bbb2222bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
});

test('files pane a and d stay add and revert', async () => {
  const added = await openSession([sampleItem('a.js')], { startPane: 'files' });
  press(added.session, 'down');
  added.session.pushInput('a');
  await added.session.ops.idle();
  assert.equal(added.repo.added.length, 1);
  const reverted = await openSession([sampleItem('a.js')], {
    startPane: 'files',
  });
  press(reverted.session, 'down');
  reverted.session.pushInput('d');
  await reverted.session.ops.idle();
  assert.equal(reverted.repo.reverted.length, 1);
});

test('files pane p and s do not pull or push', async () => {
  const { session, repo } = await openSession([sampleItem('a.js')], {
    startPane: 'files',
  });
  session.pushInput('p');
  session.pushInput('s');
  assert.equal(repo.pulls.length, 0);
  assert.equal(repo.pushes.length, 0);
  assert.equal(session.pane, 'files');
});

test('commits pane p ignores a normal row and s pushes', async () => {
  const { session, repo } = await openSession([sampleItem('a.js')], {
    startPane: 'files',
  });
  session.pushInput('c');
  await session.ops.idle();
  assert.equal(session.pane, 'commits');
  session.pushInput('p');
  assert.equal(repo.pulls.length, 0);
  assert.equal(repo.pushes.length, 0);
  assert.equal(session.mode, 'review');
  assert.equal(session.commitKind, null);
  session.pushInput('s');
  assert.equal(repo.pushes.length, 1);
  assert.equal(session.pane, 'commits');
});

test('quit without notes does not write a review file', async () => {
  const { session } = await openSession([sampleItem('a.js')]);
  const reviewPath = session.notes.reviewPath;
  session.dispatch('quit');
  assert.equal(session.done, true);
  assert.equal(fs.existsSync(reviewPath), false);
});

test('load applies imported GitHub notes on a new review', async () => {
  const item = sampleItem('lib/parser.js', 'pr');
  const cwd = tempDir('reslop-ui-');
  const imported = {
    feedback: [
      {
        file: 'lib/parser.js',
        oldStart: 1,
        newStart: 1,
        blockId: 0,
        origin: 'pr',
        header: '@@ -1,1 +1,1 @@',
        text: '@alice review at github: use const',
        done: false,
      },
    ],
    todos: [
      {
        file: 'pull request',
        text: '@bob review at github: add tests',
        done: false,
      },
    ],
  };
  const repo = {
    load: () => ({
      top: cwd,
      items: [item],
      imported,
      sourceLabel: '#123',
    }),
    add: () => {},
    unstage: () => {},
    revert: () => {},
  };
  const { session } = await openSession([item], { cwd, repo });
  const notes = [...session.notes.feedback.values()];
  assert.equal(notes.length, 1);
  assert.match(notes[0].text, /use const/);
  assert.equal(session.notes.tasks.length, 1);
  assert.match(session.notes.tasks[0].text, /add tests/);
  assert.equal(
    session.fileList().some((entry) => entry.kind === 'tasks'),
    false,
  );
  await session.load();
  assert.equal(session.notes.tasks.length, 1);
});

test('load skips imported GitHub notes when resuming a review', async () => {
  const cwd = tempDir('reslop-ui-');
  const reviewPath = path.join(cwd, REVIEW_DIR, `${today()}-00.md`);
  const draft = new ReviewStore(reviewPath);
  draft.addTask('a.js', 'rewrite loop');
  fs.mkdirSync(path.dirname(reviewPath), { recursive: true });
  fs.writeFileSync(reviewPath, serializeReview(draft), 'utf8');
  const item = sampleItem('lib/parser.js', 'pr');
  const imported = {
    feedback: [],
    todos: [{ file: 'pull request', text: 'from github', done: false }],
  };
  const { session } = await openSession([item], {
    cwd,
    repo: {
      load: () => ({ top: cwd, items: [item], imported }),
      add: () => {},
      unstage: () => {},
      revert: () => {},
    },
  });
  assert.equal(session.notes.tasks.length, 1);
  assert.equal(session.notes.tasks[0].text, 'rewrite loop');
});

test('openLoad paints git items before npm extras arrive', async () => {
  const gitItem = sampleItem('a.js');
  const extraItem = sampleItem('package.json');
  extraItem.dep = { change: { name: 'lodash', block: 'dependencies' } };
  const cwd = tempDir('reslop-ui-');
  let extrasResolve = null;
  const extras = new Promise((resolve) => {
    extrasResolve = resolve;
  });
  let extrasStarted = false;
  const repo = {
    load: async () => ({
      top: cwd,
      items: [gitItem],
      parsed: [gitItem],
      pending: true,
    }),
    loadExtras: async () => {
      extrasStarted = true;
      await extras;
      return {
        top: cwd,
        items: [gitItem, extraItem],
        pending: false,
      };
    },
    add: () => {},
    unstage: () => {},
    revert: () => {},
  };
  const session = new Session({
    cwd,
    stdout: uiSink(),
    color: false,
    repo,
    audit: true,
    startPane: 'files',
  });
  session.uiOpen = true;
  const pending = session.openLoad();
  await new Promise((resolve, reject) => {
    const tick = (left) => {
      if (extrasStarted) {
        resolve();
        return;
      }
      if (left <= 0) {
        reject(new Error('extras did not start'));
        return;
      }
      setImmediate(() => tick(left - 1));
    };
    tick(50);
  });
  assert.equal(session.items.length, 1);
  assert.equal(session.items[0].file.newPath, 'a.js');
  assert.equal(session.busy, 'checking npm');
  session.dispatch('next');
  extrasResolve();
  await pending;
  assert.equal(session.items.length, 2);
  assert.equal(session.busy, '');
});

const openUpdating = async (extra = {}) => {
  const cacheFile = path.join(tempDir('reslop-cache-'), 'update.json');
  const installed = [];
  let fetchResolve = null;
  let fetchGate = null;
  if (extra.gateFetch) {
    fetchGate = new Promise((resolve) => {
      fetchResolve = resolve;
    });
  }
  const update = {
    enabled: true,
    current: extra.current ?? '0.1.5',
    cacheFile,
    fetch:
      extra.fetch ??
      (async () => {
        if (fetchGate) await fetchGate;
        return {
          ok: true,
          json: async () => ({ version: extra.latest ?? '0.1.6' }),
        };
      }),
    install:
      extra.install ??
      (async (version) => {
        installed.push(version);
      }),
  };
  const { session } = await openSession(
    [sampleItem('a.js'), sampleItem('b.js')],
    {
      startPane: 'files',
      update,
      ...extra.session,
    },
  );
  session.uiOpen = true;
  return { session, installed, fetchResolve, cacheFile, update };
};

test('update check does not block loading', async () => {
  const { session, fetchResolve, installed } = await openUpdating({
    gateFetch: true,
    latest: '0.1.6',
  });
  const updateP = session.openUpdate();
  assert.equal(session.didLoad, true);
  assert.equal(session.items.length, 2);
  assert.equal(session.mode, 'review');
  assert.deepEqual(installed, []);
  fetchResolve();
  await updateP;
  assert.deepEqual(installed, ['0.1.6']);
});

test('patch update installs in the background', async () => {
  const { session, installed } = await openUpdating({ latest: '0.1.6' });
  await session.openUpdate();
  assert.deepEqual(installed, ['0.1.6']);
  assert.equal(session.status, 'updated');
  assert.equal(session.mode, 'review');
});

test('major update asks y or n on the loaded status line', async () => {
  const { session, installed } = await openUpdating({ latest: '1.0.0' });
  await session.openUpdate();
  session.draw();
  assert.equal(session.mode, 'confirmUpdate');
  assert.equal(session.updater.from, '0.1.5');
  assert.equal(session.updater.to, '1.0.0');
  assert.deepEqual(installed, []);
  const text = session.lastFrame.text;
  assert.match(text, /update reslop 0\.1\.5 → 1\.0\.0\? y\/n/);
  press(session, 'n');
  assert.equal(session.mode, 'review');
  assert.deepEqual(installed, []);
  press(session, 'j');
  assert.equal(session.fileCursor, 1);
});

test('major prompt waits until the UI has loaded', async () => {
  const cwd = tempDir('reslop-ui-');
  const session = new Session({
    cwd,
    stdout: uiSink(),
    color: false,
    startPane: 'files',
    repo: mockRepo([sampleItem('a.js')], cwd),
    update: {
      enabled: true,
      current: '0.1.5',
      cacheFile: path.join(tempDir('reslop-cache-'), 'update.json'),
      fetch: async () => ({
        ok: true,
        json: async () => ({ version: '1.0.0' }),
      }),
      install: async () => {},
    },
  });
  session.uiOpen = true;
  await session.openUpdate();
  assert.equal(session.updater.offer, true);
  assert.equal(session.didLoad, false);
  assert.equal(session.mode, 'review');
  await session.openLoad();
  session.draw();
  assert.equal(session.mode, 'confirmUpdate');
});

test('major update y installs the new version', async () => {
  const { session, installed } = await openUpdating({ latest: '1.0.0' });
  await session.openUpdate();
  session.draw();
  press(session, 'y');
  await session.installPromise;
  assert.deepEqual(installed, ['1.0.0']);
  assert.equal(session.status, 'updated');
  assert.equal(session.mode, 'review');
});

test('declined major update is not asked again from cache', async () => {
  const { session, cacheFile, update } = await openUpdating({
    latest: '1.0.0',
  });
  await session.openUpdate();
  session.draw();
  press(session, 'n');
  let fetched = 0;
  const again = (
    await openSession([sampleItem('a.js')], {
      startPane: 'files',
      update: {
        ...update,
        fetch: async () => {
          fetched += 1;
          return { ok: true, json: async () => ({ version: '1.0.0' }) };
        },
      },
    })
  ).session;
  again.uiOpen = true;
  await again.openUpdate();
  again.draw();
  assert.equal(again.mode, 'review');
  assert.equal(fetched, 0);
  assert.equal(fs.existsSync(cacheFile), true);
});

test('click status branch opens the branch list', async () => {
  const { session } = await openSession([sampleItem('a.js')], {
    startPane: 'files',
  });
  session.draw();
  const hit = session.lastFrame.statusHits[0];
  assert.ok(hit);
  click(session, hit.x0 + 1, hit.y);
  await session.ops.idle();
  assert.equal(session.pane, 'branches');
});

test('the 🢐esc button goes back from list screens', async () => {
  const { session } = await openSession([sampleItem('a.js')], {
    startPane: 'files',
  });
  session.dispatch('scrollDown');
  press(session, 'enter');
  assert.equal(session.pane, 'diff');
  assert.notEqual(session.current().origin, 'task');
  press(session, 'escape');
  session.pushInput('b');
  clickFooter(session, 'back');
  assert.equal(session.pane, 'files');
  session.pushInput('c');
  clickFooter(session, 'back');
  assert.equal(session.pane, 'files');
  session.pushInput('n');
  clickFooter(session, 'back');
  assert.equal(session.pane, 'files');
  session.dispatch('tasks');
  session.pushInput('ship');
  press(session, 'escape');
  assert.equal(session.current().origin, 'task');
  clickFooter(session, 'back');
  await session.ops.idle();
  assert.equal(session.pane, 'files');
});

test('files pane b lists branches and enter checks out', async () => {
  const a = sampleItem('a.js');
  const b = sampleItem('b.js');
  const { session, repo } = await openSession([a, b], { startPane: 'files' });
  assert.equal(session.branch, 'main');
  session.pushInput('b');
  await session.ops.idle();
  assert.equal(session.pane, 'branches');
  assert.equal(session.branchCursor, 0);
  press(session, 'right');
  await session.ops.idle();
  assert.equal(session.branchCursor, 0);
  press(session, 'left');
  await session.ops.idle();
  assert.equal(session.branchCursor, 0);
  press(session, 'down');
  await session.ops.idle();
  assert.equal(session.branchCursor, 1);
  press(session, 'up');
  await session.ops.idle();
  assert.equal(session.branchCursor, 0);
  session.pushInput('j');
  await session.ops.idle();
  assert.equal(session.branchCursor, 1);
  press(session, 'home');
  await session.ops.idle();
  assert.equal(session.branchCursor, 0);
  press(session, 'end');
  await session.ops.idle();
  assert.equal(session.branchCursor, session.branches.length - 1);
  press(session, 'enter');
  await session.ops.idle();
  assert.deepEqual(repo.checkouts, ['feat']);
  assert.equal(session.pane, 'branches');
  assert.equal(session.branchCursor, session.branches.length - 1);
  assert.match(session.status, /checked out feat/);
});

test('branch list p pulls and s pushes', async () => {
  const a = sampleItem('a.js');
  const b = sampleItem('b.js');
  const { session, repo } = await openSession([a, b], { startPane: 'files' });
  session.pushInput('b');
  await session.ops.idle();
  assert.equal(repo.listed.length, 1);
  session.pushInput('p');
  await session.ops.idle();
  assert.equal(repo.pulls.length, 1);
  assert.equal(repo.listed.length, 2);
  assert.equal(session.status, 'pulled');
  assert.equal(session.pane, 'branches');
  session.pushInput('s');
  await session.ops.idle();
  assert.equal(repo.pushes.length, 1);
  assert.equal(repo.listed.length, 3);
  assert.equal(session.status, 'pushed');
  press(session, 'down');
  await session.ops.idle();
  session.pushInput('p');
  await session.ops.idle();
  assert.equal(repo.pulls.length, 2);
  session.pushInput('s');
  await session.ops.idle();
  assert.equal(repo.pushes.length, 2);
  press(session, 'up');
  await session.ops.idle();
  session.pushInput('p');
  await session.ops.idle();
  assert.equal(repo.pulls.length, 3);
});

test('rejected push asks f to force or escape to cancel', async () => {
  const { session, repo } = await openSession([sampleItem('a.js')], {
    startPane: 'files',
  });
  session.repo.push = (top, force) => {
    if (force) {
      repo.pushes.push(true);
      return;
    }
    const error = new Error('non-fast-forward');
    error.rejected = true;
    throw error;
  };
  session.pushInput('b');
  await session.ops.idle();
  session.pushInput('s');
  await session.ops.idle();
  assert.equal(session.mode, 'confirmPush');
  assert.equal(repo.pushes.length, 0);
  session.pushInput('x');
  await session.ops.idle();
  assert.equal(session.mode, 'confirmPush');
  press(session, 'escape');
  await session.ops.idle();
  assert.equal(session.mode, 'review');
  assert.equal(repo.pushes.length, 0);
  session.pushInput('s');
  await session.ops.idle();
  session.pushInput('f');
  await session.ops.idle();
  assert.deepEqual(repo.pushes, [true]);
  assert.equal(session.mode, 'review');
  assert.equal(session.status, 'force pushed');
});

test('pull shows progress until git finishes', async () => {
  let finish = null;
  const pending = new Promise((resolve) => {
    finish = resolve;
  });
  const { session, repo } = await openSession([sampleItem('a.js')], {
    startPane: 'files',
  });
  session.repo.pull = () => pending;
  session.pushInput('b');
  session.pushInput('p');
  await settle();
  assert.equal(repo.pulls.length, 0);
  assert.equal(session.busy, 'pulling');
  assert.equal(session.view().status, 'pulling');
  assert.equal(session.progressFrame, 0);
  session.tickProgress();
  assert.equal(session.progressFrame, 1);
  session.pushInput('p');
  finish();
  await session.ops.idle();
  assert.equal(session.status, 'pulled');
  assert.equal(session.busy, '');
  assert.equal(session.gitBusy, false);
});

test('npm i shows progress until install finishes', async () => {
  let finish = null;
  const pending = new Promise((resolve) => {
    finish = resolve;
  });
  const { session } = await openSession([sampleItem('a.js')], {
    startPane: 'diff',
  });
  session.uiOpen = true;
  const item = session.current();
  item.reload = true;
  item.dep = {
    change: { propose: true, name: 'lodash' },
    files: ['package.json'],
  };
  session.repo.add = () => pending;
  session.dispatch('add');
  assert.equal(session.current().origin, 'staged');
  assert.equal(session.busy, 'npm i');
  session.tickProgress();
  assert.equal(session.progressFrame, 1);
  finish();
  await session.ops.idle();
  assert.equal(session.status, 'staged');
  assert.equal(session.busy, '');
});

test('stage moves on while npm install is still running', async () => {
  let finish = null;
  const pending = new Promise((resolve) => {
    finish = resolve;
  });
  const proposed = sampleItem('package.json');
  proposed.reload = true;
  proposed.dep = {
    change: { propose: true, name: 'lodash' },
    files: ['package.json'],
  };
  const other = sampleItem('z.js');
  const { session, repo } = await openSession([proposed, other]);
  session.uiOpen = true;
  let installs = 0;
  session.repo.add = (top, item) => {
    if (item.dep) installs += 1;
    else repo.added.push(item);
    return item.dep ? pending : undefined;
  };
  session.dispatch('add');
  assert.equal(session.items[0].origin, 'staged');
  assert.equal(installs, 0);
  session.dispatch('next');
  session.dispatch('add');
  assert.equal(session.items[1].origin, 'staged');
  assert.equal(repo.added.length, 0);
  await Promise.resolve();
  assert.equal(installs, 1);
  assert.equal(repo.added.length, 0);
  finish();
  await session.ops.idle();
  assert.equal(repo.added.length, 1);
  assert.equal(repo.added[0].file.newPath, 'z.js');
  assert.equal(session.busy, '');
});

test('openLoad shows progress while a remote change loads', async () => {
  let finish = null;
  const pending = new Promise((resolve) => {
    finish = resolve;
  });
  const item = sampleItem('lib/a.js', 'pr');
  const cwd = tempDir('reslop-ui-');
  const session = new Session({
    cwd,
    stdout: uiSink(),
    color: false,
    startPane: 'files',
    repo: {
      load: async () => {
        await pending;
        return {
          items: [item],
          sourceLabel: '#123',
          change: {
            source: 'pr',
            repository: 'acme/app',
            number: 123,
          },
        };
      },
    },
  });
  session.uiOpen = true;
  const ready = session.openLoad();
  assert.equal(session.busy, 'loading');
  session.tickProgress();
  assert.equal(session.progressFrame, 1);
  finish();
  await ready;
  assert.equal(session.busy, '');
  assert.equal(session.items.length, 1);
  assert.equal(session.sourceLabel, '#123');
  assert.equal(session.repoName, 'acme/app');
});

test('checkout shows progress until git finishes', async () => {
  let finish = null;
  const pending = new Promise((resolve) => {
    finish = resolve;
  });
  const { session, repo } = await openSession([sampleItem('a.js')], {
    startPane: 'files',
  });
  session.uiOpen = true;
  session.repo.checkout = async (top, name) => {
    await pending;
    repo.checkouts.push(name);
  };
  session.pushInput('b');
  await session.ops.idle();
  session.pushInput('j');
  await session.ops.idle();
  press(session, 'enter');
  assert.equal(repo.checkouts.length, 0);
  assert.equal(session.busy, 'checking out');
  session.tickProgress();
  assert.equal(session.progressFrame, 1);
  finish();
  await session.ops.idle();
  assert.deepEqual(repo.checkouts, ['feat']);
  assert.match(session.status, /checked out feat/);
  assert.equal(session.pane, 'branches');
  assert.equal(session.busy, '');
});

test('commit shows progress until git finishes', async () => {
  let finish = null;
  const pending = new Promise((resolve) => {
    finish = resolve;
  });
  const { session, repo } = await openSession([sampleItem('a.js', 'staged')], {
    startPane: 'files',
  });
  session.uiOpen = true;
  session.repo.commit = async (top, kind, message) => {
    await pending;
    repo.commits.push({ top, kind, message });
  };
  session.pushInput('c');
  await session.ops.idle();
  press(session, 'insert');
  await session.ops.idle();
  session.pushInput('land the change');
  await session.ops.idle();
  press(session, 'enter');
  await settle();
  assert.equal(repo.commits.length, 0);
  assert.equal(session.busy, 'committing');
  // The timer of the progress may have ticked on a slow machine meanwhile
  const frame = session.progressFrame;
  session.tickProgress();
  assert.equal(session.progressFrame, frame + 1);
  finish();
  await session.ops.idle();
  assert.equal(repo.commits.length, 1);
  assert.equal(session.status, 'committed');
  assert.equal(session.busy, '');
});

test('files pane u unstages', async () => {
  const item = sampleItem('a.js', 'staged');
  const { session, repo } = await openSession([item], { startPane: 'files' });
  session.dispatch('next');
  await session.ops.idle();
  session.pushInput('u');
  await session.ops.idle();
  assert.equal(repo.unstageCalls.length, 1);
  assert.equal(session.status, 'unstaged');
});

test('files pane f opens file scope and d drops', async () => {
  const item = sampleItem('a.js', 'staged');
  const { session, repo } = await openSession([item], { startPane: 'files' });
  session.dispatch('next');
  session.pushInput('f');
  await session.ops.idle();
  assert.equal(session.fileScope, 'file');
  assert.equal(session.pane, 'files');
  assert.equal(repo.unstageCalls.length, 0);
  session.pushInput('d');
  assert.equal(session.fileScope, 'file');
  assert.equal(repo.reverted.length, 1);
});

test('unit scope lists every file sorted by path', async () => {
  const { session, repo } = await openSession([sampleItem('b.js')], {
    startPane: 'files',
  });
  repo.extraFiles.push('a.js', 'z.js');
  session.dispatch('file');
  await session.ops.idle();
  const names = session.fileList().map((entry) => entry.path);
  assert.deepEqual(names, ['a.js', 'b.js', 'z.js']);
});

test('unit view shows the file with current block marks', async () => {
  const first = sampleItem('a.js');
  const second = sampleItem('a.js');
  second.blockId = 1;
  second.hunk = {
    oldStart: 3,
    oldCount: 1,
    newStart: 3,
    newCount: 1,
    header: '@@ -3,1 +3,1 @@',
    lines: [
      { type: 'del', text: 'c', noNl: false, blockId: 1 },
      { type: 'add', text: 'd', noNl: false, blockId: 1 },
    ],
  };
  const { session, repo } = await openSession([first, second], {
    startPane: 'files',
  });
  repo.fileBodies['a.js'] = 'b\nkeep\nd\n';
  session.dispatch('file');
  session.dispatch('next');
  await session.ops.idle();
  session.dispatch('open');
  await session.ops.idle();
  assert.equal(session.pane, 'unit');
  const view = session.view();
  const types = view.unitLines.map((line) => `${line.type}:${line.text}`);
  assert.deepEqual(types, ['del:a', 'add:b', 'ctx:keep', 'del:c', 'add:d']);
  assert.equal(session.unitLine, 0);
  session.dispatch('next');
  assert.equal(session.unitLine, 3);
  assert.equal(session.current(), second);
  session.dispatch('prev');
  assert.equal(session.unitLine, 0);
  session.scroll = 5;
  press(session, 'up');
  assert.equal(session.scroll, 4);
  press(session, 'down');
  assert.equal(session.scroll, 5);
});

test('unit view marks every block in the current hunk', async () => {
  const [first, second] = hunkPair('a.js');
  const { session, repo } = await openSession([first, second], {
    startPane: 'files',
  });
  repo.fileBodies['a.js'] = 'A\nmid\nC\n';
  session.dispatch('file');
  await session.ops.idle();
  session.dispatch('next');
  await session.ops.idle();
  session.dispatch('open');
  await session.ops.idle();
  session.draw();
  const body = stripAnsi(session.lastFrame.rows.join('\n'));
  assert.match(body, /- a/);
  assert.match(body, /\+ A/);
  assert.match(body, /- c/);
  assert.match(body, /\+ C/);
  session.dispatch('add');
  await session.ops.idle();
  assert.equal(repo.added.length, 2);
  assert.equal(session.items[0].origin, 'staged');
  assert.equal(session.items[1].origin, 'staged');
});

test('file scope next scrolls the whole block into view', async () => {
  const first = sampleItem('a.js');
  const second = sampleItem('a.js');
  second.blockId = 1;
  const adds = [];
  for (let i = 0; i < 5; i++) {
    adds.push({ type: 'add', text: `chg${i}`, noNl: false, blockId: 1 });
  }
  second.hunk = {
    oldStart: 40,
    oldCount: 0,
    newStart: 40,
    newCount: 5,
    header: '@@ -40,0 +40,5 @@',
    lines: adds,
  };
  const rows = ['b'];
  for (let i = 2; i < 40; i++) rows.push(`keep${i}`);
  for (let i = 0; i < 5; i++) rows.push(`chg${i}`);
  rows.push('tail');
  const { session, repo } = await openSession([first, second], {
    startPane: 'files',
  });
  repo.fileBodies['a.js'] = `${rows.join('\n')}\n`;
  session.dispatch('file');
  session.dispatch('next');
  await session.ops.idle();
  session.dispatch('open');
  session.draw();
  await session.ops.idle();
  session.dispatch('next');
  session.draw();
  const body = stripAnsi(session.lastFrame.rows.join('\n'));
  assert.match(body, /chg0/);
  assert.match(body, /chg4/);
  const page = session.lastFrame.bodyH;
  assert.equal(session.scroll, 46 - page + 1);
  assert.match(body, /keep39/);
  assert.match(body, /tail/);
});

test('file scope next pins an oversized block at its start', async () => {
  const first = sampleItem('a.js');
  const second = sampleItem('a.js');
  second.blockId = 1;
  const adds = [];
  for (let i = 0; i < 40; i++) {
    adds.push({ type: 'add', text: `chg${i}`, noNl: false, blockId: 1 });
  }
  second.hunk = {
    oldStart: 40,
    oldCount: 0,
    newStart: 40,
    newCount: 40,
    header: '@@ -40,0 +40,40 @@',
    lines: adds,
  };
  const rows = ['b'];
  for (let i = 2; i < 40; i++) rows.push(`keep${i}`);
  for (let i = 0; i < 40; i++) rows.push(`chg${i}`);
  rows.push('tail');
  const { session, repo } = await openSession([first, second], {
    startPane: 'files',
  });
  repo.fileBodies['a.js'] = `${rows.join('\n')}\n`;
  session.dispatch('file');
  session.dispatch('next');
  await session.ops.idle();
  session.dispatch('open');
  session.draw();
  await session.ops.idle();
  session.dispatch('next');
  session.draw();
  const body = stripAnsi(session.lastFrame.rows.join('\n'));
  assert.match(body, /chg0/);
  assert.equal(body.includes('chg39'), false);
  assert.equal(session.scroll, 41);
});

test('unit view e edits the whole file and autosaves', async () => {
  const { session, repo } = await openSession([sampleItem('a.js')], {
    startPane: 'files',
  });
  repo.fileBodies['a.js'] = 'b\n';
  session.dispatch('file');
  await session.ops.idle();
  session.dispatch('next');
  await session.ops.idle();
  session.dispatch('open');
  await session.ops.idle();
  session.dispatch('code');
  await session.ops.idle();
  assert.equal(session.composeKind, 'file');
  session.editor.replace('edited\n');
  session.autosave();
  assert.equal(repo.writes.length, 1);
  assert.equal(repo.writes[0].text, 'edited\n');
  assert.equal(repo.fileBodies['a.js'], 'edited\n');
  assert.equal(repo.stagedPaths.length, 0);
  session.composer.saveCompose();
  await session.ops.idle();
  assert.deepEqual(repo.stagedPaths, ['a.js']);
  assert.equal(session.status, 'staged');
});

test('file compose keeps del and add highlighting', async () => {
  const { session, repo } = await openSession([sampleItem('a.js')], {
    startPane: 'files',
  });
  repo.fileBodies['a.js'] = 'b\nkeep\n';
  session.dispatch('file');
  session.dispatch('next');
  await session.ops.idle();
  session.dispatch('open');
  session.dispatch('code');
  await session.ops.idle();
  const types = session
    .view()
    .unitLines.map((line) => `${line.type}:${line.text}`);
  assert.deepEqual(types, ['del:a', 'add:b', 'ctx:keep', 'ctx:']);
  const del = session.view().unitLines[0];
  const add = session.view().unitLines[1];
  assert.equal(del.editStart, undefined);
  assert.equal(add.editStart, 0);
  session.editor.insert('x');
  const after = session
    .view()
    .unitLines.map((line) => `${line.type}:${line.text}`);
  assert.deepEqual(after, ['del:a', 'add:xb', 'ctx:keep', 'ctx:']);
});

test('file compose cursor stays on a trailing empty line', async () => {
  const { session, repo } = await openSession([sampleItem('a.js')], {
    startPane: 'files',
  });
  repo.fileBodies['a.js'] = 'b\nkeep\n';
  session.dispatch('file');
  session.dispatch('next');
  await session.ops.idle();
  session.dispatch('open');
  session.dispatch('code');
  await session.ops.idle();
  session.editor.cursor = session.editor.text.length;
  session.draw();
  assert.ok(session.lastFrame.cursor);
  const lines = session.view().unitLines;
  const last = lines[lines.length - 1];
  assert.equal(last.text, '');
  assert.equal(last.editLast, true);
});

test('file compose scroll follows the editor cursor', async () => {
  const { session, repo } = await openSession([sampleItem('a.js')], {
    startPane: 'files',
  });
  const rows = [];
  for (let i = 0; i < 40; i++) rows.push(`line${i}`);
  repo.fileBodies['a.js'] = `${rows.join('\n')}\n`;
  session.dispatch('file');
  session.dispatch('next');
  await session.ops.idle();
  session.dispatch('open');
  session.dispatch('code');
  await session.ops.idle();
  session.scroll = 0;
  session.editor.cursor = 0;
  for (let i = 0; i < 30; i++) session.composer.handleKey('down');
  for (let i = 0; i < 30; i++) await session.ops.idle();
  const downScroll = session.scroll;
  assert.ok(downScroll > 0);
  session.editor.cursor = 0;
  session.composer.handleKey('up');
  assert.ok(session.scroll < downScroll);
  assert.ok(session.unitLine + 1 >= session.scroll);
});

test('unit view reloads disk text in view and edit', async () => {
  const { session, repo } = await openSession([sampleItem('a.js')], {
    startPane: 'files',
  });
  repo.fileBodies['a.js'] = 'b\n';
  session.dispatch('file');
  session.dispatch('next');
  await session.ops.idle();
  session.dispatch('open');
  await session.ops.idle();
  repo.fileBodies['a.js'] = 'from-disk\n';
  session.refreshFromRepo({ keepView: true, quiet: true });
  await session.ops.idle();
  const view = session.view();
  assert.ok(view.unitLines.some((line) => line.text === 'from-disk'));
  session.dispatch('code');
  await session.ops.idle();
  repo.fileBodies['a.js'] = 'later\n';
  session.composer.applyDiskText('later\n');
  assert.equal(session.editor.text, 'later\n');
});

test('insert creates a branch, or commits, amends, or fixups', async () => {
  const branch = await openSession([sampleItem('a.js')], {
    startPane: 'files',
  });
  branch.session.pushInput('b');
  press(branch.session, 'insert');
  await branch.session.ops.idle();
  assert.equal(branch.session.mode, 'compose');
  assert.equal(branch.session.composeKind, 'branch');
  const commits = await openSession([sampleItem('a.js', 'staged')], {
    startPane: 'files',
  });
  commits.session.pushInput('c');
  press(commits.session, 'insert');
  await commits.session.ops.idle();
  assert.equal(commits.session.commitKind, 'commit');
  commits.session.composer.closeCompose();
  commits.session.dispatch('next');
  press(commits.session, 'insert');
  assert.equal(commits.session.mode, 'confirmCommit');
  commits.session.draw();
  const headLine = stripAnsi(commits.session.lastFrame.rows.at(-2));
  assert.match(headLine, /what do you want to do\?/);
  assert.match(headLine, /esc cancel/);
  assert.match(headLine, /update {2}commit {2}amend {2}fixup/);
  press(commits.session, 'c');
  await commits.session.ops.idle();
  assert.equal(commits.session.commitKind, 'commit');
  commits.session.composer.closeCompose();
  commits.session.dispatch('next');
  press(commits.session, 'insert', 'escape');
  assert.equal(commits.session.mode, 'review');
  press(commits.session, 'insert', 'a');
  await commits.session.ops.idle();
  assert.equal(commits.session.commitCursor, 1);
  assert.equal(commits.session.commitKind, 'amend');
  commits.session.composer.closeCompose();
  commits.session.dispatch('next');
  press(commits.session, 'insert');
  assert.equal(commits.session.mode, 'confirmCommit');
  commits.session.draw();
  const older = stripAnsi(commits.session.lastFrame.rows.at(-2));
  assert.match(older, /esc cancel/);
  assert.match(older, /update {2}commit {2}amend {2}fixup/);
  press(commits.session, 'c');
  await commits.session.ops.idle();
  assert.equal(commits.session.commitKind, 'commit');
  assert.equal(commits.session.commitCursor, 0);
  commits.session.composer.closeCompose();
  commits.session.dispatch('next');
  commits.session.dispatch('next');
  press(commits.session, 'insert', 'a');
  await commits.session.ops.idle();
  assert.equal(commits.session.commitCursor, 1);
  assert.equal(commits.session.commitKind, 'amend');
  commits.session.composer.closeCompose();
  commits.session.dispatch('next');
  press(commits.session, 'insert', 'f');
  await commits.session.ops.idle();
  assert.equal(commits.session.commitCursor, 2);
  assert.equal(commits.session.commitKind, 'fixup');
});

test('insert update keeps the commit and takes staged changes', async () => {
  const head = 'aaa1111aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const older = 'bbb2222bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  const { session, repo } = await openSession([sampleItem('a.js', 'staged')], {
    startPane: 'files',
  });
  session.pushInput('c');
  await session.ops.idle();
  session.dispatch('next');
  await session.ops.idle();
  press(session, 'insert');
  await session.ops.idle();
  assert.equal(session.mode, 'confirmCommit');
  press(session, 'enter');
  await session.ops.idle();
  assert.equal(session.mode, 'review');
  assert.equal(session.status, 'updated');
  assert.deepEqual(repo.updates, [head]);
  session.dispatch('next');
  await session.ops.idle();
  press(session, 'insert');
  await session.ops.idle();
  press(session, 'u');
  await session.ops.idle();
  assert.deepEqual(repo.updates, [head, older]);
  press(session, 'insert');
  await session.ops.idle();
  clickStatusChoice(session, 'u');
  await session.ops.idle();
  assert.deepEqual(repo.updates, [head, older, older]);
  const bare = await openSession([sampleItem('a.js')], { startPane: 'files' });
  bare.session.pushInput('c');
  bare.session.dispatch('next');
  press(bare.session, 'insert', 'enter');
  await bare.session.ops.idle();
  assert.equal(bare.session.status, 'nothing to commit');
  assert.deepEqual(bare.repo.updates, []);
});

test('new branch action asks for a name', async () => {
  const { session, repo } = await openSession([sampleItem('a.js')], {
    startPane: 'files',
  });
  session.pushInput('b');
  await session.ops.idle();
  session.dispatch('newBranch');
  await session.ops.idle();
  assert.equal(session.pane, 'branches');
  assert.equal(session.mode, 'compose');
  assert.equal(session.composeKind, 'branch');
  session.pushInput('topic');
  await session.ops.idle();
  press(session, 'enter');
  await session.ops.idle();
  assert.deepEqual(repo.created, ['topic']);
  assert.equal(repo.listed.length, 2);
  assert.equal(session.pane, 'branches');
  assert.equal(session.mode, 'review');
  assert.match(session.status, /created topic/);
});

test('branch list r rebases current onto selected', async () => {
  const { session, repo } = await openSession([sampleItem('a.js')], {
    startPane: 'files',
  });
  session.pushInput('b');
  await session.ops.idle();
  session.pushInput('e');
  await session.ops.idle();
  assert.equal(repo.rebases.length, 0);
  session.dispatch('next');
  await session.ops.idle();
  session.pushInput('e');
  await session.ops.idle();
  assert.deepEqual(repo.rebases, ['feat']);
  assert.equal(repo.listed.length, 2);
  assert.match(session.status, /rebased onto feat/);
  assert.equal(session.pane, 'branches');
});

test('branch list delete asks to delete the selected branch', async () => {
  const { session, repo } = await openSession([sampleItem('a.js')], {
    startPane: 'files',
  });
  session.pushInput('b');
  await session.ops.idle();
  press(session, 'delete');
  await session.ops.idle();
  assert.equal(session.mode, 'review');
  assert.equal(repo.drops.length, 0);
  session.dispatch('next');
  await session.ops.idle();
  press(session, 'delete');
  await session.ops.idle();
  assert.equal(session.mode, 'confirmDrop');
  assert.equal(session.dropName, 'feat');
  session.pushInput('n');
  await session.ops.idle();
  assert.equal(session.mode, 'review');
  assert.equal(repo.drops.length, 0);
  press(session, 'delete');
  await session.ops.idle();
  press(session, 'escape');
  await session.ops.idle();
  assert.equal(session.mode, 'review');
  assert.equal(repo.drops.length, 0);
  press(session, 'delete');
  await session.ops.idle();
  session.pushInput('y');
  await session.ops.idle();
  assert.deepEqual(repo.drops, ['feat']);
  assert.match(session.status, /dropped feat/);
  assert.equal(session.pane, 'branches');
});

test('click drop prompt y and n', async () => {
  const { session, repo } = await openSession([sampleItem('a.js')], {
    startPane: 'files',
  });
  session.pushInput('b');
  await session.ops.idle();
  session.dispatch('next');
  press(session, 'delete');
  clickStatusChoice(session, 'n');
  assert.equal(session.mode, 'review');
  assert.equal(repo.drops.length, 0);
  press(session, 'delete');
  clickStatusChoice(session, 'y');
  assert.deepEqual(repo.drops, ['feat']);
});

test('escape from branch list returns to files', async () => {
  const { session } = await openSession([sampleItem('a.js')], {
    startPane: 'files',
  });
  session.pushInput('b');
  await session.ops.idle();
  assert.equal(session.pane, 'branches');
  press(session, 'escape');
  assert.equal(session.pane, 'files');
});

test('read only keeps the branch screen closed', async () => {
  const { session } = await openSession([sampleItem('a.js')], {
    startPane: 'files',
    readOnly: true,
  });
  session.pushInput('b');
  assert.equal(session.pane, 'files');
  assert.equal(session.status, 'read only');
});

test('ops runner releases busy if after throws', async () => {
  const runner = new OpsRunner({
    top: '/tmp',
    done: false,
    mode: 'review',
    status: '',
    paint: () => {},
    startProgress: () => {},
    stopProgress: () => {},
  });
  await assert.rejects(
    () =>
      runner.runBusy(
        'pulling',
        'pulled',
        async () => {},
        () => {
          throw new Error('follow-up failed');
        },
      ),
    /follow-up failed/,
  );
  assert.equal(runner.gitBusy, false);
  assert.equal(runner.busy, '');
});

test('partial file add reloads after a later hunk fails', async () => {
  const first = sampleItem('a.js');
  const second = sampleItem('a.js');
  second.blockId = 1;
  second.hunk = {
    ...second.hunk,
    oldStart: 10,
    newStart: 10,
    header: '@@ -10,1 +10,1 @@',
  };
  const other = sampleItem('b.js');
  const staged = new Set();
  let loads = 0;
  const snapshot = () => {
    loads += 1;
    const a1 = { ...first, origin: staged.has(0) ? 'staged' : 'unstaged' };
    const a2 = {
      ...second,
      origin: staged.has(1) ? 'staged' : 'unstaged',
      blockId: 1,
      hunk: second.hunk,
    };
    return { top: '/tmp', items: [a1, a2, other], branch: 'main' };
  };
  const repo = {
    load: snapshot,
    add: (top, item) => {
      if (item.blockId === 1) throw new Error('patch failed');
      staged.add(item.blockId ?? 0);
    },
    unstage: () => {},
    revert: () => {},
    revertFile: () => {},
  };
  const { session } = await openSession([first, second, other], {
    startPane: 'files',
    repo,
  });
  const before = loads;
  session.dispatch('add');
  await session.ops.idle();
  assert.equal(session.status, 'patch failed');
  assert.ok(loads > before);
  assert.equal(session.items[0].origin, 'staged');
  assert.equal(session.items[1].origin, 'unstaged');
  assert.equal(session.items[1].blockId, 1);
});

test('ctrl+d and a checkbox click toggle a task', async () => {
  const { session, stdout } = await openSession([sampleItem('a.js')]);
  stdout.columns = 100;
  session.dispatch('tasks');
  session.pushInput('ship it');
  press(session, 'ctrl-d');
  assert.equal(session.notes.tasks[0].done, true);
  assert.equal(session.editor.text, 'ship it');
  session.draw();
  const body = stripAnsi(session.lastFrame.rows.join('\n'));
  assert.match(body, /\[x\] ship it/);
  assert.doesNotMatch(body.split('\n').at(-1), /space/);
  press(session, 'ctrl-d');
  assert.equal(session.notes.tasks[0].done, false);
  session.draw();
  const box = session.lastFrame.taskHits.find((row) => row.check);
  assert.ok(box);
  click(session, box.x0 + 1, box.y);
  assert.equal(session.notes.tasks[0].done, true);
  assert.equal(session.notes.tasks[0].text, 'ship it');
  const loaded = parseReview(
    serializeReview(session.notes),
    session.notes.reviewPath,
  );
  assert.equal(loaded.tasks[0].done, true);
  assert.equal(loaded.tasks[0].text, 'ship it');
  press(session, 'end', 'x', ' ');
  assert.equal(session.mode, 'compose');
  assert.equal(session.editor.text, 'ship itx ');
  assert.equal(session.notes.tasks[0].done, true);
});

test('l toggles the theme and is typed as text while composing', async () => {
  const { session } = await openSession([sampleItem('a.js')]);
  try {
    session.pushInput('l');
    assert.equal(themeName(), 'light');
    assert.equal(session.status, 'light');
    session.pushInput('l');
    assert.equal(themeName(), 'dark');
    assert.equal(session.status, 'dark');
    session.dispatch('feedback');
    press(session, 'l');
    assert.equal(session.mode, 'compose');
    assert.equal(session.editor.text, 'l');
    assert.equal(themeName(), 'dark');
  } finally {
    setTheme('dark');
  }
});

test('packages screen manages dependencies', async () => {
  const stdout = uiSink();
  stdout.columns = 160;
  stdout.rows = 24;
  const { session, repo } = await openSession([sampleItem('a.js')], {
    startPane: 'files',
    stdout,
    outdatedMap: new Map([
      ['leftpad', { current: '1.0.0', wanted: '1.2.0', latest: '2.0.0' }],
    ]),
  });
  session.dashboard.npm = {
    ready: true,
    hasManifest: true,
    deps: 1,
    dev: 1,
    modules: {
      bytes: 20,
      count: 2,
      packages: [
        { name: 'leftpad', bytes: 14, version: '1.0.0', dev: false },
        { name: 'eslint', bytes: 6, version: '8.0.0', dev: true },
      ],
    },
  };
  const calls = [];
  let gate = null;
  repo.runPackage = (cwd, args) => {
    calls.push(args);
    if (!gate) return Promise.resolve({ status: 0, stdout: '', stderr: '' });
    const pending = gate;
    gate = null;
    return pending;
  };
  session.dashboard.openPackages();
  session.draw();
  const rows = session.lastFrame.rows.map((row) => stripAnsi(row));
  const table = rows.slice(1, -2).join('\n');
  const status = rows.at(-2);
  assert.match(status, /deps: 1 {2}dev: 1 {2}all: 2 \(20\) {2}⚠️ 1\s*$/);
  assert.match(status, /^ \S+\s{2,}deps: 1/);
  assert.equal(table.includes('deps:'), false);
  assert.match(table, /^ {2}name/m);
  assert.match(table, /current/);
  assert.match(table, /^ {2}leftpad/m);
  assert.equal(table.includes('▶'), false);
  assert.match(rows.at(-1), /insert/);
  assert.match(rows.at(-1), /delete/);
  assert.match(rows.at(-1), /wanted/);
  assert.match(rows.at(-1), /latest/);
  let release = null;
  gate = new Promise((resolve) => {
    release = resolve;
  });
  press(session, 'w');
  assert.equal(session.busy, 'npm i');
  release({ status: 0, stdout: '', stderr: '' });
  await session.packages.job;
  assert.deepEqual(calls[0], ['update', 'leftpad']);
  press(session, 'l');
  await session.packages.job;
  assert.deepEqual(calls.at(-1), ['install', 'leftpad@latest']);
  press(session, 'j', 'l');
  await session.packages.job;
  assert.deepEqual(calls.at(-1), ['install', 'eslint@latest', '--save-dev']);
  press(session, 'k', 'delete');
  assert.equal(session.mode, 'confirmDrop');
  session.draw();
  const prompt = stripAnsi(session.lastFrame.rows.at(-2));
  assert.match(prompt, /drop leftpad\? y\/n/);
  session.pushInput('n');
  assert.equal(session.mode, 'review');
  assert.equal(calls.length, 3);
  press(session, 'delete');
  session.pushInput('y');
  await session.packages.job;
  assert.deepEqual(calls.at(-1), ['uninstall', 'leftpad']);
  press(session, 'insert');
  assert.equal(session.composeKind, 'package');
  session.draw();
  const editing = session.lastFrame.rows.map((row) => stripAnsi(row));
  const editY = session.lastFrame.editHits[0].y - 1;
  const leftY = editing.findIndex((line) => line.includes('leftpad'));
  const eslintY = editing.findIndex((line) => line.includes('eslint'));
  assert.equal(editY, leftY - 1);
  assert.ok(leftY < eslintY);
  session.pushInput('ms');
  press(session, 'enter');
  await session.packages.job;
  assert.deepEqual(calls.at(-1), ['install', 'ms']);
  press(session, 'j', 'insert');
  session.draw();
  const devEdit = session.lastFrame.rows.map((row) => stripAnsi(row));
  const devY = session.lastFrame.editHits[0].y - 1;
  const leftDev = devEdit.findIndex((line) => line.includes('leftpad'));
  const eslintDev = devEdit.findIndex((line) => line.includes('eslint'));
  assert.ok(leftDev < devY);
  assert.equal(devY, eslintDev - 1);
  session.pushInput('chalk');
  press(session, 'enter');
  await session.packages.job;
  assert.deepEqual(calls.at(-1), ['install', 'chalk', '--save-dev']);
  press(session, 'insert', 'enter');
  assert.equal(session.status, 'name');
  assert.equal(calls.length, 6);
});

test('package ranges batch updates and preserve dev groups', async () => {
  const { session, repo } = await openSession([sampleItem('a.js')]);
  session.dashboard.npm = {
    hasManifest: true,
    deps: 2,
    dev: 1,
    modules: {
      bytes: 30,
      count: 3,
      packages: [
        { name: 'one', bytes: 10, version: '1.0.0' },
        { name: 'two', bytes: 10, version: '1.0.0' },
        { name: 'dev', bytes: 10, version: '1.0.0', dev: true },
      ],
    },
  };
  const calls = [];
  repo.runPackage = async (top, args) => {
    calls.push(args);
    return { status: 0 };
  };
  const select = () => press(session, 'home', 'shift-end');
  session.dashboard.openPackages();
  select();
  session.draw();
  assert.ok(!session.lastFrame.buttons.some((hit) => hit.id === 'packageNew'));
  press(session, 'insert');
  assert.equal(session.mode, 'review');
  press(session, 'w');
  await session.packages.job;
  await session.ops.idle();
  assert.deepEqual(calls, [['update', 'one', 'two', 'dev']]);
  select();
  press(session, 'l');
  await session.packages.job;
  await session.ops.idle();
  assert.deepEqual(calls.slice(1), [
    ['install', 'one@latest', 'two@latest'],
    ['install', 'dev@latest', '--save-dev'],
  ]);
  select();
  press(session, 'delete', 'n');
  assert.equal(calls.length, 3);
  press(session, 'delete', 'y');
  await session.packages.job;
  await session.ops.idle();
  assert.deepEqual(calls.at(-1), ['uninstall', 'one', 'two', 'dev']);
});

test('package operations refresh installed versions and rows', async () => {
  const { session, repo, cwd } = await openSession([sampleItem('a.js')]);
  const lock = path.join(cwd, 'node_modules', '.package-lock.json');
  const manifest = path.join(cwd, 'package.json');
  const packageDir = path.join(cwd, 'node_modules', 'one');
  fs.mkdirSync(packageDir, { recursive: true });
  fs.writeFileSync(path.join(packageDir, 'index.js'), 'module.exports = 1;');
  const write = (version) => {
    const packages = version ? { 'node_modules/one': { version } } : {};
    const dependencies = version ? { one: '^1.0.0' } : {};
    fs.writeFileSync(manifest, JSON.stringify({ dependencies }));
    fs.writeFileSync(lock, JSON.stringify({ packages }));
  };
  write('1.0.0');
  session.dashboard.runNpm = Dashboard.prototype.runNpm.bind(session.dashboard);
  await session.dashboard.runNpm(true);
  session.dashboard.openPackages();
  session.outdatedMap = new Map([
    ['one', { current: '0.9.0', wanted: '1.1.0', latest: '2.0.0' }],
  ]);
  repo.runPackage = async (top, args) => {
    if (args[0] === 'update') write('1.1.0');
    if (args[0] === 'install') write('2.0.0');
    if (args[0] === 'uninstall') {
      write(null);
      fs.rmSync(packageDir, { recursive: true });
    }
    return { status: 0 };
  };
  for (const [key, version] of [
    ['w', '1.1.0'],
    ['l', '2.0.0'],
  ]) {
    press(session, key);
    await session.packages.job;
    await session.ops.idle();
    assert.equal(session.view().packages.modules.packages[0].current, version);
  }
  press(session, 'delete', 'y');
  await session.packages.job;
  await session.ops.idle();
  assert.deepEqual(session.view().packages.modules.packages, []);
  assert.equal(session.nav.packagesCursor, 0);
});

test('delete refuses a transitive package', async () => {
  const { session } = await openSession([sampleItem('a.js')], {
    startPane: 'files',
  });
  session.dashboard.npm = {
    ready: true,
    hasManifest: true,
    deps: 1,
    dev: 0,
    modules: {
      bytes: 4,
      count: 1,
      packages: [
        {
          name: 'three',
          bytes: 4,
          version: '1.0.0',
          dev: false,
          transitive: true,
          chain: 'one 🢒 two 🢒 three',
        },
      ],
    },
  };
  session.dashboard.openPackages();
  press(session, 'delete');
  assert.equal(session.mode, 'review');
  assert.equal(session.status, 'transitive');
  press(session, 'insert');
  assert.equal(session.mode, 'review');
  assert.equal(session.composeKind, null);
  assert.equal(session.status, 'transitive');
  session.draw();
  const insert = session.lastFrame.buttons.find(
    (hit) => hit.id === 'packageNew',
  );
  assert.equal(insert, undefined);
});

test('files pane r opens npm scripts and bins', async () => {
  const { session, cwd, repo, stdout } = await openSession(
    [sampleItem('a.js')],
    {
      startPane: 'files',
    },
  );
  stdout.columns = 120;
  fs.writeFileSync(
    path.join(cwd, 'package.json'),
    `${JSON.stringify({
      scripts: { test: 'node --test', lint: 'eslint .' },
      dependencies: { leftpad: '1.0.0' },
    })}\n`,
  );
  const dep = path.join(cwd, 'node_modules', 'leftpad');
  fs.mkdirSync(dep, { recursive: true });
  fs.writeFileSync(
    path.join(dep, 'package.json'),
    `${JSON.stringify({ name: 'leftpad', bin: { leftpad: 'bin.js' } })}\n`,
  );
  session.pushInput('r');
  assert.equal(session.pane, 'npm');
  session.draw();
  let body = stripAnsi(session.lastFrame.rows.join('\n'));
  assert.match(body, /test/);
  assert.match(body, /lint/);
  assert.match(body, /leftpad/);
  assert.match(body, /: run /);
  assert.ok(!body.includes(' q'));
  session.pushInput('e');
  assert.equal(session.mode, 'compose');
  assert.equal(session.editor.text, 'test');
  session.draw();
  body = stripAnsi(session.lastFrame.rows.join('\n'));
  assert.match(body, /node --test/);
  session.editor.replace('bad name');
  press(session, 'enter');
  assert.equal(session.mode, 'compose');
  assert.equal(session.status, 'name');
  session.editor.replace('test');
  press(session, 'enter');
  assert.equal(session.mode, 'compose');
  assert.equal(session.editor.text, 'node --test');
  const nameCursor = session.lastFrame.cursor;
  session.draw();
  assert.ok(session.lastFrame.cursor.x > (nameCursor?.x ?? 0));
  session.editor.replace('node --test test');
  press(session, 'enter');
  assert.equal(session.mode, 'review');
  const file = path.join(cwd, 'package.json');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.scripts.test, 'node --test test');
  press(session, 'ctrl-down');
  const order = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(order.scripts), ['lint', 'test']);
  press(session, 'delete');
  assert.equal(session.mode, 'confirmDrop');
  session.pushInput('n');
  assert.equal(session.mode, 'review');
  assert.equal(order.scripts.lint, 'eslint .');
  press(session, 'end');
  session.pushInput('e');
  assert.equal(session.status, 'not a script');
  press(session, 'home');
  const ran = [];
  let written = null;
  repo.runNpmCommand = (root, entry, onData, onClose) => {
    ran.push(entry.name);
    const lines = [
      '✔ passes',
      `${root}/lib/app.js:4`,
      '✖ fails',
      'Error: boom',
    ];
    const text = lines.join('\n');
    onData(text);
    written = onClose({ status: 1, text });
    return { kill() {} };
  };
  press(session, 'enter');
  assert.deepEqual(ran, ['lint']);
  assert.equal(session.view().npmView, false);
  press(session, 'right', 'enter');
  session.draw();
  body = stripAnsi(session.lastFrame.rows.join('\n'));
  assert.match(body, /lib\/app\.js:4/);
  assert.match(body, /Error: boom/);
  assert.match(body, /exit 1/);
  assert.ok(!body.includes('✔'));
  assert.ok(!body.includes(cwd));
  const stamp = today();
  await written;
  const logPath = path.join(cwd, '.log', `${stamp}-lint-01.log`);
  const log = fs.readFileSync(logPath, 'utf8');
  assert.match(log, /exit 1/);
  assert.ok(!log.includes('✔'));
  press(session, 'escape');
  assert.equal(session.pane, 'npm');
  assert.equal(session.view().npmView, false);
  press(session, 'ctrl-c');
  assert.equal(session.done, false);
  session.dispatch('quit');
  assert.equal(session.done, true);
});

test('npm output v toggles raw text until the screen closes', async () => {
  const { session, cwd, repo, stdout } = await openSession(
    [sampleItem('a.js')],
    {
      startPane: 'files',
    },
  );
  stdout.columns = 400;
  fs.writeFileSync(
    path.join(cwd, 'package.json'),
    `${JSON.stringify({ scripts: { test: 'node --test' } })}\n`,
  );
  const raw = ['✔ passes', `${cwd}/lib/app.js:4`, '✖ fails'].join('\n');
  repo.runNpmCommand = (root, entry, onData, onClose) => {
    onData(raw);
    onClose({ status: 1, text: raw });
    return { kill() {} };
  };
  session.pushInput('r');
  press(session, 'enter');
  assert.equal(session.view().npmView, false);
  press(session, 'right', 'enter');
  session.draw();
  let body = stripAnsi(session.lastFrame.rows.join('\n'));
  assert.ok(!body.includes('✔'));
  assert.match(body, /exit 1/);
  const footer = () => stripAnsi(session.lastFrame.rows.at(-1));
  assert.match(footer(), /verbose/);
  press(session, 'v');
  assert.equal(session.status, 'verbose');
  session.draw();
  body = stripAnsi(session.lastFrame.rows.join('\n'));
  assert.match(body, /✔ passes/);
  assert.match(body, /lib\/app\.js:4/);
  press(session, 'v');
  assert.equal(session.status, 'filtered');
  session.draw();
  body = stripAnsi(session.lastFrame.rows.join('\n'));
  assert.ok(!body.includes('✔'));
  press(session, 'v', 'r');
  session.draw();
  body = stripAnsi(session.lastFrame.rows.join('\n'));
  assert.match(body, /✔ passes/);
  press(session, 'escape');
  assert.equal(session.view().npmView, false);
  press(session, 'enter');
  session.draw();
  body = stripAnsi(session.lastFrame.rows.join('\n'));
  assert.ok(!body.includes('✔'));
  assert.match(body, /exit 1/);
});

for (const kind of ['script', 'command']) {
  test(`solve saves a failed ${kind} in the current plan`, async () => {
    const { session, cwd } = await openSession([sampleItem('a.js')], {
      startPane: 'files',
    });
    const tasks = session.composer.tasks;
    tasks.createPlan();
    const reviewPath = session.notes.reviewPath;
    session.notes.addTask('tasks', 'Keep existing task');
    const raw = [
      'TAP version 13',
      'ok 1 passing test',
      'not ok 2 broken parser',
      '  ---',
      '  error: parser exploded',
      '  code: ERR_ASSERTION',
      '  ...',
      '1..2',
      '# tests 2',
      '# pass 1',
      '# fail 1',
    ].join('\n');
    session.npm.runs.push({
      id: 1,
      name: 'test',
      kind,
      command: kind === 'command' ? 'node --test test/parser.test.js' : '',
      label: 'npm run test',
      status: 'exited',
      exit: 1,
      raw: kind === 'command' ? `\x1b[31m${cwd}/app.js:4: boom\x1b[0m` : raw,
      top: cwd,
    });
    session.npm.open();
    session.npm.openView(1);
    session.npm.verbose = true;
    session.draw();
    const ids = session.lastFrame.buttons.map((hit) => hit.id);
    assert.ok(ids.includes('npmSolve'));
    assert.ok(!ids.includes('npmStop'));
    if (kind === 'command') clickFooter(session, 'npmSolve');
    else session.pushInput('s');
    assert.equal(session.pane, 'tasks');
    assert.equal(session.mode, 'compose');
    assert.equal(session.notes.reviewPath, reviewPath);
    const bug = session.notes.tasks.find((task) => task.kind === 'bugs');
    assert.ok(bug);
    assert.equal(bug.done, false);
    assert.equal(tasks.rowAt(session.tasksFocus).task.id, bug.id);
    if (kind === 'command') {
      assert.match(bug.text, /node --test test\/parser.test.js failed/);
      assert.match(bug.text, /app.js:4: boom/);
      assert.ok(!bug.text.includes(cwd));
      assert.ok(!bug.text.includes('\x1b'));
    } else {
      assert.match(bug.text, /npm run test failed/);
      assert.match(bug.text, /broken parser/);
      assert.match(bug.text, /parser exploded/);
      assert.ok(!bug.text.includes('passing test'));
    }
    const disk = parseReview(fs.readFileSync(reviewPath, 'utf8'), reviewPath);
    assert.equal(disk.tasks.length, 2);
    assert.ok(disk.tasks.some((task) => task.kind === 'bugs'));
  });
}

test('solve bounds output and ignores passed and stopped runs', async () => {
  const { session } = await openSession([sampleItem('a.js')]);
  session.npm.runs.push({
    id: 1,
    name: 'build',
    kind: 'script',
    status: 'exited',
    exit: 0,
    output: `build failed\n${'x'.repeat(10000)}`,
  });
  session.npm.open();
  session.npm.openView(1);
  session.pushInput('s');
  assert.equal(session.pane, 'npm');
  assert.equal(session.notes.tasks.length, 0);
  const run = session.npm.viewedRun();
  run.status = 'stopped';
  run.exit = '';
  session.pushInput('s');
  assert.equal(session.notes.tasks.length, 0);
  run.status = 'exited';
  run.exit = '1';
  session.pushInput('s');
  assert.equal(session.pane, 'tasks');
  const bug = session.notes.tasks[0];
  assert.match(bug.text, /build failed/);
  assert.match(bug.text, /truncated/);
  assert.ok(bug.text.length < 6200);
});

test('a saved test run shows the styled report, not Markdown', async () => {
  const { session, cwd } = await openSession([sampleItem('a.js')]);
  const tap = [
    'TAP version 13',
    'not ok 1 - broken parser',
    '  ---',
    '  name: AssertionError',
    '  error: Expected 3, got 4',
    '  code: ERR_ASSERTION',
    '  operator: strictEqual',
    '  expected: 3',
    '  actual: 4',
    '  ...',
    '1..1',
  ].join('\n');
  const dir = path.join(cwd, '.log');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 't-01.log'), 'Reduced output;\n\n# test\n');
  fs.writeFileSync(path.join(dir, 't-01.raw'), tap);
  session.npm.runs.push({
    id: 1,
    name: 'test',
    kind: 'script',
    command: 'node --test',
    label: 'npm run test',
    status: 'exited',
    exit: 1,
    logName: 't-01.log',
    rawName: 't-01.raw',
    top: cwd,
  });
  session.npm.open();
  session.npm.openView(1);
  const output = session.npm.output;
  assert.ok(output.includes(TABLE_KEY));
  assert.ok(!output.includes('Reduced output'));
  assert.match(stripAnsi(output), /✖ test/);
});

const frameBody = (session) => {
  session.draw();
  const bodyH = session.lastFrame.bodyH;
  const rows = session.lastFrame.rows.slice(1, 1 + bodyH);
  return rows.map((row) => stripAnsi(row));
};

test('esc leaves a running npm command in the background', async () => {
  const { session, cwd, repo } = await openSession([sampleItem('a.js')], {
    startPane: 'files',
  });
  fs.writeFileSync(
    path.join(cwd, 'package.json'),
    `${JSON.stringify({ scripts: { test: 'node --test' } })}\n`,
  );
  let close = null;
  let push = null;
  let killed = false;
  let starts = 0;
  repo.runNpmCommand = (root, entry, onData, onClose) => {
    starts += 1;
    push = onData;
    onData('hello\n');
    close = onClose;
    return {
      kill() {
        killed = true;
      },
    };
  };
  session.pushInput('r');
  press(session, 'enter');
  assert.equal(session.view().npmView, false);
  assert.equal(session.view().npmRunning, true);
  press(session, 'right', 'enter');
  session.draw();
  const footer = () => stripAnsi(session.lastFrame.rows.at(-1));
  const hitIds = () => session.lastFrame.buttons.map((hit) => hit.id);
  assert.match(footer(), /^ 🢐esc {2}/);
  assert.match(footer(), /verbose {2}stop {2}re-run/);
  assert.ok(!footer().includes('edit'));
  assert.ok(!footer().includes('new'));
  assert.equal(hitIds()[0], 'back');
  assert.ok(hitIds().includes('npmStop'));
  assert.ok(hitIds().includes('npmRerun'));
  press(session, 'r');
  assert.equal(starts, 2);
  assert.equal(session.view().npmRunning, true);
  assert.equal(session.npm.runs.length, 2);
  press(session, 'escape');
  assert.equal(killed, false);
  assert.equal(session.view().npmView, false);
  assert.equal(session.npm.running, true);
  assert.equal(session.status, '');
  let text = frameBody(session).join('\n');
  assert.match(text, /test/);
  assert.equal(text.match(/⠋/g).length, 2);
  press(session, 'right', 'enter');
  assert.equal(session.view().npmView, true);
  press(session, 's');
  assert.equal(killed, true);
  assert.equal(session.view().npmView, true);
  assert.equal(session.view().npmRunning, false);
  assert.equal(session.status, 'terminated');
  text = frameBody(session).join('\n');
  assert.match(text, /hello/);
  assert.match(text, /terminated/);
  push('hello\nmore\n');
  text = frameBody(session).join('\n');
  assert.match(text, /hello/);
  assert.match(text, /terminated/);
  assert.ok(!text.includes('more'));
  close({ status: null, text: 'hello\nlate\n' });
  assert.equal(session.view().npmView, true);
  text = frameBody(session).join('\n');
  assert.match(text, /hello/);
  assert.match(text, /terminated/);
  assert.ok(!text.includes('late'));
  assert.ok(!text.includes('more'));
  assert.ok(!text.includes('exit null'));
  session.draw();
  assert.match(footer(), /🢐esc/);
  assert.match(footer(), /stop/);
  assert.ok(!footer().includes('⊗'));
  let hits = hitIds();
  assert.equal(hits[0], 'back');
  assert.ok(!hits.includes('npmStop'));
  assert.ok(hits.includes('npmRerun'));
  assert.ok(!hits.includes('npmEdit'));
  const runs = [];
  repo.runNpmCommand = (root, entry, onData, onClose) => {
    runs.push(entry.name);
    onData('again\n');
    return {
      kill() {
        onClose({ status: null, text: 'again\n' });
      },
    };
  };
  press(session, 'r');
  assert.deepEqual(runs, ['test']);
  assert.equal(session.view().npmRunning, true);
  press(session, 's');
  assert.equal(session.view().npmView, true);
  assert.equal(session.status, 'terminated');
  session.draw();
  hits = hitIds();
  assert.ok(!hits.includes('npmStop'));
  assert.ok(hits.includes('npmRerun'));
  press(session, 'escape');
  assert.equal(session.view().npmView, false);
  assert.equal(session.pane, 'npm');
  text = frameBody(session).join('\n');
  assert.match(text, /⠋/);
  assert.match(text, /⊘/);
});

test('npm sessions survive a restart', async () => {
  const { session, cwd, repo } = await openSession([sampleItem('a.js')], {
    startPane: 'files',
  });
  fs.writeFileSync(
    path.join(cwd, 'package.json'),
    `${JSON.stringify({
      scripts: { test: 'node --test', lint: 'eslint .' },
    })}\n`,
  );
  let written = null;
  repo.runNpmCommand = (root, entry, onData, onClose) => {
    onData('hello from test\n');
    written = onClose({ status: 0, text: 'hello from test\n' });
    return { kill() {} };
  };
  session.pushInput('r');
  press(session, 'enter');
  await written;
  press(session, 'escape');
  const again = await openSession([sampleItem('a.js')], {
    cwd,
    repo,
    startPane: 'files',
  });
  again.session.pushInput('r');
  let body = frameBody(again.session).join('\n');
  assert.match(body, /✔/);
  assert.match(body, /exit 0/);
  assert.ok(!body.includes('hello from test'));
  press(again.session, 'right', 'enter');
  assert.equal(again.session.view().npmView, true);
  body = frameBody(again.session).join('\n');
  assert.match(body, /hello from test/);
  assert.match(body, /exit 0/);
  press(again.session, 'v');
  body = frameBody(again.session).join('\n');
  assert.match(body, /hello from test/);
});

test('npm history keeps the newest 50 runs', async () => {
  const { session, cwd } = await openSession([sampleItem('a.js')], {
    startPane: 'files',
  });
  fs.writeFileSync(
    path.join(cwd, 'package.json'),
    `${JSON.stringify({ scripts: { test: 'node --test' } })}\n`,
  );
  session.pushInput('r');
  for (let i = 0; i < 51; i++) {
    session.npm.runs.push({
      id: i + 1,
      name: 'test',
      kind: 'script',
      command: 'node --test',
      status: 'exited',
      exit: i,
      startedAt: i + 1,
      endedAt: i + 2,
    });
  }
  const rows = session.npm.sessionRows();
  assert.equal(rows.length, 50);
  assert.equal(rows[0].total, 'exit 50');
  assert.equal(rows[0].mark, 'fail');
  assert.equal(rows[0].name, 'test');
  assert.equal(rows.at(-1).total, 'exit 1');
  assert.ok(rows[0].elapsed);
  assert.ok(rows[0].when);
});

test('npm history shows a command when it has no script name', async () => {
  const { session, cwd } = await openSession([sampleItem('a.js')], {
    startPane: 'files',
  });
  fs.writeFileSync(
    path.join(cwd, 'package.json'),
    `${JSON.stringify({ scripts: { lint: 'eslint .' } })}\n`,
  );
  const dir = path.join(cwd, '.log');
  fs.mkdirSync(dir);
  const record = {
    v: 1,
    id: 'earlier',
    command: 'reslop t -- node --test test/a.js',
    script: '',
    startedAt: 10,
    endedAt: 20,
    status: 'failed',
    exit: 1,
    progress: { done: 0, failed: 1, lines: 1 },
    log: '2026-10-10-node-01.log',
  };
  fs.writeFileSync(
    path.join(dir, '2026-10-10-node-01.json'),
    `${JSON.stringify(record)}\n`,
  );
  session.pushInput('r');
  session.npm.runs.push({
    id: 2,
    name: 'lint',
    kind: 'script',
    command: 'eslint .',
    status: 'exited',
    exit: 0,
    startedAt: 30,
    endedAt: 40,
  });
  const rows = session.npm.sessionRows();
  assert.equal(rows[0].name, 'lint');
  assert.equal(rows[0].total, 'exit 0');
  assert.equal(rows[0].mark, 'pass');
  assert.equal(rows[1].name, 'node --test test/a.js');
  assert.equal(rows[1].total, '');
  assert.equal(rows[1].done, '1');
  assert.equal(rows[1].ok, '0');
  assert.equal(rows[1].fail, '1');
  session.draw();
  const width = session.lastSize.width;
  const leftW = width - Math.floor(width * 0.7);
  const history = frameBody(session)
    .map((line) => line.slice(leftW))
    .join('\n');
  const passAt = history.indexOf('✔');
  const failAt = history.indexOf('✖');
  assert.ok(passAt >= 0 && failAt > passAt);
  assert.match(history, /exit 0/);
  assert.match(history, /command +done +ok +fail +total +duration +time/);
  assert.ok(!history.includes('reslop t'));
  assert.ok(!history.includes('……'));
});

test('a history row opens the captured log if the file is gone', async () => {
  const { session, cwd } = await openSession([sampleItem('a.js')], {
    startPane: 'files',
  });
  fs.writeFileSync(
    path.join(cwd, 'package.json'),
    `${JSON.stringify({ scripts: { test: 'reslop t -- node --test' } })}\n`,
  );
  const dir = path.join(cwd, '.log');
  fs.mkdirSync(dir);
  const failure = 'not ok 1 npm history caption\nassert.ok(failedRow)\n';
  fs.writeFileSync(path.join(dir, '2026-10-10-test-01.log'), failure);
  fs.writeFileSync(path.join(dir, '2026-10-10-test-01.raw'), failure);
  const saved = {
    reslop: 'npm-run',
    name: 'test',
    kind: 'script',
    command: 'reslop t -- node --test',
    status: 'exited',
    exit: 1,
    startedAt: 1000,
    endedAt: 5000,
    log: '2026-10-10-test-01.log',
    raw: '2026-10-10-test-01.raw',
    result: { tests: 950, passed: 949, failed: 1 },
  };
  fs.writeFileSync(
    path.join(dir, '2026-10-10-test-01.json'),
    `${JSON.stringify(saved)}\n`,
  );
  const recorded = {
    v: 1,
    id: 'inner',
    command: 'node --test',
    script: 'test',
    startedAt: 2000,
    endedAt: 4000,
    status: 'failed',
    exit: 1,
    progress: { done: 949, failed: 1, lines: 1, expected: 0 },
    result: { tests: 950, passed: 949, failed: 1 },
    log: '2026-10-10-node-01.log',
    raw: '2026-10-10-node-01.raw',
  };
  fs.writeFileSync(
    path.join(dir, '2026-10-10-node-01.json'),
    `${JSON.stringify(recorded)}\n`,
  );
  session.pushInput('r');
  const rows = session.npm.sessionRows();
  assert.equal(rows[0].name, 'test');
  assert.equal(rows[0].mark, 'fail');
  press(session, 'right', 'enter');
  assert.equal(session.view().npmView, true);
  assert.match(stripAnsi(session.npm.output), /✖ npm history caption/);
});

test('the run screen follows an outside reslop t', async () => {
  const { session, cwd } = await openSession([sampleItem('a.js')], {
    startPane: 'files',
  });
  const dir = path.join(cwd, '.log');
  fs.mkdirSync(dir);
  const file = path.join(dir, '2026-10-10-node-01.json');
  const write = (extra) => {
    const record = {
      v: 2,
      id: 'outside',
      pid: process.pid,
      command: 'node --test',
      script: 'test',
      startedAt: 5_000,
      endedAt: 0,
      activeAt: Date.now(),
      status: 'running',
      exit: null,
      progress: { done: 2, failed: 1, lines: 4, expected: 10 },
      result: null,
      log: '2026-10-10-node-01.log',
      raw: '2026-10-10-node-01.raw',
      ...extra,
    };
    fs.writeFileSync(file, `${JSON.stringify(record)}\n`);
  };
  write();
  session.pushInput('r');
  session.dashboard.noteDisk(['.log/2026-10-10-node-01.json']);
  let rows = session.npm.sessionRows();
  assert.equal(rows[0].name, 'test');
  assert.equal(rows[0].live, true);
  assert.equal(rows[0].mark, 'run');
  assert.equal(rows[0].done, '3');
  assert.equal(rows[0].ok, '2');
  assert.equal(rows[0].fail, '1');
  assert.equal(rows[0].total, '10');
  const shown = frameBody(session).join('\n');
  assert.match(shown, /⠋/);
  assert.match(shown, /test/);
  write({
    progress: { done: 4, failed: 1, lines: 8, expected: 10 },
  });
  session.dashboard.noteDisk(['.log/2026-10-10-node-01.json']);
  rows = session.npm.sessionRows();
  assert.equal(rows[0].done, '5');
  assert.equal(rows[0].ok, '4');
  assert.equal(rows[0].live, true);
  write({
    status: 'failed',
    exit: 1,
    endedAt: 8_000,
    progress: { done: 8, failed: 2, lines: 20, expected: 10 },
    result: { tests: 10, passed: 8, failed: 2 },
  });
  session.dashboard.noteDisk(['.log/2026-10-10-node-01.json']);
  rows = session.npm.sessionRows();
  assert.equal(rows[0].live, false);
  assert.equal(rows[0].mark, 'fail');
  assert.equal(rows[0].done, '10');
  assert.equal(rows[0].ok, '8');
  assert.equal(rows[0].fail, '2');
  assert.equal(rows[0].total, '10');
});

test('an interrupted run keeps its duration after a restart', async (t) => {
  const { session, cwd, repo } = await openSession([sampleItem('a.js')], {
    startPane: 'files',
  });
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const dir = path.join(cwd, '.log');
  fs.mkdirSync(dir);
  const record = {
    v: 2,
    id: 'interrupted',
    pid: process.pid,
    command: 'node --test',
    script: 'test',
    startedAt: now - 4000,
    activeAt: now,
    endedAt: 0,
    status: 'running',
    exit: null,
    progress: { done: 1, failed: 0, lines: 1 },
  };
  fs.writeFileSync(path.join(dir, 'interrupted.json'), JSON.stringify(record));
  session.pushInput('r');
  assert.equal(session.npm.sessionRows()[0].live, true);
  now += 10000;
  session.npm.refreshRecorded();
  const [stopped] = session.npm.sessionRows();
  assert.equal(stopped.live, false);
  assert.equal(stopped.mark, 'stop');
  assert.equal(stopped.elapsed, '4s');
  now += 60000;
  session.npm.refreshRecorded();
  assert.equal(session.npm.sessionRows()[0].elapsed, '4s');
  const again = await openSession([sampleItem('a.js')], {
    cwd,
    repo,
    startPane: 'files',
  });
  again.session.pushInput('r');
  const [restored] = again.session.npm.sessionRows();
  assert.equal(restored.live, false);
  assert.equal(restored.elapsed, '4s');
});

test('an open run follows the next reslop t step in its script', async () => {
  const { session, cwd } = await openSession([sampleItem('a.js')], {
    startPane: 'files',
  });
  const dir = path.join(cwd, '.log');
  fs.mkdirSync(dir);
  const write = (id, command, startedAt, endedAt, output) => {
    const record = {
      v: 1,
      id,
      pid: process.pid,
      command,
      script: 'test',
      startedAt,
      endedAt,
      status: 'passed',
      exit: 0,
      progress: { done: 0, failed: 0, lines: 0, expected: 0 },
      result: null,
      log: `${id}.log`,
      raw: `${id}.raw`,
    };
    fs.writeFileSync(
      path.join(dir, `${id}.json`),
      `${JSON.stringify(record)}\n`,
    );
    fs.writeFileSync(path.join(dir, `${id}.log`), `${output}\n`);
    fs.writeFileSync(path.join(dir, `${id}.raw`), `${output}\n`);
  };
  session.pushInput('r');
  write('lint', 'npm run -s lint', 1_000, 3_000, 'lint output');
  session.dashboard.noteDisk(['.log/lint.json', '.log/lint.log']);
  press(session, 'right', 'enter');
  assert.equal(session.npm.viewedRun().externalId, 'lint');
  assert.match(session.npm.output, /lint output/);
  write('tests', 'node --test', 4_000, 9_000, 'test output');
  session.dashboard.noteDisk(['.log/tests.json', '.log/tests.log']);
  assert.equal(session.npm.viewedRun().externalId, 'tests');
  assert.match(session.npm.output, /test output/);
});

test('a finished outside run drops the running line', async () => {
  const { session, cwd } = await openSession([sampleItem('a.js')], {
    startPane: 'files',
  });
  const dir = path.join(cwd, '.log');
  fs.mkdirSync(dir);
  const file = path.join(dir, '2026-10-10-node-01.json');
  const write = (extra) => {
    const record = {
      v: 2,
      id: 'outside',
      pid: process.pid,
      command: 'node --test',
      script: 'test',
      startedAt: 5_000,
      endedAt: 0,
      activeAt: Date.now(),
      status: 'running',
      exit: null,
      progress: { done: 1, failed: 0, lines: 2, expected: 1 },
      result: null,
      log: '2026-10-10-node-01.log',
      raw: '2026-10-10-node-01.raw',
      ...extra,
    };
    fs.writeFileSync(file, `${JSON.stringify(record)}\n`);
  };
  write();
  session.pushInput('r');
  session.dashboard.noteDisk(['.log/2026-10-10-node-01.json']);
  fs.writeFileSync(
    path.join(dir, '2026-10-10-node-01.log'),
    '# test\n\nok: true\n\nexit: 0\n',
  );
  write({
    status: 'passed',
    exit: 0,
    endedAt: 8_000,
    result: { tests: 1, passed: 1, failed: 0 },
  });
  press(session, 'right', 'enter');
  assert.equal(session.view().npmView, true);
  assert.equal(session.view().npmRunning, true);
  let text = frameBody(session).join('\n');
  assert.match(text, /exit: 0/);
  assert.match(text, /running/);
  session.tickProgress();
  assert.equal(session.view().npmRunning, false);
  assert.equal(session.npm.sessionRows()[0].live, false);
  text = frameBody(session).join('\n');
  assert.match(text, /exit: 0/);
  assert.ok(!text.includes('running'));
});

test('chained steps of one script share a history row', async () => {
  const { session, cwd } = await openSession([sampleItem('a.js')], {
    startPane: 'files',
  });
  const dir = path.join(cwd, '.log');
  fs.mkdirSync(dir);
  const record = (id, command, startedAt, endedAt, status) => ({
    v: 2,
    id,
    pid: process.pid,
    command,
    script: 'fix',
    startedAt,
    endedAt,
    activeAt: Date.now(),
    status,
    exit: status === 'running' ? null : 0,
    progress: { done: 0, failed: 0, lines: 0, expected: 0 },
    result: null,
    log: `${id}.log`,
    raw: `${id}.raw`,
  });
  const write = (id, command, startedAt, endedAt, status = 'passed') => {
    fs.writeFileSync(
      path.join(dir, `${id}.json`),
      `${JSON.stringify(record(id, command, startedAt, endedAt, status))}\n`,
    );
  };
  write('eslint', 'eslint . --fix', 1_000, 2_000);
  write('prettier', 'prettier --write .', 2_065, 0, 'running');
  session.pushInput('r');
  session.dashboard.noteDisk(['.log/eslint.json', '.log/prettier.json']);
  let rows = session.npm.sessionRows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'fix');
  assert.equal(rows[0].live, true);
  write('prettier', 'prettier --write .', 2_065, 4_000, 'passed');
  write('eslint-2', 'eslint . --fix', 12_000, 13_000);
  write('prettier-2', 'prettier --write .', 13_080, 15_000);
  session.dashboard.noteDisk(['.log/prettier.json', '.log/eslint-2.json']);
  rows = session.npm.sessionRows();
  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map((row) => row.live),
    [false, false],
  );
});

test('npm test from the ui keeps the two reslop t runs', async () => {
  const { session, cwd, repo } = await openSession([sampleItem('a.js')], {
    startPane: 'files',
  });
  fs.writeFileSync(
    path.join(cwd, 'package.json'),
    `${JSON.stringify({
      scripts: {
        lint: 'eslint .',
        test: 'reslop t -- npm run -s lint && reslop t -- node --test',
      },
    })}\n`,
  );
  let close = null;
  repo.runNpmCommand = (root, entry, onData, onClose) => {
    close = onClose;
    return { kill() {} };
  };
  session.pushInput('r');
  const testAt = session.npm.commands.findIndex(
    (entry) => entry.name === 'test',
  );
  session.nav.npmCursor = testAt;
  press(session, 'enter');
  assert.equal(session.npm.running, true);
  assert.equal(session.npm.sessionRows().length, 0);
  const dir = path.join(cwd, '.log');
  fs.mkdirSync(dir);
  const record = (id, command, script, startedAt, endedAt, extra) => ({
    v: 1,
    id,
    pid: process.pid,
    command,
    script,
    startedAt,
    endedAt,
    status: 'passed',
    exit: 0,
    progress: { done: 0, failed: 0, lines: 0, expected: 0 },
    result: null,
    log: `${id}.log`,
    raw: `${id}.raw`,
    ...extra,
  });
  fs.writeFileSync(
    path.join(dir, 'lint.json'),
    `${JSON.stringify(
      record('lint', 'npm run -s lint', 'test', 1000, 3000),
    )}\n`,
  );
  fs.writeFileSync(
    path.join(dir, 'tests.json'),
    `${JSON.stringify(
      record('tests', 'node --test', 'test', 4000, 9000, {
        result: { tests: 4, passed: 4, failed: 0 },
      }),
    )}\n`,
  );
  session.dashboard.noteDisk(['.log/lint.json', '.log/tests.json']);
  const rows = session.npm.sessionRows();
  assert.deepEqual(
    rows.map((row) => row.name),
    ['test', 'lint'],
  );
  assert.equal(rows[0].done, '4');
  assert.equal(rows[1].total, 'exit 0');
  close({ status: 0, text: 'ok\n' });
  const names = fs.readdirSync(dir);
  assert.equal(
    names.some((name) => name.includes('npm-run') || name.startsWith('2026')),
    false,
  );
  const lintAt = session.npm.commands.findIndex(
    (entry) => entry.name === 'lint',
  );
  session.nav.npmCursor = lintAt;
  let closed = null;
  repo.runNpmCommand = (root, entry, onData, onClose) => {
    closed = onClose;
    return { kill() {} };
  };
  press(session, 'enter');
  const live = session.npm.sessionRows().filter((row) => row.live);
  assert.equal(live.length, 1);
  assert.equal(live[0].name, 'lint');
  closed({ status: 0, text: '' });
  let saved = [];
  for (let i = 0; i < 20; i++) {
    saved = fs.readdirSync(dir).filter((name) => name.endsWith('.json'));
    if (saved.length >= 3) break;
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
  }
  assert.equal(saved.length, 3);
});

test('npm history counts tests and stays on the run screen', async () => {
  const { session, cwd, repo } = await openSession([sampleItem('a.js')], {
    startPane: 'files',
  });
  fs.writeFileSync(
    path.join(cwd, 'package.json'),
    `${JSON.stringify({ scripts: { test: 'node --test' } })}\n`,
  );
  let close = null;
  repo.runNpmCommand = (root, entry, onData, onClose) => {
    onData('ok 1 one\nnot ok 2 two\n');
    close = onClose;
    return { kill() {} };
  };
  session.pushInput('r');
  press(session, 'enter');
  assert.equal(session.view().npmView, false);
  let rows = session.npm.sessionRows();
  assert.equal(rows[0].mark, 'run');
  assert.equal(rows[0].done, '2');
  assert.equal(rows[0].ok, '1');
  assert.equal(rows[0].fail, '1');
  assert.equal(rows[0].exitLabel, false);
  close({ status: 1, text: 'ok 1 one\nnot ok 2 two\n' });
  rows = session.npm.sessionRows();
  assert.equal(rows[0].mark, 'fail');
  assert.equal(rows[0].exitLabel, false);
  assert.equal(rows[0].fail, '1');
  assert.equal(session.view().npmView, false);
});

test('npm output scrolls with the editor hotkeys', async () => {
  const { session, cwd, repo } = await openSession([sampleItem('a.js')], {
    startPane: 'files',
  });
  fs.writeFileSync(
    path.join(cwd, 'package.json'),
    `${JSON.stringify({ scripts: { test: 'node --test' } })}\n`,
  );
  const lines = [];
  for (let i = 0; i < 80; i++) lines.push(`row ${i}`);
  let push = null;
  repo.runNpmCommand = (root, entry, onData, onClose) => {
    push = onData;
    onData(lines.join('\n'));
    onClose({ status: 0, text: lines.join('\n') });
    return { kill() {} };
  };
  session.pushInput('r');
  press(session, 'enter', 'right', 'enter');
  session.draw();
  const page = logViewRows(session.lastFrame.bodyH);
  assert.ok(page > 1);
  const half = Math.max(1, Math.floor(page * 0.5));
  const at = () => session.view().npmScroll;
  press(session, 'home');
  assert.equal(at(), 0);
  assert.equal(session.view().npmFollow, false);
  press(session, 'up');
  assert.equal(at(), 0);
  press(session, 'down');
  assert.equal(at(), 1);
  press(session, 'ctrl-y');
  assert.equal(at(), 0);
  press(session, 'ctrl-e');
  assert.equal(at(), 1);
  press(session, 'home', 'ctrl-f');
  assert.equal(at(), page);
  press(session, 'ctrl-b');
  assert.equal(at(), 0);
  press(session, 'ctrl-d');
  assert.equal(at(), half);
  press(session, 'ctrl-u');
  assert.equal(at(), 0);
  press(session, 'pageDown');
  assert.equal(at(), page);
  press(session, 'pageUp');
  assert.equal(at(), 0);
  press(session, 'end');
  assert.equal(session.view().npmFollow, true);
  press(session, 'up');
  assert.equal(session.view().npmFollow, false);
  const stayed = at();
  push('row extra\n');
  assert.equal(at(), stayed);
  assert.equal(session.view().npmFollow, false);
  const body = frameBody(session);
  assert.equal(body[0].trim(), '');
  assert.equal(body[body.length - 1].trim(), '');
  assert.match(body[1], /^ {2}row /);
});

test('npm output animates progress until the command exits', async () => {
  const { session, cwd, repo } = await openSession([sampleItem('a.js')], {
    startPane: 'files',
  });
  fs.writeFileSync(
    path.join(cwd, 'package.json'),
    `${JSON.stringify({ scripts: { test: 'node --test' } })}\n`,
  );
  let finish = null;
  repo.runNpmCommand = (root, entry, onData, onClose) => {
    onData('hello\n');
    finish = () => onClose({ status: 0, text: 'hello\n' });
    return {
      kill() {
        finish();
      },
    };
  };
  session.pushInput('r');
  press(session, 'enter');
  assert.equal(session.view().npmView, false);
  press(session, 'right', 'enter');
  assert.equal(session.view().npmRunning, true);
  assert.equal(session.progress.size(), 1);
  let body = frameBody(session);
  const hello = body.findIndex((row) => row.includes('hello'));
  assert.match(body[hello + 1], /^ {2}running {2}·•●•·/);
  session.tickProgress();
  body = frameBody(session);
  assert.match(body[hello + 1], /^ {2}running {2}··•●•/);
  finish();
  body = frameBody(session);
  assert.equal(session.view().npmRunning, false);
  assert.equal(session.progress.size(), 0);
  const text = body.join('\n');
  assert.match(text, /hello/);
  assert.match(text, /exit 0/);
  assert.ok(!text.includes('running'));
});

test('npm screen refuses edits when read only', async () => {
  const { session, cwd } = await openSession([sampleItem('a.js')], {
    startPane: 'files',
    readOnly: true,
  });
  fs.writeFileSync(
    path.join(cwd, 'package.json'),
    `${JSON.stringify({ scripts: { test: 'node --test' } })}\n`,
  );
  session.pushInput('r');
  session.pushInput('e');
  assert.equal(session.status, 'read only');
  assert.equal(session.mode, 'review');
  press(session, 'insert');
  assert.equal(session.status, 'read only');
  press(session, 'delete');
  assert.equal(session.mode, 'review');
  press(session, 'l');
  assert.equal(session.status, 'read only');
  assert.equal(session.mode, 'review');
});

test('double click runs the selected npm command', async () => {
  const { session, cwd, repo } = await openSession([sampleItem('a.js')], {
    startPane: 'files',
  });
  fs.writeFileSync(
    path.join(cwd, 'package.json'),
    `${JSON.stringify({
      scripts: { test: 'node --test', lint: 'eslint .' },
    })}\n`,
  );
  const ran = [];
  repo.runNpmCommand = (root, entry, onData, onClose) => {
    ran.push(entry.name);
    onClose({ status: 0, text: '' });
    return { kill() {} };
  };
  session.pushInput('r');
  session.draw();
  const hits = session.lastFrame.fileHits;
  assert.ok(hits.length >= 2);
  click(session, 2, hits[1].y);
  assert.deepEqual(ran, []);
  assert.equal(session.npmCursor, hits[1].cursor);
  click(session, 2, hits[1].y);
  assert.deepEqual(ran, ['lint']);
  assert.equal(session.view().npmView, false);
});

test('delete removes the selected npm script after confirmation', async () => {
  const { session, cwd, stdout } = await openSession([sampleItem('a.js')], {
    startPane: 'files',
  });
  stdout.columns = 160;
  const file = path.join(cwd, 'package.json');
  fs.writeFileSync(
    file,
    `${JSON.stringify({
      scripts: { test: 'node --test', lint: 'eslint .' },
    })}\n`,
  );
  session.pushInput('r');
  session.draw();
  const footer = stripAnsi(session.lastFrame.rows.at(-1));
  assert.match(footer, /edit {2}insert {2}delete {2}cleanup/);
  const ids = session.lastFrame.buttons.map((hit) => hit.id);
  assert.ok(ids.includes('npmEdit'));
  assert.ok(ids.includes('npmNew'));
  assert.ok(ids.includes('npmDrop'));
  press(session, 'delete');
  assert.equal(session.mode, 'confirmDrop');
  session.pushInput('y');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.scripts.test, undefined);
  assert.equal(saved.scripts.lint, 'eslint .');
  assert.equal(session.status, 'dropped test');
});

test('dragging the scroller of a list moves its rows and cursor', async () => {
  const items = Array.from({ length: 40 }, (_, at) => sampleItem(`f${at}.js`));
  const { session } = await openSession(items, { startPane: 'files' });
  session.draw();
  const [bar] = session.lastFrame.scrollBars;
  assert.equal(bar.target, 'list');
  assert.equal(bar.start, 0);
  const mouse = (kind, y) =>
    session.handleEvent({ type: 'mouse', kind, button: 0, x: bar.x, y });
  mouse('press', bar.y + bar.track);
  session.draw();
  mouse('drag', bar.y + bar.height - 1);
  session.draw();
  mouse('release', bar.y + bar.height - 1);
  session.draw();
  const [moved] = session.lastFrame.scrollBars;
  assert.equal(moved.start, 40 - moved.rows);
  assert.equal(session.fileCursor, moved.start);
  const picked = session.fileList()[moved.start].path;
  assert.equal(session.reviewPath, picked);
});

test('dragging the packages scroller moves the package cursor', async () => {
  const packages = Array.from({ length: 40 }, (_, at) => ({
    name: `pkg${at}`,
    bytes: at + 1,
    dev: false,
    version: '1.0.0',
  }));
  const { session } = await openSession([sampleItem('a.js')], {
    startPane: 'files',
  });
  session.dashboard.npm = {
    ready: true,
    hasManifest: true,
    deps: 40,
    dev: 0,
    modules: { bytes: 40, count: 40, packages },
  };
  session.dashboard.openPackages();
  session.draw();
  const [bar] = session.lastFrame.scrollBars;
  assert.equal(bar.target, 'list');
  assert.equal(bar.start, 0);
  const mouse = (kind, y) =>
    session.handleEvent({ type: 'mouse', kind, button: 0, x: bar.x, y });
  mouse('press', bar.y + bar.track);
  session.draw();
  mouse('drag', bar.y + bar.height - 1);
  session.draw();
  mouse('release', bar.y + bar.height - 1);
  session.draw();
  const [moved] = session.lastFrame.scrollBars;
  assert.equal(moved.start, 40 - moved.rows);
  assert.equal(session.nav.packagesCursor, moved.start);
});

test('ctrl+a selects every row of a list', async () => {
  const items = [sampleItem('a.js'), sampleItem('b.js'), sampleItem('c.js')];
  const { session, cwd } = await openSession(items, { startPane: 'files' });
  press(session, 'down', 'ctrl-a');
  assert.deepEqual(session.view().listSelection, [0, 1, 2]);
  assert.equal(session.nav.multiselect, true);
  assert.equal(session.fileCursor, 1);
  press(session, 'down');
  assert.deepEqual(session.view().listSelection, []);
  session.nav.fileScope = 'file';
  session.nav.folderFocus = true;
  press(session, 'ctrl-a');
  assert.equal(session.view().folderFocus, false);
  assert.deepEqual(session.view().listSelection, [0, 1, 2]);
  const file = path.join(cwd, 'package.json');
  const scripts = { test: 'node --test', lint: 'eslint .' };
  fs.writeFileSync(file, `${JSON.stringify({ scripts })}\n`);
  session.npm.open();
  press(session, 'ctrl-a');
  assert.deepEqual(session.view().listSelection, [0, 1]);
});

test('npm and run lists select a range', async () => {
  const { session, cwd } = await openSession([sampleItem('a.js')]);
  const file = path.join(cwd, 'package.json');
  fs.writeFileSync(
    file,
    `${JSON.stringify({
      scripts: {
        test: 'node --test',
        lint: 'eslint .',
        build: 'node build.js',
      },
    })}\n`,
  );
  session.npm.open();
  press(session, 'shift-down');
  assert.deepEqual(session.view().listSelection, [0, 1]);
  session.draw();
  const ids = session.lastFrame.buttons.map((hit) => hit.id);
  assert.ok(ids.includes('npmDrop'));
  assert.ok(!ids.includes('npmEdit'));
  const cell = session.lastFrame.fileHits.find(
    (hit) => hit.side === 'commands' && hit.cursor === 2,
  );
  shiftClick(session, { x: cell.x0 + 2, y: cell.y });
  assert.deepEqual(session.view().listSelection, [0, 1, 2]);
  press(session, 'down');
  assert.deepEqual(session.view().listSelection, []);
  press(session, 'home', 'shift-down', 'delete', 'y');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(saved.scripts), ['build']);
  session.npm.runs.push(
    {
      id: 1,
      name: 'one',
      command: 'echo one',
      status: 'exited',
      startedAt: 1,
      endedAt: 2,
    },
    {
      id: 2,
      name: 'two',
      command: 'echo two',
      status: 'exited',
      startedAt: 10,
      endedAt: 12,
    },
    {
      id: 3,
      name: 'three',
      command: 'echo three',
      status: 'exited',
      startedAt: 20,
      endedAt: 22,
    },
  );
  session.npm.focusRuns();
  session.npm.runCursor = 0;
  press(session, 'shift-down');
  assert.deepEqual(session.view().listSelection, [0, 1]);
  press(session, 'delete');
  assert.equal(session.mode, 'review');
  const kept = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(kept.scripts.build, 'node build.js');
  press(session, 'down');
  assert.deepEqual(session.view().listSelection, []);
});

const daysAgoStamp = (ago) => {
  const date = new Date();
  date.setDate(date.getDate() - ago);
  return dateStamp(date);
};

test('npm screen deletes logs older than 5 days', async () => {
  const { session, cwd } = await openSession([sampleItem('a.js')], {
    startPane: 'files',
  });
  fs.writeFileSync(
    path.join(cwd, 'package.json'),
    `${JSON.stringify({ scripts: { test: 'node --test' } })}\n`,
  );
  const dir = path.join(cwd, '.log');
  fs.mkdirSync(dir);
  const stale = path.join(dir, `${daysAgoStamp(6)}-test-01.log`);
  const kept = path.join(dir, `${daysAgoStamp(5)}-test-01.log`);
  fs.writeFileSync(stale, 'abcdef');
  fs.writeFileSync(kept, 'keep');
  session.pushInput('r');
  session.draw();
  const status = () => stripAnsi(session.lastFrame.rows.at(-2));
  assert.match(status(), /old logs 6/);
  press(session, 'l');
  assert.equal(session.mode, 'confirmDrop');
  session.draw();
  assert.match(status(), /drop logs older than 5 days \(6\)\? y\/n/);
  session.pushInput('n');
  assert.equal(fs.existsSync(stale), true);
  press(session, 'l');
  session.pushInput('y');
  assert.equal(fs.existsSync(stale), false);
  assert.equal(fs.existsSync(kept), true);
  session.draw();
  assert.ok(!status().includes('old logs'));
  assert.equal(session.status, 'dropped logs');
  const hits = session.lastFrame.buttons.map((hit) => hit.id);
  assert.ok(!hits.includes('npmLogs'));
  press(session, 'l');
  assert.equal(session.status, 'dropped logs');
  assert.equal(session.mode, 'review');
});

const clickCaret = (session, dx, dy) => {
  const caret = session.lastFrame.cursor;
  assert.ok(caret);
  click(session, caret.x + dx, caret.y + dy);
};

test('click moves the caret in the code and file editors', async () => {
  const { session, repo } = await openSession([sampleItem('a.js')]);
  session.pushInput('e');
  session.editor.replace('ab\ncd');
  session.draw();
  const undo = session.editor.undo.length;
  clickCaret(session, -1, -1);
  assert.equal(session.mode, 'compose');
  assert.equal(session.editor.cursor, 1);
  assert.equal(session.editor.undo.length, undo);
  session.layout = 'side';
  session.editor.place(session.editor.text.length);
  session.draw();
  clickCaret(session, -1, 0);
  assert.equal(session.editor.cursor, 4);
  press(session, 'escape', 'escape');
  await session.ops.idle();
  repo.fileBodies['a.js'] = 'ab\ncd\n';
  session.dispatch('file');
  session.dispatch('next');
  await session.ops.idle();
  session.dispatch('open');
  session.dispatch('code');
  await session.ops.idle();
  assert.equal(session.composeKind, 'file');
  session.editor.place(2);
  session.draw();
  clickCaret(session, -2, 1);
  assert.equal(session.editor.cursor, 3);
});

test('click moves the caret in feedback and todo editors', async () => {
  const { session } = await openSession([sampleItem('a.js')]);
  session.dispatch('feedback');
  session.editor.replace('ab\ncd');
  session.draw();
  clickCaret(session, -1, -1);
  assert.equal(session.editor.cursor, 1);
  assert.equal(session.composeKind, 'feedback');
  press(session, 'escape');
  session.dispatch('tasks');
  session.pushInput('ship');
  saveTask(session);
  session.editor.replace('ab\ncd');
  session.draw();
  const box = session.lastFrame.taskHits.find((row) => row.check);
  assert.ok(box);
  click(session, box.x0 + 1, box.y);
  assert.equal(session.mode, 'compose');
  assert.equal(session.editor.text, 'ab\ncd');
  assert.equal(session.notes.tasks[0].done, true);
  session.draw();
  clickCaret(session, -1, -1);
  assert.equal(session.editor.cursor, 1);
});

test('click moves the caret in commit, branch, and npm editors', async () => {
  const { session, cwd } = await openSession([sampleItem('a.js', 'staged')], {
    startPane: 'files',
  });
  session.pushInput('c');
  press(session, 'insert');
  session.pushInput('hello');
  await session.ops.idle();
  session.draw();
  clickCaret(session, -4, 0);
  assert.equal(session.editor.cursor, 1);
  press(session, 'escape');
  session.pushInput('v');
  press(session, 'insert');
  await session.ops.idle();
  session.editor.replace('ab\ncd');
  session.draw();
  clickCaret(session, -1, -1);
  assert.equal(session.editor.cursor, 1);
  assert.equal(session.editor.text, 'ab\ncd');
  press(session, 'escape', 'escape');
  session.pushInput('b');
  await session.ops.idle();
  session.dispatch('newBranch');
  session.pushInput('topic');
  session.draw();
  clickCaret(session, -3, 0);
  assert.equal(session.composeKind, 'branch');
  assert.equal(session.editor.cursor, 2);
  press(session, 'escape', 'escape');
  fs.writeFileSync(
    path.join(cwd, 'package.json'),
    `${JSON.stringify({ scripts: { test: 'node --test' } })}\n`,
  );
  session.pushInput('r');
  session.pushInput('e');
  assert.equal(session.editor.text, 'test');
  session.draw();
  clickCaret(session, -3, 0);
  assert.equal(session.npm.editField, 'name');
  assert.equal(session.editor.cursor, 1);
  const command = session.lastFrame.editHits.find(
    (hit) => hit.field === 'command',
  );
  assert.ok(command);
  click(session, command.textX, command.y);
  assert.equal(session.npm.editField, 'command');
  assert.equal(session.editor.text, 'node --test');
  assert.equal(session.editor.cursor, 0);
  click(session, command.textX + 5, command.y);
  assert.equal(session.editor.cursor, 5);
});

const editRow = (session) => {
  const hit = session.lastFrame.editHits[0];
  if (!hit) return '';
  return stripAnsi(session.lastFrame.rows[hit.y - 1] ?? '');
};

const longValue = (head, tail) => `${head}${'m'.repeat(120)}${tail}`;

test('table editors scroll long lines horizontally', async () => {
  const { session, stdout, cwd } = await openSession(
    [sampleItem('a.js', 'staged')],
    {
      startPane: 'files',
    },
  );
  stdout.columns = 80;
  stdout.rows = 24;
  fs.writeFileSync(
    path.join(cwd, 'package.json'),
    `${JSON.stringify({ scripts: { test: 'node --test' } })}\n`,
  );
  const showsTail = (head, tail) => {
    session.draw();
    const row = editRow(session);
    assert.ok(row);
    assert.ok(session.editor.scrollCol > 0);
    assert.ok(row.includes(tail));
    assert.ok(!row.includes(head));
    return row;
  };
  session.pushInput('b');
  await session.ops.idle();
  session.dispatch('newBranch');
  session.editor.replace(longValue('Q', 'Z'));
  showsTail('Q', 'Z');
  const stuck = session.editor.scrollCol;
  const caret = session.lastFrame.cursor.x;
  press(session, 'left');
  session.draw();
  assert.equal(session.editor.scrollCol, stuck);
  assert.ok(session.lastFrame.cursor.x < caret);
  assert.ok(editRow(session).includes('Z'));
  const origin = session.lastFrame.cursor.x - session.editor.visibleLineCol();
  click(session, origin + session.editor.scrollCol, session.lastFrame.cursor.y);
  assert.equal(session.editor.cursor, stuck);
  press(session, 'home');
  session.draw();
  assert.equal(session.editor.scrollCol, 0);
  assert.ok(editRow(session).includes('Q'));
  press(session, 'escape', 'escape');
  session.pushInput('c');
  press(session, 'insert');
  await session.ops.idle();
  session.editor.replace(longValue('Q', 'Z'));
  showsTail('Q', 'Z');
  press(session, 'escape', 'escape');
  session.pushInput('r');
  session.pushInput('e');
  session.editor.replace(longValue('Q', 'Z'));
  showsTail('Q', 'Z');
  press(session, 'enter');
  session.editor.replace(longValue('A', 'B'));
  showsTail('A', 'B');
  assert.equal(session.npm.editField, 'command');
});

test('line numbers persist in .reslop', async () => {
  const cwd = tempDir('reslop-ui-');
  const file = path.join(cwd, '.reslop');
  fs.writeFileSync(
    file,
    `${JSON.stringify({ agents: { claude: { model: 'sonnet' } } })}\n`,
  );
  try {
    const { session } = await openSession([sampleItem('a.js')], { cwd });
    assert.equal(session.lineNumbers, false);
    press(session, 'ctrl-l');
    const on = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(on.editor.lineNumbers, true);
    assert.equal(on.lineNumbers, undefined);
    assert.deepEqual(on.agents.claude, { model: 'sonnet' });
    const again = await openSession([sampleItem('a.js')], { cwd });
    assert.equal(again.session.lineNumbers, true);
    press(again.session, 'ctrl-l');
    const off = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(off.editor.lineNumbers, false);
    assert.equal(off.lineNumbers, undefined);
    assert.deepEqual(off.agents.claude, { model: 'sonnet' });
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('editor general and commits settings persist in .reslop', async () => {
  const cwd = tempDir('reslop-ui-');
  const file = path.join(cwd, '.reslop');
  const legacy = { lineNumbers: true, agents: { claude: { model: 'sonnet' } } };
  fs.writeFileSync(file, `${JSON.stringify(legacy)}\n`);
  try {
    const { session } = await openSession([sampleItem('a.js')], { cwd });
    assert.equal(session.lineNumbers, true);
    assert.equal(session.layout, 'unified');
    assert.equal(themeName(), 'dark');
    press(session, 'm', 'l');
    session.pushInput('c');
    press(session, 'v');
    await session.ops.idle();
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(saved.lineNumbers, undefined);
    assert.equal(saved.editor.lineNumbers, true);
    assert.equal(saved.editor.mode, 'mixed');
    assert.equal(saved.general.theme, 'light');
    assert.equal(saved.commits.view, 'full');
    assert.deepEqual(saved.agents.claude, { model: 'sonnet' });
    setTheme('dark');
    const again = await openSession([sampleItem('a.js')], { cwd });
    assert.equal(again.session.lineNumbers, true);
    assert.equal(again.session.layout, 'mixed');
    assert.equal(again.session.commits.commitView, 'full');
    assert.equal(themeName(), 'light');
  } finally {
    setTheme('dark');
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('ctrl-l toggles line numbers on a diff and while editing', async () => {
  const { session } = await openSession([sampleItem('a.js')]);
  assert.equal(session.lineNumbers, false);
  press(session, 'ctrl-l');
  assert.equal(session.lineNumbers, true);
  assert.equal(session.status, 'line numbers');
  session.draw();
  const shown = stripAnsi(session.lastFrame.rows.join('\n'));
  assert.match(shown, / 1 - a/);
  assert.match(shown, / 1 \+ b/);
  press(session, 'ctrl-l');
  assert.equal(session.lineNumbers, false);
  assert.equal(session.status, 'no line numbers');
  session.pane = 'files';
  press(session, 'ctrl-l');
  assert.equal(session.lineNumbers, false);
  session.pane = 'diff';
  session.dispatch('code');
  const before = session.editor.text;
  press(session, 'ctrl-l');
  assert.equal(session.editor.text, before);
  assert.equal(session.lineNumbers, true);
  assert.equal(session.mode, 'compose');
  clickFooter(session, 'lines');
  assert.equal(session.lineNumbers, false);
  assert.equal(session.editor.text, before);
});

test('ctrl-c stays in every screen when no text is selected', async () => {
  const { session } = await openSession([sampleItem('a.js')]);
  for (const pane of [
    'dashboard',
    'repos',
    'files',
    'diff',
    'unit',
    'branches',
    'commits',
    'tasks',
    'npm',
    'packages',
    'agents',
  ]) {
    session.pane = pane;
    session.pushInput('\x03');
    assert.equal(session.done, false, pane);
    const editing = pane === 'tasks' ? 'compose' : 'review';
    assert.equal(session.mode, editing, pane);
    session.composer.tasks.closeEditor();
  }
});

test('ctrl-c copies the screen selection without quitting', async (t) => {
  const { session } = await openSession([sampleItem('a.js')]);
  session.draw();
  const at = session.lastFrame.rows.findIndex((row) => row.includes('a.js'));
  const plain = stripAnsi(session.lastFrame.rows[at]);
  const x = ansi.visibleWidth(plain.slice(0, plain.indexOf('a.js'))) + 1;
  session.nav.selection = {
    start: { x, y: at + 1 },
    end: { x: x + 3, y: at + 1 },
  };
  const copied = [];
  t.mock.method(clipboard, 'copyText', (text) => {
    copied.push(text);
    return true;
  });
  session.pushInput('\x1b[27;5;99~');
  assert.deepEqual(copied, ['a.js']);
  assert.equal(session.status, 'copied');
  assert.equal(session.done, false);
});

test('editors select with shift and copy cut paste', async () => {
  const { session, stdout } = await openSession([sampleItem('a.js')]);
  session.dispatch('feedback');
  session.editor.replace('hello');
  session.color = true;
  session.draw();
  const rowOf = (text) =>
    session.lastFrame.rows.find((row) => stripAnsi(row).includes(text));
  const before = rowOf('hello');
  press(session, 'shift-left', 'shift-left');
  assert.equal(session.editor.selectedText(), 'lo');
  session.draw();
  const after = rowOf('hello');
  assert.equal(stripAnsi(before), stripAnsi(after));
  assert.notEqual(before, after);
  const dumped = stdout.dump().length;
  press(session, 'ctrl-c');
  assert.equal(session.done, false);
  assert.equal(session.status, 'copied');
  assert.match(stdout.dump().slice(dumped), /\]52;/);
  press(session, 'ctrl-x');
  assert.equal(session.editor.text, 'hel');
  press(session, 'ctrl-c');
  assert.equal(session.done, false);
  assert.equal(session.editor.text, 'hel');
  press(session, 'ctrl-v');
  assert.equal(session.editor.text, 'hello');
  press(session, 'escape', 'e');
  session.editor.replace('abcd');
  press(session, 'shift-left');
  assert.equal(session.composeKind, 'code');
  assert.equal(session.editor.selectedText(), 'd');
  press(session, 'shift-up');
  assert.equal(session.editor.hasSelect(), true);
  press(session, 'escape', 'escape', 'b');
  await session.ops.idle();
  session.dispatch('newBranch');
  session.pushInput('topic');
  press(session, 'shift-home');
  assert.equal(session.composeKind, 'branch');
  assert.equal(session.editor.selectedText(), 'topic');
  press(session, 'escape', 'escape');
  session.dispatch('tasks');
  session.pushInput('ship');
  saveTask(session);
  session.editor.replace('ab\ncd');
  press(session, 'shift-up');
  assert.equal(session.editor.text, 'ab\ncd');
  assert.equal(session.editor.hasSelect(), true);
  assert.equal(session.composeKind, 'tasks');
  session.editor.replace('zxqv');
  session.draw();
  const taskBefore = rowOf('zxqv');
  press(session, 'shift-left', 'shift-left');
  assert.equal(session.editor.selectedText(), 'qv');
  assert.equal(session.view().taskEdit.anchor, 4);
  session.draw();
  const taskAfter = rowOf('zxqv');
  assert.equal(stripAnsi(taskBefore), stripAnsi(taskAfter));
  assert.notEqual(taskBefore, taskAfter);
});

for (const [kind, pane] of [
  ['feedback', 'diff'],
  ['branch', 'branches'],
  ['worktree', 'branches'],
  ['commit', 'commits'],
  ['package', 'packages'],
  ['npm', 'npm'],
  ['tasks', 'tasks'],
]) {
  test(`mouse and keyboard share selection in the ${kind} editor`, async () => {
    const { session, stdout } = await openSession([sampleItem('a.js')]);
    session.pane = pane;
    if (kind === 'tasks') {
      session.composer.tasks.onTasks();
      session.editor.replace('hello world');
    } else {
      session.composer.openCompose(kind, 'hello world');
    }
    if (kind === 'npm') session.npm.editField = 'name';
    session.editor.place(0);
    session.draw();
    const hit = session.lastFrame.editHits.find((entry) => entry.live);
    assert.ok(hit, kind);
    const before = stdout.dump().length;
    dragBetween(
      session,
      { x: hit.textX, y: hit.y },
      { x: hit.textX + 5, y: hit.y },
    );
    assert.equal(session.editor.selectedText(), 'hello');
    assert.equal(session.nav.selection, null);
    assert.equal(session.nav.editDrag, null);
    assert.equal(stdout.dump().length, before);
    press(session, 'shift-right');
    assert.equal(session.editor.selectedText(), 'hello ');
    press(session, 'ctrl-c');
    assert.equal(session.status, 'copied');
    assert.ok(stdout.dump().includes(Buffer.from('hello ').toString('base64')));
    rightClick(session, hit.textX + 1, hit.y);
    press(session, 'ctrl-c');
    assert.equal(session.editor.selectedText(), 'hello ');
    assert.equal(session.nav.contextMenu, null);
    assert.equal(session.mode, 'compose');
  });
}

test('code mouse selection spans lines and whole wide characters', async () => {
  const { session, stdout } = await openSession([sampleItem('a.js')]);
  session.dispatch('code');
  session.editor.replace('ab中👁️\ncd');
  session.editor.place(0);
  session.draw();
  const hits = session.lastFrame.editHits;
  assert.equal(hits.length, 2);
  dragBetween(
    session,
    { x: hits[0].textX + 1, y: hits[0].y },
    { x: hits[1].textX + 1, y: hits[1].y },
  );
  assert.equal(session.editor.selectedText(), 'b中👁️\nc');
  press(session, 'ctrl-c');
  assert.ok(stdout.dump().includes(Buffer.from('b中👁️\nc').toString('base64')));
  press(session, 'shift-right');
  assert.equal(session.editor.selectedText(), 'b中👁️\ncd');
  assert.equal(session.nav.selection, null);
});

test('reverse mouse drags select scrolled file text', async () => {
  const { session } = await openSession([sampleItem('a.js')]);
  session.pane = 'unit';
  session.nav.reviewPath = 'a.js';
  session.composer.openCompose('file', '0123456789'.repeat(20));
  session.composer.afterEdit();
  session.draw();
  const hit = session.lastFrame.editHits[0];
  const scroll = hit.scroll;
  assert.ok(scroll > 0);
  dragBetween(
    session,
    { x: hit.textX + 5, y: hit.y },
    { x: hit.textX + 1, y: hit.y },
  );
  assert.equal(
    session.editor.selectedText(),
    session.editor.text.slice(scroll + 1, scroll + 5),
  );
  assert.ok(session.editor.anchor > session.editor.cursor);
  assert.equal(session.nav.selection, null);
});

test('mouse selection spans visually wrapped feedback', async () => {
  const { session, stdout } = await openSession([sampleItem('a.js')]);
  stdout.columns = 20;
  session.composer.openCompose('feedback', 'alpha beta gamma delta epsilon');
  session.editor.place(0);
  session.draw();
  const hits = session.lastFrame.editHits;
  assert.equal(hits.length, 2);
  dragBetween(
    session,
    { x: hits[0].textX + 6, y: hits[0].y },
    { x: hits[1].textX + 2, y: hits[1].y },
  );
  assert.equal(session.editor.selectedText(), 'beta gamma de');
  assert.equal(session.nav.selection, null);
});

test('find and import mouse selections use their line editors', async () => {
  const { session } = await openSession([sampleItem('hello-world.js')]);
  session.pane = 'files';
  press(session, '/');
  session.pushInput('hello');
  session.draw();
  let hit = session.lastFrame.editHits.find((entry) => entry.editor);
  dragBetween(
    session,
    { x: hit.textX + 1, y: hit.y },
    { x: hit.textX + 4, y: hit.y },
  );
  assert.equal(session.nav.find.editor.selectedText(), 'ell');
  press(session, 'shift-right');
  assert.equal(session.nav.find.editor.selectedText(), 'ello');
  press(session, 'ctrl-c');
  assert.equal(session.status, 'copied');
  press(session, 'escape');
  session.composer.tasks.openTasksPage();
  session.dispatch('taskImport');
  session.pushInput('https://example.com');
  session.draw();
  hit = session.lastFrame.editHits.find((entry) => entry.editor);
  dragBetween(
    session,
    { x: hit.textX + 8, y: hit.y },
    { x: hit.textX + 15, y: hit.y },
  );
  assert.equal(session.nav.import.editor.selectedText(), 'example');
  rightClick(session, hit.textX + 10, hit.y);
  press(session, 'ctrl-c');
  assert.equal(session.nav.import.editor.selectedText(), 'example');
  assert.equal(session.mode, 'import');
  assert.equal(session.nav.selection, null);
});

test('the plan query keeps mouse selection in the open combo', async () => {
  const { session } = await openSession([sampleItem('a.js')]);
  session.composer.tasks.openTasksPage();
  session.composer.tasks.togglePlanMenu();
  session.pushInput('plan');
  session.draw();
  const hit = session.lastFrame.editHits.find((entry) => entry.editor);
  assert.ok(hit);
  dragBetween(
    session,
    { x: hit.textX, y: hit.y },
    { x: hit.textX + 2, y: hit.y },
  );
  assert.equal(session.composer.tasks.planPick.editor.selectedText(), 'pl');
  press(session, 'shift-right');
  assert.equal(session.composer.tasks.planPick.editor.selectedText(), 'pla');
  press(session, 'ctrl-c');
  assert.equal(session.status, 'copied');
  assert.equal(session.composer.tasks.planOpen, true);
  assert.equal(session.nav.selection, null);
});

test('find import and plan lines select and use the clipboard', async () => {
  const items = [
    sampleItem('src/app.js'),
    sampleItem('lib/find.js'),
    sampleItem('lib/files.js'),
  ];
  const { session, stdout } = await openSession(items);
  press(session, 'escape', '/');
  session.pushInput('lib/f');
  press(session, 'down');
  assert.equal(session.reviewPath, 'lib/find.js');
  session.pushInput('iles');
  press(session, 'ctrl-left');
  assert.equal(session.nav.find.editor.cursor, 4);
  press(session, 'shift-left');
  assert.equal(session.nav.find.editor.selectedText(), '/');
  const dumped = stdout.dump().length;
  press(session, 'ctrl-c');
  assert.equal(session.done, false);
  assert.equal(session.mode, 'find');
  assert.match(stdout.dump().slice(dumped), /\]52;/);
  press(session, 'left');
  assert.equal(session.nav.find.editor.cursor, 3);
  press(session, 'ctrl-right');
  assert.equal(session.nav.find.editor.cursor, 9);
  press(session, 'escape');
  session.dispatch('tasks');
  press(session, 'ctrl-i');
  session.pushInput('https://example.com/a');
  press(session, 'shift-left', 'shift-left');
  assert.equal(session.nav.import.editor.selectedText(), '/a');
  press(session, 'ctrl-x');
  assert.equal(session.nav.import.url, 'https://example.com');
  press(session, 'ctrl-v');
  assert.equal(session.nav.import.url, 'https://example.com/a');
  assert.equal(session.mode, 'import');
  press(session, 'escape', 'ctrl-p');
  session.pushInput('plan');
  press(session, 'ctrl-left');
  assert.equal(session.composer.tasks.planPick.editor.cursor, 0);
  press(session, 'shift-right', 'shift-right');
  assert.equal(session.composer.tasks.planPick.editor.selectedText(), 'pl');
  press(session, 'end');
  assert.equal(session.composer.tasks.planOpen, true);
});

test('slash searches paths on the files and diff screens', async () => {
  const items = [
    sampleItem('src/app.js'),
    sampleItem('lib/find.js'),
    sampleItem('lib/files.js'),
  ];
  const { session } = await openSession(items);
  press(session, 'escape');
  assert.equal(session.pane, 'files');
  press(session, '/');
  assert.equal(session.mode, 'find');
  session.pushInput('lib/f');
  assert.equal(session.view().find.query, 'lib/f');
  assert.equal(session.reviewPath, 'lib/files.js');
  press(session, 'down');
  assert.equal(session.reviewPath, 'lib/find.js');
  press(session, 'down');
  assert.equal(session.reviewPath, 'lib/files.js');
  press(session, 'up');
  assert.equal(session.reviewPath, 'lib/find.js');
  session.pushInput('j');
  assert.equal(session.view().find.query, 'lib/fj');
  assert.equal(session.reviewPath, 'lib/find.js');
  press(session, 'backspace');
  assert.equal(session.view().find.query, 'lib/f');
  assert.equal(session.reviewPath, 'lib/files.js');
  press(session, 'escape');
  assert.equal(session.mode, 'review');
  assert.equal(session.view().find, null);
  assert.equal(session.reviewPath, 'lib/files.js');
  session.pane = 'diff';
  session.scroll = 4;
  press(session, '/');
  session.pushInput('app');
  assert.equal(session.pane, 'diff');
  assert.equal(session.reviewPath, 'src/app.js');
  assert.equal(session.scroll, 0);
  press(session, 'escape');
  session.pane = 'branches';
  press(session, '/');
  assert.equal(session.mode, 'review');
  assert.equal(session.view().find, null);
});

test('the file view reads a file once, not on every frame', async () => {
  const { FileReads } = require('../lib/session/lifecycle.js');
  let calls = 0;
  const repo = {
    fileText: async (top, rel, rev) => {
      calls += 1;
      return `${rev}:${rel}`;
    },
  };
  const pending = [];
  const ops = { track: (promise) => pending.push(promise) };
  const ui = { repo, ops, top: '/repo', rev: 'abc123', paint: () => {} };
  const reads = new FileReads(ui);
  assert.equal(await reads.loadText('a.js'), 'abc123:a.js');
  assert.equal(reads.textOf('a.js'), 'abc123:a.js');
  assert.equal(reads.textOf('a.js'), 'abc123:a.js');
  assert.equal(calls, 1);
  assert.equal(reads.textOf('b.js'), '');
  assert.equal(reads.textOf('b.js'), '');
  await Promise.all(pending);
  assert.equal(reads.textOf('b.js'), 'abc123:b.js');
  assert.equal(calls, 2);
  ui.rev = 'def456';
  assert.equal(reads.cached('b.js'), null);
  assert.equal(await reads.loadText('b.js'), 'def456:b.js');
  assert.equal(calls, 3);
});

test('an external run whose record disappears stops spinning', async () => {
  const { RunRecorder } = require('../lib/runs/runs.js');
  const { session, cwd } = await openSession([sampleItem('a.js')], {
    startPane: 'npm',
  });
  const recorder = new RunRecorder(cwd, 'eslint .');
  session.npm.refreshRecorded();
  const run = session.npm.runs.find((entry) => entry.externalId);
  assert.equal(run.status, 'running');
  assert.equal(session.npm.running, true);
  fs.rmSync(recorder.slot.jsonFull, { force: true });
  session.npm.refreshRecorded();
  assert.equal(run.status, 'stopped');
  assert.equal(session.npm.running, false);
  assert.ok(run.endedAt > 0);
  recorder.finish(1);
  fs.rmSync(recorder.slot.jsonFull, { force: true });
});

test('repo writes run one at a time and in order', async () => {
  const { session } = await openSession([sampleItem('a.js')]);
  const seen = [];
  let release = null;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const slow = async () => {
    seen.push('slow start');
    await held;
    seen.push('slow end');
  };
  const failing = async () => {
    seen.push('failing');
    throw new Error('no');
  };
  const first = session.ops.exclusive(slow);
  const second = session.ops.exclusive(failing);
  const third = session.ops.exclusive(async () => seen.push('last'));
  assert.deepEqual(seen, ['slow start']);
  release();
  await first;
  await assert.rejects(second, /no/);
  await third;
  assert.deepEqual(seen, ['slow start', 'slow end', 'failing', 'last']);
  session.ops.exclusive(async () => seen.push('free'));
  assert.equal(seen.at(-1), 'free');
});

test('keys typed while a list loads are handled after it opens', async () => {
  const { session, repo } = await openSession([sampleItem('a.js')], {
    startPane: 'files',
  });
  let deliver = null;
  const list = repo.listCommits();
  repo.listCommits = () =>
    new Promise((resolve) => {
      deliver = () => resolve(list);
    });
  session.pushInput('c');
  session.pushInput('\x1b[B');
  await settle();
  assert.equal(session.pane, 'files');
  assert.equal(session.commitCursor, 0);
  deliver();
  await session.ops.idle();
  assert.equal(session.pane, 'commits');
  assert.equal(session.commitCursor, 1);
});

test('the file list and file view read the repo only once', async () => {
  const { session, repo } = await openSession([sampleItem('a.js')], {
    startPane: 'files',
  });
  const calls = { names: 0, text: 0 };
  const { listFiles, fileText } = repo;
  repo.listFiles = (...args) => {
    calls.names += 1;
    return listFiles(...args);
  };
  repo.fileText = (...args) => {
    calls.text += 1;
    return fileText(...args);
  };
  repo.extraFiles.push('z.js');
  session.dispatch('file');
  await session.ops.idle();
  for (let i = 0; i < 5; i++) session.view();
  const names = session.fileList().map((entry) => entry.path);
  assert.deepEqual(names, ['a.js', 'z.js']);
  assert.equal(calls.names, 1);
  session.dispatch('open');
  await session.ops.idle();
  assert.equal(session.pane, 'unit');
  for (let i = 0; i < 5; i++) session.view();
  assert.equal(calls.text, 1);
});

test('an action taken while editing code waits for the save', async () => {
  const items = [sampleItem('a.js'), sampleItem('b.js')];
  const { session, repo } = await openSession(items);
  let land = null;
  repo.edit = (top, item, text) =>
    new Promise((resolve) => {
      land = () => {
        repo.edited.push({ top, item, text });
        resolve();
      };
    });
  session.pushInput('e');
  session.pushInput('2');
  session.dispatch('next');
  await settle();
  assert.equal(session.mode, 'compose');
  assert.equal(session.index, 0);
  assert.equal(repo.edited.length, 0);
  land();
  await session.ops.idle();
  assert.equal(repo.edited.length, 1);
  assert.equal(repo.edited[0].text, 'b2');
  assert.equal(session.mode, 'review');
  assert.equal(session.index, 1);
});

test('a failed code save keeps the editor and drops the action', async () => {
  const items = [sampleItem('a.js'), sampleItem('b.js')];
  const { session, repo } = await openSession(items);
  repo.edit = async () => {
    throw new Error('disk full');
  };
  session.pushInput('e');
  session.pushInput('2');
  session.dispatch('next');
  await session.ops.idle();
  assert.equal(session.status, 'disk full');
  assert.equal(session.mode, 'compose');
  assert.equal(session.editor.text, 'b2');
  assert.equal(session.index, 0);
});

test('quitting while editing a file writes it before leaving', async () => {
  const { session, repo } = await openSession([sampleItem('a.js')], {
    startPane: 'files',
  });
  session.dispatch('file');
  await session.ops.idle();
  session.dispatch('open');
  session.dispatch('code');
  await session.ops.idle();
  assert.equal(session.composeKind, 'file');
  session.editor.replace('kept\n');
  session.onQuit();
  assert.equal(session.done, false);
  await session.ops.idle();
  assert.equal(repo.fileBodies['a.js'], 'kept\n');
  assert.equal(session.done, true);
});

test('an autosave and a save write the file in the order begun', async () => {
  const { session, repo } = await openSession([sampleItem('a.js')], {
    startPane: 'files',
  });
  session.dispatch('file');
  await session.ops.idle();
  session.dispatch('open');
  session.dispatch('code');
  await session.ops.idle();
  const order = [];
  const gates = [];
  repo.writeFile = (top, rel, text) =>
    new Promise((resolve) => {
      order.push(`start ${text}`);
      gates.push(() => {
        repo.fileBodies[rel] = text;
        order.push(`end ${text}`);
        resolve();
      });
    });
  session.editor.replace('one');
  session.autosave();
  session.editor.replace('two');
  press(session, 'ctrl-s');
  await settle();
  assert.deepEqual(order, ['start one']);
  gates[0]();
  await settle();
  gates[1]();
  await session.ops.idle();
  assert.deepEqual(order, ['start one', 'end one', 'start two', 'end two']);
  assert.equal(repo.fileBodies['a.js'], 'two');
  assert.equal(session.mode, 'review');
});

test('a file edit reloads once and later saves do not stage', async () => {
  const items = [sampleItem('a.js'), sampleItem('b.js')];
  const { session, repo } = await openSession(items);
  let loads = 0;
  const { load } = repo;
  repo.load = (...args) => {
    loads += 1;
    return load(...args);
  };
  session.pushInput('e');
  session.pushInput('2');
  press(session, 'escape');
  await session.ops.idle();
  assert.equal(repo.edited.length, 1);
  assert.deepEqual(repo.stagedPaths, ['a.js']);
  assert.equal(loads, 1);
  session.dispatch('next');
  session.pushInput('e');
  press(session, 'escape');
  await session.ops.idle();
  assert.equal(session.mode, 'review');
  assert.equal(repo.edited.length, 1);
  assert.deepEqual(repo.stagedPaths, ['a.js']);
  assert.equal(loads, 1);
  session.dispatch('feedback');
  session.pushInput('note');
  press(session, 'enter');
  await session.ops.idle();
  assert.equal(session.mode, 'review');
  assert.equal(session.notes.feedback.size, 1);
  assert.equal(loads, 1);
});

test('a package command that rejects shows the error and stops', async () => {
  const { session, repo } = await openSession([sampleItem('a.js')]);
  repo.runPackage = () => Promise.reject(new Error('registry down'));
  await session.packages.exec(['update', 'leftpad'], 'npm i', 'updated');
  assert.equal(session.status, 'registry down');
  assert.equal(session.packages.running, false);
  assert.equal(session.busy, '');
  repo.runPackage = () => {
    throw new Error('no npm');
  };
  await session.packages.exec(['update', 'leftpad'], 'npm i', 'updated');
  assert.equal(session.status, 'no npm');
  assert.equal(session.busy, '');
});

const editFile = async (items) => {
  const opened = await openSession(items, { startPane: 'files' });
  const { session } = opened;
  session.dispatch('file');
  await session.ops.idle();
  session.dispatch('open');
  session.dispatch('code');
  await session.ops.idle();
  assert.equal(session.composeKind, 'file');
  return opened;
};

const heldLoad = (repo) => {
  const { load } = repo;
  let release = null;
  repo.load = (...args) =>
    new Promise((resolve) => {
      release = () => resolve(load(...args));
    });
  return () => release();
};

test('a reload does not undo an autosave that landed meanwhile', async () => {
  const { session, repo } = await editFile([sampleItem('a.js')]);
  const finishLoad = heldLoad(repo);
  session.refreshFromRepo({ keepView: true, quiet: true });
  await settle();
  session.editor.replace('typed\n');
  session.autosave();
  await settle();
  assert.equal(repo.fileBodies['a.js'], 'typed\n');
  finishLoad();
  await session.ops.idle();
  assert.equal(session.editor.text, 'typed\n');
  assert.equal(session.composer.composeBaseline, 'typed\n');
  assert.equal(session.reads.textOf('a.js'), 'typed\n');
});

test('a reload keeps unsaved typing when the disk is unchanged', async () => {
  const { session, repo } = await editFile([sampleItem('a.js')]);
  const opened = session.editor.text;
  let land = null;
  const { writeFile } = repo;
  repo.writeFile = (...args) =>
    new Promise((resolve) => {
      land = () => resolve(writeFile(...args));
    });
  session.editor.replace('typed\n');
  session.autosave();
  session.refreshFromRepo({ keepView: true, quiet: true });
  await settle();
  assert.equal(session.editor.text, 'typed\n');
  land();
  await session.ops.idle();
  assert.equal(session.editor.text, 'typed\n');
  assert.equal(repo.fileBodies['a.js'], 'typed\n');
  repo.fileBodies['a.js'] = `${opened}outside\n`;
  session.refreshFromRepo({ keepView: true, quiet: true });
  await session.ops.idle();
  assert.equal(session.editor.text, `${opened}outside\n`);
});

test('a code save does not wait for a running install', async () => {
  const proposed = sampleItem('package.json');
  proposed.reload = true;
  proposed.dep = {
    change: { propose: true, name: 'lodash' },
    files: ['package.json'],
  };
  const { session, repo } = await openSession([proposed, sampleItem('z.js')]);
  let finish = null;
  const installing = new Promise((resolve) => {
    finish = resolve;
  });
  const options = [];
  repo.add = (top, item, extra) => {
    options.push(extra);
    return item.dep ? installing : undefined;
  };
  session.dispatch('add');
  await settle();
  assert.equal(session.busy, 'npm i');
  assert.equal(typeof options[0].locked, 'function');
  session.dispatch('next');
  session.pushInput('e');
  session.pushInput('2');
  press(session, 'escape');
  await settle();
  assert.equal(repo.edited.length, 1);
  assert.equal(session.mode, 'review');
  assert.equal(session.ops.holds, 0);
  finish();
  await session.ops.idle();
  assert.equal(session.busy, '');
});

const gatedAdds = (repo) => {
  const gates = [];
  const done = [];
  repo.add = (top, item) =>
    new Promise((resolve) => {
      gates.push(() => {
        done.push(item);
        resolve();
      });
    });
  return { gates, done };
};

test('quitting lets a running stage finish every hunk first', async () => {
  const second = sampleItem('a.js');
  second.blockId = 1;
  const { session, repo } = await openSession([sampleItem('a.js'), second], {
    startPane: 'files',
  });
  const { gates, done } = gatedAdds(repo);
  session.dispatch('add');
  await settle();
  assert.equal(gates.length, 1);
  session.onQuit();
  session.pushInput('u');
  assert.equal(session.done, false);
  gates[0]();
  await settle();
  assert.equal(session.done, false);
  assert.equal(gates.length, 2);
  gates[1]();
  await session.ops.idle();
  assert.equal(done.length, 2);
  assert.equal(session.done, true);
  assert.equal(repo.unstageCalls.length, 0);
});

test('quitting does not wait for an install or a stuck write', async () => {
  const proposed = sampleItem('package.json');
  proposed.reload = true;
  proposed.dep = {
    change: { propose: true, name: 'lodash' },
    files: ['package.json'],
  };
  const { session, repo } = await openSession([proposed]);
  repo.add = () => new Promise(() => {});
  session.dispatch('add');
  await settle();
  assert.equal(session.busy, 'npm i');
  session.onQuit();
  assert.equal(session.done, true);
  const stuck = await openSession([sampleItem('a.js')]);
  stuck.repo.add = () => new Promise(() => {});
  stuck.session.dispatch('add');
  await settle();
  assert.equal(stuck.session.ops.unlanded(), true);
  const before = Date.now();
  await stuck.session.ops.landed(30);
  assert.ok(Date.now() - before < 1000);
  assert.equal(stuck.session.ops.unlanded(), true);
});

test('leaving the editor does not stage a change made outside', async () => {
  const { session, repo } = await editFile([sampleItem('a.js')]);
  repo.fileBodies['a.js'] = 'outside\n';
  session.refreshFromRepo({ keepView: true, quiet: true });
  await session.ops.idle();
  assert.equal(session.editor.text, 'outside\n');
  press(session, 'escape');
  await session.ops.idle();
  assert.equal(session.mode, 'review');
  assert.equal(session.status, 'saved');
  assert.deepEqual(repo.stagedPaths, []);
  session.dispatch('code');
  await session.ops.idle();
  repo.fileBodies['a.js'] = 'again\n';
  session.refreshFromRepo({ keepView: true, quiet: true });
  await session.ops.idle();
  session.editor.replace('again\nmine\n');
  press(session, 'escape');
  await session.ops.idle();
  assert.equal(session.status, 'staged');
  assert.deepEqual(repo.stagedPaths, ['a.js']);
});

// The tasks screen of a plan file, as plain text rows of its body
const planScreen = async (name, text, rows = 24, extra = {}) => {
  const items = [sampleItem('a.js')];
  const { session, stdout, cwd, repo } = await openSession(items, extra);
  stdout.rows = rows;
  const dir = path.join(cwd, REVIEW_DIR);
  fs.mkdirSync(dir, { recursive: true });
  if (text !== null) fs.writeFileSync(path.join(dir, name), text);
  session.composer.tasks.openTasksPage();
  session.composer.tasks.openPlan(name);
  session.draw();
  const body = session.lastFrame.rows.slice(1, -2);
  const lines = body.map((row) => stripAnsi(row).trimEnd());
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  return { session, lines, repo };
};

const PLAN_SCREEN = [
  '---',
  'status: editing',
  '---',
  '',
  '# reslop review 2026-10-27-00',
  '',
  '## Agent instructions',
  '',
  'Work through unchecked items.',
  '',
  '## Bug Reports and Fixes',
  '',
  '- [x] B1 high: Released connection can be assigned to two consumers',
  '- [ ] B2: Escape ends the read loop on the file list',
  '  - where: lib/session/terminal.js#readLoop',
  '  - check:',
  '    - [ ] read loop survives a lone Escape',
  '    - [ ] terminal tests pass',
  '- [ ] high: Timeout error message names the pool',
  '',
  '## Notes',
  '',
  'Anything else: paragraphs, lists, code, tables.',
  '',
  '```js',
  'const x = 1;',
  '```',
  '',
].join('\n');

test('tasks screen snapshot of a reslop plan', async () => {
  const { lines } = await planScreen('2026-10-27-00.md', PLAN_SCREEN);
  assert.deepEqual(lines, [
    '',
    ' Agent instructions',
    '   Work through unchecked items.',
    '',
    ` Bug Reports and Fixes${' '.repeat(54)}1/3`,
    ' [x] B1 high: Released connection can be assigned to two consumers',
    ' [ ] B2: Escape ends the read loop on the file list  (where, check: 0/2)',
    ' [ ] high: Timeout error message names the pool',
    '',
    ' Notes',
    '   Anything else: paragraphs, lists, code, tables.',
    '   ```js',
    '   const x = 1;',
    '   ```',
  ]);
});

test('tasks screen snapshot of a free-form Markdown file', async () => {
  const text = [
    '# Live dashboard',
    '',
    '## Goal',
    '',
    'Add a live dashboard that opens first.',
    '',
    '- files - size and count',
    '- diffs - lines added and removed',
    '',
    '## 1. Entry screen',
    '',
    'Pressing `Esc` returns to the dashboard.',
    '',
  ].join('\n');
  const { session, lines } = await planScreen('LIVE.md', text);
  assert.deepEqual(lines, [
    '',
    ' Live dashboard',
    '',
    ' Goal',
    '   Add a live dashboard that opens first.',
    '   - files - size and count',
    '   - diffs - lines added and removed',
    '',
    ' 1. Entry screen',
    '   Pressing `Esc` returns to the dashboard.',
  ]);
  const file = path.join(session.root, REVIEW_DIR, 'LIVE.md');
  session.notes.addTask('TODOs', 'first', false, 'features');
  session.flushReview(true);
  assert.ok(fs.readFileSync(file, 'utf8').startsWith(text));
});

test('tasks screen snapshot of an empty file', async () => {
  const { session, lines } = await planScreen('empty.md', '');
  assert.deepEqual(lines, []);
  press(session, 'enter');
  assert.equal(session.mode, 'compose');
});

const SECTIONS = [
  '## Bug Reports and Fixes',
  '',
  '- [ ] B1: pool hands a connection out twice',
  '- [ ] B2: timeout names the pool',
  '',
  '## Notes',
  '',
  'Context for the agent.',
  '',
  '## Security and Compliance',
  '',
  '- [ ] S1: keep paths inside the root',
  '',
].join('\n');

test('insert adds a task below the focused block in its block', async () => {
  const { session } = await planScreen('blocks.md', SECTIONS);
  focusTask(session, rowOf(session, 'B1:'));
  press(session, 'insert');
  assert.equal(session.mode, 'compose');
  assert.equal(session.editor.text, '');
  session.pushInput('B3: retry the handshake');
  press(session, 'down');
  const texts = session.notes.tasks.map((task) => [task.text, task.kind]);
  assert.deepEqual(texts, [
    ['B1: pool hands a connection out twice', 'bugs'],
    ['B3: retry the handshake', 'bugs'],
    ['B2: timeout names the pool', 'bugs'],
    ['S1: keep paths inside the root', 'security'],
  ]);
  assert.equal(focusedRow(session), '[ ] B2: timeout names the pool');
  focusTask(session, rowOf(session, 'Context for'));
  press(session, 'insert');
  session.pushInput('read the notes');
  press(session, 'up');
  const notes = session.notes.tasks.find(
    (task) => task.text === 'read the notes',
  );
  assert.equal(notes.kind, '');
});

test('ctrl+up and ctrl+down move a block or a task across them', async () => {
  const { session } = await planScreen('blocks.md', SECTIONS);
  const s1 = session.notes.tasks.find((task) => task.item.id === 'S1');
  focusTask(session, rowOf(session, 'S1:'));
  press(session, 'ctrl-up');
  const moved = session.notes.tasks.find((task) => task.id === s1.id);
  assert.equal(moved.kind, '');
  assert.equal(moved.item.id, 'S1');
  assert.equal(focusedRow(session), '[ ] S1: keep paths inside the root');
  press(session, 'ctrl-down');
  assert.equal(session.notes.tasks.at(-1).kind, 'security');
  focusTask(session, rowOf(session, 'Security and Compliance'));
  press(session, 'ctrl-up', 'ctrl-up');
  const text = serializeReview(session.notes);
  assert.ok(text.startsWith('## Security and Compliance\n\n- [ ] S1'));
  assert.match(text, /S1: keep paths inside the root\n\n## Bug Reports/);
  assert.match(text, /\n\nContext for the agent\.\n$/);
  assert.equal(focusedRow(session), 'Security and Compliance');
});

test('ctrl+r on a heading with blocks under it asks first', async () => {
  const { session } = await planScreen('blocks.md', SECTIONS);
  focusTask(session, rowOf(session, 'Bug Reports and Fixes'));
  press(session, 'ctrl-r');
  assert.equal(session.mode, 'confirmDrop');
  session.draw();
  const status = stripAnsi(session.lastFrame.rows.at(-2));
  assert.match(status, /drop block Bug Reports and Fixes\?/);
  press(session, 'n');
  assert.equal(session.mode, 'compose');
  assert.equal(session.notes.tasks.length, 3);
  press(session, 'ctrl-r', 'y');
  assert.equal(session.notes.tasks.length, 1);
  assert.ok(serializeReview(session.notes).startsWith('## Notes\n'));
  session.notes.addTask('TODOs', 'x', false, 'features');
  focusTask(session, rowOf(session, 'Notes'));
  press(session, 'ctrl-r');
  assert.equal(session.mode, 'confirmDrop');
  press(session, 'escape');
  const empty = '## Empty\n\n## Notes\n\ntext\n';
  const { session: other } = await planScreen('empty-block.md', empty);
  other.tasksFocus = rowOf(other, 'Empty');
  press(other, 'ctrl-r');
  assert.notEqual(other.mode, 'confirmDrop');
  assert.equal(serializeReview(other.notes), '## Notes\n\ntext\n');
});

test('enter on a heading goes below, insert starts a task', async () => {
  const { session } = await planScreen('blocks.md', SECTIONS);
  focusTask(session, rowOf(session, 'Notes'));
  press(session, 'end');
  session.pushInput(' and links');
  press(session, 'enter');
  assert.match(serializeReview(session.notes), /^## Notes and links$/m);
  assert.equal(session.editor.text, 'Context for the agent.');
  press(session, 'up', 'insert');
  assert.equal(session.editor.text, '');
  session.pushInput('a task under notes');
  press(session, 'down');
  const text = serializeReview(session.notes);
  assert.match(text, /## Notes and links\n\n- \[ \] a task under notes\n\n/);
});

const STRUCTURED = [
  '## Bug Reports and Fixes',
  '',
  '- [ ] B1 high: Escape ends the read loop',
  '  - where: lib/session/terminal.js#readLoop',
  '  - check:',
  '    - [ ] read loop survives a lone Escape',
  '    - [ ] terminal tests pass',
  '  - result: guarded the timer',
  '- [ ] B2: Timeout names the pool',
  '',
].join('\n');

test('a closed task names what it hides, an open one is its text', async () => {
  const { session, lines } = await planScreen('structured.md', STRUCTURED);
  assert.deepEqual(lines, [
    '',
    ` Bug Reports and Fixes${' '.repeat(54)}0/2`,
    ' [ ] B1 high: Escape ends the read loop',
    '     - where: lib/session/terminal.js#readLoop',
    '     - check:',
    '       - [ ] read loop survives a lone Escape',
    '       - [ ] terminal tests pass',
    '     - result: guarded the timer',
    ' [ ] B2: Timeout names the pool',
  ]);
  focusTask(session, rowOf(session, 'B2:'));
  session.draw();
  const body = session.lastFrame.rows.map((row) => stripAnsi(row).trimEnd());
  assert.ok(
    body.includes(
      ' [ ] B1 high: Escape ends the read loop  (where, result, check: 0/2)',
    ),
  );
  assert.ok(!body.some((row) => row.includes('lib/session/terminal.js')));
});

test('ctrl+d on a check line ticks that check, not the task', async () => {
  const { session } = await planScreen('structured.md', STRUCTURED);
  assert.equal(focusedRow(session), '[ ] B1 high: Escape ends the read loop');
  cursorAt(session, 'terminal tests');
  press(session, 'ctrl-d');
  assert.match(session.editor.text, / {2}- \[x\] terminal tests pass/);
  session.composer.tasks.closeEditor();
  const [task] = session.notes.tasks;
  assert.equal(task.done, false);
  assert.deepEqual(
    task.item.checks.map((check) => check.done),
    [false, true],
  );
  focusTask(session, rowOf(session, 'B1 high'));
  cursorAt(session, 'Escape ends');
  press(session, 'ctrl-d');
  assert.equal(session.notes.tasks[0].done, true);
  assert.match(
    focusedRow(session),
    /^\[x\] B1 high: Escape ends the read loop/,
  );
});

test('shift+tab opens and closes every task', async () => {
  const { session } = await planScreen('structured.md', STRUCTURED);
  const shown = () => {
    session.draw();
    return session.lastFrame.rows.some((row) =>
      stripAnsi(row).includes('lib/session/terminal.js'),
    );
  };
  focusTask(session, rowOf(session, 'B2:'));
  assert.equal(shown(), false);
  press(session, 'shift-tab');
  assert.equal(shown(), true);
  press(session, 'shift-tab');
  assert.equal(shown(), false);
});

test('tab opens a field menu and its keys add fields', async () => {
  const opened = await planScreen('structured.md', STRUCTURED, 24, {
    color: true,
  });
  const { session } = opened;
  focusTask(session, rowOf(session, 'B2:'));
  session.composer.tasks.settle();
  session.draw();
  const body = session.lastFrame.rows.map((row) => stripAnsi(row));
  assert.ok(!body.some((row) => row.includes('░')));
  press(session, 'tab');
  const menu = session.nav.contextMenu;
  assert.deepEqual(menu.actions, [
    'field:where',
    'field:problem',
    'field:expected',
    'field:check',
    'field:do',
    'field:related',
  ]);
  session.draw();
  const lines = session.lastFrame.rows.map((row) => stripAnsi(row));
  assert.ok(lines.some((row) => row.includes(' where: path, path:line')));
  assert.ok(lines.some((row) => row.includes(' expected: how it behaves')));
  const hot = `${BOLD}${seq(THEME.buttonHotFg, THEME.popupHotBg)}w`;
  assert.ok(session.lastFrame.rows.some((row) => row.includes(hot)));
  press(session, 'w');
  assert.equal(session.nav.contextMenu, null);
  assert.equal(session.mode, 'compose');
  assert.equal(session.editor.text, 'B2: Timeout names the pool\n- where: ');
  session.autosave();
  const saved = fs.readFileSync(session.notes.reviewPath, 'utf8');
  assert.doesNotMatch(saved.split('B2:')[1], /where/);
  session.pushInput('lib/pool.js');
  press(session, 'tab');
  assert.ok(session.nav.contextMenu);
  assert.ok(!session.nav.contextMenu.actions.includes('field:where'));
  press(session, 'p');
  assert.equal(
    session.editor.text,
    'B2: Timeout names the pool\n- where: lib/pool.js\n- problem: ',
  );
  press(session, 'tab', 'escape');
  assert.equal(session.nav.contextMenu, null);
  assert.equal(session.mode, 'compose');
  press(session, 'escape');
  const text = fs.readFileSync(session.notes.reviewPath, 'utf8');
  assert.match(text, /- \[ \] B2: Timeout names the pool\n {2}- where: lib/);
  assert.doesNotMatch(text.split('B2:')[1], /problem/);
});

const KIND_ORDER = [
  '## Feature requests and Enhancements',
  '',
  '- [ ] F1: dark mode',
  '',
  '## Refactoring and Technical debt',
  '',
  '- [ ] D1: split the store',
  '',
  '## Notes',
  '',
  'Text.',
  '',
].join('\n');

const pickSection = (session, query) => {
  press(session, 'ctrl-b');
  session.pushInput(query);
  press(session, 'enter');
};

test('the block menu adds a missing kind in kind order', async () => {
  const { session } = await planScreen('kinds.md', KIND_ORDER);
  press(session, 'ctrl-b');
  assert.equal(session.composer.tasks.planOpen, true);
  assert.deepEqual(session.view().planNames, [
    'Feature requests and Enhancements',
    'Improvements',
    'Bug Reports and Fixes',
    'Refactoring and Technical debt',
    'Research and Experiments',
    'Security and Compliance',
    'custom…',
  ]);
  session.draw();
  assert.match(stripAnsi(session.lastFrame.rows.at(-2)), /Block: /);
  session.pushInput('secur');
  assert.deepEqual(session.view().planNames, ['Security and Compliance']);
  press(session, 'enter');
  assert.equal(session.composer.tasks.planOpen, false);
  const file = fs.readFileSync(session.notes.reviewPath, 'utf8');
  assert.match(
    file,
    /D1: split the store\n\n## Security and Compliance\n\n## Notes/,
  );
  assert.equal(session.mode, 'compose');
  assert.equal(focusedRow(session), '[ ] ');
  assert.equal(
    session.composer.tasks.taskTexts()[session.tasksFocus - 1],
    'Security and Compliance',
  );
  session.pushInput('S1: keep paths inside the root');
  press(session, 'escape');
  const text = serializeReview(session.notes);
  const task = '- [ ] S1: keep paths inside the root';
  assert.ok(text.includes(`## Security and Compliance\n\n${task}\n\n## Notes`));
  assert.equal(session.notes.tasks.at(-1).kind, 'security');
});

test('the block menu jumps to a kind and closes on escape', async () => {
  const { session } = await planScreen('kinds.md', KIND_ORDER);
  const before = session.tasksFocus;
  press(session, 'ctrl-b');
  session.pushInput('ref');
  press(session, 'escape');
  assert.equal(session.composer.tasks.planOpen, false);
  assert.equal(session.tasksFocus, before);
  assert.equal(session.mode, 'compose');
  pickSection(session, 'refactor');
  assert.equal(focusedRow(session), 'Refactoring and Technical debt');
  assert.equal(serializeReview(session.notes), KIND_ORDER);
});

test('a custom block goes at the cursor and is named at once', async () => {
  const { session } = await planScreen('kinds.md', KIND_ORDER);
  focusTask(session, rowOf(session, 'F1:'));
  pickSection(session, 'custom');
  assert.equal(session.mode, 'compose');
  assert.equal(session.editor.selectedText(), 'New block');
  session.pushInput('Open questions');
  press(session, 'down');
  const text = serializeReview(session.notes);
  assert.match(text, /F1: dark mode\n\n## Open questions\n\n## Refactoring/);
  assert.equal(focusedRow(session), 'Refactoring and Technical debt');
});

const FIXTURE_PLAN = fs.readFileSync(
  path.join(__dirname, 'fixtures', 'plan.md'),
  'utf8',
);

test('the plan menus list .plan files, which keep their bytes', async () => {
  const { session, cwd } = await openSession([sampleItem('a.js')]);
  const dir = path.join(cwd, REVIEW_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'structured-plan.md');
  fs.writeFileSync(file, FIXTURE_PLAN);
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'not a plan');
  const specs = path.join(cwd, 'specs');
  fs.mkdirSync(specs, { recursive: true });
  fs.writeFileSync(path.join(specs, 'spec.md'), '# spec\n');
  session.dispatch('tasks');
  press(session, 'ctrl-p');
  const labels = session.view().planNames;
  const at = labels.findIndex((label) => label.startsWith('structured'));
  assert.ok(at >= 0);
  assert.ok(!labels.some((label) => /notes\.txt|spec/.test(label)));
  assert.match(labels[at], /editing {2}2\/7$/);
  session.composer.tasks.choosePlan(at);
  assert.equal(session.notes.reviewPath, file);
  assert.equal(
    focusedRow(session),
    '[ ] B1 high: A lone Escape ends the read loop on the file list',
  );
  cursorAt(session, 'B1 high');
  press(session, 'ctrl-d');
  const after = fs.readFileSync(file, 'utf8');
  const before = FIXTURE_PLAN.split('\n');
  const changed = after.split('\n').filter((line, i) => line !== before[i]);
  assert.deepEqual(changed, [
    '- [x] B1 high: A lone Escape ends the read loop on the file list',
  ]);
  const agents = session.agents.planMenu();
  assert.ok(agents.some((label) => label.startsWith('structured')));
  assert.ok(!agents.some((label) => label.includes('spec')));
});

const LINKED = [
  '## Bug Reports and Fixes',
  '',
  '- [ ] B1: Escape ends the read loop',
  '  - where: `lib/term.js` readLoop:3, lib/term.js#readLoop',
  '  - related: https://github.com/tshemsedinov/reslop/issues/86',
  '- [ ] B2: Lines and missing symbols',
  '  - where: lib/term.js:4',
  '  - related: lib/term.js#nowhere',
  '- [ ] B3: Outside the root',
  '  - where: ../../.ssh/id_rsa',
  '',
].join('\n');

const TERM = [
  '// terminal',
  '',
  'const x = 1;',
  'const readLoop = () => {};',
  '',
];

const withTerm = (screen) => {
  const dir = path.join(screen.session.root, 'lib');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'term.js'), TERM.join('\n'));
  screen.repo.fileBodies['lib/term.js'] = TERM.join('\n');
  return screen;
};

const linkedScreen = async (text = LINKED) =>
  withTerm(await planScreen('linked.md', text));

test('ctrl+w opens the location on the cursor line', async () => {
  const { session } = await linkedScreen();
  assert.equal(focusedRow(session), '[ ] B1: Escape ends the read loop');
  cursorAt(session, '- where');
  press(session, 'ctrl-w');
  await session.ops.idle();
  assert.equal(session.pane, 'unit');
  assert.equal(session.nav.reviewPath, 'lib/term.js');
  assert.equal(session.nav.unitLine, 0);
  press(session, 'escape');
  assert.equal(session.pane, 'tasks');
  assert.match(focusedRow(session), /^\[ \] B1: Escape ends the read loop/);
  cursorAt(session, '- related');
  press(session, 'ctrl-w');
  assert.equal(session.pane, 'tasks');
  assert.match(session.status, /^not opened: https:\/\/github\.com/);
});

test('escape goes back to the task only from its own location', async () => {
  const { session } = await linkedScreen();
  cursorAt(session, '- where');
  press(session, 'ctrl-w');
  await session.ops.idle();
  assert.equal(session.pane, 'unit');
  await showFile(session, { path: 'lib/term.js' });
  press(session, 'escape');
  assert.notEqual(session.pane, 'tasks');
});

test('a line or a symbol opens there; a missing one at the top', async () => {
  const { session } = await linkedScreen();
  focusTask(session, rowOf(session, 'B2:'));
  cursorAt(session, '- where');
  press(session, 'ctrl-w');
  await session.ops.idle();
  assert.equal(session.pane, 'unit');
  assert.equal(session.nav.unitLine, 3);
  press(session, 'escape');
  cursorAt(session, '- related');
  press(session, 'ctrl-w');
  await session.ops.idle();
  assert.equal(session.nav.unitLine, 0);
  assert.equal(session.status, 'not found: nowhere');
  press(session, 'escape');
  const text = LINKED.replace('lib/term.js:4', 'lib/term.js#readLoop');
  const { session: other } = await linkedScreen(text);
  other.tasksFocus = rowOf(other, 'B2:');
  cursorAt(other, '- where');
  press(other, 'ctrl-w');
  await other.ops.idle();
  assert.equal(other.nav.unitLine, 3);
});

test('a location outside the root is named, never opened', async () => {
  const { session } = await linkedScreen();
  focusTask(session, rowOf(session, 'B3:'));
  press(session, 'ctrl-w');
  await session.ops.idle();
  assert.equal(session.pane, 'tasks');
  assert.equal(session.status, 'outside the repository: ../../.ssh/id_rsa');
});

test('editing a heading keeps the blank line above it', async () => {
  const { session } = await planScreen('blocks.md', SECTIONS);
  focusTask(session, rowOf(session, 'Notes'));
  session.draw();
  const before = session.lastFrame.rows.map((row) => stripAnsi(row));
  press(session, 'enter');
  session.draw();
  const after = session.lastFrame.rows.map((row) => stripAnsi(row));
  const at = before.findIndex((row) => row.trim() === 'Notes');
  assert.equal(after[at - 1].trim(), '');
  assert.equal(after[at].trim(), 'Notes');
});

test('the agent instructions open on focus and close after it', async () => {
  const { session } = await openSession([sampleItem('a.js')]);
  typeTasks(session, 'add tests');
  const shown = () => {
    session.draw();
    return session.lastFrame.rows.some((row) =>
      stripAnsi(row).includes('Read the fields under an item'),
    );
  };
  assert.equal(shown(), false);
  press(session, 'pageUp');
  assert.equal(focusedRow(session), 'Agent instructions');
  assert.equal(shown(), true);
  press(session, 'down');
  assert.match(focusedRow(session), /^Work through unchecked/);
  assert.equal(shown(), true);
  pageTo(session, '[ ] add tests');
  assert.equal(focusedRow(session), '[ ] add tests');
  assert.equal(shown(), false);
});

test('done tasks recede', async () => {
  const colored = { color: true };
  const { session } = await planScreen('linked.md', LINKED, 24, colored);
  session.notes.setTaskDone(session.notes.tasks[1].id, true);
  session.draw();
  const rows = session.lastFrame.rows;
  const row = (text) => rows.find((one) => stripAnsi(one).includes(text));
  const on = seq(THEME.chromeFg, THEME.buttonBg);
  assert.ok(row('B1: Escape ends').includes(on));
  const off = `${seq(THEME.mutedFg, THEME.ctxBg)}B2: `;
  assert.ok(row('B2: Lines and').includes(off));
});

test('the tasks footer keeps its words on 80 columns', async () => {
  const { session } = await planScreen('blocks.md', SECTIONS);
  session.draw();
  const footer = stripAnsi(session.lastFrame.rows.at(-1));
  assert.match(
    footer,
    /insert {2}\^remove {2}tab {2}\^block {2}\^done {2}\^level/,
  );
  assert.doesNotMatch(footer, /files|f {2}d {2}t/);
});

test('the title is bold text and finished checks turn green', async () => {
  const text = [
    '# Pool fixes',
    '',
    '## Bug Reports and Fixes',
    '',
    '- [ ] B1: all checks done',
    '  - check:',
    '    - [x] one',
    '- [ ] B2: one check left',
    '  - check:',
    '    - [ ] two',
    '',
  ].join('\n');
  const colored = { color: true };
  const { session } = await planScreen('title.md', text, 24, colored);
  focusTask(session, rowOf(session, 'B2:'));
  session.draw();
  const rows = session.lastFrame.rows;
  const row = (part) => rows.find((one) => stripAnsi(one).includes(part));
  const title = row('Pool fixes');
  assert.ok(title.includes(`${BOLD}${seq(THEME.chromeFg, THEME.ctxBg)}`));
  assert.ok(!title.includes(bg(THEME.taskHeadBg)));
  assert.ok(row('Bug Reports').includes(bg(THEME.taskHeadBg)));
  assert.ok(row('B1: all').includes(fg(THEME.addLineFg)));
  assert.ok(!row('B2: one').includes(fg(THEME.addLineFg)));
});

test('notes show their line and code proposals their place', async () => {
  const { lines } = await planScreen(
    'notes.md',
    fs.readFileSync(path.join(__dirname, 'fixtures', 'plan.md'), 'utf8'),
    60,
  );
  const note = lines.find((line) => line.includes('keep the gap'));
  assert.match(note, /^ \[ \] keep the gap between the two sides +:12$/);
  const code = lines.find((line) => line.includes('code lib'));
  assert.match(code, /^ \[x\] code lib\/diff\/align\.js:40 {3}const gap = 1;$/);
});

test('a draft in a new kind shows the heading it will go under', async () => {
  const { session } = await openSession([sampleItem('a.js')]);
  session.dispatch('tasks');
  session.draw();
  const plain = () => session.lastFrame.rows.map((row) => stripAnsi(row));
  const at = plain().findIndex((row) => row.includes('Feature requests'));
  assert.ok(at > 0);
  assert.match(plain()[at + 1], /^ \[ \] /);
  assert.equal(focusedRow(session), '[ ] ');
  press(session, 'escape');
  session.draw();
  assert.ok(!plain().some((row) => row.includes('Feature requests')));
});

test('ctrl+z brings back the last dropped task or block', async () => {
  const { session } = await planScreen('blocks.md', SECTIONS);
  focusTask(session, rowOf(session, 'B2:'));
  press(session, 'ctrl-r');
  assert.equal(session.status, 'dropped · ctrl+z to undo');
  assert.equal(rowOf(session, 'B2:'), -1);
  press(session, 'ctrl-z');
  assert.equal(session.status, 'restored');
  assert.equal(focusedRow(session), '[ ] B2: timeout names the pool');
  assert.equal(fs.readFileSync(session.notes.reviewPath, 'utf8'), SECTIONS);
  focusTask(session, rowOf(session, 'Bug Reports and Fixes'));
  press(session, 'ctrl-r', 'y', 'ctrl-z');
  assert.equal(serializeReview(session.notes), SECTIONS);
  press(session, 'ctrl-r', 'y');
  focusTask(session, rowOf(session, 'S1:'));
  press(session, 'x', 'ctrl-z');
  assert.equal(session.editor.text, 'S1: keep paths inside the root');
  press(session, 'ctrl-d', 'ctrl-z');
  assert.equal(session.status, 'nothing to undo');
});

test('ctrl+l sets the priority of the focused task from a pop-up', async () => {
  const { session } = await planScreen('blocks.md', SECTIONS);
  focusTask(session, rowOf(session, 'B2:'));
  press(session, 'ctrl-l');
  assert.deepEqual(Object.values(session.nav.contextMenu.keys), [
    'h',
    'n',
    'l',
  ]);
  press(session, 'h');
  assert.equal(focusedRow(session), '[ ] B2 high: timeout names the pool');
  press(session, 'ctrl-l', 'n');
  assert.equal(focusedRow(session), '[ ] B2: timeout names the pool');
  press(session, 'ctrl-l', 'escape', '!');
  assert.equal(session.nav.contextMenu, null);
  assert.equal(session.editor.text, 'B2: timeout names the pool!');
});

test('ctrl+f jumps between the blocks that match', async () => {
  const { session } = await planScreen('blocks.md', SECTIONS);
  const all = session.composer.tasks.taskTexts();
  press(session, 'ctrl-f');
  assert.equal(session.mode, 'find');
  session.draw();
  assert.match(stripAnsi(session.lastFrame.rows.at(-2)), /^ find: {2}/);
  session.pushInput('pool');
  assert.deepEqual(session.composer.tasks.taskTexts(), all);
  assert.equal(
    focusedRow(session),
    '[ ] B1: pool hands a connection out twice',
  );
  press(session, 'down');
  assert.equal(focusedRow(session), '[ ] B2: timeout names the pool');
  press(session, 'down');
  assert.equal(
    focusedRow(session),
    '[ ] B1: pool hands a connection out twice',
  );
  press(session, 'up', 'enter');
  assert.equal(session.mode, 'compose');
  assert.equal(session.editor.text, 'B2: timeout names the pool');
  press(session, 'ctrl-f');
  assert.equal(session.nav.find.query, 'pool');
  session.pushInput('zzz');
  assert.equal(session.nav.find.miss, true);
  assert.equal(focusedRow(session), '[ ] B2: timeout names the pool');
  press(session, 'escape');
  assert.equal(session.pane, 'tasks');
  assert.equal(session.mode, 'compose');
});

test('tab folds a block under its heading', async () => {
  const { session } = await planScreen('blocks.md', SECTIONS);
  focusTask(session, rowOf(session, 'Bug Reports and Fixes'));
  press(session, 'tab');
  assert.equal(rowOf(session, 'B1:'), -1);
  session.draw();
  const body = () => session.lastFrame.rows.map((row) => stripAnsi(row));
  assert.ok(body().some((row) => row.trim() === '(2 tasks)'));
  assert.equal(focusedRow(session), 'Bug Reports and Fixes');
  press(session, 'down');
  session.draw();
  const folded = ' Bug Reports and Fixes  (2 tasks)';
  assert.ok(body().some((row) => row.includes(folded)));
  press(session, 'up');
  assert.equal(serializeReview(session.notes), SECTIONS);
  press(session, 'tab');
  assert.ok(rowOf(session, 'B1:') > 0);
});

test('the status line counts open and done tasks', async () => {
  const { session } = await planScreen('s.md', STRUCTURED);
  session.draw();
  const status = stripAnsi(session.lastFrame.rows.at(-2));
  assert.match(status, /open 2 · done 0\/2 $/);
});

test('a plan opened again comes back as it was left', async () => {
  const { session } = await planScreen('blocks.md', SECTIONS);
  const other = path.join(session.root, REVIEW_DIR, 'other.md');
  fs.writeFileSync(other, '- [ ] x\n');
  focusTask(session, rowOf(session, 'Security and Compliance'));
  press(session, 'tab');
  focusTask(session, rowOf(session, 'B2:'));
  session.composer.tasks.openPlan('other.md');
  assert.equal(focusedRow(session), '[ ] x');
  session.composer.tasks.openPlan('blocks.md');
  assert.equal(focusedRow(session), '[ ] B2: timeout names the pool');
  assert.equal(rowOf(session, 'S1:'), -1);
});

test('ctrl+w opens the file of a note and ctrl+c copies a task', async (t) => {
  const plan = fs.readFileSync(path.join(__dirname, 'fixtures', 'plan.md'));
  const { session, repo } = await planScreen('notes.md', `${plan}`, 60);
  const dir = path.join(session.root, 'lib', 'diff');
  fs.mkdirSync(dir, { recursive: true });
  const code = Array.from({ length: 20 }, (_, at) => `line ${at + 1}`);
  fs.writeFileSync(path.join(dir, 'align.js'), code.join('\n'));
  repo.fileBodies['lib/diff/align.js'] = code.join('\n');
  focusTask(session, rowOf(session, 'keep the gap'));
  press(session, 'ctrl-w');
  await session.ops.idle();
  assert.equal(session.pane, 'unit');
  assert.equal(session.nav.unitLine, 11);
  press(session, 'escape');
  assert.equal(session.pane, 'tasks');
  const copied = t.mock.method(clipboard, 'copyText', (text) => !!text);
  focusTask(session, rowOf(session, 'D1:'));
  press(session, 'ctrl-c');
  assert.equal(session.status, 'copied');
  assert.match(copied.mock.calls.at(-1).arguments[0], /^- \[ \] D1: Split/);
  press(session, 'o');
  assert.equal(session.mode, 'compose');
  assert.match(session.editor.text, /escape kindo\n/);
});

test('ctrl+s starts on the agents screen with the plan chosen', async () => {
  const { session } = await planScreen('blocks.md', SECTIONS);
  press(session, 'ctrl-s');
  assert.equal(session.pane, 'agents');
  assert.equal(session.mode, 'review');
  assert.equal(session.agents.planPath, session.notes.reviewPath);
  assert.equal(session.agents.jobs.length, 0);
});

test('a block stays in place when it opens in the editor', async () => {
  const plan = fs.readFileSync(path.join(__dirname, 'fixtures', 'plan.md'));
  const { session } = await planScreen('notes.md', `${plan}`, 60);
  session.stdout.columns = 40;
  const tasks = session.composer.tasks;
  const frame = () => {
    session.draw();
    return session.lastFrame.rows.map((row) => stripAnsi(row).trimEnd());
  };
  const shapes = ['text', 'heading'];
  const blocks = tasks
    .rows()
    .filter((row) => shapes.includes(row.type))
    .filter((row) => row.block.text !== 'Agent instructions');
  assert.ok(blocks.some((row) => row.block.fence));
  for (const row of blocks) {
    focusTask(session, tasks.rowIndex(row));
    const shown = frame();
    tasks.settle();
    assert.equal(session.mode, 'compose');
    const edited = frame();
    const at = shown.findIndex((line, i) => line !== edited[i]);
    assert.equal(at, -1, `${row.block.lines[0]}: ${shown[at]}`);
  }
});

test('delete takes letters and ctrl+r removes the block', async () => {
  const { session } = await planScreen('blocks.md', SECTIONS);
  focusTask(session, rowOf(session, 'B2:'));
  press(session, 'home', 'delete');
  assert.equal(session.editor.text, '2: timeout names the pool');
  press(session, 'end', 'delete');
  assert.equal(session.editor.text, '2: timeout names the pool');
  press(session, 'ctrl-r');
  assert.equal(rowOf(session, 'timeout names'), -1);
  assert.equal(session.status, 'dropped · ctrl+z to undo');
});

test('a folded block of text shows its first lines', async () => {
  const text = [
    '## Notes',
    '',
    'one',
    'two',
    '',
    'three',
    'four',
    '',
    '## Bug Reports and Fixes',
    '',
    '- [ ] B1: x',
    '',
  ].join('\n');
  const { session } = await planScreen('peek.md', text);
  focusTask(session, rowOf(session, 'Notes'));
  press(session, 'tab', 'down');
  session.draw();
  const rows = session.lastFrame.rows.map((row) => stripAnsi(row).trimEnd());
  const at = rows.indexOf(' Notes');
  assert.ok(at > 0);
  assert.deepEqual(rows.slice(at + 1, at + 4), [
    '   one',
    '   two',
    '   three ...',
  ]);
  focusTask(session, rowOf(session, 'Bug Reports'));
  press(session, 'tab');
  session.draw();
  const folded = session.lastFrame.rows.map((row) => stripAnsi(row));
  assert.ok(folded.some((row) => row.trim() === '(1 task)'));
});

test('a long title gives way to what the task hides', async () => {
  const text = [
    '## Bug Reports and Fixes',
    '',
    `- [ ] B1: ${'a long title '.repeat(8)}`,
    '  - where: lib/a.js',
    '  - do: fix it',
    '- [ ] B2: other',
    '',
  ].join('\n');
  const { session } = await planScreen('long.md', text);
  session.stdout.columns = 60;
  focusTask(session, rowOf(session, 'B2:'));
  session.draw();
  const row = session.lastFrame.rows
    .map((one) => stripAnsi(one))
    .find((one) => one.includes('B1:'));
  assert.match(row, /… {2}\(where, do\)\s*$/);
});

test('field names are blue, values green, and a priority yellow', async () => {
  const colored = { color: true };
  const { session } = await planScreen('s.md', STRUCTURED, 24, colored);
  session.composer.tasks.settle();
  const row = (text) => {
    session.draw();
    return session.lastFrame.rows.find((one) => stripAnsi(one).includes(text));
  };
  const where = row('- where: lib/session');
  assert.ok(where.includes(`${fg(THEME.shaFg)}`));
  assert.ok(where.includes(`${fg(THEME.addLineFg)}`));
  assert.ok(row('read loop survives').includes(`${fg(THEME.addLineFg)}`));
  assert.ok(row('B1 high:').includes(`${fg(THEME.warnFg)}`));
  focusTask(session, rowOf(session, 'B2:'));
  assert.ok(row('B1 high:').includes(`${fg(THEME.warnFg)}`));
  assert.equal(row('(where'), row('B1 high:'));
});

test('each list item and paragraph is edited on its own', async () => {
  const text = [
    '## Notes',
    '',
    'The watcher skips:',
    '- node_modules',
    '- dist, and the',
    '  build output',
    '',
    'A paragraph',
    'on two lines.',
    '',
  ].join('\n');
  const { session } = await planScreen('notes.md', text);
  assert.deepEqual(session.composer.tasks.taskTexts(), [
    'Notes',
    'The watcher skips:',
    '- node_modules',
    '- dist, and the\n  build output',
    'A paragraph\non two lines.',
  ]);
  focusTask(session, rowOf(session, '- node_modules'));
  press(session, 'end', 'enter');
  session.pushInput('- coverage');
  press(session, 'down');
  assert.equal(
    serializeReview(session.notes),
    text.replace('- node_modules\n', '- node_modules\n- coverage\n'),
  );
  assert.ok(rowOf(session, '- coverage') > 0);
});

test('an item typed under another is saved once, however often', async () => {
  const text = '## Notes\n\n1. one\n- a\n';
  const { session } = await planScreen('items.md', text);
  focusTask(session, rowOf(session, '- a'));
  press(session, 'end', 'enter');
  session.pushInput('- b');
  session.autosave();
  session.autosave();
  session.pushInput('x');
  session.autosave();
  assert.equal(
    serializeReview(session.notes),
    '## Notes\n\n1. one\n- a\n- bx\n',
  );
  assert.equal(session.editor.text, '- bx');
});
