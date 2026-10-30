'use strict';

const path = require('node:path');
const { TASK_KINDS } = require('../common/files.js');
const { toInt, resource } = require('../common/utilities.js');
const markdown = require('./markdown.js');
const { MarkdownDoc, CODE_ITEM, bare, fenceOf, closesFence } = markdown;
const { TaskItem, isDoneMark, taskLines } = require('./task.js');

const REVIEW_NAME = /^(\d{4}-\d{2}-\d{2})-(\d+)\.md$/;

const INSTRUCTIONS_TITLE = 'Agent instructions';

const AGENT_INSTRUCTIONS = resource(__dirname, 'agent-instructions.md').trim();

const TASK_TITLES = {
  Backlog: 'debt',
  TODOs: 'debt',
  Issues: 'debt',
  'Bug Reports': 'bugs',
  'Feature Requests': 'features',
  'Technical debt': 'debt',
  Research: 'research',
  Security: 'security',
  ...Object.fromEntries(TASK_KINDS.map((kind) => [kind.title, kind.id])),
};

const KIND_BY_TITLE = new Map(
  Object.entries(TASK_TITLES).map(([title, id]) => [title.toLowerCase(), id]),
);

const FEED_HEAD = /^### Feedback `([^`]+)` \+(\d+) \((.*)\)\s*$/;

const FEED_BLOCK = /^(.*), block (\d+)$/;

const FEED_BLOCK_ONLY = /^block (\d+)$/;

const FEED_META = /^<!-- reslop:(.*) -->\s*$/;

const FEED_SUFFIX = /^([\s\S]*) - (.+):(\d+):(\d+):(\d+)$/;

const GIT_ORIGINS = ['unstaged', 'staged', 'untracked', 'commit', 'pr'];

const isReviewName = (file) => REVIEW_NAME.test(path.basename(file ?? ''));

const isHeading = (block) => block?.type === 'heading';

const isInstructions = (block) =>
  isHeading(block) && block.text === INSTRUCTIONS_TITLE;

const headingKind = (block) => {
  if (!isHeading(block) || block.level > 2) return '';
  return KIND_BY_TITLE.get(block.text.toLowerCase()) ?? '';
};

// The `#` or `##` heading a block is under, through any deeper ones
const sectionHead = (block) => {
  let head = isHeading(block) && block.level <= 2 ? block : block.heading;
  while (head && head.level > 2) head = head.heading;
  return head;
};

const blockKind = (block) => headingKind(sectionHead(block));

const feedbackKey = (note) => {
  const file = note.file ?? '';
  const oldStart = note.oldStart ?? 0;
  const newStart = note.newStart ?? 0;
  const block = note.blockId ?? 0;
  return `${file}:${oldStart}:${newStart}:${block}`;
};

const toNote = (note, done = false) => ({
  file: note.file,
  oldStart: note.oldStart ?? 0,
  newStart: note.newStart ?? 0,
  blockId: note.blockId ?? 0,
  origin: note.origin ?? '',
  header: note.header ?? '',
  text: note.text ?? '',
  done: note.done ?? done,
});

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

const parseFeedSuffix = (text) => {
  const match = FEED_SUFFIX.exec(text);
  if (!match) return null;
  return {
    text: match[1],
    file: match[2],
    oldStart: toInt(match[3]),
    newStart: toInt(match[4]),
    blockId: toInt(match[5]),
  };
};

const parseFeedbackHeading = (line) => {
  const match = FEED_HEAD.exec(line);
  if (!match) return null;
  const file = match[1];
  const newStart = toInt(match[2]);
  const rest = match[3];
  const base = { file, newStart, oldStart: newStart, origin: '' };
  const only = FEED_BLOCK_ONLY.exec(rest);
  if (only) return { ...base, header: '', blockId: toInt(only[1]) };
  const withHead = FEED_BLOCK.exec(rest);
  if (!withHead) return { ...base, header: rest, blockId: 0 };
  return { ...base, header: withHead[1], blockId: toInt(withHead[2]) };
};

const codeNote = (block) => {
  const lines = block.lines.map(bare);
  const head = CODE_ITEM.exec(lines[0]);
  const loc = head ? parseLoc(head[2]) : null;
  if (!loc) return null;
  let at = 1;
  while (at < lines.length && !lines[at].trim()) at += 1;
  const fence = at < lines.length ? fenceOf(lines[at]) : null;
  let text = '';
  if (fence) {
    const body = lines.slice(at + 1);
    const last = body.length - 1;
    const closed = last >= 0 && closesFence(body[last], fence);
    text = (closed ? body.slice(0, last) : body).join('\n');
  }
  return toNote({ ...loc, text, done: isDoneMark(head[1]) });
};

const feedbackNote = (block, pending) => {
  const item = new TaskItem(block.lines);
  const parsed = parseFeedSuffix(item.text);
  if (parsed) return toNote({ ...parsed, done: item.done });
  if (!pending) return null;
  return toNote({ ...pending, text: item.text, done: item.done });
};

const asNote = (block, type, note, key) => {
  block.type = type;
  block.note = note;
  block.key = key || feedbackKey(note);
};

// Gives each checkbox item its review meaning: a task, a feedback note on a
// diff block, or a code proposal
const classify = (doc) => {
  let pending = null;
  for (const block of doc.layout()) {
    if (isHeading(block)) {
      pending = parseFeedbackHeading(bare(block.lines[0]));
      continue;
    }
    if (block.type === 'text' && pending) {
      const meta = FEED_META.exec(bare(block.lines[0]));
      const loc = meta ? parseLoc(meta[1]) : null;
      if (loc) Object.assign(pending, loc);
      continue;
    }
    if (block.type !== 'item') continue;
    const code = block.code ? codeNote(block) : null;
    if (code) {
      asNote(block, 'code', code);
      continue;
    }
    const feedback = blockKind(block) ? null : feedbackNote(block, pending);
    if (feedback) {
      asNote(block, 'feedback', feedback, pending ? feedbackKey(pending) : '');
      pending = null;
      continue;
    }
    block.type = 'task';
  }
  return doc;
};

const parsePlan = (text) => classify(MarkdownDoc.parse(text));

const feedbackLines = (note) => {
  const lines = taskLines(note.text, note.done);
  lines[lines.length - 1] += ` - ${feedbackKey(note)}`;
  return lines;
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

const codeLines = (note) => {
  const mark = note.done ? 'x' : ' ';
  const fence = fenceFor(note.text);
  const lines = [`- [${mark}] code \`${feedbackKey(note)}\``, fence];
  if (note.text !== '') lines.push(...note.text.split('\n'));
  lines.push(fence);
  return lines;
};

const instructionLines = () => ['', ...AGENT_INSTRUCTIONS.split('\n'), ''];

const newPlanText = (reviewPath, status = 'editing') => {
  const name = path.basename(reviewPath, '.md');
  const lines = ['---', `status: ${status}`, '---', ''];
  lines.push(`# reslop review ${name}`, '');
  lines.push(`## ${INSTRUCTIONS_TITLE}`, ...instructionLines());
  return `${lines.join('\n')}\n`;
};

module.exports = {
  REVIEW_NAME,
  AGENT_INSTRUCTIONS,
  isReviewName,
  isHeading,
  isInstructions,
  headingKind,
  sectionHead,
  blockKind,
  feedbackKey,
  toNote,
  classify,
  parsePlan,
  feedbackLines,
  codeLines,
  instructionLines,
  newPlanText,
};
