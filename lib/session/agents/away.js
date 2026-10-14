'use strict';

const { saveRunFiles } = require('./jobs.js');

const isRunning = (job) => job.status === 'running';

// Runs that go on in a worktree which is not shown. Each list is saved in
// the logs of its own directory and is taken back when that one is shown
class AwayRuns {
  constructor() {
    this.lists = new Map();
  }

  park(root, jobs) {
    if (root && jobs.some(isRunning)) this.lists.set(root, jobs);
  }

  take(root) {
    const jobs = this.lists.get(root);
    this.lists.delete(root);
    return jobs;
  }

  jobs() {
    return [...this.lists.values()].flat();
  }

  save() {
    for (const [root, jobs] of this.lists) {
      saveRunFiles(root, jobs);
      if (!jobs.some(isRunning)) this.lists.delete(root);
    }
  }

  // The count of runs in work by directory, with the list that is shown
  counts(root, jobs) {
    const lists = [...this.lists.entries()];
    if (root) lists.push([root, jobs]);
    const live = new Map();
    for (const [dir, list] of lists) {
      const count = list.filter(isRunning).length;
      if (count) live.set(dir, count);
    }
    return live;
  }
}

module.exports = { AwayRuns };
