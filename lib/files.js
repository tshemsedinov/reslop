'use strict';

const ORIGIN_ORDER = ['staged', 'unstaged', 'untracked', 'commit'];

const itemPath = (item) => {
  if (!item || !item.file) return '';
  return item.file.newPath || item.file.oldPath || '';
};

const fileStatus = (origins) => {
  const seen = [];
  for (const origin of ORIGIN_ORDER) {
    if (origins.includes(origin)) seen.push(origin);
  }
  const key = seen.join('+');
  if (key === 'staged+unstaged') {
    return 'partial';
  }
  return key;
};

const fileEntries = (items, remaining) => {
  const order = [];
  const groups = new Map();
  for (let i = 0; i < items.length; i++) {
    if (!remaining.has(i)) continue;
    const item = items[i];
    const rel = itemPath(item);
    if (!groups.has(rel)) {
      const group = {
        path: rel,
        origins: [],
        firstIndex: i,
        remaining: 0,
      };
      groups.set(rel, group);
      order.push(rel);
    }
    const group = groups.get(rel);
    group.origins.push(item.origin);
    group.remaining += 1;
  }
  return order.map((rel) => {
    const group = groups.get(rel);
    return {
      path: group.path,
      status: fileStatus(group.origins),
      firstIndex: group.firstIndex,
      remaining: group.remaining,
    };
  });
};

module.exports = { ORIGIN_ORDER, itemPath, fileStatus, fileEntries };
