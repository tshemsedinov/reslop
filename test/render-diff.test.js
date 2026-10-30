'use strict';

const helpers = require('./helpers.js');
const { sampleHunk, reviewView, assertPrompt, YES_NO } = helpers;
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { displayLines } = require('../lib/diff/diff.js');
const render = require('../lib/render/render.js');
const ansi = require('../lib/term/ansi.js');
const { THEME, CODE_FG, fg, bg, stripAnsi, BOLD } = ansi;
const { visibleWidth } = ansi;

test('AC2 muted line color differs from strong char color', () => {
  assert.notDeepEqual(THEME.delLineBg, THEME.delCharBg);
  assert.notDeepEqual(THEME.addLineBg, THEME.addCharBg);
  assert.notDeepEqual(THEME.delLineFg, THEME.delCharFg);
  assert.notDeepEqual(THEME.addLineFg, THEME.addCharFg);
  const hunk = sampleHunk([
    { type: 'del', text: 'hello world', noNl: false, blockId: 0 },
    { type: 'add', text: 'hello World', noNl: false, blockId: 0 },
  ]);
  const lines = displayLines(hunk, 0);
  const del = render.paintDiffLine(lines[0], 40, true, 'unstaged', 'txt');
  const add = render.paintDiffLine(lines[1], 40, true, 'unstaged', 'txt');
  assert.ok(del.includes(bg(THEME.delLineBg)));
  assert.ok(del.includes(bg(THEME.delCharBg)));
  assert.ok(add.includes(bg(THEME.addLineBg)));
  assert.ok(add.includes(bg(THEME.addCharBg)));
  assert.ok(del.includes(fg(CODE_FG.plain)));
  assert.ok(!del.includes(fg(THEME.delLineFg)));
  assert.ok(!add.includes(fg(THEME.addLineFg)));
  const view = reviewView({
    origin: 'unstaged',
    file: { newPath: 'f.js', oldPath: 'f.js', isBinary: false },
    hunk,
    blockId: 0,
  });
  const frame = render.renderFrame(view, {
    width: 80,
    height: 16,
    color: true,
  });
  assert.ok(frame.text.includes(bg(THEME.delCharBg)));
  assert.ok(frame.text.includes(bg(THEME.addCharBg)));
  assert.ok(frame.text.includes(fg(CODE_FG.variable)));
  assert.ok(!frame.text.includes(fg(THEME.delLineFg)));
  assert.equal(frame.rows.length, 16);
  assert.ok(!frame.text.includes('@@'));
  assert.match(render.headerText(view), /reslop: demo\/f\.js$/);
  assert.ok(!/\d+\/\d+/.test(render.headerText(view)));
});

test('AC27 side layout paints old left and new right', () => {
  const hunk = sampleHunk([
    { type: 'del', text: 'hello world', noNl: false, blockId: 0 },
    { type: 'add', text: 'hello World', noNl: false, blockId: 0 },
  ]);
  const view = reviewView(
    {
      origin: 'unstaged',
      file: { newPath: 'f.js', oldPath: 'f.js', isBinary: false },
      hunk,
      blockId: 0,
    },
    { pane: 'diff', layout: 'side' },
  );
  const width = 80;
  const frame = render.renderFrame(view, { width, height: 8, color: true });
  const gap = frame.rows[1];
  assert.equal(stripAnsi(gap).trim(), '');
  assert.ok(gap.includes(bg(THEME.splitGutterBg)));
  const row = frame.rows[2];
  const plain = stripAnsi(row);
  assert.equal(visibleWidth(plain), width);
  assert.match(plain, /-/);
  assert.match(plain, /\+/);
  assert.ok(!plain.includes('|'));
  assert.ok(!plain.includes('│'));
  const leftW = Math.floor((width - 1) / 2);
  assert.equal(plain[leftW], ' ');
  assert.ok(plain.slice(0, leftW).includes('hello world'));
  assert.ok(plain.slice(leftW + 1).includes('hello World'));
  assert.ok(row.includes(bg(THEME.delLineBg)));
  assert.ok(row.includes(bg(THEME.addLineBg)));
  assert.ok(row.includes(bg(THEME.splitGutterBg)));
  const blank = frame.rows[3];
  assert.ok(blank.includes(bg(THEME.splitGutterBg)));
  assert.deepEqual(THEME.splitGutterBg, THEME.chromeBg);
});

test('js toString paints in side layout', () => {
  const hunk = sampleHunk([
    { type: 'del', text: 'foo.toString()', noNl: false, blockId: 0 },
    { type: 'add', text: 'bar.toString()', noNl: false, blockId: 0 },
  ]);
  const view = reviewView(
    {
      origin: 'unstaged',
      file: { newPath: 'f.js', oldPath: 'f.js', isBinary: false },
      hunk,
      blockId: 0,
    },
    { pane: 'diff', layout: 'side' },
  );
  const frame = render.renderFrame(view, { width: 80, height: 8, color: true });
  const plain = stripAnsi(frame.rows[2]);
  assert.ok(plain.includes('foo.toString()'));
  assert.ok(plain.includes('bar.toString()'));
});

test('AC29 short diff leaves a gap under the header', () => {
  const addHunk = (n) => ({
    oldStart: 1,
    oldCount: 0,
    newStart: 1,
    newCount: n,
    header: `@@ -1,0 +1,${n} @@`,
    lines: Array.from({ length: n }, (_, i) => ({
      type: 'add',
      text: `line${i}`,
      noNl: false,
      blockId: 0,
    })),
  });
  const viewFor = (n, scroll) => ({
    pane: 'diff',
    item: {
      origin: 'unstaged',
      file: { newPath: 'f.js', oldPath: 'f.js', isBinary: false },
      hunk: addHunk(n),
      blockId: 0,
    },
    index: 0,
    total: 1,
    scroll,
    status: '',
    counts: { staged: 0, unstaged: 1, untracked: 0 },
    repoName: 'demo',
  });
  const opt = { width: 80, height: 8, color: true };
  const short = render.renderFrame(viewFor(1, 0), opt);
  assert.equal(stripAnsi(short.rows[1]).trim(), '');
  assert.ok(short.rows[1].includes(bg(THEME.ctxBg)));
  assert.match(stripAnsi(short.rows[2]), /\+ line0/);
  const full = render.renderFrame(viewFor(5, 0), opt);
  assert.equal(stripAnsi(full.rows[1]).trim(), '');
  assert.match(stripAnsi(full.rows[2]), /\+ line0/);
  const scrolled = render.renderFrame(viewFor(8, 1), opt);
  assert.match(stripAnsi(scrolled.rows[1]), /\+ line0/);
  const leadingBlank = render.renderFrame(
    {
      ...viewFor(1, 0),
      item: {
        ...viewFor(1, 0).item,
        hunk: {
          oldStart: 1,
          oldCount: 1,
          newStart: 2,
          newCount: 2,
          header: '@@ -1,1 +2,2 @@',
          lines: [
            { type: 'ctx', text: '', noNl: false, blockId: null },
            { type: 'add', text: 'line0', noNl: false, blockId: 0 },
          ],
        },
      },
    },
    opt,
  );
  assert.equal(stripAnsi(leadingBlank.rows[1]).trim(), '');
  assert.match(stripAnsi(leadingBlank.rows[2]), /\+ line0/);
  const leadingEmptyAdd = render.renderFrame(
    {
      ...viewFor(1, 0),
      item: {
        ...viewFor(1, 0).item,
        hunk: {
          oldStart: 1,
          oldCount: 0,
          newStart: 1,
          newCount: 2,
          header: '@@ -1,0 +1,2 @@',
          lines: [
            { type: 'add', text: '', noNl: false, blockId: 0 },
            { type: 'add', text: 'line0', noNl: false, blockId: 0 },
          ],
        },
      },
    },
    opt,
  );
  assert.equal(stripAnsi(leadingEmptyAdd.rows[1]).trim(), '');
  assert.match(stripAnsi(leadingEmptyAdd.rows[2]), /\+ line0/);
  const leadingCtx = render.renderFrame(
    {
      ...viewFor(1, 0),
      item: {
        ...viewFor(1, 0).item,
        hunk: {
          oldStart: 1,
          oldCount: 1,
          newStart: 1,
          newCount: 2,
          header: '@@ -1,1 +1,2 @@',
          lines: [
            { type: 'ctx', text: '  hold() {', noNl: false, blockId: null },
            { type: 'add', text: 'line0', noNl: false, blockId: 0 },
          ],
        },
      },
    },
    opt,
  );
  assert.equal(stripAnsi(leadingCtx.rows[1]).trim(), '');
  assert.match(stripAnsi(leadingCtx.rows[2]), /hold/);
  assert.match(stripAnsi(leadingCtx.rows[3]), /\+ line0/);
});

test('AC30 diff lines keep a two-column left gutter', () => {
  const hunk = {
    oldStart: 1,
    oldCount: 2,
    newStart: 1,
    newCount: 2,
    header: '@@ -1,2 +1,2 @@',
    lines: [
      { type: 'ctx', text: 'hold() {', noNl: false, blockId: null },
      { type: 'del', text: 'hello world', noNl: false, blockId: 0 },
      { type: 'add', text: 'hello World', noNl: false, blockId: 0 },
    ],
  };
  const lines = displayLines(hunk, 0);
  const ctx = stripAnsi(
    render.paintDiffLine(lines[0], 40, false, 'unstaged', 'txt'),
  );
  const del = stripAnsi(
    render.paintDiffLine(lines[1], 40, false, 'unstaged', 'txt'),
  );
  const add = stripAnsi(
    render.paintDiffLine(lines[2], 40, false, 'unstaged', 'txt'),
  );
  assert.equal(ctx.startsWith('  hold'), true);
  assert.equal(del.startsWith('- hello world'), true);
  assert.equal(add.startsWith('+ hello World'), true);
  const view = reviewView(
    {
      origin: 'unstaged',
      file: { newPath: 'f.js', oldPath: 'f.js', isBinary: false },
      hunk,
      blockId: 0,
    },
    { pane: 'diff', layout: 'side' },
  );
  const frame = render.renderFrame(view, {
    width: 80,
    height: 8,
    color: false,
  });
  const row = frame.rows[3];
  const leftW = Math.floor((80 - 1) / 2);
  assert.equal(row.slice(0, 2), '- ');
  assert.equal(row.slice(2, 13), 'hello world');
  assert.equal(row.slice(leftW + 1, leftW + 3), '+ ');
  assert.equal(row.slice(leftW + 3, leftW + 14), 'hello World');
});

test('AC23 staged lines are grey with plus and minus marks', () => {
  const hunk = sampleHunk([
    { type: 'del', text: 'hello world', noNl: false, blockId: 0 },
    { type: 'add', text: 'hello World', noNl: false, blockId: 0 },
  ]);
  const lines = displayLines(hunk, 0);
  const del = render.paintDiffLine(lines[0], 40, true, 'staged', 'txt');
  const add = render.paintDiffLine(lines[1], 40, true, 'staged', 'txt');
  assert.equal(stripAnsi(del).startsWith('-'), true);
  assert.equal(stripAnsi(add).startsWith('+'), true);
  assert.ok(del.includes(bg(THEME.stagedDelLineBg)));
  assert.ok(del.includes(bg(THEME.stagedDelCharBg)));
  assert.ok(add.includes(bg(THEME.stagedAddLineBg)));
  assert.ok(add.includes(bg(THEME.stagedAddCharBg)));
  assert.ok(del.includes(fg(CODE_FG.plain)));
  assert.ok(!del.includes(fg(THEME.delLineFg)));
  assert.ok(!del.includes(bg(THEME.delCharBg)));
  assert.ok(!add.includes(fg(THEME.addLineFg)));
  assert.ok(!add.includes(bg(THEME.addCharBg)));
  const view = {
    item: {
      origin: 'staged',
      file: { newPath: 'f.js', oldPath: 'f.js', isBinary: false },
      hunk,
      blockId: 0,
    },
    index: 0,
    total: 1,
    scroll: 0,
    status: '',
    counts: { staged: 1, unstaged: 0, untracked: 0 },
    repoName: 'demo',
  };
  const frame = render.renderFrame(view, {
    width: 80,
    height: 16,
    color: true,
  });
  assert.ok(frame.text.includes(bg(THEME.stagedDelCharBg)));
  assert.ok(frame.text.includes(bg(THEME.stagedAddCharBg)));
  assert.ok(!frame.text.includes(bg(THEME.delCharBg)));
  assert.ok(!frame.text.includes(bg(THEME.addCharBg)));
  const plain = render.renderFrame(view, {
    width: 80,
    height: 16,
    color: false,
  });
  assert.match(plain.text, /^-/m);
  assert.match(plain.text, /^\+/m);
});

test('footer keeps info status on the counts line', () => {
  const hunk = sampleHunk([
    { type: 'add', text: 'x', noNl: false, blockId: 0 },
  ]);
  const view = {
    item: {
      origin: 'unstaged',
      file: { newPath: 'f.js', oldPath: 'f.js', isBinary: false },
      hunk,
      blockId: 0,
    },
    index: 0,
    total: 1,
    scroll: 0,
    status: 'copied',
    counts: { staged: 0, unstaged: 1, untracked: 0 },
    repoName: 'demo',
  };
  const frame = render.renderFrame(view, {
    width: 80,
    height: 16,
    color: false,
  });
  assert.equal(frame.rows.length, 16);
  const statusRow = frame.rows[frame.rows.length - 2];
  assert.match(statusRow, /0\/1/);
  assert.match(statusRow, /copied /);
  assert.equal(statusRow.endsWith(' '), true);
  const saved = render.renderFrame(
    { ...view, status: 'saved' },
    { width: 80, height: 16, color: false },
  );
  const savedRow = saved.rows[saved.rows.length - 2];
  assert.match(savedRow, /saved /);
  assert.equal(savedRow.endsWith(' '), true);
});

test('status line shows tasks done against the total', () => {
  const hunk = sampleHunk([
    { type: 'add', text: 'x', noNl: false, blockId: 0 },
  ]);
  const view = {
    item: {
      origin: 'unstaged',
      file: { newPath: 'f.js', oldPath: 'f.js', isBinary: false },
      hunk,
      blockId: 0,
    },
    index: 0,
    total: 1,
    scroll: 0,
    status: '',
    counts: {
      staged: 6,
      unstaged: 11,
      untracked: 0,
      tasks: 2,
      tasksDone: 1,
    },
    repoName: 'demo',
    branch: 'main',
  };
  const frame = render.renderFrame(view, {
    width: 80,
    height: 16,
    color: false,
  });
  const statusRow = frame.rows[frame.rows.length - 2];
  assert.match(statusRow, /main {2}tasks 1\/2/);
  assert.equal(statusRow.includes('feedback'), false);
  assert.equal(statusRow.includes('code'), false);
  assert.ok(!statusRow.includes('['));
  assert.match(statusRow, /6\/17\s*$/);
  assert.ok(!statusRow.includes('untracked'));
  const notesAt = statusRow.indexOf('tasks 1/2');
  const ratioAt = statusRow.indexOf('6/17');
  assert.ok(notesAt < ratioAt);
  const colored = render.renderFrame(view, {
    width: 80,
    height: 16,
    color: true,
  });
  const painted = colored.rows[colored.rows.length - 2];
  const chromeBg = bg(THEME.chromeBg);
  const white = `${fg(THEME.buttonHotFg)}${chromeBg}`;
  assert.ok(painted.includes(`${white}main`));
  assert.ok(!painted.includes(`${white}[`));
  assert.equal(frame.statusHits.length, 1);
  assert.equal(frame.statusHits[0].id, 'branch');
  assert.equal(frame.statusHits[0].y, frame.rows.length - 1);
  assert.equal(frame.statusHits[0].x0, 1);
  assert.equal(frame.statusHits[0].x1, 5);
});

test('status line includes repo +/- totals', () => {
  const files = [
    {
      path: 'a.js',
      status: 'unstaged',
      remaining: 4,
      staged: 0,
      added: 12,
      removed: 5,
    },
    {
      path: 'b.js',
      status: 'staged',
      remaining: 1,
      staged: 1,
      added: 3,
      removed: 1,
    },
    {
      path: 'README.md',
      status: 'untracked',
      remaining: 12,
      staged: 0,
      added: 20,
      removed: 0,
    },
  ];
  const view = {
    pane: 'files',
    files,
    fileCursor: 0,
    repoName: 'demo',
    branch: 'main',
    counts: { staged: 1, unstaged: 1, untracked: 1 },
    status: '',
    scroll: 0,
  };
  const frame = render.renderFrame(view, {
    width: 80,
    height: 10,
    color: false,
  });
  const statusRow = stripAnsi(frame.rows[frame.rows.length - 2]);
  assert.match(statusRow, /main {2}tasks 0\/0/);
  assert.ok(!statusRow.includes('['));
  assert.match(statusRow, /\+3\/35 {2}-1\/6 {2}1\/17\s*$/);
  assert.ok(!statusRow.includes('untracked'));
  const notesAt = statusRow.indexOf('tasks 0/0');
  const plusAt = statusRow.indexOf('+3/35');
  assert.ok(notesAt < plusAt);
  const colored = render.renderFrame(view, {
    width: 80,
    height: 10,
    color: true,
  });
  const painted = colored.rows[colored.rows.length - 2];
  assert.ok(painted.includes(fg(THEME.addLineFg)));
  assert.ok(painted.includes(fg(THEME.delLineFg)));
});

test('npm run tasks and branches omit diff totals', () => {
  const files = [
    {
      path: 'a.js',
      status: 'unstaged',
      remaining: 4,
      staged: 0,
      added: 12,
      removed: 5,
    },
  ];
  const base = {
    files,
    fileCursor: 0,
    repoName: 'demo',
    branch: 'main',
    counts: { staged: 0, unstaged: 1 },
    status: '',
    scroll: 0,
  };
  const quiet = new Set(['npm', 'packages', 'branches']);
  for (const pane of ['npm', 'packages', 'tasks', 'branches']) {
    const frame = render.renderFrame(
      { ...base, pane },
      { width: 80, height: 10, color: false },
    );
    const statusRow = stripAnsi(frame.rows[frame.rows.length - 2]);
    assert.equal(statusRow.includes('+'), false, pane);
    assert.equal(statusRow.includes('-'), false, pane);
    if (pane === 'tasks') {
      assert.match(statusRow, /open 0 · done 0\/0\s*$/);
      assert.equal(statusRow.includes('0/4'), false, pane);
      continue;
    }
    if (!quiet.has(pane)) {
      assert.match(statusRow, /0\/4/);
      assert.match(statusRow, /tasks 0\/0/);
      continue;
    }
    assert.equal(statusRow.includes('0/4'), false, pane);
    assert.equal(statusRow.includes('tasks'), false, pane);
    assert.match(statusRow, /^ main\s*$/);
  }
});

test('long operations paint an infinite progress bar', () => {
  assert.equal(render.formatBusyStatus('pulled', 0), 'pulled');
  const first = render.formatBusyStatus('pulling', 0);
  const next = render.formatBusyStatus('pulling', 1);
  assert.match(first, /^pulling {2}·•●•·/);
  assert.notEqual(first, next);
  const busy = [
    'loading',
    'checking npm',
    'updating reslop',
    'npm i',
    'npm uninstall',
    'npm audit fix',
    'checking out',
    'creating branch',
    'rebasing',
    'dropping',
    'committing',
    'force pushing',
  ];
  for (const label of busy) {
    assert.ok(
      render.formatBusyStatus(label, 0).startsWith(`${label}  ·`),
      label,
    );
  }
  const view = {
    pane: 'files',
    files: [],
    counts: { staged: 0, unstaged: 0, untracked: 0 },
    branch: 'main',
    status: 'pulling',
    progressFrame: 0,
    repoName: 'demo',
    scroll: 0,
  };
  const frame = render.renderFrame(view, {
    width: 80,
    height: 12,
    color: false,
  });
  const row = stripAnsi(frame.rows[frame.rows.length - 2]);
  const shown = render.formatBusyStatus('pulling', 0);
  const msgAt = row.indexOf(shown);
  const leftEnd = row.indexOf('tasks 0/0') + 'tasks 0/0'.length;
  const rightAt = row.lastIndexOf('0/0');
  assert.ok(msgAt > leftEnd);
  assert.ok(msgAt + visibleWidth(shown) <= rightAt);
  const leftGap = msgAt - leftEnd;
  const rightGap = rightAt - (msgAt + visibleWidth(shown));
  assert.ok(Math.abs(leftGap - rightGap) <= 1);
});

test('quit prompt warns that tests will be terminated', () => {
  const hunk = sampleHunk([
    { type: 'add', text: 'x', noNl: false, blockId: 0 },
  ]);
  const view = reviewView(
    {
      origin: 'unstaged',
      file: { newPath: 'f.js', oldPath: 'f.js', isBinary: false },
      hunk,
      blockId: 0,
    },
    { mode: 'confirmQuit', quitWarning: ' exit will terminate tests' },
  );
  const text = ' exit will terminate tests y/n';
  const { statusRow, plain } = assertPrompt(view, text, YES_NO);
  assert.ok(!plain.includes('finish as ready'));
  assert.ok(!plain.includes('continue next time'));
  assert.ok(!statusRow.includes(bg(THEME.buttonBg)));
  assert.ok(statusRow.includes(BOLD));
});
