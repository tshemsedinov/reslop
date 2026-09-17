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

const setStatus = (api, value) => api.options.setStatus(value);

const keepOrigin = (api, item, origin) => {
  api.options.collection.keepOrigin(item, origin);
  api.options.nav.clearSelection();
  api.options.syncReviewPath();
  api.options.syncFileCursor();
};

const fileCursorEntry = (api) => {
  const list = api.options.fileList();
  return list[api.options.nav.fileCursor] ?? null;
};

const fileActionItems = (api) => {
  const entry = fileCursorEntry(api);
  if (!entry || isTodosEntry(entry)) return [];
  const rel = entry.path;
  const selected = [];
  for (const item of api.options.getItems()) {
    if (isTodoItem(item)) continue;
    if (itemPath(item) !== rel) continue;
    selected.push(item);
  }
  return selected;
};

const activeDiffItem = (api) => {
  const item = api.options.currentItem();
  if (!item) return null;
  if (isTodoItem(item)) {
    setStatus(api, 'not a diff block');
    return null;
  }
  return item;
};

const guardWritable = (api, item) => {
  if (!item) return false;
  const caps = api.options.capabilities();
  if (!caps.changes || isReadOnlyOrigin(item.origin)) {
    setStatus(api, 'read only');
    return false;
  }
  return true;
};

const selectNextFileAfter = (api, rel) => {
  const list = api.options.fileList();
  const nav = api.options.nav;
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

const liveItem = (api, item) => {
  for (const entry of api.options.getItems()) {
    if (sameBlock(entry, item)) return entry;
  }
  return item;
};

const applyGit = (api, item, label, write, after) => {
  try {
    write(api.options.top(), item);
    setStatus(api, label);
    after();
  } catch (error) {
    setStatus(api, error.message);
  }
};

const applyFileGit = (api, targets, label, write, afterItem) => {
  const completed = [];
  try {
    for (const item of targets) {
      const current = liveItem(api, item);
      write(api.options.top(), current);
      afterItem(current);
      completed.push(current);
    }
    setStatus(api, label);
    return { ok: true, completed };
  } catch (error) {
    setStatus(api, error.message);
    return { ok: false, completed };
  }
};

const reconcilePartial = (api, result) => {
  if (result.ok) return false;
  if (result.completed.length) api.options.reloadAfterChange();
  return true;
};

const applyBlockAdd = (api, item) => {
  if (needsReload(item)) {
    api.options.reloadAfterChange();
    return;
  }
  keepOrigin(api, item, 'staged');
};

const runBusyAdd = (api, kind, write, after) => {
  const run = api.options.runBusy;
  return void run(kind, 'staged', write, after);
};

const onBlockAdd = (api, item) => {
  const busy = npmBusyKind(item);
  const repo = api.options.repo();
  if (api.options.uiOpen() && busy && repo.addAsync) {
    const after = () => applyBlockAdd(api, item);
    const write = (top) => repo.addAsync(top, item);
    runBusyAdd(api, busy, write, after);
    return;
  }
  applyGit(
    api,
    item,
    'staged',
    (top, current) => repo.add(top, current),
    () => {
      applyBlockAdd(api, item);
    },
  );
};

const onBlockUnstage = (api, item) => {
  const origin = nextUnstageOrigin(item);
  const repo = api.options.repo();
  applyGit(
    api,
    item,
    'unstaged',
    (top, current) => repo.unstage(top, current),
    () => keepOrigin(api, item, origin),
  );
};

const onBlockRevert = (api, item) => {
  const repo = api.options.repo();
  applyGit(
    api,
    item,
    'dropped',
    (top, current) => repo.revert(top, current),
    () => {
      if (needsReload(item)) api.options.collection.dismiss(item);
      api.options.reloadAfterChange();
    },
  );
};

const BLOCK = {
  add: onBlockAdd,
  unstage: onBlockUnstage,
  revert: onBlockRevert,
};

const onBlockCommand = (api, name) => {
  const command = COMMANDS[name];
  const item = activeDiffItem(api);
  if (!guardWritable(api, item)) return;
  if (!command.match(item)) {
    setStatus(api, command.skipStatus);
    return;
  }
  BLOCK[name](api, item);
};

const writeFileAddAsync = (api, targets) => async (top) => {
  const repo = api.options.repo();
  for (const item of targets) {
    const current = liveItem(api, item);
    await repo.addAsync(top, current);
    keepOrigin(api, current, 'staged');
  }
};

const afterFileAdd = (api, rel, proposed) => () => {
  if (proposed) {
    api.options.reloadAfterChange(() => selectNextFileAfter(api, rel));
    return;
  }
  selectNextFileAfter(api, rel);
};

const onFileAdd = (api) => {
  const selected = fileActionItems(api);
  if (!selected.length) {
    setStatus(api, 'not a diff block');
    return;
  }
  if (!guardWritable(api, selected[0])) return;
  const rel = itemPath(selected[0]);
  const targets = selected.filter(COMMANDS.add.match);
  if (!targets.length) {
    setStatus(api, 'already staged');
    selectNextFileAfter(api, rel);
    return;
  }
  const proposed = targets.some((item) => needsReload(item));
  const busy = targets.map(npmBusyKind).find((kind) => kind);
  const repo = api.options.repo();
  if (api.options.uiOpen() && busy && repo.addAsync) {
    const write = writeFileAddAsync(api, targets);
    const after = afterFileAdd(api, rel, proposed);
    runBusyAdd(api, busy, write, after);
    return;
  }
  const result = applyFileGit(
    api,
    targets,
    'staged',
    (top, current) => repo.add(top, current),
    (item) => keepOrigin(api, item, 'staged'),
  );
  if (reconcilePartial(api, result)) return;
  if (proposed) api.options.reloadAfterChange();
  selectNextFileAfter(api, rel);
};

const onFileUnstage = (api) => {
  const selected = fileActionItems(api);
  if (!selected.length) {
    setStatus(api, 'not a diff block');
    return;
  }
  if (!guardWritable(api, selected[0])) return;
  const rel = itemPath(selected[0]);
  const targets = selected.filter(COMMANDS.unstage.match);
  if (!targets.length) {
    setStatus(api, 'not staged');
    selectNextFileAfter(api, rel);
    return;
  }
  const repo = api.options.repo();
  const result = applyFileGit(
    api,
    targets,
    'unstaged',
    (top, current) => repo.unstage(top, current),
    (item) => keepOrigin(api, item, nextUnstageOrigin(item)),
  );
  if (reconcilePartial(api, result)) return;
  selectNextFileAfter(api, rel);
};

const onFileRevert = (api) => {
  const selected = fileActionItems(api);
  if (!selected.length) {
    setStatus(api, 'not a diff block');
    return;
  }
  if (!guardWritable(api, selected[0])) return;
  const rel = itemPath(selected[0]);
  for (const item of selected) {
    if (needsReload(item)) api.options.collection.dismiss(item);
  }
  let ok = false;
  try {
    api.options.repo().revertFile(api.options.top(), rel, selected);
    setStatus(api, 'dropped');
    ok = true;
  } catch (error) {
    setStatus(api, error.message);
  }
  const after = ok ? () => selectNextFileAfter(api, rel) : null;
  api.options.reloadAfterChange(after);
};

const FILE = {
  add: onFileAdd,
  unstage: onFileUnstage,
  revert: onFileRevert,
};

const onCommand = (api, name) => {
  if (api.options.nav.pane === 'files') return void FILE[name](api);
  onBlockCommand(api, name);
};

const createChangeActions = (options) => {
  const api = { options };
  return {
    fileCursorEntry: () => fileCursorEntry(api),
    onAdd: () => onCommand(api, 'add'),
    onUnstage: () => onCommand(api, 'unstage'),
    onRevert: () => onCommand(api, 'revert'),
  };
};

module.exports = { createChangeActions };
