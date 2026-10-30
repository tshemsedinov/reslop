'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { withNewline } = require('../common/utilities.js');
const files = require('../common/files.js');
const { listPath, isTaskItem, isTasksEntry, isReadOnlyOrigin } = files;
const { needsReload, npmBusyKind, sameBlock } = require('./items.js');
const { hunkKey } = require('../diff/diff.js');

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
  ignore: {
    match: () => true,
  },
};

const IGNORE_FILES = ['.gitignore', '.npmignore'];

const nextUnstageOrigin = (item) =>
  item.file.isNew === true ? 'untracked' : 'unstaged';

const appendIgnoreFile = (top, name, pattern) => {
  const abs = path.join(top, name);
  const exists = fs.existsSync(abs);
  if (name === '.npmignore' && !exists) return false;
  const text = exists ? fs.readFileSync(abs, 'utf8') : '';
  const lines = text.split('\n');
  if (lines.some((line) => line.trim() === pattern)) return false;
  const base = withNewline(text);
  fs.writeFileSync(abs, `${base}${pattern}\n`);
  return true;
};

const ignorePattern = (rel) => `${rel ?? ''}`.replace(/^\//, '');

const ignorePaths = (ui, paths) => {
  const patterns = paths.map(ignorePattern).filter((pattern) => pattern);
  if (!patterns.length) {
    ui.status = 'not a diff block';
    return;
  }
  const wrotePattern = (pattern) => {
    const writes = IGNORE_FILES.map((name) =>
      appendIgnoreFile(ui.top, name, pattern),
    );
    return writes.includes(true);
  };
  if (!patterns.map(wrotePattern).includes(true)) {
    ui.status = 'already ignored';
    return;
  }
  ui.ignoreWatch();
  ui.nav.clearSelection();
  ui.reloadAfterChange();
  ui.status = 'ignored';
};

const ignoreRelPath = (ui, rel) => ignorePaths(ui, [rel]);

const keepOrigin = (ui, item, origin) => {
  ui.collection.keepOrigin(item, origin);
  const index = ui.collection.findRestoredIndex({ ...item, origin });
  if (index >= 0) ui.nav.index = index;
  ui.ignoreWatch();
  ui.nav.clearSelection();
  ui.syncReviewPath();
  ui.syncFileCursor();
};

const fileActionItems = (ui) => {
  const entry = ui.fileCursorEntry();
  if (!entry || isTasksEntry(entry)) return [];
  return ui.items.filter(
    (item) => !isTaskItem(item) && listPath(item) === entry.path,
  );
};

const activeDiffItem = (ui) => {
  const item = ui.current();
  if (!item) return null;
  if (isTaskItem(item)) {
    ui.status = 'not a diff block';
    return null;
  }
  return item;
};

const guardWritable = (ui, item) => {
  if (!item) return false;
  const caps = ui.capabilities;
  if (!caps.changes || isReadOnlyOrigin(item.origin)) {
    ui.status = 'read only';
    return false;
  }
  return true;
};

const selectNextFileAfter = (ui, rel) => {
  const list = ui.fileList();
  const nav = ui.nav;
  if (!list.length) {
    nav.fileCursor = 0;
    nav.reviewPath = null;
    return;
  }
  const index = list.findIndex((entry) => entry.path === rel);
  let at = index < 0 ? nav.fileCursor : index + 1;
  if (at >= list.length) at = list.length - 1;
  const entry = list[at];
  nav.fileCursor = at;
  nav.reviewPath = entry.path;
  nav.index = entry.firstIndex;
};

const liveItem = (ui, item) => {
  const match = (entry) => sameBlock(entry, item);
  return ui.items.find(match) ?? item;
};

const applyFileGit = async (ui, targets, label, write) => {
  let written = 0;
  try {
    for (const target of targets) {
      const item = liveItem(ui, target);
      await ui.ops.exclusive((top) => write(top, item));
      written++;
    }
    ui.status = label;
    return { ok: true, written };
  } catch (error) {
    ui.status = error.message;
    return { ok: false, written };
  }
};

const enqueueOrigins = (ui, targets, spec) => {
  const writes = targets.map((target) => {
    const item = liveItem(ui, target);
    keepOrigin(ui, item, spec.originOf(item));
    return item;
  });
  if (spec.afterUi) spec.afterUi();
  if (!spec.busy) ui.status = spec.done;
  ui.ops.enqueueLazy({
    kind: spec.busy || spec.done,
    done: spec.done,
    reload: spec.reload === true,
    write: async () => {
      for (const item of writes) await spec.write(item);
    },
  });
};

const stageLazy = (ui, targets, extra = {}) => {
  const busy = extra.busy || '';
  enqueueOrigins(ui, targets, {
    done: 'staged',
    busy,
    reload: extra.reload === true,
    originOf: () => 'staged',
    afterUi: extra.afterUi,
    write: (item) => ui.ops.add(item),
  });
};

const unstageLazy = (ui, targets, extra = {}) => {
  enqueueOrigins(ui, targets, {
    done: 'unstaged',
    busy: '',
    originOf: nextUnstageOrigin,
    afterUi: extra.afterUi,
    write: (item) => ui.ops.unstage(item),
  });
};

const dismissReloadable = (ui, targets) => {
  for (const item of targets) {
    if (needsReload(item)) ui.collection.dismiss(item);
  }
};

const onBlockAdd = (ui, item) => {
  const reload = needsReload(item);
  stageLazy(ui, [item], { busy: npmBusyKind(item), reload });
};

const onBlockUnstage = (ui, item) => unstageLazy(ui, [item]);

const onBlockRevert = (ui, item) => {
  const write = (top) => ui.repo.revert(top, item);
  const after = () => {
    dismissReloadable(ui, [item]);
    ui.reloadAfterChange();
  };
  ui.ops.track(ui.ops.apply('dropped', write, after));
};

const BLOCK = {
  add: onBlockAdd,
  unstage: onBlockUnstage,
  revert: onBlockRevert,
};

const stageTargets = (ui, targets, afterUi = null) => {
  const reload = targets.some(needsReload);
  const busy = targets.map(npmBusyKind).find((kind) => kind) || '';
  stageLazy(ui, targets, { busy, reload, afterUi });
};

const unstageTargets = (ui, targets, afterUi = null) =>
  unstageLazy(ui, targets, { afterUi });

const revertTargets = (ui, targets) => {
  dismissReloadable(ui, targets);
  const write = (top, item) => ui.repo.revert(top, item);
  const run = async () => {
    const result = await applyFileGit(ui, targets, 'dropped', write);
    if (result.ok || result.written) ui.reloadAfterChange();
  };
  ui.ops.track(run());
};

const revertFile = (ui, rel, selected, after) => {
  dismissReloadable(ui, selected);
  const write = (top) => ui.repo.revertFile(top, rel, selected);
  const run = async () => {
    const ok = await ui.ops.apply('dropped', write);
    ui.reloadAfterChange(ok ? after : undefined);
  };
  ui.ops.track(run());
};

const TARGETS = {
  add: stageTargets,
  unstage: unstageTargets,
  revert: revertTargets,
};

const selectedBlocks = (ui) => {
  const rows = ui.items;
  const eligible = (item) =>
    !isTaskItem(item) && !isReadOnlyOrigin(item.origin);
  const indices = ui.nav.listSelection(rows, eligible);
  return indices.map((index) => rows[index]).filter(Boolean);
};

const onBlockGroup = (ui, name) => {
  const selected = selectedBlocks(ui);
  if (!selected.length) {
    ui.status = 'not a diff block';
    return;
  }
  if (!guardWritable(ui, selected[0])) return;
  if (name === 'ignore') {
    const paths = [...new Set(selected.map(listPath))];
    return void ignorePaths(ui, paths);
  }
  const command = COMMANDS[name];
  const matched = selected.filter(command.match);
  const targets = name === 'revert' ? selected : matched;
  if (!targets.length) {
    ui.status = command.skipStatus;
    return;
  }
  ui.nav.clearListPick();
  TARGETS[name](ui, targets);
};

const onBlockCommand = (ui, name) => {
  if (ui.nav.multiselect) return void onBlockGroup(ui, name);
  const command = COMMANDS[name];
  const item = activeDiffItem(ui);
  if (!guardWritable(ui, item)) return;
  if (name === 'ignore') return void ignoreRelPath(ui, listPath(item));
  if (!command.match(item)) {
    ui.status = command.skipStatus;
    return;
  }
  BLOCK[name](ui, item);
};

const selectedFileEntries = (ui) => {
  const listed = ui.fileList();
  const eligible = (entry) => !isTasksEntry(entry);
  const indices = ui.nav.listSelection(listed, eligible);
  return indices.map((index) => listed[index]).filter(Boolean);
};

const hunksForEntries = (ui, entries) => {
  const paths = new Set(entries.map((entry) => entry.path));
  const chosen = (item) => !isTaskItem(item) && paths.has(listPath(item));
  return ui.items.filter(chosen);
};

const onFileGroup = (ui, name) => {
  const entries = selectedFileEntries(ui);
  const hunks = hunksForEntries(ui, entries);
  if (!entries.length || !hunks.length) {
    ui.status = 'not a diff block';
    return;
  }
  if (!guardWritable(ui, hunks[0])) return;
  const last = entries.at(-1).path;
  const next = () => {
    ui.nav.clearListPick();
    selectNextFileAfter(ui, last);
  };
  if (name === 'ignore') {
    return void ignorePaths(
      ui,
      entries.map((entry) => entry.path),
    );
  }
  if (name === 'revert') {
    next();
    return void revertTargets(ui, hunks);
  }
  const command = COMMANDS[name];
  const targets = hunks.filter(command.match);
  if (!targets.length) {
    ui.status = command.skipStatus;
    return;
  }
  TARGETS[name](ui, targets, next);
};

const onFileCommand = (ui, name) => {
  if (ui.nav.multiselect) return void onFileGroup(ui, name);
  const selected = fileActionItems(ui);
  if (!selected.length) {
    ui.status = 'not a diff block';
    return;
  }
  if (!guardWritable(ui, selected[0])) return;
  const rel = listPath(selected[0]);
  const next = () => selectNextFileAfter(ui, rel);
  if (name === 'ignore') return void ignoreRelPath(ui, rel);
  if (name === 'revert') return void revertFile(ui, rel, selected, next);
  const command = COMMANDS[name];
  const targets = selected.filter(command.match);
  if (!targets.length) {
    ui.status = command.skipStatus;
    return void next();
  }
  TARGETS[name](ui, targets, next);
};

const hunkActionItems = (ui, item) => {
  const key = hunkKey(item);
  return key ? ui.items.filter((entry) => hunkKey(entry) === key) : [];
};

const onUnitCommand = (ui, name) => {
  const command = COMMANDS[name];
  const item = activeDiffItem(ui);
  if (!guardWritable(ui, item)) return;
  const selected = hunkActionItems(ui, item);
  const targets = name === 'revert' ? selected : selected.filter(command.match);
  if (!targets.length) {
    ui.status = command.skipStatus ?? 'not a diff block';
    return;
  }
  TARGETS[name](ui, targets);
};

const onCommand = (ui, name) => {
  if (ui.nav.pane === 'files') return void onFileCommand(ui, name);
  if (ui.nav.pane === 'unit') return void onUnitCommand(ui, name);
  onBlockCommand(ui, name);
};

module.exports = { onCommand };
