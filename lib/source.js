'use strict';

const { parseGithubPrUrl } = require('./github.js');

const selectChangeSource = (paths) => {
  if (!paths.length) return { kind: 'local', paths };
  const first = paths[0];
  const pr = parseGithubPrUrl(first);
  if (!pr) return { kind: 'local', paths };
  return { kind: 'github-pr', pr, paths: paths.slice(1) };
};

const nop = () => {};

const createLoadedSource = (loaded) => ({
  load: () => {
    const items = loaded.items ?? [];
    return { ...loaded, items: [...items] };
  },
  add: nop,
  unstage: nop,
  revert: nop,
  revertFile: nop,
  resolveRev: () => null,
});

module.exports = {
  selectChangeSource,
  createLoadedSource,
};
