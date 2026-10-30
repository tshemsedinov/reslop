'use strict';

class BranchController {
  constructor(ui) {
    this.ui = ui;
    this.reset();
  }

  reset() {
    this.branches = [];
    this.dropName = '';
    this.dropNames = [];
  }

  selected() {
    return this.branches[this.ui.nav.branchCursor];
  }

  selectedRows() {
    return this.ui.nav.selectedRows(
      this.branches,
      (entry) => entry && !entry.current,
    );
  }

  canWrite() {
    return this.ui.nav.pane === 'branches' && this.ui.commits.canCommit();
  }

  async loadBranches() {
    const ui = this.ui;
    try {
      this.branches = await ui.repo.listBranches(ui.top);
      return true;
    } catch (error) {
      ui.status = error.message;
      return false;
    }
  }

  async refresh() {
    if (!this.ui.repo.listBranches) return;
    const loaded = await this.loadBranches();
    if (!loaded) return;
    const last = this.branches.length - 1;
    const nav = this.ui.nav;
    if (nav.branchCursor > last) nav.branchCursor = Math.max(0, last);
  }

  refreshAfterWrite(extra = {}) {
    const ui = this.ui;
    ui.ops.hold(Promise.all([this.refresh(), ui.commits.refresh()]));
    ui.refreshFromRepo({ keepEmpty: true, ...extra });
  }

  async open(focusTrees = false) {
    const ui = this.ui;
    const loaded = await this.loadBranches();
    if (!loaded) return;
    const current = this.branches.findIndex((entry) => entry.current);
    const nav = ui.nav;
    nav.branchCursor = current < 0 ? 0 : current;
    nav.treeFocus = focusTrees;
    nav.openList('branches');
    ui.status = '';
    void ui.worktrees.refreshTrees();
  }

  runWrite(name, args, kind, done) {
    const after = (extra) => this.refreshAfterWrite(extra);
    this.ui.ops.runWrite(name, args, kind, done, after);
  }

  onBranch() {
    const ui = this.ui;
    if (ui.mode === 'compose') return;
    if (!ui.commits.canCommit()) return;
    if (!ui.capabilities.branches || !ui.repo.listBranches) {
      ui.status = 'read only';
      return;
    }
    ui.ops.hold(this.open());
  }

  // The worktrees above the branches share the cursor keys with them: one
  // element is selected, up from the first branch reaches the worktrees
  moveBetweenTrees(delta) {
    const nav = this.ui.nav;
    if (!this.ui.worktrees.hasPanels()) return false;
    if (nav.treeFocus) {
      if (delta > 0) nav.treeFocus = false;
      return true;
    }
    if (delta >= 0 || nav.branchCursor > 0) return false;
    nav.treeFocus = true;
    return true;
  }

  onBranchMove(delta, extend = false) {
    const nav = this.ui.nav;
    if (!extend) nav.clearListPick();
    if (!extend && this.moveBetweenTrees(delta)) {
      return void (this.ui.status = '');
    }
    if (nav.treeFocus) return;
    if (!this.branches.length) {
      this.ui.status = 'nothing to review';
      return;
    }
    nav.moveList(delta, this.branches.length, extend);
    this.ui.status = '';
  }

  onCheckoutBranch() {
    const ui = this.ui;
    if (!ui.commits.canCommit()) return;
    const entry = this.selected();
    if (!entry || entry.current) return;
    const name = entry.name;
    const after = (extra) => this.refreshAfterWrite(extra);
    const done = `checked out ${name}`;
    ui.ops.runWrite('checkout', [name], 'checking out', done, after);
  }

  finishCreateBranch() {
    const ui = this.ui;
    const name = ui.composer.typedBranchName();
    if (!name) return;
    const after = (extra) => this.refreshAfterWrite(extra);
    const leave = () => {
      ui.composer.closeCompose();
    };
    const done = `created ${name}`;
    ui.ops.runWrite(
      'createBranch',
      [name],
      'creating branch',
      done,
      after,
      leave,
    );
  }

  onRebaseBranch() {
    if (!this.canWrite()) return;
    const entry = this.selected();
    if (!entry || entry.current) return;
    const onto = entry.name;
    this.runWrite('rebase', [onto], 'rebasing', `rebased onto ${onto}`);
  }

  onDropBranch() {
    if (!this.canWrite()) return;
    const rows = this.selectedRows().filter((entry) => !entry.current);
    if (!rows.length) return;
    this.dropNames = rows.map((entry) => entry.name);
    this.dropName = this.dropNames.join(', ');
    this.ui.mode = 'confirmDrop';
    this.ui.status = '';
  }

  cancelDropBranch() {
    this.ui.mode = 'review';
    this.dropName = '';
    this.dropNames = [];
    this.ui.status = '';
  }

  confirmDropBranch() {
    const names = this.dropNames;
    const name = this.dropName;
    this.ui.mode = 'review';
    this.dropName = '';
    this.dropNames = [];
    if (!names.length) return;
    const write = async (top) => {
      for (const branch of names) await this.ui.repo.drop(top, branch);
    };
    const doneStatus = `dropped ${name}`;
    const after = () => this.refreshAfterWrite({ doneStatus });
    this.ui.ops.runBusy('dropping', doneStatus, write, after);
  }

  onNewBranch() {
    if (this.canWrite()) this.ui.composer.openCompose('branch', '');
  }

  onPull() {
    if (this.ui.commits.canCommit()) {
      this.runWrite('pull', [], 'pulling', 'pulled');
    }
  }

  startPush(force) {
    const ui = this.ui;
    if (!ui.commits.canCommit()) return;
    const doneStatus = force ? 'force pushed' : 'pushed';
    const kind = force ? 'force pushing' : 'pushing';
    const write = (top) => ui.repo.push(top, force);
    const after = () => this.refreshAfterWrite({ doneStatus });
    ui.ops.runBusy(kind, doneStatus, write, after);
  }

  onPush() {
    this.startPush(false);
  }

  onForcePush() {
    this.ui.mode = 'review';
    this.startPush(true);
  }

  cancelPush() {
    this.ui.mode = 'review';
    this.ui.status = '';
  }
}

module.exports = { BranchController };
