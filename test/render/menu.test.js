'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { contextMenu } = require('../../lib/render/menu.js');
const ansi = require('../../lib/term/ansi.js');
const { THEME, bg, fg, paint, stripAnsi, visibleWidth, setTheme } = ansi;

const luminance = (rgb) =>
  rgb.reduce((sum, channel, index) => {
    const value = channel / 255;
    const linear =
      value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    return sum + linear * [0.2126, 0.7152, 0.0722][index];
  }, 0);

const contrast = (left, right) => {
  const a = luminance(left);
  const b = luminance(right);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
};

test('context menu uses a contrasting background without a border', () => {
  try {
    for (const theme of ['dark', 'light']) {
      setTheme(theme);
      const menu = contextMenu(
        {
          x: 79,
          y: 23,
          cursor: 0,
          actions: ['taskImport', 'drop'],
          disabled: ['drop'],
        },
        80,
        24,
        true,
      );
      assert.notDeepEqual(THEME.popupBg, THEME.ctxBg);
      assert.notDeepEqual(THEME.popupBg, THEME.noteBg);
      assert.ok(contrast(THEME.popupDisabledFg, THEME.popupBg) < 3);
      assert.equal(menu.lines.length, menu.hits.length);
      assert.equal(menu.lines.length, 2);
      const disabled = menu.lines[1].text;
      assert.ok(disabled.includes(bg(THEME.popupBg)));
      assert.ok(disabled.includes(fg(THEME.popupDisabledFg)));
      assert.equal(disabled.includes(fg(THEME.buttonHotFg)), false);
      assert.equal(menu.hits[1].disabled, true);
      for (const line of menu.lines) {
        assert.doesNotMatch(stripAnsi(line.text), /[┌┐└┘│─]/);
        assert.ok(menu.x + visibleWidth(line.text) <= 80);
        assert.ok(line.y < 23);
      }
    }
  } finally {
    setTheme('dark');
  }
});

test('regular popups use inline shortcut labels like the hint panel', () => {
  const menu = contextMenu(
    {
      x: 0,
      y: 2,
      actions: [
        'taskImport',
        'drop',
        'open',
        'taskDone',
        'newBranch',
        'worktreeBranch',
        'code',
      ],
    },
    80,
    24,
    false,
  );
  assert.deepEqual(
    menu.lines.map((line) => line.text.trim()),
    ['^import', 'delete', 'enter open', '^done', 'insert', 'worktree', 'edit'],
  );
  const colored = contextMenu({ actions: ['rebase'] }, 80, 24, true);
  const hot = paint('e', THEME.buttonHotFg, THEME.popupHotBg, true, true);
  assert.ok(colored.lines[0].text.includes(hot));
});

test('editor popups align shortcut and caption columns', () => {
  const menu = contextMenu(
    {
      x: 0,
      y: 2,
      editor: true,
      actions: [
        'textCut',
        'textCopy',
        'textPaste',
        'textDelete',
        'textSelectAll',
      ],
    },
    80,
    24,
    false,
  );
  assert.deepEqual(
    menu.lines.map((line) => line.text.trim()),
    [
      'ctrl+x  cut',
      'ctrl+c  copy',
      'ctrl+v  paste',
      'del     delete',
      'ctrl+a  select all',
    ],
  );
});

test('short context menus scroll the focused operation into view', () => {
  const model = {
    x: 19,
    y: 5,
    cursor: 4,
    editor: true,
    actions: [
      'textCut',
      'textCopy',
      'textPaste',
      'textDelete',
      'textSelectAll',
    ],
  };
  const menu = contextMenu(model, 20, 6, false);
  assert.equal(menu.hits.length, 3);
  assert.equal(menu.hits.at(-1).id, 'textSelectAll');
  assert.equal(menu.hits.at(-1).cursor, 4);
  assert.ok(menu.lines.every((line) => line.y > 1 && line.y < 5));
  assert.ok(menu.lines.every((line) => visibleWidth(line.text) <= 20));
});
