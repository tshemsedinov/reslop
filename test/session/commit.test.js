'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const helpers = require('../helpers.js');
const { press, click, rightClick } = helpers;
const ansi = require('../../lib/term/ansi.js');
const { stripAnsi } = ansi;
const sessionHelpers = require('../session-helpers.js');
const { sampleItem, openSession, clickFooter, dragBetween } = sessionHelpers;
const { listCell, modifiedClick, shiftClick, ctrlClick } = sessionHelpers;

const ctrlShiftClick = (session, cell) => modifiedClick(session, cell, 20);

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
  session.dispatch('blockTask');
  session.pushInput('c');
  assert.equal(session.mode, 'compose');
  assert.equal(session.composeKind, 'blockTask');
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

test('files pane a adds and delete drops', async () => {
  const added = await openSession([sampleItem('a.js')], { startPane: 'files' });
  press(added.session, 'down');
  added.session.pushInput('a');
  await added.session.ops.idle();
  assert.equal(added.repo.added.length, 1);
  const reverted = await openSession([sampleItem('a.js')], {
    startPane: 'files',
  });
  press(reverted.session, 'down', 'delete');
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
