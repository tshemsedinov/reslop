'use strict';

const ACTIONS = {
  add: ['a'],
  unstage: ['u'],
  revert: ['d'],
  commit: ['c'],
  prev: ['left', 'p', 'k'],
  next: ['right', 'n', 'j'],
  layout: ['m'],
  feedback: ['f'],
  todo: ['t'],
  code: ['e'],
  reload: ['r'],
  branch: ['b'],
  pull: ['p'],
  push: ['s'],
  quit: ['q', 'ctrl-c'],
};
const ACTION_IDS = Object.keys(ACTIONS);

const BRANCH_ACTIONS = {
  newBranch: ['n'],
};

const ACTION_HOT = {
  prev: '←',
  next: '→',
};

const ACTION_LABEL = {
  revert: 'drop',
  layout: 'mode',
  code: 'edit',
  newBranch: 'new',
  quit: 'q',
};

const DIFF_DISABLED = ['reload', 'branch', 'pull', 'push'];
const FILES_DISABLED = ['layout', 'feedback', 'code'];
const TODO_DISABLED = [
  'add',
  'unstage',
  'revert',
  'layout',
  'feedback',
  'code',
  'reload',
  'branch',
  'pull',
  'push',
];
const BRANCHES_DISABLED = [
  'add',
  'unstage',
  'revert',
  'commit',
  'layout',
  'feedback',
  'todo',
  'code',
  'reload',
  'branch',
  'pull',
  'push',
];

const disabledActions = (pane, item) => {
  if (pane === 'files') return FILES_DISABLED;
  if (pane === 'branches') return BRANCHES_DISABLED;
  if (item && item.origin === 'todo') return TODO_DISABLED;
  return DIFF_DISABLED;
};

const SCROLL = {
  up: 'scrollUp',
  down: 'scrollDown',
  'ctrl-y': 'scrollUp',
  'ctrl-e': 'scrollDown',
  'ctrl-b': 'pageUp',
  'ctrl-f': 'pageDown',
  'ctrl-u': 'halfUp',
  'ctrl-d': 'halfDown',
  enter: 'open',
  backspace: 'removeTodo',
  delete: 'removeTodo',
};

const KEY_TO_ACTION = {};
const PANE_ONLY = ['branch', 'pull', 'push'];
const FILES_KEYS = {};
for (const id of PANE_ONLY) {
  for (const key of ACTIONS[id]) FILES_KEYS[key] = id;
}
const BRANCH_KEYS = {};
for (const id of Object.keys(BRANCH_ACTIONS)) {
  for (const key of BRANCH_ACTIONS[id]) BRANCH_KEYS[key] = id;
}
const PANE_KEYS = { files: FILES_KEYS, branches: BRANCH_KEYS };

for (const id of ACTION_IDS) {
  if (PANE_ONLY.includes(id)) continue;
  for (const key of ACTIONS[id]) KEY_TO_ACTION[key] = id;
}

for (const key of Object.keys(SCROLL)) KEY_TO_ACTION[key] = SCROLL[key];

const CSI_KEYS = {
  A: 'up',
  B: 'down',
  C: 'right',
  D: 'left',
  H: 'home',
  F: 'end',
};

const CSI_TILDE = {
  1: 'home',
  3: 'delete',
  4: 'end',
};

const LITERAL_KEY = {
  '\x7f': 'backspace',
  '\x08': 'backspace',
  '\t': 'tab',
  '\x03': 'ctrl-c',
  '\r': 'enter',
  '\n': 'enter',
};

const MOUSE_WHEEL = {
  64: 'wheelUp',
  65: 'wheelDown',
};

const mouseKindFromButton = (button, press) => {
  const wheel = MOUSE_WHEEL[button];
  if (wheel) return wheel;
  if (!press) return 'release';
  if (button & 32) return 'drag';
  return 'press';
};

const parseMouse = (body, flag) => {
  const parts = body.split(';');
  if (parts.length < 3) return null;
  const button = parseInt(parts[0], 10);
  const x = parseInt(parts[1], 10);
  const y = parseInt(parts[2], 10);
  if (!Number.isFinite(button) || !Number.isFinite(x) || !Number.isFinite(y)) {
    return null;
  }
  const press = flag === 'M';
  const kind = mouseKindFromButton(button, press);
  return { type: 'mouse', button, x, y, press, kind, btn: button & 3 };
};

const parseEsc = (text, start) => {
  const rest = text.slice(start);
  if (rest === '\x1b') return { needMore: true };
  if (rest.startsWith('\x1b[') && rest.length === 2) return { needMore: true };
  if (rest.startsWith('\x1b[<')) {
    const endM = rest.search(/[Mm]/);
    if (endM < 0) return { needMore: true };
    const kind = rest[endM];
    const body = rest.slice(3, endM);
    const mouse = parseMouse(body, kind);
    if (!mouse) {
      return { event: { type: 'key', key: 'escape' }, end: start + endM + 1 };
    }
    return { event: mouse, end: start + endM + 1 };
  }
  if (rest.startsWith('\x1b[')) {
    const code = rest[2];
    if (code === undefined) return { needMore: true };
    if (code >= '0' && code <= '9') {
      const tilde = rest.indexOf('~');
      if (tilde < 0) {
        if (rest.length > 8) {
          return { event: { type: 'key', key: 'escape' }, end: start + 1 };
        }
        return { needMore: true };
      }
      const num = rest.slice(2, tilde);
      const named = CSI_TILDE[num];
      if (named) {
        return { event: { type: 'key', key: named }, end: start + tilde + 1 };
      }
      return { event: { type: 'key', key: 'escape' }, end: start + 1 };
    }
    const key = CSI_KEYS[code];
    if (key) return { event: { type: 'key', key }, end: start + 3 };
    return { event: { type: 'key', key: 'escape' }, end: start + 1 };
  }
  return { event: { type: 'key', key: 'escape' }, end: start + 1 };
};

const decodeChunk = (text, carry = '') => {
  const source = carry + text;
  const events = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '\x1b') {
      const parsed = parseEsc(source, i);
      if (parsed.needMore) return { events, carry: source.slice(i) };
      events.push(parsed.event);
      i = parsed.end;
      continue;
    }
    const named = LITERAL_KEY[ch];
    if (named) {
      events.push({ type: 'key', key: named });
      i += 1;
      continue;
    }
    const code = source.charCodeAt(i);
    if (code >= 1 && code <= 26) {
      const letter = String.fromCharCode(96 + code);
      events.push({ type: 'key', key: `ctrl-${letter}` });
      i += 1;
      continue;
    }
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < source.length) {
      events.push({ type: 'key', key: source.slice(i, i + 2) });
      i += 2;
      continue;
    }
    events.push({ type: 'key', key: ch });
    i += 1;
  }
  return { events, carry: '' };
};

const actionFromKey = (key, pane) => {
  const paneKeys = PANE_KEYS[pane];
  if (paneKeys && paneKeys[key]) return paneKeys[key];
  return KEY_TO_ACTION[key] ?? null;
};

const actionKeys = (id) => ACTIONS[id] ?? BRANCH_ACTIONS[id] ?? [];

const actionHot = (id) => ACTION_HOT[id] ?? actionKeys(id)[0];

const actionLabel = (id) => ACTION_HOT[id] ?? ACTION_LABEL[id] ?? id;

const actionLetter = actionHot;

const buttonWord = (id) => {
  const word = actionLabel(id);
  const mark = actionLetter(id);
  if (word.includes(mark)) return word;
  return `${mark}${word}`;
};

const hitAction = (hits, x) => {
  for (const hit of hits) {
    if (x >= hit.x0 && x < hit.x1) return hit.id;
  }
  return null;
};

module.exports = {
  ACTIONS,
  ACTION_IDS,
  BRANCH_ACTIONS,
  DIFF_DISABLED,
  FILES_DISABLED,
  TODO_DISABLED,
  BRANCHES_DISABLED,
  disabledActions,
  decodeChunk,
  actionFromKey,
  actionHot,
  actionLetter,
  buttonWord,
  hitAction,
};
