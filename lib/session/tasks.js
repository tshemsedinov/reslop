'use strict';

const path = require('node:path');
const { clamp } = require('../common/utilities.js');
const files = require('../common/files.js');
const { isTasksEntry, TASKS_FILE, TASK_KINDS, REVIEW_DIR } = files;
const { bare } = require('../review/markdown.js');
const blocks = require('../review/blocks.js');
const { isInstructions, headingKind, sectionHead, blockKind } = blocks;
const review = require('../review/review.js');
const { checkLabel, orderedPlanNames, allocateReviewPath } = review;
const { planKey, planPart, alignPlanLabels } = require('./agents/plans.js');
const editorPart = require('../input/editor.js');
const { MenuPick, menuRows, pickDelta, lineKey } = editorPart;
const { isTextKey } = require('../input/keys.js');

const TASK_TYPE_SKIP = [
  'enter',
  'escape',
  'tab',
  'backspace',
  'delete',
  'left',
  'right',
  'up',
  'down',
  'home',
  'end',
  'pageUp',
  'pageDown',
  'j',
  'k',
  'n',
  'p',
  'q',
  'f',
  'd',
  't',
  'i',
  'b',
  'r',
  'c',
];

const isTaskTypeKey = (key) => {
  if (!isTextKey(key) || key === ' ') return false;
  return !TASK_TYPE_SKIP.includes(key);
};

const idlePick = () => false;
const NEW_PLAN = '<new plan>';
const PLAN_ROWS = 8;
const EMPTY_HINT = 'Insert task · s section · e markdown';

const planListSize = (ui) => {
  const frame = ui.lastFrame;
  const height = frame && frame.height ? frame.height : ui.getSize().height;
  const room = Math.max(1, height - 3);
  return Math.min(room, PLAN_ROWS);
};

const planOpenScroll = (cursor, extra, count, size) => {
  const span = Math.abs(extra - cursor);
  const end = span < size ? Math.max(cursor, extra) : cursor;
  const start = Math.max(0, end - size + 1);
  const maxStart = Math.max(0, count - size);
  return Math.min(start, maxStart);
};

// The keys the plan menu takes before its query does
const PLAN_KEYS = {
  escape: (tasks) => tasks.closePlanMenu(),
  enter: (tasks, pick) => tasks.choosePlan(pick.cursor),
  ' ': () => {},
};

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

// The first row a plan opens on: past the folded instructions
const firstRow = (rows) => {
  const at = rows.findIndex((row) => !row.block || !isInstructions(row.block));
  return Math.max(0, at);
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

class TaskPage {
  constructor(composer) {
    this.composer = composer;
    this.planPick = null;
    this.draft = null;
    this.dropId = null;
    this.dropName = '';
  }

  get ui() {
    return this.composer.ui;
  }

  get nav() {
    return this.composer.ui.nav;
  }

  get store() {
    return this.ui.review?.store ?? null;
  }

  isOpen() {
    return this.nav.pane === 'tasks';
  }

  rows() {
    const store = this.store;
    if (!store) return [];
    const tasks = new Map(store.tasks.map((task) => [task.id, task]));
    const draft = this.composing() ? this.draft : null;
    const rows = [];
    let placed = false;
    let fold = 0;
    for (const block of store.doc.layout()) {
      if (block.type === 'blank' || block.type === 'frontmatter') continue;
      if (block.type === 'heading') {
        if (fold && block.level > fold) continue;
        if (isPlanTitle(block, store.reviewPath)) continue;
        fold = isInstructions(block) ? block.level : 0;
      } else if (fold) {
        continue;
      }
      rows.push(blockRow(block, tasks));
      if (draft && draft.after === block.id) {
        rows.push({ type: 'draft', draft: true, kind: draft.kind });
        placed = true;
      }
    }
    if (draft && !placed) {
      rows.push({ type: 'draft', draft: true, kind: draft.kind });
    }
    if (rows.every((row) => !isEditable(row))) {
      rows.push({ type: 'hint', draft: false });
    }
    return rows;
  }

  rowAt(index) {
    return this.rows()[index] ?? null;
  }

  rowIndex(dest) {
    if (!dest) return 0;
    const at = this.rows().findIndex((row) => sameRow(row, dest));
    return Math.max(0, at);
  }

  composing() {
    return this.composer.composeKind === 'tasks';
  }

  editingId() {
    return this.composing() ? this.composer.composeTaskId : null;
  }

  canToggle() {
    if (!this.isOpen()) return false;
    return this.ui.mode === 'review';
  }

  focusedRow() {
    return this.rowAt(this.clampedTaskFocus());
  }

  focusedKind() {
    const row = this.focusedRow();
    if (!row || !row.block) return TASK_KINDS[0].id;
    return blockKind(row.block) || TASK_KINDS[0].id;
  }

  closeEditor() {
    this.composer.commitCompose();
    this.composer.closeCompose();
  }

  isLive(row, at) {
    if (!this.composing() || !this.composer.editor) return false;
    if (at !== this.clampedTaskFocus()) return false;
    return this.sameCompose(row, at);
  }

  // What the renderer draws for a row; the row being edited shows the editor
  viewRow(row, at, progress) {
    if (this.isLive(row, at)) {
      const text = this.composer.editor.text;
      const plain = row.type === 'heading' || row.type === 'text';
      const done = row.task ? row.task.done : Boolean(row.note?.done);
      return { type: 'label', text: plain ? text : checkLabel(text, done) };
    }
    if (row.type === 'heading') {
      const { block } = row;
      const counts = progress.get(block.id);
      const aside = counts ? `${counts.done}/${counts.total}` : '';
      const folded = isInstructions(block);
      return {
        type: 'heading',
        text: block.text,
        level: block.level,
        aside,
        folded,
      };
    }
    if (row.type === 'task') {
      const { item } = row.task;
      return {
        type: 'task',
        done: item.done,
        id: item.id,
        priority: item.priority,
        title: item.title,
        aside: checkAside(item),
      };
    }
    if (row.type === 'text') {
      const lang = row.block.fence ? fenceLang(row.block) : undefined;
      return { type: 'text', text: blockText(row.block), lang };
    }
    if (row.type === 'hint') return { type: 'text', text: EMPTY_HINT };
    return { type: 'label', text: rowLabel(row) };
  }

  taskRows() {
    if (!this.isOpen()) return [];
    const store = this.store;
    const progress = kindProgress(store ? store.tasks : []);
    return this.rows().map((row, at) => this.viewRow(row, at, progress));
  }

  taskTexts() {
    if (!this.isOpen()) return [];
    return this.rows().map((row, at) => {
      if (!this.isLive(row, at)) return rowLabel(row);
      return this.viewRow(row, at, new Map()).text;
    });
  }

  taskRowCount() {
    if (!this.isOpen()) return 0;
    return this.rows().length;
  }

  clampedTaskFocus() {
    return clamp(this.nav.tasksFocus, 0, this.taskRowCount() - 1);
  }

  moveTaskFocus(delta) {
    const count = this.taskRowCount();
    if (!count) return;
    this.nav.tasksFocus = clamp(this.clampedTaskFocus() + delta, 0, count - 1);
  }

  openTasksPage() {
    const nav = this.nav;
    nav.tasksOpen = true;
    nav.pane = 'tasks';
    nav.scroll = 0;
    nav.clearSelection();
    this.ui.syncReviewPath();
    if (!nav.tasksFocus) nav.tasksFocus = firstRow(this.rows());
  }

  // The last block of the first section of a kind, where a new task of
  // that kind goes; null when the file has no such section
  kindTail(kind) {
    const store = this.store;
    const head = store ? store.kindHeading(kind) : null;
    if (!head) return null;
    const at = store.sectionTail(head);
    return store.doc.blocks[at - 1] ?? head;
  }

  // A new task that is not in the file until it has text
  startDraft(after, kind) {
    this.draft = { after, kind };
    this.composer.openCompose('tasks', '', null);
    this.nav.tasksFocus = this.rowIndex({ type: 'draft', draft: true });
  }

  // A draft left empty is gone; the focus goes back to where it started
  dropDraft() {
    const draft = this.draft;
    this.draft = null;
    if (!draft || draft.after === null) return;
    this.followRow({ block: { id: draft.after } });
  }

  newTask() {
    const kind = TASK_KINDS[0].id;
    const tail = this.kindTail(kind);
    this.startDraft(tail ? tail.id : null, kind);
  }

  editFocusedTask() {
    if (!this.isOpen()) return;
    const row = this.focusedRow();
    if (!row || row.type === 'hint') return void this.newTask();
    if (row.draft) return void this.startDraft(this.draft?.after, row.kind);
    if (row.quote) return void this.composer.openQuote(row.key, row.note.text);
    if (!isEditable(row)) return;
    const text = row.task ? row.task.text : editText(row.block);
    this.composer.openCompose('tasks', text, row.block.id);
  }

  moveTaskCompose(delta, width, extend) {
    if (!this.isOpen()) return;
    const editor = this.composer.editor;
    if (editor && width) {
      const before = editor.cursor;
      editor.moveLine(delta, width, extend);
      if (editor.cursor !== before || extend) return;
    }
    const rows = this.rows();
    const at = this.clampedTaskFocus();
    let next = clamp(at + delta, 0, rows.length - 1);
    const back = delta > 0 ? -1 : 1;
    while (next !== at && !isEditable(rows[next])) next += back;
    if (next === at) return;
    const dest = rows[next];
    this.composer.commitCompose();
    this.ui.flushReview();
    this.composer.closeCompose();
    this.nav.tasksFocus = this.rowIndex(dest);
    this.editFocusedTask();
  }

  typeIntoTask(key) {
    if (!this.canToggle() || !isTaskTypeKey(key)) return false;
    const row = this.focusedRow();
    if (row && !isEditable(row) && row.type !== 'hint') return false;
    this.editFocusedTask();
    this.composer.editor.insert(key);
    return true;
  }

  // A heading with blocks under it asks first: they go with it
  removeFocusedTask() {
    if (!this.isOpen()) return;
    const row = this.focusedRow();
    if (!row || row.draft || row.type === 'hint') return;
    const { block } = row;
    if (row.type === 'heading' && this.store.sectionBlocks(block).length) {
      this.dropId = block.id;
      this.dropName = `section ${block.text}`;
      this.ui.mode = 'confirmDrop';
      this.ui.status = '';
      return;
    }
    this.dropRow(row);
  }

  dropRow(row) {
    const nav = this.nav;
    dropRow(this.store, row);
    nav.tasksFocus = clamp(nav.tasksFocus, 0, this.rows().length - 1);
    this.ui.flushReview(true);
  }

  cancelDrop() {
    this.ui.mode = 'review';
    this.dropId = null;
    this.dropName = '';
  }

  confirmDrop() {
    const id = this.dropId;
    this.cancelDrop();
    const row = this.rows().find((one) => one.block && one.block.id === id);
    if (row) this.dropRow(row);
  }

  // Insert: a new task below the focused block, in its section
  insertBelow() {
    if (!this.isOpen()) return;
    const row = this.focusedRow();
    if (!row || row.draft) return;
    if (!row.block || isInstructions(row.block)) return void this.newTask();
    this.startDraft(row.block.id, blockKind(row.block) || TASK_KINDS[0].id);
  }

  // Enter at the end of a one-line task, or on a heading, saves it and
  // starts a new task below; anywhere else it is a new line
  enterNext() {
    const { editor, composeQuoteKey } = this.composer;
    if (!editor || composeQuoteKey || !this.store) return false;
    const row = this.focusedRow();
    if (!row) return false;
    const heading = row.type === 'heading';
    if (!heading && row.type !== 'task' && !row.draft) return false;
    const text = editor.text;
    const atEnd = editor.cursor === text.length && !text.includes('\n');
    if (!heading && (!atEnd || !text.trim())) return false;
    this.composer.commitCompose();
    const id = this.composer.composeTaskId;
    if (id === null) return false;
    this.ui.flushReview();
    this.composer.closeCompose();
    this.followRow({ block: { id } });
    this.insertBelow();
    return true;
  }

  toggleRow(row) {
    const store = this.store;
    if (row.quote) store.setFeedbackDone(row.key, !row.note.done);
    else if (row.task) store.setTaskDone(row.task.id, !row.task.done);
    else return false;
    return true;
  }

  toggleFocusedTask() {
    if (!this.canToggle()) return false;
    const row = this.focusedRow();
    if (!row || !this.toggleRow(row)) return false;
    this.ui.flushReview(true);
    return true;
  }

  followRow(dest) {
    this.nav.tasksFocus = this.rowIndex(dest);
  }

  moveIssue(delta) {
    if (!this.isOpen() || !delta) return;
    const row = this.focusedRow();
    if (!row || !row.block) return;
    this.composer.commitCompose();
    if (!moveRow(this.store, row, delta)) return;
    this.composer.closeCompose();
    this.followRow(row);
    this.ui.flushReview(true);
  }

  sameCompose(row, cursor) {
    const composer = this.composer;
    if (cursor !== this.clampedTaskFocus()) return false;
    if (row.draft) {
      return composer.composeTaskId === null && !composer.composeQuoteKey;
    }
    if (row.quote) return composer.composeQuoteKey === row.key;
    return Boolean(row.block) && row.block.id === composer.composeTaskId;
  }

  onTaskHit(cursor) {
    if (!this.isOpen()) return;
    this.closePlanMenu();
    const row = this.rowAt(cursor);
    if (!row) return;
    if (this.composing()) {
      if (this.sameCompose(row, cursor)) return;
      this.closeEditor();
    }
    this.nav.tasksFocus = this.rowIndex(row);
    this.editFocusedTask();
  }

  onTaskCheck(cursor) {
    if (!this.isOpen()) return;
    const row = this.rowAt(cursor);
    if (!row || (!row.task && !row.quote)) return void this.onTaskHit(cursor);
    if (this.composing() && !this.sameCompose(row, cursor)) this.closeEditor();
    this.toggleRow(row);
    this.nav.tasksFocus = this.rowIndex(row);
    this.ui.flushReview(true);
  }

  onTasks() {
    const { nav } = this;
    if (nav.pane === 'files') {
      const entry = this.ui.fileCursorEntry();
      if (entry && !isTasksEntry(entry)) {
        nav.index = entry.openIndex ?? entry.firstIndex;
      }
    }
    this.openTasksPage();
    this.newTask();
  }

  taskEditView() {
    const { composeKind, editor } = this.composer;
    if (composeKind !== 'tasks' || !editor) return null;
    return { cursor: editor.cursor, anchor: editor.anchor };
  }

  commitTask(text) {
    const notes = this.store;
    const key = this.composer.composeQuoteKey;
    if (key) {
      const note = notes.feedback.get(key);
      if (!note) return;
      notes.setFeedback(key, { ...note, text });
      return;
    }
    const id = this.composer.composeTaskId;
    if (id !== null && notes.doc.byId(id)) {
      return void notes.setBlockText(id, text);
    }
    if (!text.trim()) return;
    const draft = this.draft ?? { after: null, kind: this.focusedKind() };
    const after =
      draft.after !== null && notes.doc.byId(draft.after) ? draft.after : null;
    const todo = notes.addTask(TASKS_FILE, text, false, draft.kind, after);
    this.composer.composeTaskId = todo.id;
    this.draft = null;
    this.followRow({ block: todo.block });
  }

  planName() {
    const store = this.ui.review.store;
    if (!store || !store.reviewPath) return '';
    return path.basename(store.reviewPath);
  }

  planNames() {
    const names = orderedPlanNames(this.ui.root);
    const current = this.planName();
    if (current && !names.includes(current)) names.push(current);
    return names;
  }

  planLabels() {
    const root = this.ui.root;
    const dir = path.join(root, REVIEW_DIR);
    const store = this.ui.review.store;
    const parts = this.planNames().map((name) => planPart(dir, name, store));
    const labels = alignPlanLabels(parts.filter(Boolean));
    labels.push(NEW_PLAN);
    return labels;
  }

  planMenu() {
    const labels = this.planLabels();
    if (!this.planPick) return labels;
    return this.planPick.filter(labels);
  }

  planQuery() {
    return this.planPick ? this.planPick.query : '';
  }

  planScroll() {
    return this.planPick ? this.planPick.scroll : 0;
  }

  view(active) {
    const pick = this.planPick;
    return {
      tasks: this.taskTexts(),
      taskRows: this.taskRows(),
      tasksFocus: this.clampedTaskFocus(),
      taskEdit: this.taskEditView(),
      planName: this.planName(),
      planNames: active && pick ? this.planMenu() : [],
      planOpen: this.planOpen,
      planCursor: this.planCursor,
      planScroll: this.planScroll(),
      planQuery: this.planQuery(),
      planEditor: pick ? pick.editor : null,
    };
  }

  get planOpen() {
    return this.planPick !== null;
  }

  get planCursor() {
    return this.planPick ? this.planPick.cursor : 0;
  }

  closePlanMenu() {
    this.planPick = null;
  }

  togglePlanMenu() {
    if (this.planPick) return void this.closePlanMenu();
    const labels = this.planLabels();
    if (!labels.length) return;
    const current = this.planName();
    const at = labels.findIndex((item) => planKey(item) === current);
    const cursor = at < 0 ? labels.length - 1 : at;
    const extra = labels.length - 1;
    const size = planListSize(this.ui);
    this.planPick = new MenuPick('plan', cursor);
    this.planPick.scroll = planOpenScroll(cursor, extra, labels.length, size);
  }

  movePlan(delta) {
    const pick = this.planPick;
    const items = this.planMenu();
    if (!pick || !items.length) return;
    pick.move(delta, items, idlePick);
  }

  planStep(key) {
    const body = this.ui.lastFrame && this.ui.lastFrame.bodyH;
    return pickDelta(key, menuRows(body), menuRows(body, 0.5));
  }

  notePlanEdit(changed) {
    if (changed) this.planPick.touch();
  }

  onPlanKey(key) {
    const pick = this.planPick;
    if (!pick) return;
    const own = PLAN_KEYS[key];
    if (own) return void own(this, pick);
    const handled = lineKey(pick.editor, key, this.ui, false);
    if (handled) return void this.notePlanEdit(handled === 'text');
    const step = this.planStep(key);
    if (step) this.movePlan(step);
  }

  openPlan(name) {
    if (!name || name === this.planName()) return;
    this.composer.commitCompose();
    this.composer.closeCompose();
    const dir = this.ui.root;
    if (!this.ui.review.usePlan(dir, name)) return;
    this.nav.tasksFocus = firstRow(this.rows());
    this.nav.scroll = 0;
    this.draft = null;
    this.ui.lifecycle.noteReviewStamp();
  }

  createPlan() {
    const dir = this.ui.root;
    const reviewPath = allocateReviewPath(dir, new Date(), this.planNames());
    this.openPlan(path.basename(reviewPath));
  }

  choosePlan(index) {
    const label = this.planMenu()[index];
    const name = label ? planKey(label) : '';
    this.closePlanMenu();
    if (name === NEW_PLAN) return void this.createPlan();
    this.openPlan(name);
  }
}

module.exports = { TaskPage };
