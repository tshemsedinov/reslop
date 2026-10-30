'use strict';

const { lineKey, lineField } = require('../input/editor.js');
const { blockText } = require('../review/markdown.js');

// ctrl+f on the tasks screen: typing jumps to the first block at or below
// the focus whose text has the query, Up and Down go to the previous and
// next one, and Enter or Escape stay where it is. Nothing is hidden.

const rowText = (row) => {
  if (row.task) return row.task.text;
  if (row.note) return row.note.text;
  if (row.type === 'heading') return row.block.text;
  return row.block ? blockText(row.block) : '';
};

// The rows that have the query, in screen order
const findHits = (rows, query) => {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const hits = [];
  rows.forEach((row, at) => {
    if (rowText(row).toLowerCase().includes(needle)) hits.push(at);
  });
  return hits;
};

// The first hit from `at` on in a direction, round the end of the list
const hitFrom = (hits, at, delta) => {
  if (!hits.length) return -1;
  if (delta < 0) {
    return [...hits].reverse().find((one) => one <= at) ?? hits.at(-1);
  }
  return hits.find((one) => one >= at) ?? hits[0];
};

const stopFind = (ui) => {
  ui.mode = 'review';
  ui.nav.find = null;
  ui.status = '';
};

const jump = (page, from, delta) => {
  const find = page.ui.nav.find;
  const rows = page.rows();
  const hits = findHits(rows, find.query);
  page.findQuery = find.query;
  find.miss = Boolean(find.query.trim()) && !hits.length;
  const at = hitFrom(hits, from, delta);
  if (at >= 0) page.followRow(rows[at]);
};

const step = (page, delta) => {
  jump(page, page.clampedTaskFocus() + delta, delta);
};

const FIND_KEYS = {
  escape: (page, ui) => stopFind(ui),
  enter: (page, ui) => stopFind(ui),
  up: (page) => step(page, -1),
  down: (page) => step(page, 1),
  'ctrl-f': (page) => step(page, 1),
};

const onTaskFindKey = (page, key) => {
  const ui = page.ui;
  const find = ui.nav.find;
  if (!find) return void (ui.mode = 'review');
  const own = FIND_KEYS[key];
  if (own) return void own(page, ui);
  if (lineKey(find.editor, key, ui, true) !== 'text') return;
  jump(page, find.from, 1);
};

// The find line starts on the last query, searching from the focus
const startTaskFind = (page) => {
  const ui = page.ui;
  if (ui.mode !== 'review') return;
  const find = lineField('query', page.findQuery);
  if (find.query) find.editor.selectAll();
  find.lead = ' find: ';
  find.from = page.clampedTaskFocus();
  find.miss = false;
  find.onKey = (key) => onTaskFindKey(page, key);
  ui.mode = 'find';
  ui.nav.find = find;
  ui.status = '';
};

module.exports = { startTaskFind };
