'use strict';

const files = require('../common/files.js');
const { listPath, isTaskItem, isTasksEntry, TASKS_FILE } = files;
const { LIST_PANES } = require('../input/actions.js');

const freshListScroll = () =>
  Object.fromEntries(LIST_PANES.map((pane) => [pane, 0]));

const RANGE_CURSORS = {
  commits: 'commitCursor',
  branches: 'branchCursor',
  packages: 'packagesCursor',
  files: 'fileCursor',
  diff: 'index',
};

const SPLIT_PANES = ['npm', 'agents'];

const cursorKey = (nav) => {
  if (nav.pane === 'npm') {
    return nav.listSide === 'runs' ? 'npmRunCursor' : 'npmCursor';
  }
  if (nav.pane === 'agents') {
    return nav.listSide === 'runs' ? 'agentRunCursor' : '';
  }
  return RANGE_CURSORS[nav.pane] ?? '';
};

const anchorAt = (nav, index) => ({
  pane: nav.pane,
  side: SPLIT_PANES.includes(nav.pane) ? nav.listSide : '',
  index,
});

const spanIndices = (from, to) => {
  const start = Math.min(from, to);
  const length = Math.abs(from - to) + 1;
  return Array.from({ length }, (_, offset) => start + offset);
};

const toggleMember = (indices, index) => {
  if (indices.includes(index)) return indices.filter((at) => at !== index);
  const next = [...indices, index];
  next.sort((left, right) => left - right);
  return next;
};

const unionMembers = (indices, extra) => {
  const next = [...indices];
  for (const index of extra) {
    if (!next.includes(index)) next.push(index);
  }
  next.sort((left, right) => left - right);
  return next;
};

class Navigation {
  constructor(options = {}) {
    this.reset(options.startPane ?? 'files');
  }

  reset(startPane = this.pane) {
    this.pane = startPane;
    this.index = 0;
    this.fileCursor = 0;
    this.folder = '.';
    this.folderFocus = false;
    this.folderScroll = 0;
    this.branchCursor = 0;
    this.treeFocus = false;
    this.commitCursor = 0;
    this.npmCursor = 0;
    this.npmRunCursor = 0;
    this.packagesCursor = 0;
    this.agentCursor = 0;
    this.agentRunCursor = 0;
    this.listSide = '';
    this.scroll = 0;
    this.listScrollByPane = freshListScroll();
    this.listAnchor = null;
    this.listPicked = null;
    this.listDrag = null;
    this.reviewPath = null;
    this.fileScope = 'diff';
    this.unitLine = 0;
    this.selection = null;
    this.mouseAnchor = null;
    this.editDrag = null;
    this.editClick = null;
    this.pendingClick = null;
    this.scrollDrag = null;
    this.lastClick = null;
    this.contextMenu = null;
    this.tasksOpen = false;
    this.tasksFocus = 0;
    this.find = null;
    this.import = null;
  }

  clampIndex(length) {
    if (!length) {
      this.index = 0;
      return;
    }
    if (this.index < 0) this.index = 0;
    if (this.index >= length) this.index = length - 1;
  }

  current(items, tasksItem) {
    if (this.tasksOpen) return tasksItem;
    if (this.pane === 'unit' && this.reviewPath) {
      const item = items[this.index];
      if (item && listPath(item) === this.reviewPath) return item;
      for (const entry of items) {
        if (listPath(entry) === this.reviewPath) return entry;
      }
      return null;
    }
    return items[this.index] ?? null;
  }

  syncReviewPath(item) {
    if (this.pane !== 'diff' && this.pane !== 'unit') return;
    if (this.pane === 'unit' && this.reviewPath) return;
    this.reviewPath = item ? listPath(item) : null;
  }

  clampFileCursor(length) {
    if (!length) {
      this.fileCursor = 0;
      return;
    }
    if (this.fileCursor >= length) this.fileCursor = length - 1;
  }

  followReviewPath(fileList, item) {
    if (!fileList.length) {
      this.fileCursor = 0;
      return;
    }
    let idx = fileList.findIndex(
      (entry) => !isTasksEntry(entry) && entry.path === this.reviewPath,
    );
    if (this.reviewPath === TASKS_FILE || isTaskItem(item)) {
      idx = fileList.findIndex((entry) => isTasksEntry(entry));
    }
    if (idx >= 0) {
      this.fileCursor = idx;
      return;
    }
    this.clampFileCursor(fileList.length);
  }

  restoreFileCursor(fileList) {
    if (this.pane !== 'files') return;
    this.followReviewPath(fileList, null);
  }

  clearListPick() {
    this.listAnchor = null;
    this.listPicked = null;
  }

  clearSelection() {
    this.clearListPick();
    this.listDrag = null;
    this.selection = null;
    this.mouseAnchor = null;
    this.editDrag = null;
    this.pendingClick = null;
    this.scrollDrag = null;
    this.contextMenu = null;
  }

  get multiselect() {
    return this.sameList();
  }

  get listCursor() {
    return this[cursorKey(this)];
  }

  pinAnchor(index) {
    this.listAnchor = anchorAt(this, index);
  }

  sameList(anchor = this.listAnchor) {
    if (!anchor || anchor.pane !== this.pane) return false;
    if (!SPLIT_PANES.includes(this.pane)) return true;
    return (anchor.side || '') === (this.listSide || '');
  }

  // listPicked null is the span from the anchor to the cursor. An array is
  // the rows left after Ctrl toggles, and an empty array is a cleared group.
  listSelection(rows, eligible = () => true) {
    const anchor = this.listAnchor;
    if (!this.sameList(anchor)) return [];
    const picked = this.listPicked;
    const indices = picked ?? spanIndices(anchor.index, this.listCursor);
    if (!rows) return indices;
    return indices.filter((index) => eligible(rows[index]));
  }

  activeIndices(rows, eligible) {
    if (this.multiselect) return this.listSelection(rows, eligible);
    const entry = rows[this.listCursor];
    if (!entry || !eligible(entry)) return [];
    return [this.listCursor];
  }

  toggleListIndex(index, rows, eligible) {
    const key = cursorKey(this);
    const entry = rows[index];
    if (!key || !entry || !eligible(entry)) return false;
    this.listPicked = toggleMember(this.activeIndices(rows, eligible), index);
    this.listAnchor = anchorAt(this, index);
    this[key] = index;
    return true;
  }

  addListSpan(index, rows, eligible) {
    const key = cursorKey(this);
    if (!key || index < 0 || index >= rows.length) return false;
    const anchored = this.sameList();
    const anchor = anchored ? this.listAnchor.index : this[key];
    const span = spanIndices(anchor, index);
    const extra = span.filter((at) => eligible(rows[at]));
    const base = this.activeIndices(rows, eligible);
    this.listPicked = unionMembers(base, extra);
    if (!anchored) this.listAnchor = anchorAt(this, anchor);
    this[key] = index;
    return true;
  }

  selectedRows(rows, eligible) {
    const selected = this.listSelection(rows, eligible);
    const key = cursorKey(this);
    const cursor = key ? this[key] : undefined;
    const indices = this.multiselect ? selected : [cursor];
    return indices.map((index) => rows[index]).filter(Boolean);
  }

  moveList(delta, count, extend = false) {
    const key = cursorKey(this);
    if (!key) return;
    if (!extend) this.clearListPick();
    else if (!this.sameList()) this.listAnchor = anchorAt(this, this[key]);
    if (extend) this.listPicked = null;
    const last = Math.max(0, count - 1);
    this[key] = Math.max(0, Math.min(last, this[key] + delta));
  }

  get listScroll() {
    return this.listScrollByPane[this.pane] ?? 0;
  }

  set listScroll(value) {
    if (!LIST_PANES.includes(this.pane)) return;
    this.listScrollByPane[this.pane] = value ?? 0;
  }

  resetListScroll(pane = this.pane) {
    if (!LIST_PANES.includes(pane)) return;
    this.listScrollByPane[pane] = 0;
  }

  openList(pane) {
    this.pane = pane;
    this.resetListScroll(pane);
    this.clearSelection();
  }
}

module.exports = { Navigation };
