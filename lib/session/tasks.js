'use strict';

const path = require('node:path');
const { clamp } = require('../common/utilities.js');
const files = require('../common/files.js');
const { isTasksEntry, TASKS_FILE, TASK_KINDS } = files;
const blocks = require('../review/blocks.js');
const { isInstructions, blockKind } = blocks;
const review = require('../review/review.js');
const { checkLabel, orderedPlanNames, allocateReviewPath } = review;
const { planNameOf } = review;
const { planKey, planPart, alignPlanLabels } = require('./plans.js');
const editorPart = require('../input/editor.js');
const { MenuPick, menuRows, pickDelta, lineKey } = editorPart;
const clipboard = require('../term/select.js');
const { blockText } = require('../review/markdown.js');
const { labelBodyWidth } = require('../render/notes.js');
const taskActions = require('./task-actions.js');
const { openNote, fieldMenu, blockName, chooseBlock } = taskActions;
const { remember, recall } = taskActions;
const rowParts = require('./task-rows.js');
const {
  checkAside,
  dropEmptyFields,
  draftHeading,
  dropRow,
  editText,
  fenceLang,
  fieldText,
  firstRow,
  hiddenParts,
  isFieldStub,
  isEditable,
  isInstructionsRow,
  kindProgress,
  moveRow,
  noteView,
  planRows,
  rowLabel,
  sameRow,
  blockLabels,
  blockSummary,
  blockPeek,
} = rowParts;

const idlePick = () => false;
const NEW_PLAN = '<new plan>';
const BLOCK_LEAD = 'Block: ';
const PLAN_ROWS = 8;

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

// Done and total tasks of a kind block, beside its heading
const headAside = (progress, block) => {
  const counts = progress.get(block.id);
  return counts ? `${counts.done}/${counts.total}` : '';
};

// The keys of the screen besides its actions: ctrl+z takes back a drop once
// the text has nothing left to undo, ctrl+c copies the block without a
// selection
const TASK_KEYS = {
  'ctrl-z': (tasks) => tasks.undo(),
  'ctrl-c': (tasks) => tasks.copy(),
  tab: (tasks) => {
    if (tasks.ui.mode !== 'review') return false;
    tasks.toggleExpand();
    return true;
  },
  'shift-tab': (tasks) => tasks.toggleExpandAll(),
};

class TaskPage {
  constructor(composer) {
    this.composer = composer;
    this.planPick = null;
    this.draft = null;
    this.dropId = null;
    this.dropName = '';
    this.dropped = null;
    this.keep = null;
    this.enterAt = 'start';
    this.instructionsOpen = false;
    this.foldedBlocks = new Set();
    this.findQuery = '';
    this.memory = new Map();
    this.allOpen = false;
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

  // The rows are read many times a frame; they change with the doc and the
  // draft, so they are built once for each of those
  rows() {
    const store = this.store;
    if (!store) return [];
    const { doc } = store;
    const draft = this.composing() ? this.draft : null;
    const open = this.instructionsOpen;
    const folded = this.foldedBlocks;
    const memo = this.memo;
    const same =
      memo &&
      memo.doc === doc &&
      memo.version === doc.version &&
      memo.draft === draft &&
      memo.open === open &&
      memo.folded === folded &&
      memo.path === store.reviewPath;
    if (same) return memo.rows;
    const rows = planRows(store, draft, { instructions: open, folded });
    const path = store.reviewPath;
    this.memo = {
      doc,
      version: doc.version,
      draft,
      open,
      folded,
      path,
      rows,
      progress: null,
    };
    return rows;
  }

  // What a folded block shows under its heading: its first lines, or a
  // count of what it holds; kept with the rows
  foldView(block) {
    const memo = this.memo;
    if (!memo.folds) memo.folds = new Map();
    let view = memo.folds.get(block.id);
    if (!view) {
      const peek = blockPeek(this.store, block);
      view = { peek, hidden: peek ? '' : blockSummary(this.store, block) };
      memo.folds.set(block.id, view);
    }
    return view;
  }

  // Done and total tasks for each kind heading, kept with the rows
  progress() {
    const memo = this.memo;
    if (!memo) return new Map();
    if (!memo.progress) memo.progress = kindProgress(this.store.tasks);
    return memo.progress;
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

  // The screen takes its keys while a block is edited or none can be
  canToggle() {
    if (!this.isOpen()) return false;
    return this.ui.mode === 'review' || this.ui.mode === 'compose';
  }

  focusedRow() {
    return this.rowAt(this.clampedTaskFocus());
  }

  // The edited block is written back; its cursor is kept for when the
  // same block is edited again
  closeEditor() {
    const { editor, composeTaskId } = this.composer;
    if (!this.composing() || !editor) return;
    this.composer.commitCompose();
    const id = this.composer.composeTaskId ?? composeTaskId;
    this.keep = { id, cursor: editor.cursor, text: editor.text };
    this.composer.dropEditor();
    this.ui.flushReview();
  }

  // The tasks screen has one mode: the focused block is always in the
  // editor, a new task when the plan is empty. A code proposal and the
  // instructions heading are only focused
  settle() {
    const ui = this.ui;
    // A read in flight, such as a file opening, comes first
    if (!this.isOpen() || ui.mode !== 'review' || ui.ops.holds) return;
    if (this.planPick || this.nav.contextMenu) return;
    const status = ui.status;
    const row = this.focusedRow();
    if (!this.rows().some(isEditable)) {
      if (!this.store) return;
      this.newTask();
    } else if (row && isEditable(row)) {
      this.editFocusedTask();
    }
    ui.status = status;
  }

  // The row being edited
  isLive(row, at) {
    return this.composing() && this.sameCompose(row, at);
  }

  // A block as its text, the way the editor shows it, so nothing moves
  // when the editor opens on it or closes
  textRow(row, text, progress) {
    const plain = row.type === 'heading' || row.type === 'text';
    const done = row.task ? row.task.done : Boolean(row.note?.done);
    const gap = row.type === 'heading';
    const folded = gap && this.foldedBlocks.has(row.block.id);
    const { peek, hidden } = folded ? this.foldView(row.block) : {};
    return {
      type: 'label',
      text: plain ? text : checkLabel(text, done),
      gap,
      hidden,
      peek,
      shape: row.draft ? 'task' : row.type,
      level: row.block?.level,
      aside: gap ? headAside(progress, row.block) : '',
    };
  }

  // What the renderer draws for a row
  viewRow(row, at, progress) {
    if (this.isLive(row, at)) {
      return this.textRow(row, this.composer.editor.text, progress);
    }
    if (row.type === 'heading') {
      const { block } = row;
      const aside = headAside(progress, block);
      const own = isInstructions(block);
      const open = own && this.instructionsOpen;
      const folded = own ? !open : this.foldedBlocks.has(block.id);
      const { peek, hidden } = folded ? this.foldView(block) : {};
      return {
        type: 'heading',
        text: block.text,
        level: block.level,
        aside,
        folded,
        open,
        hidden,
        peek,
      };
    }
    if (row.type === 'task') {
      const { item } = row.task;
      if (this.isExpanded(row, at)) {
        return this.textRow(row, row.task.text, progress);
      }
      return {
        type: 'task',
        done: item.done,
        head: item.head,
        id: item.id,
        priority: item.priority,
        title: item.title,
        hidden: hiddenParts(item),
        checks: checkAside(item),
        complete:
          item.checks.length > 0 && item.checks.every((one) => one.done),
      };
    }
    if (row.type === 'text') {
      const lang = row.block.fence ? fenceLang(row.block) : undefined;
      return { type: 'text', text: blockText(row.block), lang };
    }
    if (row.quote || row.type === 'code') return noteView(row);
    return { type: 'label', text: rowLabel(row) };
  }

  taskRows() {
    if (!this.isOpen()) return [];
    const rows = this.rows();
    const progress = this.progress();
    const out = [];
    rows.forEach((row, at) => {
      const head = row.draft ? draftHeading(this.store, this.draft, row) : null;
      if (head) out.push(head);
      out.push(this.viewRow(row, at, progress));
    });
    return out;
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
    const next = clamp(this.clampedTaskFocus() + delta, 0, count - 1);
    this.stepTo(this.rowAt(next), delta, this.focusedRow());
  }

  // A step up from below onto the agent instructions opens them on their
  // last line, the one next to where the focus came from
  stepTo(dest, delta, from) {
    this.enterAt = delta > 0 ? 'start' : 'end';
    this.followRow(dest);
    if (delta !== -1 || !dest?.block || !isInstructions(dest.block)) return;
    if (from && isInstructionsRow(from)) return;
    const rows = this.rows();
    let at = this.clampedTaskFocus();
    while (rows[at + 1]?.instructions) at += 1;
    this.nav.tasksFocus = at;
  }

  // The focused task shows its text, as do all of them after Shift+Tab
  isExpanded(row, at) {
    if (!row || row.type !== 'task') return false;
    return this.allOpen || at === this.clampedTaskFocus();
  }

  // Tab folds a heading and opens the field menu of a task
  toggleExpand() {
    const at = this.clampedTaskFocus();
    const row = this.rowAt(at);
    if (row && row.block && isInstructions(row.block)) {
      return void this.toggleInstructions();
    }
    if (row && row.type === 'heading') return void this.toggleFold(row.block);
    this.fieldFromFocus();
  }

  // Tab on a block heading folds it; the file is not changed
  toggleFold(head) {
    const folded = new Set(this.foldedBlocks);
    if (folded.has(head.id)) folded.delete(head.id);
    else folded.add(head.id);
    this.foldedBlocks = folded;
  }

  // The agent instructions open under their heading to be read
  toggleInstructions() {
    this.instructionsOpen = !this.instructionsOpen;
  }

  toggleExpandAll() {
    this.allOpen = !this.allOpen;
  }

  onKey(key) {
    if (!this.canToggle()) return false;
    const own = TASK_KEYS[key];
    if (!own) return false;
    return own(this) !== false;
  }

  // ctrl+s: the agents screen with this plan chosen, to pick the agent,
  // model, and effort before the run starts
  toAgents() {
    const store = this.store;
    if (!store) return;
    this.closeEditor();
    this.ui.flushReview(true);
    this.ui.agents.planPath = store.reviewPath;
    this.ui.agents.open();
  }

  // ctrl+c copies the selected text, else the focused block as Markdown
  copy() {
    const editor = this.composing() ? this.composer.editor : null;
    if (editor && editor.hasSelect()) return false;
    if (this.nav.selection) return false;
    const row = this.focusedRow();
    if (row && row.block) {
      if (clipboard.copyText(blockText(row.block), this.ui.stdout)) {
        this.ui.status = 'copied';
      }
    }
    return true;
  }

  // The field menu of the focused task, from its row menu
  fieldFromFocus() {
    const row = this.focusedRow();
    if (!row || row.type !== 'task') return;
    if (!this.isLive(row, this.clampedTaskFocus())) {
      this.closeEditor();
      this.editFocusedTask();
      const editor = this.composer.editor;
      editor.place(editor.text.length);
    }
    fieldMenu(this);
  }

  // Tab while editing a task opens the menu of the fields it does not
  // have; a field's key adds it
  tabField() {
    const row = this.focusedRow();
    if (row && row.type === 'heading') return void this.toggleFold(row.block);
    fieldMenu(this);
  }

  isTaskEdit() {
    const row = this.focusedRow();
    return Boolean(row) && (row.type === 'task' || row.draft);
  }

  // A field goes on the line the cursor is on when it is empty or a `- `
  // stub, else after the text; the cursor goes to its value
  addField(key) {
    const editor = this.composer.editor;
    if (!editor) return;
    const { text, cursor } = editor;
    const { lo, hi } = editor.lineSpan(cursor);
    const field = fieldText(key);
    if (lo > 0 && isFieldStub(text.slice(lo, hi))) {
      const next = text.slice(0, lo) + field + text.slice(hi);
      return void editor.edit(next, lo + field.length);
    }
    const next = `${text.replace(/\s+$/, '')}\n${field}`;
    editor.edit(next, next.length);
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

  // The last part of the first block of a kind, where a new task of
  // that kind goes; null when the file has no such block
  kindTail(kind) {
    const store = this.store;
    const head = store ? store.kindHeading(kind) : null;
    if (!head) return null;
    const at = store.blockTail(head);
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
    if (!row) return void this.newTask();
    if (row.draft) return void this.startDraft(this.draft?.after, row.kind);
    if (row.quote) return void this.composer.openQuote(row.key, row.note.text);
    if (row.block && isInstructions(row.block)) {
      return void this.toggleInstructions();
    }
    if (row.type === 'code') return void openNote(this);
    if (!isEditable(row)) return;
    const text = row.task ? row.task.text : editText(row.block);
    this.composer.openCompose('tasks', text, row.block.id);
    this.placeCursor(row.block.id);
  }

  // Back on the block it was in, unchanged, the cursor is where it was;
  // coming from below it is on the last line, else at the end of the first
  placeCursor(id) {
    const editor = this.composer.editor;
    const keep = this.keep;
    this.keep = null;
    const same = keep && keep.id === id && keep.text === editor.text;
    if (same) editor.place(keep.cursor);
    else if (this.enterAt === 'start') editor.place(editor.lineSpan(0).hi);
    this.enterAt = 'start';
  }

  // The wrap width of the edited block as the screen paints it
  editWidth(width) {
    const at = this.clampedTaskFocus();
    const row = this.rowAt(at);
    if (!row) return labelBodyWidth({ text: '' }, width);
    return labelBodyWidth(this.viewRow(row, at, new Map()), width);
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
    const next = clamp(at + delta, 0, rows.length - 1);
    if (next === at) return;
    const dest = rows[next];
    this.composer.commitCompose();
    this.ui.flushReview();
    this.composer.dropEditor();
    this.stepTo(dest, delta, rows[at]);
  }

  // A heading with blocks under it asks first: they go with it
  removeFocusedTask() {
    if (!this.isOpen()) return;
    const row = this.focusedRow();
    if (!row || row.draft || !isEditable(row)) return;
    const { block } = row;
    if (row.type === 'heading' && this.store.blockContent(block).length) {
      this.dropId = block.id;
      this.dropName = `block ${block.text}`;
      this.ui.mode = 'confirmDrop';
      this.ui.status = '';
      return;
    }
    this.dropRow(row);
  }

  // A drop can be taken back with ctrl+z until the plan changes again
  dropRow(row) {
    const nav = this.nav;
    const { doc } = this.store;
    const text = doc.toString();
    const lines = row.block ? row.block.lines : null;
    dropRow(this.store, row);
    this.dropped = { doc, version: doc.version, text, lines };
    nav.tasksFocus = clamp(nav.tasksFocus, 0, this.rows().length - 1);
    this.ui.flushReview(true);
    this.ui.status = 'dropped · ctrl+z to undo';
  }

  // ctrl+z undoes typing in the edited block, then the last drop
  undo() {
    const editor = this.composing() ? this.composer.editor : null;
    if (editor && editor.undo.length) return false;
    this.closeEditor();
    this.undoDrop();
    return true;
  }

  undoDrop() {
    const undo = this.dropped;
    const { doc } = this.store;
    this.dropped = null;
    if (!undo || undo.doc !== doc || undo.version !== doc.version) {
      return void (this.ui.status = 'nothing to undo');
    }
    this.store.setText(undo.text);
    const same = (block) => block.lines.join('\n') === undo.lines?.join('\n');
    const back = this.store.doc.blocks.find(same);
    if (back) this.followRow({ block: back });
    this.ui.flushReview(true);
    this.ui.status = 'restored';
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

  // A new task below the focused part, in its block; the instructions
  // take none
  insertBelow() {
    if (!this.isOpen()) return;
    const row = this.focusedRow();
    if (!row || row.draft) return;
    if (!row.block || isInstructionsRow(row)) return void this.newTask();
    this.startDraft(row.block.id, blockKind(row.block) || TASK_KINDS[0].id);
  }

  // Enter breaks the line; a heading is one line, so it goes on to the
  // block below
  enterHeading() {
    const row = this.focusedRow();
    if (!this.composer.editor || !row || row.type !== 'heading') return false;
    this.moveTaskCompose(1, 0);
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

  // Focus on a row; the agent instructions are open while it is in them
  followRow(dest) {
    this.instructionsOpen = Boolean(dest && isInstructionsRow(dest));
    this.nav.tasksFocus = this.rowIndex(dest);
  }

  moveIssue(delta) {
    if (!this.isOpen() || !delta) return;
    const row = this.focusedRow();
    if (!row || !row.block) return;
    this.composer.commitCompose();
    if (!moveRow(this.store, row, delta)) return;
    this.composer.dropEditor();
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
    this.followRow(row);
  }

  onTaskCheck(cursor) {
    if (!this.isOpen()) return;
    const row = this.rowAt(cursor);
    if (!row || (!row.task && !row.quote)) return void this.onTaskHit(cursor);
    if (this.composing() && !this.sameCompose(row, cursor)) this.closeEditor();
    this.toggleRow(row);
    this.followRow(row);
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
    const block = id === null ? null : notes.doc.byId(id);
    const own = block && block.type !== 'task' ? text : dropEmptyFields(text);
    if (block) {
      const at = notes.doc.indexOf(block);
      notes.setBlockText(id, own);
      if (block.type !== 'task') this.followSplit(at, own);
      return;
    }
    if (!own.trim()) return;
    const draft = this.draft;
    if (!draft) return;
    const after =
      draft.after !== null && notes.doc.byId(draft.after) ? draft.after : null;
    const todo = notes.addTask(TASKS_FILE, own, false, draft.kind, after);
    this.composer.composeTaskId = todo.id;
    this.draft = null;
    this.followRow({ block: todo.block });
  }

  // Text that now reads as several blocks, an item typed under another,
  // goes on in the block the cursor is in, so it is not written twice
  followSplit(at, text) {
    const { doc } = this.store;
    const editor = this.composer.editor;
    const want = text.replace(/\s+$/, '').split('\n').length;
    if (!editor || !doc.blocks[at] || doc.blocks[at].lines.length >= want) {
      return;
    }
    const { col } = editor.linePos();
    let { line } = editor.linePos();
    let index = at;
    while (
      index < doc.blocks.length - 1 &&
      line >= doc.blocks[index].lines.length
    ) {
      line -= doc.blocks[index].lines.length;
      index += 1;
    }
    while (doc.blocks[index].type === 'blank' && index > at) index -= 1;
    const block = doc.blocks[index];
    const status = this.ui.status;
    this.followRow({ block });
    this.editFocusedTask();
    const lines = this.composer.editor.text.split('\n');
    const row = Math.min(line, lines.length - 1);
    const before = lines
      .slice(0, row)
      .reduce((sum, one) => sum + one.length + 1, 0);
    this.composer.editor.place(before + Math.min(col, lines[row].length));
    this.ui.status = status;
  }

  planName() {
    const store = this.ui.review.store;
    if (!store || !store.reviewPath) return '';
    return planNameOf(this.ui.root, store.reviewPath);
  }

  planNames() {
    const names = orderedPlanNames(this.ui.root);
    const current = this.planName();
    if (current && !names.includes(current)) names.push(current);
    return names;
  }

  planLabels() {
    const root = this.ui.root;
    const store = this.ui.review.store;
    const parts = this.planNames().map((name) => planPart(root, name, store));
    const labels = alignPlanLabels(parts.filter(Boolean));
    labels.push(NEW_PLAN);
    return labels;
  }

  isBlockMenu() {
    return this.planPick !== null && this.planPick.field === 'block';
  }

  // The plan files are read once when the menu opens, not on every key
  menuLabels() {
    if (this.isBlockMenu()) return blockLabels();
    return this.planPick?.labels ?? this.planLabels();
  }

  planMenu() {
    const labels = this.menuLabels();
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
      taskRows: this.taskRows(),
      tasksFocus: this.clampedTaskFocus(),
      taskEdit: this.taskEditView(),
      planName: this.isBlockMenu() ? blockName(this) : this.planName(),
      planLead: this.isBlockMenu() ? BLOCK_LEAD : undefined,
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
    this.planPick.labels = labels;
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
    this.closeEditor();
    const dir = this.ui.root;
    remember(this, this.memory);
    if (!this.ui.review.usePlan(dir, name)) return;
    this.resetView();
    this.nav.scroll = 0;
    if (!recall(this, this.memory)) {
      this.nav.tasksFocus = firstRow(this.rows());
    }
    this.ui.lifecycle.noteReviewStamp();
  }

  // A plan opens with its tasks closed and its blocks open
  resetView() {
    this.instructionsOpen = false;
    this.foldedBlocks = new Set();
    this.allOpen = false;
    this.draft = null;
  }

  createPlan() {
    const dir = this.ui.root;
    const reviewPath = allocateReviewPath(dir, new Date(), this.planNames());
    this.openPlan(path.basename(reviewPath));
  }

  choosePlan(index) {
    const label = this.planMenu()[index];
    if (this.isBlockMenu()) {
      this.closePlanMenu();
      return void chooseBlock(this, label);
    }
    const name = label ? planKey(label) : '';
    this.closePlanMenu();
    if (name === NEW_PLAN) return void this.createPlan();
    this.openPlan(name);
  }
}

module.exports = { TaskPage };
