'use strict';

const ORIGIN_ORDER = ['staged', 'unstaged', 'untracked', 'commit'];

const itemPath = (item) => {
  if (!item || !item.file) return '';
  return item.file.newPath || item.file.oldPath || '';
};

const fileStatus = (origins) => {
  const present = new Set(origins);
  const seen = ORIGIN_ORDER.filter((origin) => present.has(origin));
  const key = seen.join('+');
  if (key === 'staged+unstaged') return 'partial';
  return key;
};

const fileEntries = (items, remaining) => {
  const groups = new Map();
  for (let i = 0; i < items.length; i++) {
    if (!remaining.has(i)) continue;
    const item = items[i];
    const rel = itemPath(item);
    let group = groups.get(rel);
    if (!group) {
      group = {
        path: rel,
        origins: [],
        firstIndex: i,
        remaining: 0,
      };
      groups.set(rel, group);
    }
    group.origins.push(item.origin);
    group.remaining += 1;
  }
  const entries = [];
  for (const group of groups.values()) {
    entries.push({
      path: group.path,
      status: fileStatus(group.origins),
      firstIndex: group.firstIndex,
      remaining: group.remaining,
    });
  }
  return entries;
};

module.exports = { ORIGIN_ORDER, itemPath, fileStatus, fileEntries };
