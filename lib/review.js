'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { itemPath } = require('./files.js');

const REVIEW_DIR = '.review';
const TEMPLATES_FILE = 'templates.json';
const TEMPLATE_SHOW = 5;
const AUTOSAVE_MS = 3000;
const REVIEW_NAME = /^(\d{4}-\d{2}-\d{2})-(\d+)\.md$/;
const REVIEW_STATUSES = ['editing', 'ready', 'partial', 'done'];
const STATUS_ALIAS = Object.assign(Object.create(null), {
  pending: 'ready',
});
const FEED_HEAD = /^### Feedback `([^`]+)` \+(\d+) \((.*)\)\s*$/;
const FEED_BLOCK = /^(.*), block (\d+)$/;
const FEED_BLOCK_ONLY = /^block (\d+)$/;
const FEED_META = /^<!-- reslop:(.*) -->\s*$/;
const FEED_SUFFIX = /^(.*) - (.+):(\d+):(\d+):(\d+)$/;
const CHECK_ITEM = /^- \[([ xX])\] (.*)$/;
const FILE_QUOTE = /^> (.+)$/;
const STATUS_LINE = /^status:\s*(\S+)\s*$/;
const GIT_ORIGINS = ['unstaged', 'staged', 'untracked', 'commit', 'pr'];
const SECTION_LINE = Object.assign(Object.create(null), {
  '### Todo': 'todo',
  '### Feedback': 'feedback',
});

const AGENT_INSTRUCTIONS = [
  'Execute reviews with `status: ready` or `status: partial`.',
  'Do not start `editing` or `done` review files.',
  'Work through unchecked items. After finishing one, mark it `[x]`.',
  'Set `status` to `partial` if some remain, or `done` if all are `[x]`.',
  'Do not redo items already marked `[x]`.',
].join('\n');

const toInt = (text) => parseInt(text, 10);

const pad2 = (n) => `${n}`.padStart(2, '0');

const padIndex = (n) => (n < 100 ? pad2(n) : `${n}`);

const dateStamp = (date) => {
  const y = date.getFullYear();
  const month = pad2(date.getMonth() + 1);
  const day = pad2(date.getDate());
  return `${y}-${month}-${day}`;
};

const allocateReviewPath = (dir, date, existingNames) => {
  const stamp = dateStamp(date);
  let max = -1;
  for (const name of existingNames) {
    const match = REVIEW_NAME.exec(name);
    if (!match) continue;
    if (match[1] !== stamp) continue;
    const n = toInt(match[2]);
    if (n > max) max = n;
  }
  const file = `${stamp}-${padIndex(max + 1)}.md`;
  return path.join(dir, REVIEW_DIR, file);
};

const listReviewNames = (dir, readdirSync = fs.readdirSync) => {
  const folder = path.join(dir, REVIEW_DIR);
  try {
    return readdirSync(folder);
  } catch {
    return [];
  }
};

const compareReviewNames = (left, right) => {
  const a = REVIEW_NAME.exec(left);
  const b = REVIEW_NAME.exec(right);
  if (!a && !b) return 0;
  if (!a) return -1;
  if (!b) return 1;
  if (a[1] < b[1]) return -1;
  if (a[1] > b[1]) return 1;
  return toInt(a[2]) - toInt(b[2]);
};

const latestReviewName = (names) => {
  let best = '';
  for (const name of names) {
    if (!REVIEW_NAME.test(name)) continue;
    if (!best || compareReviewNames(name, best) > 0) best = name;
  }
  return best;
};

const canonicalStatus = (raw) => {
  if (!raw) return '';
  const name = STATUS_ALIAS[raw] ?? raw;
  if (REVIEW_STATUSES.includes(name)) return name;
  return '';
};

const parseFrontmatterStatus = (text) => {
  if (!text.startsWith('---')) return '';
  const nl = text.indexOf('\n');
  if (nl < 0) return '';
  const rest = text.slice(nl + 1);
  const end = rest.indexOf('\n---');
  if (end < 0) return '';
  const matter = rest.slice(0, end);
  for (const line of matter.split('\n')) {
    const match = STATUS_LINE.exec(line);
    if (match) return canonicalStatus(match[1]);
  }
  return '';
};

const readReviewStatus = (reviewPath, readFileSync = fs.readFileSync) => {
  try {
    return parseFrontmatterStatus(readFileSync(reviewPath, 'utf8'));
  } catch {
    return '';
  }
};

const resolveReviewPath = (dir, date, existingNames, options = {}) => {
  const forceNew = options.forceNew ?? false;
  const readFileSync = options.readFileSync ?? fs.readFileSync;
  if (!forceNew) {
    const latest = latestReviewName(existingNames);
    if (latest) {
      const reviewPath = path.join(dir, REVIEW_DIR, latest);
      const status = readReviewStatus(reviewPath, readFileSync);
      if (status === 'editing') return { reviewPath, resume: true };
    }
  }
  return {
    reviewPath: allocateReviewPath(dir, date, existingNames),
    resume: false,
  };
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

const createStore = (reviewPath, templates = []) => ({
  reviewPath,
  dirty: false,
  nextTodoId: 1,
  feedback: new Map(),
  todos: [],
  templates: [...templates],
  status: 'editing',
});

const noteCounts = (store) => {
  const counts = { feedback: 0, todo: 0 };
  if (!store) return counts;
  for (const todo of store.todos) {
    if (todo.text.trim()) counts.todo += 1;
  }
  for (const note of store.feedback.values()) {
    if (note.text.trim()) counts.feedback += 1;
  }
  return counts;
};

const hasNotes = (store) => {
  const counts = noteCounts(store);
  return counts.feedback > 0 || counts.todo > 0;
};

const rememberTemplate = (store, prevText, nextText) => {
  const trimmed = nextText.trim();
  if (!trimmed) return;
  const prev = (prevText ?? '').trim();
  if (prev === trimmed) return;
  store.templates = upsertTemplate(store.templates, trimmed);
  store.dirty = true;
};

const setFeedback = (store, key, note) => {
  const text = note.text ?? '';
  const trimmed = text.trim();
  const prev = store.feedback.get(key);
  if (!trimmed) {
    if (!prev) return;
    store.feedback.delete(key);
    store.dirty = true;
    return;
  }
  if (prev && prev.text === text) return;
  store.feedback.set(key, {
    file: note.file,
    oldStart: note.oldStart ?? 0,
    newStart: note.newStart ?? 0,
    blockId: note.blockId ?? 0,
    origin: note.origin ?? '',
    header: note.header ?? '',
    text,
    done: note.done ?? prev?.done ?? false,
  });
  store.dirty = true;
};

const addTodo = (store, file, text = '') => {
  const id = store.nextTodoId;
  store.nextTodoId += 1;
  const todo = { id, file, text, done: false };
  store.todos.push(todo);
  store.dirty = true;
  return todo;
};

const removeTodo = (store, id) => {
  const next = [];
  let found = false;
  for (const todo of store.todos) {
    if (todo.id === id) {
      found = true;
      continue;
    }
    next.push(todo);
  }
  if (!found) return false;
  store.todos = next;
  store.dirty = true;
  return true;
};

const setTodoText = (store, id, text) => {
  const i = store.todos.findIndex((todo) => todo.id === id);
  if (i < 0) return;
  const prev = store.todos[i];
  const trimmed = text.trim();
  if (!trimmed) {
    removeTodo(store, id);
    return;
  }
  if (prev.text === text) return;
  store.todos[i] = { id: prev.id, file: prev.file, text, done: prev.done };
  store.dirty = true;
};

const isDoneMark = (mark) => mark === 'x' || mark === 'X';

const pushTodo = (store, file, text, done) => {
  const id = store.nextTodoId;
  store.nextTodoId += 1;
  store.todos.push({ id, file, text, done });
};

const checkboxLine = (text, done) => {
  const flat = text.trim().replace(/\n/g, ' ');
  const mark = done ? 'x' : ' ';
  return `- [${mark}] ${flat}`;
};

const checkLabel = (text, done) => {
  const mark = done ? 'x' : ' ';
  return `[${mark}] ${text}`;
};

const feedbackKey = (note) => {
  const file = note.file ?? '';
  const oldStart = note.oldStart ?? 0;
  const newStart = note.newStart ?? 0;
  const block = note.blockId ?? 0;
  return `${file}:${oldStart}:${newStart}:${block}`;
};

const applyImportedNotes = (store, imported) => {
  if (!store || !imported) return;
  const feedbacks = imported.feedback ?? [];
  for (const note of feedbacks) {
    const key = feedbackKey(note);
    const prev = store.feedback.get(key);
    const text = prev ? `${prev.text}\n\n${note.text}` : note.text;
    const done = prev ? prev.done && !!note.done : !!note.done;
    setFeedback(store, key, {
      file: note.file,
      oldStart: note.oldStart ?? 0,
      newStart: note.newStart ?? 0,
      blockId: note.blockId ?? 0,
      origin: note.origin ?? '',
      header: note.header ?? '',
      text,
      done,
    });
  }
  const todos = imported.todos ?? [];
  for (const todo of todos) {
    const added = addTodo(store, todo.file || '', todo.text ?? '');
    if (todo.done) added.done = true;
  }
};

const storeFeedback = (store, note, key) => {
  const next = {
    file: note.file,
    oldStart: note.oldStart ?? 0,
    newStart: note.newStart ?? 0,
    blockId: note.blockId ?? 0,
    origin: note.origin ?? '',
    header: note.header ?? '',
    text: note.text,
    done: note.done ?? false,
  };
  store.feedback.set(key || feedbackKey(next), next);
};

const feedbackLine = (note) => {
  const loc = feedbackKey(note);
  return `${checkboxLine(note.text, note.done)} - ${loc}`;
};

const parseLoc = (raw) => {
  const parts = raw.split(':');
  const n = parts.length;
  if (n < 4) return null;
  const blockId = toInt(parts[n - 1]);
  const newStart = toInt(parts[n - 2]);
  const oldStart = toInt(parts[n - 3]);
  if (!Number.isFinite(blockId + newStart + oldStart)) return null;
  let fileParts = parts.slice(0, n - 3);
  let origin = '';
  if (fileParts.length > 1 && GIT_ORIGINS.includes(fileParts[0])) {
    origin = fileParts[0];
    fileParts = fileParts.slice(1);
  }
  if (!fileParts.length) return null;
  return {
    origin,
    file: fileParts.join(':'),
    oldStart,
    newStart,
    blockId,
  };
};

const parseFeedSuffix = (textItem) => {
  const match = FEED_SUFFIX.exec(textItem);
  if (!match) return null;
  return {
    text: match[1],
    file: match[2],
    oldStart: toInt(match[3]),
    newStart: toInt(match[4]),
    blockId: toInt(match[5]),
  };
};

const fileGroup = (groups, file) => {
  let group = groups.get(file);
  if (!group) {
    group = { todos: [], feedback: [] };
    groups.set(file, group);
  }
  return group;
};

const groupReviewNotes = (store) => {
  const groups = new Map();
  for (const todo of store.todos) {
    if (!todo.text.trim()) continue;
    fileGroup(groups, todo.file).todos.push(todo);
  }
  for (const [key, note] of store.feedback) {
    if (!note.text.trim()) continue;
    fileGroup(groups, note.file).feedback.push({ key, note });
  }
  return groups;
};

const reviewHeader = (store) => {
  const name = path.basename(store.reviewPath, '.md');
  const status = canonicalStatus(store.status) || 'editing';
  return [
    '---',
    `status: ${status}`,
    '---',
    '',
    `# reslop review ${name}`,
    '',
    '## Agent instructions',
    '',
    AGENT_INSTRUCTIONS,
    '',
  ];
};

const emitReviewGroups = (lines, groups) => {
  for (const [file, group] of groups) {
    lines.push(`## ${file}`);
    lines.push('');
    for (const todo of group.todos) {
      lines.push(checkboxLine(todo.text, todo.done));
    }
    for (const item of group.feedback) {
      lines.push(feedbackLine(item.note));
    }
    lines.push('');
  }
};

const serializeReview = (store) => {
  const lines = reviewHeader(store);
  emitReviewGroups(lines, groupReviewNotes(store));
  return `${lines.join('\n')}\n`;
};

const parseFeedbackHeading = (line) => {
  const match = FEED_HEAD.exec(line);
  if (!match) return null;
  const file = match[1];
  const newStart = toInt(match[2]);
  const rest = match[3];
  const only = FEED_BLOCK_ONLY.exec(rest);
  if (only) {
    return { file, newStart, header: '', blockId: toInt(only[1]) };
  }
  const withHead = FEED_BLOCK.exec(rest);
  if (!withHead) {
    return { file, newStart, header: rest, blockId: 0 };
  }
  return {
    file,
    newStart,
    header: withHead[1],
    blockId: toInt(withHead[2]),
  };
};

const flushPendingFeedback = (store, pending) => {
  if (!pending || !(pending.text ?? '').trim()) return null;
  storeFeedback(store, pending, pending.key);
  return null;
};

const headingFile = (line) => {
  const quoted = FILE_QUOTE.exec(line);
  if (quoted) return quoted[1];
  if (line.startsWith('## ') && line !== '## Agent instructions') {
    return line.slice(3);
  }
  return null;
};

const startFeedbackPending = (heading, file) => ({
  file: heading.file || file,
  newStart: heading.newStart,
  header: heading.header,
  blockId: heading.blockId,
  oldStart: heading.newStart,
  origin: '',
  key: '',
  text: '',
});

const applyFeedMeta = (pending, raw) => {
  const loc = parseLoc(raw);
  if (!loc) return pending;
  pending.origin = loc.origin;
  pending.file = loc.file;
  pending.oldStart = loc.oldStart;
  pending.newStart = loc.newStart;
  pending.blockId = loc.blockId;
  pending.key = feedbackKey(loc);
  return pending;
};

const applyCheckItem = (store, file, section, pending, textItem, done) => {
  if (section === 'todo' && file) {
    pushTodo(store, file, textItem, done);
    return pending;
  }
  const parsed = parseFeedSuffix(textItem);
  if (parsed) {
    flushPendingFeedback(store, pending);
    storeFeedback(store, {
      file: parsed.file || file,
      oldStart: parsed.oldStart,
      newStart: parsed.newStart,
      blockId: parsed.blockId,
      origin: '',
      header: '',
      text: parsed.text,
      done,
    });
    return null;
  }
  if (pending) {
    pending.text = textItem;
    pending.done = done;
    return flushPendingFeedback(store, pending);
  }
  if (file && section !== 'feedback') {
    pushTodo(store, file, textItem, done);
  }
  return pending;
};

const applyReviewLine = (store, file, section, pending, line) => {
  const nextFile = headingFile(line);
  if (nextFile !== null) {
    pending = flushPendingFeedback(store, pending);
    return { file: nextFile, section: '', pending };
  }
  const nextSection = SECTION_LINE[line];
  if (nextSection) {
    pending = flushPendingFeedback(store, pending);
    return { file, section: nextSection, pending };
  }
  const heading = parseFeedbackHeading(line);
  if (heading) {
    flushPendingFeedback(store, pending);
    pending = startFeedbackPending(heading, file);
    return { file, section: 'feedback', pending };
  }
  const meta = FEED_META.exec(line);
  if (meta && pending) {
    pending = applyFeedMeta(pending, meta[1]);
    return { file, section, pending };
  }
  const item = CHECK_ITEM.exec(line);
  if (!item) return { file, section, pending };
  const done = isDoneMark(item[1]);
  pending = applyCheckItem(store, file, section, pending, item[2], done);
  return { file, section, pending };
};

const parseReview = (text, reviewPath, templates = []) => {
  const store = createStore(reviewPath, templates);
  store.status = parseFrontmatterStatus(text) || 'editing';
  let file = '';
  let section = '';
  let pending = null;
  for (const line of text.split('\n')) {
    const next = applyReviewLine(store, file, section, pending, line);
    file = next.file;
    section = next.section;
    pending = next.pending;
  }
  flushPendingFeedback(store, pending);
  store.dirty = false;
  return store;
};

const loadReview = (reviewPath, templates, readFileSync = fs.readFileSync) => {
  const raw = readFileSync(reviewPath, 'utf8');
  return parseReview(raw, reviewPath, templates);
};

const loadTemplates = (dir, readFileSync = fs.readFileSync) => {
  const file = path.join(dir, REVIEW_DIR, TEMPLATES_FILE);
  try {
    const raw = readFileSync(file, 'utf8');
    const data = JSON.parse(raw);
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
  } catch {
    return [];
  }
};

const flushReview = (store, io = {}) => {
  const writeFileSync = io.writeFileSync ?? fs.writeFileSync;
  const mkdirSync = io.mkdirSync ?? fs.mkdirSync;
  if (!store || !store.dirty) return false;
  if (!hasNotes(store) && !io.force) {
    store.dirty = false;
    return false;
  }
  const folder = path.dirname(store.reviewPath);
  mkdirSync(folder, { recursive: true });
  writeFileSync(store.reviewPath, serializeReview(store), 'utf8');
  const top = path.dirname(folder);
  const templatesFile = path.join(top, REVIEW_DIR, TEMPLATES_FILE);
  const body = `${JSON.stringify(store.templates, null, 2)}\n`;
  writeFileSync(templatesFile, body, 'utf8');
  store.dirty = false;
  return true;
};

const todosByFile = (todos) => {
  const byFile = new Map();
  for (const todo of todos) {
    const list = byFile.get(todo.file);
    if (list) list.push(todo);
    else byFile.set(todo.file, [todo]);
  }
  return byFile;
};

const makeTodoItem = (file) => ({
  origin: 'todo',
  file: {
    oldPath: file,
    newPath: file,
    isNew: false,
    isDeleted: false,
    isBinary: false,
    preamble: [],
    hunks: [],
  },
  hunk: null,
  blockId: 'todo',
  patchAdd: '',
  patchRevert: '',
});

const mergeTodos = (gitItems, todos, extraFiles = []) => {
  const base = gitItems.filter((item) => item.origin !== 'todo');
  const byFile = todosByFile(todos);
  for (const file of extraFiles) {
    if (!file || byFile.has(file)) continue;
    byFile.set(file, []);
  }
  if (!byFile.size) return base;
  const out = [];
  const placed = new Set();
  const placePage = (rel) => {
    if (placed.has(rel)) return;
    if (!byFile.has(rel)) return;
    placed.add(rel);
    out.push(makeTodoItem(rel));
  };
  for (let i = 0; i < base.length; i++) {
    const item = base[i];
    const rel = itemPath(item);
    const prev = base[i - 1];
    const prevRel = prev ? itemPath(prev) : '';
    if (rel !== prevRel) placePage(rel);
    out.push(item);
  }
  for (const rel of byFile.keys()) {
    if (placed.has(rel)) continue;
    placePage(rel);
  }
  return out;
};

module.exports = {
  REVIEW_DIR,
  TEMPLATES_FILE,
  TEMPLATE_SHOW,
  AUTOSAVE_MS,
  REVIEW_STATUSES,
  AGENT_INSTRUCTIONS,
  dateStamp,
  allocateReviewPath,
  listReviewNames,
  compareReviewNames,
  latestReviewName,
  parseFrontmatterStatus,
  readReviewStatus,
  resolveReviewPath,
  rankedTemplates,
  prefixTemplates,
  upsertTemplate,
  createStore,
  noteCounts,
  hasNotes,
  rememberTemplate,
  setFeedback,
  addTodo,
  removeTodo,
  setTodoText,
  isDoneMark,
  checkLabel,
  feedbackKey,
  applyImportedNotes,
  serializeReview,
  parseReview,
  loadReview,
  loadTemplates,
  flushReview,
  makeTodoItem,
  mergeTodos,
};
