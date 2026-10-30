'use strict';

const { listRows } = require('./view.js');
const { selectableRow } = require('../common/files.js');
const { placeChosenFile } = require('./files-pane.js');

// SGR 1006 button bits: Shift is 4, Ctrl is 16.
const SHIFT_BUTTON = 4;
const CTRL_BUTTON = 16;

const rowHits = (ui) => {
  const rows = listRows(ui);
  const side = ui.nav.listSide;
  return (ui.lastFrame?.fileHits ?? []).filter((hit) => {
    if (hit.tree || hit.folder || hit.field) return false;
    if (!Number.isInteger(hit.cursor) || !rows[hit.cursor]) return false;
    if (side && hit.side && hit.side !== side) return false;
    return true;
  });
};

const hitAt = (ui, cell) => {
  const x = cell.x - 1;
  return (ui.lastFrame?.fileHits ?? []).find((hit) => {
    if (hit.tree || hit.folder || hit.field || hit.y !== cell.y) return false;
    if (!Number.isInteger(hit.cursor)) return false;
    if (hit.x0 !== undefined && (x < hit.x0 || x >= hit.x1)) return false;
    return true;
  });
};

const adoptList = (ui, hit) => {
  const nav = ui.nav;
  if (nav.pane === 'files') {
    nav.folderFocus = false;
    return true;
  }
  if (nav.pane === 'npm') {
    if (ui.npm.viewing) return false;
    const side = hit.side === 'runs' ? 'runs' : 'commands';
    if (nav.listSide !== side) nav.clearListPick();
    nav.listSide = side;
    ui.npm.focus = side;
    return true;
  }
  if (nav.pane === 'agents') {
    if (hit.side !== 'runs' || ui.agents.viewing || ui.agents.pick) {
      return false;
    }
    if (nav.listSide !== 'runs') nav.clearListPick();
    nav.listSide = 'runs';
    ui.agents.focus = 'runs';
    return true;
  }
  return true;
};

const extendRange = (ui, drag, cursor) => {
  const nav = ui.nav;
  nav.pinAnchor(drag.anchor);
  nav.moveList(cursor - nav.listCursor, listRows(ui).length, true);
  drag.moved ||= cursor !== drag.cursor;
  drag.cursor = nav.listCursor;
  nav.lastClick = null;
  if (nav.pane === 'files') placeChosenFile(ui);
};

const armListDrag = (nav, drag) => {
  nav.listDrag = drag;
  nav.mouseAnchor = null;
  nav.selection = null;
  nav.pendingClick = null;
  if (nav.pane === 'branches') nav.treeFocus = false;
};

const startListPointer = (ui, event, cell) => {
  const nav = ui.nav;
  if (ui.mode !== 'review') return false;
  const hit = hitAt(ui, cell);
  if (!hit || !adoptList(ui, hit)) return false;
  if (nav.listCursor === undefined || !listRows(ui)[hit.cursor]) return false;
  const extended = Boolean(event.button & SHIFT_BUTTON);
  const ctrl = Boolean(event.button & CTRL_BUTTON);
  if (ctrl) {
    const rows = listRows(ui);
    const eligible = (entry) => selectableRow(nav.pane, entry, ui);
    if (extended) nav.addListSpan(hit.cursor, rows, eligible);
    else nav.toggleListIndex(hit.cursor, rows, eligible);
    if (nav.pane === 'files') placeChosenFile(ui);
    nav.lastClick = null;
    armListDrag(nav, {
      pane: nav.pane,
      anchor: hit.cursor,
      cursor: hit.cursor,
      cell,
      extended: false,
      moved: false,
      toggle: true,
    });
    return true;
  }
  const anchor = nav.multiselect ? nav.listAnchor.index : nav.listCursor;
  armListDrag(nav, {
    pane: nav.pane,
    anchor: extended ? anchor : hit.cursor,
    cursor: hit.cursor,
    cell,
    extended,
    moved: false,
    toggle: false,
  });
  if (extended) extendRange(ui, nav.listDrag, hit.cursor);
  return true;
};

const moveListPointer = (ui, cell, released = false) => {
  const nav = ui.nav;
  const drag = nav.listDrag;
  if (!drag) return false;
  if (drag.pane !== nav.pane || ui.mode !== 'review') {
    nav.listDrag = null;
    return false;
  }
  if (drag.toggle) {
    if (released) nav.listDrag = null;
    return true;
  }
  const hits = rowHits(ui);
  const changed = cell.x !== drag.cell.x || cell.y !== drag.cell.y;
  if (changed && hits.length) {
    const nearest = hits.reduce((best, hit) =>
      Math.abs(hit.y - cell.y) < Math.abs(best.y - cell.y) ? hit : best,
    );
    let cursor = nearest.cursor;
    if (cell.y < hits[0].y || cell.y > hits.at(-1).y) {
      const step = cell.y < hits[0].y ? -1 : 1;
      const before = Math.min(nav.listCursor, nearest.cursor);
      const after = Math.max(nav.listCursor, nearest.cursor);
      const edge = step < 0 ? before : after;
      cursor = edge + step;
      drag.moved = true;
    }
    if (cursor !== drag.cursor || drag.extended || drag.moved) {
      extendRange(ui, drag, cursor);
    }
    drag.cell = cell;
  }
  const consumed = drag.extended || drag.moved;
  if (released) nav.listDrag = null;
  return !released || consumed;
};

module.exports = { startListPointer, moveListPointer };
