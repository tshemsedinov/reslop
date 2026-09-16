'use strict';

const { itemPath, isPathInScope } = require('../files.js');

const changePath = (file) => file.newPath || file.oldPath || '';

const filterChangeFiles = (files, paths) => {
  if (!paths.length) return files;
  const kept = [];
  for (const file of files) {
    if (isPathInScope(changePath(file), paths)) kept.push(file);
  }
  return kept;
};

const pushChangeFile = (files, seen, rel) => {
  if (!rel || seen.has(rel)) return;
  seen.add(rel);
  files.push(rel);
};

const changeFiles = (items) => {
  const files = [];
  const seen = new Set();
  for (const item of items) {
    if (item.dep) {
      const depFiles = item.dep.files ?? [];
      for (const rel of depFiles) pushChangeFile(files, seen, rel);
      continue;
    }
    const rel = itemPath(item);
    pushChangeFile(files, seen, rel);
  }
  return files;
};

module.exports = { changePath, filterChangeFiles, changeFiles };
