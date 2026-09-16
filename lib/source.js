'use strict';

const { parseGithubPrUrl } = require('./github.js');
const { parseGitlabMrUrl } = require('./gitlab.js');
const { capabilitiesFor, attachCapabilities } = require('./capabilities.js');

const selectChangeSource = (paths) => {
  if (!paths.length) return { kind: 'local', paths };
  const first = paths[0];
  const pr = parseGithubPrUrl(first);
  if (pr) return { kind: 'github-pr', pr, paths: paths.slice(1) };
  const mr = parseGitlabMrUrl(first);
  if (mr) return { kind: 'gitlab-mr', mr, paths: paths.slice(1) };
  return { kind: 'local', paths };
};

const createLoadedSource = (loaded, kind = 'github-pr', extra = {}) => {
  const load = () => {
    const items = loaded.items ?? [];
    return { ...loaded, items: [...items] };
  };
  const impl = {
    load,
    resolveRev: () => null,
  };
  if (extra.loadAsync) impl.loadAsync = extra.loadAsync;
  return attachCapabilities(impl, capabilitiesFor(kind));
};

module.exports = {
  selectChangeSource,
  createLoadedSource,
};
