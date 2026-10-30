'use strict';

const { TASK_KINDS } = require('../common/files.js');
const { fieldAction } = require('../input/actions.js');
const { MenuPick, lineKey, lineField } = require('../input/editor.js');
const { blockText } = require('../review/markdown.js');
const { TaskItem, taskLines } = require('../review/task.js');
const location = require('../review/location.js');
const { parseLocations, resolveLocation } = location;
const { showLocation } = require('./unit.js');
const { stopFind } = require('./prompts.js');
const rowParts = require('./task-rows.js');
const { isEditable, rowLabel, missingFields, blockLabels } = rowParts;
const { CUSTOM_BLOCK, CUSTOM_TITLE } = rowParts;

// The actions of the tasks screen on its TaskPage: find, opening the
// files a task points at, the keys of the edited block, the screen kept
// for each plan, and the pop-ups to add fields and pick a priority

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

// The files a task points at, opened on the files screen; Escape comes back
// to the task. Anything outside the root, and every URL, is named in the
// status line and never opened.

const openFound = (page, found) => {
  const ui = page.ui;
  if (!found.ok) {
    ui.status = found.error;
    return;
  }
  page.closeEditor();
  ui.ops.hold(showLocation(ui, found));
};

// The first location in a `where` or `related` value
const openLocation = (page, text) => {
  const [first] = parseLocations(text);
  openFound(page, resolveLocation(page.ui.root, first));
};

// A feedback note or a code proposal: its file at its line
const openNote = (page) => {
  const row = page.focusedRow();
  if (!row || !(row.quote || row.type === 'code')) return false;
  const { file, newStart } = row.note;
  const found = resolveLocation(page.ui.root, { path: file, line: newStart });
  openFound(page, { ...found, symbol: '' });
  return true;
};

const LINK_KEYS = ['where', 'related'];

// The location on the cursor line of a `where` or `related` field, else
// the first one of that field
const cursorLocations = (editor) => {
  const item = new TaskItem(taskLines(editor.text, false));
  const at = editor.linePos().line;
  const field = item.fields.find(
    (one) => LINK_KEYS.includes(one.key) && at >= one.start && at < one.end,
  );
  if (!field) return '';
  const line = editor.text.split('\n')[at];
  return parseLocations(line).length ? line : field.value;
};

// ctrl+w: a note's diff, the location on the cursor line of the edited
// task, else the task's first `where`
const openFocused = (page) => {
  if (openNote(page)) return;
  const row = page.focusedRow();
  if (!row || row.type !== 'task') return;
  const editor = page.composing() ? page.composer.editor : null;
  const line = editor ? cursorLocations(editor) : '';
  const text = line || row.task.item.value('where');
  if (!parseLocations(text).length) {
    page.ui.status = 'no file to open';
    return;
  }
  openLocation(page, text);
};

// The keys that act on the edited block of the tasks screen: ctrl+d ticks,
// and Backspace drops the block once there is no text left for it

// Ticks or clears the check on the cursor line of a task's text
const tickCheckLine = (editor) => {
  const item = new TaskItem(taskLines(editor.text, false));
  const at = editor.linePos().line;
  const index = item.checks.findIndex((check) => check.line === at);
  if (index < 0) return false;
  const lines = item.setCheck(index, !item.checks[index].done);
  editor.edit(new TaskItem(lines).text, editor.cursor);
  return true;
};

// ctrl+d marks the edited task done or not; on a check line it ticks the
// check in the text
const toggleDone = (page) => {
  const editor = page.composing() ? page.composer.editor : null;
  if (editor && tickCheckLine(editor)) return;
  page.closeEditor();
  page.toggleFocusedTask();
};

// Backspace in an empty block drops it and goes on at the end of the
// block above; a heading with blocks under it asks first
const dropBlock = (page) => {
  const editor = page.composer.editor;
  const row = page.focusedRow();
  if (!editor || !row || editor.text) return false;
  page.composer.dropEditor();
  if (row.draft) return true;
  if (!isEditable(row) || !row.block) return false;
  const at = page.clampedTaskFocus();
  page.removeFocusedTask();
  page.ui.status = '';
  if (page.rowAt(at)?.block !== row.block) {
    page.nav.tasksFocus = Math.max(0, at - 1);
  }
  page.enterAt = 'end';
  return true;
};

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

// The pop-ups of the tasks screen: fields to add and a priority. Each item
// has its own key, picked by typing it.

const PRIORITY_ITEMS = [
  { id: 'priority:high', key: 'h', caption: 'high', value: 'high' },
  { id: 'priority:normal', key: 'n', caption: 'normal', value: '' },
  { id: 'priority:low', key: 'l', caption: 'low', value: 'low' },
];

// Under the text cursor while editing, else under the focused row
const anchorOf = (page) => {
  const frame = page.ui.lastFrame;
  if (page.composing() && frame?.cursor) {
    return { x: Math.max(0, frame.cursor.x - 1), y: frame.cursor.y + 1 };
  }
  const focus = page.clampedTaskFocus();
  const hits = frame?.taskHits ?? [];
  const hit = hits.find((one) => one.cursor === focus && one.x0 === undefined);
  return { x: 4, y: hit ? hit.y + 1 : 2 };
};

// The frame is drawn first so the pop-up sits under the cursor it has now
const openPick = (page, menu) => {
  if (typeof page.ui.draw === 'function') page.ui.draw();
  const base = { cursor: 0, disabled: [], inline: true };
  page.nav.contextMenu = { ...anchorOf(page), ...base, ...menu };
};

// A pop-up of items: [{ id, key, caption }]
const openItems = (page, items, pick) => {
  const actions = items.map((item) => item.id);
  const keys = Object.fromEntries(items.map((item) => [item.id, item.key]));
  const captions = Object.fromEntries(
    items.map((item) => [item.id, item.caption]),
  );
  openPick(page, { actions, keys, captions, pick });
};

// The fields the edited task does not have yet, the kind's first
const fieldMenu = (page) => {
  const editor = page.composer.editor;
  if (!editor || !page.isTaskEdit()) return false;
  const row = page.focusedRow();
  const kind = row.task ? row.task.kind : row.kind;
  const keys = missingFields(editor.text, kind);
  if (!keys.length) return false;
  const prefix = fieldAction('').length;
  openPick(page, {
    actions: keys.map(fieldAction),
    pick: (action) => page.addField(action.slice(prefix)),
  });
  return true;
};

// ctrl+l: high, normal, or low for the focused task; the task is
// written first when it is being edited
const priorityMenu = (page) => {
  const store = page.store;
  const row = page.focusedRow();
  if (!store || !row || row.type !== 'task') return;
  const pick = (id) => {
    const item = PRIORITY_ITEMS.find((one) => one.id === id);
    page.closeEditor();
    store.editTask(row.task.id, (task) => task.setPriority(item.value));
    page.followRow(row);
    page.ui.flushReview(true);
  };
  openItems(page, PRIORITY_ITEMS, pick);
};

// Tasks with the same ID go into one commit. The menu lists the groups of
// the plan with their sizes, a new `f<n>`, and none
const GROUP_LETTER = 'f';

// `f1` to `f9` are picked by their digit
const GROUP_KEY = new RegExp(`^${GROUP_LETTER}[1-9]$`);

const groupOrder = (left, right) =>
  left[0].localeCompare(right[0]) ||
  Number(left.slice(1)) - Number(right.slice(1));

const groupItems = (store) => {
  const sizes = new Map();
  for (const task of store.tasks) {
    const id = task.item.id.toLowerCase();
    if (id) sizes.set(id, (sizes.get(id) ?? 0) + 1);
  }
  const ids = [...sizes.keys()].sort(groupOrder);
  const numbers = ids
    .filter((id) => id.startsWith(GROUP_LETTER))
    .map((id) => Number(id.slice(1)));
  const fresh = `${GROUP_LETTER}${Math.max(0, ...numbers) + 1}`;
  const items = ids.map((id) => {
    const size = sizes.get(id);
    const digit = GROUP_KEY.test(id) ? id[1] : undefined;
    const caption = `${id}  ${size} task${size > 1 ? 's' : ''}`;
    return { id: `group:${id}`, key: digit, caption, value: id };
  });
  items.push({
    id: 'group:new',
    key: 'n',
    caption: `new ${fresh}`,
    value: fresh,
  });
  items.push({ id: 'group:none', key: 'u', caption: 'ungroup', value: '' });
  return items;
};

// ctrl+g: the commit group of the focused task, the menu on its own one
const groupMenu = (page) => {
  const store = page.store;
  const row = page.focusedRow();
  if (!store || !row || row.type !== 'task') return;
  const items = groupItems(store);
  const own = row.task.item.id.toLowerCase();
  const pick = (id) => {
    const item = items.find((one) => one.id === id);
    page.closeEditor();
    store.editTask(row.task.id, (task) => task.setId(item.value));
    page.followRow(row);
    page.ui.flushReview(true);
  };
  openItems(page, items, pick);
  const at = items.findIndex((item) => item.value === own && own);
  if (at >= 0) page.nav.contextMenu.cursor = at;
};

// The block the focused block is in, for the closed block combo
const blockName = (page) => {
  const row = page.focusedRow();
  const block = row && row.block;
  if (!block) return 'none';
  const head = block.type === 'heading' ? block : block.heading;
  return head ? head.text : 'none';
};

// `s`: the kinds and `custom…` in the plan combo
const toggleBlockMenu = (page) => {
  if (page.planPick) return void page.closePlanMenu();
  page.closeEditor();
  const labels = blockLabels();
  const at = Math.max(0, labels.indexOf(blockName(page)));
  page.planPick = new MenuPick('block', at);
};

// A custom heading goes after the focused block and is named at once
const addCustomBlock = (page) => {
  const store = page.store;
  const row = page.focusedRow();
  const anchor = row && row.block;
  const at = anchor ? store.doc.indexOf(anchor) + 1 : store.doc.blocks.length;
  const head = store.addHeadedBlock(at, CUSTOM_TITLE);
  page.followRow({ block: head });
  page.composer.openCompose('tasks', CUSTOM_TITLE, head.id);
  page.composer.editor.selectAll();
};

// A kind that exists is a jump; a missing one is added in kind order with
// a first task to fill
const chooseBlock = (page, label) => {
  const store = page.store;
  if (!store || !label) return;
  if (label === CUSTOM_BLOCK) return void addCustomBlock(page);
  const kind = TASK_KINDS.find((entry) => entry.title === label);
  if (!kind) return;
  const had = store.kindHeading(kind.id);
  const head = store.addKindBlock(kind.id);
  page.followRow({ block: head });
  page.ui.flushReview(true);
  if (!had) page.startDraft(head.id, kind.id);
};

module.exports = {
  startTaskFind,
  openNote,
  openFocused,
  dropBlock,
  toggleDone,
  remember,
  recall,
  fieldMenu,
  priorityMenu,
  groupMenu,
  blockName,
  toggleBlockMenu,
  chooseBlock,
};
