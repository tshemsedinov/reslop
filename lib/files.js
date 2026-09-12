'use strict';

const REVIEW_DIR = '.review';
const ORIGIN_ORDER = ['staged', 'unstaged', 'untracked', 'commit', 'pr'];

const normalizePathSpec = (spec) =>
  `${spec ?? ''}`.replaceAll('\\', '/').replace(/\/+$/, '');

const isPathInScope = (rel, paths) => {
  if (!paths.length) return true;
  for (const spec of paths) {
    const norm = normalizePathSpec(spec);
    if (!norm || norm === '.') return true;
    if (rel === norm || rel.startsWith(`${norm}/`)) return true;
  }
  return false;
};

const itemPath = (item) => {
  if (!item || !item.file) return '';
  return item.file.newPath || item.file.oldPath || '';
};

const fileStatus = (origins) => {
  const present = new Set(origins);
  const seen = ORIGIN_ORDER.filter((origin) => present.has(origin));
  const key = seen.join('+');
  if (!key) {
    if (present.has('todo')) return 'todo';
    return '';
  }
  if (key === 'staged+unstaged') return 'partial';
  return key;
};

const lineDelta = ({ hunk, blockId }) => {
  const delta = { added: 0, removed: 0 };
  if (!hunk) return delta;
  const { lines } = hunk;
  if (!lines) return delta;
  const scoped = typeof blockId === 'number';
  for (const { type, blockId: lineBlock } of lines) {
    if (scoped && lineBlock !== blockId) continue;
    if (type === 'add') delta.added += 1;
    else if (type === 'del') delta.removed += 1;
  }
  return delta;
};

const fileEntries = (items) => {
  const groups = new Map();
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const rel = itemPath(item);
    if (!groups.has(rel)) {
      groups.set(rel, {
        path: rel,
        origins: [],
        firstIndex: i,
        remaining: 0,
        added: 0,
        removed: 0,
        staged: 0,
        unstaged: 0,
      });
    }
    const group = groups.get(rel);
    const { origin } = item;
    group.origins.push(origin);
    group.remaining += 1;
    const delta = lineDelta(item);
    group.added += delta.added;
    group.removed += delta.removed;
    if (origin === 'staged') group.staged += 1;
    if (origin === 'unstaged') group.unstaged += 1;
  }
  const entries = [...groups.values()];
  for (const group of entries) {
    group.status = fileStatus(group.origins);
  }
  return entries;
};

module.exports = {
  REVIEW_DIR,
  isPathInScope,
  itemPath,
  fileStatus,
  fileEntries,
};
