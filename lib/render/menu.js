'use strict';

const { clamp } = require('../common/utilities.js');
const { matchesIn } = require('../common/find.js');
const { THEME, paint, visibleWidth, trimVisible } = require('../term/ansi.js');
const { listWindowStart, scrollMark, padTrim } = require('./primitives.js');
const actionsPart = require('../input/actions.js');
const { actionLetter, actionCaption, buttonWord } = actionsPart;

const menuBoxWidth = (options, columnW, room) => {
  let widest = Math.max(columnW, 4);
  for (const label of options) {
    widest = Math.max(widest, visibleWidth(`${label ?? ''}`));
  }
  return clamp(widest + 2, 4, room);
};

const paintQuery = (text, query, fgRgb, bgRgb, color, bold) => {
  if (!color) return paint(text, fgRgb, bgRgb, color, bold);
  let out = '';
  let from = 0;
  for (const { start, end } of matchesIn(text, `${query ?? ''}`.trim())) {
    out += paint(text.slice(from, start), fgRgb, bgRgb, color, bold);
    out += paint(text.slice(start, end), THEME.warnFg, bgRgb, color, true);
    from = end;
  }
  return out + paint(text.slice(from), fgRgb, bgRgb, color, bold);
};

const menuItem = (label, boxW, color, selected, mark, disabled, query) => {
  const barW = mark ? 1 : 0;
  const faceW = Math.max(1, boxW - barW);
  const room = Math.max(0, faceW - 1);
  const face = ` ${padTrim(label, room)}`;
  if (!color) return `${face}${' '.repeat(barW)}`;
  const hot = selected && !disabled;
  const fgRgb = disabled ? THEME.mutedFg : THEME.chromeFg;
  const hotFg = hot ? THEME.buttonHotFg : fgRgb;
  const bgRgb = hot ? THEME.checkBg : THEME.noteBg;
  let row = paintQuery(face, query, hotFg, bgRgb, color, hot);
  if (!mark) return row;
  const barBg = mark === 'thumb' ? THEME.taskHeadBg : THEME.buttonBg;
  row += paint(' ', fgRgb, barBg, color);
  return row;
};

const dropBox = (options, cursor, scroll, room) => {
  const count = options.length;
  const focus = count ? clamp(cursor ?? 0, 0, count - 1) : 0;
  const inner = Math.max(1, Math.min(count || 1, room, 8));
  const start = listWindowStart(focus, scroll, inner, count);
  return { focus, inner, span: inner, start, count };
};

const menuFaces = (options, box, boxW, color, query = '', off = new Set()) => {
  const faces = [];
  for (let i = 0; i < box.inner; i++) {
    const index = box.start + i;
    const label = options[index];
    const mark = scrollMark(i, box.count, box.inner, box.start);
    const empty = label === undefined;
    const shown = empty ? 'none' : label;
    const focused = !empty && index === box.focus;
    const disabled = !empty && off.has(label);
    const typed = empty ? '' : query;
    const face = menuItem(shown, boxW, color, focused, mark, disabled, typed);
    faces.push({ index, face });
  }
  return faces;
};

// A menu can name its own keys and captions, else the action's are used
const letterOf = (model, id) => model?.keys?.[id] ?? actionLetter(id);

const captionOf = (model, id) => model?.captions?.[id] ?? actionCaption(id);

// An inline menu marks the key inside its caption, `where` with its `w`
const contextText = (id, keyWidth, model) => {
  if (model?.inline) return captionOf(model, id);
  if (!keyWidth) return buttonWord(id);
  const mark = letterOf(model, id) ?? '';
  const caption = captionOf(model, id);
  const key = mark.padEnd(keyWidth);
  return `${key}  ${caption}`;
};

const contextLabel = (id, width, color, look, keyWidth, model) => {
  const { selected, disabled } = look;
  const label = contextText(id, keyWidth, model);
  const mark = letterOf(model, id) ?? '';
  const shown = trimVisible(label, Math.max(1, width - 2));
  const pad = ' '.repeat(Math.max(0, width - 2 - visibleWidth(shown)));
  const face = ` ${shown}${pad} `;
  if (!color || !mark) return face;
  const bgRgb = selected && !disabled ? THEME.popupHotBg : THEME.popupBg;
  const fgRgb = disabled ? THEME.popupDisabledFg : THEME.popupFg;
  if (disabled) return paint(face, fgRgb, bgRgb, color);
  const at = shown.indexOf(mark);
  if (at < 0) return paint(face, fgRgb, bgRgb, color);
  let out = paint(face.slice(0, at + 1), fgRgb, bgRgb, color);
  out += paint(mark, THEME.buttonHotFg, bgRgb, color, true);
  return out + paint(face.slice(at + mark.length + 1), fgRgb, bgRgb, color);
};

// The menu of a text field shows the keys of its actions in a column
const keyColumn = (actions, model) => {
  const marks = actions.map((id) => visibleWidth(letterOf(model, id) ?? ''));
  return Math.max(...marks);
};

const contextMenu = (model, width, height, color) => {
  const actions = model?.actions ?? [];
  if (!actions.length) return null;
  const keyed = (model.editor || model.keyed) && !model.inline;
  const keyWidth = keyed ? keyColumn(actions, model) : 0;
  const labels = actions.map((id) =>
    visibleWidth(contextText(id, keyWidth, model)),
  );
  const boxW = Math.min(width, Math.max(4, ...labels) + 2);
  const count = actions.length;
  const inner = Math.min(count, Math.max(1, height - 3));
  const x = clamp(model.x ?? 0, 0, Math.max(0, width - boxW));
  const anchorY = clamp(model.y ?? 2, 2, Math.max(2, height - 1));
  const y = Math.min(anchorY, Math.max(2, height - inner - 1));
  const cursor = clamp(model.cursor ?? 0, 0, count - 1);
  const start = listWindowStart(cursor, 0, inner, count);
  const off = model.disabled ?? [];
  const lines = [];
  const hits = [];
  for (let row = 0; row < inner; row++) {
    const index = start + row;
    const id = actions[index];
    const selected = index === cursor;
    const disabled = off.includes(id);
    const look = { selected, disabled };
    const text = contextLabel(id, boxW, color, look, keyWidth, model);
    lines.push({ y: y + row, text });
    hits.push({ id, cursor: index, disabled, y: y + row, x0: x, x1: x + boxW });
  }
  return { x, lines, hits };
};

module.exports = { menuBoxWidth, dropBox, menuFaces, contextMenu, letterOf };
