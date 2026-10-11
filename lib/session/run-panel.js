'use strict';

const { clamp } = require('../common/utilities.js');
const { logScrollMax } = require('../render/log.js');

class RunPanel {
  constructor(ui) {
    this.ui = ui;
  }

  barMax() {
    const bar = this.ui.lastFrame && this.ui.lastFrame.scrollBar;
    return bar ? Math.max(0, bar.count - bar.rows) : -1;
  }

  setLog(start, max) {
    const next = clamp(start, 0, max);
    this.logScroll = next;
    this.followEnd = next === max;
  }

  placeLog(start) {
    const max = this.barMax();
    if (max >= 0) this.setLog(start, max);
  }

  placeRuns(start) {
    const max = this.barMax();
    if (max >= 0) this.runScroll = clamp(start, 0, max);
  }

  scrollLogBy(delta, text, running) {
    const { lastSize, lastFrame } = this.ui;
    const max = logScrollMax(text, lastSize, lastFrame, running);
    const from = this.followEnd ? max : this.logScroll;
    this.setLog(from + delta, max);
  }
}

module.exports = { RunPanel };
