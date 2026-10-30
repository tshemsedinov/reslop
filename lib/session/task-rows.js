'use strict';

const files = require('../common/files.js');
const { TASK_KINDS, TASK_FIELDS, kindFields, taskTitle } = files;
const { TaskItem, taskLines } = require('../review/task.js');
const { blockText, fenceOf } = require('../review/markdown.js');
const blocks = require('../review/blocks.js');
const { isInstructions, headingKind, blockHead, planTitle } = blocks;
const { checkLabel } = require('../review/review.js');

// What the tasks screen shows for a block, and the field helpers of its
// task editor

const CUSTOM_BLOCK = 'custom…';

const PEEK_LINES = 3;

// The fields the menu offers; `result` is left for the agent to write
const MENU_KEYS = TASK_FIELDS.filter((field) => field.hot).map(
  (field) => field.key,
);

const CUSTOM_TITLE = 'New block';

const fenceLang = (block) => {
  const fence = fenceOf(block.lines[0]);
  return fence ? fence.info.split(/\s/)[0] : '';
};

// One row per block in file order: headings, tasks, text, and notes
const blockRow = (block, tasks) => {
  const { type, key, note } = block;
  const row = { type, block, quote: false, task: null, kind: '', key, note };
  if (type === 'task') {
    row.task = tasks.get(block.id) ?? null;
    row.kind = row.task ? row.task.kind : '';
  } else if (type === 'feedback') {
    row.quote = true;
  } else if (type === 'item') {
    row.type = 'text';
  }
  return row;
};

const sameRow = (row, target) => {
  if (target.draft) return row.type === target.type;
  if (target.quote) return row.quote && row.key === target.key;
  const id = target.block?.id ?? target.task?.id;
  return Boolean(row.block) && row.block.id === id;
};

// The title reslop writes into a new plan repeats the plan name
const isPlanTitle = (block, reviewPath) =>
  block.level === 1 && block.text === planTitle(reviewPath);

const kindProgress = (tasks) => {
  const progress = new Map();
  for (const task of tasks) {
    if (!task.text.trim()) continue;
    const head = blockHead(task.block);
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
  return `check: ${done}/${checks.length}`;
};

// What a closed task hides: its fields by name and its checks, as
// `(where, do, check: 1/5)`
const hiddenParts = (item) => {
  const parts = [];
  for (const field of item.fields) {
    if (field.key === 'check' && item.checks.length) continue;
    if (!parts.includes(field.key)) parts.push(field.key);
  }
  if (item.hasText()) parts.push('text');
  return parts;
};

// The first lines of a folded block that holds no task, as its preview;
// null for a block with tasks, which counts them instead
const blockPeek = (store, head) => {
  const inside = store.blockContent(head);
  if (inside.some((block) => block.type === 'task')) return null;
  const lines = inside
    .flatMap((block) => block.lines)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) return null;
  const shown = lines.slice(0, PEEK_LINES);
  if (lines.length > PEEK_LINES) shown[shown.length - 1] += ' ...';
  return shown;
};

const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

// What a folded block hides: its tasks, notes, and other parts; the
// instructions count their lines
const blockSummary = (store, head) => {
  const inside = store.blockContent(head);
  if (isInstructions(head)) {
    const lines = inside.flatMap((block) => block.lines);
    return `(${plural(lines.filter((line) => line.trim()).length, 'line')})`;
  }
  const count = (test) => inside.filter(test).length;
  const tasks = count((block) => block.type === 'task');
  const notes = count((block) => ['feedback', 'code'].includes(block.type));
  const other = inside.length - tasks - notes;
  const parts = [];
  if (tasks) parts.push(plural(tasks, 'task'));
  if (notes) parts.push(plural(notes, 'note'));
  if (other) parts.push(`${other} more`);
  return parts.length ? `(${parts.join(', ')})` : '(empty)';
};

// Code proposals are not edited here, nor the instructions heading: Enter
// on it opens the instructions, and their text is edited like any other
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

// A field with no value is not written: it is a hint the author skipped
const dropEmptyFields = (text) => {
  let item = new TaskItem(taskLines(text, false));
  const empty = item.fields.filter((field) => !field.value);
  if (!empty.length) return text;
  for (const field of empty) item = new TaskItem(item.setField(field.key, ''));
  return item.text;
};

// The fields a task text does not have yet, the kind's suggested ones
// first, for the field menu
const missingFields = (text, kind) => {
  const present = new TaskItem(taskLines(text, false)).fields;
  const keys = present.map((field) => field.key);
  const first = kindFields(kind);
  const rest = MENU_KEYS.filter((key) => !first.includes(key));
  return first.concat(rest).filter((key) => !keys.includes(key));
};

const fieldText = (key) => `- ${key}: `;

// A line the field menu writes over: empty, or `- ` and part of a name
const isFieldStub = (line) => /^(?:- [a-z-]*)?\s*$/.test(line);

const blockLabels = () => [
  ...TASK_KINDS.map((kind) => kind.title),
  CUSTOM_BLOCK,
];

// One row per shown block in file order and the draft after its anchor.
// The agent instructions show their heading, and their text once opened;
// a folded block shows only its heading
const planRows = (store, draft, view = {}) => {
  const { instructions = false, folded = new Set() } = view;
  const tasks = new Map(store.tasks.map((task) => [task.id, task]));
  const rows = [];
  let placed = false;
  let inside = 0;
  let fold = 0;
  for (const block of store.doc.layout()) {
    if (block.type === 'blank' || block.type === 'frontmatter') continue;
    if (block.type === 'heading') {
      if (fold && block.level > fold) continue;
      fold = 0;
      if (inside && block.level > inside && !instructions) continue;
      if (isPlanTitle(block, store.reviewPath)) continue;
      if (!inside || block.level <= inside) {
        inside = isInstructions(block) ? block.level : 0;
      }
      if (folded.has(block.id)) fold = block.level;
    } else if (fold || (inside && !instructions)) {
      continue;
    }
    const row = blockRow(block, tasks);
    if (inside && !isInstructions(block)) row.instructions = true;
    rows.push(row);
    if (draft && draft.after === block.id) {
      rows.push({ type: 'draft', draft: true, kind: draft.kind });
      placed = true;
    }
  }
  if (draft && !placed) {
    rows.push({ type: 'draft', draft: true, kind: draft.kind });
  }
  return rows;
};

const isInstructionsRow = (row) =>
  Boolean(row.instructions || (row.block && isInstructions(row.block)));

// A feedback note shows its first line and line number; a code proposal
// its place and the first line of the code
const noteView = (row) => {
  const { note } = row;
  if (row.quote) {
    const title = note.text.split('\n')[0];
    return {
      type: 'task',
      done: note.done,
      title,
      aside: `:${note.newStart}`,
    };
  }
  const first = note.text.trim().split('\n')[0] ?? '';
  const title = `code ${note.file}:${note.newStart}`;
  return { type: 'task', done: note.done, title, note: first.trim() };
};

// A draft in a kind the file has no block for shows the heading it will
// be saved under, dim and out of the focus order
const draftHeading = (store, draft, row) => {
  if (!draft || draft.after !== null) return null;
  if (store.kindHeading(row.kind)) return null;
  if (!TASK_KINDS.some((one) => one.id === row.kind)) return null;
  return {
    type: 'heading',
    text: taskTitle(row.kind),
    level: 2,
    preview: true,
    focus: false,
  };
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
  return blockText(row.block);
};

module.exports = {
  CUSTOM_BLOCK,
  CUSTOM_TITLE,
  fenceLang,
  sameRow,
  kindProgress,
  checkAside,
  hiddenParts,
  blockPeek,
  blockSummary,
  isEditable,
  firstRow,
  dropEmptyFields,
  missingFields,
  fieldText,
  isFieldStub,
  blockLabels,
  planRows,
  isInstructionsRow,
  noteView,
  draftHeading,
  editText,
  dropRow,
  moveRow,
  rowLabel,
};
