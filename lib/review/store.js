'use strict';

const fs = require('node:fs');
const path = require('node:path');

const files = require('../common/files.js');
const { ISSUE_FILE, TASKS_FILE, TASK_KINDS, taskKind, REVIEW_DIR } = files;
const { trimText, toInt } = require('../common/utilities.js');
const { MarkdownDoc } = require('./markdown.js');
const { TaskItem, taskLines, fieldTaskText } = require('./task.js');
const blocks = require('./blocks.js');
const { isHeading, isInstructions, headingKind, blockKind } = blocks;
const { feedbackKey, toNote, feedbackLines, codeLines, fenceFor } = blocks;
const { isReviewName, newPlanText, parsePlan } = blocks;
const { carryIds } = require('./merge.js');
const { issueTaskText, issueKind } = require('./import.js');
const { parseLocations } = require('./location.js');

const TEMPLATE_SHOW = 5;

const REVIEW_STATUSES = ['editing', 'partial', 'done'];

const EDITING_ALIASES = ['pending', 'ready'];

const TEMPLATES_FILE = '.templates';

const LEGACY_TEMPLATES = 'templates.json';

const STATUS_LINE = /^status:/;

const BLOCK_TASK_KIND = 'improvements';

// A code proposal is the `do` of a block's task: a lead line and a fence
const CODE_TITLE = 'Replace the added lines';
const CODE_LEAD = 'replace the added lines with';
const FENCED = /(?:^|\n)(`{3,})[^\n]*\n([\s\S]*?)\n?\1\s*$/;

const CODE_FIELDS = ['where', 'do'];

const canonicalStatus = (raw) => {
  const name = EDITING_ALIASES.includes(raw) ? 'editing' : raw;
  return REVIEW_STATUSES.includes(name) ? name : '';
};

const rankedTemplates = (templates) => {
  const ranked = [...templates];
  ranked.sort((a, b) => {
    const byCount = b.count - a.count;
    if (byCount) return byCount;
    return a.text.localeCompare(b.text);
  });
  return ranked;
};

const prefixTemplates = (templates, prefix) => {
  if (!prefix) return templates;
  return templates.filter((entry) => entry.text.startsWith(prefix));
};

const upsertTemplate = (templates, text) => {
  const trimmed = text.trim();
  if (!trimmed) return templates;
  const next = [...templates];
  const i = next.findIndex((entry) => entry.text === trimmed);
  if (i < 0) {
    next.push({ text: trimmed, count: 1 });
    return next;
  }
  const prev = next[i];
  next[i] = { text: prev.text, count: prev.count + 1 };
  return next;
};

const templateEntries = (data) => {
  if (!Array.isArray(data)) return [];
  const templates = [];
  for (const entry of data) {
    if (!entry || typeof entry.text !== 'string') continue;
    const count = toInt(entry.count);
    templates.push({
      text: entry.text,
      count: Number.isFinite(count) ? count : 1,
    });
  }
  return templates;
};

const readTemplateFile = (file) => {
  try {
    return templateEntries(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    return [];
  }
};

const loadTemplates = (dir) => {
  const folder = path.join(dir, REVIEW_DIR);
  const current = readTemplateFile(path.join(folder, TEMPLATES_FILE));
  if (current) return current;
  const legacy = readTemplateFile(path.join(folder, LEGACY_TEMPLATES));
  return legacy ?? [];
};

const countDone = (entries) => {
  let done = 0;
  let total = 0;
  for (const entry of entries) {
    total += 1;
    if (entry.done) done += 1;
  }
  return { done, total };
};

const filledTasks = (store) => store.tasks.filter((task) => task.text.trim());

const noteCounts = (store) => {
  const counts = { feedback: 0, tasks: 0, tasksDone: 0, code: 0 };
  if (!store) return counts;
  const { done, total } = countDone(filledTasks(store));
  counts.tasks = total;
  counts.tasksDone = done;
  for (const note of store.feedback.values()) {
    if (note.text.trim()) counts.feedback += 1;
  }
  counts.code = store.code.size;
  return counts;
};

const reviewProgress = (store) => {
  if (!store) return { done: 0, total: 0 };
  const notes = [...store.feedback.values(), ...store.code.values()];
  return countDone(filledTasks(store).concat(notes));
};

const hasNotes = (store) => {
  const counts = noteCounts(store);
  return counts.feedback > 0 || counts.tasks > 0 || counts.code > 0;
};

const checkLabel = (text, done) => {
  const mark = done ? 'x' : ' ';
  return `[${mark}] ${text}`;
};

const flatTaskText = (text) => trimText(text).replace(/\n/g, ' ');

const knownTaskText = (store) => {
  const known = new Set();
  for (const task of store.tasks) known.add(flatTaskText(task.text));
  return known;
};

// Where the URL of an imported issue shows: `related` and older import text
const issueTexts = (store) =>
  store.tasks.map((task) => `${task.item.value('related')}\n${task.text}`);

const kindRank = (kind) => TASK_KINDS.findIndex((entry) => entry.id === kind);

const isGap = (block) => block?.type === 'blank';

const whereOf = (item) => item.value('where').replace(/^`(.*)`$/, '$1');

// A path with spaces is one location only in backticks
const whereValue = (where) => (/\s/.test(where) ? `\`${where}\`` : where);

// The task on a diff block reads as its title line and its problem
const blockTaskNote = (view) => {
  const { item } = view;
  const text = [item.rest, item.value('problem')].filter(Boolean).join('\n');
  return { id: view.id, text, done: item.done };
};

const codeOf = (item) => {
  const match = FENCED.exec(item.value('do'));
  return match ? match[2] : null;
};

const codeValue = (text) => {
  const fence = fenceFor(text);
  return `${CODE_LEAD}\n${fence}\n${text}\n${fence}`;
};

// A task that is only a code proposal goes when its code does
const onlyCode = (item) => {
  const isCodeField = (field) => CODE_FIELDS.includes(field.key);
  return item.title === CODE_TITLE && item.fields.every(isCodeField);
};

const isListItem = (block) =>
  ['task', 'feedback', 'code', 'item'].includes(block?.type);

// `id` is the block's own number for the session; `item.id` is the task ID
// written in the file
const taskView = (block) => {
  const item = new TaskItem(block.lines);
  item.kind = blockKind(block);
  const { text, done, kind } = item;
  return { id: block.id, file: TASKS_FILE, text, done, kind, block, item };
};

class ReviewStore {
  constructor(reviewPath, templates = [], doc = null) {
    this.reviewPath = reviewPath;
    this.dirty = false;
    this.templates = [...templates];
    this.baseline = null;
    this.doc = doc ?? ReviewStore.newDoc(reviewPath);
    this.cache = null;
  }

  // A reslop plan starts with its frontmatter, title, and instructions;
  // any other file starts empty
  static newDoc(reviewPath) {
    if (!isReviewName(reviewPath)) return new MarkdownDoc();
    return parsePlan(newPlanText(reviewPath));
  }

  views() {
    const { doc } = this;
    const version = doc.version;
    const cache = this.cache;
    if (cache && cache.doc === doc && cache.version === version) return cache;
    const tasks = [];
    const feedback = new Map();
    const code = new Map();
    const byWhere = new Map();
    for (const block of this.doc.layout()) {
      if (block.type === 'task') {
        const view = taskView(block);
        tasks.push(view);
        const where = whereOf(view.item);
        if (where && !byWhere.has(where)) byWhere.set(where, view);
      } else if (block.type === 'feedback') {
        feedback.set(block.key, block.note);
      } else if (block.type === 'code') {
        code.set(block.key, block.note);
      }
    }
    this.cache = { doc, version, tasks, feedback, code, byWhere };
    return this.cache;
  }

  // The task on a diff block: the one whose `where` is the block, or the
  // feedback note an older plan wrote under the block's key
  blockTask(where, legacyKey = '') {
    const view = where ? this.views().byWhere.get(where) : null;
    if (view) return blockTaskNote(view);
    return this.feedback.get(legacyKey) ?? null;
  }

  // Tasks follow their diff blocks to the lines a reload found them at; all
  // move at once, so blocks that swap places keep their tasks
  moveWheres(moved) {
    if (!moved.size) return;
    for (const task of this.tasks) {
      const to = moved.get(whereOf(task.item));
      if (!to) continue;
      this.editTask(task.id, (item) => item.setField('where', whereValue(to)));
    }
  }

  // An older note is taken out, and its file heading if that is left empty
  dropLegacy(type, key) {
    const block = key ? this.noteBlock(type, key) : null;
    if (!block) return null;
    const head = block.heading;
    this.unplace(block);
    if (head && !this.blockContent(head).length) this.removeBlock(head.id);
    this.changed();
    return block;
  }

  // The code proposed for a block's added lines: the fence in the `do` of
  // its task, or the code note an older plan wrote
  blockCode(where, legacyKey = '') {
    const view = where ? this.views().byWhere.get(where) : null;
    const text = view ? codeOf(view.item) : null;
    if (text !== null) return { text, done: view.done };
    return this.code.get(legacyKey) ?? null;
  }

  setBlockCode(where, text, legacyKey = '', clear = false) {
    const legacy = this.dropLegacy('code', legacyKey);
    const found = this.views().byWhere.get(where);
    if (clear) {
      if (!found || codeOf(found.item) === null) return;
      if (onlyCode(found.item)) return void this.removeTask(found.id);
      return void this.editTask(found.id, (item) => item.setField('do', ''));
    }
    if (found) {
      if (codeOf(found.item) === text) return;
      // New code is new work, even on a task that was done
      this.editTask(found.id, (item) =>
        new TaskItem(item.setDone(false)).setField('do', codeValue(text)),
      );
      return void this.reopen();
    }
    const fields = [
      ['where', whereValue(where)],
      ['do', codeValue(text)],
    ];
    const done = legacy?.note.done ?? false;
    this.addTask(
      TASKS_FILE,
      fieldTaskText(CODE_TITLE, fields),
      done,
      BLOCK_TASK_KIND,
    );
  }

  // What the tasks point at in a file: the lines of each `where` and the
  // whole values, which name diff blocks; an open task wins over a done one
  taskMarks(rel) {
    const ranges = [];
    const wheres = new Map();
    for (const task of this.tasks) {
      const value = whereOf(task.item);
      if (!value) continue;
      const { done } = task;
      if (!done || !wheres.has(value)) wheres.set(value, done);
      for (const spot of parseLocations(task.item.value('where'))) {
        if (spot.path !== rel || !spot.line) continue;
        ranges.push({ first: spot.line, last: spot.end, done });
      }
    }
    return ranges.length || wheres.size ? { ranges, wheres } : null;
  }

  // Writes the task on a diff block: the first line is its title and the
  // rest its problem. An older feedback note on the block becomes that
  // task; empty text removes it, or leaves a code proposal it holds.
  setBlockTask(where, note, legacyKey = '') {
    const legacy = this.dropLegacy('feedback', legacyKey);
    const parts = trimText(note.text).split('\n');
    const title = parts[0] ?? '';
    const rest = parts.slice(1);
    const problem = rest.join('\n').trim();
    const done = note.done ?? legacy?.note.done;
    const found = this.views().byWhere.get(where);
    if (!found) {
      if (!title) return;
      const fields = [
        ['where', whereValue(where)],
        ['problem', problem],
      ];
      const text = fieldTaskText(title, fields);
      return void this.addTask(
        TASKS_FILE,
        text,
        done ?? false,
        BLOCK_TASK_KIND,
      );
    }
    if (!title) {
      if (codeOf(found.item) === null) return void this.removeTask(found.id);
      return void this.editTask(found.id, (item) =>
        new TaskItem(item.setTitleLine(CODE_TITLE)).setField('problem', ''),
      );
    }
    const keep = done ?? found.done;
    const changed = this.editTask(found.id, (item) => {
      const lines = new TaskItem(item.setTitleLine(title)).setDone(keep);
      return new TaskItem(lines).setField('problem', problem);
    });
    if (changed && !keep) this.reopen();
  }

  get tasks() {
    return this.views().tasks;
  }

  get feedback() {
    return this.views().feedback;
  }

  get code() {
    return this.views().code;
  }

  statusBlock() {
    const block = this.doc.frontmatter;
    if (!block) return null;
    const at = block.lines.findIndex((line) => STATUS_LINE.test(line.trim()));
    return at < 0 ? null : { block, at };
  }

  // A file without a status in its frontmatter is being edited
  get status() {
    const { status } = this.doc.frontmatterFields();
    return canonicalStatus(status) || 'editing';
  }

  // Only a status the frontmatter already has is written
  set status(value) {
    if (value === this.status) return;
    const found = this.statusBlock();
    if (!found) return;
    const lines = [...found.block.lines];
    const cr = lines[found.at].endsWith('\r') ? '\r' : '';
    lines[found.at] = `status: ${value}${cr}`;
    this.doc.replace(found.block, lines);
  }

  reopen() {
    if (this.status === 'done') this.status = 'editing';
  }

  changed() {
    this.dirty = true;
  }

  lines(lines) {
    return lines.map((line) => this.doc.line(line));
  }

  // Blocks under a heading as [first, end) indexes into the doc: up to the
  // next heading, or with `deep` up to one of the same or a higher level
  blockRange(heading, deep = false) {
    const list = this.doc.blocks;
    const first = heading ? list.indexOf(heading) + 1 : 0;
    const level = heading && deep ? heading.level : 6;
    let end = first;
    while (end < list.length) {
      const block = list[end];
      if (isHeading(block) && block.level <= level) break;
      end += 1;
    }
    return [first, end];
  }

  // Index after the last part of a block that is not a blank line
  blockTail(heading) {
    const pair = this.blockRange(heading);
    const first = pair[0];
    const end = pair[1];
    let at = end;
    while (at > first && isGap(this.doc.blocks[at - 1])) at -= 1;
    return at;
  }

  gap() {
    return this.doc.block('blank', [this.doc.line('')]);
  }

  // Puts a block in and keeps a blank line around anything but adjacent
  // list items
  place(at, block) {
    const doc = this.doc;
    const prev = doc.blocks[at - 1];
    const next = doc.blocks[at];
    const tight = (other) => isListItem(other) && isListItem(block);
    let index = at;
    if (prev && !isGap(prev) && !tight(prev)) {
      doc.insert(index, this.gap());
      index += 1;
    }
    doc.insert(index, block);
    if (next && !isGap(next) && !tight(next)) {
      doc.insert(index + 1, this.gap());
    }
    return block;
  }

  // Takes a block out and leaves one blank line where there were two
  unplace(block) {
    const doc = this.doc;
    const at = doc.indexOf(block);
    if (at < 0) return false;
    doc.remove(block);
    const prev = doc.blocks[at - 1];
    const next = doc.blocks[at];
    if (isGap(prev) && (isGap(next) || !next)) doc.remove(prev);
    else if (!prev && isGap(next)) doc.remove(next);
    return true;
  }

  kindHeading(kind) {
    for (const block of this.doc.layout()) {
      if (headingKind(block) === kind) return block;
    }
    return null;
  }

  // Where a new kind block goes: by kind order among the kind blocks in
  // the file, else before the first block of diff notes, else at the end
  kindBlockAt(kind) {
    const list = this.doc.layout();
    const rank = kindRank(kind);
    let after = null;
    let before = null;
    for (const block of list) {
      const other = headingKind(block);
      if (!other) continue;
      const otherRank = kindRank(other);
      if (otherRank < rank) after = block;
      else if (!before && otherRank > rank) before = block;
    }
    if (after) return this.blockRange(after, true)[1];
    if (before) return list.indexOf(before);
    const notes = list.find(
      (block) => block.type === 'feedback' || block.type === 'code',
    );
    const head = notes ? notes.heading : null;
    if (head) return list.indexOf(head);
    return list.length;
  }

  addHeading(at, text, level = 2) {
    const marks = '#'.repeat(level);
    const block = this.doc.block('heading', [
      this.doc.line(`${marks} ${text}`),
    ]);
    return this.place(at, block);
  }

  addKindBlock(kind) {
    const found = this.kindHeading(kind);
    if (found) return found;
    return this.addHeadedBlock(this.kindBlockAt(kind), files.taskTitle(kind));
  }

  addHeadedBlock(at, text) {
    const head = this.addHeading(at, text);
    this.changed();
    return head;
  }

  taskBlock(id) {
    const block = this.doc.byId(id);
    return block && block.type === 'task' ? block : null;
  }

  newTaskBlock(text, done) {
    const cr = this.doc.eol === '\r\n';
    return this.doc.block('task', taskLines(text, done, cr));
  }

  // A new task at the end of its kind block, or right after `after`
  addTask(file, text = '', done = false, kind = 'features', after = null) {
    const block = this.newTaskBlock(text, done);
    const anchor = after === null ? null : this.doc.byId(after);
    if (anchor) {
      this.place(this.doc.indexOf(anchor) + 1, block);
    } else {
      const heading = this.addKindBlock(taskKind({ kind }));
      this.place(this.blockTail(heading), block);
    }
    this.changed();
    if (!done) this.reopen();
    return taskView(block);
  }

  removeTask(id) {
    const block = this.taskBlock(id);
    if (!block) return false;
    this.unplace(block);
    this.changed();
    return true;
  }

  setTaskText(id, text) {
    const block = this.taskBlock(id);
    if (!block) return;
    if (!text.trim()) return void this.removeTask(id);
    const lines = new TaskItem(block.lines).withText(text);
    if (this.doc.replace(block, lines)) this.changed();
  }

  // Runs a TaskItem setter on a task and keeps the lines it returns
  editTask(id, edit) {
    const block = this.taskBlock(id);
    if (!block) return false;
    const lines = edit(new TaskItem(block.lines));
    if (!this.doc.replace(block, lines)) return false;
    this.changed();
    return true;
  }

  setTaskDone(id, done) {
    this.editTask(id, (item) => item.setDone(done));
  }

  neighbor(block, delta) {
    const list = this.doc.blocks;
    let at = list.indexOf(block) + delta;
    while (at >= 0 && at < list.length && isGap(list[at])) at += delta;
    return list[at] ?? null;
  }

  swap(left, right) {
    const list = this.doc.blocks;
    const a = list.indexOf(left);
    const b = list.indexOf(right);
    list[a] = right;
    list[b] = left;
    this.doc.touch();
  }

  // A heading a task can move under: not the instructions, not the notes
  // on a diff file, and not a title with nothing of its own
  takesTasks(block) {
    if (!isHeading(block) || isInstructions(block)) return false;
    const pair = this.blockRange(block);
    const first = pair[0];
    const end = pair[1];
    const own = this.doc.blocks.slice(first, end);
    const notes = (other) => other.type === 'feedback' || other.type === 'code';
    if (own.some(notes)) return false;
    return block.level > 1 || own.some((other) => !isGap(other));
  }

  // The block a task lands in when it leaves its own one
  crossBlock(block, delta) {
    this.doc.layout();
    const list = this.doc.blocks;
    const own = block.heading;
    let at = list.indexOf(block) + delta;
    if (delta < 0) at = own ? list.indexOf(own) - 1 : -1;
    while (at >= 0 && at < list.length) {
      if (this.takesTasks(list[at])) return list[at];
      at += delta;
    }
    return null;
  }

  // A task or text swaps with its neighbor, or at the edge of its block
  // crosses into the next one
  moveBlock(block, delta) {
    if (!delta || !block) return false;
    if (isHeading(block)) return this.moveHeadedBlock(block, delta);
    const next = this.neighbor(block, delta);
    if (next && !isHeading(next) && next.type !== 'frontmatter') {
      this.swap(block, next);
      this.changed();
      return true;
    }
    const target = this.crossBlock(block, delta);
    if (!target) return false;
    this.unplace(block);
    const at =
      delta < 0 ? this.blockTail(target) : this.doc.indexOf(target) + 1;
    this.place(at, block);
    this.changed();
    return true;
  }

  // A heading swaps places with its sibling block, with all under it
  moveHeadedBlock(head, delta) {
    const list = this.doc.blocks;
    const pair = this.blockRange(head, true);
    const first = pair[0];
    const end = pair[1];
    const start = first - 1;
    const at = this.siblingAt(head, start, end, delta);
    if (at < 0) return false;
    const endsGap = isGap(list[list.length - 1]);
    const chunk = list.splice(start, end - start);
    const index = at > start ? at - chunk.length : at;
    list.splice(index, 0, ...chunk);
    this.spaceAround(index, index + chunk.length, endsGap);
    this.doc.touch();
    this.changed();
    return true;
  }

  // Where a block moves to: before the sibling above, or after the one
  // below; -1 at the edge of its parent
  siblingAt(head, start, end, delta) {
    const list = this.doc.blocks;
    if (delta > 0) {
      const next = list[end];
      if (!next || next.level < head.level) return -1;
      return this.blockRange(next, true)[1];
    }
    let i = start - 1;
    while (i >= 0 && !(isHeading(list[i]) && list[i].level <= head.level)) {
      i -= 1;
    }
    if (i < 0 || list[i].level < head.level) return -1;
    return i;
  }

  // One blank line before and after a moved run of blocks, and the file
  // ending as it did
  spaceAround(start, end, endsGap) {
    const list = this.doc.blocks;
    if (end < list.length && !isGap(list[end - 1])) {
      list.splice(end, 0, this.gap());
    }
    if (start > 0 && !isGap(list[start - 1])) list.splice(start, 0, this.gap());
    const last = list[list.length - 1];
    if (!endsGap && isGap(last)) list.pop();
    if (endsGap && !isGap(last)) list.push(this.gap());
  }

  // Removes a part; a heading takes its whole block with it
  removeBlock(id) {
    const block = this.doc.byId(id);
    if (!block || block.type === 'frontmatter') return false;
    if (isHeading(block)) {
      const pair = this.blockRange(block, true);
      const first = pair[0];
      const end = pair[1];
      for (const inner of this.doc.blocks.slice(first, end)) {
        this.doc.remove(inner);
      }
    }
    this.unplace(block);
    this.changed();
    return true;
  }

  blockContent(head) {
    const pair = this.blockRange(head, true);
    const first = pair[0];
    const end = pair[1];
    return this.doc.blocks.slice(first, end).filter((block) => !isGap(block));
  }

  // New text for a heading or a block of Markdown; the file is read again
  // so text that became a task or a heading is one
  setBlockText(id, text) {
    const block = this.doc.byId(id);
    if (!block) return;
    if (block.type === 'task') return void this.setTaskText(id, text);
    const trimmed = `${text ?? ''}`.replace(/\s+$/, '');
    if (!trimmed.trim()) {
      if (block.type === 'heading') return;
      return void this.removeBlock(id);
    }
    const title = trimmed.split('\n').join(' ');
    const heading = [`${'#'.repeat(block.level)} ${title}`];
    const lines = isHeading(block) ? heading : trimmed.split('\n');
    if (!this.doc.replace(block, this.lines(lines))) return;
    this.reparse();
    this.changed();
  }

  // The whole file as typed in the raw editor; blocks that stay keep their ids
  setText(text) {
    if (text === this.doc.toString()) return false;
    this.doc = carryIds(this.doc, parsePlan(text));
    this.changed();
    this.reopen();
    return true;
  }

  reparse() {
    this.doc = carryIds(this.doc, parsePlan(this.doc.toString()));
  }

  noteBlock(type, key) {
    for (const block of this.doc.blocks) {
      if (block.type === type && block.key === key) return block;
    }
    return null;
  }

  fileHeading(file) {
    for (const block of this.doc.layout()) {
      if (isHeading(block) && block.level === 2 && block.text === file) {
        return block;
      }
    }
    return null;
  }

  insertNote(block, file) {
    let heading = this.fileHeading(file);
    if (!heading) heading = this.addHeading(this.doc.blocks.length, file);
    return this.place(this.blockTail(heading), block);
  }

  noteLines(type, note) {
    return this.lines(type === 'code' ? codeLines(note) : feedbackLines(note));
  }

  putNote(type, key, note, clear) {
    const block = this.noteBlock(type, key);
    if (clear) {
      if (!block) return;
      this.unplace(block);
      return void this.changed();
    }
    if (block && block.note.text === (note.text ?? '')) return;
    const next = toNote(note, block?.note.done);
    const lines = this.noteLines(type, next);
    if (block) {
      block.note = next;
      this.doc.replace(block, lines);
    } else {
      const fresh = this.doc.block(type, lines);
      fresh.note = next;
      fresh.key = key;
      this.insertNote(fresh, next.file ?? '');
    }
    this.changed();
    this.reopen();
  }

  setFeedback(key, note) {
    const clear = !(note.text ?? '').trim();
    this.putNote('feedback', key, note, clear);
  }

  setCode(key, note) {
    this.putNote('code', key, note, Boolean(note.clear));
  }

  setFeedbackDone(key, done) {
    const block = this.noteBlock('feedback', key);
    if (!block || block.note.done === done) return;
    block.note = { ...block.note, done };
    this.doc.replace(block, this.noteLines('feedback', block.note));
    this.changed();
  }

  moveFeedback(key, delta) {
    if (!delta) return false;
    const block = this.noteBlock('feedback', key);
    if (!block) return false;
    let next = this.neighbor(block, delta);
    while (next && next.type === 'feedback' && !trimText(next.note.text)) {
      next = this.neighbor(next, delta);
    }
    if (!next || next.type !== 'feedback') return false;
    this.swap(block, next);
    this.changed();
    return true;
  }

  applyImportedNotes(imported) {
    if (!imported) return;
    for (const note of imported.blockTasks ?? []) {
      const prev = this.blockTask(note.where);
      const text = prev ? `${prev.text}\n\n${note.text}` : note.text;
      const done = prev ? prev.done && !!note.done : !!note.done;
      this.setBlockTask(note.where, { text, done });
    }
    const todos = imported.tasks ?? imported.todos ?? [];
    const known = knownTaskText(this);
    const issues = issueTexts(this);
    for (const todo of todos) {
      if (todo.issue) {
        this.addIssue(todo.issue, !!todo.done, issues);
        continue;
      }
      const text = todo.text ?? '';
      const file = todo.file || '';
      const same = file === ISSUE_FILE && known.has(flatTaskText(text));
      if (same) continue;
      this.addTask(file, text, !!todo.done);
      if (file === ISSUE_FILE) known.add(flatTaskText(text));
    }
  }

  // An issue already in the plan is found by its URL in `related` or in the
  // text an older import wrote
  addIssue(issue, done, known = issueTexts(this)) {
    const url = issue.url;
    if (url && known.some((text) => text.includes(url))) return null;
    const text = issueTaskText(issue);
    known.push(text);
    return this.addTask(ISSUE_FILE, text, done, issueKind(issue.labels));
  }

  rememberTemplate(prevText, nextText) {
    const trimmed = nextText.trim();
    if (!trimmed) return;
    const prev = (prevText ?? '').trim();
    if (prev === trimmed) return;
    this.templates = upsertTemplate(this.templates, trimmed);
    this.dirty = true;
  }
}

module.exports = {
  feedbackKey,
  TEMPLATE_SHOW,
  TEMPLATES_FILE,
  LEGACY_TEMPLATES,
  canonicalStatus,
  rankedTemplates,
  prefixTemplates,
  upsertTemplate,
  loadTemplates,
  noteCounts,
  reviewProgress,
  hasNotes,
  checkLabel,
  ReviewStore,
};
