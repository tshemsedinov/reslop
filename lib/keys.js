'use strict';

const ACTIONS = [
  { id: 'add', keys: ['a'], label: 'Add' },
  { id: 'unstage', keys: ['u'], label: 'Unstage' },
  { id: 'revert', keys: ['r'], label: 'Revert' },
  { id: 'skip', keys: ['s'], label: 'Skip' },
  { id: 'prev', keys: ['left', 'p'], hot: '←', label: 'Prev' },
  { id: 'next', keys: ['right', 'n'], hot: '→', label: 'Next' },
  { id: 'layout', keys: ['m'], label: 'Mode' },
  { id: 'files', keys: ['l'], label: 'Files' },
  { id: 'feedback', keys: ['f'], label: 'Feedback' },
  { id: 'todo', keys: ['t'], label: 'Todo' },
  { id: 'quit', keys: ['q', 'ctrl-c'], label: 'Quit' },
];

const FILES_DISABLED = ['skip', 'layout', 'feedback'];

const SCROLL = {
  up: 'scrollUp',
  k: 'scrollUp',
  down: 'scrollDown',
  j: 'scrollDown',
  h: 'help',
  '?': 'help',
  enter: 'open',
  backspace: 'removeTodo',
  delete: 'removeTodo',
};

const KEY_TO_ACTION = Object.create(null);

for (const action of ACTIONS) {
  for (const key of action.keys) KEY_TO_ACTION[key] = action.id;
}

for (const [key, id] of Object.entries(SCROLL)) KEY_TO_ACTION[key] = id;

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

const mouseKind = (event) => {
  if (event.kind) return event.kind;
  return mouseKindFromButton(event.button, event.press);
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

const LITERAL_KEY = {
  '\x7f': 'backspace',
  '\x08': 'backspace',
  '\t': 'tab',
  '\x03': 'ctrl-c',
  '\r': 'enter',
  '\n': 'enter',
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

const actionFromKey = (key) => KEY_TO_ACTION[key] ?? null;

const actionHot = (action) => action.hot ?? action.keys[0];

const actionLetter = (action) => {
  if (action.hot) return action.hot;
  const label = (action.label ?? '').toLowerCase();
  for (const key of action.keys) {
    if (key.length !== 1) continue;
    if (label.includes(key)) return key;
  }
  return actionHot(action);
};

const buttonWord = (action) => {
  const word = (action.label ?? '').toLowerCase();
  const mark = actionLetter(action);
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
  FILES_DISABLED,
  KEY_TO_ACTION,
  decodeChunk,
  actionFromKey,
  actionHot,
  actionLetter,
  buttonWord,
  hitAction,
  mouseKind,
};
