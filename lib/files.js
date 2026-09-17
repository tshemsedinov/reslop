'use strict';

const REVIEW_DIR = '.review';
const ORIGIN_ORDER = ['staged', 'unstaged', 'untracked', 'commit', 'pr'];
const TODO_FILE = 'TODOs';
const REPO_TODOS_LABEL = 'Repository TODOs and Issues';
const TOTAL_LABEL = 'total';

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

const isTodoItem = (item) => !!(item && item.origin === 'todo');

const isTodosEntry = (entry) => !!(entry && entry.kind === 'todos');

const isTotalEntry = (entry) => !!(entry && entry.kind === 'total');

const repoTodosLabel = () => REPO_TODOS_LABEL;

const makeTodoItem = () => ({
  origin: 'todo',
  file: {
    oldPath: TODO_FILE,
    newPath: TODO_FILE,
    isNew: false,
    isDeleted: false,
    isBinary: false,
    preamble: [],
    hunks: [],
  },
  hunk: null,
  blockId: 'todo',
  patchAdd: '',
  patchRevert: '',
});

const fileStatus = (origins) => {
  const present = new Set(origins);
  const seen = ORIGIN_ORDER.filter((origin) => present.has(origin));
  const key = seen.join('+');
  if (!key) return '';
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

const addLineDelta = (group, origin, delta) => {
  group.added += delta.added;
  group.removed += delta.removed;
  if (origin === 'staged') {
    group.stagedAdded += delta.added;
    group.stagedRemoved += delta.removed;
    return;
  }
  group.unstagedAdded += delta.added;
  group.unstagedRemoved += delta.removed;
};

const originLineDelta = (entry) => {
  if (entry.stagedAdded !== undefined || entry.unstagedAdded !== undefined) {
    return {
      stagedAdded: entry.stagedAdded ?? 0,
      stagedRemoved: entry.stagedRemoved ?? 0,
      unstagedAdded: entry.unstagedAdded ?? 0,
      unstagedRemoved: entry.unstagedRemoved ?? 0,
    };
  }
  const added = entry.added ?? 0;
  const removed = entry.removed ?? 0;
  if ((entry.status ?? '') === 'staged') {
    return {
      stagedAdded: added,
      stagedRemoved: removed,
      unstagedAdded: 0,
      unstagedRemoved: 0,
    };
  }
  return {
    stagedAdded: 0,
    stagedRemoved: 0,
    unstagedAdded: added,
    unstagedRemoved: removed,
  };
};

const fileEntries = (items) => {
  const groups = new Map();
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (isTodoItem(item)) continue;
    const rel = itemPath(item);
    if (!groups.has(rel)) {
      groups.set(rel, {
        path: rel,
        origins: [],
        firstIndex: i,
        openIndex: i,
        remaining: 0,
        added: 0,
        removed: 0,
        stagedAdded: 0,
        stagedRemoved: 0,
        unstagedAdded: 0,
        unstagedRemoved: 0,
        staged: 0,
        unstaged: 0,
      });
    }
    const group = groups.get(rel);
    const { origin } = item;
    group.origins.push(origin);
    group.remaining += 1;
    addLineDelta(group, origin, lineDelta(item));
    if (origin === 'staged') group.staged += 1;
    if (origin === 'unstaged') {
      if (group.unstaged === 0) group.openIndex = i;
      group.unstaged += 1;
    }
  }
  const entries = [...groups.values()];
  for (const group of entries) {
    group.status = fileStatus(group.origins);
  }
  return entries;
};

const fileTotals = (files) => {
  const total = {
    path: TOTAL_LABEL,
    kind: 'total',
    status: '',
    remaining: 0,
    added: 0,
    removed: 0,
    stagedAdded: 0,
    stagedRemoved: 0,
    unstagedAdded: 0,
    unstagedRemoved: 0,
    staged: 0,
    unstaged: 0,
  };
  for (const entry of files) {
    if (isTodosEntry(entry) || isTotalEntry(entry)) continue;
    const remaining = entry.remaining ?? 0;
    const staged = entry.staged ?? 0;
    const added = entry.added ?? 0;
    const removed = entry.removed ?? 0;
    const lines = originLineDelta(entry);
    const listed = entry.unstaged ?? Math.max(0, remaining - staged);
    const untracked = (entry.status ?? '') === 'untracked';
    const unstaged = untracked && listed === 0 ? remaining : listed;
    total.remaining += remaining;
    total.added += added;
    total.removed += removed;
    total.stagedAdded += lines.stagedAdded;
    total.stagedRemoved += lines.stagedRemoved;
    total.unstagedAdded += lines.unstagedAdded;
    total.unstagedRemoved += lines.unstagedRemoved;
    total.staged += staged;
    total.unstaged += unstaged;
  }
  return total;
};

module.exports = {
  REVIEW_DIR,
  TODO_FILE,
  REPO_TODOS_LABEL,
  TOTAL_LABEL,
  isPathInScope,
  itemPath,
  isTodoItem,
  isTodosEntry,
  isTotalEntry,
  repoTodosLabel,
  makeTodoItem,
  fileStatus,
  fileEntries,
  fileTotals,
};
