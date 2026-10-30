'use strict';

const fs = require('node:fs');
const path = require('node:path');
const files = require('../common/files.js');
const { REVIEW_DIR, taskKind, ISSUE_FILE, posixRel } = files;
const { mergeReview } = require('./merge.js');
const utilities = require('../common/utilities.js');
const { pad2, dateStamp, toInt, readText, writeJson } = utilities;
const { listDir, listEntries } = utilities;
const storePart = require('./store.js');
const { hasNotes, ReviewStore, noteCounts, reviewProgress } = storePart;
const { checkLabel, feedbackKey, TEMPLATES_FILE, LEGACY_TEMPLATES } = storePart;
const { TEMPLATE_SHOW, rankedTemplates, prefixTemplates } = storePart;
const { upsertTemplate, loadTemplates, canonicalStatus } = storePart;
const { textFrontmatter } = require('./markdown.js');
const { REVIEW_NAME, parsePlan } = require('./blocks.js');

const AUTOSAVE_MS = 3000;

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

// A plan in `.plan/` is named by its file name; one anywhere else by its
// path from the root
const planNameOf = (dir, file) => {
  const rel = posixRel(path.relative(dir, file));
  const parts = rel.split('/');
  if (parts.length === 2 && parts[0] === REVIEW_DIR) return parts[1];
  return rel;
};

const planPathOf = (dir, name) => {
  if (!name.includes('/')) return path.join(dir, REVIEW_DIR, name);
  return path.join(dir, ...name.split('/'));
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
  const next = max + 1;
  return path.join(dir, REVIEW_DIR, `${stamp}-${pad2(next)}.md`);
};

const listReviewNames = (dir) => listDir(path.join(dir, REVIEW_DIR));

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

const planFiles = (dir) => {
  const reviews = [];
  const notes = [];
  for (const entry of listEntries(path.join(dir, REVIEW_DIR))) {
    const name = entry.name;
    if (!entry.isFile() || !name.endsWith('.md')) continue;
    if (REVIEW_NAME.test(name)) reviews.push(name);
    else notes.push(name);
  }
  return { reviews, notes };
};

const planFileNames = (dir) => {
  const { reviews, notes } = planFiles(dir);
  reviews.sort((left, right) => compareReviewNames(right, left));
  return reviews.concat(notes.sort());
};

const orderedPlanNames = (dir) => {
  const { reviews, notes } = planFiles(dir);
  reviews.sort(compareReviewNames);
  notes.sort();
  return notes.concat(reviews);
};

const readReviewStatus = (reviewPath) =>
  parseFrontmatterStatus(readText(reviewPath));

const resolveReviewPath = (dir, date, existingNames, extra = {}) => {
  if (!extra.forceNew) {
    const latest = latestReviewName(existingNames);
    if (latest) {
      const reviewPath = path.join(dir, REVIEW_DIR, latest);
      if (readReviewStatus(reviewPath) === 'editing') {
        return { reviewPath, resume: true };
      }
    }
  }
  return {
    reviewPath: allocateReviewPath(dir, date, existingNames),
    resume: false,
  };
};

const loadReview = (reviewPath, templates) => {
  const raw = fs.readFileSync(reviewPath, 'utf8');
  return parseReview(raw, reviewPath, templates);
};

const readReviewText = (reviewPath) => {
  try {
    return fs.readFileSync(reviewPath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return '';
    throw error;
  }
};

// Takes in what an agent or an editor wrote since the last read or write
const mergeDiskReview = (notes) => {
  const text = readReviewText(notes.reviewPath);
  if (!text || text === notes.baseline) return false;
  mergeReview(notes, text);
  return true;
};

// A new plan stays unwritten while it is the untouched template with no
// note; an existing file is always written
const isBlankPlan = (notes) => {
  if (hasNotes(notes)) return false;
  const fresh = ReviewStore.newDoc(notes.reviewPath).toString();
  return notes.doc.toString() === fresh;
};

// The templates are written when they change, which retires the old file;
// a plan is saved far more often than a template is used
const saveTemplates = (notes, top) => {
  const text = JSON.stringify(notes.templates);
  if (text === notes.templatesSaved) return;
  writeJson(path.join(top, REVIEW_DIR, TEMPLATES_FILE), notes.templates);
  try {
    fs.rmSync(path.join(top, REVIEW_DIR, LEGACY_TEMPLATES));
  } catch {
    // ignore when the old templates file is already gone
  }
  notes.templatesSaved = text;
};

const flushReview = (notes, force = false) => {
  if (!notes || !notes.dirty) return false;
  const exists = mergeDiskReview(notes) || notes.baseline !== null;
  if (!exists && !force && isBlankPlan(notes)) {
    notes.dirty = false;
    return false;
  }
  const folder = path.dirname(notes.reviewPath);
  fs.mkdirSync(folder, { recursive: true });
  const text = serializeReview(notes);
  if (text !== notes.baseline) fs.writeFileSync(notes.reviewPath, text, 'utf8');
  saveTemplates(notes, path.dirname(folder));
  notes.baseline = text;
  notes.dirty = false;
  return true;
};

const issueTasks = (imported) => {
  const todos = imported.tasks ?? imported.todos ?? [];
  return todos.filter((todo) => (todo.file || '') === ISSUE_FILE);
};

class ReviewController {
  constructor() {
    this.reset();
  }

  reset() {
    this.store = null;
    this.didResume = false;
    this.importedRemote = false;
  }

  init(dir, date, extra = {}) {
    const names = listReviewNames(dir);
    const templates = loadTemplates(dir);
    const resolved = resolveReviewPath(dir, date, names, extra);
    this.didResume = resolved.resume === true;
    const reviewPath = resolved.reviewPath;
    if (this.didResume) this.store = loadReview(reviewPath, templates);
    else this.store = new ReviewStore(reviewPath, templates);
    return this.store;
  }

  applyImported(imported) {
    if (!imported || !this.store) return false;
    if (this.importedRemote) return false;
    const notes = this.didResume ? { tasks: issueTasks(imported) } : imported;
    this.store.applyImportedNotes(notes);
    this.importedRemote = true;
    return true;
  }

  flush(force = false) {
    if (!this.store) return { ok: true, wrote: false };
    try {
      const wrote = flushReview(this.store, force);
      return { ok: true, wrote };
    } catch (error) {
      return { ok: false, wrote: false, error };
    }
  }

  usePlan(dir, name) {
    const store = this.store;
    if (!store || !name) return false;
    const next = planPathOf(dir, name);
    if (next === store.reviewPath) return false;
    this.flush();
    const templates = store.templates;
    const loaded = fs.existsSync(next);
    if (loaded) this.store = loadReview(next, templates);
    else this.store = new ReviewStore(next, templates);
    return true;
  }
}

module.exports = {
  TEMPLATE_SHOW,
  AUTOSAVE_MS,
  allocateReviewPath,
  listReviewNames,
  latestReviewName,
  planFileNames,
  orderedPlanNames,
  planNameOf,
  planPathOf,
  parseFrontmatterStatus,
  resolveReviewPath,
  rankedTemplates,
  prefixTemplates,
  upsertTemplate,
  ReviewStore,
  noteCounts,
  reviewProgress,
  frontmatterStatus,
  hasNotes,
  taskKind,
  checkLabel,
  feedbackKey,
  serializeReview,
  parseReview,
  loadReview,
  loadTemplates,
  flushReview,
  mergeDiskReview,
  ReviewController,
};
