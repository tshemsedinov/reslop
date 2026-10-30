'use strict';

const processPart = require('../common/process.js');
const { IS_WIN, npmBin, runProc, INSTALL_MS } = processPart;
const { oneLine } = require('../common/utilities.js');

const manifestWritable = (ui) => {
  const caps = ui.capabilities;
  if (!ui.readOnly && (!caps || caps.changes !== false)) return true;
  ui.status = 'read only';
  return false;
};

class PackageController {
  constructor(ui) {
    this.ui = ui;
    this.dropName = '';
    this.dropNames = [];
    this.addDev = false;
    this.running = false;
    this.job = null;
  }

  rows() {
    const data = this.ui.dashboard.packagesView();
    const modules = data.modules;
    return modules && modules.packages ? modules.packages : [];
  }

  selected() {
    return this.rows()[this.ui.nav.packagesCursor] ?? null;
  }

  canWrite() {
    if (this.running) return false;
    return manifestWritable(this.ui);
  }

  need() {
    if (!this.canWrite()) return null;
    const rows = this.ui.nav.selectedRows(this.rows());
    if (rows.length) return rows;
    this.ui.status = 'not a package';
    return null;
  }

  create() {
    if (!this.canWrite()) return;
    const pkg = this.selected();
    if (pkg && pkg.transitive) {
      this.ui.status = 'transitive';
      return;
    }
    this.addDev = Boolean(pkg && pkg.dev);
    this.ui.composer.openCompose('package', '');
  }

  finishAdd() {
    const editor = this.ui.composer.editor;
    if (!editor) return;
    const name = editor.text.trim();
    if (!name || /\s/.test(name) || name.startsWith('-')) {
      this.ui.status = 'name';
      return;
    }
    const args = ['install', name];
    if (this.addDev) args.push('--save-dev');
    this.ui.composer.closeCompose();
    this.job = this.exec(args, 'npm i', `installed ${name}`);
  }

  askDrop() {
    const rows = this.need();
    if (!rows) return;
    if (rows.some((pkg) => pkg.transitive)) {
      this.ui.status = 'transitive';
      return;
    }
    this.dropNames = rows.map((pkg) => pkg.name);
    this.dropName = this.dropNames.join(', ');
    this.ui.mode = 'confirmDrop';
    this.ui.status = '';
  }

  cancelDrop() {
    this.dropName = '';
    this.dropNames = [];
    this.ui.mode = 'review';
    this.ui.status = '';
  }

  confirmDrop() {
    const name = this.dropName;
    const names = this.dropNames;
    this.dropName = '';
    this.dropNames = [];
    this.ui.mode = 'review';
    if (!name) return;
    const done = `dropped ${name}`;
    this.job = this.exec(['uninstall', ...names], 'npm uninstall', done);
  }

  updateWanted() {
    const rows = this.need();
    if (!rows) return;
    const names = rows.map((pkg) => pkg.name);
    const done = `updated ${names.join(', ')}`;
    this.job = this.exec(['update', ...names], 'npm i', done);
  }

  updateLatest() {
    const rows = this.need();
    if (!rows) return;
    const commands = [];
    for (const dev of [false, true]) {
      const group = rows.filter((pkg) => Boolean(pkg.dev) === dev);
      if (!group.length) continue;
      const args = ['install', ...group.map((pkg) => `${pkg.name}@latest`)];
      if (dev) args.push('--save-dev');
      commands.push(args);
    }
    const names = rows.map((pkg) => pkg.name).join(', ');
    this.job = this.exec(
      commands[0],
      'npm i',
      `updated ${names}`,
      commands.slice(1),
    );
  }

  async exec(args, busy, done, more = []) {
    const ui = this.ui;
    const cwd = ui.top;
    this.running = true;
    ui.status = '';
    ui.ops.setBusy(busy);
    ui.ignoreWatch(INSTALL_MS);
    ui.paint();
    const run = async (args) => {
      try {
        const hook = ui.repo && ui.repo.runPackage;
        if (hook) return await hook(cwd, args);
        return await runProc(npmBin(), args, { cwd, shell: IS_WIN });
      } catch (error) {
        return { error, status: 1, stderr: '' };
      }
    };
    let result = null;
    for (const command of [args, ...more]) {
      result = await run(command);
      if (!result || result.error || result.status) break;
    }
    try {
      await ui.dashboard.runNpm(true);
      ui.nav.clearListPick();
      const last = Math.max(0, this.rows().length - 1);
      ui.nav.packagesCursor = Math.min(ui.nav.packagesCursor, last);
      ui.lifecycle.cachedExtras = null;
      ui.outdatedMap = undefined;
      ui.auditMap = undefined;
      ui.refreshFromRepo({ keepEmpty: true, quiet: true });
    } catch (error) {
      ui.status = error.message;
    }
    this.running = false;
    ui.ops.clearBusy();
    const failed = !result || result.error || result.status;
    if (failed) {
      const message = result && result.error ? result.error.message : '';
      const stderr = result ? result.stderr : '';
      ui.status = oneLine(stderr, message || 'npm failed');
    } else if (!ui.status) {
      ui.status = done;
    }
    ui.paint();
  }
}

module.exports = { manifestWritable, PackageController };
