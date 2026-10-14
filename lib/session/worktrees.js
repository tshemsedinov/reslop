'use strict';

const wt = require('../dashboard/worktrees.js');
const { readWorkspace, worktreesOf, worktreeTarget } = wt;
const linked = require('../git/linked.js');
const { addWorktree, removeWorktree, dirKey } = linked;

// Create, switch and remove the worktrees of a repository on the repos
// screen. Each worktree is a repository of its own for everything else
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

  selected() {
    const { rows, cursor } = this.ui.workspace;
    return rows[cursor] ?? null;
  }

  mainOf(row) {
    const rows = this.ui.workspace.rows.filter((it) => it.group === row.group);
    return rows.find((it) => it.main) ?? rows[0];
  }

  canWrite() {
    const ui = this.ui;
    if (ui.nav.pane !== 'repos' || ui.mode !== 'review') return false;
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

  // From the screen of a repository: its worktrees replace the folder
  async open() {
    const ui = this.ui;
    const home = ui.top;
    if (!ui.workspaceRoot) {
      const info = await readWorkspace(worktreesOf(home), []);
      ui.workspaceRoot = home;
      ui.workspaceInfo = info;
      ui.workspace.reset();
    }
    ui.workspace.origin = dirKey(home);
    await this.reload();
    await ui.workspace.show();
    ui.workspace.focusDir(home);
    ui.paint();
  }

  async reload() {
    const ui = this.ui;
    const ws = ui.workspace;
    const info = await readWorkspace(ui.workspaceInfo, ws.rows);
    ui.workspaceInfo = info;
    ws.adopt(info.repos);
    if (ui.nav.pane === 'repos' && ui.uiOpen) ui.lifecycle.startWatch();
  }

  onAdd() {
    if (!this.canWrite() || !this.selected()) return;
    this.ui.composer.openCompose('worktree', '');
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

  async create(row, name) {
    const ui = this.ui;
    const main = this.mainOf(row);
    this.busy = true;
    ui.status = 'creating worktree';
    ui.paint();
    try {
      const dir = await addWorktree(main.dir, worktreeTarget(main, name), name);
      await this.reload();
      ui.workspace.focusDir(dir);
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
    if (dirKey(row.dir) === dirKey(ui.workspaceRoot)) {
      ui.status = 'reslop was started in this worktree';
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
