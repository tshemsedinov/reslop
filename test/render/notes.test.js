'use strict';

const { sampleHunk, reviewView, labels } = require('../helpers.js');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const render = require('../../lib/render/render.js');
const wrap = require('../../lib/term/wrap.js');
const ansi = require('../../lib/term/ansi.js');
const { THEME, fg, bg, stripAnsi, BOLD } = ansi;
const { ESC, visibleWidth } = ansi;

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

test('presentRows paints with a hidden cursor, then shows it blinking', () => {
  const out = render.presentRows(['aa'], { cursor: { x: 3, y: 2 } });
  const hide = out.indexOf(`${ESC}[?25l`);
  const sync = out.indexOf(`${ESC}[?2026h`);
  const firstRow = out.indexOf(`${ESC}[1;1H`);
  const syncEnd = out.indexOf(`${ESC}[?2026l`);
  const pos = out.indexOf(`${ESC}[2;3H`);
  const style = out.indexOf(`${ESC}[1 q`);
  const blink = out.indexOf(`${ESC}[?12h`);
  const show = out.indexOf(`${ESC}[?25h`);
  assert.ok(hide >= 0);
  assert.ok(hide < sync);
  assert.ok(sync < firstRow);
  assert.ok(firstRow < syncEnd);
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

for (const [name, origin, source, label] of [
  ['commit', 'commit', { revShort: '7ac260c' }, /commit 7ac260c {2}1 {2}tasks/],
  [
    'PR',
    'pr',
    { sourceKind: 'pr', sourceLabel: '#123' },
    /pr #123 {2}1 {2}tasks/,
  ],
  [
    'MR',
    'pr',
    { sourceKind: 'mr', sourceLabel: '!123' },
    /mr !123 {2}1 {2}tasks/,
  ],
]) {
  test(`${name} review header and counts name the source`, () => {
    const hunk = sampleHunk([
      { type: 'add', text: 'x', noNl: false, blockId: 0 },
    ]);
    const file = { newPath: 'f.js', oldPath: 'f.js', isBinary: false };
    const item = { origin, file, hunk, blockId: 0 };
    const counts = { staged: 0, unstaged: 0, untracked: 0, [origin]: 1 };
    const extra = { counts, repoName: 'acme/app', ...source };
    const view = reviewView(item, extra);
    assert.match(render.headerText(view), /reslop: acme\/app\/f\.js$/);
    const frame = render.renderFrame(view, {
      width: 80,
      height: 16,
      color: false,
    });
    assert.match(frame.text, label);
  });
}

test('compose panel sits above status and buttons', () => {
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
    {
      pane: 'diff',
      compose: { kind: 'blockTask', text: 'extract helper', cursor: 14 },
    },
  );
  const frame = render.renderFrame(view, {
    width: 140,
    height: 16,
    color: false,
  });
  assert.equal(frame.rows.length, 16);
  const statusRow = frame.rows[frame.rows.length - 2];
  const buttonRow = frame.rows[frame.rows.length - 1];
  assert.match(statusRow, /0\/1/);
  assert.match(buttonRow, /files/);
  assert.match(buttonRow, /unstage/);
  assert.ok(!buttonRow.includes('code'));
  assert.ok(!buttonRow.includes('reload'));
  const joined = frame.rows.join('\n');
  const noteAt = joined.indexOf('extract helper');
  const statusAt = joined.indexOf(statusRow);
  assert.ok(noteAt >= 0 && noteAt < statusAt);
  assert.ok(frame.cursor);
});

test('feedback compose paints templates above the input', () => {
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
    {
      pane: 'diff',
      compose: { kind: 'blockTask', text: 'new note', cursor: 0 },
      templates: [
        { text: 'extract helper', count: 2 },
        { text: 'add tests', count: 1 },
      ],
      templateIndex: 0,
    },
  );
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
    pane: 'tasks',
    item: {
      origin: 'task',
      todoId: 1,
      file: { newPath: 'f.js', oldPath: 'f.js', isBinary: false },
      hunk: null,
      blockId: 'todo-1',
    },
    index: 0,
    total: 1,
    scroll: 0,
    status: '',
    counts: { staged: 0, unstaged: 0, untracked: 0, tasks: 1 },
    repoName: 'demo',
    taskRows: labels('[ ] rewrite this'),
    tasksFocus: 0,
    taskEdit: { cursor: 0 },
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
  const hunk = sampleHunk([
    { type: 'add', text: 'x', noNl: false, blockId: 0 },
  ]);
  const base = reviewView(
    {
      origin: 'unstaged',
      file: { newPath: 'f.js', oldPath: 'f.js', isBinary: false },
      hunk,
      blockId: 0,
    },
    { pane: 'diff' },
  );
  const opt = { width: 80, height: 16, color: false };
  const compose = render.renderFrame(
    { ...base, compose: { kind: 'blockTask', text: 'hi', cursor: 0 } },
    opt,
  );
  const composeRow = compose.rows.find((row) => row.includes('hi'));
  assert.match(stripAnsi(composeRow), /^ hi /);
  assert.equal(compose.cursor.x, 2);
  const prompt = 'task: [ ] ';
  const asked = render.renderFrame(
    { ...base, compose: { kind: 'blockTask', prompt, text: 'hi', cursor: 0 } },
    opt,
  );
  const askedRow = asked.rows.find((row) => row.includes('hi'));
  assert.match(stripAnsi(askedRow), /^ task: \[ \] hi /);
  assert.equal(asked.cursor.x, 2 + prompt.length);
  const noteText = 'task: [ ] hi';
  const idle = render.renderFrame({ ...base, noteText }, opt);
  const idleRow = idle.rows.find((row) => row.includes(noteText));
  assert.match(stripAnsi(idleRow), /^ task: \[ \] hi /);
});

test('idle feedback note sits above the footer', () => {
  const hunk = sampleHunk([
    { type: 'add', text: 'x', noNl: false, blockId: 0 },
  ]);
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
    noteText: 'task: [ ] extract helper',
  };
  const frame = render.renderFrame(view, {
    width: 80,
    height: 16,
    color: false,
  });
  const statusRow = frame.rows[frame.rows.length - 2];
  assert.match(statusRow, /copied /);
  const joined = frame.rows.join('\n');
  assert.match(joined, /task: \[ \] extract helper/);
  const noteAt = joined.indexOf('task: [ ] extract helper');
  assert.ok(noteAt >= 0 && noteAt < joined.indexOf(statusRow));
});

test('note panel is lighter than the status line', () => {
  const hunk = sampleHunk([
    { type: 'add', text: 'x', noNl: false, blockId: 0 },
  ]);
  const base = reviewView(
    {
      origin: 'unstaged',
      file: { newPath: 'f.js', oldPath: 'f.js', isBinary: false },
      hunk,
      blockId: 0,
    },
    { pane: 'diff' },
  );
  const opt = { width: 80, height: 16, color: true };
  const idle = render.renderFrame({ ...base, noteText: 'extract helper' }, opt);
  const compose = render.renderFrame(
    {
      ...base,
      compose: { kind: 'blockTask', text: 'rewrite loop', cursor: 0 },
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
    pane: 'tasks',
    item: {
      origin: 'task',
      todoId: 1,
      file: { newPath: 'f.js', oldPath: 'f.js', isBinary: false },
      hunk: null,
      blockId: 'todo-1',
    },
    index: 0,
    total: 1,
    scroll: 0,
    status: '',
    counts: { staged: 0, unstaged: 0, untracked: 0, tasks: 1 },
    repoName: 'demo',
    taskRows: [
      { type: 'heading', text: 'Feature requests', focus: false },
      ...labels('[ ] rewrite this', '[x] already done'),
      { type: 'heading', text: 'Bug reports', focus: false },
      ...labels('[ ] later'),
    ],
    tasksFocus: 0,
  };
  const frame = render.renderFrame(view, {
    width: 140,
    height: 16,
    color: false,
  });
  const body = stripAnsi(frame.rows.join('\n'));
  const captionAt = body.indexOf('Feature requests');
  const firstAt = body.indexOf('[ ] rewrite this');
  assert.ok(captionAt >= 0 && captionAt < firstAt);
  assert.match(body, /\[ \] rewrite this/);
  assert.match(body, /\[x\] already done/);
  assert.ok(!stripAnsi(frame.rows[2]).startsWith('+'));
  assert.ok(!stripAnsi(frame.rows[2]).startsWith('-'));
  assert.ok(body.includes('demo: tasks'));
  assert.ok(!body.includes('todo 1/1'));
  assert.ok(!body.includes('demo/tasks'));
  const footer = frame.rows[frame.rows.length - 1];
  assert.match(
    footer,
    /^ 🢐esc {2}insert {2}\^remove {2}tab {2}\^block {2}\^done/,
  );
  assert.match(footer, /\^find {2}\^where {2}ctrl\+up\/dn/);
  assert.doesNotMatch(footer, /files {2}diffs/);
  const rows = frame.rows.map((row) => stripAnsi(row));
  const doneAt = rows.findIndex((row) => row.includes('already done'));
  const issuesAt = rows.findIndex((row) => row.includes('Bug reports'));
  assert.equal(issuesAt, doneAt + 2);
  assert.equal(rows[doneAt + 1].trim(), '');
  assert.ok(!footer.includes('←'));
  assert.ok(!footer.includes('→'));
  assert.ok(!footer.includes('q'));
  assert.ok(!footer.includes('prev'));
  assert.ok(!footer.includes('next'));
  assert.ok(!footer.includes('quit'));
  assert.ok(!footer.includes('reload'));
  assert.ok(!footer.includes('add'));
  assert.ok(!footer.includes('drop'));
  assert.ok(!footer.includes('mode'));
  assert.ok(!footer.includes('feedback'));
  assert.ok(!footer.includes('code'));
  assert.ok(!footer.includes('todo'));
  assert.ok(!footer.includes('pull'));
  assert.ok(!footer.includes('push'));
  assert.ok(!footer.includes('⏎'));
  const colored = render.renderFrame(view, {
    width: 80,
    height: 16,
    color: true,
  });
  const caption = colored.rows.find((row) =>
    stripAnsi(row).includes('Feature requests'),
  );
  assert.ok(stripAnsi(caption).includes('Feature requests'));
  assert.ok(!stripAnsi(caption).includes('demo'));
  assert.ok(!caption.includes(BOLD));
  assert.ok(caption.includes(fg(THEME.taskHeadFg)));
  assert.ok(caption.includes(bg(THEME.taskHeadBg)));
});

test('todo list stays visible while composing', () => {
  const view = {
    pane: 'tasks',
    item: {
      origin: 'task',
      todoId: 1,
      file: { newPath: 'f.js', oldPath: 'f.js', isBinary: false },
      hunk: null,
      blockId: 'todo-1',
    },
    index: 0,
    total: 1,
    scroll: 0,
    status: '',
    counts: { staged: 0, unstaged: 0, untracked: 0, tasks: 2 },
    repoName: 'demo',
    taskRows: labels('[ ] rewrite this', '[x] already done'),
    tasksFocus: 0,
    taskEdit: { cursor: 12 },
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
  const hit = frame.taskHits.find((row) => row.cursor === 0);
  assert.ok(hit);
  assert.equal(frame.cursor.y, hit.y);
});

test('todo list paints the focused row on the selection bar', () => {
  const view = {
    pane: 'tasks',
    item: {
      origin: 'task',
      todoId: 1,
      file: { newPath: 'f.js', oldPath: 'f.js', isBinary: false },
      hunk: null,
      blockId: 'todo-1',
    },
    index: 0,
    total: 1,
    scroll: 0,
    status: '',
    counts: { staged: 0, unstaged: 0, untracked: 0, tasks: 2 },
    repoName: 'demo',
    taskRows: labels('[ ] rewrite this', '[x] already done'),
    tasksFocus: 1,
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
  const hunk = sampleHunk([
    { type: 'add', text: 'x', noNl: false, blockId: 0 },
  ]);
  const todoView = {
    pane: 'tasks',
    item: {
      origin: 'task',
      todoId: 1,
      file: { newPath: 'f.js', oldPath: 'f.js', isBinary: false },
      hunk: null,
      blockId: 'todo-1',
    },
    index: 0,
    total: 1,
    scroll: 0,
    status: '',
    counts: { staged: 0, unstaged: 0, untracked: 0, tasks: 2 },
    repoName: 'demo',
    taskRows: labels('[ ] rewrite this', '[x] already done'),
    tasksFocus: 0,
  };
  const noteView = reviewView(
    {
      origin: 'unstaged',
      file: { newPath: 'f.js', oldPath: 'f.js', isBinary: false },
      hunk,
      blockId: 0,
    },
    { pane: 'diff', noteText: '[x] extract helper' },
  );
  const opt = { width: 80, height: 16, color: true };
  const todos = render.renderFrame(todoView, opt);
  const note = render.renderFrame(noteView, opt);
  const openRow = todos.rows.find((row) => row.includes('rewrite this'));
  const doneRow = todos.rows.find((row) => row.includes('already done'));
  const noteRow = note.rows.find((row) => row.includes('extract helper'));
  const openBg = bg(THEME.checkBg);
  const doneBg = bg(THEME.checkDoneBg);
  assert.ok(!openRow.includes(openBg));
  assert.ok(!openRow.includes(doneBg));
  assert.ok(openRow.includes(bg(THEME.buttonBg)));
  assert.ok(!doneRow.includes(openBg));
  assert.ok(!doneRow.includes(doneBg));
  assert.ok(doneRow.includes(bg(THEME.ctxBg)));
  assert.ok(noteRow.includes(doneBg));
  assert.ok(noteRow.includes(bg(THEME.noteBg)));
});

test('todo list exposes a click hit for each todo row', () => {
  const view = {
    pane: 'tasks',
    item: {
      origin: 'task',
      todoId: 1,
      file: { newPath: 'f.js', oldPath: 'f.js', isBinary: false },
      hunk: null,
      blockId: 'todo-1',
    },
    index: 0,
    total: 1,
    scroll: 0,
    status: '',
    counts: { staged: 0, unstaged: 0, untracked: 0, tasks: 2 },
    repoName: 'demo',
    taskRows: labels('[ ] rewrite this', '[x] already done'),
    tasksFocus: 0,
  };
  const frame = render.renderFrame(view, {
    width: 80,
    height: 16,
    color: false,
  });
  const boxes = frame.taskHits.filter((hit) => hit.check === true);
  const rows = frame.taskHits.filter((hit) => hit.check !== true);
  assert.equal(boxes.length, 2);
  assert.equal(rows.length, 2);
  assert.equal(boxes[0].cursor, 0);
  assert.equal(boxes[0].x0, 1);
  assert.equal(boxes[0].x1, 4);
  assert.equal(rows[0].cursor, 0);
  assert.equal(rows[1].cursor, 1);
  assert.equal(rows[1].y, rows[0].y + 1);
  assert.ok(rows[0].y > 1);
});

test('todo wrap hangs under the checkbox text', () => {
  const view = {
    pane: 'tasks',
    item: {
      origin: 'task',
      todoId: 1,
      file: { newPath: 'f.js', oldPath: 'f.js', isBinary: false },
      hunk: null,
      blockId: 'todo-1',
    },
    index: 0,
    total: 1,
    scroll: 0,
    status: '',
    counts: { staged: 0, unstaged: 0, untracked: 0, tasks: 1 },
    repoName: 'demo',
    taskRows: labels('[ ] abcdefghijklmnopqrstuvwxyz12'),
    tasksFocus: 0,
    taskEdit: { cursor: 14 },
  };
  const frame = render.renderFrame(view, {
    width: 20,
    height: 12,
    color: false,
  });
  const first = frame.rows.find((row) => stripAnsi(row).includes('[ ]'));
  const second = frame.rows.find((row) => {
    const plain = stripAnsi(row);
    return plain.includes('opqrstuvwxyz12') && !plain.includes('[ ]');
  });
  assert.ok(first);
  assert.ok(second);
  const firstPlain = stripAnsi(first);
  const secondPlain = stripAnsi(second);
  assert.match(firstPlain, /^ \[ \] abcdefghijklmn/);
  assert.match(secondPlain, /^ {5}opqrstuvwxyz12/);
  const lead = ' [ ] ';
  const hang = '     ';
  const chunk0 = firstPlain.trimEnd().slice(lead.length);
  const chunk1 = secondPlain.trimEnd().slice(hang.length);
  assert.equal(visibleWidth(chunk0), visibleWidth(chunk1));
  assert.equal(firstPlain.indexOf('a'), secondPlain.indexOf('o'));
  assert.equal(frame.cursor.x, 6);
  const rows = frame.taskHits.filter((hit) => hit.check !== true);
  assert.equal(frame.cursor.y, rows[1].y);
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
  const words = wrap.wrapPlain('alpha beta gamma', 8);
  assert.deepEqual(words, ['alpha ', 'beta ', 'gamma']);
  for (const row of words) assert.ok(visibleWidth(row) <= 8);
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
  const hunk = sampleHunk([
    { type: 'add', text: 'x', noNl: false, blockId: 0 },
  ]);
  const base = reviewView(
    {
      origin: 'unstaged',
      file: { newPath: 'f.js', oldPath: 'f.js', isBinary: false },
      hunk,
      blockId: 0,
    },
    { pane: 'diff' },
  );
  const opt = { width: 20, height: 16, color: false };
  const compose = render.renderFrame(
    {
      ...base,
      compose: {
        kind: 'blockTask',
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
  const noteText = 'task: [ ] outstanding';
  const idle = render.renderFrame({ ...base, noteText }, opt);
  const idleNote = idle.rows
    .map(stripAnsi)
    .filter((row) => row.includes('task') || row.includes('outstanding'));
  assert.ok(
    idleNote.some(
      (row) => row.includes('task') && !row.includes('outstanding'),
    ),
  );
  assert.ok(
    idleNote.some(
      (row) => row.includes('outstanding') && !row.includes('task:'),
    ),
  );
  const todo = render.renderFrame(
    {
      ...base,
      pane: 'tasks',
      item: {
        origin: 'task',
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
  const hunk = sampleHunk([
    { type: 'del', text: 'a', noNl: false, blockId: 0 },
    { type: 'add', text: 'b', noNl: false, blockId: 0 },
  ]);
  const view = reviewView(
    {
      origin: 'unstaged',
      file: { newPath: 'f.js', oldPath: 'f.js', isBinary: false },
      hunk,
      blockId: 0,
    },
    {
      pane: 'diff',
      codeOverlay: { text: 'hello', keepEmpty: true, cursor: 0 },
    },
  );
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

test('diff and file view wrap a long line', () => {
  const text = 'alpha beta gamma delta';
  const hunk = sampleHunk([{ type: 'add', text, noNl: false, blockId: 0 }]);
  const diffView = reviewView(
    {
      origin: 'unstaged',
      file: { newPath: 'f.js', oldPath: 'f.js', isBinary: false },
      hunk,
      blockId: 0,
    },
    { pane: 'diff' },
  );
  const diffFrame = render.renderFrame(diffView, {
    width: 20,
    height: 12,
    color: false,
  });
  const diffRows = diffFrame.rows.map((row) => stripAnsi(row));
  const head = diffRows.find((row) => row.includes('alpha beta'));
  const tail = diffRows.find(
    (row) => row.includes('delta') && !row.includes('alpha'),
  );
  assert.ok(head);
  assert.ok(tail);
  const fileView = {
    pane: 'unit',
    item: null,
    reviewPath: 'a.js',
    unitLine: 0,
    unitLines: [{ type: 'ctx', text, blockId: null, item: null, origin: '' }],
    index: 0,
    total: 1,
    scroll: 0,
    status: '',
    counts: { staged: 0, unstaged: 0, untracked: 0 },
    repoName: 'demo',
  };
  const fileFrame = render.renderFrame(fileView, {
    width: 20,
    height: 8,
    color: false,
  });
  const fileRows = fileFrame.rows.map((row) => stripAnsi(row));
  assert.ok(fileRows.some((row) => row.includes('alpha beta')));
  assert.ok(
    fileRows.some((row) => row.includes('delta') && !row.includes('alpha')),
  );
});

test('editor scrolls a long line instead of wrapping it', () => {
  const text = 'abcdefghijklmnopqrstuvwxyz';
  const hunk = sampleHunk([
    { type: 'add', text: 'b', noNl: false, blockId: 0 },
  ]);
  const view = reviewView(
    {
      origin: 'unstaged',
      file: { newPath: 'f.js', oldPath: 'f.js', isBinary: false },
      hunk,
      blockId: 0,
    },
    {
      pane: 'diff',
      mode: 'compose',
      codeOverlay: {
        text,
        keepEmpty: true,
        cursor: text.length,
        scrollCol: 16,
      },
    },
  );
  const frame = render.renderFrame(view, {
    width: 20,
    height: 12,
    color: false,
  });
  const rows = frame.rows.map((row) => stripAnsi(row));
  const shown = rows.filter((row) => row.includes('qrstuvwxyz'));
  assert.equal(shown.length, 1);
  assert.ok(!rows.some((row) => row.includes('abcdef')));
  assert.equal(frame.cursor.x, 13);
});

test('unit pane marks the current block and keeps other diffs', () => {
  const current = {
    origin: 'unstaged',
    file: { newPath: 'a.js', oldPath: 'a.js', isBinary: false },
    blockId: 0,
  };
  const other = {
    origin: 'unstaged',
    file: { newPath: 'a.js', oldPath: 'a.js', isBinary: false },
    blockId: 1,
  };
  const view = {
    pane: 'unit',
    item: current,
    reviewPath: 'a.js',
    unitLine: 0,
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
        blockId: 0,
        item: current,
        origin: 'unstaged',
      },
      { type: 'ctx', text: 'keep', blockId: null, item: null, origin: '' },
      {
        type: 'add',
        text: 'later',
        blockId: 1,
        item: other,
        origin: 'unstaged',
      },
    ],
    index: 0,
    total: 2,
    scroll: 0,
    status: '',
    counts: { staged: 0, unstaged: 2, untracked: 0 },
    repoName: 'demo',
  };
  const frame = render.renderFrame(view, {
    width: 160,
    height: 12,
    color: false,
  });
  const body = frame.rows.join('\n');
  assert.match(body, /- old/);
  assert.match(body, /\+ new/);
  assert.match(body, / {2}later/);
  assert.ok(!body.includes('+ later'));
  assert.match(render.headerText(view), /reslop: demo\/a\.js$/);
  const footer = frame.rows[frame.rows.length - 1];
  assert.match(
    footer,
    /🢐esc {2}add {2}unstage {2}delete {2}\^task {2}edit.*files/,
  );
  assert.ok(!footer.includes('ignore'));
  assert.ok(!footer.includes('mode'));
  assert.ok(frame.buttons.find((hit) => hit.id === 'add'));
  assert.ok(frame.buttons.find((hit) => hit.id === 'code'));
  assert.equal(
    frame.buttons.find((hit) => hit.id === 'layout'),
    undefined,
  );
  assert.equal(
    frame.buttons.find((hit) => hit.id === 'file'),
    undefined,
  );
  assert.equal(frame.cursor, null);
});

test('unit edit hides plus minus marks and keeps the line-end cursor', () => {
  const current = {
    origin: 'unstaged',
    file: { newPath: 'a.js', oldPath: 'a.js', isBinary: false },
    blockId: 0,
  };
  const view = reviewView(current, {
    pane: 'unit',
    mode: 'compose',
    reviewPath: 'a.js',
    unitLine: 0,
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
        text: 'hello',
        blockId: 0,
        item: current,
        origin: 'unstaged',
        wrap: true,
        editStart: 0,
        editEnd: 5,
        editLast: false,
      },
      {
        type: 'ctx',
        text: 'z',
        blockId: null,
        item: null,
        origin: '',
        wrap: true,
        editStart: 6,
        editEnd: 7,
        editLast: true,
      },
    ],
    codeOverlay: { text: 'hello\nz', keepEmpty: true, cursor: 5 },
  });
  const frame = render.renderFrame(view, {
    width: 80,
    height: 12,
    color: false,
  });
  const body = stripAnsi(frame.rows.join('\n'));
  assert.ok(!body.includes('+ hello'));
  assert.ok(!body.includes('- old'));
  assert.match(body, /hello/);
  assert.ok(frame.cursor);
});
