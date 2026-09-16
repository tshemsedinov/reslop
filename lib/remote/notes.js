'use strict';

const { isCtxType } = require('../diff.js');
const { itemPath } = require('../files.js');

const sideLineNumber = (type, oldNo, newNo, side) => {
  if (side === 'LEFT') {
    if (type === 'add') return 0;
    return oldNo;
  }
  if (type === 'del') return 0;
  return newNo;
};

const locateLineInItem = (item, rel, line, side) => {
  const path = itemPath(item);
  if (path !== rel) return null;
  const hunk = item.hunk;
  if (!hunk || !line) return null;
  let oldNo = hunk.oldStart;
  let newNo = hunk.newStart;
  for (const entry of hunk.lines) {
    const at = sideLineNumber(entry.type, oldNo, newNo, side);
    if (at === line) {
      const inBlock = entry.blockId === item.blockId;
      return { inBlock };
    }
    if (isCtxType(entry.type) || entry.type === 'del') {
      oldNo += 1;
    }
    if (isCtxType(entry.type) || entry.type === 'add') {
      newNo += 1;
    }
  }
  return null;
};

const findItemForLine = (items, rel, line, side) => {
  let fallback = null;
  for (const item of items) {
    const hit = locateLineInItem(item, rel, line, side);
    if (!hit) continue;
    if (hit.inBlock) return item;
    if (!fallback) fallback = item;
  }
  return fallback;
};

const importedText = (entry, host) => {
  const reviewer = entry.reviewer || 'unknown';
  const body = `${entry.body ?? ''}`.trim();
  return `@${reviewer} review at ${host}: ${body}`;
};

const importedTodo = (file, entry, host) => ({
  kind: 'todo',
  file,
  text: importedText(entry, host),
  done: entry.resolved === true,
});

const importedFeedback = (item, path, entry, host) => {
  const hunk = item.hunk;
  return {
    kind: 'feedback',
    file: itemPath(item) || path,
    oldStart: hunk ? hunk.oldStart : 0,
    newStart: hunk ? hunk.newStart : 0,
    blockId: item.blockId ?? 0,
    origin: item.origin ?? 'pr',
    header: hunk ? hunk.header : '',
    text: importedText(entry, host),
    done: entry.resolved === true,
  };
};

const noteFromLocation = (items, loc, entry, host, fallbackFile) => {
  const path = loc.path || '';
  const line = loc.line;
  const side = loc.side;
  if (line && path) {
    const item = findItemForLine(items, path, line, side);
    if (item) return importedFeedback(item, path, entry, host);
  }
  if (path) return importedTodo(path, entry, host);
  return importedTodo(fallbackFile, entry, host);
};

module.exports = {
  findItemForLine,
  importedText,
  importedTodo,
  noteFromLocation,
};
