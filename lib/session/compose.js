'use strict';

const { cursorInWrap, wrapDoc } = require('../term/wrap.js');
const render = require('../render/render.js');
const { noteInnerWidth, codeInnerWidth, activeDigits } = render;
const commits = require('../render/commits.js');
const { commitMessageWidth, wholeCommitMessage } = commits;
const { listedCommits } = require('./commit.js');
const { Editor, EDIT_OP, copyLine, cutLine } = require('../input/editor.js');
const { isTextKey, isNewlineKey } = require('../input/keys.js');
const files = require('../common/files.js');
const { itemPath, isTaskItem, isTasksEntry, listPath } = files;
const { isReadOnlyOrigin } = files;
const diff = require('../diff/diff.js');
const { blockAddText, fileLineIndex, addBlockRange } = diff;
const { itemFeedKey, itemWhere, canEditCode } = require('./items.js');
const review = require('../review/review.js');
const { checkLabel, rankedTemplates, prefixTemplates, TEMPLATE_SHOW } = review;
const { TaskPage } = require('./tasks.js');
const { dropBlock } = require('./task-actions.js');
const unit = require('./unit.js');
const clipboard = require('../term/select.js');
const { clamp } = require('../common/utilities.js');

class TemplatePick {
  constructor(composer) {
    this.composer = composer;
  }

  shownTemplates() {
    const notes = this.composer.ui.review.store;
    if (!notes) return [];
    const { composeKind, editor } = this.composer;
    if (composeKind && composeKind !== 'blockTask') return [];
    const ranked = rankedTemplates(notes.templates);
    const typed = composeKind && editor ? editor.text : '';
    if (ranked.some((entry) => entry.text === typed)) return [];
    return prefixTemplates(ranked, typed).slice(0, TEMPLATE_SHOW);
  }

  clampedTemplateIndex(shown) {
    if (!shown.length) return -1;
    return Math.min(this.composer.templateIndex, shown.length - 1);
  }

  clearTemplatePick() {
    this.composer.templateIndex = -1;
    this.composer.templateFocus = false;
  }

  focusTemplate(index, apply) {
    const shown = this.shownTemplates();
    if (!shown.length) return;
    let i = index;
    if (i < 0) i = shown.length - 1;
    if (i >= shown.length) i = 0;
    this.composer.templateIndex = i;
    this.composer.templateFocus = true;
    if (apply) this.composer.editor.replace(shown[i].text);
  }

  selectTemplate(index) {
    if (!this.shownTemplates().length) return null;
    this.focusTemplate(index, true);
    return this.composer.saveCompose();
  }

  applyTemplate() {
    const { composeKind, templateFocus, templateIndex } = this.composer;
    if (composeKind !== 'blockTask') return null;
    return this.selectTemplate(templateFocus ? templateIndex : 0);
  }
}

const COMPOSE_EDITS = [
  'backspace',
  'ctrl-backspace',
  'delete',
  'ctrl-z',
  'ctrl-y',
];

const COMPOSE_CLIP = ['ctrl-x', 'ctrl-v'];

const COMPOSE_LEAVE = ['next', 'prev', 'tasks'];

const KIND = {
  blockTask: { enter: 'save', tab: 'template', escape: 'save', move: 'note' },
  code: { enter: 'newline', tab: 'insert-tab', escape: 'save', move: 'code' },
  file: { enter: 'newline', tab: 'insert-tab', escape: 'save', move: 'code' },
  tasks: { enter: 'newline', tab: 'template', escape: 'save', move: 'tasks' },
  commit: { enter: 'save', tab: 'template', escape: 'cancel', move: 'note' },
  branch: { enter: 'save', tab: 'template', escape: 'cancel', move: 'note' },
  npm: { enter: 'save', tab: 'insert-tab', escape: 'cancel', move: 'note' },
  package: { enter: 'save', tab: 'insert-tab', escape: 'cancel', move: 'note' },
  worktree: { enter: 'save', tab: 'template', escape: 'cancel', move: 'note' },
};

const COMMAND_KINDS = ['commit', 'branch', 'npm', 'package', 'worktree'];

const TASK_PROMPT = 'task: ';

// The editors a task prompt opens over, to come back to after it
const SUSPENDS = ['file', 'code'];

const lineAt = (text, offset) => text.slice(0, offset).split('\n').length;

// `12` or `12-15`: the lines a selection covers, counted from `start`; one
// that ends at the start of a line leaves that line out
const selectedLines = (editor, start = 1) => {
  const { lo, hi } = editor.span();
  const first = lineAt(editor.text, lo) + start - 1;
  let last = lineAt(editor.text, hi) + start - 1;
  if (hi > lo && editor.text[hi - 1] === '\n') last -= 1;
  return last > first ? `${first}-${last}` : `${first}`;
};

const blockTarget = (item) => ({
  where: itemWhere(item),
  legacyKey: itemFeedKey(item),
});

const NOTE_VIEWS = ['blockTask', ...COMMAND_KINDS];

const itemNote = (item, text) => {
  const hunk = item.hunk;
  return {
    file: itemPath(item),
    oldStart: hunk ? hunk.oldStart : 0,
    newStart: hunk ? hunk.newStart : 0,
    blockId: item.blockId ?? 0,
    origin: item.origin,
    header: hunk ? hunk.header : '',
    text,
  };
};

const onEmptyLastLine = (editor) => {
  if (!editor) return false;
  const text = editor.text;
  const lastBreak = text.lastIndexOf('\n');
  if (editor.cursor < lastBreak + 1) return false;
  return text.slice(lastBreak + 1).trim() === '';
};

const filledLines = (text) =>
  text.split('\n').filter((line) => line.trim() !== '').length;

const blankTail = (text) => {
  const lines = text.split('\n');
  let count = 0;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (lines[i].trim() !== '') break;
    count += 1;
  }
  return count;
};

const EDITOR_KEYS = {};

for (const key of Object.keys(EDIT_OP)) {
  EDITOR_KEYS[key] = (c) => EDIT_OP[key](c.editor);
}

const COMPOSE_SPECIAL = {
  ...EDITOR_KEYS,
  up: (c) => c.moveLine(-1),
  down: (c) => c.moveLine(1),
  'shift-up': (c) => c.moveLine(-1, true),
  'shift-down': (c) => c.moveLine(1, true),
  home: (c) => c.home(),
  end: (c) => c.end(),
  'shift-home': (c) => c.home(true),
  'shift-end': (c) => c.end(true),
  pageUp: (c) => c.movePage(-1),
  pageDown: (c) => c.movePage(1),
  'ctrl-a': (c) => c.editor.selectAll(),
  'ctrl-e': (c) => c.editor.end(),
  'ctrl-c': (c) => c.copy(),
  'ctrl-x': (c) => c.cut(),
  'ctrl-v': (c) => c.paste(),
  'ctrl-z': (c) => c.editor.undoEdit(),
  'ctrl-y': (c) => c.editor.redoEdit(),
  'ctrl-t': (c) => {
    if (SUSPENDS.includes(c.composeKind)) c.onBlockTask();
  },
  tab: (c) => c.tab(),
};

class Composer {
  constructor(ui) {
    this.ui = ui;
    this.templates = new TemplatePick(this);
    this.tasks = new TaskPage(this);
    this.reset();
  }

  reset() {
    this.tasks.closePlanMenu();
    this.fileDirty = false;
    this.saving = false;
    this.suspended = null;
    this.clear();
  }

  clear() {
    if (this.tasks) this.tasks.dropDraft();
    this.editor = null;
    this.composeKind = null;
    this.commitKind = null;
    this.commitBody = '';
    this.composeTaskId = null;
    this.composeQuoteKey = null;
    this.composeBaseline = '';
    this.templateIndex = -1;
    this.templateFocus = false;
    this.fileEditRows = null;
    this.fileOpened = '';
    this.taskTarget = null;
  }

  get spec() {
    return KIND[this.composeKind] ?? null;
  }

  get notes() {
    return this.ui.review.store;
  }

  viewSize() {
    return this.ui.lastSize ?? this.ui.getSize();
  }

  canChange() {
    const caps = this.ui.capabilities;
    return Boolean(caps && caps.changes === true);
  }

  syncCodeScroll() {
    const kind = this.composeKind;
    if (kind !== 'code' && kind !== 'file') return;
    if (!this.editor) return;
    const width = this.viewSize().width;
    const digits = activeDigits(this.ui);
    this.editor.reveal(codeInnerWidth(width, this.ui.layout, digits));
  }

  followFileEdit() {
    if (this.composeKind !== 'file') return;
    const ui = this.ui;
    const text = this.editor ? this.editor.text : null;
    const rel = ui.nav.reviewPath;
    const rows = unit.linesFor(ui, rel, text, this.fileEditRows);
    unit.followFileCursor(ui.nav, this.editor, ui.lastFrame, rows);
  }

  openCompose(kind, text, taskId = null) {
    this.ui.mode = 'compose';
    this.composeKind = kind;
    this.composeTaskId = taskId;
    this.composeQuoteKey = null;
    this.composeBaseline = text;
    this.fileOpened = kind === 'file' ? text : '';
    this.editor = new Editor(text);
    this.templateIndex = -1;
    this.templateFocus = false;
    this.ui.status = '';
    this.ui.nav.clearSelection();
  }

  openQuote(key, text) {
    this.openCompose('tasks', text, null);
    this.composeQuoteKey = key;
  }

  closeCompose() {
    const ui = this.ui;
    if (this.resumeEditor()) return;
    this.dropEditor();
    ui.clampIndex();
    ui.syncReviewPath();
    ui.syncFileCursor();
  }

  // The tasks screen swaps the block in the editor without the files list
  // following it
  dropEditor() {
    this.ui.mode = 'review';
    this.clear();
  }

  liveFileText() {
    const kept = this.suspended;
    const kind = kept ? kept.composeKind : this.composeKind;
    const editor = kept ? kept.editor : this.editor;
    return kind === 'file' && editor ? editor.text : null;
  }

  writesCodeFile(item) {
    if (!canEditCode(item) || !this.canChange()) return false;
    if (isReadOnlyOrigin(item.origin)) return false;
    return Boolean(this.ui.repo.edit);
  }

  // The task on a diff block, found in the plan by its `where`
  blockTaskOf(item) {
    return this.notes.blockTask(itemWhere(item), itemFeedKey(item));
  }

  targetTask() {
    const target = this.taskTarget;
    if (!target) return this.blockTaskOf(this.ui.current());
    return this.notes.blockTask(target.where, target.legacyKey);
  }

  // `task: [ ] `, with the mark the block's task has
  blockTaskPrompt(note = this.targetTask()) {
    return `${TASK_PROMPT}${checkLabel('', Boolean(note?.done))}`;
  }

  // Where a new task points: a diff block; in the file view the selected
  // lines, else the diff block at the cursor, else the line
  blockTaskTarget() {
    const ui = this.ui;
    if (ui.nav.pane !== 'unit') return this.diffTaskTarget();
    const rel = ui.nav.reviewPath;
    if (!rel) return null;
    const editor = this.composeKind === 'file' ? this.editor : null;
    if (editor?.hasSelect()) {
      return { where: `${rel}:${selectedLines(editor)}`, legacyKey: '' };
    }
    let rows = unit.linesFor(ui, rel);
    let at = ui.nav.unitLine;
    if (editor) {
      rows = unit.linesFor(ui, rel, editor.text, this.fileEditRows);
      at = fileLineIndex(rows, editor.linePos().line);
    }
    const row = rows[at];
    if (row?.item && row.type !== 'ctx') return blockTarget(row.item);
    return { where: `${rel}:${row?.newNo ?? at + 1}`, legacyKey: '' };
  }

  // An edit of a block's added lines names the lines selected in the file
  diffTaskTarget() {
    const item = this.ui.current();
    if (!item || isTaskItem(item)) return null;
    const editor = this.composeKind === 'code' ? this.editor : null;
    if (!editor?.hasSelect() || !item.hunk) return blockTarget(item);
    const { start } = addBlockRange(item.hunk, item.blockId);
    const lines = selectedLines(editor, start);
    return { where: `${itemPath(item)}:${lines}`, legacyKey: '' };
  }

  commitBlockTask(text) {
    const target = this.taskTarget;
    if (!target) return;
    this.notes.setBlockTask(target.where, { text }, target.legacyKey);
  }

  // The editor waits under the task prompt, its text kept as typed
  suspendEditor() {
    const keys = [
      'composeKind',
      'editor',
      'composeBaseline',
      'fileOpened',
      'fileEditRows',
    ];
    this.suspended = Object.fromEntries(keys.map((key) => [key, this[key]]));
    this.suspended.fileDirty = this.fileDirty;
    this.fileDirty = false;
  }

  resumeEditor() {
    const kept = this.suspended;
    if (!kept || this.composeKind !== 'blockTask') return false;
    this.suspended = null;
    this.clear();
    Object.assign(this, kept);
    this.ui.mode = 'compose';
    this.afterEdit();
    return true;
  }

  dropCodeNote(item, text) {
    const notes = this.notes;
    if (!notes) return;
    const key = itemFeedKey(item);
    if (!notes.code.has(key)) return;
    notes.setCode(key, { ...itemNote(item, text), clear: true });
  }

  // Edits that land in the worktree or index, not in the review notes
  writesDisk() {
    const kind = this.composeKind;
    if (!this.editor) return false;
    if (kind === 'file') return true;
    return kind === 'code' && this.writesCodeFile(this.ui.current());
  }

  commitCode(text) {
    const item = this.ui.current();
    if (!canEditCode(item) || this.writesCodeFile(item)) return;
    const note = itemNote(item, text);
    const clear = text === blockAddText(item.hunk, item.blockId);
    this.notes.setCode(itemFeedKey(item), clear ? { ...note, clear } : note);
  }

  async write(action) {
    const ui = this.ui;
    ui.ignoreWatch();
    try {
      await ui.ops.exclusive(action);
    } catch (error) {
      ui.status = error.message;
      return false;
    }
    ui.ignoreWatch();
    return true;
  }

  async writeCode(text) {
    const ui = this.ui;
    const item = ui.current();
    if (text !== blockAddText(item.hunk, item.blockId)) {
      const edit = (top) => ui.repo.edit(top, item, text);
      const written = await this.write(edit);
      if (!written) return false;
      this.fileDirty = true;
    }
    this.dropCodeNote(item, text);
    return true;
  }

  async saveUnitFile(text) {
    const ui = this.ui;
    const rel = ui.nav.reviewPath;
    if (!rel || !ui.repo.writeFile) return true;
    if (!this.canChange()) {
      ui.status = 'read only';
      return false;
    }
    const save = (top) => ui.repo.writeFile(top, rel, text);
    const written = await this.write(save);
    if (!written) return false;
    ui.reads.keepText(rel, text);
    this.composeBaseline = text;
    this.fileDirty = true;
    return true;
  }

  stageItems(rel) {
    const ui = this.ui;
    const repo = ui.repo;
    if (!repo.add) return;
    const targets = ui.items.filter((item) => {
      if (listPath(item) !== rel || isReadOnlyOrigin(item.origin)) return false;
      return item.origin !== 'staged';
    });
    if (!targets.length) return;
    for (const item of targets) ui.collection.keepOrigin(item, 'staged');
    ui.ignoreWatch();
    const write = async () => {
      for (const item of targets) await ui.ops.add(item);
    };
    ui.ops.enqueueLazy({ kind: 'staged', done: '', reload: false, write });
  }

  async stageEditedFile(rel) {
    const repo = this.ui.repo;
    if (!rel || !this.canChange()) return;
    if (!repo.stagePath) return void this.stageItems(rel);
    await this.write((top) => repo.stagePath(top, rel));
  }

  finishSave(reload, doneStatus) {
    const ui = this.ui;
    ui.flushReview();
    this.closeCompose();
    if (!reload) {
      if (!ui.status) ui.status = doneStatus;
      return;
    }
    this.fileDirty = false;
    ui.reloadAfterChange(() => {
      if (!ui.status) ui.status = doneStatus;
    });
  }

  // Closes the editor after a note or a block edit; reloads if a file changed
  finishNote(doneStatus) {
    const ui = this.ui;
    if (this.fileDirty === true) return void this.finishSave(true, doneStatus);
    ui.flushReview();
    this.closeCompose();
    ui.status = doneStatus;
  }

  async saveFile() {
    const rel = this.ui.nav.reviewPath;
    const opened = this.fileOpened;
    const text = this.editor.text;
    this.ui.nav.unitLine = this.editor.linePos().line;
    const saved = await this.saveUnitFile(text);
    if (!saved) return false;
    const changed = text !== opened;
    const reload = this.fileDirty === true;
    if (changed) await this.stageEditedFile(rel);
    this.finishSave(reload, changed ? 'staged' : 'saved');
    return true;
  }

  async saveCode() {
    const ui = this.ui;
    const item = ui.current();
    const unstaged = item.origin !== 'staged';
    const rel = itemPath(item);
    const saved = await this.writeCode(this.editor.text);
    if (!saved) return false;
    const staging = unstaged && this.fileDirty === true;
    if (staging) await this.stageEditedFile(rel);
    this.finishNote(staging ? 'staged' : 'saved');
    return true;
  }

  saveEdit() {
    return this.composeKind === 'file' ? this.saveFile() : this.saveCode();
  }

  // One save at a time; `after` runs once the edit is safely on disk
  async saveToDisk(after) {
    if (this.saving) return;
    this.saving = true;
    const settle = () => {
      this.saving = false;
    };
    const saved = await this.saveEdit().finally(settle);
    if (saved && after) after();
  }

  // Leaves the editor whether or not the edit could be written
  async writeAndClose() {
    const text = this.editor.text;
    if (this.composeKind === 'file') await this.saveUnitFile(text);
    else await this.writeCode(text);
    this.closeCompose();
  }

  commitCompose() {
    const kind = this.composeKind;
    if (!kind || !this.editor) return;
    const text = this.editor.text;
    if (kind === 'blockTask' && this.notes) this.commitBlockTask(text);
    if (kind === 'tasks') this.tasks.commitTask(text);
    if (kind === 'code') this.commitCode(text);
  }

  // Notes save at once. An edit to a file answers `saving` and finishes later
  saveCompose(opts = {}) {
    const ui = this.ui;
    const kind = this.composeKind;
    if (COMMAND_KINDS.includes(kind)) return { kind };
    if (this.writesDisk()) {
      ui.ops.hold(this.saveToDisk(opts.after));
      return { kind: 'saving' };
    }
    const baseline = this.composeBaseline;
    this.commitCompose();
    if (kind === 'blockTask' && this.notes) {
      const next = this.editor ? this.editor.text : '';
      this.notes.rememberTemplate(baseline, next);
    }
    this.finishNote('saved');
    return { kind: 'saved' };
  }

  autosaveFile(text) {
    if (this.saving || text === this.composeBaseline) return;
    this.ui.ops.track(this.saveUnitFile(text));
  }

  autosave() {
    const kind = this.composeKind;
    const text = this.editor ? this.editor.text : '';
    if (kind === 'file' && this.editor) return void this.autosaveFile(text);
    const reviewKind = kind !== null && !COMMAND_KINDS.includes(kind);
    const noted = reviewKind && !this.writesDisk();
    if (noted && (kind === 'code' || text.trim())) this.commitCompose();
    if (this.notes && this.notes.dirty) this.ui.flushReview();
  }

  composeView() {
    const { composeKind: kind, editor } = this;
    if (!editor || !NOTE_VIEWS.includes(kind)) return null;
    const { text, cursor, scrollCol, anchor } = editor;
    return {
      kind,
      prompt: kind === 'blockTask' ? this.blockTaskPrompt() : '',
      text,
      cursor,
      scrollCol,
      anchor,
      commitKind: this.commitKind,
    };
  }

  // The editor under a task prompt still shows what was typed
  liveCodeText() {
    const kept = this.suspended;
    const kind = kept ? kept.composeKind : this.composeKind;
    const editor = kept ? kept.editor : this.editor;
    if (kind === 'file' && editor) return editor.text;
    const item = this.ui.current();
    if (!canEditCode(item)) return null;
    if (kind === 'code' && editor) return editor.text;
    if (this.writesCodeFile(item) || !this.notes) return null;
    const note = this.notes.code.get(itemFeedKey(item));
    return note ? note.text : null;
  }

  codeOverlayView() {
    const text = this.liveCodeText();
    if (text === null) return null;
    const editing = this.composeKind === 'code' || this.composeKind === 'file';
    const editor = editing ? this.editor : null;
    return {
      text,
      keepEmpty: editing,
      cursor: editor?.cursor ?? null,
      scrollCol: editor?.scrollCol ?? 0,
      anchor: editor?.anchor ?? null,
    };
  }

  idleNoteText() {
    const notes = this.notes;
    if (!notes || this.composeKind) return '';
    const item = this.ui.current();
    if (!item || isTaskItem(item)) return '';
    const note = this.blockTaskOf(item);
    if (!note || !note.text.trim()) return '';
    return `${this.blockTaskPrompt(note)}${note.text}`;
  }

  tab() {
    if (this.composeKind === 'tasks') {
      this.tasks.tabField();
      return null;
    }
    if (this.spec && this.spec.tab === 'insert-tab') {
      this.editor.insert('\t');
      return null;
    }
    return this.templates.applyTemplate();
  }

  moveTemplateLine(delta, shown, width) {
    const pick = this.templates;
    if (this.templateFocus) {
      const next = clamp(this.templateIndex + delta, 0, shown.length - 1);
      if (next === this.templateIndex) this.templateFocus = false;
      else pick.focusTemplate(next, false);
      return true;
    }
    const pos = cursorInWrap(this.editor.text, this.editor.cursor, width);
    const last = wrapDoc(this.editor.text, width).length - 1;
    if (delta < 0 && pos.row === 0) {
      pick.focusTemplate(shown.length - 1, false);
      return true;
    }
    if (delta > 0 && pos.row === last) {
      pick.focusTemplate(0, false);
      return true;
    }
    return false;
  }

  noteLineWidth() {
    const width = this.viewSize().width;
    const kind = this.commitKind;
    const view = this.ui.commits.commitView;
    const editing = this.composeKind === 'commit';
    const fullCommit = editing && wholeCommitMessage(kind, view);
    if (this.composeKind === 'blockTask') {
      return Math.max(1, noteInnerWidth(width) - this.blockTaskPrompt().length);
    }
    if (!fullCommit) return noteInnerWidth(width);
    const inPlace = ['amend', 'reword', 'squash'].includes(kind);
    const list = listedCommits(this.ui.commits.commits);
    const entry = (inPlace && list[this.ui.nav.commitCursor]) || null;
    return commitMessageWidth(entry, width);
  }

  moveLine(delta, extend) {
    const move = this.spec ? this.spec.move : 'note';
    if (move === 'tasks') {
      const inner = this.tasks.editWidth(this.viewSize().width);
      return void this.tasks.moveTaskCompose(delta, inner, extend);
    }
    if (move === 'code') {
      this.editor.moveLine(delta, undefined, extend);
      return void this.syncCodeScroll();
    }
    const width = this.noteLineWidth();
    const shown = this.templates.shownTemplates();
    const blockTask = this.composeKind === 'blockTask';
    if (shown.length && blockTask && !extend) {
      if (this.moveTemplateLine(delta, shown, width)) return;
    }
    this.editor.moveLine(delta, width, extend);
  }

  movePage(dir) {
    const frame = this.ui.lastFrame;
    const fallback = Math.max(1, (this.viewSize().height ?? 24) - 4);
    const step = Math.max(1, frame?.bodyH ?? fallback);
    this.moveLine(step * dir);
  }

  jumpTemplates(toEnd) {
    if (!this.templateFocus) return false;
    const shown = this.templates.shownTemplates();
    if (!shown.length) return false;
    this.templates.focusTemplate(toEnd ? shown.length - 1 : 0, false);
    return true;
  }

  home(extend) {
    if (!extend && this.jumpTemplates(false)) return;
    this.editor.home(extend);
  }

  end(extend) {
    if (!extend && this.jumpTemplates(true)) return;
    this.editor.end(extend);
  }

  onBlockTask() {
    const ui = this.ui;
    const target = ui.nav.pane === 'files' ? null : this.blockTaskTarget();
    if (!target) {
      ui.status = 'not a diff block';
      return;
    }
    if (SUSPENDS.includes(this.composeKind)) this.suspendEditor();
    const prev = this.notes.blockTask(target.where, target.legacyKey);
    this.openCompose('blockTask', prev ? prev.text : '');
    this.taskTarget = target;
  }

  onUnitEdit() {
    const ui = this.ui;
    if (!ui.nav.reviewPath) {
      ui.status = 'not a diff block';
      return;
    }
    if (!this.canChange()) {
      ui.status = 'read only';
      return;
    }
    ui.ops.hold(this.editViewed());
  }

  async editViewed() {
    const ui = this.ui;
    await ui.reads.loadText(ui.nav.reviewPath);
    const at = unit.editCursor(ui);
    this.openCompose('file', at.text);
    this.fileEditRows = at.rows ?? null;
    this.editor.cursor = Math.min(at.cursor, at.text.length);
    this.syncCodeScroll();
    this.followFileEdit();
  }

  onFileEdit() {
    const ui = this.ui;
    const list = ui.fileList();
    const entry = list[ui.nav.fileCursor];
    if (!entry || isTasksEntry(entry)) {
      ui.status = 'not a diff block';
      return;
    }
    const edit = () => this.onUnitEdit();
    ui.ops.hold(unit.showFile(ui, entry).then(edit));
  }

  onCode() {
    const ui = this.ui;
    if (ui.nav.pane === 'files') return void this.onFileEdit();
    if (ui.nav.pane === 'unit') return void this.onUnitEdit();
    const item = ui.current();
    if (!canEditCode(item)) {
      ui.status = 'not a diff block';
      return;
    }
    const original = blockAddText(item.hunk, item.blockId);
    const writes = this.writesCodeFile(item);
    const prev = writes ? null : this.notes.code.get(itemFeedKey(item));
    this.openCompose('code', prev ? prev.text : original);
    this.syncCodeScroll();
  }

  insertNewline() {
    this.editor.insert('\n');
    this.followFileEdit();
    return null;
  }

  enter() {
    const kind = this.composeKind;
    if (this.templateFocus && kind === 'blockTask') {
      return this.templates.selectTemplate(this.templateIndex);
    }
    if (kind === 'tasks' && this.tasks.enterHeading()) return null;
    const spec = this.spec;
    if (spec && spec.enter === 'newline') return this.insertNewline();
    const messageView = this.ui.commits.commitView;
    const whole = wholeCommitMessage(this.commitKind, messageView);
    if (kind === 'commit' && whole) {
      const text = this.editor ? this.editor.text : '';
      const shaped = filledLines(text) >= 2 || blankTail(text) >= 2;
      if (onEmptyLastLine(this.editor) && shaped) return this.saveCompose();
      return this.insertNewline();
    }
    return this.saveCompose();
  }

  leave(key) {
    if (this.spec && this.spec.escape === 'cancel' && key === 'escape') {
      this.closeCompose();
      this.ui.status = '';
      return null;
    }
    return this.saveCompose();
  }

  copy() {
    copyLine(this.editor, this.ui);
  }

  cut() {
    cutLine(this.editor, this.ui);
  }

  paste() {
    const text = clipboard.pasteText();
    if (text) this.editor.insert(text);
  }

  afterEdit() {
    this.followFileEdit();
    this.syncCodeScroll();
  }

  handleKey(key) {
    if (key === 'enter' || isNewlineKey(key)) {
      const result = isNewlineKey(key) ? this.insertNewline() : this.enter();
      this.syncCodeScroll();
      return result;
    }
    if (key === 'escape' || key === 'ctrl-s') return this.leave(key);
    const tasks = this.composeKind === 'tasks';
    if (tasks && key === 'backspace' && dropBlock(this.tasks)) return null;
    const special = COMPOSE_SPECIAL[key];
    if (special) {
      const result = special(this);
      const edits = COMPOSE_EDITS.includes(key) || COMPOSE_CLIP.includes(key);
      if (edits) this.templates.clearTemplatePick();
      this.afterEdit();
      return result ?? null;
    }
    if (isTextKey(key)) {
      this.templates.clearTemplatePick();
      this.editor.insert(key);
      this.afterEdit();
    }
    return null;
  }

  applyDiskText(text) {
    const editor = this.editor;
    if (this.composeKind !== 'file' || !editor) return;
    // The baseline is the last text known on disk: no news, keep the typing
    if (text === editor.text || text === this.composeBaseline) return;
    const cursor = editor.cursor;
    editor.text = text;
    editor.cursor = Math.min(cursor, text.length);
    editor.anchor = null;
    this.composeBaseline = text;
    // An outside change is the new starting point, not an edit made here
    this.fileOpened = text;
    this.fileEditRows = unit.linesFor(this.ui, this.ui.nav.reviewPath, null);
    this.syncCodeScroll();
    this.followFileEdit();
  }
}

module.exports = { COMPOSE_LEAVE, Composer };
