'use strict';

const files = require('../files.js');
const { itemPath, isTodoItem, isTodosEntry } = files;
const items = require('./items.js');
const { needsReload, npmBusyKind, sameBlock } = items;
const { isReadOnlyOrigin } = require('./origins.js');

const nextUnstageOrigin = (item) => {
  if (item.file.isNew === true) return 'untracked';
  return 'unstaged';
};

const COMMANDS = {
  add: {
    skipStatus: 'already staged',
    match: (item) => item.origin !== 'staged',
  },
  unstage: {
    skipStatus: 'not staged',
    match: (item) => item.origin === 'staged',
  },
  revert: {
    match: () => true,
  },
};

const keepOrigin = (options, item, origin) => {
  options.collection.keepOrigin(item, origin);
  options.nav.clearSelection();
  options.syncReviewPath();
  options.syncFileCursor();
};

const fileCursorEntry = (options) => {
  const list = options.fileList();
  return list[options.nav.fileCursor] ?? null;
};

const fileActionItems = (options) => {
  const entry = fileCursorEntry(options);
  if (!entry || isTodosEntry(entry)) return [];
  const rel = entry.path;
  const selected = [];
  for (const item of options.getItems()) {
    if (isTodoItem(item)) continue;
    if (itemPath(item) !== rel) continue;
    selected.push(item);
  }
  return selected;
};

const activeDiffItem = (options) => {
  const item = options.currentItem();
  if (!item) return null;
  if (isTodoItem(item)) {
    options.setStatus('not a diff block');
    return null;
  }
  return item;
};

const guardWritable = (options, item) => {
  if (!item) return false;
  const caps = options.capabilities();
  if (!caps.changes || isReadOnlyOrigin(item.origin)) {
    options.setStatus('read only');
    return false;
  }
  return true;
};

const selectNextFileAfter = (options, rel) => {
  const list = options.fileList();
  const nav = options.nav;
  if (!list.length) {
    nav.fileCursor = 0;
    nav.reviewPath = null;
    return;
  }
  const idx = list.findIndex((entry) => entry.path === rel);
  let at = idx < 0 ? nav.fileCursor : idx + 1;
  if (at >= list.length) at = list.length - 1;
  const entry = list[at];
  nav.fileCursor = at;
  nav.reviewPath = entry.path;
  nav.index = entry.firstIndex;
};

const liveItem = (options, item) => {
  for (const entry of options.getItems()) {
    if (sameBlock(entry, item)) return entry;
  }
  return item;
};

const applyGit = (options, item, label, write, after) => {
  try {
    write(options.top(), item);
    options.setStatus(label);
    after();
  } catch (error) {
    options.setStatus(error.message);
  }
};

const applyFileGit = (options, targets, label, write, afterItem) => {
  const completed = [];
  try {
    for (const item of targets) {
      const current = liveItem(options, item);
      write(options.top(), current);
      afterItem(current);
      completed.push(current);
    }
    options.setStatus(label);
    return { ok: true, completed };
  } catch (error) {
    options.setStatus(error.message);
    return { ok: false, completed };
  }
};

const reconcilePartial = (options, result) => {
  if (result.ok) return false;
  if (result.completed.length) options.reloadAfterChange();
  return true;
};

const applyBlockAdd = (options, item) => {
  if (needsReload(item)) {
    options.reloadAfterChange();
    return;
  }
  keepOrigin(options, item, 'staged');
};

const onBlockAdd = (options, item) => {
  const busy = npmBusyKind(item);
  const repo = options.repo();
  if (options.uiOpen() && busy && repo.addAsync) {
    const after = () => applyBlockAdd(options, item);
    const write = (top) => repo.addAsync(top, item);
    options.runBusy(busy, 'staged', write, after);
    return;
  }
  applyGit(
    options,
    item,
    'staged',
    (top, current) => repo.add(top, current),
    () => {
      applyBlockAdd(options, item);
    },
  );
};

const onBlockUnstage = (options, item) => {
  const origin = nextUnstageOrigin(item);
  const repo = options.repo();
  applyGit(
    options,
    item,
    'unstaged',
    (top, current) => repo.unstage(top, current),
    () => keepOrigin(options, item, origin),
  );
};

const onBlockRevert = (options, item) => {
  const repo = options.repo();
  applyGit(
    options,
    item,
    'dropped',
    (top, current) => repo.revert(top, current),
    () => {
      if (needsReload(item)) options.collection.dismiss(item);
      options.reloadAfterChange();
    },
  );
};

const BLOCK = {
  add: onBlockAdd,
  unstage: onBlockUnstage,
  revert: onBlockRevert,
};

const onBlockCommand = (options, name) => {
  const command = COMMANDS[name];
  const item = activeDiffItem(options);
  if (!guardWritable(options, item)) return;
  if (!command.match(item)) {
    options.setStatus(command.skipStatus);
    return;
  }
  BLOCK[name](options, item);
};

const writeFileAddAsync = (options, targets) => async (top) => {
  const repo = options.repo();
  for (const item of targets) {
    const current = liveItem(options, item);
    await repo.addAsync(top, current);
    keepOrigin(options, current, 'staged');
  }
};

const afterFileAdd = (options, rel, proposed) => () => {
  if (proposed) {
    options.reloadAfterChange(() => selectNextFileAfter(options, rel));
    return;
  }
  selectNextFileAfter(options, rel);
};

const onFileAdd = (options) => {
  const selected = fileActionItems(options);
  if (!selected.length) {
    options.setStatus('not a diff block');
    return;
  }
  if (!guardWritable(options, selected[0])) return;
  const rel = itemPath(selected[0]);
  const targets = selected.filter(COMMANDS.add.match);
  if (!targets.length) {
    options.setStatus('already staged');
    selectNextFileAfter(options, rel);
    return;
  }
  const proposed = targets.some(needsReload);
  const busy = targets.map(npmBusyKind).find((kind) => kind);
  const repo = options.repo();
  if (options.uiOpen() && busy && repo.addAsync) {
    const write = writeFileAddAsync(options, targets);
    const after = afterFileAdd(options, rel, proposed);
    options.runBusy(busy, 'staged', write, after);
    return;
  }
  const result = applyFileGit(
    options,
    targets,
    'staged',
    (top, current) => repo.add(top, current),
    (item) => keepOrigin(options, item, 'staged'),
  );
  if (reconcilePartial(options, result)) return;
  if (proposed) options.reloadAfterChange();
  selectNextFileAfter(options, rel);
};

const onFileUnstage = (options) => {
  const selected = fileActionItems(options);
  if (!selected.length) {
    options.setStatus('not a diff block');
    return;
  }
  if (!guardWritable(options, selected[0])) return;
  const rel = itemPath(selected[0]);
  const targets = selected.filter(COMMANDS.unstage.match);
  if (!targets.length) {
    options.setStatus('not staged');
    selectNextFileAfter(options, rel);
    return;
  }
  const repo = options.repo();
  const result = applyFileGit(
    options,
    targets,
    'unstaged',
    (top, current) => repo.unstage(top, current),
    (item) => keepOrigin(options, item, nextUnstageOrigin(item)),
  );
  if (reconcilePartial(options, result)) return;
  selectNextFileAfter(options, rel);
};

const onFileRevert = (options) => {
  const selected = fileActionItems(options);
  if (!selected.length) {
    options.setStatus('not a diff block');
    return;
  }
  if (!guardWritable(options, selected[0])) return;
  const rel = itemPath(selected[0]);
  for (const item of selected) {
    if (needsReload(item)) options.collection.dismiss(item);
  }
  let ok = false;
  try {
    options.repo().revertFile(options.top(), rel, selected);
    options.setStatus('dropped');
    ok = true;
  } catch (error) {
    options.setStatus(error.message);
  }
  const after = ok ? () => selectNextFileAfter(options, rel) : null;
  options.reloadAfterChange(after);
};

const FILE = {
  add: onFileAdd,
  unstage: onFileUnstage,
  revert: onFileRevert,
};

const onCommand = (options, name) => {
  if (options.nav.pane === 'files') return void FILE[name](options);
  onBlockCommand(options, name);
};

const createChangeActions = (options) => ({
  fileCursorEntry: () => fileCursorEntry(options),
  onAdd: () => onCommand(options, 'add'),
  onUnstage: () => onCommand(options, 'unstage'),
  onRevert: () => onCommand(options, 'revert'),
});

module.exports = { createChangeActions };
