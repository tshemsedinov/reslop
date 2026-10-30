'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const render = require('../../lib/render/render.js');
const ansi = require('../../lib/term/ansi.js');
const { THEME, fg, bg, stripAnsi } = ansi;
const { RESET, visibleWidth } = ansi;
const { assertPrompt, YES_NO } = require('../helpers.js');

test('commit pane brief mode lists subject hash branch and age', () => {
  const view = {
    pane: 'commits',
    commits: [
      {
        sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        shortSha: 'aaa1111',
        author: 'Ada',
        date: '2 hours ago',
        refs: 'HEAD -> main',
        subject: 'land the change',
        head: true,
      },
      {
        sha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        shortSha: 'bbb2222',
        author: 'Bob',
        date: 'yesterday',
        refs: 'old',
        subject: 'init',
        head: false,
      },
    ],
    commitCursor: 0,
    repoName: 'demo',
    counts: { staged: 1, unstaged: 0, untracked: 0 },
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
  const text = rows.join('\n');
  const headRow = rows.find((row) => row.includes('aaa1111'));
  const oldRow = rows.find((row) => row.includes('bbb2222'));
  assert.ok(headRow);
  assert.ok(oldRow);
  assert.ok(headRow.includes('  land the change'));
  assert.equal(headRow.includes('▶'), false);
  assert.ok(headRow.includes('HEAD -> main'));
  assert.ok(headRow.includes('2h ago'));
  assert.equal(headRow.includes('Ada'), false);
  assert.ok(oldRow.includes('  init'));
  assert.ok(oldRow.includes('old'));
  assert.ok(oldRow.includes('1d ago'));
  assert.ok(headRow.indexOf('land the change') < headRow.indexOf('aaa1111'));
  assert.ok(headRow.indexOf('aaa1111') < headRow.indexOf('HEAD -> main'));
  assert.equal(headRow.indexOf('HEAD -> main'), oldRow.indexOf('old'));
  assert.ok(headRow.indexOf('HEAD -> main') < headRow.indexOf('2h ago'));
  assert.ok(headRow.endsWith('2h ago  '));
  assert.ok(oldRow.endsWith('1d ago  '));
  assert.equal(visibleWidth(headRow), 80);
  assert.equal(visibleWidth(oldRow), 80);
  assert.equal(
    headRow.indexOf('2h ago') + '2h ago'.length,
    oldRow.indexOf('1d ago') + '1d ago'.length,
  );
  assert.match(text, /land the change/);
  assert.match(render.headerText(view), /demo: commits brief$/);
  const footer = frame.rows[frame.rows.length - 1];
  const commitIds = frame.buttons.map((hit) => hit.id);
  for (const id of ['newCommit', 'reword', 'view', 'drop', 'pull', 'push']) {
    assert.ok(commitIds.includes(id), id);
  }
  for (const id of ['commit', 'apply', 'amend', 'fixup']) {
    assert.ok(!commitIds.includes(id), id);
  }
  assert.equal(footer.includes('apply'), false);
  assert.ok(!footer.includes('add'));
  assert.ok(!footer.includes('←'));
  view.commits[0] = {
    ...view.commits[0],
    subject: 'fixup! land the change',
  };
  const fixupFrame = render.renderFrame(view, {
    width: 80,
    height: 12,
    color: false,
  });
  assert.ok(fixupFrame.buttons.find((hit) => hit.id === 'apply'));
  view.commits[0] = {
    ...view.commits[0],
    subject: 'land the change',
  };
  const colored = render.renderFrame(view, {
    width: 80,
    height: 12,
    color: true,
  });
  const headPainted = colored.rows.find((row) => row.includes('aaa1111'));
  const mark = ansi.paint('  ', THEME.chromeFg, THEME.buttonBg, true);
  const subject = ansi.paint(
    'land the change',
    THEME.buttonHotFg,
    THEME.buttonBg,
    true,
  );
  const tail = ansi.paint('  ', THEME.chromeFg, THEME.buttonBg, true);
  assert.ok(headPainted.includes(`${mark}${subject}`));
  assert.ok(headPainted.endsWith(tail));
  assert.ok(!headPainted.includes(bg(THEME.currentBg)));
  assert.equal(visibleWidth(stripAnsi(headPainted)), 80);
  assert.ok(!headPainted.includes(bg(THEME.ctxBg)));
  view.commitCursor = 1;
  const selected = render.renderFrame(view, {
    width: 80,
    height: 12,
    color: true,
  });
  const idleHead = selected.rows.find((row) => row.includes('aaa1111'));
  const idleMark = ansi.paint('  ', THEME.mutedFg, THEME.ctxBg, true);
  const idleSubject = ansi.paint(
    'land the change',
    THEME.chromeFg,
    THEME.ctxBg,
    true,
  );
  assert.ok(idleHead.includes(`${idleMark}${idleSubject}`));
  const selectedRow = selected.rows.find((row) => row.includes('bbb2222'));
  const selectedMark = ansi.paint('  ', THEME.chromeFg, THEME.buttonBg, true);
  const selectedSubject = ansi.paint(
    'init',
    THEME.buttonHotFg,
    THEME.buttonBg,
    true,
  );
  assert.ok(selectedRow.includes(`${selectedMark}${selectedSubject}`));
  assert.ok(selectedRow.endsWith(tail));
});

test('viewed commit uses a readable current palette', () => {
  const sha = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const view = {
    pane: 'commits',
    rev: sha,
    revShort: 'aaa1111',
    commits: [
      {
        pending: true,
        subject: 'uncommitted changes',
        sha: '',
        shortSha: '',
        date: '',
        refs: '',
      },
      {
        sha,
        shortSha: 'aaa1111',
        date: '2 hours ago',
        refs: 'HEAD -> main',
        subject: 'land the change',
        head: true,
      },
    ],
    commitCursor: 0,
    repoName: 'demo',
    counts: { staged: 1, unstaged: 0, untracked: 0 },
    branch: 'main',
    status: '',
    scroll: 0,
  };
  const colored = render.renderFrame(view, {
    width: 80,
    height: 12,
    color: true,
  });
  const pending = colored.rows.find((row) => row.includes('uncommitted'));
  const viewed = colored.rows.find((row) => row.includes('aaa1111'));
  const currentBg = bg(THEME.commitCurrentBg);
  const currentLead = ansi.paint(
    '  ',
    THEME.commitCurrentFg,
    THEME.commitCurrentBg,
    true,
  );
  const currentSubject = ansi.paint(
    'land the change',
    THEME.commitCurrentFg,
    THEME.commitCurrentBg,
    true,
  );
  const currentSha = ansi.paint(
    'aaa1111',
    THEME.shaDarkFg,
    THEME.commitCurrentBg,
    true,
  );
  const currentTail = ansi.paint(
    '  ',
    THEME.commitCurrentFg,
    THEME.commitCurrentBg,
    true,
  );
  assert.ok(pending.includes(bg(THEME.buttonBg)));
  assert.ok(!pending.includes(currentBg));
  assert.ok(viewed.includes(`${currentLead}${currentSubject}`));
  assert.ok(viewed.includes(currentSha));
  assert.ok(viewed.endsWith(currentTail));
  assert.ok(!viewed.includes(bg(THEME.buttonBg)));
  assert.ok(!viewed.includes(bg(THEME.ctxBg)));
  view.commitCursor = 1;
  const selected = render.renderFrame(view, {
    width: 80,
    height: 12,
    color: true,
  });
  const selectedViewed = selected.rows.find((row) => row.includes('aaa1111'));
  const selectedLead = ansi.paint(
    '  ',
    THEME.commitCurrentFg,
    THEME.commitCurrentBg,
    true,
  );
  const currentRefs = ansi.paint(
    'HEAD -> main',
    THEME.shaDarkFg,
    THEME.commitCurrentBg,
    true,
  );
  assert.ok(selectedViewed.includes(`${selectedLead}${currentSubject}`));
  assert.ok(selectedViewed.includes(currentRefs));
  assert.ok(!selectedViewed.includes(fg(THEME.warnFg)));
  assert.ok(!selectedViewed.includes(bg(THEME.buttonBg)));
  view.rev = '';
  view.revShort = '';
  view.commitCursor = 0;
  const worktree = render.renderFrame(view, {
    width: 80,
    height: 12,
    color: true,
  });
  const currentPending = worktree.rows.find((row) =>
    row.includes('uncommitted'),
  );
  const pendingLead = ansi.paint(
    '  ',
    THEME.commitCurrentFg,
    THEME.commitCurrentBg,
    true,
  );
  const pendingSubject = ansi.paint(
    'uncommitted changes',
    THEME.commitCurrentFg,
    THEME.commitCurrentBg,
    true,
  );
  assert.ok(currentPending.includes(`${pendingLead}${pendingSubject}`));
  assert.ok(currentPending.endsWith(currentTail));
  assert.ok(!currentPending.includes(bg(THEME.buttonBg)));
  view.rev = sha;
  view.revShort = 'aaa1111';
  view.commitView = 'full';
  view.commitCursor = 1;
  const full = render.renderFrame(view, {
    width: 80,
    height: 16,
    color: true,
  });
  const hash = full.rows.find((row) => row.includes(sha));
  const fullHash = ansi.paint(
    sha,
    THEME.shaDarkFg,
    THEME.commitCurrentBg,
    true,
  );
  assert.ok(hash.includes(fullHash));
  assert.ok(!hash.includes(bg(THEME.ctxBg)));
});

test('current commit palettes are darker with readable contrast', () => {
  const palettes = [
    require('../../lib/term/theme-dark.json').ui,
    require('../../lib/term/theme-light.json').ui,
  ];
  const luminance = (hex) => {
    const channels = hex
      .slice(1)
      .match(/../g)
      .map((part) => parseInt(part, 16) / 255);
    const linear = channels.map((value) => {
      if (value <= 0.04045) return value / 12.92;
      return ((value + 0.055) / 1.055) ** 2.4;
    });
    return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
  };
  for (const palette of palettes) {
    const background = luminance(palette.commitCurrentBg);
    const foreground = luminance(palette.commitCurrentFg);
    assert.ok(background < luminance(palette.currentBg));
    assert.ok(foreground < luminance(palette.mutedFg));
    assert.ok((background + 0.05) / (foreground + 0.05) >= 4.5);
  }
});

test('full commit selection scrolls the entire item into the window', () => {
  const { paintBodyCommits } = require('../../lib/render/commits.js');
  const commits = Array.from({ length: 4 }, (_, index) => ({
    sha: `sha${index}`,
    subject: `subject ${index}`,
    body: `subject ${index}\nbody ${index}\nlast ${index}`,
  }));
  const view = { commits, commitView: 'full', listScroll: 0 };
  const options = [80, false, 10, 1];
  for (const commitCursor of [0, 1, 2, 3, 2, 1, 0]) {
    const painted = paintBodyCommits({ ...view, commitCursor }, ...options);
    const selected = painted.fileHits.filter(
      (hit) => hit.cursor === commitCursor,
    );
    assert.equal(selected.length, 4);
    const text = painted.body.join('\n');
    for (const part of [`sha${commitCursor}`, `last ${commitCursor}`]) {
      assert.ok(text.includes(part));
    }
    view.listScroll = painted.listScroll;
  }
});

test('multiselected commits look like the selected one', () => {
  const { paintBodyCommits } = require('../../lib/render/commits.js');
  const commits = [
    { sha: 'one', body: 'first\nbody', subject: 'first' },
    { sha: 'two', body: 'second\nbody', subject: 'second' },
  ];
  for (const commitView of ['brief', 'full']) {
    const view = {
      commits,
      commitView,
      commitCursor: 1,
      listSelection: [0, 1],
      rev: 'other',
    };
    const painted = paintBodyCommits(view, 80, true, 16, 1);
    for (const hit of painted.fileHits) {
      const row = painted.body[hit.y - 2];
      assert.ok(row.includes(bg(THEME.buttonBg)));
      assert.ok(!row.includes(bg(THEME.currentBg)));
    }
  }
});

test('full view puts uncommitted changes on the first line', () => {
  const view = {
    pane: 'commits',
    commitView: 'full',
    commits: [
      {
        pending: true,
        subject: 'uncommitted changes',
        sha: '',
        shortSha: '',
        date: '',
        refs: '',
        stagedAdded: 2,
        unstagedAdded: 4,
        stagedRemoved: 1,
        unstagedRemoved: 3,
      },
    ],
    commitCursor: 0,
    repoName: 'demo',
    counts: { staged: 1, unstaged: 0, untracked: 0 },
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
  const subject = rows.find((row) => row.includes('uncommitted changes'));
  const at = rows.indexOf(subject);
  assert.ok(subject.startsWith('  '));
  assert.equal(subject.includes('▶'), false);
  assert.ok(subject.includes('Diffs:'));
  assert.ok(subject.indexOf('Diffs:') < subject.indexOf('+2/4'));
  assert.ok(subject.indexOf('+2/4') < subject.indexOf('-1/3'));
  assert.equal(rows[at - 1].trim(), '');
  const brief = render.renderFrame(
    { ...view, commitView: 'brief' },
    { width: 80, height: 8, color: false },
  );
  const briefRow = brief.rows
    .map((row) => stripAnsi(row))
    .find((row) => row.includes('uncommitted'));
  assert.ok(briefRow.includes('+2/4'));
  assert.ok(briefRow.includes('-1/3'));
  assert.equal(briefRow.includes('Diffs:'), false);
  assert.ok(briefRow.indexOf('+2/4') < briefRow.indexOf('-1/3'));
});

test('diff counts follow branches in full and replace them in brief', () => {
  const entry = {
    sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    shortSha: 'aaa1111',
    author: 'Ada',
    email: 'ada@example.com',
    date: '2 hours ago',
    when: '2026-09-26 00:32:00 +0300',
    refs: 'HEAD -> main',
    subject: 'land the change',
    body: 'land the change',
    added: 4,
    removed: 1,
    head: true,
  };
  const view = {
    pane: 'commits',
    commitView: 'full',
    commits: [entry],
    commitCursor: 0,
    repoName: 'demo',
    counts: { staged: 0, unstaged: 0, untracked: 0 },
    branch: 'main',
    status: '',
    scroll: 0,
  };
  const full = render.renderFrame(view, {
    width: 120,
    height: 16,
    color: false,
  });
  const rows = full.rows.map((row) => stripAnsi(row));
  const branches = rows.find((row) => row.includes('HEAD -> main'));
  const count = rows.find((row) => row.includes('Diffs:'));
  const ago = '2h ago';
  const timeRow = rows.find((row) => row.includes(ago));
  const endAt = (row, token) => row.indexOf(token) + token.length;
  assert.ok(count.includes('+4'));
  assert.ok(count.includes('-1'));
  assert.ok(rows.indexOf(branches) < rows.indexOf(count));
  assert.ok(count.indexOf('Diffs:') < count.indexOf('+4'));
  assert.ok(count.indexOf('+4') < count.indexOf('-1'));
  assert.equal(endAt(count, '-1'), endAt(timeRow, ago));
  const wider = render.renderFrame(
    {
      ...view,
      commits: [
        entry,
        {
          ...entry,
          sha: 'b'.repeat(40),
          added: 12,
          removed: 30,
          refs: 'old',
        },
      ],
    },
    { width: 120, height: 20, color: false },
  );
  const wideRows = wider.rows.map((row) => stripAnsi(row));
  const small = wideRows.find(
    (row) => row.includes('Diffs:') && row.includes('+4'),
  );
  const large = wideRows.find((row) => row.includes('+12'));
  assert.equal(endAt(small, '+4'), endAt(large, '+12'));
  assert.equal(endAt(small, '-1'), endAt(large, '-30'));
  const colored = render.renderFrame(view, {
    width: 120,
    height: 16,
    color: true,
  });
  const painted = colored.rows.find((row) => row.includes('Diffs:'));
  const addPaint = ansi.paint('+4', THEME.addLineFg, THEME.buttonBg, true);
  const delPaint = ansi.paint('-1', THEME.delLineFg, THEME.buttonBg, true);
  assert.ok(painted.includes(addPaint));
  assert.ok(painted.includes(delPaint));
  const brief = render.renderFrame(
    { ...view, commitView: 'brief' },
    { width: 80, height: 8, color: false },
  );
  const briefRow = brief.rows
    .map((row) => stripAnsi(row))
    .find((row) => row.includes('aaa1111'));
  assert.ok(briefRow.includes('HEAD -> main'));
  assert.ok(briefRow.includes('+4'));
  assert.ok(briefRow.includes('-1'));
  assert.ok(briefRow.indexOf('HEAD -> main') < briefRow.indexOf('+4'));
  assert.ok(briefRow.indexOf('+4') < briefRow.indexOf('-1'));
  const open = render.renderFrame(
    {
      ...view,
      commitView: 'brief',
      commits: [{ ...entry, refs: '' }],
    },
    { width: 80, height: 8, color: false },
  );
  const openRow = open.rows
    .map((row) => stripAnsi(row))
    .find((row) => row.includes('aaa1111'));
  assert.ok(openRow.includes('+4'));
  assert.ok(openRow.includes('-1'));
  assert.equal(openRow.includes('HEAD -> main'), false);
  assert.ok(openRow.indexOf('+4') < openRow.indexOf('-1'));
  const pair = render.renderFrame(
    {
      ...view,
      commitView: 'brief',
      commits: [
        { ...entry, refs: '', added: 4, removed: 1 },
        {
          ...entry,
          refs: '',
          sha: 'b'.repeat(40),
          shortSha: 'bbb2222',
          added: 12,
          removed: 30,
        },
      ],
    },
    { width: 80, height: 8, color: false },
  );
  const pairRows = pair.rows.map((row) => stripAnsi(row));
  const few = pairRows.find((row) => row.includes('+4'));
  const many = pairRows.find((row) => row.includes('+12'));
  assert.equal(endAt(few, '+4'), endAt(many, '+12'));
  assert.equal(endAt(few, '-1'), endAt(many, '-30'));
  const coloredBrief = render.renderFrame(
    {
      ...view,
      commitView: 'brief',
      commits: [{ ...entry, refs: '' }],
    },
    { width: 80, height: 8, color: true },
  );
  const coloredRow = coloredBrief.rows.find((row) => row.includes('+4'));
  assert.ok(coloredRow.includes(addPaint));
  assert.ok(coloredRow.includes(delPaint));
});

test('brief mode shows only the first line of a commit message', () => {
  const view = {
    pane: 'commits',
    commits: [
      {
        sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        shortSha: 'aaa1111',
        author: 'Ada',
        date: '2 hours ago',
        refs: 'HEAD -> main',
        subject: 'land the change extra line',
        body: 'land the change\nextra line',
        head: true,
      },
    ],
    commitCursor: 0,
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
  const headRow = rows.find((row) => row.includes('aaa1111'));
  assert.ok(headRow.includes('land the change'));
  assert.equal(headRow.includes('extra line'), false);
  view.compose = {
    kind: 'commit',
    commitKind: 'reword',
    text: 'ship it\nextra line',
    cursor: 7,
  };
  const editing = render.renderFrame(view, {
    width: 80,
    height: 12,
    color: false,
  });
  const editRows = editing.rows.map((row) => stripAnsi(row));
  const editRow = editRows.find((row) => row.includes('ship it'));
  assert.ok(editRow.startsWith('  ship it'));
  assert.equal(editRow.includes('▶'), false);
  assert.equal(editRow.includes('land the change'), false);
  assert.equal(
    editRows.some((row) => row.includes('extra line')),
    false,
  );
});

test('commit pane types a message on a row at the top of the list', () => {
  const view = {
    pane: 'commits',
    commits: [
      {
        sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        shortSha: 'aaa1111',
        author: 'Ada',
        date: '2 hours ago',
        subject: 'land the change',
        head: true,
      },
      {
        sha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        shortSha: 'bbb2222',
        author: 'Bob',
        date: 'yesterday',
        subject: 'init',
        head: false,
      },
    ],
    commitCursor: 0,
    compose: { kind: 'commit', text: 'ship it', cursor: 7 },
    repoName: 'demo',
    counts: { staged: 1, unstaged: 0, untracked: 0 },
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
  const editAt = rows.findIndex((row) => row.includes('ship it'));
  const headAt = rows.findIndex((row) => row.includes('aaa1111'));
  assert.ok(editAt >= 0);
  assert.ok(headAt > editAt);
  assert.ok(rows[editAt].includes('  ship it'));
  assert.equal(rows[editAt].includes('▶'), false);
  assert.ok(!rows[editAt].includes('[ship it]'));
  assert.equal(frame.cursor.y, editAt + 1);
  assert.match(render.headerText(view), /demo: commits brief$/);
});

test('amend types over the current commit row', () => {
  const view = {
    pane: 'commits',
    commits: [
      {
        sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        shortSha: 'aaa1111',
        author: 'Ada',
        date: '2 hours ago',
        subject: 'land the change',
        head: true,
      },
      {
        sha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        shortSha: 'bbb2222',
        author: 'Bob',
        date: 'yesterday',
        subject: 'init',
        head: false,
      },
    ],
    commitCursor: 0,
    compose: {
      kind: 'commit',
      commitKind: 'amend',
      text: 'rewritten',
      cursor: 9,
    },
    repoName: 'demo',
    counts: { staged: 1, unstaged: 0, untracked: 0 },
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
  const editAt = rows.findIndex((row) => row.includes('rewritten'));
  const oldAt = rows.findIndex((row) => row.includes('bbb2222'));
  assert.ok(editAt >= 0);
  assert.ok(oldAt > editAt);
  assert.ok(rows[editAt].includes('aaa1111'));
  assert.ok(!rows[editAt].includes('land the change'));
  assert.equal(
    rows.some((row) => row.includes('▶')),
    false,
  );
  assert.equal(frame.cursor.y, editAt + 1);
  assert.match(render.headerText(view), /demo: commits brief$/);
});

test('full mode amend edits the message inside the panel', () => {
  const hash = 'a'.repeat(40);
  const view = {
    pane: 'commits',
    commitView: 'full',
    commits: [
      {
        sha: hash,
        shortSha: 'aaa1111',
        author: 'Ada',
        email: 'ada@example.com',
        date: '2 hours ago',
        when: '2026-09-26 00:32:00 +0300',
        refs: 'HEAD -> main',
        subject: 'land the change',
        body: 'land the change\n\nexplain the change',
        head: true,
      },
      {
        sha: 'b'.repeat(40),
        shortSha: 'bbb2222',
        author: 'Bob',
        date: 'yesterday',
        when: '2026-09-25 12:00:00 +0300',
        subject: 'init',
        body: 'init',
        head: false,
      },
    ],
    commitCursor: 0,
    compose: {
      kind: 'commit',
      commitKind: 'amend',
      text: 'rewritten\nsecond line',
      cursor: 9,
    },
    repoName: 'demo',
    counts: { staged: 1, unstaged: 0, untracked: 0 },
    branch: 'main',
    status: '',
    scroll: 0,
  };
  const frame = render.renderFrame(view, {
    width: 120,
    height: 18,
    color: false,
  });
  const rows = frame.rows.map((row) => stripAnsi(row));
  const head = rows.find((row) => row.includes(hash));
  const subject = rows.find((row) => row.includes('rewritten'));
  const editAt = rows.findIndex((row) => row.includes('rewritten'));
  assert.ok(head.startsWith('  '));
  assert.equal(head.includes('▶'), false);
  assert.ok(head.includes('Ada <ada@example.com>'));
  assert.equal(head.includes('rewritten'), false);
  assert.equal(head.includes('land the change'), false);
  assert.equal(subject.includes(hash), false);
  assert.ok(rows.some((row) => row.includes('second line')));
  assert.equal(
    rows.some((row) => row.includes('explain the change')),
    false,
  );
  assert.equal(
    rows.some((row) => row.includes('▶')),
    false,
  );
  assert.equal(frame.cursor.y, editAt + 1);
  const bob = rows.find((row) => row.includes('Bob'));
  assert.ok(bob.includes('b'.repeat(40)));
  const colored = render.renderFrame(view, {
    width: 120,
    height: 18,
    color: true,
  });
  const subjectPaint = ansi.paint(
    'rewritten',
    THEME.buttonHotFg,
    THEME.buttonBg,
    true,
  );
  const bodyPaint = ansi.paint(
    'second line',
    THEME.mutedFg,
    THEME.buttonBg,
    true,
  );
  const paintedSubject = colored.rows.find((row) => row.includes('rewritten'));
  const paintedBody = colored.rows.find((row) => row.includes('second line'));
  assert.ok(paintedSubject.includes(subjectPaint));
  assert.ok(paintedBody.includes(bodyPaint));
});

test('full mode new commit stays a multiline message', () => {
  const hash = 'a'.repeat(40);
  const view = {
    pane: 'commits',
    commitView: 'full',
    commits: [
      {
        sha: hash,
        shortSha: 'aaa1111',
        author: 'Ada',
        date: '2 hours ago',
        when: '2026-09-26 00:32:00 +0300',
        subject: 'land the change',
        body: 'land the change',
        head: true,
      },
    ],
    commitCursor: 0,
    compose: {
      kind: 'commit',
      commitKind: 'commit',
      text: 'ship it\nmore',
      cursor: 7,
    },
    repoName: 'demo',
    counts: { staged: 1, unstaged: 0, untracked: 0 },
    branch: 'main',
    status: '',
    scroll: 0,
  };
  const frame = render.renderFrame(view, {
    width: 120,
    height: 16,
    color: false,
  });
  const rows = frame.rows.map((row) => stripAnsi(row));
  const draft = rows.find((row) => row.includes('ship it'));
  const editAt = rows.findIndex((row) => row.includes('ship it'));
  const kept = rows.find((row) => row.includes(hash));
  assert.ok(draft.startsWith('  '));
  assert.equal(draft.includes('▶'), false);
  assert.equal(draft.includes(hash), false);
  assert.equal(draft.includes('aaa1111'), false);
  assert.ok(rows.some((row) => row.includes('more')));
  assert.equal(
    rows.some((row) => row.includes('▶')),
    false,
  );
  assert.equal(frame.cursor.y, editAt + 1);
  assert.ok(kept.includes('Ada'));
  assert.equal(kept.includes('▶'), false);
  assert.ok(editAt < rows.findIndex((row) => row.includes(hash)));
});

test('commit pane full mode shows the message author date and branches', () => {
  const view = {
    pane: 'commits',
    commitView: 'full',
    commits: [
      {
        sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        shortSha: 'aaa1111',
        author: 'Ada',
        email: 'ada@example.com',
        date: '2 hours ago',
        when: '2026-09-26 00:32:00 +0300',
        refs: 'HEAD -> main, origin/main',
        subject: 'land the change',
        body: 'land the change\n\nexplain the change',
        head: true,
      },
      {
        sha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        shortSha: 'bbb2222',
        author: 'Bob',
        date: 'yesterday',
        when: '2026-09-25 12:00:00 +0300',
        refs: 'old',
        subject: 'init',
        body: 'init',
        head: false,
      },
    ],
    commitCursor: 0,
    repoName: 'demo',
    counts: { staged: 1, unstaged: 0, untracked: 0 },
    branch: 'main',
    status: '',
    scroll: 0,
  };
  const frame = render.renderFrame(view, {
    width: 120,
    height: 18,
    color: false,
  });
  const rows = frame.rows.map((row) => stripAnsi(row));
  const hash = 'a'.repeat(40);
  const head = rows.find((row) => row.includes(hash));
  const stamp = rows.find((row) => row.includes('2026-09-26 00:32:00 +0300'));
  const branches = rows.find((row) =>
    row.includes('HEAD -> main, origin/main'),
  );
  assert.ok(head.startsWith('  '));
  assert.equal(head.includes('▶'), false);
  assert.ok(head.includes('Ada <ada@example.com>'));
  assert.ok(head.indexOf(hash) < head.indexOf('Ada'));
  assert.ok(stamp.includes('land the change'));
  assert.ok(stamp.includes('2h ago'));
  assert.ok(stamp.indexOf('land the change') < stamp.indexOf('2026-09-26'));
  assert.ok(stamp.indexOf('2026-09-26') < stamp.indexOf('2h ago'));
  assert.ok(rows.some((row) => row.includes('explain the change')));
  const column = head.indexOf('Ada');
  assert.equal(stamp.indexOf('2026-09-26'), column);
  assert.equal(branches.indexOf('HEAD -> main'), column);
  const wideRefs = 'HEAD -> main, origin/main, feature/long-name';
  const when = '2026-09-26 00:32:00 +0300';
  const ago = '2h ago';
  const wide = render.renderFrame(
    {
      ...view,
      commits: [{ ...view.commits[0], refs: wideRefs }, view.commits[1]],
    },
    { width: 120, height: 18, color: false },
  );
  const wideRows = wide.rows.map((row) => stripAnsi(row));
  const timeRow = wideRows.find((row) => row.includes(when));
  const branchRow = wideRows.find((row) => row.includes(wideRefs));
  const origin = timeRow.indexOf(when);
  const columnW = Math.max(
    'Ada <ada@example.com>'.length,
    when.length + 2 + ago.length,
    wideRefs.length,
  );
  assert.equal(branchRow.indexOf(wideRefs), origin);
  assert.equal(timeRow.indexOf(ago) + ago.length, origin + columnW);
  assert.ok(timeRow.endsWith(`${ago}  `));
  assert.ok(timeRow.indexOf(ago) > origin + when.length);
  assert.equal(visibleWidth(timeRow), 120);
  const oldHash = 'b'.repeat(40);
  const bob = rows.find((row) => row.includes('Bob'));
  assert.ok(bob.includes(oldHash));
  assert.ok(bob.indexOf(oldHash) < bob.indexOf('Bob'));
  assert.equal(bob.includes('<'), false);
  const old = rows.find((row) => row.includes('old'));
  assert.equal(old.includes(oldHash), false);
  assert.equal(old.includes('init'), false);
  const hits = frame.fileHits.map((hit) => hit.cursor);
  assert.ok(hits.filter((cursor) => cursor === 0).length >= 4);
  assert.ok(hits.includes(1));
  assert.match(render.headerText(view), /demo: commits full$/);
  const colored = render.renderFrame(view, {
    width: 120,
    height: 18,
    color: true,
  });
  const authorPaint = ansi.paint('Ada', THEME.addLineFg, THEME.buttonBg, true);
  const emailPaint = ansi.paint(
    ' <ada@example.com>',
    THEME.mutedFg,
    THEME.buttonBg,
    true,
  );
  const subjectPaint = ansi.paint(
    'land the change',
    THEME.buttonHotFg,
    THEME.buttonBg,
    true,
  );
  const bodyPaint = ansi.paint(
    'explain the change',
    THEME.mutedFg,
    THEME.buttonBg,
    true,
  );
  const paintedAuthor = colored.rows.find((row) => row.includes('Ada'));
  const paintedSubject = colored.rows.find((row) =>
    row.includes('land the change'),
  );
  const paintedBody = colored.rows.find((row) =>
    row.includes('explain the change'),
  );
  assert.ok(paintedAuthor.includes(authorPaint));
  assert.ok(paintedAuthor.includes(emailPaint));
  assert.equal(visibleWidth(stripAnsi(paintedAuthor)), 120);
  assert.ok(!paintedAuthor.includes(bg(THEME.ctxBg)));
  const panelTail = ansi.paint('  ', THEME.chromeFg, THEME.buttonBg, true);
  assert.ok(paintedSubject.endsWith(panelTail));
  assert.ok(stripAnsi(paintedSubject).endsWith('2h ago  '));
  assert.ok(paintedSubject.includes(subjectPaint));
  assert.ok(paintedBody.includes(bodyPaint));
  view.commitCursor = 1;
  const lower = render.renderFrame(view, {
    width: 80,
    height: 8,
    color: false,
  });
  const lowerRows = lower.rows.map((row) => stripAnsi(row));
  assert.ok(lowerRows.some((row) => row.includes('b'.repeat(40))));
});

test('full mode commit edit hints how to save', () => {
  const view = {
    pane: 'commits',
    commitView: 'full',
    mode: 'compose',
    compose: {
      kind: 'commit',
      commitKind: 'commit',
      text: 'ship',
      cursor: 4,
    },
    commits: [],
    commitCursor: 0,
    repoName: 'demo',
    counts: { staged: 1, unstaged: 0, untracked: 0 },
    branch: 'main',
    status: '',
    scroll: 0,
  };
  const frame = render.renderFrame(view, {
    width: 80,
    height: 10,
    color: false,
  });
  const footer = stripAnsi(frame.rows[frame.rows.length - 1]);
  const status = stripAnsi(frame.rows[frame.rows.length - 2]);
  assert.match(footer, /^ Press Ctrl-S or Enter at EOF to save/);
  assert.equal(footer.includes('reword'), false);
  assert.equal(status.includes('Enter at EOF'), false);
  assert.equal(frame.buttons.length, 0);
  const colored = render.renderFrame(view, {
    width: 80,
    height: 10,
    color: true,
  });
  const row = colored.rows[colored.rows.length - 1];
  const hotFg = 0xff;
  const ctrlS = ansi.paint('Ctrl-S', hotFg, THEME.buttonBg, true, true);
  const enter = ansi.paint('Enter', hotFg, THEME.buttonBg, true, true);
  const press = ansi.paint('Press ', THEME.buttonFg, THEME.buttonBg, true);
  const or = ansi.paint(' or ', THEME.buttonFg, THEME.buttonBg, true);
  const tail = ansi.paint(
    ' at EOF to save',
    THEME.buttonFg,
    THEME.buttonBg,
    true,
  );
  assert.ok(row.includes(`${press}${ctrlS}${or}${enter}${tail}`));
  view.status = 'empty commit message';
  const blocked = render.renderFrame(view, {
    width: 80,
    height: 10,
    color: false,
  });
  const errorRow = stripAnsi(blocked.rows[blocked.rows.length - 2]);
  const stillHint = stripAnsi(blocked.rows[blocked.rows.length - 1]);
  assert.ok(errorRow.includes('empty commit message'));
  assert.ok(stillHint.includes('Press Ctrl-S or Enter at EOF to save'));
  view.status = '';
  view.commitView = 'brief';
  const brief = render.renderFrame(view, {
    width: 80,
    height: 10,
    color: false,
  });
  const briefRow = stripAnsi(brief.rows[brief.rows.length - 1]);
  assert.equal(briefRow.includes('Enter at EOF'), false);
  assert.ok(brief.buttons.find((hit) => hit.id === 'view'));
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
  const text = ' update reslop 0.1.5 → 1.0.0? y/n';
  const { frame } = assertPrompt(view, text, YES_NO);
  assert.match(stripAnsi(frame.rows[2]), /a\.js/);
  assert.ok(frame.buttons.some((hit) => hit.id === 'add'));
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
  assertPrompt(view, ' drop feat? y/n', YES_NO);
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
  const text = ' Need force-push? force push';
  assertPrompt(view, text, [['f', 'force push']]);
});

test('insert on a commit asks what to do on the status line', () => {
  const prompt = (mode) => {
    const frame = render.renderFrame(
      {
        pane: 'commits',
        repoName: 'demo',
        status: '',
        counts: {},
        commits: [],
        scroll: 0,
        mode,
      },
      { width: 100, height: 8, color: false },
    );
    return stripAnsi(frame.rows.at(-2));
  };
  const head = prompt('confirmCommit');
  assert.match(head, /^ what do you want to do\? {2}esc cancel/);
  assert.match(head, /update {2}commit {2}amend {2}fixup/);
  const colored = render.renderFrame(
    {
      pane: 'commits',
      repoName: 'demo',
      status: '',
      counts: {},
      commits: [],
      scroll: 0,
      mode: 'confirmCommit',
    },
    { width: 100, height: 8, color: true },
  );
  const warn = fg(THEME.warnFg);
  const yellow = colored.rows
    .at(-2)
    .split(warn)
    .slice(1)
    .map((part) => stripAnsi(part.split(RESET)[0]));
  assert.deepEqual(yellow, ['esc', 'u', 'c', 'a', 'f']);
});
