'use strict';

const { detectLang } = require('../detect.js');
const primitives = require('./primitives.js');
const diff = require('./diff.js');

const { paneResult } = primitives;
const { paintDiffLine, codeCursorInRows } = diff;
const { sameHunk } = require('../diff.js');

const paintBodyUnit = (view, width, color) => {
  const lines = view.unitLines ?? [];
  const item = view.item;
  const lang = detectLang(view.reviewPath ?? '');
  const overlay = view.codeOverlay;
  const editing = view.mode === 'compose' && overlay;
  const body = [];
  for (const line of lines) {
    const isBlock = item && sameHunk(line.item, item);
    const row = { ...line };
    if (editing) {
      row.mark = ' ';
    } else if ((row.type === 'add' || row.type === 'del') && !isBlock) {
      row.mark = ' ';
    }
    body.push(paintDiffLine(row, width, color, row.origin, lang));
  }
  const edit = overlay ? overlay.cursor : null;
  const cursor = codeCursorInRows(lines, false, width, edit);
  return paneResult({
    body,
    fileHits: [],
    todoOwners: [],
    cursor,
    splitBody: false,
  });
};

module.exports = { paintBodyUnit };
