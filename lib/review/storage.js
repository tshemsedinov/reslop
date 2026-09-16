'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { REVIEW_DIR } = require('../files.js');
const format = require('./format.js');
const { serializeReview, parseReview, parseFrontmatterStatus } = format;
const { hasNotes } = require('./store.js');

const TEMPLATES_FILE = 'templates.json';
const AUTOSAVE_MS = 3000;
const REVIEW_NAME = /^(\d{4}-\d{2}-\d{2})-(\d+)\.md$/;

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

const readReviewStatus = (reviewPath, readFileSync = fs.readFileSync) => {
  try {
    const text = readFileSync(reviewPath, 'utf8');
    return parseFrontmatterStatus(text);
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
  const reviewPath = allocateReviewPath(dir, date, existingNames);
  const resume = false;
  return { reviewPath, resume };
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

const flushReview = (notes, io = {}) => {
  const writeFileSync = io.writeFileSync ?? fs.writeFileSync;
  const mkdirSync = io.mkdirSync ?? fs.mkdirSync;
  if (!notes || !notes.dirty) return false;
  if (!hasNotes(notes) && !io.force) {
    notes.dirty = false;
    return false;
  }
  const folder = path.dirname(notes.reviewPath);
  mkdirSync(folder, { recursive: true });
  writeFileSync(notes.reviewPath, serializeReview(notes), 'utf8');
  const top = path.dirname(folder);
  const templatesFile = path.join(top, REVIEW_DIR, TEMPLATES_FILE);
  const body = `${JSON.stringify(notes.templates, null, 2)}\n`;
  writeFileSync(templatesFile, body, 'utf8');
  notes.dirty = false;
  return true;
};

module.exports = {
  AUTOSAVE_MS,
  allocateReviewPath,
  listReviewNames,
  latestReviewName,
  resolveReviewPath,
  loadReview,
  loadTemplates,
  flushReview,
};
