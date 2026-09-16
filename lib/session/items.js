'use strict';

const files = require('../files.js');
const { itemPath, TODO_FILE, isTodoItem } = files;
const { feedbackKey } = require('../review.js');
const { refreshIndexPatches } = require('../diff.js');

const depChangeKey = (item) => {
  const change = item.dep && item.dep.change;
  if (!change) return '';
  return `${change.section}/${change.name}`;
};

const needsReload = (item) => item.reload === true;

const npmBusyKind = (item) => {
  const change = item && item.dep && item.dep.change;
  if (!change || !change.propose) return '';
  if (change.unused) return 'npm uninstall';
  if (change.section === 'resolved') return 'npm audit fix';
  return 'npm i';
};

const itemKey = (item) => {
  if (!item || !item.file) return '';
  const rel = itemPath(item);
  if (isTodoItem(item)) return `todo:${TODO_FILE}`;
  const origin = item.origin ?? '';
  const depId = depChangeKey(item);
  if (depId) return `${origin}:${rel}:dep:${depId}`;
  if (!item.hunk) {
    const block = item.blockId ?? '-';
    return `${origin}:${rel}:file:${block}`;
  }
  const oldStart = item.hunk.oldStart;
  const newStart = item.hunk.newStart;
  const block = item.blockId ?? '-';
  return `${origin}:${rel}:${oldStart}:${newStart}:${block}`;
};

const itemFeedKey = (item) => {
  if (!item || !item.file || isTodoItem(item)) return '';
  const hunk = item.hunk;
  const depId = depChangeKey(item);
  const file = depId ? `${itemPath(item)}#${depId}` : itemPath(item);
  const oldStart = hunk ? hunk.oldStart : 0;
  const newStart = hunk ? hunk.newStart : 0;
  const blockId = item.blockId ?? 0;
  return feedbackKey({ file, oldStart, newStart, blockId });
};

const sameBlock = (left, right) => {
  if (left === right) return true;
  if (left.file !== right.file) return false;
  if (left.hunk !== right.hunk) return false;
  return left.blockId === right.blockId;
};

const canEditCode = (item) => {
  if (!item || isTodoItem(item)) return false;
  if (!item.hunk || !item.file) return false;
  if (item.file.isBinary) return false;
  return true;
};

const createItemCollection = () => {
  const state = {
    items: [],
    dismissed: new Set(),
  };

  const reset = () => {
    state.items = [];
    state.dismissed = new Set();
  };

  const isDismissed = (item) => state.dismissed.has(itemKey(item));

  const replace = (items) => {
    const next = [];
    for (const item of items) {
      if (isDismissed(item)) continue;
      next.push(item);
    }
    state.items = next;
    return next;
  };

  const dismiss = (item) => {
    state.dismissed.add(itemKey(item));
  };

  const clearDismissed = () => {
    state.dismissed.clear();
  };

  const findIndexByKey = (key) => {
    if (!key) return -1;
    return state.items.findIndex((item) => itemKey(item) === key);
  };

  const keepOrigin = (item, origin) => {
    const next = { ...item, origin };
    const replaced = [];
    for (const entry of state.items) {
      replaced.push(sameBlock(entry, item) ? next : entry);
    }
    if (next.dep) {
      state.items = replaced;
      return;
    }
    state.items = refreshIndexPatches(replaced, next);
  };

  return {
    get items() {
      return state.items;
    },
    set items(value) {
      state.items = value;
    },
    get dismissed() {
      return state.dismissed;
    },
    reset,
    replace,
    dismiss,
    clearDismissed,
    isDismissed,
    findIndexByKey,
    keepOrigin,
  };
};

module.exports = {
  depChangeKey,
  needsReload,
  npmBusyKind,
  itemKey,
  itemFeedKey,
  sameBlock,
  canEditCode,
  createItemCollection,
};
