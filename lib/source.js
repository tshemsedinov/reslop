'use strict';

const { parseGithubPrUrl } = require('./github.js');
const { parseGitlabMrUrl } = require('./gitlab.js');

const selectChangeSource = (paths) => {
  if (!paths.length) return { kind: 'local', paths };
  const first = paths[0];
  const pr = parseGithubPrUrl(first);
  if (pr) return { kind: 'github-pr', pr, paths: paths.slice(1) };
  const mr = parseGitlabMrUrl(first);
  if (mr) return { kind: 'gitlab-mr', mr, paths: paths.slice(1) };
  return { kind: 'local', paths };
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
