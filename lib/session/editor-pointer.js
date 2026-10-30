'use strict';

const { indexAtRow } = require('../term/wrap.js');

const MULTI_CLICK_MS = 500;

const TEXT_ACTIONS = [
  'textCut',
  'textCopy',
  'textPaste',
  'textDelete',
  'textSelectAll',
];

const TEXT_KEYS = {
  textCut: 'ctrl-x',
  textCopy: 'ctrl-c',
  textPaste: 'ctrl-v',
  textDelete: 'delete',
};

const hitAt = (hits, cell) =>
  hits.find((hit) => {
    if (hit.y !== cell.y) return false;
    const x0 = hit.x0 ?? hit.textX;
    return cell.x >= x0 && (hit.x1 === undefined || cell.x < hit.x1);
  });

const offsetOf = (hit, cellX) => {
  const col = Math.max(0, cellX - hit.textX) + (hit.scroll || 0);
  const at = indexAtRow(hit.start || 0, hit.text, col);
  return Math.min(at, hit.limit ?? Infinity);
};

const focusField = (ui, hit) => {
  if (ui.composeKind !== 'npm' || !hit.field) return true;
  if (hit.field === ui.npm.editField) return true;
  return ui.npm.focusField(hit.field);
};

const activeEditor = (ui) => {
  if (ui.pane === 'agents' && ui.agents.pick) return ui.agents.pick.editor;
  if (ui.pane === 'agents' && !ui.agents.viewing) return ui.agents.task;
  if (ui.pane === 'tasks' && ui.composer.tasks.planOpen) {
    return ui.composer.tasks.planPick.editor;
  }
  if (ui.mode === 'find') return ui.nav.find?.editor;
  if (ui.mode === 'import') return ui.nav.import?.editor;
  return ui.mode === 'compose' ? ui.editor : null;
};

const editorHits = (ui, editor) =>
  (ui.lastFrame?.editHits ?? []).filter(
    (hit) => (hit.editor ?? ui.editor) === editor,
  );

const revealEditor = (ui) => {
  if (ui.mode === 'compose') ui.composer.afterEdit();
  ui.paint();
};

// How many presses in a row, on the same cell of the same text, make a click
const clickCount = (nav, editor, cell) => {
  const at = Date.now();
  const prev = nav.editClick;
  const again =
    prev &&
    prev.editor === editor &&
    prev.x === cell.x &&
    prev.y === cell.y &&
    at - prev.at <= MULTI_CLICK_MS;
  const count = again ? (prev.count % 3) + 1 : 1;
  nav.editClick = { editor, x: cell.x, y: cell.y, at, count };
  return count;
};

const beginEditDrag = (ui, cell, extend = false) => {
  const editor = activeEditor(ui);
  if (!editor) return false;
  const hit = hitAt(editorHits(ui, editor), cell);
  if (!hit) return false;
  if (!focusField(ui, hit)) {
    ui.paint();
    return true;
  }
  if (ui.pane === 'agents' && editor === ui.agents.task) {
    ui.agents.focusTask();
  }
  const previous = editor.anchor ?? editor.cursor;
  const offset = offsetOf(hit, cell.x);
  let anchor = extend ? previous : offset;
  editor.place(offset);
  if (extend && anchor !== editor.cursor) editor.anchor = anchor;
  const clicks = extend ? 1 : clickCount(ui.nav, editor, cell);
  if (clicks > 1) {
    // Twice selects the word, three times the line
    editor.selectSpan(
      clicks === 2 ? editor.wordSpan(offset) : editor.lineSpan(offset),
    );
    anchor = editor.anchor ?? editor.cursor;
  }
  ui.nav.clearSelection();
  ui.nav.editDrag = { editor, anchor, field: hit.field, cell };
  revealEditor(ui);
  return true;
};

const nearestHit = (hits, y) => {
  const away = (hit) => Math.abs(hit.y - y);
  let nearest = null;
  for (const hit of hits) {
    if (!nearest || away(hit) < away(nearest)) nearest = hit;
  }
  return nearest;
};

const moveEditDrag = (ui, cell, release = false) => {
  const drag = ui.nav.editDrag;
  if (!drag) return false;
  if (release && drag.cell.x === cell.x && drag.cell.y === cell.y) {
    ui.nav.editDrag = null;
    return true;
  }
  if (activeEditor(ui) === drag.editor) {
    const sameField = (hit) => hit.field === drag.field;
    const hits = editorHits(ui, drag.editor).filter(sameField);
    const hit = nearestHit(hits, cell.y);
    if (hit) {
      const x = Math.min(cell.x, (hit.x1 ?? cell.x + 1) - 1);
      drag.editor.place(offsetOf(hit, x));
      if (drag.anchor !== drag.editor.cursor) drag.editor.anchor = drag.anchor;
      drag.cell = cell;
      revealEditor(ui);
    }
  }
  if (release) ui.nav.editDrag = null;
  return true;
};

// The prompt box of the agents screen is a text area with its own menu
const agentPrompt = (ui, cell) => {
  const { agents, lastFrame } = ui;
  if (ui.pane !== 'agents' || agents.viewing || agents.pick) return null;
  const hits = (lastFrame?.editHits ?? []).filter(
    (hit) => hit.editor === agents.task,
  );
  return hitAt(hits, cell) ? agents.task : null;
};

const textEditor = (ui, cell) => {
  if (ui.mode === 'compose') return ui.editor;
  if (ui.mode === 'review' && ui.pane === 'agents') {
    const prompt = agentPrompt(ui, cell);
    if (prompt) return prompt;
  }
  const statusY = ui.lastFrame?.height - 1;
  if (cell.y !== statusY) return null;
  if (ui.mode === 'find') return ui.nav.find?.editor;
  if (ui.mode === 'import') return ui.nav.import?.editor;
  return null;
};

const textDisabled = (editor) => {
  const off = editor.hasSelect() ? [] : ['textCut', 'textCopy'];
  if (!editor.hasSelect() && editor.cursor >= editor.text.length) {
    off.push('textDelete');
  }
  if (!editor.text) off.push('textSelectAll');
  return off;
};

const runTextAction = (ui, menu, action) => {
  const editor = menu.editor;
  if (!editor) return false;
  if (action === 'textSelectAll') {
    editor.selectAll();
    if (ui.mode === 'compose') ui.composer.afterEdit();
  } else {
    const key = TEXT_KEYS[action];
    if (key) ui.handleEvent({ type: 'key', key });
  }
  return true;
};

module.exports = {
  TEXT_ACTIONS,
  hitAt,
  offsetOf,
  focusField,
  beginEditDrag,
  moveEditDrag,
  textEditor,
  textDisabled,
  runTextAction,
};
