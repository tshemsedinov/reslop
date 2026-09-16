'use strict';

const createProgress = (term, onTick, intervalMs) => {
  const active = new Map();

  const start = (id) => {
    const wasEmpty = active.size === 0;
    active.set(id, true);
    if (wasEmpty) {
      term.startTimer('progress', onTick, intervalMs);
    }
  };

  const stop = (id) => {
    active.delete(id);
    if (active.size === 0) term.stopTimer('progress');
  };

  const clear = () => {
    active.clear();
    term.stopTimer('progress');
  };

  const size = () => active.size;

  return { start, stop, clear, size };
};

module.exports = { createProgress };
