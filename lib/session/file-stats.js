'use strict';

const { readEntry } = require('../dashboard/tree.js');
const { mapLimit } = require('../common/utilities.js');

const CONCURRENCY = 32;

// The size and lines of the listed files, read from the worktree when the
// list names one nobody read yet or after a reload, painted when they arrive
class FileStats {
  constructor(ui) {
    this.ui = ui;
    this.reset();
  }

  reset() {
    this.entries = new Map();
    this.epoch = (this.epoch ?? 0) + 1;
    this.reading = false;
    this.dirty = false;
  }

  stale() {
    this.dirty = true;
  }

  of(rels) {
    const ui = this.ui;
    if (ui.rev || ui.change || !ui.top) return this.entries;
    const missing = rels.some((rel) => !this.entries.has(rel));
    if ((this.dirty || missing) && !this.reading) {
      ui.ops.track(this.read(rels));
    }
    return this.entries;
  }

  async read(rels) {
    const { ui, epoch, entries } = this;
    this.reading = true;
    this.dirty = false;
    const root = ui.top;
    const read = (rel) => readEntry(root, rel, entries.get(rel), 0);
    const found = await mapLimit(rels, CONCURRENCY, read);
    if (epoch !== this.epoch) return;
    this.reading = false;
    let changed = false;
    for (let i = 0; i < rels.length; i++) {
      if (entries.get(rels[i]) === found[i]) continue;
      entries.set(rels[i], found[i]);
      changed = true;
    }
    if (changed && ui.nav.pane === 'files') ui.paint();
  }
}

module.exports = { FileStats };
