'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { visibleWidth } = require('../../term/ansi.js');
const { padVisible } = require('../../render/primitives.js');
const review = require('../../review/review.js');
const { parseReview, reviewProgress, frontmatterStatus } = review;
const { trimText } = require('../../common/utilities.js');

const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;

const HEADING = /^#{1,3}\s+(.+)$/;

const TASK = /^- \[[ xX]\]\s+(.+)$/;

const DATE_TOKEN = /\d{4}-\d{2}-\d{2}(?:-\d+)?/;

const ITEM_PREFIX = /^F\d+:\s*/;

const CAPTION_MAX = 72;

const clipCaption = (text) => {
  const line = text.replace(/\s+/g, ' ').trim();
  if (line.length <= CAPTION_MAX) return line;
  return `${line.slice(0, CAPTION_MAX - 1)}…`;
};

const captionFromPlan = (text) => {
  const body = `${text ?? ''}`.replace(FRONTMATTER, '');
  let heading = '';
  let task = '';
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (!heading) {
      const head = HEADING.exec(line);
      if (head) heading = head[1].trim();
    }
    if (!task) {
      const item = TASK.exec(line);
      if (item) task = item[1].replace(ITEM_PREFIX, '').trim();
    }
    if (heading && task) break;
  }
  if (heading && !DATE_TOKEN.test(heading)) return clipCaption(heading);
  if (task) return clipCaption(task);
  return '';
};

const planCaption = (root, plan) => {
  const rel = `${plan ?? ''}`.trim();
  if (!rel || !root) return '';
  const file = path.isAbsolute(rel) ? rel : path.join(root, rel);
  try {
    return captionFromPlan(fs.readFileSync(file, 'utf8'));
  } catch {
    // missing plan
    return '';
  }
};

const planKey = (value) => {
  const text = trimText(value);
  if (!text) return '';
  const gap = text.indexOf('  ');
  return gap > 0 ? text.slice(0, gap) : path.basename(text);
};

const isLive = (store, file) => {
  const live = store ? store.reviewPath : '';
  return Boolean(live) && path.basename(live) === path.basename(file);
};

const planState = (file, store) => {
  if (isLive(store, file)) {
    const status = trimText(store.status) || 'editing';
    return { status, ...reviewProgress(store) };
  }
  try {
    const text = fs.readFileSync(file, 'utf8');
    const parsed = parseReview(text, file);
    const progress = reviewProgress(parsed);
    const fallback = progress.total ? 'editing' : '';
    const status = frontmatterStatus(text) ? parsed.status : fallback;
    return { status, done: progress.done, total: progress.total };
  } catch {
    return null;
  }
};

const planProgress = (file, root, store) => {
  if (!file) return '';
  const abs = path.isAbsolute(file) ? file : path.join(root, file);
  const state = planState(abs, store);
  return state && state.total ? `${state.done}/${state.total}` : '';
};

const planPart = (dir, name, store) => {
  const base = planKey(name);
  if (!base) return null;
  const state = planState(path.join(dir, base), store);
  if (!state || !state.status) return { name: base, status: '', progress: '' };
  const progress = `${state.done}/${state.total}`;
  return { name: base, status: state.status, progress };
};

const planLabel = (part) => {
  if (!part.status) return part.name;
  return `${part.name}  ${part.status}  ${part.progress}`;
};

const alignPlanLabels = (parts) => {
  let nameW = 0;
  let statusW = 0;
  for (const part of parts) {
    if (!part.status) continue;
    nameW = Math.max(nameW, visibleWidth(part.name));
    statusW = Math.max(statusW, visibleWidth(part.status));
  }
  return parts.map((part) => {
    if (!part.status) return part.name;
    const name = padVisible(part.name, nameW, 'end');
    const status = padVisible(part.status, statusW, 'end');
    return planLabel({ name, status, progress: part.progress });
  });
};

module.exports = {
  captionFromPlan,
  planCaption,
  planKey,
  planProgress,
  planPart,
  planLabel,
  alignPlanLabels,
};
