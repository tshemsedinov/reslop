'use strict';

const path = require('node:path');

const { renderFrame, presentRows } = require('./render.js');
const keys = require('./keys.js');
const { actionFromKey, hitAction, decodeChunk, mouseKind } = keys;
const { extractText, isRange } = require('./select.js');
const { copyText } = require('./clipboard.js');
const { fileEntries, itemPath } = require('./files.js');

const LAYOUTS = ['unified', 'mixed', 'side'];
const FILES_IDLE = ['add', 'unstage', 'revert', 'skip'];
const FILES_MOVE = Object.assign(Object.create(null), {
  next: 1,
  prev: -1,
});
const ADD_STATUS = Object.assign(Object.create(null), {
  staged: 'already staged',
  commit: 'read only',
});
const UNSTAGE_STATUS = Object.assign(Object.create(null), {
  commit: 'read only',
});
const REVERT_STATUS = Object.assign(Object.create(null), {
  commit: 'read only',
});
const ENTER_TERM = '\x1b[?1049h\x1b[?25l\x1b[?7l\x1b[?1002h\x1b[?1006h';
const LEAVE_TERM = '\x1b[?1006l\x1b[?1002l\x1b[?7h\x1b[?25h\x1b[?1049l';

const layoutStatus = (id) => (id === 'side' ? 'side-by-side' : id);

const itemKey = (item) => {
  if (!item || !item.file) return '';
  const origin = item.origin ?? '';
  const rel = item.file.newPath || item.file.oldPath || '';
  if (!item.hunk) {
    const block = item.blockId ?? '-';
    return `${origin}:${rel}:file:${block}`;
  }
  const oldStart = item.hunk.oldStart;
  const newStart = item.hunk.newStart;
  const block = item.blockId ?? '-';
  return `${origin}:${rel}:${oldStart}:${newStart}:${block}`;
};

const HANDLERS = {
  add: (session) => session.onAdd(),
  unstage: (session) => session.onUnstage(),
  revert: (session) => session.onRevert(),
  skip: (session) => session.onSkip(),
  next: (session) => session.onNext(),
  prev: (session) => session.onPrev(),
  layout: (session) => session.onLayout(),
  files: (session) => session.onFiles(),
  open: (session) => session.onOpenFile(),
  quit: (session) => session.onQuit(),
  scrollUp: (session) => session.onScroll(-1),
  scrollDown: (session) => session.onScroll(1),
  help: (session) => session.onHelp(),
};

class Session {
  constructor(options) {
    this.repo = options.repo;
    this.cwd = options.cwd;
    this.paths = options.paths ?? [];
    this.stdin = options.stdin ?? null;
    this.stdout = options.stdout;
    this.color = options.color ?? true;
    this.copyText = options.copyText ?? copyText;
    this.getSize =
      options.getSize ??
      (() => ({
        width: this.stdout.columns ?? 80,
        height: this.stdout.rows ?? 24,
      }));
    this.items = [];
    this.top = options.cwd;
    this.index = 0;
    this.skipped = new Set();
    this.pane = options.startPane ?? 'diff';
    this.fileCursor = 0;
    this.reviewPath = null;
    this.scroll = 0;
    this.status = '';
    this.help = false;
    this.layout = 'unified';
    this.rev = options.rev ?? null;
    this.revShort = options.revShort ?? '';
    this.done = false;
    this.exitCode = 0;
    this.carry = '';
    this.lastFrame = null;
    this.lastSize = null;
    this.selection = null;
    this.mouseAnchor = null;
    this.dragging = false;
    this.pendingClick = null;
    this.abortController = null;
  }

  load() {
    const loaded = this.repo.load(this.cwd, this.paths, {
      commit: this.rev,
    });
    this.top = loaded.top ?? this.cwd;
    this.items = loaded.items;
    if (loaded.rev) {
      this.rev = loaded.rev;
    }
    if (loaded.revShort) {
      this.revShort = loaded.revShort;
    } else if (this.rev && !this.revShort) {
      this.revShort = this.rev.slice(0, 7);
    }
    this.pruneSkipped();
    if (this.index >= this.items.length) {
      this.index = Math.max(0, this.items.length - 1);
    }
    if (!this.isRemaining(this.items[this.index])) {
      this.focusRemaining(this.index, 1);
    }
    this.syncReviewPath();
    this.syncFileCursor();
  }

  pruneSkipped() {
    const live = new Set();
    for (const item of this.items) live.add(itemKey(item));
    for (const key of [...this.skipped]) {
      if (!live.has(key)) this.skipped.delete(key);
    }
  }

  isRemaining(item) {
    return Boolean(item) && !this.skipped.has(itemKey(item));
  }

  remainingIndices() {
    const indices = [];
    for (let i = 0; i < this.items.length; i++) {
      if (this.isRemaining(this.items[i])) indices.push(i);
    }
    return indices;
  }

  focusRemaining(from, direction) {
    const remaining = this.remainingIndices();
    if (!remaining.length) {
      this.index = 0;
      return false;
    }
    if (direction >= 0) {
      for (const i of remaining) {
        if (i >= from) {
          this.index = i;
          return true;
        }
      }
      this.index = remaining[remaining.length - 1];
      return true;
    }
    for (let k = remaining.length - 1; k >= 0; k--) {
      const i = remaining[k];
      if (i <= from) {
        this.index = i;
        return true;
      }
    }
    this.index = remaining[0];
    return true;
  }

  fileList() {
    const remaining = new Set(this.remainingIndices());
    const entries = fileEntries(this.items, remaining);
    if (!this.revShort) return entries;
    return entries.map((entry) => {
      if (entry.status !== 'commit') return entry;
      return { ...entry, status: this.revShort };
    });
  }

  syncReviewPath() {
    if (this.pane !== 'diff') return;
    const item = this.current();
    this.reviewPath = item ? itemPath(item) : null;
  }

  syncFileCursor() {
    const files = this.fileList();
    if (!files.length) {
      this.fileCursor = 0;
      return;
    }
    const here = this.reviewPath;
    const idx = files.findIndex((entry) => entry.path === here);
    if (idx >= 0) {
      this.fileCursor = idx;
    } else if (this.fileCursor >= files.length) {
      this.fileCursor = files.length - 1;
    }
  }

  counts() {
    const counts = {
      staged: 0,
      unstaged: 0,
      untracked: 0,
      commit: 0,
      skipped: 0,
    };
    for (const item of this.items) {
      if (!this.isRemaining(item)) {
        counts.skipped += 1;
        continue;
      }
      if (!Object.hasOwn(counts, item.origin)) continue;
      counts[item.origin] += 1;
    }
    return counts;
  }

  view() {
    const remaining = this.remainingIndices();
    const pos = remaining.indexOf(this.index);
    return {
      item: this.current(),
      index: pos < 0 ? 0 : pos,
      total: remaining.length,
      scroll: this.scroll,
      status: this.status,
      help: this.help,
      layout: this.layout,
      counts: this.counts(),
      selection: this.selection,
      pane: this.pane,
      files: this.fileList(),
      fileCursor: this.fileCursor,
      reviewPath: this.reviewPath,
      repoName: path.basename(this.top || this.cwd || ''),
      revShort: this.revShort || '',
    };
  }

  draw() {
    const size = this.getSize();
    const resized =
      !this.lastSize ||
      this.lastSize.width !== size.width ||
      this.lastSize.height !== size.height;
    const frame = renderFrame(this.view(), {
      width: size.width,
      height: size.height,
      color: this.color,
    });
    if (!resized && this.lastFrame && this.lastFrame.text === frame.text) {
      return;
    }
    this.lastSize = size;
    this.lastFrame = frame;
    this.stdout.write(presentRows(frame.rows, { clear: resized }));
  }

  dispatch(action) {
    if (this.pane === 'files') {
      const delta = FILES_MOVE[action];
      if (delta) {
        this.onFileMove(delta);
        return;
      }
      if (FILES_IDLE.includes(action)) return;
    }
    const handler = HANDLERS[action];
    if (!handler) return;
    handler(this);
  }

  current() {
    const item = this.items[this.index] ?? null;
    if (!this.isRemaining(item)) return null;
    return item;
  }

  reloadAfterChange() {
    const here = this.index;
    this.load();
    if (!this.items.length) {
      this.done = true;
      this.exitCode = 0;
      this.status = 'nothing to review';
      return;
    }
    this.focusRemaining(here, 1);
    this.syncReviewPath();
    this.syncFileCursor();
    this.scroll = 0;
    this.clearSelection();
  }

  clearSelection() {
    this.selection = null;
    this.mouseAnchor = null;
    this.dragging = false;
    this.pendingClick = null;
  }

  applyGit(item, label, write) {
    try {
      write(this.top, item);
      this.status = label;
      this.reloadAfterChange();
    } catch (error) {
      this.status = error.message;
    }
  }

  onAdd() {
    const item = this.current();
    if (!item) return;
    const blocked = ADD_STATUS[item.origin];
    if (blocked) {
      this.status = blocked;
      return;
    }
    this.applyGit(item, 'staged', (top, current) =>
      this.repo.add(top, current),
    );
  }

  onUnstage() {
    const item = this.current();
    if (!item) return;
    if (item.origin !== 'staged') {
      this.status = UNSTAGE_STATUS[item.origin] ?? 'not staged';
      return;
    }
    this.applyGit(item, 'unstaged', (top, current) =>
      this.repo.unstage(top, current),
    );
  }

  onRevert() {
    const item = this.current();
    if (!item) return;
    const blocked = REVERT_STATUS[item.origin];
    if (blocked) {
      this.status = blocked;
      return;
    }
    this.applyGit(item, 'reverted', (top, current) =>
      this.repo.revert(top, current),
    );
  }

  onSkip() {
    const item = this.items[this.index];
    if (!this.isRemaining(item)) return;
    this.skipped.add(itemKey(item));
    this.scroll = 0;
    this.clearSelection();
    const remaining = this.remainingIndices();
    if (!remaining.length) {
      this.status = 'all skipped';
      return;
    }
    this.focusRemaining(this.index + 1, 1);
    this.syncReviewPath();
    this.status = 'skipped';
  }

  moveRemaining(step) {
    const remaining = this.remainingIndices();
    if (!remaining.length) {
      this.status = 'all skipped';
      return;
    }
    const pos = remaining.indexOf(this.index);
    if (pos < 0) {
      this.focusRemaining(this.index, step);
      this.scroll = 0;
      this.status = '';
      this.clearSelection();
      this.syncReviewPath();
      return;
    }
    const next = pos + step;
    if (next < 0) {
      this.status = 'first block';
      return;
    }
    if (next >= remaining.length) {
      this.status = 'last block';
      return;
    }
    this.index = remaining[next];
    this.scroll = 0;
    this.status = '';
    this.clearSelection();
    this.syncReviewPath();
  }

  onNext() {
    this.moveRemaining(1);
  }

  onPrev() {
    this.moveRemaining(-1);
  }

  onQuit() {
    this.done = true;
    this.exitCode = 0;
  }

  onFiles() {
    if (this.pane === 'files') {
      if (!this.reviewPath) return;
      this.pane = 'diff';
      this.help = false;
      this.clearSelection();
      return;
    }
    this.pane = 'files';
    this.help = false;
    this.clearSelection();
    this.syncFileCursor();
  }

  onOpenFile() {
    if (this.pane !== 'files') return;
    const files = this.fileList();
    const entry = files[this.fileCursor];
    if (!entry) return;
    this.index = entry.firstIndex;
    this.pane = 'diff';
    this.scroll = 0;
    this.status = '';
    this.help = false;
    this.clearSelection();
    this.syncReviewPath();
  }

  onFileMove(delta) {
    const files = this.fileList();
    if (!files.length) {
      this.status = 'all skipped';
      return;
    }
    const next = this.fileCursor + delta;
    if (next < 0) {
      this.status = 'first file';
      return;
    }
    if (next >= files.length) {
      this.status = 'last file';
      return;
    }
    this.fileCursor = next;
    this.status = '';
  }

  onScroll(delta) {
    if (this.pane === 'files') {
      this.onFileMove(delta);
      return;
    }
    this.scroll = Math.max(0, this.scroll + delta);
    this.clearSelection();
  }

  onHelp() {
    this.help = !this.help;
    this.clearSelection();
  }

  onLayout() {
    const i = LAYOUTS.indexOf(this.layout);
    const next = (i < 0 ? 0 : i + 1) % LAYOUTS.length;
    this.layout = LAYOUTS[next];
    this.status = layoutStatus(this.layout);
    this.scroll = 0;
    this.clearSelection();
  }

  mouseCell(event) {
    const size = this.lastSize ?? this.getSize();
    const x = Math.min(Math.max(1, event.x), size.width);
    const y = Math.min(Math.max(1, event.y), size.height);
    return { x, y };
  }

  onMousePress(event) {
    const cell = this.mouseCell(event);
    this.mouseAnchor = cell;
    this.dragging = false;
    this.pendingClick = null;
    this.selection = null;
    if (this.lastFrame && cell.y === this.lastFrame.height) {
      this.pendingClick = hitAction(this.lastFrame.buttons, cell.x - 1);
    }
  }

  onMouseDrag(event) {
    if (!this.mouseAnchor) return;
    this.dragging = true;
    this.pendingClick = null;
    this.selection = {
      start: this.mouseAnchor,
      end: this.mouseCell(event),
    };
  }

  onMouseRelease(event) {
    const cell = this.mouseCell(event);
    if (this.mouseAnchor) {
      this.selection = { start: this.mouseAnchor, end: cell };
    }
    const clickId = this.pendingClick;
    this.pendingClick = null;
    this.mouseAnchor = null;
    this.dragging = false;
    if (clickId && this.lastFrame && !isRange(this.selection)) {
      const id = hitAction(this.lastFrame.buttons, cell.x - 1);
      if (id === clickId && cell.y === this.lastFrame.height) {
        this.dispatch(id);
      }
      this.selection = null;
      return;
    }
    const fileHits = this.lastFrame ? this.lastFrame.fileHits : null;
    if (this.pane === 'files' && fileHits && !isRange(this.selection)) {
      const hit = fileHits.find((row) => row.y === cell.y);
      if (hit) {
        this.fileCursor = hit.cursor;
        this.onOpenFile();
        this.selection = null;
        return;
      }
    }
    if (isRange(this.selection) && this.lastFrame) {
      const text = extractText(this.lastFrame.rows, this.selection);
      if (text) {
        const ok = this.copyText(text, this.stdout);
        this.status = ok ? 'copied' : 'copy failed';
      }
    }
  }

  handleEvent(event) {
    if (event.type === 'key') {
      const action = actionFromKey(event.key);
      if (action) this.dispatch(action);
      return;
    }
    if (event.type !== 'mouse') return;
    const kind = mouseKind(event);
    if (kind === 'wheelUp') {
      this.onScroll(-1);
      return;
    }
    if (kind === 'wheelDown') {
      this.onScroll(1);
      return;
    }
    if (event.btn !== 0 && event.btn !== undefined) return;
    if (kind === 'press') {
      this.onMousePress(event);
      return;
    }
    if (kind === 'drag') {
      this.onMouseDrag(event);
      return;
    }
    if (kind === 'release') this.onMouseRelease(event);
  }

  pushInput(text) {
    const decoded = decodeChunk(text, this.carry);
    this.carry = decoded.carry;
    for (const event of decoded.events) {
      this.handleEvent(event);
      if (this.done) return;
    }
    if (this.carry === '\x1b') {
      this.carry = '';
      this.handleEvent({ type: 'key', key: 'escape' });
    }
  }

  enterTerm() {
    if (this.stdin && this.stdin.setRawMode) this.stdin.setRawMode(true);
    if (this.stdin) this.stdin.resume();
    this.stdout.write(ENTER_TERM);
  }

  leaveTerm() {
    this.stdout.write(LEAVE_TERM);
    if (this.stdin && this.stdin.setRawMode) this.stdin.setRawMode(false);
  }

  async startUi() {
    this.enterTerm();
    try {
      this.draw();
      await this.readLoop();
    } finally {
      this.leaveTerm();
    }
    return this.exitCode;
  }

  readLoop() {
    return new Promise((resolve) => {
      this.abortController = new AbortController();
      const { signal } = this.abortController;
      const finish = () => {
        this.abortController.abort();
        resolve();
      };
      const onData = (chunk) => {
        this.pushInput(chunk.toString('utf8'));
        if (this.done) {
          finish();
          return;
        }
        this.draw();
      };
      this.stdin.on('data', (chunk) => onData(chunk), { signal });
      process.on('SIGWINCH', () => this.draw(), { signal });
    });
  }
}

module.exports = { LAYOUTS, ENTER_TERM, LEAVE_TERM, HANDLERS, Session };
