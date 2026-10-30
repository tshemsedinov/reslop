'use strict';

const { parsePlan } = require('./blocks.js');

// The file on disk changed since the last read or write: an untouched plan
// takes the disk text, an edited one keeps its own
const mergeReview = (store, text) => {
  const base = store.baseline ?? '';
  if (text === base) return;
  if (store.doc.toString() === base) store.doc = parsePlan(text);
  store.baseline = text;
};

module.exports = { mergeReview };
