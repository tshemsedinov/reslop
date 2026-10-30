'use strict';

const { sampleHunk, reviewView } = require('../helpers.js');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const render = require('../../lib/render/render.js');
const ansi = require('../../lib/term/ansi.js');
const { THEME, fg, bg, stripAnsi, BOLD, seq } = ansi;
const { ESC } = ansi;

test('diff and chrome pick up a theme switched after load', () => {
  const hunk = sampleHunk([
    { type: 'del', text: 'a', noNl: false, blockId: 0 },
    { type: 'add', text: 'b', noNl: false, blockId: 0 },
  ]);
  const view = reviewView({
    origin: 'unstaged',
    file: { newPath: 'f.js', oldPath: 'f.js', isBinary: false },
    hunk,
    blockId: 0,
  });
  try {
    ansi.setTheme('light');
    const frame = render.renderFrame(view, {
      width: 80,
      height: 16,
      color: true,
    });
    assert.ok(frame.text.includes(bg(ansi.PALETTES.light.ui.addLineBg)));
    assert.ok(frame.text.includes(bg(ansi.PALETTES.light.ui.headerBg)));
    assert.ok(frame.text.includes(bg(ansi.PALETTES.light.ui.buttonBg)));
    assert.ok(!frame.text.includes(bg(ansi.PALETTES.dark.ui.addLineBg)));
  } finally {
    ansi.setTheme('dark');
  }
});

test('npm output keeps a line margin and a two-space gutter', () => {
  const lines = [];
  for (let i = 0; i < 30; i++) lines.push(`line-${i}-${'x'.repeat(80)}`);
  const view = {
    pane: 'npm',
    npmView: true,
    npmOutput: `${lines.join('\n')}\n`,
    npmFollow: false,
    npmScroll: 2,
    npmCommands: [],
    repoName: 'demo',
    status: '',
    counts: {},
  };
  const frame = render.renderFrame(view, {
    width: 40,
    height: 12,
    color: false,
  });
  const bodyH = frame.bodyH;
  const body = frame.rows.slice(1, 1 + bodyH).map((row) => stripAnsi(row));
  assert.equal(body[0].trim(), '');
  assert.equal(body[body.length - 1].trim(), '');
  assert.equal(body[1].slice(0, 2), '  ');
  assert.ok(body[1].includes('x'));
  assert.ok(body.some((row) => row.startsWith('  line-1')));
  assert.ok(body[1].endsWith('  '));
  assert.equal(body[1].length, 40);
  assert.ok(!body[1].includes('x'.repeat(40)));
});

test('npm output paints a moving bar while a command runs', () => {
  const view = {
    pane: 'npm',
    npmView: true,
    npmRunning: true,
    npmOutput: 'hello\n',
    npmFollow: true,
    progressFrame: 0,
    npmCommands: [],
    repoName: 'demo',
    status: '',
    counts: {},
  };
  const opt = { width: 40, height: 12, color: false };
  const frame = render.renderFrame(view, opt);
  const bodyH = frame.bodyH;
  const body = frame.rows.slice(1, 1 + bodyH).map((row) => stripAnsi(row));
  assert.equal(body[0].trim(), '');
  assert.equal(body[body.length - 1].trim(), '');
  const hello = body.findIndex((row) => row.includes('hello'));
  assert.ok(hello > 0);
  assert.match(body[hello + 1], /^ {2}running {2}·•●•·/);
  assert.ok(hello + 1 < body.length - 2);
  view.progressFrame = 1;
  const next = render.renderFrame(view, opt);
  const moved = next.rows.slice(1, 1 + bodyH).map((row) => stripAnsi(row));
  assert.match(moved[hello + 1], /^ {2}running {2}··•●•/);
  const many = [];
  for (let i = 0; i < 40; i++) many.push(`line-${i}`);
  view.npmOutput = `${many.join('\n')}\n`;
  view.progressFrame = 0;
  const full = render.renderFrame(view, opt);
  const fullBody = full.rows.slice(1, 1 + bodyH).map((row) => stripAnsi(row));
  assert.match(fullBody[fullBody.length - 3], /line-39/);
  assert.match(fullBody[fullBody.length - 2], /^ {2}running {2}·•●•·/);
  view.npmFollow = false;
  view.npmScroll = 0;
  const top = render.renderFrame(view, opt);
  const topBody = top.rows.slice(1, 1 + bodyH).map((row) => stripAnsi(row));
  assert.match(topBody[1], /line-0/);
  assert.ok(!topBody.join('\n').includes('running'));
});

test('npm bin names are blue and package scripts stay white', () => {
  const view = {
    pane: 'npm',
    npmCommands: [
      { name: 'test', command: 'node --test', kind: 'script' },
      { name: 'eslint', command: 'eslint', kind: 'bin' },
    ],
    npmCursor: 0,
    repoName: 'demo',
    status: '',
    counts: {},
  };
  const frame = render.renderFrame(view, {
    width: 100,
    height: 10,
    color: true,
  });
  const rows = frame.rows.map((row) => stripAnsi(row));
  const script = frame.rows[rows.findIndex((row) => row.includes('test'))];
  const bin = frame.rows[rows.findIndex((row) => row.includes('eslint'))];
  const blue = seq(THEME.shaFg, THEME.buttonBg);
  const white = `${BOLD}${seq(THEME.buttonHotFg, THEME.checkBg)}`;
  assert.ok(script.includes(`${white}test`));
  assert.ok(!script.includes(fg(THEME.shaFg)));
  assert.ok(bin.includes(`${blue}eslint`));
  assert.ok(!bin.includes(`${fg(THEME.buttonHotFg)}eslint`));
});

test('npm list aligns names and commands on the left', () => {
  const view = {
    pane: 'npm',
    npmCommands: [
      { name: 'test', command: 'node --test', kind: 'script' },
      { name: 'eslint', command: 'eslint .', kind: 'script' },
      { name: 'leftpad', command: 'leftpad', kind: 'bin' },
    ],
    npmCursor: 1,
    repoName: 'demo',
    status: '',
    counts: {},
  };
  const frame = render.renderFrame(view, {
    width: 100,
    height: 12,
    color: false,
  });
  const rows = frame.rows.map((row) => stripAnsi(row));
  const test = rows.find((row) => row.includes('node --test'));
  const lint = rows.find((row) => row.includes('eslint .'));
  const bin = rows.find((row) => row.includes('leftpad'));
  const nameAt = test.indexOf('test');
  const cmdAt = test.indexOf('node --test');
  assert.equal(lint.indexOf('eslint'), nameAt);
  assert.equal(bin.indexOf('leftpad'), nameAt);
  assert.equal(lint.indexOf('eslint .'), cmdAt);
  assert.equal(bin.indexOf('bin'), cmdAt);
  assert.equal(cmdAt, nameAt + 'leftpad'.length + 2);
});

test('npm history caption, columns, and scrollbar', () => {
  const run = (name, extra = {}) => ({
    name,
    mark: 'pass',
    done: '',
    ok: '',
    fail: '',
    total: 'exit 0',
    exitLabel: true,
    elapsed: '3s',
    when: '14:05',
    ...extra,
  });
  const view = {
    pane: 'npm',
    npmCommands: [{ name: 'test', command: 'node --test', kind: 'script' }],
    npmCursor: 0,
    npmRuns: [
      run('test', {
        done: '4',
        ok: '4',
        fail: '0',
        total: '4',
        exitLabel: false,
        okN: 4,
        failN: 0,
      }),
      run('lint', { mark: 'fail', total: 'exit 1' }),
    ],
    repoName: 'demo',
    status: '',
    counts: {},
  };
  const frame = render.renderFrame(view, {
    width: 80,
    height: 12,
    color: false,
  });
  const bodyH = frame.bodyH;
  const body = frame.rows.slice(1, 1 + bodyH).map((row) => stripAnsi(row));
  const leftW = 80 - Math.floor(80 * 0.7);
  assert.equal(body[0].slice(leftW).trim(), '');
  const titles = body[1].slice(leftW);
  assert.match(titles, /command +done +ok +fail +total +duration +time/);
  assert.equal(body[2].slice(leftW).trim(), '');
  const history = body[3].slice(leftW);
  const statusAt = history.indexOf('✔');
  const nameAt = history.indexOf('test');
  assert.equal(statusAt, titles.indexOf('command'));
  const doneAt = history.indexOf('4');
  const elapsedAt = history.indexOf('3s');
  const whenAt = history.indexOf('14:05');
  assert.ok(statusAt >= 0 && statusAt < nameAt);
  assert.ok(nameAt < doneAt && doneAt < elapsedAt && elapsedAt < whenAt);
  assert.match(history, /✔ +test +4 +4 +0 +4 +3s +14:05/);
  assert.match(body[4].slice(leftW), /✖ +lint/);
  assert.match(body[4].slice(leftW), /exit 1/);
  assert.ok(!history.includes('exit'));
  assert.equal(frame.scrollBar, null);
  const live = render.renderFrame(
    {
      ...view,
      npmRuns: [
        run('test', { live: true, mark: 'run', total: '', exitLabel: false }),
      ],
      progressFrame: 0,
    },
    { width: 80, height: 12, color: false },
  );
  const liveBody = live.rows
    .slice(1, 1 + live.bodyH)
    .map((row) => stripAnsi(row));
  assert.equal(liveBody[0].slice(leftW).trim(), '');
  assert.match(liveBody[3], /⠋/);
  const many = [];
  for (let i = 0; i < 20; i++) many.push(run('test'));
  const scrolled = render.renderFrame(
    { ...view, npmRuns: many },
    { width: 80, height: 12, color: false },
  );
  assert.equal(scrolled.scrollBar.count, 20);
  assert.ok(scrolled.scrollBar.rows < 20);
  const narrow = render.renderFrame(
    {
      ...view,
      npmRuns: [run('very-long-command-name')],
    },
    { width: 60, height: 12, color: false },
  );
  const narrowBody = narrow.rows
    .slice(1, 1 + narrow.bodyH)
    .map((row) => stripAnsi(row));
  assert.match(narrowBody[3], /…/);
  assert.ok(!narrowBody[3].includes('……'));
  const lift = (rgb) =>
    rgb.map((value) => Math.round(value + (255 - value) * 0.45));
  const picked = render.renderFrame(
    { ...view, npmFocus: 'runs', npmRunCursor: 0 },
    { width: 80, height: 12, color: true },
  );
  const pickedRow = picked.rows[4];
  assert.ok(pickedRow.includes(fg(lift(THEME.addLineFg))));
  assert.ok(!pickedRow.includes(fg(THEME.buttonHotFg)));
  const failed = render.renderFrame(
    { ...view, npmFocus: 'runs', npmRunCursor: 1 },
    { width: 80, height: 12, color: true },
  );
  const failedRow = failed.rows[5];
  assert.ok(failedRow.includes(fg(lift(THEME.errorFg))));
});

test('secondary screens lead the hint line with 🢐esc', () => {
  const footerOf = (view, color = false) =>
    render.renderFrame(
      {
        repoName: 'demo',
        status: '',
        counts: {},
        files: [],
        scroll: 0,
        ...view,
      },
      { width: 80, height: 8, color },
    );
  const plain = (view) => stripAnsi(footerOf(view).rows.at(-1));
  assert.match(plain({ pane: 'branches' }), /^ 🢐esc {2}/);
  assert.match(plain({ pane: 'commits' }), /^ 🢐esc {2}/);
  assert.match(plain({ pane: 'npm' }), /^ 🢐esc {2}/);
  assert.match(plain({ pane: 'tasks' }), /^ 🢐esc {2}/);
  assert.match(plain({ pane: 'files' }), /^ 🢐esc {2}/);
  assert.match(plain({ pane: 'diff' }), /^ 🢐esc {2}/);
  assert.match(
    plain({ pane: 'dashboard' }),
    /^ 🢐esc {2}light {2}pull {2}push.*files {2}diffs/,
  );
  assert.match(plain({ pane: 'dashboard' }), /run {2}npm\s/);
  const commits = plain({ pane: 'commits' });
  assert.match(commits, /insert {2}edit {2}update {2}delete {2}view/);
  assert.match(commits, /pull {2}push/);
  assert.equal(commits.includes('apply'), false);
  assert.match(plain({ pane: 'repos' }), /^ 🢐esc {2}light/);
  assert.ok(!plain({ pane: 'repos' }).includes('files'));
  const output = footerOf({ pane: 'npm', npmView: true });
  assert.match(stripAnsi(output.rows.at(-1)), /^ 🢐esc {2}/);
  assert.match(stripAnsi(output.rows.at(-1)), /verbose {2}stop {2}re-run/);
  const running = footerOf({ pane: 'npm', npmView: true, npmRunning: true });
  assert.match(stripAnsi(running.rows.at(-1)), /^ 🢐esc {2}/);
  assert.equal(output.buttons[0].id, 'back');
  const idleStops = output.buttons.filter((hit) => hit.id === 'npmStop');
  assert.equal(idleStops.length, 0);
  const stops = running.buttons.filter((hit) => hit.id === 'npmStop');
  assert.equal(stops.length, 1);
  const colored = footerOf({ pane: 'branches' }, true);
  const row = colored.rows.at(-1);
  const arrow = `${BOLD}${seq(THEME.buttonHotFg, THEME.buttonBg)}🢐`;
  const key = `${seq(THEME.buttonFg, THEME.buttonBg)}esc`;
  assert.ok(row.includes(arrow));
  assert.ok(row.indexOf(arrow) < row.indexOf(key));
  assert.equal(colored.buttons[0].id, 'back');
});

test('npm status line shows the old log size', () => {
  const view = {
    pane: 'npm',
    npmCommands: [{ name: 'test', command: 'node --test', kind: 'script' }],
    npmCursor: 0,
    npmLogs: 'old logs 6',
    repoName: 'demo',
    status: '',
    counts: {},
    files: [],
  };
  const frame = render.renderFrame(view, {
    width: 160,
    height: 10,
    color: false,
  });
  const status = stripAnsi(frame.rows.at(-2));
  const footer = stripAnsi(frame.rows.at(-1));
  assert.match(status, /old logs 6/);
  assert.match(footer, /delete/);
  assert.match(footer, /cleanup/);
  const colored = render.renderFrame(view, {
    width: 60,
    height: 10,
    color: true,
  });
  const row = colored.rows.at(-2);
  const blue = seq(THEME.shaFg, THEME.chromeBg);
  assert.ok(row.includes(`${blue}old logs 6`));
  assert.ok(!row.includes(`${blue}0/0`));
  view.npmLogs = '';
  const empty = render.renderFrame(view, {
    width: 160,
    height: 10,
    color: false,
  });
  const emptyStatus = stripAnsi(empty.rows.at(-2));
  const emptyFooter = stripAnsi(empty.rows.at(-1));
  assert.ok(!emptyStatus.includes('old logs'));
  assert.match(emptyFooter, /cleanup/);
  assert.ok(!empty.buttons.some((hit) => hit.id === 'npmLogs'));
});

test('npm output keeps the colors the command printed', () => {
  const red = '\x1b[31m';
  const reset = '\x1b[0m';
  const view = {
    pane: 'npm',
    npmView: true,
    npmOutput: `${red}Error: boom${reset}\n`,
    npmFollow: true,
    npmCommands: [],
    repoName: 'demo',
    status: '',
    counts: {},
  };
  const frame = render.renderFrame(view, {
    width: 40,
    height: 12,
    color: true,
  });
  assert.ok(frame.text.includes(`${red}Error: boom`));
  assert.ok(frame.text.includes(bg(THEME.ctxBg)));
  const plain = stripAnsi(frame.rows.join('\n'));
  assert.match(plain, / {2}Error: boom/);
});

test('npm output drops the command background', () => {
  const view = {
    pane: 'npm',
    npmView: true,
    npmOutput: '\x1b[31;41mError\x1b[0m\n',
    npmFollow: true,
    npmCommands: [],
    repoName: 'demo',
    status: '',
    counts: {},
  };
  const frame = render.renderFrame(view, {
    width: 40,
    height: 12,
    color: true,
  });
  assert.ok(frame.text.includes('\x1b[31mError'));
  assert.ok(frame.text.includes(bg(THEME.ctxBg)));
  assert.ok(!frame.text.includes('\x1b[41m'));
  assert.ok(!frame.text.includes('31;41'));
});

test('npm output paints assertion fields as a colored table', () => {
  const { reduceOutput } = require('../../lib/runs/output.js');
  const mark = String.fromCharCode(39);
  const field = (name, value) => `  ${name}: ${mark}${value}${mark}`;
  const raw = [
    '    at Test.runInAsyncScope (node:async_hooks:227:14) {',
    field('code', 'ERR_ASSERTION'),
    field('actual', 'local+'),
    '}',
  ].join('\n');
  const view = {
    pane: 'npm',
    npmView: true,
    npmOutput: reduceOutput(raw, '/repo', 1),
    npmFollow: true,
    npmCommands: [],
    repoName: 'demo',
    status: '',
    counts: {},
  };
  const frame = render.renderFrame(view, {
    width: 40,
    height: 12,
    color: true,
  });
  const plain = stripAnsi(frame.rows.join('\n'));
  const codeRow = frame.rows.find((row) =>
    stripAnsi(row).includes('ERR_ASSERTION'),
  );
  const actualRow = frame.rows.find((row) => stripAnsi(row).includes('local+'));
  const bgMark = `${ESC}[48;2;`;
  const backgrounds = (row) => {
    const found = [];
    let at = 0;
    while (at < row.length) {
      const start = row.indexOf(bgMark, at);
      if (start < 0) break;
      const end = row.indexOf('m', start);
      found.push(row.slice(start, end + 1));
      at = end + 1;
    }
    return found;
  };
  assert.match(plain, /code {4}ERR_ASSERTION/);
  assert.match(plain, /actual {4}local\+/);
  const codeBgs = backgrounds(codeRow);
  const actualBgs = backgrounds(actualRow);
  assert.notDeepEqual(codeBgs, actualBgs);
  assert.ok(!codeBgs.includes(bg(THEME.checkBg)));
  assert.ok(!codeBgs.includes(bg(THEME.buttonBg)));
  assert.ok(!codeBgs.includes(bg(THEME.ctxBg)));
  assert.ok(!actualBgs.includes(bg(THEME.ctxBg)));
  assert.ok(codeRow.includes(fg(THEME.ctxFg)));
  assert.ok(!plain.includes('┌'));
  assert.ok(!plain.includes('│'));
  assert.ok(!plain.includes('─'));
});

test('line numbers stay off until the diff view asks for them', () => {
  const hunk = sampleHunk([
    { type: 'del', text: 'hello', noNl: false, blockId: 0 },
    { type: 'add', text: 'world', noNl: false, blockId: 0 },
  ]);
  const item = {
    origin: 'unstaged',
    file: { newPath: 'f.js', oldPath: 'f.js', isBinary: false },
    hunk,
    blockId: 0,
  };
  const size = { width: 160, height: 8, color: false };
  const off = render.renderFrame(reviewView(item, { pane: 'diff' }), size);
  const on = render.renderFrame(
    reviewView(item, { pane: 'diff', lineNumbers: true }),
    size,
  );
  const offBody = off.rows.join('\n');
  const onBody = on.rows.join('\n');
  assert.match(offBody, /^- hello/m);
  assert.doesNotMatch(offBody, /^ {1}1 - hello/m);
  assert.match(onBody, /^ {1}1 - hello/m);
  assert.match(onBody, /^ {1}1 \+ world/m);
  const colored = render.renderFrame(
    reviewView(item, { pane: 'diff', lineNumbers: true }),
    { width: 160, height: 8, color: true },
  );
  const numbered = colored.rows.find((row) =>
    stripAnsi(row).includes('1 - hello'),
  );
  const gutter = seq(THEME.lineNoFg, THEME.lineNoBg);
  assert.ok(numbered.includes(`${gutter} 1 `));
  assert.ok(!numbered.startsWith(bg(THEME.delLineBg)));
  assert.ok(off.buttons.find((hit) => hit.id === 'lines'));
  assert.ok(on.buttons.find((hit) => hit.id === 'lines'));
});

test('line number column fills the body down to the status', () => {
  const hunk = sampleHunk([
    { type: 'del', text: 'hello', noNl: false, blockId: 0 },
    { type: 'add', text: 'world', noNl: false, blockId: 0 },
  ]);
  const item = {
    origin: 'unstaged',
    file: { newPath: 'f.js', oldPath: 'f.js', isBinary: false },
    hunk,
    blockId: 0,
  };
  const frame = render.renderFrame(
    reviewView(item, { pane: 'diff', lineNumbers: true }),
    { width: 40, height: 12, color: true },
  );
  const gutter = bg(THEME.lineNoBg);
  const body = frame.rows.slice(1, -2);
  assert.ok(body.length > 2);
  for (const row of body) assert.ok(row.includes(gutter));
  assert.ok(!frame.rows[0].includes(gutter));
  assert.ok(!frame.rows.at(-1).includes(gutter));
  assert.ok(!frame.rows.at(-2).includes(gutter));
  const side = render.renderFrame(
    reviewView(item, { pane: 'diff', layout: 'side', lineNumbers: true }),
    { width: 80, height: 12, color: true },
  );
  const gap = side.rows[1];
  assert.ok(gap.includes(gutter));
  assert.ok(gap.includes(bg(THEME.splitGutterBg)));
  assert.ok(!side.rows[0].includes(gutter));
  assert.ok(!side.rows.at(-1).includes(gutter));
});

test('side layout numbers the old file left and the new file right', () => {
  const hunk = {
    oldStart: 3,
    oldCount: 1,
    newStart: 10,
    newCount: 1,
    header: '@@ -3,1 +10,1 @@',
    lines: [
      { type: 'del', text: 'gone', noNl: false, blockId: 0 },
      { type: 'add', text: 'fresh', noNl: false, blockId: 0 },
    ],
  };
  const view = reviewView(
    {
      origin: 'unstaged',
      file: { newPath: 'f.js', oldPath: 'f.js', isBinary: false },
      hunk,
      blockId: 0,
    },
    { pane: 'diff', layout: 'side', lineNumbers: true },
  );
  const frame = render.renderFrame(view, {
    width: 80,
    height: 8,
    color: false,
  });
  const row = frame.rows.find((line) => line.includes('gone'));
  const plain = stripAnsi(row);
  const leftW = Math.floor((80 - 1) / 2);
  assert.match(plain.slice(0, leftW), / 3 - gone/);
  assert.match(plain.slice(leftW + 1), /10 \+ fresh/);
});

test('unit file numbers skip deleted lines', () => {
  const current = {
    origin: 'unstaged',
    file: { newPath: 'a.js', oldPath: 'a.js', isBinary: false },
    blockId: 0,
  };
  const view = reviewView(current, {
    pane: 'unit',
    reviewPath: 'a.js',
    lineNumbers: true,
    unitLines: [
      {
        type: 'del',
        text: 'old',
        blockId: 0,
        item: current,
        origin: 'unstaged',
      },
      {
        type: 'add',
        text: 'new',
        newNo: 1,
        blockId: 0,
        item: current,
        origin: 'unstaged',
      },
    ],
  });
  const frame = render.renderFrame(view, {
    width: 160,
    height: 8,
    color: false,
  });
  const body = frame.rows.join('\n');
  assert.match(body, /^ {3}- old/m);
  assert.match(body, /^ 1 \+ new/m);
  assert.ok(frame.buttons.find((hit) => hit.id === 'lines'));
});

test('only failures paint the status message in the error color', () => {
  const { paintStatusLine } = require('../../lib/render/status.js');
  const view = { pane: 'diff', files: [], counts: {} };
  const isError = (status) =>
    paintStatusLine(view, status, 80, true).includes(ansi.fg(THEME.errorFg));
  const notices = [
    'updating',
    'rewording',
    'running',
    'terminated',
    'verbose',
    'filtered',
    'fast on',
    'fast off',
    'logged in',
    'logging in',
    'ignored',
    'already ignored',
    'brief',
    'full',
    'installed left-pad',
    'updated left-pad',
    'staged',
  ];
  for (const status of notices) assert.equal(isError(status), false, status);
  const failures = ['copy failed', 'update failed', 'not logged in', 'boom'];
  for (const status of failures) assert.equal(isError(status), true, status);
});

test('the unit pane paints only the rows on screen', () => {
  const { paintBodyUnit } = require('../../lib/render/diff.js');
  const unitLines = [];
  for (let i = 0; i < 500; i++) {
    const text = `const line${i} = ${i};`;
    unitLines.push({
      type: 'ctx',
      text,
      blockId: null,
      item: null,
      origin: '',
    });
  }
  const view = {
    pane: 'unit',
    item: null,
    reviewPath: 'a.js',
    unitLine: 0,
    unitLines,
    index: 0,
    total: 1,
    scroll: 200,
    status: '',
    counts: { staged: 0, unstaged: 0, untracked: 0 },
    repoName: 'demo',
  };
  const painted = paintBodyUnit(view, 60, false);
  assert.equal(Array.isArray(painted.body), false);
  assert.equal(painted.body.length, 500);
  const paint = painted.body.paint;
  assert.equal(typeof paint, 'function');
  const row = paint(199);
  assert.ok(stripAnsi(row).includes('const line199 = 199;'));
  const frame = render.renderFrame(view, {
    width: 60,
    height: 12,
    color: false,
  });
  const rows = frame.rows.map((line) => stripAnsi(line));
  const shown = rows.filter((line) => /const line\d+ = \d+;/.test(line));
  assert.equal(shown.length, frame.bodyH);
  assert.ok(shown[0].includes('const line199 = 199;'));
  assert.ok(shown.at(-1).includes(`const line${199 + frame.bodyH - 1} =`));
  assert.equal(frame.scrollMax, 501 - frame.bodyH);
});
