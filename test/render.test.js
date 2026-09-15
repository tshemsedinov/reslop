'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { displayLines } = require('../lib/diff.js');
const render = require('../lib/render.js');
const wrap = require('../lib/wrap.js');
const ansi = require('../lib/ansi.js');
const { THEME, CODE_FG, fg, bg, stripAnsi, BOLD, seq } = ansi;
const { ESC, RESET, EL, visibleWidth } = ansi;

test('AC2 muted line color differs from strong char color', () => {
  assert.notDeepEqual(THEME.delLineBg, THEME.delCharBg);
  assert.notDeepEqual(THEME.addLineBg, THEME.addCharBg);
  assert.notDeepEqual(THEME.delLineFg, THEME.delCharFg);
  assert.notDeepEqual(THEME.addLineFg, THEME.addCharFg);
  const hunk = {
    oldStart: 1,
    oldCount: 1,
    newStart: 1,
    newCount: 1,
    header: '@@ -1,1 +1,1 @@',
    lines: [
      { type: 'del', text: 'hello world', noNl: false, blockId: 0 },
      { type: 'add', text: 'hello World', noNl: false, blockId: 0 },
    ],
  };
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
    counts: { staged: 0, unstaged: 1, untracked: 0 },
    repoName: 'demo',
  };
  const frame = render.renderFrame(view, {
    width: 80,
    height: 16,
    color: true,
  });
  assert.ok(frame.text.includes(render.DEL_CHAR_BG));
  assert.ok(frame.text.includes(render.ADD_CHAR_BG));
  assert.ok(frame.text.includes(fg(CODE_FG.variable)));
  assert.ok(!frame.text.includes(fg(THEME.delLineFg)));
  assert.equal(frame.rows.length, 16);
  assert.ok(!frame.text.includes('@@'));
  assert.match(render.headerText(view), /reslop: demo\/f\.js unstaged 1\/1/);
});

test('AC27 side layout paints old left and new right', () => {
  const hunk = {
    oldStart: 1,
    oldCount: 1,
    newStart: 1,
    newCount: 1,
    header: '@@ -1,1 +1,1 @@',
    lines: [
      { type: 'del', text: 'hello world', noNl: false, blockId: 0 },
      { type: 'add', text: 'hello World', noNl: false, blockId: 0 },
    ],
  };
  const view = {
    pane: 'diff',
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
    layout: 'side',
    counts: { staged: 0, unstaged: 1, untracked: 0 },
    repoName: 'demo',
  };
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
  const hunk = {
    oldStart: 1,
    oldCount: 1,
    newStart: 1,
    newCount: 1,
    header: '@@ -1,1 +1,1 @@',
    lines: [
      { type: 'del', text: 'foo.toString()', noNl: false, blockId: 0 },
      { type: 'add', text: 'bar.toString()', noNl: false, blockId: 0 },
    ],
  };
  const view = {
    pane: 'diff',
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
    layout: 'side',
    counts: { staged: 0, unstaged: 1, untracked: 0 },
    repoName: 'demo',
  };
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
  const view = {
    pane: 'diff',
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
    layout: 'side',
    counts: { staged: 0, unstaged: 1, untracked: 0 },
    repoName: 'demo',
  };
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
  const hunk = {
    oldStart: 1,
    oldCount: 1,
    newStart: 1,
    newCount: 1,
    header: '@@ -1,1 +1,1 @@',
    lines: [
      { type: 'del', text: 'hello world', noNl: false, blockId: 0 },
      { type: 'add', text: 'hello World', noNl: false, blockId: 0 },
    ],
  };
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
  assert.ok(!frame.text.includes(render.DEL_CHAR_BG));
  assert.ok(!frame.text.includes(render.ADD_CHAR_BG));
  const plain = render.renderFrame(view, {
    width: 80,
    height: 16,
    color: false,
  });
  assert.match(plain.text, /^-/m);
  assert.match(plain.text, /^\+/m);
});

test('footer keeps info status on the counts line', () => {
  const hunk = {
    oldStart: 1,
    oldCount: 1,
    newStart: 1,
    newCount: 1,
    header: '@@ -1,1 +1,1 @@',
    lines: [{ type: 'add', text: 'x', noNl: false, blockId: 0 }],
  };
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
  assert.match(statusRow, /unstaged 1/);
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

test('status line includes feedback todo and code counts', () => {
  const hunk = {
    oldStart: 1,
    oldCount: 1,
    newStart: 1,
    newCount: 1,
    header: '@@ -1,1 +1,1 @@',
    lines: [{ type: 'add', text: 'x', noNl: false, blockId: 0 }],
  };
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
      feedback: 3,
      todo: 2,
      code: 1,
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
  assert.match(statusRow, /\[main\] {2}staged 6 {2}unstaged 11 {2}untracked 0/);
  assert.match(statusRow, /feedback 3 {2}todo 2 {2}code 1/);
  const colored = render.renderFrame(view, {
    width: 80,
    height: 16,
    color: true,
  });
  const painted = colored.rows[colored.rows.length - 2];
  const chromeBg = bg(THEME.chromeBg);
  const white = `${fg(THEME.buttonHotFg)}${chromeBg}`;
  const muted = `${fg(THEME.mutedFg)}${chromeBg}`;
  const brackets = `${BOLD}${muted}`;
  assert.ok(painted.includes(`${white}main`));
  assert.ok(painted.includes(`${brackets}[`));
  assert.ok(painted.includes(`${brackets}]`));
  assert.ok(!painted.includes(`${white}[`));
  assert.ok(!painted.includes(`${white}]`));
  assert.equal(frame.statusHits.length, 1);
  assert.equal(frame.statusHits[0].id, 'branch');
  assert.equal(frame.statusHits[0].y, frame.rows.length - 1);
  assert.equal(frame.statusHits[0].x0, 1);
  assert.equal(frame.statusHits[0].x1, 7);
});

test('long operations paint an infinite progress bar', () => {
  assert.equal(render.formatBusyStatus('pulled', 0), 'pulled');
  const first = render.formatBusyStatus('pulling', 0);
  const next = render.formatBusyStatus('pulling', 1);
  assert.match(first, /^pulling {2}▰/);
  assert.notEqual(first, next);
  assert.match(render.formatBusyStatus('loading', 0), /^loading {2}▰/);
  assert.match(render.formatBusyStatus('checking npm', 2), /^checking npm {2}/);
  assert.match(
    render.formatBusyStatus('updating reslop', 0),
    /^updating reslop {2}▰/,
  );
  assert.match(render.formatBusyStatus('npm i', 0), /^npm i {2}▰/);
  assert.match(render.formatBusyStatus('npm uninstall', 1), /^npm uninstall /);
  assert.match(render.formatBusyStatus('npm audit fix', 2), /^npm audit fix /);
  assert.match(
    render.formatBusyStatus('checking out', 0),
    /^checking out {2}▰/,
  );
  assert.match(
    render.formatBusyStatus('creating branch', 1),
    /^creating branch {2}/,
  );
  assert.match(render.formatBusyStatus('rebasing', 0), /^rebasing {2}▰/);
  assert.match(render.formatBusyStatus('dropping', 1), /^dropping {2}/);
  assert.match(render.formatBusyStatus('committing', 2), /^committing {2}/);
  assert.match(
    render.formatBusyStatus('force pushing', 0),
    /^force pushing {2}▰/,
  );
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
  const row = frame.rows[frame.rows.length - 2];
  assert.match(row, /pulling {2}▰/);
});

test('quit prompt paints f and c yellow on grey copy', () => {
  const hunk = {
    oldStart: 1,
    oldCount: 1,
    newStart: 1,
    newCount: 1,
    header: '@@ -1,1 +1,1 @@',
    lines: [{ type: 'add', text: 'x', noNl: false, blockId: 0 }],
  };
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
    mode: 'confirmQuit',
    counts: { staged: 0, unstaged: 1, untracked: 0 },
    repoName: 'demo',
  };
  const colored = render.renderFrame(view, {
    width: 80,
    height: 16,
    color: true,
  });
  const statusRow = colored.rows[colored.rows.length - 2];
  const plain = stripAnsi(statusRow);
  assert.equal(plain.startsWith(render.QUIT_PROMPT), true);
  assert.ok(plain.includes('finish as ready'));
  assert.ok(plain.includes('continue next time'));
  assert.ok(!plain.includes('discard'));
  assert.ok(!plain.includes('Finish'));
  assert.ok(!plain.includes('Continue'));
  assert.ok(!plain.includes('pending'));
  assert.ok(statusRow.includes(fg(THEME.warnFg)));
  assert.ok(statusRow.includes(fg(THEME.mutedFg)));
  assert.ok(statusRow.includes(bg(THEME.chromeBg)));
  assert.ok(!statusRow.includes(bg(THEME.buttonBg)));
  assert.ok(statusRow.includes(BOLD));
  const warn = fg(THEME.warnFg);
  assert.equal(statusRow.split(warn).length - 1, 2);
});

test('commit prompt paints c a and f yellow on grey copy', () => {
  const hunk = {
    oldStart: 1,
    oldCount: 1,
    newStart: 1,
    newCount: 1,
    header: '@@ -1,1 +1,1 @@',
    lines: [{ type: 'add', text: 'x', noNl: false, blockId: 0 }],
  };
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
    mode: 'confirmCommit',
    counts: { staged: 0, unstaged: 1, untracked: 0 },
    repoName: 'demo',
  };
  const colored = render.renderFrame(view, {
    width: 80,
    height: 16,
    color: true,
  });
  const statusRow = colored.rows[colored.rows.length - 2];
  const plain = stripAnsi(statusRow);
  assert.equal(plain.startsWith(render.COMMIT_PROMPT), true);
  assert.ok(plain.includes('commit'));
  assert.ok(plain.includes('amend'));
  assert.ok(plain.includes('fixup'));
  assert.ok(statusRow.includes(fg(THEME.warnFg)));
  assert.ok(statusRow.includes(fg(THEME.mutedFg)));
  assert.ok(statusRow.includes(bg(THEME.chromeBg)));
  assert.ok(statusRow.includes(BOLD));
  const warn = fg(THEME.warnFg);
  assert.equal(statusRow.split(warn).length - 1, 3);
});

test('update prompt paints y and n on the status line', () => {
  const view = {
    pane: 'files',
    files: [{ path: 'a.js', status: 'unstaged', remaining: 1, firstIndex: 0 }],
    fileCursor: 0,
    repoName: 'demo',
    counts: { staged: 0, unstaged: 1, untracked: 0 },
    status: '',
    scroll: 0,
    mode: 'confirmUpdate',
    updateFrom: '0.1.5',
    updateTo: '1.0.0',
  };
  const colored = render.renderFrame(view, {
    width: 80,
    height: 8,
    color: true,
  });
  const statusRow = colored.rows[colored.rows.length - 2];
  const buttons = colored.rows[colored.rows.length - 1];
  const plain = stripAnsi(statusRow);
  assert.equal(plain.startsWith(render.updatePrompt('0.1.5', '1.0.0')), true);
  assert.match(plain, /update reslop 0\.1\.5 → 1\.0\.0\? y {2}n/);
  assert.match(stripAnsi(colored.rows[2]), /a\.js/);
  assert.match(stripAnsi(buttons), /add/i);
  assert.ok(statusRow.includes(fg(THEME.warnFg)));
  assert.ok(statusRow.includes(fg(THEME.mutedFg)));
  assert.ok(statusRow.includes(bg(THEME.chromeBg)));
  const warn = fg(THEME.warnFg);
  assert.equal(statusRow.split(warn).length - 1, 2);
});

test('drop branch prompt paints y and n on the status line', () => {
  const view = {
    pane: 'branches',
    branches: [
      { name: 'main', current: true, isDefault: true },
      { name: 'feat', current: false, isDefault: false },
    ],
    branchCursor: 1,
    repoName: 'demo',
    counts: { staged: 0, unstaged: 0, untracked: 0 },
    branch: 'main',
    status: '',
    scroll: 0,
    mode: 'confirmDrop',
    dropName: 'feat',
  };
  const colored = render.renderFrame(view, {
    width: 80,
    height: 8,
    color: true,
  });
  const statusRow = colored.rows[colored.rows.length - 2];
  const plain = stripAnsi(statusRow);
  assert.equal(plain.startsWith(render.dropPrompt('feat')), true);
  assert.match(plain, /drop feat\? y {2}n/);
  const warn = fg(THEME.warnFg);
  assert.equal(statusRow.split(warn).length - 1, 2);
});

test('rejected push prompt paints f for force push', () => {
  const view = {
    pane: 'files',
    files: [{ path: 'a.js', status: 'unstaged', remaining: 1, firstIndex: 0 }],
    fileCursor: 0,
    repoName: 'demo',
    counts: { staged: 0, unstaged: 1, untracked: 0 },
    status: '',
    scroll: 0,
    mode: 'confirmPush',
  };
  const colored = render.renderFrame(view, {
    width: 80,
    height: 8,
    color: true,
  });
  const statusRow = colored.rows[colored.rows.length - 2];
  const plain = stripAnsi(statusRow);
  assert.equal(plain.startsWith(render.PUSH_PROMPT), true);
  assert.ok(plain.includes('Need force-push?'));
  assert.ok(plain.includes('force push'));
  assert.ok(statusRow.includes(fg(THEME.warnFg)));
  assert.ok(statusRow.includes(fg(THEME.mutedFg)));
  assert.ok(statusRow.includes(bg(THEME.chromeBg)));
  const warn = fg(THEME.warnFg);
  assert.equal(statusRow.split(warn).length - 1, 1);
});

test('header and file list keep a right-side gap', () => {
  const view = {
    pane: 'files',
    files: [{ path: 'a.js', status: 'unstaged', remaining: 1, firstIndex: 0 }],
    fileCursor: 0,
    repoName: 'demo',
    counts: { staged: 0, unstaged: 1, untracked: 0 },
    status: '',
    scroll: 0,
  };
  const frame = render.renderFrame(view, {
    width: 40,
    height: 8,
    color: false,
  });
  const header = stripAnsi(frame.rows[0]);
  assert.equal(header.startsWith(' '), true);
  assert.equal(header.endsWith(' '), true);
  assert.match(header, /👁️ {2}reslop/);
  const row = stripAnsi(frame.rows[2]);
  assert.equal(row.endsWith(' '), true);
  assert.match(row, /▶ a\.js/);
});

test('file list keeps a blank line before and after', () => {
  const files = [
    { path: 'a.js', status: 'unstaged', remaining: 1, firstIndex: 0 },
    { path: 'b.js', status: 'staged', remaining: 1, firstIndex: 1 },
  ];
  const view = {
    pane: 'files',
    files,
    fileCursor: 0,
    repoName: 'demo',
    counts: { staged: 1, unstaged: 1, untracked: 0 },
    status: '',
    scroll: 0,
  };
  const frame = render.renderFrame(view, {
    width: 40,
    height: 8,
    color: true,
  });
  assert.equal(stripAnsi(frame.rows[1]).trim(), '');
  assert.ok(frame.rows[1].includes(bg(THEME.ctxBg)));
  assert.match(stripAnsi(frame.rows[2]), /a\.js/);
  assert.match(stripAnsi(frame.rows[3]), /b\.js/);
  assert.equal(stripAnsi(frame.rows[4]).trim(), '');
  assert.ok(frame.rows[4].includes(bg(THEME.ctxBg)));
  assert.equal(frame.fileHits[0].y, 3);
  assert.equal(frame.fileHits[1].y, 4);
});

test('header last column uses the light grey bar background', () => {
  const view = {
    pane: 'files',
    files: [{ path: 'a.js', status: 'unstaged', remaining: 1, firstIndex: 0 }],
    fileCursor: 0,
    repoName: 'demo',
    counts: { staged: 0, unstaged: 1, untracked: 0 },
    status: '',
    scroll: 0,
  };
  const width = 40;
  const frame = render.renderFrame(view, { width, height: 8, color: true });
  const row = frame.rows[0];
  const plain = stripAnsi(row);
  assert.equal(visibleWidth(plain), width);
  assert.equal(plain.endsWith(' '), true);
  assert.ok(row.includes(bg(THEME.headerBg)));
  assert.ok(row.includes(`${bg(THEME.headerBg)}${EL}`));
  const body = row.endsWith(RESET) ? row.slice(0, -RESET.length) : row;
  assert.ok(!body.includes(RESET));
  assert.ok(!body.includes(`${ESC}[2J`));
});

test('file list leads with repository TODOs and a count', () => {
  const files = [
    {
      path: 'Repository TODOs and Issues',
      kind: 'todos',
      status: 'todos',
      remaining: 3,
      staged: 1,
      firstIndex: 0,
    },
    { path: 'a.js', status: 'unstaged', remaining: 1, firstIndex: 0 },
  ];
  const frame = render.renderFrame(
    {
      pane: 'files',
      files,
      fileCursor: 0,
      repoName: 'demo',
      counts: { staged: 0, unstaged: 1, untracked: 0, todo: 3 },
      status: '',
      scroll: 0,
    },
    { width: 64, height: 8, color: false },
  );
  const lead = stripAnsi(frame.rows[2]);
  const file = stripAnsi(frame.rows[3]);
  assert.match(lead, /▶ Repository TODOs and Issues/);
  assert.match(lead, /1\/3\s*$/);
  assert.match(file, /a\.js/);
  assert.ok(!file.includes('Repository'));
  assert.ok(!lead.includes('demo'));
  assert.equal(frame.fileHits[0].y, 3);
  const header = render.headerText({
    pane: 'files',
    files,
    fileCursor: 0,
  });
  assert.match(header, /TODOs todo 1\/2/);
  const colored = render.renderFrame(
    {
      pane: 'files',
      files,
      fileCursor: 0,
      repoName: 'demo',
      counts: { staged: 0, unstaged: 1, untracked: 0, todo: 3 },
      status: '',
      scroll: 0,
    },
    { width: 64, height: 8, color: true },
  );
  const title = colored.rows[2];
  assert.ok(title.includes(BOLD));
  assert.ok(title.includes(fg(THEME.buttonHotFg)));
});

test('file list marks only the cursor row', () => {
  const files = [
    { path: 'a.js', status: 'unstaged', remaining: 1, firstIndex: 0 },
    { path: 'b.js', status: 'staged', remaining: 1, firstIndex: 1 },
  ];
  const frame = render.renderFrame(
    {
      pane: 'files',
      files,
      fileCursor: 0,
      reviewPath: 'b.js',
      repoName: 'demo',
      counts: { staged: 1, unstaged: 1, untracked: 0 },
      status: '',
      scroll: 0,
    },
    { width: 40, height: 8, color: false },
  );
  assert.match(stripAnsi(frame.rows[2]), /▶ a\.js/);
  assert.match(stripAnsi(frame.rows[3]), / {2}b\.js/);
  assert.ok(!stripAnsi(frame.rows[3]).includes('▶'));
});

test('AC10 footer words highlight the bound letter', () => {
  const view = {
    pane: 'files',
    files: [{ path: 'a.js', status: 'unstaged', remaining: 1, firstIndex: 0 }],
    fileCursor: 0,
    repoName: 'demo',
    counts: { staged: 0, unstaged: 1, untracked: 0 },
    status: '',
    scroll: 0,
  };
  const frame = render.renderFrame(view, {
    width: 80,
    height: 8,
    color: true,
  });
  const row = frame.rows[frame.rows.length - 1];
  const plain = stripAnsi(row);
  assert.match(plain, /add {2}unstage {2}drop {2}commit {2}←/);
  assert.match(plain, /todo {2}reload {2}branch {2}pull {2}push {2}q/);
  assert.ok(!plain.includes('prev'));
  assert.ok(!plain.includes('next'));
  assert.ok(!plain.includes('quit'));
  assert.ok(!plain.includes('files'));
  assert.ok(!plain.includes('mode'));
  assert.ok(!plain.includes('feedback'));
  assert.ok(!plain.includes('code'));
  assert.ok(!plain.includes('['));
  assert.ok(row.includes(fg(THEME.buttonHotFg)));
  assert.ok(row.includes(fg(THEME.buttonFg)));
  assert.ok(row.includes(BOLD));
  const dim = render.renderFrame(view, {
    width: 80,
    height: 8,
    color: false,
  });
  const dimRow = dim.rows[dim.rows.length - 1];
  assert.match(dimRow, /add {2}unstage {2}drop {2}commit {2}←/);
  assert.ok(!dimRow.includes('['));
  const mode = frame.buttons.find((hit) => hit.id === 'layout');
  const feedback = frame.buttons.find((hit) => hit.id === 'feedback');
  const code = frame.buttons.find((hit) => hit.id === 'code');
  assert.equal(mode, undefined);
  assert.equal(feedback, undefined);
  assert.equal(code, undefined);
  assert.ok(frame.buttons.find((hit) => hit.id === 'add'));
  assert.ok(frame.buttons.find((hit) => hit.id === 'reload'));
  assert.equal(
    frame.buttons.find((hit) => hit.id === 'files'),
    undefined,
  );
});

test('files pane todos row dims add unstage drop', () => {
  const view = {
    pane: 'files',
    files: [
      {
        path: 'Repository TODOs and Issues',
        kind: 'todos',
        status: 'todos',
        remaining: 1,
        staged: 0,
        firstIndex: 0,
      },
      { path: 'a.js', status: 'unstaged', remaining: 1, firstIndex: 0 },
    ],
    fileCursor: 0,
    repoName: 'demo',
    counts: { staged: 0, unstaged: 1, untracked: 0, todo: 1 },
    status: '',
    scroll: 0,
  };
  const frame = render.renderFrame(view, {
    width: 80,
    height: 8,
    color: false,
  });
  const footer = frame.rows[frame.rows.length - 1];
  assert.match(footer, /add {2}unstage {2}drop {2}commit {2}←/);
  assert.equal(
    frame.buttons.find((hit) => hit.id === 'add'),
    undefined,
  );
  assert.equal(
    frame.buttons.find((hit) => hit.id === 'unstage'),
    undefined,
  );
  assert.equal(
    frame.buttons.find((hit) => hit.id === 'revert'),
    undefined,
  );
  assert.ok(frame.buttons.find((hit) => hit.id === 'commit'));
  const colored = render.renderFrame(view, {
    width: 80,
    height: 8,
    color: true,
  });
  const row = colored.rows[colored.rows.length - 1];
  const rest = seq(THEME.buttonFg, THEME.buttonBg);
  const hot = seq(THEME.buttonHotFg, THEME.buttonBg);
  assert.ok(row.includes(`${rest}add`));
  assert.ok(!row.includes(`${BOLD}${hot}a`));
  assert.ok(row.includes(`${BOLD}${hot}c`));
  view.fileCursor = 1;
  const file = render.renderFrame(view, {
    width: 80,
    height: 8,
    color: false,
  });
  const fileFooter = file.rows[file.rows.length - 1];
  assert.match(fileFooter, /add {2}unstage {2}drop/);
  assert.ok(file.buttons.find((hit) => hit.id === 'add'));
});

test('diff pane dims add on staged and unstage on unstaged', () => {
  const hunk = {
    oldStart: 1,
    oldCount: 1,
    newStart: 1,
    newCount: 1,
    header: '@@ -1,1 +1,1 @@',
    lines: [{ type: 'add', text: 'x', noNl: false, blockId: 0 }],
  };
  const item = {
    origin: 'staged',
    file: { newPath: 'f.js', oldPath: 'f.js', isBinary: false },
    hunk,
    blockId: 0,
  };
  const view = {
    pane: 'diff',
    item,
    index: 0,
    total: 1,
    scroll: 0,
    status: '',
    counts: { staged: 1, unstaged: 0, untracked: 0 },
    repoName: 'demo',
  };
  const staged = render.renderFrame(view, {
    width: 80,
    height: 8,
    color: true,
  });
  const stagedRow = staged.rows[staged.rows.length - 1];
  const rest = seq(THEME.buttonFg, THEME.buttonBg);
  const hot = seq(THEME.buttonHotFg, THEME.buttonBg);
  assert.match(stripAnsi(stagedRow), /add {2}unstage {2}drop/);
  assert.equal(
    staged.buttons.find((hit) => hit.id === 'add'),
    undefined,
  );
  assert.ok(staged.buttons.find((hit) => hit.id === 'unstage'));
  assert.ok(stagedRow.includes(`${rest}add`));
  assert.ok(!stagedRow.includes(`${BOLD}${hot}a`));
  assert.ok(stagedRow.includes(`${BOLD}${hot}u`));
  view.item = { ...item, origin: 'unstaged' };
  view.counts = { staged: 0, unstaged: 1, untracked: 0 };
  const unstaged = render.renderFrame(view, {
    width: 80,
    height: 8,
    color: true,
  });
  const unstagedRow = unstaged.rows[unstaged.rows.length - 1];
  assert.ok(unstaged.buttons.find((hit) => hit.id === 'add'));
  assert.equal(
    unstaged.buttons.find((hit) => hit.id === 'unstage'),
    undefined,
  );
  assert.ok(unstagedRow.includes(`${BOLD}${hot}a`));
  assert.ok(unstagedRow.includes(`${rest}unstage`));
  assert.ok(!stripAnsi(unstagedRow).includes('commit'));
  assert.equal(
    unstaged.buttons.find((hit) => hit.id === 'commit'),
    undefined,
  );
});

test('branch pane lists names and marks the default branch', () => {
  const view = {
    pane: 'branches',
    branches: [
      {
        name: 'main',
        current: false,
        isDefault: true,
        sha: 'aaa1111',
        date: '2 days ago',
        subject: 'init',
        ahead: 1,
        behind: 0,
        gone: false,
      },
      {
        name: 'feat',
        current: true,
        isDefault: false,
        sha: 'bbb2222',
        date: '3 weeks ago',
        subject: 'wip',
        ahead: 0,
        behind: 2,
        gone: false,
      },
    ],
    branchCursor: 1,
    repoName: 'demo',
    counts: { staged: 0, unstaged: 0, untracked: 0 },
    branch: 'main',
    status: '',
    scroll: 0,
  };
  const frame = render.renderFrame(view, {
    width: 80,
    height: 12,
    color: false,
  });
  const text = frame.rows.join('\n');
  const rows = frame.rows.map((row) => stripAnsi(row));
  const mainRow = rows.find((row) => row.includes('aaa1111'));
  const featRow = rows.find((row) => row.includes('bbb2222'));
  assert.ok(mainRow);
  assert.ok(featRow);
  assert.ok(mainRow.includes('[main]'));
  assert.match(featRow, /\[feat\]/);
  assert.ok(!text.includes('* main'));
  assert.match(text, /aaa1111/);
  assert.match(text, /bbb2222/);
  assert.match(text, /⇡1/);
  assert.match(text, /⇣2/);
  assert.match(text, /2 days ago/);
  assert.match(text, /3 weeks ago/);
  assert.match(text, /init/);
  assert.match(text, /wip/);
  assert.match(render.headerText(view), /feat current 2\/2/);
  const footer = frame.rows[frame.rows.length - 1];
  assert.match(footer, /new/);
  assert.match(footer, /rebase/);
  assert.match(footer, /drop/);
  assert.ok(!footer.includes('add'));
  assert.ok(frame.buttons.find((hit) => hit.id === 'newBranch'));
  assert.equal(
    frame.buttons.find((hit) => hit.id === 'rebase'),
    undefined,
  );
  assert.equal(
    frame.buttons.find((hit) => hit.id === 'drop'),
    undefined,
  );
  assert.equal(mainRow.indexOf('aaa1111'), featRow.indexOf('bbb2222'));
  assert.equal(mainRow.indexOf('2 days ago'), featRow.indexOf('3 weeks ago'));
  const colored = render.renderFrame(view, {
    width: 80,
    height: 12,
    color: true,
  });
  const mainPainted = colored.rows.find((row) => row.includes('aaa1111'));
  const featPainted = colored.rows.find((row) => row.includes('bbb2222'));
  const whiteBg = bg(THEME.buttonHotFg);
  const greenBg = bg(THEME.checkDoneBg);
  const mainWrap = `${BOLD}${fg(THEME.mutedFg)}${greenBg}`;
  const mainName = `${fg(THEME.checkDoneFg)}${greenBg}`;
  const currentName = `${fg(THEME.headerFg)}${whiteBg}`;
  const currentWrap = `${BOLD}${fg(THEME.mutedFg)}${whiteBg}`;
  assert.ok(mainPainted.includes(`${mainWrap}[`));
  assert.ok(mainPainted.includes(`${mainName}main`));
  assert.ok(mainPainted.includes(`${mainWrap}]`));
  assert.ok(featPainted.includes(`${currentWrap}[`));
  assert.ok(featPainted.includes(`${currentName}feat`));
  assert.ok(featPainted.includes(`${currentWrap}]`));
  const rest = seq(THEME.buttonFg, THEME.buttonBg);
  const hot = seq(THEME.buttonHotFg, THEME.buttonBg);
  const currentFooter = colored.rows[colored.rows.length - 1];
  assert.ok(currentFooter.includes(`${rest}rebase`));
  assert.ok(currentFooter.includes(`${rest}drop`));
  assert.ok(!currentFooter.includes(`${BOLD}${hot}r`));
  assert.ok(!currentFooter.includes(`${BOLD}${hot}d`));
  view.branchCursor = 0;
  const onto = render.renderFrame(view, {
    width: 80,
    height: 12,
    color: true,
  });
  const ontoFooter = onto.rows[onto.rows.length - 1];
  assert.ok(onto.buttons.find((hit) => hit.id === 'rebase'));
  assert.ok(onto.buttons.find((hit) => hit.id === 'drop'));
  assert.ok(ontoFooter.includes(`${BOLD}${hot}r`));
  assert.ok(ontoFooter.includes(`${BOLD}${hot}d`));
});

test('branch pane types a new name on a row under the list', () => {
  const view = {
    pane: 'branches',
    branches: [
      {
        name: 'main',
        current: true,
        isDefault: true,
        sha: 'aaa1111',
        date: '2 days ago',
        subject: 'init',
        ahead: 0,
        behind: 0,
        gone: false,
      },
      {
        name: 'feat',
        current: false,
        isDefault: false,
        sha: 'bbb2222',
        date: '3 weeks ago',
        subject: 'wip',
        ahead: 0,
        behind: 0,
        gone: false,
      },
    ],
    branchCursor: 0,
    compose: { kind: 'branch', text: 'topic', cursor: 5 },
    repoName: 'demo',
    counts: { staged: 0, unstaged: 0, untracked: 0 },
    branch: 'main',
    status: '',
    scroll: 0,
  };
  const frame = render.renderFrame(view, {
    width: 80,
    height: 12,
    color: false,
  });
  const rows = frame.rows.map((row) => stripAnsi(row));
  const featAt = rows.findIndex((row) => row.includes('bbb2222'));
  const topicAt = rows.findIndex(
    (row, i) => i > featAt && row.includes('topic'),
  );
  assert.ok(featAt >= 0);
  assert.ok(topicAt > featAt);
  assert.ok(topicAt < rows.length - 2);
  const mainRow = rows.find((row) => row.includes('aaa1111'));
  assert.match(mainRow, /\[main\]/);
  assert.equal(frame.cursor.y, topicAt + 1);
  assert.match(render.headerText(view), /topic new 3\/3/);
});

test('AC26 file list status and counts are column-aligned', () => {
  const files = [
    {
      path: 'a.js',
      status: 'unstaged',
      remaining: 4,
      staged: 0,
      added: 12,
      removed: 5,
      firstIndex: 0,
    },
    {
      path: 'b.js',
      status: 'staged',
      remaining: 1,
      staged: 1,
      added: 3,
      removed: 1,
      firstIndex: 1,
    },
    {
      path: 'README.md',
      status: 'untracked',
      remaining: 12,
      staged: 0,
      added: 20,
      removed: 0,
      firstIndex: 2,
    },
  ];
  const base = {
    pane: 'files',
    files,
    repoName: 'demo',
    counts: { staged: 1, unstaged: 1, untracked: 1 },
    status: '',
    scroll: 0,
    fileCursor: 0,
  };
  const frame = render.renderFrame(base, {
    width: 48,
    height: 10,
    color: false,
  });
  const rows = [2, 3, 4].map((i) => stripAnsi(frame.rows[i]));
  const columnMarks = (row) => {
    const t = row.trimEnd();
    const add = /\+[0-9]+/.exec(t);
    const del = /-[0-9]+/.exec(t);
    const status = /(unstaged|staged|untracked)/.exec(t);
    const ratio = /(\d+)\/(\d+)$/.exec(t);
    const addEnd = add.index + add[0].length;
    const delEnd = del.index + del[0].length;
    const statusEnd = status.index + status[0].length;
    const slashAt = ratio.index + ratio[1].length;
    return { addEnd, delEnd, statusEnd, slashAt };
  };
  const marks = rows.map(columnMarks);
  assert.equal(new Set(marks.map((m) => m.addEnd)).size, 1);
  assert.equal(new Set(marks.map((m) => m.delEnd)).size, 1);
  assert.equal(new Set(marks.map((m) => m.statusEnd)).size, 1);
  assert.equal(new Set(marks.map((m) => m.slashAt)).size, 1);
  assert.ok(marks[0].addEnd < marks[0].delEnd);
  assert.ok(marks[0].delEnd < marks[0].statusEnd);
  assert.ok(marks[0].statusEnd < marks[0].slashAt);
  assert.match(rows[0], /unstaged/);
  assert.match(rows[1], /staged/);
  assert.match(rows[2], /untracked/);
  assert.match(rows[0], /\+12 {2}-5/);
  assert.match(rows[1], /\+3 {2}-1/);
  assert.match(rows[2], /\+20 {2}-0/);
  assert.match(rows[0], /0\/4/);
  assert.match(rows[1], /1\/1/);
  assert.match(rows[2], /0\/12/);
  const slim = render.renderFrame(base, {
    width: 48,
    height: 4,
    color: false,
  });
  const first = stripAnsi(slim.rows[2]);
  assert.match(first, /unstaged {2}0\/4 {2}$/);
});

test('file list TODOs n/m aligns with file staged/remaining', () => {
  const files = [
    {
      path: 'Repository TODOs and Issues',
      kind: 'todos',
      status: 'todos',
      remaining: 5,
      staged: 2,
      firstIndex: 0,
    },
    {
      path: 'a.js',
      status: 'unstaged',
      remaining: 4,
      staged: 0,
      added: 12,
      removed: 5,
      firstIndex: 0,
    },
  ];
  const frame = render.renderFrame(
    {
      pane: 'files',
      files,
      fileCursor: 0,
      repoName: 'demo',
      counts: { staged: 0, unstaged: 1, untracked: 0, todo: 5 },
      status: '',
      scroll: 0,
    },
    { width: 48, height: 8, color: false },
  );
  const todoRow = stripAnsi(frame.rows[2]);
  const fileRow = stripAnsi(frame.rows[3]);
  assert.match(todoRow, /2\/5\s*$/);
  assert.match(fileRow, /0\/4\s*$/);
  assert.equal(todoRow.lastIndexOf('/'), fileRow.lastIndexOf('/'));
});

test('file list paints git status colors', () => {
  const files = [
    {
      path: 'a.js',
      status: 'unstaged',
      remaining: 1,
      staged: 0,
      firstIndex: 0,
    },
    { path: 'b.js', status: 'staged', remaining: 1, staged: 1, firstIndex: 1 },
    {
      path: 'c.js',
      status: 'untracked',
      remaining: 1,
      staged: 0,
      firstIndex: 2,
    },
    {
      path: 'd.js',
      status: 'partial',
      remaining: 3,
      staged: 2,
      unstaged: 1,
      firstIndex: 3,
    },
  ];
  const view = {
    pane: 'files',
    files,
    fileCursor: 0,
    repoName: 'demo',
    counts: { staged: 1, unstaged: 1, untracked: 1 },
    status: '',
    scroll: 0,
  };
  const frame = render.renderFrame(view, {
    width: 48,
    height: 10,
    color: true,
  });
  assert.ok(frame.rows[2].includes(fg(THEME.delLineFg)));
  assert.ok(frame.rows[3].includes(fg(THEME.addLineFg)));
  assert.ok(frame.rows[3].includes(fg(THEME.delLineFg)));
  assert.ok(frame.rows[4].includes(fg(THEME.mutedFg)));
  assert.ok(frame.rows[5].includes(fg(THEME.warnFg)));
  assert.ok(!frame.rows[3].includes(fg(THEME.warnFg)));
  const mixed = stripAnsi(frame.rows[5]);
  assert.match(mixed, /partial/);
  assert.match(mixed, /2\/3/);
});

test('AC25 header path roles use distinct greys', () => {
  assert.notDeepEqual(THEME.headerRepoFg, THEME.headerDirFg);
  assert.notDeepEqual(THEME.headerDirFg, THEME.headerFileFg);
  assert.notDeepEqual(THEME.headerSlashFg, THEME.headerDirFg);
  assert.notDeepEqual(THEME.headerSlashFg, THEME.headerFileFg);
  const view = {
    pane: 'diff',
    item: {
      origin: 'unstaged',
      file: {
        newPath: 'lib/database.js',
        oldPath: 'lib/database.js',
        isBinary: false,
      },
      hunk: {
        oldStart: 1,
        oldCount: 1,
        newStart: 1,
        newCount: 1,
        header: '@@ -1,1 +1,1 @@',
        lines: [{ type: 'add', text: 'x', noNl: false, blockId: 0 }],
      },
      blockId: 0,
    },
    index: 0,
    total: 1,
    repoName: 'metasql',
    counts: { staged: 0, unstaged: 1, untracked: 0 },
    status: '',
    scroll: 0,
  };
  assert.match(render.headerText(view), /metasql\/lib\/database\.js/);
  const frame = render.renderFrame(view, {
    width: 80,
    height: 12,
    color: true,
  });
  const row = frame.rows[0];
  assert.ok(row.includes(fg(THEME.headerRepoFg)));
  assert.ok(row.includes(fg(THEME.headerDirFg)));
  assert.ok(row.includes(fg(THEME.headerSlashFg)));
  assert.ok(row.includes(fg(THEME.headerFileFg)));
  const plain = stripAnsi(row);
  assert.match(plain, /metasql\/lib\/database\.js/);
});

test('presentRows overwrites in place without a leading wipe', () => {
  const out = render.presentRows(['aa', 'bb'], { clear: false });
  assert.ok(out.startsWith(`${ESC}[?25l`));
  assert.ok(out.includes(`${ESC}[?2026h`));
  assert.ok(!out.includes(`${ESC}[2J`));
  assert.ok(out.includes(`${ESC}[1;1H`));
  assert.ok(out.includes(`${ESC}[2;1H`));
  const hide = out.indexOf(`${ESC}[?25l`);
  const firstRow = out.indexOf(`${ESC}[1;1H`);
  const syncEnd = out.indexOf(`${ESC}[?2026l`);
  assert.ok(syncEnd >= 0);
  assert.ok(hide < firstRow);
});

test('presentRows clear stays inside the synchronized region', () => {
  const out = render.presentRows(['aa'], { clear: true });
  const sync = out.indexOf(`${ESC}[?2026h`);
  const wipe = out.indexOf(`${ESC}[2J`);
  const end = out.indexOf(`${ESC}[?2026l`);
  assert.ok(sync >= 0);
  assert.ok(wipe > sync);
  assert.ok(wipe < end);
});

test('presentRows hides the cursor before painting rows', () => {
  const out = render.presentRows(['aa'], { cursor: { x: 3, y: 2 } });
  const hide = out.indexOf(`${ESC}[?25l`);
  const sync = out.indexOf(`${ESC}[?2026h`);
  const firstRow = out.indexOf(`${ESC}[1;1H`);
  assert.ok(hide >= 0);
  assert.ok(hide < sync);
  assert.ok(sync < firstRow);
});

test('presentRows shows a blinking cursor after the sync region', () => {
  const out = render.presentRows(['aa'], { cursor: { x: 3, y: 2 } });
  const syncEnd = out.indexOf(`${ESC}[?2026l`);
  const pos = out.indexOf(`${ESC}[2;3H`);
  const style = out.indexOf(`${ESC}[1 q`);
  const blink = out.indexOf(`${ESC}[?12h`);
  const show = out.indexOf(`${ESC}[?25h`);
  assert.ok(syncEnd >= 0);
  assert.ok(pos > syncEnd);
  assert.ok(style > pos);
  assert.ok(blink > style);
  assert.ok(show > blink);
});

test('presentCursor hides or shows at the edit cell', () => {
  assert.equal(render.presentCursor(null), `${ESC}[?25l`);
  const shown = render.presentCursor({ x: 4, y: 7 });
  assert.ok(shown.startsWith(`${ESC}[7;4H`));
  assert.ok(shown.includes(`${ESC}[?25h`));
  assert.ok(!shown.includes(`${ESC}[?2026h`));
});

test('commit review header and counts use short sha', () => {
  const hunk = {
    oldStart: 1,
    oldCount: 1,
    newStart: 1,
    newCount: 1,
    header: '@@ -1,1 +1,1 @@',
    lines: [{ type: 'add', text: 'x', noNl: false, blockId: 0 }],
  };
  const view = {
    item: {
      origin: 'commit',
      file: { newPath: 'f.js', oldPath: 'f.js', isBinary: false },
      hunk,
      blockId: 0,
    },
    index: 0,
    total: 1,
    scroll: 0,
    status: '',
    revShort: '7ac260c',
    counts: { staged: 0, unstaged: 0, untracked: 0, commit: 1 },
    repoName: 'demo',
  };
  assert.match(render.headerText(view), /reslop: demo\/f\.js 7ac260c 1\/1/);
  const frame = render.renderFrame(view, {
    width: 80,
    height: 16,
    color: false,
  });
  assert.match(
    frame.text,
    /commit 7ac260c {2}1 {2}feedback 0 {2}todo 0 {2}code 0/,
  );
});

test('PR review header and counts use pull request label', () => {
  const hunk = {
    oldStart: 1,
    oldCount: 1,
    newStart: 1,
    newCount: 1,
    header: '@@ -1,1 +1,1 @@',
    lines: [{ type: 'add', text: 'x', noNl: false, blockId: 0 }],
  };
  const view = {
    item: {
      origin: 'pr',
      file: { newPath: 'f.js', oldPath: 'f.js', isBinary: false },
      hunk,
      blockId: 0,
    },
    index: 0,
    total: 1,
    scroll: 0,
    status: '',
    sourceKind: 'pr',
    sourceLabel: '#123',
    counts: { staged: 0, unstaged: 0, untracked: 0, commit: 0, pr: 1 },
    repoName: 'acme/app',
  };
  assert.match(render.headerText(view), /reslop: acme\/app\/f\.js #123 1\/1/);
  const frame = render.renderFrame(view, {
    width: 80,
    height: 16,
    color: false,
  });
  assert.match(frame.text, /pr #123 {2}1 {2}feedback 0 {2}todo 0 {2}code 0/);
});

test('MR review header and counts use merge request label', () => {
  const hunk = {
    oldStart: 1,
    oldCount: 1,
    newStart: 1,
    newCount: 1,
    header: '@@ -1,1 +1,1 @@',
    lines: [{ type: 'add', text: 'x', noNl: false, blockId: 0 }],
  };
  const view = {
    item: {
      origin: 'pr',
      file: { newPath: 'f.js', oldPath: 'f.js', isBinary: false },
      hunk,
      blockId: 0,
    },
    index: 0,
    total: 1,
    scroll: 0,
    status: '',
    sourceKind: 'mr',
    sourceLabel: '!123',
    counts: { staged: 0, unstaged: 0, untracked: 0, commit: 0, pr: 1 },
    repoName: 'acme/app',
  };
  assert.match(render.headerText(view), /reslop: acme\/app\/f\.js !123 1\/1/);
  const frame = render.renderFrame(view, {
    width: 80,
    height: 16,
    color: false,
  });
  assert.match(frame.text, /mr !123 {2}1 {2}feedback 0 {2}todo 0 {2}code 0/);
});

test('compose panel sits above status and buttons', () => {
  const hunk = {
    oldStart: 1,
    oldCount: 1,
    newStart: 1,
    newCount: 1,
    header: '@@ -1,1 +1,1 @@',
    lines: [{ type: 'add', text: 'x', noNl: false, blockId: 0 }],
  };
  const view = {
    pane: 'diff',
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
    counts: { staged: 0, unstaged: 1, untracked: 0 },
    repoName: 'demo',
    compose: { kind: 'feedback', text: 'extract helper', cursor: 14 },
  };
  const frame = render.renderFrame(view, {
    width: 80,
    height: 16,
    color: false,
  });
  assert.equal(frame.rows.length, 16);
  const statusRow = frame.rows[frame.rows.length - 2];
  const buttonRow = frame.rows[frame.rows.length - 1];
  assert.match(statusRow, /unstaged 1/);
  assert.match(buttonRow, /feedback/);
  assert.match(buttonRow, /edit/);
  assert.ok(!buttonRow.includes('code'));
  assert.ok(!buttonRow.includes('reload'));
  assert.ok(!buttonRow.includes('files'));
  const joined = frame.rows.join('\n');
  const noteAt = joined.indexOf('extract helper');
  const statusAt = joined.indexOf(statusRow);
  assert.ok(noteAt >= 0 && noteAt < statusAt);
  assert.ok(!joined.includes('1 add tests'));
  assert.ok(frame.cursor);
});

test('feedback compose paints templates above the input', () => {
  const hunk = {
    oldStart: 1,
    oldCount: 1,
    newStart: 1,
    newCount: 1,
    header: '@@ -1,1 +1,1 @@',
    lines: [{ type: 'add', text: 'x', noNl: false, blockId: 0 }],
  };
  const view = {
    pane: 'diff',
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
    counts: { staged: 0, unstaged: 1, untracked: 0 },
    repoName: 'demo',
    compose: { kind: 'feedback', text: 'new note', cursor: 0 },
    templates: [
      { text: 'extract helper', count: 2 },
      { text: 'add tests', count: 1 },
    ],
    templateIndex: 0,
  };
  const frame = render.renderFrame(view, {
    width: 80,
    height: 16,
    color: true,
  });
  const joined = stripAnsi(frame.rows.join('\n'));
  const pickAt = joined.indexOf('extract helper');
  const otherAt = joined.indexOf('add tests');
  const inputAt = joined.indexOf('new note');
  assert.ok(pickAt >= 0 && pickAt < inputAt);
  assert.ok(otherAt >= 0 && otherAt < inputAt);
  const picked = frame.rows.find((row) => row.includes('extract helper'));
  const idle = frame.rows.find((row) => row.includes('add tests'));
  assert.ok(picked.includes(bg(THEME.buttonBg)));
  assert.ok(idle.includes(bg(THEME.noteBg)));
  assert.equal(frame.templateHits.length, 2);
  assert.equal(frame.templateHits[0].cursor, 0);
  assert.equal(frame.templateHits[1].cursor, 1);
  assert.equal(frame.templateHits[1].y, frame.templateHits[0].y + 1);
  assert.ok(frame.cursor.y > frame.templateHits[1].y);
});

test('todo compose does not paint feedback templates', () => {
  const view = {
    pane: 'diff',
    item: {
      origin: 'todo',
      todoId: 1,
      file: { newPath: 'f.js', oldPath: 'f.js', isBinary: false },
      hunk: null,
      blockId: 'todo-1',
    },
    index: 0,
    total: 1,
    scroll: 0,
    status: '',
    counts: { staged: 0, unstaged: 0, untracked: 0, todo: 1 },
    repoName: 'demo',
    todos: ['[ ] rewrite this'],
    todoFocus: 0,
    todoEdit: { cursor: 0 },
    templates: [{ text: 'extract helper', count: 1 }],
    templateIndex: 0,
  };
  const frame = render.renderFrame(view, {
    width: 80,
    height: 16,
    color: false,
  });
  const body = stripAnsi(frame.rows.join('\n'));
  assert.match(body, /rewrite this/);
  assert.ok(!body.includes('extract helper'));
  assert.equal(frame.templateHits.length, 0);
});

test('compose and idle notes keep one-char side margins', () => {
  const hunk = {
    oldStart: 1,
    oldCount: 1,
    newStart: 1,
    newCount: 1,
    header: '@@ -1,1 +1,1 @@',
    lines: [{ type: 'add', text: 'x', noNl: false, blockId: 0 }],
  };
  const base = {
    pane: 'diff',
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
    counts: { staged: 0, unstaged: 1, untracked: 0 },
    repoName: 'demo',
  };
  const opt = { width: 80, height: 16, color: false };
  const compose = render.renderFrame(
    { ...base, compose: { kind: 'feedback', text: 'hi', cursor: 0 } },
    opt,
  );
  const composeRow = compose.rows.find((row) => row.includes('hi'));
  assert.match(stripAnsi(composeRow), /^ hi /);
  assert.equal(compose.cursor.x, 2);
  const idle = render.renderFrame({ ...base, noteText: 'hi' }, opt);
  const idleRow = idle.rows.find((row) => row.includes('feedback: hi'));
  assert.match(stripAnsi(idleRow), /^ feedback: hi /);
});

test('idle feedback note sits above the footer', () => {
  const hunk = {
    oldStart: 1,
    oldCount: 1,
    newStart: 1,
    newCount: 1,
    header: '@@ -1,1 +1,1 @@',
    lines: [{ type: 'add', text: 'x', noNl: false, blockId: 0 }],
  };
  const view = {
    pane: 'diff',
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
    noteText: '[ ] extract helper',
  };
  const frame = render.renderFrame(view, {
    width: 80,
    height: 16,
    color: false,
  });
  const statusRow = frame.rows[frame.rows.length - 2];
  assert.match(statusRow, /copied /);
  const joined = frame.rows.join('\n');
  assert.match(joined, /feedback: \[ \] extract helper/);
  const noteAt = joined.indexOf('feedback: [ ] extract helper');
  assert.ok(noteAt >= 0 && noteAt < joined.indexOf(statusRow));
});

test('note panel is lighter than the status line', () => {
  const hunk = {
    oldStart: 1,
    oldCount: 1,
    newStart: 1,
    newCount: 1,
    header: '@@ -1,1 +1,1 @@',
    lines: [{ type: 'add', text: 'x', noNl: false, blockId: 0 }],
  };
  const base = {
    pane: 'diff',
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
    counts: { staged: 0, unstaged: 1, untracked: 0 },
    repoName: 'demo',
  };
  const opt = { width: 80, height: 16, color: true };
  const idle = render.renderFrame({ ...base, noteText: 'extract helper' }, opt);
  const compose = render.renderFrame(
    {
      ...base,
      compose: { kind: 'feedback', text: 'rewrite loop', cursor: 0 },
    },
    opt,
  );
  const idleNote = idle.rows.find((row) => row.includes('extract helper'));
  const composeNote = compose.rows.find((row) => row.includes('rewrite loop'));
  const statusRow = idle.rows[idle.rows.length - 2];
  const noteBg = bg(THEME.noteBg);
  const chromeBg = bg(THEME.chromeBg);
  assert.notDeepEqual(THEME.noteBg, THEME.chromeBg);
  assert.ok(idleNote.includes(noteBg));
  assert.ok(composeNote.includes(noteBg));
  assert.ok(!idleNote.includes(chromeBg));
  assert.ok(statusRow.includes(chromeBg));
  assert.ok(!statusRow.includes(noteBg));
});

test('todo view paints file todo text not a diff hunk', () => {
  const view = {
    pane: 'diff',
    item: {
      origin: 'todo',
      todoId: 1,
      file: { newPath: 'f.js', oldPath: 'f.js', isBinary: false },
      hunk: null,
      blockId: 'todo-1',
    },
    index: 0,
    total: 1,
    scroll: 0,
    status: '',
    counts: { staged: 0, unstaged: 0, untracked: 0, todo: 1 },
    repoName: 'demo',
    todos: ['[ ] rewrite this', '[x] already done'],
    todoFocus: 0,
  };
  const frame = render.renderFrame(view, {
    width: 80,
    height: 16,
    color: false,
  });
  const body = stripAnsi(frame.rows.join('\n'));
  const captionAt = body.indexOf('Repository TODOs and Issues');
  const firstAt = body.indexOf('[ ] rewrite this');
  assert.ok(captionAt >= 0 && captionAt < firstAt);
  assert.match(body, /\[ \] rewrite this/);
  assert.match(body, /\[x\] already done/);
  assert.ok(!stripAnsi(frame.rows[2]).startsWith('+'));
  assert.ok(!stripAnsi(frame.rows[2]).startsWith('-'));
  assert.match(body, /TODOs\s+todo 1\/1/);
  const footer = frame.rows[frame.rows.length - 1];
  assert.match(footer, /← {2}→ {2}q/);
  assert.ok(!footer.includes('prev'));
  assert.ok(!footer.includes('next'));
  assert.ok(!footer.includes('quit'));
  assert.ok(!footer.includes('files'));
  assert.ok(!footer.includes('reload'));
  assert.ok(!footer.includes('add'));
  assert.ok(!footer.includes('drop'));
  assert.ok(!footer.includes('mode'));
  assert.ok(!footer.includes('feedback'));
  assert.ok(!footer.includes('code'));
  assert.ok(!footer.includes('todo'));
  assert.ok(!footer.includes('commit'));
  assert.ok(!footer.includes('del'));
  assert.ok(!footer.includes('edit'));
  assert.ok(!footer.includes('⏎'));
  const colored = render.renderFrame(view, {
    width: 80,
    height: 16,
    color: true,
  });
  const caption = colored.rows[2];
  assert.match(stripAnsi(caption), /Repository TODOs and Issues/);
  assert.ok(!stripAnsi(caption).includes('demo'));
  assert.ok(caption.includes(BOLD));
  assert.ok(caption.includes(fg(THEME.buttonHotFg)));
});

test('todo list stays visible while composing', () => {
  const view = {
    pane: 'diff',
    item: {
      origin: 'todo',
      todoId: 1,
      file: { newPath: 'f.js', oldPath: 'f.js', isBinary: false },
      hunk: null,
      blockId: 'todo-1',
    },
    index: 0,
    total: 1,
    scroll: 0,
    status: '',
    counts: { staged: 0, unstaged: 0, untracked: 0, todo: 2 },
    repoName: 'demo',
    todos: ['[ ] rewrite this', '[x] already done'],
    todoFocus: 0,
    todoEdit: { cursor: 12 },
  };
  const frame = render.renderFrame(view, {
    width: 80,
    height: 16,
    color: false,
  });
  const body = stripAnsi(frame.rows.join('\n'));
  assert.match(body, /\[ \] rewrite this/);
  assert.match(body, /\[x\] already done/);
  const footer = frame.rows.find((row) => {
    const plain = stripAnsi(row);
    return plain.includes('rewrite this') && !plain.includes('[ ]');
  });
  assert.equal(footer, undefined);
  const hit = frame.todoHits.find((row) => row.cursor === 0);
  assert.ok(hit);
  assert.equal(frame.cursor.y, hit.y);
});

test('todo list paints the focused row on the selection bar', () => {
  const view = {
    pane: 'diff',
    item: {
      origin: 'todo',
      todoId: 1,
      file: { newPath: 'f.js', oldPath: 'f.js', isBinary: false },
      hunk: null,
      blockId: 'todo-1',
    },
    index: 0,
    total: 1,
    scroll: 0,
    status: '',
    counts: { staged: 0, unstaged: 0, untracked: 0, todo: 2 },
    repoName: 'demo',
    todos: ['[ ] rewrite this', '[x] already done'],
    todoFocus: 1,
  };
  const frame = render.renderFrame(view, {
    width: 80,
    height: 16,
    color: true,
  });
  const focused = frame.rows.find((row) => row.includes('already done'));
  const idle = frame.rows.find((row) => row.includes('rewrite this'));
  const selectBg = bg(THEME.buttonBg);
  const idleBg = bg(THEME.ctxBg);
  assert.ok(focused);
  assert.ok(idle);
  assert.ok(focused.includes(selectBg));
  assert.ok(!focused.includes(idleBg));
  assert.ok(idle.includes(idleBg));
  assert.ok(!idle.includes(selectBg));
});

test('checkbox marks use a contrast chip on todo and note rows', () => {
  const hunk = {
    oldStart: 1,
    oldCount: 1,
    newStart: 1,
    newCount: 1,
    header: '@@ -1,1 +1,1 @@',
    lines: [{ type: 'add', text: 'x', noNl: false, blockId: 0 }],
  };
  const todoView = {
    pane: 'diff',
    item: {
      origin: 'todo',
      todoId: 1,
      file: { newPath: 'f.js', oldPath: 'f.js', isBinary: false },
      hunk: null,
      blockId: 'todo-1',
    },
    index: 0,
    total: 1,
    scroll: 0,
    status: '',
    counts: { staged: 0, unstaged: 0, untracked: 0, todo: 2 },
    repoName: 'demo',
    todos: ['[ ] rewrite this', '[x] already done'],
    todoFocus: 0,
  };
  const noteView = {
    pane: 'diff',
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
    counts: { staged: 0, unstaged: 1, untracked: 0 },
    repoName: 'demo',
    noteText: '[x] extract helper',
  };
  const opt = { width: 80, height: 16, color: true };
  const todos = render.renderFrame(todoView, opt);
  const note = render.renderFrame(noteView, opt);
  const openRow = todos.rows.find((row) => row.includes('rewrite this'));
  const doneRow = todos.rows.find((row) => row.includes('already done'));
  const noteRow = note.rows.find((row) => row.includes('extract helper'));
  const openBg = bg(THEME.checkBg);
  const doneBg = bg(THEME.checkDoneBg);
  assert.notDeepEqual(THEME.checkBg, THEME.ctxBg);
  assert.notDeepEqual(THEME.checkBg, THEME.buttonBg);
  assert.notDeepEqual(THEME.checkBg, THEME.noteBg);
  assert.notDeepEqual(THEME.checkDoneBg, THEME.checkBg);
  assert.ok(openRow.includes(openBg));
  assert.ok(!openRow.includes(doneBg));
  assert.ok(doneRow.includes(doneBg));
  assert.ok(!doneRow.includes(openBg));
  assert.ok(noteRow.includes(doneBg));
  assert.ok(noteRow.includes(bg(THEME.noteBg)));
});

test('todo list exposes a click hit for each todo row', () => {
  const view = {
    pane: 'diff',
    item: {
      origin: 'todo',
      todoId: 1,
      file: { newPath: 'f.js', oldPath: 'f.js', isBinary: false },
      hunk: null,
      blockId: 'todo-1',
    },
    index: 0,
    total: 1,
    scroll: 0,
    status: '',
    counts: { staged: 0, unstaged: 0, untracked: 0, todo: 2 },
    repoName: 'demo',
    todos: ['[ ] rewrite this', '[x] already done'],
    todoFocus: 0,
  };
  const frame = render.renderFrame(view, {
    width: 80,
    height: 16,
    color: false,
  });
  assert.equal(frame.todoHits.length, 2);
  assert.equal(frame.todoHits[0].cursor, 0);
  assert.equal(frame.todoHits[1].cursor, 1);
  assert.equal(frame.todoHits[1].y, frame.todoHits[0].y + 1);
  assert.ok(frame.todoHits[0].y > 1);
});

test('wrapPlain moves whole words to the next line', () => {
  assert.deepEqual(wrap.wrapPlain('hello world', 8), ['hello ', 'world']);
  assert.deepEqual(wrap.wrapPlain('extract helper', 10), [
    'extract ',
    'helper',
  ]);
  assert.deepEqual(wrap.wrapPlain('feedback: extract helper', 14), [
    'feedback: ',
    'extract helper',
  ]);
  const long = wrap.wrapPlain('supercalifragilistic', 8);
  assert.deepEqual(long, ['supercal', 'ifragili', 'stic']);
  assert.equal(long.join(''), 'supercalifragilistic');
});

test('cursorInWrap follows word wrap', () => {
  const text = 'hello world';
  assert.deepEqual(wrap.cursorInWrap(text, 0, 8), { row: 0, col: 0 });
  assert.deepEqual(wrap.cursorInWrap(text, 6, 8), { row: 1, col: 0 });
  assert.deepEqual(wrap.cursorInWrap(text, 11, 8), { row: 1, col: 5 });
  assert.deepEqual(wrap.cursorInWrap('ab\ncd', 2, 8), { row: 0, col: 2 });
  assert.deepEqual(wrap.cursorInWrap('ab\ncd', 3, 8), { row: 1, col: 0 });
});

test('wrapMove walks visual rows of one wrapped line', () => {
  const text = 'hello world';
  const down = wrap.wrapMove(text, 0, 8, 1, null);
  assert.equal(down.cursor, 6);
  assert.equal(down.col, 0);
  const up = wrap.wrapMove(text, 6, 8, -1, null);
  assert.equal(up.cursor, 0);
  const fromEnd = wrap.wrapMove(text, 11, 8, -1, null);
  assert.equal(fromEnd.cursor, 5);
  const back = wrap.wrapMove(text, fromEnd.cursor, 8, 1, fromEnd.col);
  assert.equal(back.cursor, 11);
  const edge = wrap.wrapMove(text, 0, 8, -1, null);
  assert.equal(edge.cursor, 0);
});

test('wrapMove keeps a column across a short visual row', () => {
  const text = 'abc de fghij';
  const up = wrap.wrapMove(text, 12, 5, -1, null);
  assert.equal(up.cursor, 6);
  const upAgain = wrap.wrapMove(text, up.cursor, 5, -1, up.col);
  assert.equal(upAgain.cursor, 3);
  const down = wrap.wrapMove(text, upAgain.cursor, 5, 1, upAgain.col);
  assert.equal(down.cursor, 6);
  const downAgain = wrap.wrapMove(text, down.cursor, 5, 1, down.col);
  assert.equal(downAgain.cursor, 12);
});

test('compose and idle notes wrap on word boundaries', () => {
  const hunk = {
    oldStart: 1,
    oldCount: 1,
    newStart: 1,
    newCount: 1,
    header: '@@ -1,1 +1,1 @@',
    lines: [{ type: 'add', text: 'x', noNl: false, blockId: 0 }],
  };
  const base = {
    pane: 'diff',
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
    counts: { staged: 0, unstaged: 1, untracked: 0 },
    repoName: 'demo',
  };
  const opt = { width: 20, height: 16, color: false };
  const compose = render.renderFrame(
    {
      ...base,
      compose: {
        kind: 'feedback',
        text: 'outstanding example',
        cursor: 12,
      },
    },
    opt,
  );
  const composeNote = compose.rows
    .map(stripAnsi)
    .filter((row) => row.includes('outstanding') || row.includes('example'));
  assert.ok(
    composeNote.some(
      (row) => row.includes('outstanding') && !row.includes('example'),
    ),
  );
  assert.ok(
    composeNote.some(
      (row) => row.includes('example') && !row.includes('outstanding'),
    ),
  );
  const idle = render.renderFrame({ ...base, noteText: 'outstanding' }, opt);
  const idleNote = idle.rows
    .map(stripAnsi)
    .filter((row) => row.includes('feedback') || row.includes('outstanding'));
  assert.ok(
    idleNote.some(
      (row) => row.includes('feedback') && !row.includes('outstanding'),
    ),
  );
  assert.ok(
    idleNote.some(
      (row) => row.includes('outstanding') && !row.includes('feedback:'),
    ),
  );
  const todo = render.renderFrame(
    {
      ...base,
      item: {
        origin: 'todo',
        todoId: 1,
        file: { newPath: 'f.js', oldPath: 'f.js', isBinary: false },
        hunk: null,
        blockId: 'todo-1',
      },
      noteText: 'outstanding example',
    },
    opt,
  );
  const todoNote = todo.rows
    .map(stripAnsi)
    .filter((row) => row.includes('outstanding') || row.includes('example'));
  assert.ok(
    todoNote.some(
      (row) => row.includes('outstanding') && !row.includes('example'),
    ),
  );
  assert.ok(
    todoNote.some(
      (row) => row.includes('example') && !row.includes('outstanding'),
    ),
  );
});

test('code overlay paints proposed adds and an in-place cursor', () => {
  const hunk = {
    oldStart: 1,
    oldCount: 1,
    newStart: 1,
    newCount: 1,
    header: '@@ -1,1 +1,1 @@',
    lines: [
      { type: 'del', text: 'a', noNl: false, blockId: 0 },
      { type: 'add', text: 'b', noNl: false, blockId: 0 },
    ],
  };
  const view = {
    pane: 'diff',
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
    counts: { staged: 0, unstaged: 1, untracked: 0 },
    repoName: 'demo',
    codeOverlay: { text: 'hello', keepEmpty: true, cursor: 0 },
  };
  const frame = render.renderFrame(view, {
    width: 80,
    height: 16,
    color: false,
  });
  const body = stripAnsi(frame.rows.join('\n'));
  assert.match(body, /\+ hello/);
  assert.ok(!body.includes('+ b'));
  assert.ok(frame.cursor);
  assert.equal(frame.cursor.x, 3);
});
