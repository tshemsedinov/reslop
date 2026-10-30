'use strict';

const { textFrontmatter } = require('./markdown.js');
const { parsePlan } = require('./blocks.js');
const { ReviewStore, canonicalStatus } = require('./store.js');

const frontmatterStatus = (text) => textFrontmatter(text).status ?? '';

const parseFrontmatterStatus = (text) =>
  canonicalStatus(frontmatterStatus(text));

const serializeReview = (store) => store.doc.toString();

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
