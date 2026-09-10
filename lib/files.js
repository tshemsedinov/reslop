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

const fileEntries = (items) => {
  const groups = new Map();
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const rel = itemPath(item);
    let group = groups.get(rel);
    if (!group) {
      group = { path: rel, origins: [], firstIndex: i, remaining: 0 };
      groups.set(rel, group);
    }
    group.origins.push(item.origin);
    group.remaining += 1;
  }
  const entries = [];
  for (const group of groups.values()) {
    const path = group.path;
    const status = fileStatus(group.origins);
    const firstIndex = group.firstIndex;
    const remaining = group.remaining;
    entries.push({ path, status, firstIndex, remaining });
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
