'use strict';

const path = require('node:path');
const { REVIEW_DIR } = require('../common/files.js');
const { FileIndex, HEAT_MS } = require('../dashboard/tree.js');
const { UNKNOWN_PATH } = require('../dashboard/watch.js');
const workspace = require('../dashboard/workspace.js');
const { emptyDiff, countCommits, readDiffStat, taskStats, pickRun } = workspace;
const { currentBranchName } = workspace;
const { readNpmSummary } = require('../dashboard/npm.js');
const { reportCounts } = require('../dashboard/reports.js');
const { dirKey, changedFiles } = require('../git/linked.js');
const { resolveGitDirs } = require('../git/dir.js');

const TICK_ID = 'repos';

const freshBag = () => ({
  files: [],
  git: false,
  diff: false,
  runs: false,
  tasks: false,
  npm: false,
  activity: false,
});

const fullBag = () => ({
  files: [UNKNOWN_PATH],
  git: true,
  diff: true,
  runs: true,
  tasks: true,
  npm: true,
  activity: false,
});

const mergeBag = (left, right) => {
  const base = left ?? freshBag();
  return {
    files: [...base.files, ...right.files],
    git: base.git || right.git,
    diff: base.diff || right.diff,
    runs: base.runs || right.runs,
    tasks: base.tasks || right.tasks,
    npm: base.npm || right.npm,
    activity: base.activity || right.activity,
  };
};

// The path inside of a directory, or null for one outside of it
const insideOf = (base, full) => {
  const rel = path.relative(base, full);
  const out = rel === '..' || rel.startsWith(`..${path.sep}`);
  if (out || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
};

const gitDirKey = (dir) => {
  const dirs = resolveGitDirs(dir);
  return dirs ? dirKey(dirs.gitDir) : '';
};

// What a list of worktrees says of a repository
const rowMeta = (repo) => ({
  name: repo.name,
  group: repo.group ?? repo.name,
  main: repo.main ?? true,
  linked: repo.linked ?? false,
  branch: repo.branch ?? '',
  head: repo.head ?? '',
  detached: repo.detached ?? false,
  locked: repo.locked ?? false,
});

const blankRow = (repo) => ({
  ...rowMeta(repo),
  dir: repo.dir,
  key: dirKey(repo.dir),
  gitDir: gitDirKey(repo.dir),
  dirty: false,
  index: new FileIndex(repo.dir),
  bytes: 0,
  exts: [],
  tasks: 0,
  tasksDone: 0,
  commits: 0,
  diff: emptyDiff(),
  run: null,
  activityAt: 0,
  filesReady: false,
  commitsReady: false,
  diffReady: false,
  tasksReady: false,
  runsReady: false,
  npm: null,
  npmReady: false,
  pending: null,
  running: false,
});

const readFiles = async (row, bag) => {
  if (!bag.files.length) return;
  const unknown = bag.files.includes(UNKNOWN_PATH);
  if (unknown || !row.index.ready) await row.index.rescan();
  else await row.index.touch(bag.files);
  if (!row.index.ready) return;
  const summary = row.index.summary();
  row.bytes = summary.total.bytes;
  row.exts = summary.exts.slice(0, 3);
  row.filesReady = true;
};

const readCommits = async (row) => {
  const [commits, branch] = await Promise.all([
    countCommits(row.dir),
    currentBranchName(row.dir),
  ]);
  row.commits = commits;
  row.branch = branch;
  row.detached = !branch;
  row.commitsReady = true;
};

const readDiff = async (row) => {
  const [diff, changed] = await Promise.all([
    readDiffStat(row.dir),
    changedFiles(row.dir).catch(() => []),
  ]);
  row.diff = diff;
  row.dirty = changed.length > 0;
  row.diffReady = true;
};

const readTasks = (row) => {
  const stats = taskStats(row.dir);
  row.tasksDone = stats.done;
  row.tasks = stats.total;
  row.tasksReady = true;
};

const readRuns = (row) => {
  row.run = pickRun(row.dir);
  row.runsReady = true;
};

const readNpm = async (row) => {
  const [summary, counts] = await Promise.all([
    readNpmSummary(row.dir, row.npm),
    reportCounts(row.dir),
  ]);
  row.npm = { ...summary, ...counts };
  row.npmReady = true;
};

const toTile = (row, live) => ({
  id: row.name,
  name: row.name,
  group: row.group,
  linked: row.linked,
  branch: row.branch,
  detached: row.detached,
  head: row.head,
  locked: row.locked,
  dirty: row.dirty,
  agents: live.get(row.key) ?? 0,
  bytes: row.bytes,
  exts: row.exts,
  tasks: row.tasks,
  tasksDone: row.tasksDone,
  commits: row.commits,
  diff: row.diff,
  run: row.run,
  activityAt: row.activityAt,
  filesReady: row.filesReady,
  commitsReady: row.commitsReady,
  diffReady: row.diffReady,
  tasksReady: row.tasksReady,
  runsReady: row.runsReady,
  npm: row.npm,
  npmReady: row.npmReady,
});

const rowBusy = (row) => {
  if (!row.filesReady || !row.commitsReady) return true;
  if (!row.diffReady || !row.tasksReady) return true;
  return !row.runsReady || !row.npmReady;
};

const classifyRest = (rest) => {
  const bag = freshBag();
  if (!rest) {
    bag.files.push(UNKNOWN_PATH);
    bag.git = true;
    bag.runs = true;
    bag.tasks = true;
    bag.npm = true;
    bag.activity = true;
    return bag;
  }
  if (
    rest === 'package.json' ||
    rest === 'package-lock.json' ||
    rest === 'node_modules/.package-lock.json'
  ) {
    bag.npm = true;
  }
  if (rest === '.git' || rest.startsWith('.git/')) {
    bag.git = true;
    return bag;
  }
  if (rest === '.log' || rest.startsWith('.log/')) {
    bag.runs = true;
    return bag;
  }
  if (rest === REVIEW_DIR || rest.startsWith(`${REVIEW_DIR}/`)) {
    bag.tasks = true;
    return bag;
  }
  bag.files.push(rest);
  bag.diff = true;
  bag.activity = true;
  return bag;
};

// The tiles of a folder on the repos screen, and the ones of the worktrees
// of a repository above the branches
class Workspace {
  constructor(ui, options = {}) {
    this.ui = ui;
    this.pane = options.pane ?? 'repos';
    this.tick = this.pane === 'repos' ? TICK_ID : `${TICK_ID}-${this.pane}`;
    this.heat = `${this.tick}-heat`;
    this.infoOf = options.infoOf ?? (() => this.ui.workspaceInfo);
    this.epoch = 0;
    this.reset();
  }

  reset() {
    this.stop();
    this.rows = [];
    this.byName = new Map();
    this.cursor = 0;
    this.cols = 1;
  }

  // Whether the tiles are on the screen
  shown() {
    return this.ui.uiOpen && this.ui.nav.pane === this.pane;
  }

  seed() {
    const info = this.infoOf();
    const repos = info ? info.repos : [];
    this.rows = repos.map(blankRow);
    this.byName = new Map(this.rows.map((row) => [row.name, row]));
    if (this.cursor >= this.rows.length) this.cursor = 0;
  }

  // The list of worktrees changed: what is known of the rest is kept
  adopt(repos) {
    const focus = this.rows[this.cursor] ? this.rows[this.cursor].key : '';
    const known = new Map(this.rows.map((row) => [row.key, row]));
    const fresh = [];
    this.rows = repos.map((repo) => {
      const prev = known.get(dirKey(repo.dir));
      if (!prev) {
        const row = blankRow(repo);
        fresh.push(row);
        return row;
      }
      return Object.assign(prev, rowMeta(repo));
    });
    this.byName = new Map(this.rows.map((row) => [row.name, row]));
    const at = this.rows.findIndex((row) => row.key === focus);
    this.cursor = at < 0 ? Math.min(this.cursor, this.rows.length - 1) : at;
    this.cursor = Math.max(0, this.cursor);
    for (const row of fresh) this.kick(row, fullBag());
  }

  focusDir(dir) {
    const key = dirKey(dir);
    const at = this.rows.findIndex((row) => row.key === key);
    if (at >= 0) this.cursor = at;
  }

  stale(epoch) {
    return epoch !== this.epoch || !this.active;
  }

  publish(epoch) {
    if (this.stale(epoch)) return;
    this.afterDraw();
    if (this.shown()) this.ui.paint();
  }

  async settle(epoch, read) {
    await read();
    this.publish(epoch);
  }

  async apply(row, bag, epoch) {
    if (bag.activity) row.activityAt = Date.now();
    const jobs = [];
    if (bag.files.length) {
      jobs.push(this.settle(epoch, () => readFiles(row, bag)));
    }
    if (bag.git) jobs.push(this.settle(epoch, () => readCommits(row)));
    if (bag.git || bag.diff) {
      jobs.push(this.settle(epoch, () => readDiff(row)));
    }
    if (bag.tasks) jobs.push(this.settle(epoch, () => readTasks(row)));
    if (bag.runs) jobs.push(this.settle(epoch, () => readRuns(row)));
    if (bag.npm) jobs.push(this.settle(epoch, () => readNpm(row)));
    await Promise.all(jobs);
  }

  async pump(row) {
    row.running = true;
    while (row.pending && this.active) {
      const bag = row.pending;
      const epoch = this.epoch;
      row.pending = null;
      try {
        await this.apply(row, bag, epoch);
      } catch {
        // keep the previous snapshot until the next event
      }
      if (this.stale(epoch)) break;
      this.afterDraw();
      if (this.shown()) this.ui.paint();
    }
    row.running = false;
    if (row.pending && this.active) {
      void this.pump(row);
      return;
    }
    this.afterDraw();
    if (this.shown()) this.ui.paint();
  }

  kick(row, bag) {
    if (!row || !this.active) return;
    if (bag.activity) row.activityAt = Date.now();
    row.pending = mergeBag(row.pending, bag);
    if (row.running) return;
    void this.pump(row);
  }

  requestAll() {
    for (const row of this.rows) this.kick(row, fullBag());
  }

  // Everything is read again, but npm only where there is no answer yet:
  // the lists of packages change when their files do, and the watcher says so
  refresh() {
    for (const row of this.rows) {
      this.kick(row, { ...fullBag(), npm: !row.npmReady });
    }
  }

  // The worktree that owns a path of the watcher, and the path inside it.
  // A worktree can be anywhere, and the state of git of a linked one is
  // in the directory of the main one
  placeOf(rel, root) {
    const full = path.resolve(root, rel);
    let best = null;
    for (const row of this.rows) {
      for (const [base, lead] of [
        [row.key, ''],
        [row.gitDir, '.git/'],
      ]) {
        const inside = base ? insideOf(base, full) : null;
        if (inside === null) continue;
        if (best && base.length <= best.size) continue;
        best = { row, rest: `${lead}${inside}`, size: base.length };
      }
    }
    return best ?? this.placeByName(rel);
  }

  placeByName(rel) {
    const slash = rel.indexOf('/');
    const name = slash < 0 ? rel : rel.slice(0, slash);
    const row = this.byName.get(name);
    return row ? { row, rest: slash < 0 ? '' : rel.slice(slash + 1) } : null;
  }

  notePaths(paths) {
    if (!this.active) return;
    for (const rel of paths) {
      if (rel === UNKNOWN_PATH) return void this.requestAll();
    }
    const found = new Map();
    const info = this.infoOf();
    const root = dirKey(info ? info.root : '.');
    for (const rel of paths) {
      const place = this.placeOf(rel, root);
      if (!place) continue;
      const { row, rest } = place;
      const name = row.name;
      found.set(name, mergeBag(found.get(name), classifyRest(rest)));
    }
    for (const [name, bag] of found) this.kick(this.byName.get(name), bag);
    if (found.size) {
      this.afterDraw();
      if (this.shown()) this.ui.paint();
    }
  }

  start() {
    if (this.active) return;
    this.active = true;
    if (!this.rows.length) this.seed();
    this.requestAll();
  }

  stop() {
    this.epoch += 1;
    this.active = false;
    this.cancelTimers();
  }

  cancelTimers() {
    const { progress, term } = this.ui;
    if (!progress || !term) return;
    progress.stop(this.tick);
    term.cancel(this.heat);
  }

  hotUntil() {
    let until = 0;
    for (const row of this.rows) {
      until = Math.max(until, row.activityAt + HEAT_MS);
    }
    return until;
  }

  afterDraw() {
    if (!this.active) return;
    if (!this.shown()) return void this.cancelTimers();
    const now = Date.now();
    const until = this.hotUntil();
    const hot = now < until;
    const running = this.rows.some((row) => row.run?.status === 'running');
    const loading = this.rows.some((row) => rowBusy(row));
    const { progress, term } = this.ui;
    if (running || hot || loading) progress.start(this.tick);
    else progress.stop(this.tick);
    if (!hot) return;
    term.later(
      this.heat,
      () => {
        if (this.ui.nav.pane === this.pane) this.ui.paint();
      },
      until - now + 20,
    );
  }

  liveAgents() {
    const live = new Map();
    const running = this.ui.agents ? this.ui.agents.liveByRoot() : new Map();
    for (const [root, count] of running) live.set(dirKey(root), count);
    return live;
  }

  // The index of the worktree that is shown, -1 for none of the tiles
  currentIndex() {
    const key = dirKey(this.ui.top || this.ui.cwd || '.');
    return this.rows.findIndex((row) => row.key === key);
  }

  view() {
    const live = this.liveAgents();
    return {
      now: Date.now(),
      frame: this.ui.progressFrame,
      cursor: this.cursor,
      current: this.currentIndex(),
      tiles: this.rows.map((row) => toTile(row, live)),
    };
  }

  move(dx, dy) {
    const count = this.rows.length;
    if (!count) return;
    const cols = Math.max(1, this.cols || 1);
    const next = this.cursor + dx + dy * cols;
    if (next < 0 || next >= count) return;
    this.cursor = next;
    if (this.ui.uiOpen) this.ui.paint();
  }

  async switchTo(row) {
    const ui = this.ui;
    ui.flushReview();
    this.stop();
    ui.retarget({ cwd: row.dir, repoName: row.name, pane: 'dashboard' });
    try {
      await ui.ensureRepo();
    } catch (error) {
      ui.status = error instanceof Error ? error.message : `${error}`;
      return { loading: this.show() };
    }
    const loading = ui.openLoad();
    if (ui.uiOpen) {
      ui.lifecycle.startWatch();
      ui.dashboard.start();
      ui.paint();
    }
    return { loading };
  }

  async enter(name) {
    const row = this.byName.get(name);
    const ui = this.ui;
    if (!row || ui.mode !== 'review') return;
    const opened = await ui.ops.hold(this.switchTo(row));
    if (opened) await opened.loading;
  }

  openSelected() {
    const row = this.rows[this.cursor];
    if (!row) return Promise.resolve();
    return this.enter(row.name);
  }

  openAt(id) {
    const index = this.rows.findIndex((row) => row.name === id);
    if (index < 0) return Promise.resolve();
    this.cursor = index;
    return this.openSelected();
  }

  show() {
    const ui = this.ui;
    if (!ui.workspaceRoot) return Promise.resolve();
    ui.flushReview();
    const root = ui.workspaceRoot;
    const repoName = path.basename(root);
    ui.retarget({ cwd: root, top: root, repoName, pane: 'repos' });
    ui.loader.didLoad = true;
    this.start();
    if (ui.uiOpen) {
      ui.lifecycle.startWatch();
      ui.paint();
    }
    return Promise.resolve();
  }
}

module.exports = { Workspace };
