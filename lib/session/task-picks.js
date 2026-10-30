'use strict';

const { TASK_KINDS } = require('../common/files.js');
const { fieldAction } = require('../input/actions.js');
const { MenuPick } = require('../input/editor.js');
const rowParts = require('./task-rows.js');
const { missingFields, blockLabels, CUSTOM_BLOCK, CUSTOM_TITLE } = rowParts;

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
  fieldMenu,
  priorityMenu,
  blockName,
  toggleBlockMenu,
  chooseBlock,
};
