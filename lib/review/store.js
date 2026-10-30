'use strict';

const fs = require('node:fs');
const path = require('node:path');
const files = require('../common/files.js');
const { ISSUE_FILE, TASKS_FILE, TASK_KINDS, taskKind, REVIEW_DIR } = files;
const { kindPrefix } = files;
const { trimText, toInt } = require('../common/utilities.js');
const { MarkdownDoc } = require('./markdown.js');
const { TaskItem, taskLines } = require('./task.js');
const blocks = require('./blocks.js');
const { isHeading, isInstructions, headingKind, blockKind } = blocks;
const { feedbackKey, toNote, feedbackLines, codeLines } = blocks;
const { isReviewName, newPlanText, parsePlan } = blocks;
const { carryIds } = require('./merge.js');
const { issueTaskText, issueKind } = require('./import.js');

const TEMPLATE_SHOW = 5;

const REVIEW_STATUSES = ['editing', 'partial', 'done'];

const EDITING_ALIASES = ['pending', 'ready'];

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

const TEMPLATES_FILE = '.templates';

const LEGACY_TEMPLATES = 'templates.json';

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

const noteCounts = (store) => {
  const counts = { feedback: 0, tasks: 0, tasksDone: 0, code: 0 };
  if (!store) return counts;
  for (const task of store.tasks) {
    if (!task.text.trim()) continue;
    counts.tasks += 1;
    if (task.done) counts.tasksDone += 1;
  }
  for (const note of store.feedback.values()) {
    if (note.text.trim()) counts.feedback += 1;
  }
  counts.code = store.code.size;
  return counts;
};

const reviewProgress = (store) => {
  let done = 0;
  let total = 0;
  if (!store) return { done, total };
  for (const task of store.tasks) {
    if (!trimText(task.text)) continue;
    total += 1;
    if (task.done) done += 1;
  }
  for (const note of store.feedback.values()) {
    total += 1;
    if (note.done) done += 1;
  }
  for (const note of store.code.values()) {
    total += 1;
    if (note.done) done += 1;
  }
  return { done, total };
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

const STATUS_LINE = /^status:/;

const kindRank = (kind) => TASK_KINDS.findIndex((entry) => entry.id === kind);

const isGap = (block) => block?.type === 'blank';

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
    for (const block of this.doc.layout()) {
      if (block.type === 'task') tasks.push(taskView(block));
      else if (block.type === 'feedback') feedback.set(block.key, block.note);
      else if (block.type === 'code') code.set(block.key, block.note);
    }
    this.cache = { doc, version, tasks, feedback, code };
    return this.cache;
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
  sectionRange(heading, deep = false) {
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

  // Index after the last block of a section that is not a blank line
  sectionTail(heading) {
    const [first, end] = this.sectionRange(heading);
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

  // Where a new kind section goes: by kind order among the kind sections in
  // the file, else before the first section of diff notes, else at the end
  kindSectionAt(kind) {
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
    if (after) return this.sectionRange(after, true)[1];
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

  // The heading of a kind, added in kind order when the file has none
  addKindSection(kind) {
    const found = this.kindHeading(kind);
    if (found) return found;
    const head = this.addKindHeading(kind);
    this.changed();
    return head;
  }

  addSection(at, text) {
    const head = this.addHeading(at, text);
    this.changed();
    return head;
  }

  ensureKindSection(kind) {
    return this.kindHeading(kind) ?? this.addKindHeading(kind);
  }

  addKindHeading(kind) {
    const title = TASK_KINDS[kindRank(kind)]?.title ?? TASK_KINDS[0].title;
    return this.addHeading(this.kindSectionAt(kind), title);
  }

  taskBlock(id) {
    const block = this.doc.byId(id);
    return block && block.type === 'task' ? block : null;
  }

  taskById(id) {
    return this.tasks.find((task) => task.id === id) ?? null;
  }

  newTaskBlock(text, done) {
    const cr = this.doc.eol === '\r\n';
    return this.doc.block('task', taskLines(text, done, cr));
  }

  // A new task at the end of its kind section, or right after `after`
  addTask(file, text = '', done = false, kind = 'features', after = null) {
    const block = this.newTaskBlock(text, done);
    const anchor = after === null ? null : this.doc.byId(after);
    if (anchor) {
      this.place(this.doc.indexOf(anchor) + 1, block);
    } else {
      const heading = this.ensureKindSection(taskKind({ kind }));
      this.place(this.sectionTail(heading), block);
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

  setTaskField(id, key, value) {
    return this.editTask(id, (item) => item.setField(key, value));
  }

  setTaskCheck(id, index, done) {
    return this.editTask(id, (item) => item.setCheck(index, done));
  }

  setTaskRef(id, ref) {
    return this.editTask(id, (item) => item.setId(ref));
  }

  // The block before or after, skipping blank lines
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
  isTaskSection(block) {
    if (!isHeading(block) || isInstructions(block)) return false;
    const [first, end] = this.sectionRange(block);
    const own = this.doc.blocks.slice(first, end);
    const notes = (other) => other.type === 'feedback' || other.type === 'code';
    if (own.some(notes)) return false;
    return block.level > 1 || own.some((other) => !isGap(other));
  }

  // The section a task lands in when it leaves its own one
  crossSection(block, delta) {
    this.doc.layout();
    const list = this.doc.blocks;
    const own = block.heading;
    let at = list.indexOf(block) + delta;
    if (delta < 0) at = own ? list.indexOf(own) - 1 : -1;
    while (at >= 0 && at < list.length) {
      if (this.isTaskSection(list[at])) return list[at];
      at += delta;
    }
    return null;
  }

  moveTask(id, delta) {
    return this.moveBlock(this.taskBlock(id), delta);
  }

  // Gives each open task without an ID its kind's letter and the number
  // after the highest one of that letter in the file; IDs never change
  numberTasks() {
    const top = new Map();
    for (const task of this.tasks) {
      const id = task.item.id;
      if (!id) continue;
      const letter = id[0].toUpperCase();
      const n = toInt(id.slice(1));
      top.set(letter, Math.max(top.get(letter) ?? 0, n));
    }
    let count = 0;
    for (const task of this.tasks) {
      if (task.done || task.item.id || !task.text.trim()) continue;
      const letter = kindPrefix(task.kind);
      const n = (top.get(letter) ?? 0) + 1;
      top.set(letter, n);
      this.setTaskRef(task.id, `${letter}${n}`);
      count += 1;
    }
    return count;
  }

  // A task or text block swaps with its neighbor, or at the edge of its
  // section crosses into the next one
  moveBlock(block, delta) {
    if (!delta || !block) return false;
    if (isHeading(block)) return this.moveSection(block, delta);
    const next = this.neighbor(block, delta);
    if (next && !isHeading(next) && next.type !== 'frontmatter') {
      this.swap(block, next);
      this.changed();
      return true;
    }
    const dest = this.crossSection(block, delta);
    if (!dest) return false;
    this.unplace(block);
    const at = delta < 0 ? this.sectionTail(dest) : this.doc.indexOf(dest) + 1;
    this.place(at, block);
    this.changed();
    return true;
  }

  // A heading swaps places with its sibling section, blocks and all
  moveSection(head, delta) {
    const list = this.doc.blocks;
    const [first, end] = this.sectionRange(head, true);
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

  // Where a section moves to: before the sibling above, or after the one
  // below; -1 at the edge of its parent
  siblingAt(head, start, end, delta) {
    const list = this.doc.blocks;
    if (delta > 0) {
      const next = list[end];
      if (!next || next.level < head.level) return -1;
      return this.sectionRange(next, true)[1];
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

  // Removes a block; a heading takes its section with it
  removeBlock(id) {
    const block = this.doc.byId(id);
    if (!block || block.type === 'frontmatter') return false;
    if (isHeading(block)) {
      const [first, end] = this.sectionRange(block, true);
      for (const inner of this.doc.blocks.slice(first, end)) {
        this.doc.remove(inner);
      }
    }
    this.unplace(block);
    this.changed();
    return true;
  }

  // Blocks under a heading that are not blank lines
  sectionBlocks(head) {
    const [first, end] = this.sectionRange(head, true);
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
    return this.place(this.sectionTail(heading), block);
  }

  noteLines(type, note) {
    return this.lines(type === 'code' ? codeLines(note) : feedbackLines(note));
  }

  putNote(type, key, note, clear) {
    const block = this.noteBlock(type, key);
    if (clear) {
      if (!block) return;
      this.unplace(block);
      this.changed();
      return;
    }
    if (block && block.note.text === (note.text ?? '')) return;
    const next = toNote(note, block?.note.done);
    const lines = this.noteLines(type, next);
    if (block) {
      block.note = next;
      this.doc.replace(block, lines);
    } else {
      const fresh = this.doc.block(type, lines);
      Object.assign(fresh, { note: next, key });
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
    const feedbacks = imported.feedback ?? [];
    for (const note of feedbacks) {
      const key = feedbackKey(note);
      const prev = this.feedback.get(key);
      const text = prev ? `${prev.text}\n\n${note.text}` : note.text;
      const done = prev ? prev.done && !!note.done : !!note.done;
      this.setFeedback(key, { ...note, text, done });
    }
    const todos = imported.tasks ?? imported.todos ?? [];
    const known = knownTaskText(this);
    for (const todo of todos) {
      if (todo.issue) {
        this.addIssue(todo.issue, !!todo.done);
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

  // An issue already in the plan, found by its URL in `related` or in the
  // text an older import wrote
  hasIssue(url) {
    if (!url) return false;
    return this.tasks.some((task) => {
      if (task.item.value('related').includes(url)) return true;
      return task.text.includes(`Issue: ${url}`);
    });
  }

  addIssue(issue, done) {
    if (this.hasIssue(issue.url)) return null;
    const text = issueTaskText(issue);
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
  ReviewStore,
  canonicalStatus,
  noteCounts,
  reviewProgress,
  hasNotes,
  checkLabel,
  feedbackKey,
  TEMPLATE_SHOW,
  rankedTemplates,
  prefixTemplates,
  upsertTemplate,
  TEMPLATES_FILE,
  LEGACY_TEMPLATES,
  loadTemplates,
};
