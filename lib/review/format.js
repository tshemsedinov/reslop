'use strict';

const { MarkdownDoc } = require('./markdown.js');
const blocks = require('./blocks.js');
const { AGENT_INSTRUCTIONS, isInstructions, isReviewName, parsePlan } = blocks;
const { instructionLines } = blocks;
const { ReviewStore, canonicalStatus } = require('./store.js');

const STATUS_LINE = /^status:\s*(\S+)\s*$/;

const frontmatterStatus = (text) => {
  const body = `${text ?? ''}`;
  if (!body.startsWith('---')) return '';
  const nl = body.indexOf('\n');
  if (nl < 0) return '';
  const rest = body.slice(nl + 1);
  const end = rest.indexOf('\n---');
  if (end < 0) return '';
  for (const line of rest.slice(0, end).split('\n')) {
    const match = STATUS_LINE.exec(line);
    if (match) return match[1];
  }
  return '';
};

const parseFrontmatterStatus = (text) =>
  canonicalStatus(frontmatterStatus(text));

const instructionsText = (list) =>
  list
    .flatMap((block) => block.lines)
    .join('\n')
    .replace(/\r/g, '')
    .trim();

// An edited reslop plan that is still open gets the current agent
// instructions; a done plan and any other file keep what they say
const syncInstructions = (store) => {
  if (!store.dirty || !isReviewName(store.reviewPath)) return;
  if (store.status === 'done') return;
  const doc = store.doc;
  const head = doc.blocks.find(isInstructions);
  if (!head) return;
  const [first, end] = store.sectionRange(head);
  const body = doc.blocks.slice(first, end);
  if (instructionsText(body) === AGENT_INSTRUCTIONS) return;
  const fresh = MarkdownDoc.parse(`${instructionLines().join('\n')}\n`);
  for (const block of body) doc.remove(block);
  let at = first;
  for (const block of fresh.blocks) {
    const lines = block.lines.map((line) => doc.line(line));
    doc.insert(at, doc.block(block.type, lines));
    at += 1;
  }
};

const serializeReview = (store) => {
  syncInstructions(store);
  return store.doc.toString();
};

const parseReview = (text, reviewPath, templates = []) => {
  const source = `${text ?? ''}`;
  const store = new ReviewStore(reviewPath, templates, parsePlan(source));
  store.dirty = false;
  store.baseline = source;
  return store;
};

module.exports = {
  frontmatterStatus,
  parseFrontmatterStatus,
  serializeReview,
  parseReview,
};
