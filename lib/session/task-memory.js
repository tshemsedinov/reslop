'use strict';

const { rowLabel } = require('./task-rows.js');

// What the tasks screen looked like on each plan opened in this session:
// the focused row, the folded blocks, whether all tasks are open, and the
// open instructions. Rows are found again by their labels, since a plan read
// again gives its blocks new ids.

const labelsOf = (rows, ids) =>
  rows.filter((row) => row.block && ids.has(row.block.id)).map(rowLabel);

const idsOf = (rows, labels) => {
  const wanted = new Set(labels);
  const ids = new Set();
  for (const row of rows) {
    if (row.block && wanted.has(rowLabel(row))) ids.add(row.block.id);
  }
  return ids;
};

const remember = (page, memory) => {
  const path = page.store?.reviewPath;
  if (!path) return;
  const rows = page.rows();
  const focused = page.focusedRow();
  memory.set(path, {
    focus: focused ? rowLabel(focused) : '',
    folded: labelsOf(rows, page.foldedBlocks),
    instructions: page.instructionsOpen,
    allOpen: page.allOpen,
  });
};

const recall = (page, memory) => {
  const kept = memory.get(page.store?.reviewPath);
  if (!kept) return false;
  page.allOpen = kept.allOpen;
  page.instructionsOpen = kept.instructions;
  page.foldedBlocks = idsOf(page.rows(), kept.folded);
  const rows = page.rows();
  const at = rows.findIndex((row) => rowLabel(row) === kept.focus);
  if (at >= 0) page.nav.tasksFocus = at;
  return at >= 0;
};

module.exports = { remember, recall };
