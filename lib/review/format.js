'use strict';

const { MarkdownDoc, blockText, textFrontmatter } = require('./markdown.js');
const blocks = require('./blocks.js');
const { AGENT_INSTRUCTIONS, isInstructions, isReviewName, parsePlan } = blocks;
const { instructionLines } = blocks;
const { ReviewStore, canonicalStatus } = require('./store.js');

const frontmatterStatus = (text) => textFrontmatter(text).status ?? '';

const parseFrontmatterStatus = (text) =>
  canonicalStatus(frontmatterStatus(text));

const instructionsText = (list) => list.map(blockText).join('\n').trim();

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
