'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { sampleHunk, labels } = require('../helpers.js');
const render = require('../../lib/render/render.js');
const { REPO_TASKS_LABEL } = require('../../lib/common/files.js');
const ansi = require('../../lib/term/ansi.js');
const { THEME, fg, bg, stripAnsi, BOLD, seq } = ansi;
const { ESC, RESET, EL, visibleWidth } = ansi;

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
  assert.equal(row.endsWith('  '), true);
  assert.match(row, /^ {2}js a\.js/);
  assert.equal(row.includes('▶'), false);
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
      path: REPO_TASKS_LABEL,
      kind: 'tasks',
      status: 'tasks',
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
      counts: { staged: 0, unstaged: 1, untracked: 0, tasks: 3 },
      status: '',
      scroll: 0,
    },
    { width: 120, height: 8, color: false },
  );
  const lead = stripAnsi(frame.rows[2]);
  const file = stripAnsi(frame.rows[3]);
  assert.ok(lead.startsWith('  📋 '));
  assert.ok(lead.includes('Project Tasks:'));
  assert.equal(lead.includes('▶'), false);
  assert.match(lead, /1\/3\s*$/);
  assert.match(file, /a\.js/);
  assert.ok(!file.includes('Repository'));
  assert.ok(!lead.includes('demo'));
  assert.equal(frame.fileHits[0].y, 3);
  const header = render.headerText({
    pane: 'files',
    files,
    fileCursor: 0,
    repoName: 'demo',
  });
  assert.ok(header.endsWith(`: ${REPO_TASKS_LABEL}`));
  assert.ok(!header.includes('todo '));
  assert.ok(!/\d+\/\d+/.test(header));
  assert.ok(!header.includes('demo/'));
  const colored = render.renderFrame(
    {
      pane: 'files',
      files,
      fileCursor: 0,
      repoName: 'demo',
      counts: { staged: 0, unstaged: 1, untracked: 0, tasks: 3 },
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
    { width: 40, height: 8, color: true },
  );
  const cursor = frame.rows[2];
  const other = frame.rows[3];
  assert.match(stripAnsi(cursor), /^ {2}js a\.js/);
  assert.match(stripAnsi(other), /^ {2}js b\.js/);
  assert.ok(cursor.includes(bg(THEME.buttonBg)));
  assert.ok(!other.includes(bg(THEME.buttonBg)));
  assert.equal(stripAnsi(cursor).includes('▶'), false);
  assert.equal(stripAnsi(other).includes('▶'), false);
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
    width: 160,
    height: 8,
    color: true,
  });
  const row = frame.rows[frame.rows.length - 1];
  const plain = stripAnsi(row);
  assert.match(
    plain,
    /^ 🢐esc {2}add {2}unstage {2}delete {2}ignore {2}edit.*files {2}diffs/,
  );
  assert.match(plain, /^ 🢐esc {2}add {2}/);
  assert.ok(!plain.includes('q'));
  assert.ok(!plain.includes('prev'));
  assert.ok(!plain.includes('next'));
  assert.ok(!plain.includes('quit'));
  assert.ok(!plain.includes('pull'));
  assert.ok(!plain.includes('push'));
  assert.ok(!plain.includes('mode'));
  assert.ok(!plain.includes('feedback'));
  assert.ok(!plain.includes('code'));
  assert.ok(!plain.includes('['));
  assert.ok(!plain.includes('←'));
  assert.ok(!plain.includes('→'));
  assert.ok(row.includes(fg(THEME.buttonHotFg)));
  assert.ok(row.includes(fg(THEME.buttonFg)));
  assert.ok(row.includes(BOLD));
  const dim = render.renderFrame(view, {
    width: 160,
    height: 8,
    color: false,
  });
  const dimRow = dim.rows[dim.rows.length - 1];
  assert.match(
    dimRow,
    /🢐esc {2}add {2}unstage {2}delete {2}ignore {2}edit.*files {2}diffs/,
  );
  assert.match(dimRow, /delete {2}ignore/);
  assert.ok(!dimRow.includes('q'));
  assert.ok(!dimRow.includes('['));
  const mode = frame.buttons.find((hit) => hit.id === 'layout');
  const feedback = frame.buttons.find((hit) => hit.id === 'blockTask');
  const code = frame.buttons.find((hit) => hit.id === 'code');
  assert.equal(mode, undefined);
  assert.equal(feedback, undefined);
  assert.ok(code);
  assert.ok(frame.buttons.find((hit) => hit.id === 'add'));
  assert.ok(frame.buttons.find((hit) => hit.id === 'unstage'));
  assert.ok(frame.buttons.find((hit) => hit.id === 'dashFiles'));
  assert.ok(frame.buttons.find((hit) => hit.id === 'dashDiffs'));
  assert.equal(
    frame.buttons.find((hit) => hit.id === 'reload'),
    undefined,
  );
  assert.equal(
    frame.buttons.find((hit) => hit.id === 'files'),
    undefined,
  );
  assert.equal(
    frame.buttons.find((hit) => hit.id === 'pull'),
    undefined,
  );
  assert.equal(
    frame.buttons.find((hit) => hit.id === 'push'),
    undefined,
  );
  view.fileScope = 'file';
  const fileScope = render.renderFrame(view, {
    width: 160,
    height: 8,
    color: false,
  });
  const fileScopeRow = fileScope.rows[fileScope.rows.length - 1];
  assert.match(
    fileScopeRow,
    /🢐esc {2}add {2}unstage {2}delete {2}ignore {2}edit.*files {2}diffs/,
  );
  assert.ok(fileScope.buttons.find((hit) => hit.id === 'revert'));
  assert.ok(fileScope.buttons.find((hit) => hit.id === 'dashDiffs'));
});

test('files pane todos row dims add unstage drop', () => {
  const view = {
    pane: 'files',
    files: [
      {
        path: REPO_TASKS_LABEL,
        kind: 'tasks',
        status: 'tasks',
        remaining: 1,
        staged: 0,
        firstIndex: 0,
      },
      { path: 'a.js', status: 'unstaged', remaining: 1, firstIndex: 0 },
    ],
    fileCursor: 0,
    repoName: 'demo',
    counts: { staged: 0, unstaged: 1, untracked: 0, tasks: 1 },
    status: '',
    scroll: 0,
  };
  const frame = render.renderFrame(view, {
    width: 160,
    height: 8,
    color: false,
  });
  const footer = frame.rows[frame.rows.length - 1];
  assert.match(
    footer,
    /🢐esc {2}add {2}unstage {2}delete {2}ignore {2}edit.*files {2}diffs/,
  );
  assert.ok(!footer.includes('q'));
  assert.ok(!footer.includes('←'));
  assert.ok(!footer.includes('→'));
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
  assert.ok(frame.buttons.find((hit) => hit.id === 'dashCommits'));
  const colored = render.renderFrame(view, {
    width: 160,
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
    width: 160,
    height: 8,
    color: false,
  });
  const fileFooter = file.rows[file.rows.length - 1];
  assert.match(
    fileFooter,
    /🢐esc {2}add {2}unstage {2}delete {2}ignore {2}edit.*files {2}diffs/,
  );
  assert.ok(file.buttons.find((hit) => hit.id === 'add'));
});

test('diff pane dims add on staged and unstage on unstaged', () => {
  const hunk = sampleHunk([
    { type: 'add', text: 'x', noNl: false, blockId: 0 },
  ]);
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
    width: 140,
    height: 8,
    color: true,
  });
  const stagedRow = staged.rows[staged.rows.length - 1];
  const rest = seq(THEME.buttonFg, THEME.buttonBg);
  const hot = seq(THEME.buttonHotFg, THEME.buttonBg);
  assert.match(stripAnsi(stagedRow), /add {2}unstage {2}delete {2}ignore/);
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
    width: 140,
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
  assert.ok(mainRow.includes('main'));
  assert.ok(!mainRow.includes('['));
  assert.match(featRow, /feat/);
  assert.ok(!featRow.includes('['));
  assert.ok(!text.includes('* main'));
  assert.match(text, /aaa1111/);
  assert.match(text, /bbb2222/);
  assert.match(text, /⇡1/);
  assert.match(text, /⇣2/);
  assert.match(text, /2d ago/);
  assert.match(text, /3w ago/);
  assert.match(text, /init/);
  assert.match(text, /wip/);
  assert.match(render.headerText(view), /demo: branches$/);
  const footer = frame.rows[frame.rows.length - 1];
  const branchIds = frame.buttons.map((hit) => hit.id);
  for (const id of ['pull', 'push']) {
    assert.ok(branchIds.includes(id), id);
  }
  const wide = render.renderFrame(view, {
    width: 160,
    height: 12,
    color: false,
  });
  const wideFooter = stripAnsi(wide.rows.at(-1));
  assert.match(
    wideFooter,
    /^ 🢐esc {2}insert {2}worktree {2}rebase {2}delete {2}pull {2}push.*files/,
  );
  assert.ok(wideFooter.includes('delete'));
  assert.ok(!footer.includes('add'));
  assert.ok(!footer.includes('←'));
  assert.ok(!footer.includes('→'));
  assert.ok(frame.buttons.find((hit) => hit.id === 'newBranch'));
  assert.ok(frame.buttons.find((hit) => hit.id === 'pull'));
  assert.ok(frame.buttons.find((hit) => hit.id === 'push'));
  assert.equal(
    frame.buttons.find((hit) => hit.id === 'rebase'),
    undefined,
  );
  assert.equal(
    frame.buttons.find((hit) => hit.id === 'drop'),
    undefined,
  );
  assert.equal(mainRow.indexOf('aaa1111'), featRow.indexOf('bbb2222'));
  assert.ok(mainRow.endsWith('2d ago  '));
  assert.ok(!mainRow.endsWith('2d ago   '));
  assert.ok(featRow.endsWith('3w ago  '));
  assert.ok(!featRow.endsWith('3w ago   '));
  assert.equal(
    mainRow.indexOf('2d ago') + '2d ago'.length,
    featRow.indexOf('3w ago') + '3w ago'.length,
  );
  assert.match(featRow, /⇣2 {3}3w ago/);
  assert.equal(visibleWidth(featRow), 80);
  assert.equal(visibleWidth(mainRow), 80);
  const colored = render.renderFrame(view, {
    width: 80,
    height: 12,
    color: true,
  });
  const mainPainted = colored.rows.find((row) => row.includes('aaa1111'));
  const featPainted = colored.rows.find((row) => row.includes('bbb2222'));
  const currentBg = bg(THEME.currentBg);
  const rowBg = bg(THEME.ctxBg);
  const mainName = `${BOLD}${fg(THEME.warnFg)}${rowBg}`;
  const currentName = `${fg(THEME.mutedFg)}${currentBg}`;
  assert.ok(mainPainted.includes(`${mainName}main`));
  assert.ok(!mainPainted.includes(bg(THEME.warnFg)));
  assert.ok(!mainPainted.includes(currentBg));
  const shaTone = `${fg(THEME.shaFg)}${bg(THEME.ctxBg)}`;
  assert.ok(mainPainted.includes(`${shaTone}aaa1111`));
  assert.ok(featPainted.includes(`${currentName}feat`));
  assert.ok(!featPainted.includes(`${fg(THEME.buttonHotFg)}${currentBg}`));
  assert.ok(featPainted.includes(`${fg(THEME.shaDarkFg)}${currentBg}`));
  assert.ok(!featPainted.includes(`${fg(THEME.shaFg)}${currentBg}`));
  assert.ok(featPainted.includes(`${fg(THEME.headerFg)}${currentBg}`));
  const date = ansi.paint('3w ago', THEME.headerFg, THEME.currentBg, true);
  const dateTail = ansi.paint('  ', THEME.headerFg, THEME.currentBg, true);
  const currentLead = ansi.paint('  ', THEME.headerFg, THEME.currentBg, true);
  assert.ok(featPainted.includes(`${currentLead}${currentName}feat`));
  assert.ok(!stripAnsi(featPainted).includes('▶'));
  assert.ok(featPainted.includes(`${date}${dateTail}`));
  assert.ok(!featPainted.includes(bg(THEME.ctxBg)));
  assert.ok(featPainted.includes(`${fg(THEME.delLineFg)}${currentBg}`));
  assert.ok(!featPainted.includes(bg(THEME.buttonHotFg)));
  const rest = seq(THEME.buttonFg, THEME.buttonBg);
  const hot = seq(THEME.buttonHotFg, THEME.buttonBg);
  const wideColored = render.renderFrame(view, {
    width: 160,
    height: 12,
    color: true,
  });
  const currentFooter = wideColored.rows[wideColored.rows.length - 1];
  assert.ok(currentFooter.includes(`${rest}rebase`));
  assert.ok(currentFooter.includes(`${rest}delete`));
  assert.ok(currentFooter.includes(`${BOLD}${hot}p`));
  assert.ok(currentFooter.includes(`${BOLD}${hot}s`));
  view.branchCursor = 0;
  const onto = render.renderFrame(view, {
    width: 80,
    height: 12,
    color: true,
  });
  const ontoFeat = onto.rows.find((row) => row.includes('bbb2222'));
  const ontoMain = onto.rows.find((row) => row.includes('aaa1111'));
  assert.ok(ontoFeat.includes(currentBg));
  const currentPlain = ansi.paint('  ', THEME.headerFg, THEME.currentBg, true);
  assert.ok(ontoFeat.includes(currentPlain));
  assert.ok(!ontoFeat.includes(bg(THEME.ctxBg)));
  const selectDate = ansi.paint('2d ago', THEME.mutedFg, THEME.buttonBg, true);
  const selectTail = ansi.paint('  ', THEME.chromeFg, THEME.buttonBg, true);
  assert.ok(ontoMain.includes(`${selectDate}${selectTail}`));
  assert.ok(!ontoMain.includes(bg(THEME.ctxBg)));
  assert.ok(onto.buttons.find((hit) => hit.id === 'rebase'));
  assert.ok(onto.buttons.find((hit) => hit.id === 'drop'));
  assert.ok(onto.buttons.find((hit) => hit.id === 'pull'));
  assert.ok(onto.buttons.find((hit) => hit.id === 'push'));
  const ontoWide = render.renderFrame(view, {
    width: 160,
    height: 12,
    color: true,
  });
  const ontoHint = ontoWide.rows[ontoWide.rows.length - 1];
  assert.ok(ontoHint.includes(`${BOLD}${hot}e`));
  assert.ok(ontoHint.includes(`${BOLD}${hot}p`));
  assert.ok(ontoHint.includes(`${BOLD}${hot}s`));
  const ontoCompact = onto.rows[onto.rows.length - 1];
  assert.ok(ontoCompact.includes(`${BOLD}${hot}p`));
  assert.ok(ontoCompact.includes(`${BOLD}${hot}s`));
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
  assert.match(mainRow, /main/);
  assert.ok(!mainRow.includes('['));
  assert.equal(frame.cursor.y, topicAt + 1);
  assert.match(render.headerText(view), /demo: branches$/);
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
    const endAt = (index, text) =>
      visibleWidth(t.slice(0, index + text.length));
    const addEnd = endAt(add.index, add[0]);
    const delEnd = endAt(del.index, del[0]);
    const statusEnd = endAt(status.index, status[0]);
    const slashAt = endAt(ratio.index, ratio[1]);
    return { addEnd, delEnd, statusEnd, slashAt };
  };
  const marks = rows.map(columnMarks);
  assert.equal(new Set(marks.map((mark) => mark.addEnd)).size, 1);
  assert.equal(new Set(marks.map((mark) => mark.delEnd)).size, 1);
  assert.equal(new Set(marks.map((mark) => mark.statusEnd)).size, 1);
  assert.equal(new Set(marks.map((mark) => mark.slashAt)).size, 1);
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
  assert.match(first, /unstaged {2}0\/4 {3}$/);
});

test('file list dates are right-aligned', () => {
  const files = [
    {
      path: 'a.js',
      status: 'unstaged',
      remaining: 1,
      staged: 0,
      added: 1,
      removed: 0,
      date: '2 hours ago',
      firstIndex: 0,
    },
    {
      path: 'b.js',
      status: 'staged',
      remaining: 1,
      staged: 1,
      added: 1,
      removed: 0,
      date: 'yesterday',
      firstIndex: 1,
    },
  ];
  const frame = render.renderFrame(
    {
      pane: 'files',
      files,
      fileCursor: 0,
      repoName: 'demo',
      counts: { staged: 1, unstaged: 1, untracked: 0 },
      status: '',
      scroll: 0,
    },
    { width: 80, height: 8, color: false },
  );
  const rows = [2, 3].map((i) => stripAnsi(frame.rows[i]));
  const recent = rows.find((row) => row.includes('a.js'));
  const older = rows.find((row) => row.includes('b.js'));
  assert.ok(recent.endsWith('2h ago  '));
  assert.ok(older.endsWith('1d ago  '));
  assert.equal(
    recent.indexOf('2h ago') + '2h ago'.length,
    older.indexOf('1d ago') + '1d ago'.length,
  );
  const colored = render.renderFrame(
    {
      pane: 'files',
      files,
      fileCursor: 0,
      repoName: 'demo',
      counts: { staged: 1, unstaged: 1, untracked: 0 },
      status: '',
      scroll: 0,
    },
    { width: 80, height: 8, color: true },
  );
  const painted = colored.rows.find((row) => row.includes('2h ago'));
  const age = ansi.paint('2h ago', THEME.mutedFg, THEME.buttonBg, true);
  assert.ok(painted.includes(age));
});

test('file list TODOs n/m aligns with file staged/remaining', () => {
  const files = [
    {
      path: REPO_TASKS_LABEL,
      kind: 'tasks',
      status: 'tasks',
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
      counts: { staged: 0, unstaged: 1, untracked: 0, tasks: 5 },
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

test('files screen shows a folder tree, the active pick lighter', () => {
  const files = [
    {
      path: 'lib/a.js',
      status: 'unstaged',
      remaining: 1,
      staged: 0,
      added: 2,
      removed: 1,
      bytes: 2048,
      lines: 40,
      firstIndex: 0,
    },
  ];
  const folders = [
    { key: '.', name: '/', depth: 0, files: 3, bytes: 4096, lines: 90 },
    { key: 'lib', name: 'lib', depth: 1, files: 1, bytes: 2048, lines: 40 },
  ].map((row) => ({ ...row, sized: true }));
  const view = {
    pane: 'files',
    files,
    fileScope: 'file',
    folders,
    folderCursor: 1,
    fileCursor: 0,
    repoName: 'demo',
    counts: {},
    status: '',
    scroll: 0,
  };
  const options = { width: 110, height: 8, color: false };
  const plain = render.renderFrame(view, options);
  const top = stripAnsi(plain.rows[2]);
  const row = stripAnsi(plain.rows[3]);
  const leftW = 33;
  assert.match(top.slice(0, leftW), /^ {2}📁 \/ demo repository 3 4KB 90 {2}$/);
  assert.match(row.slice(0, leftW), /^ {4}📁 lib +1 2KB 40 {2}$/);
  assert.match(
    top.slice(leftW),
    /^ {2}js a\.js +\+2 {2}-1 {2}0\/1 {2}2 KB {2}40 {2}$/,
  );
  const tree = plain.fileHits.filter((hit) => hit.folder);
  assert.deepEqual(
    tree.map((hit) => [hit.cursor, hit.x0, hit.x1]),
    [
      [0, 0, leftW],
      [1, 0, leftW],
    ],
  );
  const color = { ...options, color: true };
  const strong = bg(THEME.checkBg);
  const onFiles = render.renderFrame(view, color);
  assert.ok(onFiles.rows[2].includes(strong));
  assert.ok(!onFiles.rows[3].includes(strong));
  assert.ok(onFiles.rows[2].includes(bg(THEME.buttonBg)));
  assert.ok(onFiles.rows[3].includes(bg(THEME.ctxBg)));
  const { mixRgb } = require('../../lib/render/log.js');
  const noteFg = mixRgb(THEME.buttonBg, THEME.chromeFg, 0.25);
  const note = ansi.paint(' demo repository', noteFg, THEME.buttonBg, true);
  assert.ok(onFiles.rows[2].includes(note));
  const onTree = render.renderFrame({ ...view, folderFocus: true }, color);
  assert.ok(!onTree.rows[2].includes(strong));
  assert.ok(onTree.rows[3].includes(strong));
  assert.match(render.headerText(view), /reslop: demo: files$/);
  const onFolder = { ...view, folderFocus: true };
  assert.match(render.headerText(onFolder), /reslop: demo: files$/);
  const diffs = { ...view, fileScope: 'diff' };
  assert.match(render.headerText(diffs), /reslop: demo: files$/);
  const run = { ...view, pane: 'npm' };
  assert.match(render.headerText(run), /reslop: demo: run$/);
  const packages = { ...view, pane: 'packages' };
  assert.match(render.headerText(packages), /reslop: demo: npm packages$/);
});

test('list screens show the selection without a marker', () => {
  const base = { repoName: 'demo', counts: {}, status: '', scroll: 0 };
  const options = { width: 80, height: 10, color: false };
  const entry = { status: 'unstaged', remaining: 1, staged: 0, firstIndex: 0 };
  const files = [
    { ...entry, path: 'a.js' },
    { ...entry, path: 'b.js' },
  ];
  const marks = (view) =>
    render
      .renderFrame({ ...base, ...view }, options)
      .rows.slice(1, -2)
      .filter((row) => stripAnsi(row).includes('▶'));
  assert.deepEqual(marks({ pane: 'files', files, fileCursor: 1 }), []);
  const npmCommands = [{ name: 'test', command: 'node --test' }];
  assert.deepEqual(marks({ pane: 'npm', npmCommands, npmCursor: 0 }), []);
  const branches = [{ name: 'main', current: true, subject: 'x' }];
  assert.deepEqual(marks({ pane: 'branches', branches, branchCursor: 0 }), []);
});

test('a multiselected row looks like the single selected row', () => {
  const base = { repoName: 'demo', counts: {}, status: '', scroll: 0 };
  const options = { width: 80, height: 10, color: true };
  const entry = { status: 'unstaged', remaining: 1, staged: 0, firstIndex: 0 };
  const files = [
    { ...entry, path: 'a.js' },
    { ...entry, path: 'b.js' },
  ];
  const rowOf = (view, name) =>
    render
      .renderFrame({ ...base, pane: 'files', files, ...view }, options)
      .rows.slice(1)
      .find((row) => stripAnsi(row).includes(name));
  const single = rowOf({ fileCursor: 0 }, 'a.js');
  const grouped = { fileCursor: 1, listSelection: [0, 1], multiselect: true };
  assert.equal(rowOf(grouped, 'a.js'), single);
  const npmCommands = [
    { name: 'test', command: 'node --test' },
    { name: 'lint', command: 'eslint .' },
  ];
  const npm = { pane: 'npm', npmCommands, npmFocus: 'commands' };
  const one = rowOf({ ...npm, npmCursor: 0 }, 'node --test');
  const both = { ...npm, npmCursor: 1, listSelection: [0, 1] };
  assert.equal(rowOf({ ...both, multiselect: true }, 'node --test'), one);
});

test('long lists show a one column scroller', () => {
  const base = { repoName: 'demo', counts: {}, status: '', scroll: 0 };
  const options = { width: 60, height: 10, color: true };
  const thumb = bg(THEME.taskHeadBg);
  const thumbRows = (frame) =>
    frame.rows.slice(1, -2).filter((row) => row.includes(`${thumb} `));
  const entry = { status: 'unstaged', remaining: 1, staged: 0 };
  const files = Array.from({ length: 30 }, (_, firstIndex) => ({
    ...entry,
    path: `f${firstIndex}.js`,
    firstIndex,
  }));
  const flat = render.renderFrame(
    { ...base, pane: 'files', files, fileCursor: 0 },
    options,
  );
  assert.ok(thumbRows(flat).length > 0);
  assert.equal(flat.scrollBars.length, 1);
  assert.equal(flat.scrollBars[0].x, 60);
  assert.equal(flat.scrollBars[0].target, 'list');
  const few = render.renderFrame(
    { ...base, pane: 'files', files: files.slice(0, 2), fileCursor: 0 },
    options,
  );
  assert.equal(thumbRows(few).length, 0);
  assert.deepEqual(few.scrollBars, []);
  const folders = Array.from({ length: 20 }, (_, at) => ({
    key: at ? `d${at}` : '.',
    name: at ? `d${at}` : '/',
    depth: at ? 1 : 0,
    files: 1,
    bytes: 1,
    lines: 1,
    sized: true,
  }));
  const tree = render.renderFrame(
    { ...base, pane: 'files', fileScope: 'file', files, folders },
    options,
  );
  const targets = tree.scrollBars.map((bar) => [bar.target, bar.x]);
  assert.deepEqual(targets, [
    ['folders', 18],
    ['list', 60],
  ]);
  const branches = files.map((file) => ({ name: file.path, subject: 's' }));
  const listed = render.renderFrame(
    { ...base, pane: 'branches', branches, branchCursor: 0 },
    options,
  );
  assert.equal(listed.scrollBars[0].target, 'list');
  const commits = files.map((file, at) => ({
    sha: `${at}`.repeat(7),
    shortSha: `${at}`.repeat(7),
    subject: file.path,
    body: `${file.path}\nmore`,
  }));
  const brief = { ...base, pane: 'commits', commits, commitCursor: 0 };
  assert.equal(render.renderFrame(brief, options).scrollBars[0].target, 'list');
  const full = render.renderFrame({ ...brief, commitView: 'full' }, options);
  assert.ok(thumbRows(full).length > 0);
  assert.equal(full.scrollBars[0].target, '');
  const tasks = render.renderFrame(
    {
      ...base,
      pane: 'tasks',
      taskRows: labels(...files.map((file) => `[ ] ${file.path}`)),
      tasksFocus: 0,
    },
    options,
  );
  assert.ok(thumbRows(tasks).length > 0);
  const packages = Array.from({ length: 30 }, (_, at) => ({
    name: `pkg${at}`,
    bytes: at + 1,
    current: '1.0.0',
    wanted: '1.0.0',
    latest: '1.0.0',
  }));
  const data = {
    ready: true,
    hasManifest: true,
    deps: 30,
    modules: { bytes: 30, count: 30, packages },
  };
  const listedPackages = render.renderFrame(
    { ...base, pane: 'packages', packages: data, packagesCursor: 0 },
    options,
  );
  assert.ok(thumbRows(listedPackages).length > 0);
  assert.equal(listedPackages.scrollBars.length, 1);
  assert.equal(listedPackages.scrollBars[0].target, 'list');
  assert.equal(listedPackages.scrollBars[0].x, 60);
  const plain = listedPackages.rows.map(stripAnsi);
  const headAt = plain.findIndex((row) => row.includes('current'));
  assert.equal(listedPackages.rows[headAt].includes(thumb), false);
  const one = packages.slice(0, 1);
  const short = { ...data, modules: { ...data.modules, packages: one } };
  const fewPackages = render.renderFrame(
    { ...base, pane: 'packages', packages: short, packagesCursor: 0 },
    options,
  );
  assert.deepEqual(fewPackages.scrollBars, []);
});

test('list screens keep two spaces at both sides of a row', () => {
  const base = { repoName: 'demo', counts: {}, status: '', scroll: 0 };
  const rowsOf = (view) =>
    render
      .renderFrame(
        { ...base, ...view },
        { width: 80, height: 10, color: false },
      )
      .rows.slice(1, -2)
      .map(stripAnsi)
      .filter((row) => row.trim());
  const edged = (text) => /^ {2}\S(.*\S)? {2}$/.test(text);
  const entry = { status: 'unstaged', remaining: 1, staged: 0, added: 1 };
  const files = [{ ...entry, path: 'lib/a.js', removed: 0, date: '1h' }];
  const flat = rowsOf({ pane: 'files', files, fileCursor: 0 })[0];
  assert.ok(edged(flat), flat);
  const folders = [
    {
      key: '.',
      name: '/',
      depth: 0,
      files: 1,
      bytes: 9,
      lines: 1,
      sized: true,
    },
  ];
  const tree = { pane: 'files', files, folders, folderCursor: 0 };
  const split = rowsOf({ ...tree, fileCursor: 0 })[0];
  assert.ok(edged(split.slice(0, 24)), split);
  assert.ok(edged(split.slice(24)), split);
  const commit = {
    sha: 'a'.repeat(40),
    shortSha: 'aaa1111',
    date: '1h',
    subject: 'land',
    head: true,
  };
  const commitRow = rowsOf({
    pane: 'commits',
    commits: [commit],
    commitCursor: 0,
  })[0];
  assert.ok(edged(commitRow), commitRow);
  const runs = rowsOf({
    pane: 'npm',
    npmCommands: [{ name: 'test', command: 'node --test', kind: 'script' }],
    npmCursor: 0,
    npmRuns: [{ name: 'test', mark: 'pass', total: '4', when: '14:05' }],
  });
  assert.match(runs[0], /^ {2}test {2}node --test {2}/);
  for (const row of runs) assert.ok(edged(row.slice(24)), row);
  const pkg = { name: 'x', current: '1.0.0', wanted: '1.0.0', latest: '1.0.0' };
  const modules = { count: 1, bytes: 10, packages: [{ ...pkg, bytes: 10 }] };
  const packages = { ready: true, hasManifest: true, deps: 1, modules };
  const listed = rowsOf({ pane: 'packages', packages, packagesCursor: 0 });
  for (const row of listed) assert.ok(edged(row), row);
  const branches = [{ name: 'main', current: true, subject: 'x', date: '1h' }];
  const branch = rowsOf({ pane: 'branches', branches, branchCursor: 0 })[0];
  assert.ok(edged(branch), branch);
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
      hunk: sampleHunk([{ type: 'add', text: 'x', noNl: false, blockId: 0 }]),
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

test('find marks path matches and the active one is stronger', () => {
  const files = [
    {
      path: 'lib/files.js',
      status: 'unstaged',
      remaining: 1,
      staged: 0,
      added: 1,
      removed: 0,
    },
    {
      path: 'lib/find.js',
      status: 'unstaged',
      remaining: 1,
      staged: 0,
      added: 1,
      removed: 0,
    },
    {
      path: 'src/app.js',
      status: 'unstaged',
      remaining: 1,
      staged: 0,
      added: 1,
      removed: 0,
    },
  ];
  const view = {
    pane: 'files',
    files,
    fileCursor: 1,
    repoName: 'demo',
    branch: 'main',
    counts: { staged: 0, unstaged: 3, untracked: 0 },
    status: '',
    scroll: 0,
    find: { query: 'lib', at: 1 },
  };
  const frame = render.renderFrame(view, {
    width: 80,
    height: 12,
    color: true,
  });
  const rows = frame.rows.map((raw) => ({ raw, text: stripAnsi(raw) }));
  const filesRow = rows.find((row) => row.text.includes('lib/files.js'));
  const findRow = rows.find((row) => row.text.includes('lib/find.js'));
  assert.ok(filesRow.raw.includes(bg(THEME.searchBg)));
  assert.ok(!filesRow.raw.includes(bg(THEME.searchOnBg)));
  assert.ok(findRow.raw.includes(bg(THEME.searchOnBg)));
  const status = rows[rows.length - 2];
  assert.match(status.text, /^ \/lib /);
  assert.ok(status.raw.includes(bg(THEME.searchOnBg)));
  const header = rows[0];
  assert.match(header.text, /demo: files/);
  assert.equal(header.raw.includes(bg(THEME.searchOnBg)), false);
});
