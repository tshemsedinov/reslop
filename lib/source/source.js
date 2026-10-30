'use strict';

const github = require('./github.js');
const gitlab = require('./gitlab.js');
const { parseGithubPrUrl, parseGithubIssueUrl } = github;
const { parseGithubIssueListUrl } = github;
const { parseGitlabMrUrl, parseGitlabIssueUrl } = gitlab;
const { parseGitlabIssueListUrl } = gitlab;

const READ_METHODS = [
  'load',
  'loadExtras',
  'toplevel',
  'resolveRev',
  'listFiles',
  'fileText',
];

const CHANGE_METHODS = [
  'add',
  'unstage',
  'revert',
  'revertFile',
  'edit',
  'writeFile',
  'stagePath',
];

const BRANCH_METHODS = [
  'commit',
  'updateCommit',
  'hasStaged',
  'lastMessage',
  'commitMessage',
  'listBranches',
  'listCommits',
  'currentBranch',
  'checkout',
  'createBranch',
  'rebase',
  'drop',
  'dropCommit',
  'dropCommits',
  'updateCommitTimes',
  'squashCommits',
  'applyFixup',
  'reword',
  'pull',
  'push',
];

const VIEW_CAPS = { read: true, changes: false, branches: false, review: true };

const SOURCE_CAPS = {
  local: { read: true, changes: true, branches: true, review: true },
  commit: VIEW_CAPS,
  pr: VIEW_CAPS,
  mr: VIEW_CAPS,
  issue: VIEW_CAPS,
  'gl-issue': VIEW_CAPS,
  readonly: VIEW_CAPS,
};

const withReadOnly = (caps, readOnly) => {
  if (!readOnly) return { ...caps };
  return { ...caps, changes: false, branches: false };
};

const capabilitiesFor = (kind, extra = {}) => {
  const base = SOURCE_CAPS[kind] ?? SOURCE_CAPS.local;
  return withReadOnly(base, extra.readOnly === true);
};

const copyMethods = (target, source, names) => {
  for (const name of names) {
    const method = source[name];
    if (typeof method === 'function') target[name] = method;
  }
};

const attachCapabilities = (impl, caps) => {
  const source = { capabilities: { ...caps } };
  if (caps.read) copyMethods(source, impl, READ_METHODS);
  if (caps.changes) copyMethods(source, impl, CHANGE_METHODS);
  if (caps.branches) copyMethods(source, impl, BRANCH_METHODS);
  return source;
};

const sessionCapabilities = (options) => {
  const readOnly = options.readOnly === true;
  if (options.capabilities) return withReadOnly(options.capabilities, readOnly);
  if (options.rev) return capabilitiesFor('commit', { readOnly });
  const source = options.change && options.change.source;
  if (SOURCE_CAPS[source]) return capabilitiesFor(source, { readOnly });
  const repoCaps = options.repo && options.repo.capabilities;
  if (repoCaps) return withReadOnly(repoCaps, readOnly);
  return capabilitiesFor('local', { readOnly });
};

const REMOTE_KINDS = {
  pr: {
    option: 'loadPullRequest',
    load: github.loadPullRequest,
    token: github.githubToken,
    target: (selected) => selected.pr,
  },
  mr: {
    option: 'loadMergeRequest',
    load: gitlab.loadMergeRequest,
    token: gitlab.gitlabToken,
    target: (selected) => selected.mr,
  },
  issue: {
    option: 'loadGithubIssue',
    load: github.loadGithubIssue,
    token: github.githubToken,
    target: (selected) => selected.issue,
  },
  'gl-issue': {
    option: 'loadGitlabIssue',
    load: gitlab.loadGitlabIssue,
    token: gitlab.gitlabToken,
    target: (selected) => selected.issue,
  },
};

const remoteKind = (selected) => REMOTE_KINDS[selected.kind] ?? null;

const selectChangeSource = (paths) => {
  if (!paths.length) return { kind: 'local', paths };
  const first = paths[0];
  const rest = paths.slice(1);
  const pr = parseGithubPrUrl(first);
  if (pr) return { kind: 'pr', pr, paths: rest };
  const githubIssue = parseGithubIssueUrl(first);
  if (githubIssue) return { kind: 'issue', issue: githubIssue, paths: rest };
  const githubIssues = parseGithubIssueListUrl(first);
  if (githubIssues) return { kind: 'issue', issue: githubIssues, paths: rest };
  const mr = parseGitlabMrUrl(first);
  if (mr) return { kind: 'mr', mr, paths: rest };
  const gitlabIssue = parseGitlabIssueUrl(first);
  if (gitlabIssue) return { kind: 'gl-issue', issue: gitlabIssue, paths: rest };
  const gitlabIssues = parseGitlabIssueListUrl(first);
  if (gitlabIssues) {
    return { kind: 'gl-issue', issue: gitlabIssues, paths: rest };
  }
  return { kind: 'local', paths };
};

const createLoadedSource = (loaded, kind = 'pr', extra = {}) => {
  const load = async () => {
    const items = loaded.items ?? [];
    return { ...loaded, items: [...items] };
  };
  const impl = { load: extra.load ?? load, resolveRev: () => null };
  return attachCapabilities(impl, capabilitiesFor(kind));
};

module.exports = {
  remoteKind,
  selectChangeSource,
  createLoadedSource,
  SOURCE_CAPS,
  capabilitiesFor,
  attachCapabilities,
  sessionCapabilities,
};
