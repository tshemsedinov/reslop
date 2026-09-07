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
  { id: 'quit', keys: ['q', 'escape', 'ctrl-c'], label: 'Quit' },
];

const SCROLL = {
  up: 'scrollUp',
  k: 'scrollUp',
  down: 'scrollDown',
  j: 'scrollDown',
  h: 'help',
  '?': 'help',
  enter: 'open',
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
};

const MOUSE_WHEEL = Object.assign(Object.create(null), {
  64: 'wheelUp',
  65: 'wheelDown',
});

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
  const button = Number(parts[0]);
  const x = Number(parts[1]);
  const y = Number(parts[2]);
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
    if (ch === '\x03') {
      events.push({ type: 'key', key: 'ctrl-c' });
      i += 1;
      continue;
    }
    if (ch === '\r' || ch === '\n') {
      events.push({ type: 'key', key: 'enter' });
      i += 1;
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
  KEY_TO_ACTION,
  decodeChunk,
  actionFromKey,
  actionHot,
  actionLetter,
  buttonWord,
  hitAction,
  mouseKind,
};
