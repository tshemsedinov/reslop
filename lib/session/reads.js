'use strict';

// Repo reads the screen needs on every frame: loaded ahead and kept here
class FileReads {
  constructor(ui) {
    this.ui = ui;
    this.reset();
  }

  reset() {
    this.names = [];
    this.textKey = null;
    this.text = '';
    this.stamp = 0;
    this.wanted = null;
  }

  keyOf(rel) {
    const ui = this.ui;
    return `${ui.top}\0${ui.rev ?? ''}\0${rel}`;
  }

  async readNames() {
    const ui = this.ui;
    if (!ui.repo.listFiles) return [];
    const options = { commit: ui.rev };
    try {
      return await ui.repo.listFiles(ui.top || ui.cwd, ui.paths ?? [], options);
    } catch {
      return [];
    }
  }

  async readText(rel) {
    const ui = this.ui;
    const key = this.keyOf(rel);
    const repo = ui.repo;
    const readable = rel && repo && typeof repo.fileText === 'function';
    if (!readable) return { key, text: '' };
    try {
      return { key, text: await repo.fileText(ui.top, rel, ui.rev) };
    } catch {
      return { key, text: '' };
    }
  }

  // What a reload needs besides the snapshot, applied together with it
  async read() {
    const nav = this.ui.nav;
    const listed = nav.fileScope === 'file';
    const rel = nav.pane === 'unit' ? nav.reviewPath : null;
    const reads = [
      listed ? this.readNames() : null,
      rel ? this.readText(rel) : null,
    ];
    const stamp = this.stamp;
    const [names, viewed] = await Promise.all(reads);
    return { names, viewed, stamp };
  }

  // Text kept since the read began is newer than what the read found
  apply(found) {
    if (found.names) this.names = found.names;
    if (found.viewed && found.stamp === this.stamp) this.keep(found.viewed);
  }

  keep(viewed) {
    this.textKey = viewed.key;
    this.text = viewed.text;
    this.stamp += 1;
  }

  keepText(rel, text) {
    this.keep({ key: this.keyOf(rel), text });
  }

  async loadNames() {
    this.names = await this.readNames();
  }

  async loadText(rel) {
    const viewed = await this.readText(rel);
    this.keep(viewed);
    return viewed.text;
  }

  cached(rel) {
    if (!rel || this.textKey !== this.keyOf(rel)) return null;
    return this.text;
  }

  // A path nobody loaded ahead is read now and painted when it arrives
  textOf(rel) {
    const text = this.cached(rel);
    if (text !== null || !rel) return text ?? '';
    const key = this.keyOf(rel);
    if (this.wanted === key) return '';
    this.wanted = key;
    const ui = this.ui;
    const done = () => {
      this.wanted = null;
      ui.paint();
    };
    ui.ops.track(this.loadText(rel).then(done, done));
    return '';
  }
}

module.exports = { FileReads };
