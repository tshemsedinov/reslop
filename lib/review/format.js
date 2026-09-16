'use strict';

const path = require('node:path');

const { TODO_FILE } = require('../files.js');
const store = require('./store.js');
const { createStore, feedbackKey } = store;

const REVIEW_STATUSES = ['editing', 'ready', 'partial', 'done'];
const FEED_HEAD = /^### Feedback `([^`]+)` \+(\d+) \((.*)\)\s*$/;
const FEED_BLOCK = /^(.*), block (\d+)$/;
const FEED_BLOCK_ONLY = /^block (\d+)$/;
const FEED_META = /^<!-- reslop:(.*) -->\s*$/;
const FEED_SUFFIX = /^(.*) - (.+):(\d+):(\d+):(\d+)$/;
const CHECK_ITEM = /^- \[([ xX])\] (.*)$/;
const CODE_HEAD = /^- \[([ xX])\] code `([^`]+)`\s*$/;
const FENCE_LINE = /^(`{3,})\s*$/;
const FILE_QUOTE = /^> (.+)$/;
const STATUS_LINE = /^status:\s*(\S+)\s*$/;
const GIT_ORIGINS = ['unstaged', 'staged', 'untracked', 'commit', 'pr'];
const SECTION_LINE = {
  '### Todo': 'todo',
  '### Feedback': 'feedback',
};

const AGENT_INSTRUCTIONS = [
  'Execute reviews with `status: ready` or `status: partial`.',
  'Do not start `editing` or `done` review files.',
  'Work through unchecked items. After finishing one, mark it `[x]`.',
  'For `code` items, replace added lines at that location with the fence.',
  'Set `status` to `partial` if some remain, or `done` if all are `[x]`.',
  'Do not redo items already marked `[x]`.',
].join('\n');

const toInt = (text) => parseInt(text, 10);

const canonicalStatus = (raw) => {
  if (!raw) return '';
  const name = raw === 'pending' ? 'ready' : raw;
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

const isDoneMark = (mark) => mark === 'x' || mark === 'X';

const pushTodo = (builder, file, text, done) => {
  const id = builder.nextTodoId;
  builder.nextTodoId += 1;
  builder.todos.push({ id, file, text, done });
};

const checkboxLine = (text, done) => {
  const flat = text.trim().replace(/\n/g, ' ');
  const mark = done ? 'x' : ' ';
  return `- [${mark}] ${flat}`;
};

const storeFeedback = (builder, note, key) => {
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
  builder.feedback.set(key || feedbackKey(next), next);
};

const storeCode = (builder, note, key) => {
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
  builder.code.set(key || feedbackKey(next), next);
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
  const file = fileParts.join(':');
  return { origin, file, oldStart, newStart, blockId };
};

const parseFeedSuffix = (textItem) => {
  const match = FEED_SUFFIX.exec(textItem);
  if (!match) return null;
  const text = match[1];
  const file = match[2];
  const oldStart = toInt(match[3]);
  const newStart = toInt(match[4]);
  const blockId = toInt(match[5]);
  return { text, file, oldStart, newStart, blockId };
};

const fileGroup = (groups, file) => {
  let group = groups.get(file);
  if (!group) {
    group = { todos: [], feedback: [], code: [] };
    groups.set(file, group);
  }
  return group;
};

const groupReviewNotes = (notes) => {
  const groups = new Map();
  for (const todo of notes.todos) {
    if (!todo.text.trim()) continue;
    fileGroup(groups, TODO_FILE).todos.push(todo);
  }
  for (const key of notes.feedback.keys()) {
    const note = notes.feedback.get(key);
    if (!note.text.trim()) continue;
    fileGroup(groups, note.file).feedback.push({ key, note });
  }
  for (const key of notes.code.keys()) {
    const note = notes.code.get(key);
    fileGroup(groups, note.file).code.push({ key, note });
  }
  return groups;
};

const reviewHeader = (notes) => {
  const name = path.basename(notes.reviewPath, '.md');
  const status = canonicalStatus(notes.status) || 'editing';
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

const fenceFor = (text) => {
  let n = 3;
  for (const line of text.split('\n')) {
    const match = /^(`{3,})/.exec(line);
    if (!match) continue;
    if (match[1].length >= n) n = match[1].length + 1;
  }
  return '`'.repeat(n);
};

const emitCodeItem = (lines, note) => {
  const loc = feedbackKey(note);
  const mark = note.done ? 'x' : ' ';
  const fence = fenceFor(note.text);
  lines.push(`- [${mark}] code \`${loc}\``);
  lines.push(fence);
  if (note.text !== '') lines.push(note.text);
  lines.push(fence);
};

const emitReviewGroups = (lines, groups) => {
  for (const file of groups.keys()) {
    const group = groups.get(file);
    lines.push(`## ${file}`);
    lines.push('');
    for (const todo of group.todos) {
      lines.push(checkboxLine(todo.text, todo.done));
    }
    for (const item of group.feedback) {
      lines.push(feedbackLine(item.note));
    }
    for (const item of group.code) {
      emitCodeItem(lines, item.note);
    }
    lines.push('');
  }
};

const serializeReview = (notes) => {
  const lines = reviewHeader(notes);
  emitReviewGroups(lines, groupReviewNotes(notes));
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
  const header = withHead[1];
  const blockId = toInt(withHead[2]);
  return { file, newStart, header, blockId };
};

const flushPendingFeedback = (builder, pending) => {
  if (!pending || !(pending.text ?? '').trim()) return null;
  storeFeedback(builder, pending, pending.key);
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

const applyCheckItem = (builder, file, section, pending, textItem, done) => {
  if (section === 'todo' && file) {
    pushTodo(builder, file, textItem, done);
    return pending;
  }
  const parsed = parseFeedSuffix(textItem);
  if (parsed) {
    flushPendingFeedback(builder, pending);
    storeFeedback(builder, {
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
    return flushPendingFeedback(builder, pending);
  }
  if (file && section !== 'feedback') {
    pushTodo(builder, file, textItem, done);
  }
  return pending;
};

const applyReviewLine = (builder, file, section, pending, line) => {
  const nextFile = headingFile(line);
  if (nextFile !== null) {
    pending = flushPendingFeedback(builder, pending);
    return { file: nextFile, section: '', pending };
  }
  const nextSection = SECTION_LINE[line];
  if (nextSection) {
    pending = flushPendingFeedback(builder, pending);
    return { file, section: nextSection, pending };
  }
  const heading = parseFeedbackHeading(line);
  if (heading) {
    flushPendingFeedback(builder, pending);
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
  pending = applyCheckItem(builder, file, section, pending, item[2], done);
  return { file, section, pending };
};

const startCodePending = (line) => {
  const match = CODE_HEAD.exec(line);
  if (!match) return null;
  const loc = parseLoc(match[2]);
  if (!loc) return null;
  return {
    done: isDoneMark(match[1]),
    origin: loc.origin,
    file: loc.file,
    oldStart: loc.oldStart,
    newStart: loc.newStart,
    blockId: loc.blockId,
    open: '',
    lines: [],
  };
};

const storeCodeNote = (builder, pending, text) => {
  storeCode(builder, {
    file: pending.file,
    oldStart: pending.oldStart,
    newStart: pending.newStart,
    blockId: pending.blockId,
    origin: pending.origin,
    header: '',
    text,
    done: pending.done,
  });
};

const flushPendingCode = (builder, pending) => {
  if (!pending) return;
  const text = pending.open ? pending.lines.join('\n') : '';
  storeCodeNote(builder, pending, text);
};

const takeCodeLine = (builder, pending, line) => {
  const fence = FENCE_LINE.exec(line);
  if (!pending.open) {
    if (fence) {
      pending.open = fence[1];
      return pending;
    }
    if (!line.trim()) return pending;
    storeCodeNote(builder, pending, '');
    return 'fallthrough';
  }
  if (fence && fence[1].length >= pending.open.length) {
    storeCodeNote(builder, pending, pending.lines.join('\n'));
    return null;
  }
  pending.lines.push(line);
  return pending;
};

const parseReview = (text, reviewPath, templates = []) => {
  const builder = createStore(reviewPath, templates);
  builder.status = parseFrontmatterStatus(text) || 'editing';
  let file = '';
  let section = '';
  let pending = null;
  let pendingCode = null;
  for (const line of text.split('\n')) {
    if (pendingCode) {
      const nextCode = takeCodeLine(builder, pendingCode, line);
      if (nextCode === 'fallthrough') {
        pendingCode = null;
      } else {
        pendingCode = nextCode;
        continue;
      }
    }
    const started = startCodePending(line);
    if (started) {
      pending = flushPendingFeedback(builder, pending);
      pendingCode = started;
      continue;
    }
    const next = applyReviewLine(builder, file, section, pending, line);
    file = next.file;
    section = next.section;
    pending = next.pending;
  }
  flushPendingCode(builder, pendingCode);
  flushPendingFeedback(builder, pending);
  builder.dirty = false;
  return builder;
};

module.exports = {
  parseFrontmatterStatus,
  serializeReview,
  parseReview,
};
