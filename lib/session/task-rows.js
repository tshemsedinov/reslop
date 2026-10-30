'use strict';

const path = require('node:path');
const files = require('../common/files.js');
const { TASK_KINDS, TASK_FIELDS, kindFields } = files;
const { TaskItem, taskLines, FIELD_KEYS } = require('../review/task.js');
const { bare } = require('../review/markdown.js');
const blocks = require('../review/blocks.js');
const { isInstructions, headingKind, sectionHead } = blocks;
const { checkLabel } = require('../review/review.js');
const { parseLocations } = require('../review/location.js');

// What the tasks screen shows for a block, and the field helpers of its
// task editor

const EMPTY_HINT = 'Insert task · s section · e markdown';

const CUSTOM_SECTION = 'custom…';

const FENCE_INFO = /^\s*(?:`{3,}|~{3,})\s*([\w+-]*)/;

const blockText = (block) => block.lines.map(bare).join('\n');

const fenceLang = (block) => {
  const match = FENCE_INFO.exec(bare(block.lines[0]));
  return match ? match[1] : '';
};

// One row per block in file order: headings, tasks, text, and notes
const blockRow = (block, tasks) => {
  const row = { type: block.type, block, quote: false, task: null };
  if (block.type === 'task') {
    row.task = tasks.get(block.id) ?? null;
    row.kind = row.task ? row.task.kind : '';
  } else if (block.type === 'feedback') {
    Object.assign(row, { quote: true, key: block.key, note: block.note });
  } else if (block.type === 'code') {
    Object.assign(row, { key: block.key, note: block.note });
  } else if (block.type === 'item') {
    row.type = 'text';
  }
  return row;
};

const sameRow = (row, dest) => {
  if (dest.draft || dest.type === 'hint') return row.type === dest.type;
  if (dest.quote) return row.quote && row.key === dest.key;
  const id = dest.block?.id ?? dest.task?.id;
  return Boolean(row.block) && row.block.id === id;
};

// The title reslop writes into a new plan repeats the plan name
const isPlanTitle = (block, reviewPath) => {
  if (block.level !== 1) return false;
  const name = path.basename(reviewPath ?? '', '.md');
  return block.text === `reslop review ${name}`;
};

// Done and total tasks under each kind heading
const kindProgress = (tasks) => {
  const progress = new Map();
  for (const task of tasks) {
    if (!task.text.trim()) continue;
    const head = sectionHead(task.block);
    if (!head || !headingKind(head)) continue;
    const entry = progress.get(head.id) ?? { done: 0, total: 0 };
    entry.total += 1;
    if (task.done) entry.done += 1;
    progress.set(head.id, entry);
  }
  return progress;
};

const checkAside = (item) => {
  const checks = item.checks;
  if (!checks.length) return '';
  const done = checks.filter((check) => check.done).length;
  return `check ${done}/${checks.length}`;
};

// Code proposals and the folded agent instructions are not edited here
const isEditable = (row) => {
  if (row.type === 'code') return false;
  return !(row.block && isInstructions(row.block));
};

// The first row a plan opens on: its first task, else the first row past
// the folded instructions
const firstRow = (rows) => {
  const task = rows.findIndex((row) => row.type === 'task');
  if (task >= 0) return task;
  const at = rows.findIndex((row) => !row.block || !isInstructions(row.block));
  return Math.max(0, at);
};

const FIELD_HINT = new Map(TASK_FIELDS.map((field) => [field.key, field.hint]));

const EMPTY_FIELD = /^- [a-z][a-z0-9_-]*:\s*$/;

// A field with no value is not written: it is a hint the author skipped
const dropEmptyFields = (text) => {
  const lines = text.split('\n');
  const kept = lines.filter((line, at) => {
    if (at === 0 || !EMPTY_FIELD.test(line)) return true;
    return /^\s+\S/.test(lines[at + 1] ?? '');
  });
  return kept.join('\n');
};

// The suggested fields of a kind the text does not have yet
const missingFields = (text, kind) => {
  const present = new TaskItem(taskLines(text, false)).fields;
  const keys = present.map((field) => field.key);
  return kindFields(kind).filter((key) => !keys.includes(key));
};

const ghostDetails = (text, kind) =>
  missingFields(text, kind).map((key) => ({
    kind: 'ghost',
    key,
    text: FIELD_HINT.get(key) ?? '',
  }));

// Field names to complete: the kind's suggested ones first
const fieldChoices = (kind) => {
  const first = kindFields(kind);
  return [...first, ...FIELD_KEYS.filter((key) => !first.includes(key))];
};

const fieldText = (key) =>
  key === 'check' ? '- check:\n  - [ ] ' : `- ${key}: `;

const PARTIAL_FIELD = /^- ([a-z-]*)$/;

const DONE_FIELD = /^- ([a-z-]+):\s*$/;

// The line Tab completes: `- ` and part of a name, or a name just completed
const completeLine = (line, kind) => {
  const choices = fieldChoices(kind);
  const partial = PARTIAL_FIELD.exec(line);
  if (partial) {
    const key = choices.find((one) => one.startsWith(partial[1]));
    return key ? fieldText(key) : null;
  }
  const done = DONE_FIELD.exec(line);
  if (!done) return null;
  const at = choices.indexOf(done[1]);
  return fieldText(choices[(at + 1) % choices.length]);
};

const CUSTOM_TITLE = 'New section';

const sectionLabels = () => [
  ...TASK_KINDS.map((kind) => kind.title),
  CUSTOM_SECTION,
];

// The fields Enter opens as a file location
const LINK_KEYS = ['where', 'related'];

const isStop = (detail) => {
  if (detail.kind === 'check') return true;
  if (detail.kind !== 'field' || !LINK_KEYS.includes(detail.key)) return false;
  return parseLocations(detail.text).length > 0;
};

// The details of an open task; checks and locations are stops the cursor
// moves through, numbered in `stop`
const stopDetails = (item) => {
  let stop = 0;
  return item.details().map((detail) => {
    if (!isStop(detail)) return detail;
    const numbered = { ...detail, stop };
    stop += 1;
    return numbered;
  });
};

// The stop numbered `sub` of a task row
const stopOf = (row, sub) => {
  if (sub === undefined || !row || row.type !== 'task') return null;
  const stops = stopDetails(row.task.item);
  return stops.find((one) => one.stop === sub) ?? null;
};

const editText = (block) =>
  block.type === 'heading' ? block.text : blockText(block);

const dropRow = (store, row) => {
  if (row.quote) {
    store.setFeedback(row.key, { ...row.note, text: '' });
  } else if (row.type === 'code') {
    store.setCode(row.key, { ...row.note, clear: true });
  } else {
    store.removeBlock(row.block.id);
  }
};

const moveRow = (store, row, delta) => {
  if (row.quote) return store.moveFeedback(row.key, delta);
  return store.moveBlock(row.block, delta);
};

const rowLabel = (row) => {
  if (row.type === 'heading') return row.block.text;
  if (row.type === 'task') return checkLabel(row.task.item.rest, row.task.done);
  if (row.quote) return checkLabel(row.note.text, row.note.done);
  if (row.type === 'code') return checkLabel(`code ${row.key}`, row.note.done);
  if (row.type === 'draft') return checkLabel('', false);
  if (row.type === 'hint') return EMPTY_HINT;
  return blockText(row.block);
};

module.exports = {
  stopDetails,
  stopOf,
  blockText,
  fenceLang,
  blockRow,
  sameRow,
  isPlanTitle,
  kindProgress,
  checkAside,
  isEditable,
  firstRow,
  dropEmptyFields,
  missingFields,
  ghostDetails,
  fieldText,
  completeLine,
  CUSTOM_TITLE,
  sectionLabels,
  editText,
  dropRow,
  moveRow,
  rowLabel,
  EMPTY_HINT,
  CUSTOM_SECTION,
};
