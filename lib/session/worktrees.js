'use strict';

const wt = require('../dashboard/worktrees.js');
const { readWorkspace, worktreesOf, worktreeTarget } = wt;
const linked = require('../git/linked.js');
const { addWorktree, removeWorktree, dirKey } = linked;

// Create, switch and remove the worktrees of a repository. They are tiles
// above the branches, and on the repos screen when a folder is opened. Each
// worktree is a repository of its own for everything else
class WorktreeController {
  constructor(ui) {
    this.ui = ui;
    this.reset();
  }

  reset() {
    this.dropName = '';
    this.dropRow = null;
    this.busy = false;
  }

  // The tiles in use: the worktrees above the branches or the folder
  panel() {
    const { ui } = this;
    return ui.nav.pane === 'branches' ? ui.trees : ui.workspace;
  }

  // The tiles show only when there is more than one worktree
  hasPanels() {
    return this.ui.trees.rows.length > 1;
  }

  // One element is selected: a tile of the worktrees or a branch
  focused() {
    const { ui } = this;
    return ui.nav.pane === 'branches' && ui.nav.treeFocus && this.hasPanels();
  }

  selected() {
    const { rows, cursor } = this.panel();
    return rows[cursor] ?? null;
  }

  mainOf(row) {
    const rows = this.panel().rows.filter((it) => it.group === row.group);
    return rows.find((it) => it.main) ?? rows[0];
  }

  canWrite() {
    const { ui } = this;
    const inList = ui.nav.pane === 'repos' || ui.nav.pane === 'branches';
    if (!inList || ui.mode !== 'review') return false;
    if (!ui.capabilities.branches) {
      ui.status = 'read only';
      return false;
    }
    if (this.busy) {
      ui.status = 'busy';
      return false;
    }
    return true;
  }

  // Runs in work in a worktree keep it from being removed
  workingIn(row) {
    const { agents, npm } = this.ui;
    const key = dirKey(row.dir);
    const sources = [agents.liveByRoot(), npm.liveByRoot()];
    return sources.some((live) => {
      for (const [root, count] of live) {
        if (count && dirKey(root) === key) return true;
      }
      return false;
    });
  }

  // The worktrees of the repository that is shown
  async refreshTrees() {
    const { ui } = this;
    const top = ui.top;
    if (!top) return;
    try {
      const seed = { ...worktreesOf(top), root: top };
      const info = await readWorkspace(seed, ui.trees.rows);
      if (ui.top !== top) return;
      ui.treesInfo = { ...info, root: top };
    } catch {
      return;
    }
    if (ui.trees.active) ui.trees.adopt(ui.treesInfo.repos);
    else ui.trees.start();
    ui.trees.requestAll();
    ui.trees.focusDir(top);
    if (!this.hasPanels()) ui.nav.treeFocus = false;
    ui.lifecycle.watchTrees();
    if (ui.uiOpen && ui.nav.pane === 'branches') ui.paint();
  }

  // `w`: from the dashboard to the worktrees, on the branches to one more
  async onWorktrees() {
    const { ui } = this;
    if (ui.nav.pane === 'dashboard') {
      if (!ui.commits.canCommit()) return;
      await ui.gitBranches.open(true);
      await this.refreshTrees();
      return;
    }
    if (ui.nav.pane !== 'branches') return;
    if (this.hasPanels()) {
      ui.nav.treeFocus = true;
      ui.status = '';
      return;
    }
    this.onAdd();
  }

  moveTree(dx) {
    if (this.focused()) this.ui.trees.move(dx, 0);
  }

  // A click on a tile selects it and shows that worktree
  pickTile(name) {
    const { ui } = this;
    const at = ui.trees.rows.findIndex((row) => row.name === name);
    if (at < 0 || ui.mode !== 'review') return;
    ui.trees.cursor = at;
    ui.nav.treeFocus = true;
    ui.ops.hold(this.enterSelected());
  }

  // Selecting a tile shows that worktree: its branches, files, diffs, tasks
  async enterSelected() {
    const { ui } = this;
    const row = this.selected();
    if (!row || ui.mode !== 'review' || this.busy) return;
    if (dirKey(row.dir) === dirKey(ui.top)) return;
    ui.flushReview();
    const home = ui.dashboardHome;
    ui.retarget({ cwd: row.dir, repoName: row.name, pane: 'branches' });
    ui.dashboardHome = home;
    try {
      await ui.ensureRepo();
    } catch (error) {
      ui.status = error instanceof Error ? error.message : `${error}`;
      return;
    }
    const loading = ui.openLoad();
    await ui.gitBranches.open(true);
    await this.refreshTrees();
    if (ui.uiOpen) {
      ui.lifecycle.startWatch();
      if (home) ui.dashboard.start();
      ui.paint();
    }
    await loading;
  }

  onAdd() {
    if (!this.canWrite() || !this.selected()) return;
    this.ui.composer.openCompose('worktree', '');
    this.ui.status = 'new worktree: branch name';
  }

  finishAdd() {
    const ui = this.ui;
    const editor = ui.composer.editor;
    const name = editor ? editor.text.trim() : '';
    if (!name) {
      ui.status = 'empty branch name';
      return;
    }
    const row = this.selected();
    ui.composer.closeCompose();
    if (!row) return;
    ui.ops.hold(this.create(row, name));
  }

  async reload() {
    const { ui } = this;
    if (ui.nav.pane === 'branches') {
      await this.refreshTrees();
      return;
    }
    const ws = ui.workspace;
    const info = await readWorkspace(ui.workspaceInfo, ws.rows);
    ui.workspaceInfo = info;
    ws.adopt(info.repos);
    if (ui.nav.pane === 'repos' && ui.uiOpen) ui.lifecycle.startWatch();
  }

  async create(row, name) {
    const ui = this.ui;
    const main = this.mainOf(row);
    this.busy = true;
    ui.status = 'creating worktree';
    ui.paint();
    try {
      const dir = await addWorktree(main.dir, worktreeTarget(main, name), name);
      await this.reload();
      this.panel().focusDir(dir);
      ui.status = `created ${name}`;
    } catch (error) {
      ui.status = error.message;
    } finally {
      this.busy = false;
      ui.paint();
    }
  }

  onDrop() {
    const ui = this.ui;
    const row = this.selected();
    if (!this.canWrite() || !row) return;
    if (row.main) {
      ui.status = 'the main worktree stays';
      return;
    }
    if (ui.nav.pane === 'branches' && dirKey(row.dir) === dirKey(ui.top)) {
      ui.status = 'this worktree is shown';
      return;
    }
    if (this.workingIn(row)) {
      ui.status = 'runs are working in this worktree';
      return;
    }
    this.dropRow = row;
    this.dropName = `worktree ${row.name}`;
    ui.mode = 'confirmWorktree';
    ui.status = '';
  }

  cancelDrop() {
    this.ui.mode = 'review';
    this.reset();
    this.ui.status = '';
  }

  confirmDrop() {
    const row = this.dropRow;
    this.ui.mode = 'review';
    this.reset();
    if (row) this.ui.ops.hold(this.remove(row));
  }

  // Git refuses a dirty or locked worktree and so does this, nothing is forced
  async remove(row) {
    const ui = this.ui;
    this.busy = true;
    ui.status = 'removing worktree';
    ui.paint();
    try {
      await removeWorktree(this.mainOf(row).dir, row.dir);
      await this.reload();
      ui.status = `removed ${row.name}`;
    } catch (error) {
      ui.status = error.message;
    } finally {
      this.busy = false;
      ui.paint();
    }
  }
}

module.exports = { WorktreeController };
