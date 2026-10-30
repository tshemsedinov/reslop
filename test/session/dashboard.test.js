'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const tiles = require('../../lib/render/tiles.js');
const { paintTile } = tiles;
const dashTable = require('../../lib/render/table.js');
const { cell, flexCell, tableLines } = dashTable;
const { labelOf, pickGroups } = dashTable;
const dashboardPaint = require('../../lib/render/dashboard.js');
const { branchesBlock } = dashboardPaint;
const dashBlocks = require('../../lib/render/dashboard-blocks.js');
const { filesBlock, diffsBlock, npmBlock, npmContent } = dashBlocks;
const { badgeColors } = require('../../lib/render/icons.js');
const { paintBodyPackages } = require('../../lib/render/npm.js');
const { Session } = require('../../lib/session/session.js');
const { createGitRepo } = require('../../lib/git/git.js');
const ansi = require('../../lib/term/ansi.js');
const { stripAnsi, visibleWidth } = ansi;
const helpers = require('../helpers.js');
const { makeRepo, waitUntil, click } = helpers;
const { openDashboard, frameText } = helpers;

const press = async (ui, key) => {
  ui.handleEvent({ type: 'key', key });
  await ui.ops.idle();
};

test('hotkeys open screens and Esc returns to the dashboard', async () => {
  const { ui, close } = await openDashboard();
  try {
    await press(ui, 'c');
    assert.equal(ui.pane, 'commits');
    await press(ui, 'escape');
    assert.equal(ui.pane, 'dashboard');
    await press(ui, 'b');
    assert.equal(ui.pane, 'branches');
    await press(ui, 'escape');
    assert.equal(ui.pane, 'dashboard');
    await press(ui, 'n');
    assert.equal(ui.pane, 'packages');
    await press(ui, 'escape');
    assert.equal(ui.pane, 'dashboard');
    await press(ui, 'r');
    assert.equal(ui.pane, 'npm');
    await press(ui, 'escape');
    assert.equal(ui.pane, 'dashboard');
    await press(ui, 'f');
    assert.equal(ui.pane, 'files');
    await press(ui, 'escape');
    assert.equal(ui.pane, 'dashboard');
    await press(ui, 'd');
    assert.equal(ui.pane, 'files');
    await press(ui, 'escape');
    assert.equal(ui.pane, 'dashboard');
    await press(ui, 't');
    assert.equal(ui.nav.tasksOpen, true);
    await press(ui, 'escape');
    assert.equal(ui.pane, 'dashboard');
    assert.equal(ui.nav.tasksOpen, false);
    ui.agents.listModels = async () => [];
    await press(ui, 'a');
    assert.equal(ui.pane, 'agents');
    await press(ui, 'escape');
    assert.equal(ui.pane, 'dashboard');
  } finally {
    await close();
  }
});

test('other keys do nothing, Esc and its button quit', async () => {
  const { ui, close } = await openDashboard();
  try {
    let quit = 0;
    ui.onQuit = () => {
      quit += 1;
    };
    for (const key of ['j', 'k', 'down', 'up', 's', 'u', 'x']) {
      await press(ui, key);
    }
    assert.equal(ui.pane, 'dashboard');
    assert.equal(quit, 0);
    await press(ui, 'escape');
    assert.equal(quit, 1);
    ui.draw();
    const hit = ui.lastFrame.buttons.find((button) => button.id === 'back');
    assert.ok(hit);
    click(ui, hit.x0 + 1, ui.lastFrame.height);
    assert.equal(quit, 2);
  } finally {
    await close();
  }
});

test('the footer offers the block buttons and opens screens', async () => {
  const { ui, close } = await openDashboard();
  try {
    ui.draw();
    const ids = ui.lastFrame.buttons.map((button) => button.id);
    for (const id of ['dashFiles', 'dashDiffs', 'dashCommits', 'dashTasks']) {
      assert.ok(ids.includes(id), id);
    }
    const hit = ui.lastFrame.buttons.find((b) => b.id === 'dashCommits');
    click(ui, hit.x0 + 1, ui.lastFrame.height);
    await ui.ops.idle();
    assert.equal(ui.pane, 'commits');
  } finally {
    await close();
  }
});

test('a click on a tile opens its screen', async () => {
  const { ui, close } = await openDashboard();
  try {
    ui.draw();
    const hit = ui.lastFrame.fileHits.find((h) => h.cursor === 'branches');
    assert.ok(hit);
    click(ui, hit.x0 + 2, hit.y);
    await ui.ops.idle();
    assert.equal(ui.pane, 'branches');
    ui.nav.pane = 'dashboard';
    ui.draw();
    const npm = ui.lastFrame.fileHits.find((h) => h.cursor === 'npm');
    assert.ok(npm);
    click(ui, npm.x0 + 2, npm.y);
    await ui.ops.idle();
    assert.equal(ui.pane, 'packages');
  } finally {
    await close();
  }
});

test('the dashboard stays responsive on a tiny terminal', async () => {
  const { ui, close } = await openDashboard(8, 30);
  try {
    frameText(ui);
    assert.equal(ui.lastFrame.rows.length, 8);
    for (const row of ui.lastFrame.rows) {
      assert.ok(visibleWidth(stripAnsi(row)) <= 30, row);
    }
  } finally {
    await close();
  }
});

test('a session started without a screen keeps the files pane', () => {
  const repo = makeRepo();
  try {
    const stdout = { isTTY: false, columns: 80, rows: 20, write: () => true };
    const ui = new Session({
      cwd: repo.dir,
      stdout,
      repo: createGitRepo(),
      color: false,
    });
    assert.equal(ui.pane, 'files');
    assert.equal(ui.dashboardHome, false);
  } finally {
    repo.cleanup();
  }
});

test('the dashboard pads below the header and above the footer', async () => {
  const { ui, close } = await openDashboard();
  try {
    assert.ok(await waitUntil(() => /first commit/.test(frameText(ui))));
    ui.draw();
    const rows = ui.lastFrame.rows.map((row) => stripAnsi(row));
    assert.equal(rows[1].trim(), '');
    assert.match(rows[2], /files/);
    const footer = rows.findIndex((row) =>
      /🢐esc {2}light.*files {2}diffs/.test(row),
    );
    assert.ok(footer > 2);
    assert.equal(rows[footer - 2].trim(), '');
  } finally {
    await close();
  }
});

test('block captions have no key prefix and a lighter header', async () => {
  const { ui, close } = await openDashboard();
  try {
    ui.color = true;
    ui.draw();
    const raw = ui.lastFrame.rows[2];
    const plain = stripAnsi(raw);
    assert.match(plain, /^ files/);
    assert.ok(!plain.includes('f files'));
    const head = ansi.THEME.dashHeadBg.join(';');
    assert.ok(raw.includes(`48;2;${head}m`));
  } finally {
    await close();
  }
});

test('table rows alternate a darker background on even lines', async () => {
  const { ui, close } = await openDashboard();
  try {
    ui.color = true;
    ui.draw();
    const colorOf = (row) => {
      const found = ui.lastFrame.rows[row].match(/48;2;(\d+;\d+;\d+)m/g);
      return new Set(found);
    };
    const odd = ansi.THEME.dashTileBg.join(';');
    const even = ansi.THEME.dashRowBg.join(';');
    assert.ok(colorOf(3).has(`48;2;${odd}m`));
    assert.ok(colorOf(4).has(`48;2;${even}m`));
    assert.ok(colorOf(5).has(`48;2;${odd}m`));
  } finally {
    await close();
  }
});

test('diff columns line up across rows', () => {
  const rows = [
    [cell('total'), cell('38', 'text', 'r'), cell('+0/3752', 'add', 'r')],
    [cell('lib/'), cell('3', 'text', 'r'), cell('+0/741', 'add', 'r')],
  ];
  const lines = tableLines(rows, 40).map((line) =>
    line.map((item) => item.text).join(''),
  );
  assert.equal(lines[0].indexOf('+0/3752') + 7, lines[1].indexOf('+0/741') + 6);
  assert.equal(lines[0].length, lines[1].length);
});

test('a flexible middle column takes the free width', () => {
  const rows = [
    [cell('a'), flexCell('long text here', 'text'), cell('1', 'text', 'r')],
    [cell('b'), flexCell('x', 'text'), cell('22', 'text', 'r')],
  ];
  const lines = tableLines(rows, 20).map((line) =>
    line.map((item) => item.text).join(''),
  );
  assert.equal(lines[0].length, 20);
  assert.equal(lines[1].length, 20);
  assert.ok(lines[0].endsWith(' 1'));
  assert.ok(lines[1].endsWith('22'));
});

test('the root folder is labeled with a slash', () => {
  assert.equal(labelOf('.', true), '/');
  assert.equal(labelOf('lib', true), 'lib');
  assert.equal(labelOf('.js', false), '*.js');
  assert.equal(labelOf('(none)', false), '(none)');
});

test('the files share bar stays on a narrow tile', () => {
  const model = {
    files: {
      ready: true,
      total: { files: 4, bytes: 80, lines: 12 },
      dirs: [{ key: 'lib', files: 2, bytes: 40, lines: 8 }],
      exts: [{ key: '.js', files: 4, bytes: 80, lines: 12 }],
      hot: { dirs: new Set(), exts: new Set() },
      delta: null,
    },
  };
  const tile = { key: 'f', title: 'files' };
  const block = filesBlock(model, 36, 8, { now: 1 }, tile);
  const text = (line) => line.map((part) => part.text).join('');
  const header = text(block.titleLine);
  const folder = text(block.lines[0]);
  const ext = text(block.lines[1]);
  assert.equal(header.startsWith('files'), true);
  assert.ok(folder.indexOf('lib') > 0);
  const end = (line, value) => {
    const at = line.lastIndexOf(value);
    return visibleWidth(line.slice(0, at + value.length));
  };
  assert.equal(end(header, 'size'), end(folder, '40'));
  assert.equal(end(header, 'lines'), end(folder, '8'));
  const sizeLabel = block.titleLine.find((part) => part.text === 'size');
  const linesLabel = block.titleLine.find((part) => part.text === 'lines');
  assert.equal(sizeLabel.tone, 'caption');
  assert.equal(linesLabel.tone, 'caption');
  const shareLabel = block.titleLine.find((part) => part.text === 'share');
  assert.equal(shareLabel.tone, 'caption');
  assert.equal(header.endsWith('share'), true);
  assert.equal(end(header, 'share'), visibleWidth(folder));
  assert.match(folder, /📁 lib/);
  assert.equal(folder.includes('📁  '), false);
  assert.equal(ext.indexOf('*.js'), folder.indexOf('lib'));
  assert.match(ext, /^js \*\.js/);
  const js = block.lines[1].find((part) => part.text === 'js');
  const chip = badgeColors('yellow');
  assert.deepEqual(js.bg, chip.bg);
  assert.deepEqual(js.fg, chip.fg);
  assert.equal(js.bold, true);
  const folderIcon = block.lines[0].find((part) => part.text === '📁');
  assert.equal(folderIcon.bg, null);
  assert.equal(folder.includes('📄'), false);
  assert.match(ext, /\*\.js/);
  assert.equal(ext.includes('📄'), false);
  assert.match(folder, /[█░]/);
  assert.equal(folder.length, 36);
});

test('diff columns keep one space after the mark and fill the row', () => {
  const group = (key) => ({
    key,
    added: 10,
    removed: 3,
    stagedAdded: 4,
    stagedRemoved: 1,
    staged: 1,
    remaining: 2,
    date: '2 days ago',
  });
  const model = {
    diffs: {
      files: 4,
      dirs: [group('lib')],
      exts: [group('.js')],
      totals: {
        added: 20,
        removed: 6,
        stagedAdded: 8,
        stagedRemoved: 2,
        staged: 2,
        remaining: 4,
      },
      activity: { minutes: [], live: false },
      delta: null,
    },
  };
  const tile = { key: 'd', title: 'diffs' };
  const block = diffsBlock(model, 40, 6, { now: 1, frame: 0 }, tile);
  const text = (line) => line.map((part) => part.text).join('');
  const lines = block.lines.map(text);
  const header = text(block.titleLine);
  const folder = lines.find((line) => line.includes('lib'));
  const ext = lines.find((line) => line.includes('*.js'));
  const end = (line, value) => {
    const at = line.lastIndexOf(value);
    return visibleWidth(line.slice(0, at + value.length));
  };
  assert.equal(header.startsWith('diffs'), true);
  assert.equal(header.includes('total'), false);
  assert.equal(end(header, '+8/20'), end(folder, '+4/10'));
  assert.equal(end(header, '-2/6'), end(folder, '-1/3'));
  assert.equal(end(header, '2/4'), end(folder, '1/2'));
  assert.equal(header.includes('3h ago'), false);
  assert.ok(folder.includes('2d ago'));
  model.diffs.delta = { added: 4, removed: 0, at: 1 };
  const live = diffsBlock(model, 40, 6, { now: 1, frame: 0 }, tile);
  const liveHeader = text(live.titleLine);
  assert.equal(liveHeader.includes('3h ago'), false);
  assert.ok(liveHeader.includes('▲+4'));
  const mark = live.titleLine.find((part) => part.text === '▲+4');
  assert.equal(mark.tone, 'add');
  assert.match(folder, /📁 lib/);
  assert.equal(folder.includes('📁  '), false);
  assert.match(ext, /^js \*\.js/);
  const jsLine = block.lines.find((line) =>
    line.some((part) => part.text === 'js'),
  );
  const jsIcon = jsLine.find((part) => part.text === 'js');
  assert.deepEqual(jsIcon.bg, badgeColors('yellow').bg);
  assert.equal(ext.indexOf('*.js'), folder.indexOf('lib'));
  assert.equal(visibleWidth(header), 40);
  assert.equal(visibleWidth(folder), 40);
  const trend = text(block.footer);
  assert.equal(trend.startsWith('activity '), true);
  assert.equal(trend.startsWith('activity  '), false);
  assert.equal(visibleWidth(trend), 41);
  assert.equal(block.footer[0].tone, 'sha');
  const trace = block.footer.find((part) => part.text === '─');
  assert.equal(trace.tone, 'sha');
});

test('diff activity scrolls minutes left and blinks the current one', () => {
  const minute = 60_000;
  const now = 3 * minute;
  const totals = {
    added: 1,
    removed: 0,
    stagedAdded: 0,
    stagedRemoved: 0,
    staged: 0,
    remaining: 1,
  };
  const model = {
    diffs: {
      files: 1,
      dirs: [],
      exts: [],
      totals,
      activity: {
        minutes: [
          { at: 1, level: 10, marks: ['commit'] },
          { at: 2, level: 20, marks: [] },
          { at: 3, level: 400, marks: ['fail', 'commit'] },
        ],
        live: true,
      },
      delta: null,
    },
  };
  const tile = { key: 'd', title: 'diffs' };
  const text = (line) => line.map((part) => part.text).join('');
  const block = diffsBlock(model, 40, 6, { now, frame: 0 }, tile);
  const footer = text(block.footer);
  assert.equal(footer.startsWith('activity '), true);
  assert.equal(footer.startsWith('activity  '), false);
  assert.equal(visibleWidth(footer), 41);
  for (const part of block.footer.slice(1)) {
    assert.equal(visibleWidth(part.text), 1);
  }
  assert.ok(footer.indexOf('◉') < footer.indexOf('+'));
  assert.equal(footer.endsWith(' '), true);
  assert.equal(block.footer.at(-2).text, '∙');
  assert.equal(block.footer[1].text, ' ');
  assert.equal(block.footer.at(-1).text, ' ');
  const toneOf = (glyph) =>
    block.footer.find((part) => part.text === glyph).tone;
  assert.equal(toneOf('◉'), 'key');
  assert.equal(toneOf('+'), 'add');
  assert.equal(block.footer[0].tone, 'sha');
  for (const part of block.footer) {
    assert.equal(part.bg, null);
  }
  const flash = diffsBlock(model, 40, 6, { now, frame: 1 }, tile);
  assert.equal(flash.footer.at(-2).text, '●');
  assert.equal(flash.footer.at(-2).tone, 'key');
  const painted = paintTile(tile, flash, 42, 6, true);
  const row = painted.at(-1);
  const plain = stripAnsi(row);
  assert.equal(visibleWidth(plain), 42);
  assert.equal(plain.endsWith('● '), true);
  assert.equal(plain.endsWith('●  '), false);
  model.diffs.activity.live = false;
  const done = diffsBlock(model, 40, 6, { now, frame: 0 }, tile);
  assert.equal(done.footer.at(-2).text, '⨯');
});

test('diff activity keeps a foreground-only timeline with edge gaps', () => {
  const minute = 60_000;
  const now = 5 * minute;
  const totals = {
    added: 1,
    removed: 0,
    stagedAdded: 0,
    stagedRemoved: 0,
    staged: 0,
    remaining: 1,
  };
  const model = {
    diffs: {
      files: 1,
      dirs: [],
      exts: [],
      totals,
      activity: {
        minutes: [
          { at: 2, level: 4, marks: ['commit'] },
          { at: 4, level: 0, marks: ['pass'] },
        ],
        live: false,
      },
      delta: null,
    },
  };
  const tile = { key: 'd', title: 'diffs' };
  const block = diffsBlock(model, 40, 6, { now, frame: 0 }, tile);
  const timeline = block.footer
    .slice(1)
    .map((part) => part.text)
    .join('');
  assert.equal(timeline[0], ' ');
  assert.equal(timeline.at(-1), ' ');
  assert.ok(timeline.includes('◉'));
  assert.ok(timeline.includes('*'));
  assert.ok(timeline.includes('─'));
  const toneOf = (glyph) =>
    block.footer.find((part) => part.text === glyph).tone;
  assert.equal(toneOf('◉'), 'key');
  assert.equal(toneOf('*'), 'add');
  assert.equal(toneOf('─'), 'sha');
  for (const part of block.footer) {
    assert.equal(part.bg, null);
  }
});

test('diff activity marks removals and pulses the current minute', () => {
  const minute = 60_000;
  const now = 3 * minute;
  const totals = {
    added: 1,
    removed: 4,
    stagedAdded: 0,
    stagedRemoved: 0,
    staged: 0,
    remaining: 1,
  };
  const model = {
    diffs: {
      files: 1,
      dirs: [],
      exts: [],
      totals,
      activity: {
        minutes: [
          { at: 1, level: 0, added: 0, removed: 0, marks: ['abort'] },
          { at: 2, level: 5, added: 1, removed: 4, marks: [] },
          { at: 3, level: 3, added: 3, removed: 0, marks: ['fail'] },
        ],
        live: true,
      },
      delta: null,
    },
  };
  const tile = { key: 'd', title: 'diffs' };
  const text = (line) => line.map((part) => part.text).join('');
  const quiet = diffsBlock(model, 40, 6, { now, frame: 0 }, tile);
  const footer = text(quiet.footer);
  assert.ok(footer.includes('!'));
  assert.ok(footer.indexOf('!') < footer.indexOf('-'));
  const toneOf = (glyph) =>
    quiet.footer.find((part) => part.text === glyph).tone;
  assert.equal(toneOf('!'), 'error');
  assert.equal(toneOf('-'), 'del');
  assert.equal(quiet.footer.at(-2).text, '∙');
  assert.equal(quiet.footer.at(-1).text, ' ');
  const low = diffsBlock(model, 40, 6, { now, frame: 1 }, tile);
  assert.equal(low.footer.at(-2).text, '◦');
  model.diffs.activity.minutes[2].level = 90;
  const high = diffsBlock(model, 40, 6, { now, frame: 1 }, tile);
  assert.equal(high.footer.at(-2).text, '•');
  model.diffs.activity.minutes[2].level = 400;
  const top = diffsBlock(model, 40, 6, { now, frame: 1 }, tile);
  assert.equal(top.footer.at(-2).text, '●');
});

test('diff rows keep removals when the tile is narrow', () => {
  const group = (key) => ({
    key,
    added: 34,
    removed: 8,
    stagedAdded: 12,
    stagedRemoved: 3,
    staged: 12,
    remaining: 40,
    date: '5 minutes ago',
  });
  const model = {
    diffs: {
      files: 12,
      dirs: [group('lib')],
      exts: [group('.js')],
      totals: {
        added: 34,
        removed: 8,
        stagedAdded: 12,
        stagedRemoved: 3,
        staged: 12,
        remaining: 40,
      },
      activity: { minutes: [], live: false },
      delta: null,
    },
  };
  const tile = { key: 'd', title: 'diffs' };
  const block = diffsBlock(model, 32, 6, { now: 1, frame: 0 }, tile);
  const text = (line) => line.map((part) => part.text).join('');
  const header = text(block.titleLine);
  const folder = block.lines.map(text).find((line) => line.includes('lib'));
  assert.ok(header.includes('+12/34'));
  assert.ok(header.includes('-3/8'));
  assert.ok(folder.includes('-3/8'));
  assert.ok(folder.includes('12/40'));
});

test('file names stay whole when the tile is narrow', () => {
  const model = {
    files: {
      ready: true,
      total: { files: 2, bytes: 40, lines: 8 },
      dirs: [{ key: 'node_modules', files: 2, bytes: 40, lines: 8 }],
      exts: [{ key: '.js', files: 2, bytes: 40, lines: 8 }],
      hot: { dirs: new Set(), exts: new Set() },
      delta: null,
    },
  };
  const tile = { key: 'f', title: 'files' };
  const block = filesBlock(model, 22, 6, { now: 1 }, tile);
  const text = (line) => line.map((part) => part.text).join('');
  const folder = text(block.lines[0]);
  const ext = text(block.lines[1]);
  assert.ok(folder.includes('node_modules'));
  assert.equal(ext.indexOf('*.js'), folder.indexOf('node_modules'));
});

test('groups list folders before extensions', () => {
  const folders = ['a', 'b', 'c'];
  const exts = ['js', 'md'];
  const picked = pickGroups(folders, exts, 2);
  assert.deepEqual(picked.dirs, ['a', 'b']);
  assert.deepEqual(picked.exts, []);
  const rest = pickGroups(folders, exts, 4);
  assert.deepEqual(rest.dirs, folders);
  assert.deepEqual(rest.exts, ['js']);
});

test('the branches header shows the local count', () => {
  const tile = { key: 'b', title: 'branches' };
  const entry = (name, current) => ({
    name,
    current,
    at: 1,
    subject: name,
    ahead: 0,
    behind: 0,
    upstream: '',
    gone: false,
  });
  const model = {
    branches: {
      ready: true,
      list: [entry('main', true), entry('next', false)],
      rebase: null,
      switches: [],
      hot: new Map(),
    },
  };
  const ctx = { now: 10, frame: 0 };
  const block = branchesBlock(model, 32, 6, ctx, tile);
  const header = block.titleLine.map((part) => part.text).join('');
  assert.equal(header.startsWith('branches'), true);
  assert.equal(header.endsWith('2'), true);
  const count = block.titleLine.find((part) => part.text === '2');
  assert.equal(count.tone, 'key');
  assert.equal(count.bold, true);
});

test('the npm tile lists packages under the header counts', () => {
  const tile = { key: 'n', title: 'npm' };
  const model = {
    npm: {
      ready: true,
      hasManifest: true,
      deps: 1,
      dev: 0,
      modules: {
        bytes: 20,
        count: 2,
        packages: [
          { name: 'big', bytes: 14 },
          { name: 'small', bytes: 6, dev: true },
        ],
      },
      audit: 0,
      outdated: 0,
      running: '',
    },
  };
  const block = npmBlock(model, 36, 8, { now: 1, frame: 0 }, tile);
  const text = (line) => line.map((part) => part.text).join('');
  const header = text(block.titleLine);
  const body = block.lines.map(text).join('\n');
  assert.equal(header.startsWith('npm'), true);
  assert.match(header, /deps:1 dev:0 all:2\/20/);
  const summary = block.titleLine.find((part) => part.text.startsWith('deps:'));
  assert.equal(summary.tone, 'caption');
  assert.equal(header.includes('🚨'), false);
  assert.equal(header.includes('⚠️'), false);
  assert.equal(body.includes('deps'), false);
  assert.ok(body.indexOf('big') < body.indexOf('small'));
  assert.match(body, /14/);
  assert.match(body, /6/);
  const tone = (value) => {
    for (const line of block.lines) {
      const part = line.find((item) => item.text === value);
      if (part) return part.tone;
    }
    return '';
  };
  assert.equal(tone('name'), 'muted');
  assert.equal(tone('size'), 'muted');
  assert.equal(tone('big'), 'dep');
  assert.equal(tone('small'), 'dev');
});

test('the npm screen lists every package the tile cuts off', () => {
  const packages = [];
  for (let i = 0; i < 12; i++) {
    packages.push({
      name: `pkg${i}`,
      bytes: i + 1,
      dev: false,
      current: '1.0.0',
      wanted: '1.0.0',
      latest: '1.0.0',
    });
  }
  const data = {
    ready: true,
    hasManifest: true,
    deps: 12,
    dev: 0,
    modules: { bytes: 78, count: 12, packages },
    audit: 0,
    outdated: 0,
    running: '',
  };
  const tile = { key: 'n', title: 'npm' };
  const ctx = { frame: 0 };
  const block = npmBlock({ npm: data }, 48, 6, ctx, tile);
  const full = npmContent(data, 48, null, ctx, tile);
  const text = (line) => line.map((part) => part.text).join('');
  const short = block.lines.map(text).join('\n');
  const complete = full.lines.map(text).join('\n');
  assert.ok(short.includes('pkg0'));
  assert.equal(short.includes('pkg11'), false);
  assert.ok(complete.includes('pkg11'));
  assert.ok(text(block.lines[0]).includes('current'));
  assert.ok(text(full.lines[0]).includes('current'));
  const view = {
    packages: data,
    packagesCursor: full.lines.length,
    listScroll: 0,
    progressFrame: 0,
  };
  const painted = paintBodyPackages(view, 48, false, 8, 1);
  const body = painted.body.join('\n');
  assert.match(painted.body[1], /^ {2}\S.* {2}$/);
  assert.ok(painted.body[1].includes('current'));
  assert.equal(painted.body[2].trim(), '');
  assert.match(painted.body[3], /^ {2}pkg/);
  const first = Number(painted.body[3].match(/pkg(\d+)/)[1]);
  const hit = painted.fileHits.find((spot) => spot.cursor === first);
  assert.equal(hit.y, 1 + 3 + 1);
  assert.equal(body.includes('▶'), false);
  assert.ok(body.includes('pkg11'));
  assert.equal(body.includes('deps:'), false);
});

test('the npm tile shows current, wanted, and latest', () => {
  const tile = { key: 'n', title: 'npm' };
  const model = {
    npm: {
      ready: true,
      hasManifest: true,
      deps: 3,
      dev: 0,
      modules: {
        bytes: 24,
        count: 3,
        packages: [
          {
            name: 'big',
            bytes: 14,
            current: '1.0.0',
            wanted: '1.2.0',
            latest: '2.0.0',
          },
          {
            name: 'next',
            bytes: 4,
            current: '4.0.0',
            wanted: '4.0.0',
            latest: '5.0.0',
          },
          {
            name: 'small',
            bytes: 6,
            current: '3.1.0',
            wanted: '3.1.0',
            latest: '3.1.0',
            audit: true,
          },
        ],
      },
      audit: 1,
      outdated: 2,
      running: '',
    },
  };
  const block = npmBlock(model, 64, 10, { now: 1, frame: 0 }, tile);
  const text = (line) => line.map((part) => part.text).join('');
  const body = block.lines.map(text);
  const header = text(block.titleLine);
  assert.match(header, /deps:3 dev:0 all:3\/24 🚨 1 ⚠️ 2/);
  assert.equal(body.join('\n').includes('deps'), false);
  const labels = body.find((line) => line.includes('current'));
  const heading = block.lines.find((line) =>
    line.some((part) => part.text === 'current'),
  );
  const behind = block.lines.find((line) =>
    line.some((part) => part.text === 'big'),
  );
  const ready = block.lines.find((line) =>
    line.some((part) => part.text === 'small'),
  );
  const ahead = block.lines.find((line) =>
    line.some((part) => part.text === 'next'),
  );
  const tone = (line, value) => {
    const part = line.find((item) => item.text === value);
    return part ? part.tone : '';
  };
  assert.ok(labels.startsWith('name'));
  assert.equal(tone(heading, 'name'), 'muted');
  assert.ok(labels.includes('current'));
  assert.ok(labels.includes('wanted'));
  assert.ok(labels.includes('latest'));
  assert.ok(labels.includes('size'));
  assert.equal(tone(heading, 'current'), 'muted');
  assert.equal(tone(heading, 'size'), 'muted');
  assert.equal(tone(behind, 'big'), 'dep');
  assert.equal(tone(behind, '1.0.0'), 'warn');
  assert.equal(tone(behind, '1.2.0'), 'add');
  assert.equal(tone(behind, '2.0.0'), 'add');
  assert.equal(tone(ready, '3.1.0'), 'error');
  assert.equal(tone(ahead, '5.0.0'), 'add');
  assert.equal(tone(ahead, '4.0.0'), 'warn');
  assert.equal(body.join('\n').includes('⚠️'), false);
  assert.equal(body.join('\n').includes('🛑'), false);
  const screen = npmContent(model.npm, 96, null, { now: 1, frame: 0 }, tile);
  const screenTone = (name, value) => {
    const line = screen.lines.find((row) =>
      row.some((part) => part.text === name),
    );
    const part = line.find((item) => item.text === value);
    return part ? part.tone : '';
  };
  assert.equal(screenTone('big', '⚠️ outdated'), 'warn');
  assert.equal(screenTone('small', '🛑 vulnerability detected'), 'error');
  assert.equal(screenTone('next', '⚠️ outdated'), 'warn');
  const narrow = npmBlock(model, 52, 10, { now: 1, frame: 0 }, tile);
  const narrowText = narrow.lines.map(text).join('\n');
  assert.match(narrowText, /big/);
  assert.match(narrowText, /2\.0\.0/);
  assert.match(narrowText, /5\.0\.0/);
});
