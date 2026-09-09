'use strict';

const { parseGithubPrUrl } = require('./github.js');

const peelReviewVerb = (paths) => {
  if (paths.length < 2) return paths;
  if (paths[0] !== 'review') return paths;
  if (!parseGithubPrUrl(paths[1])) return paths;
  return paths.slice(1);
};

const selectChangeSource = (paths) => {
  const args = peelReviewVerb(paths);
  if (!args.length) return { kind: 'local', paths: args };
  const first = args[0];
  const pr = parseGithubPrUrl(first);
  if (!pr) return { kind: 'local', paths: args };
  return { kind: 'github-pr', pr, paths: args.slice(1) };
};

const createLoadedSource = (loaded) => ({
  load: () => {
    const items = loaded.items ?? [];
    return { ...loaded, items: [...items] };
  },
  add: () => {},
  unstage: () => {},
  revert: () => {},
});

module.exports = {
  selectChangeSource,
  createLoadedSource,
};
