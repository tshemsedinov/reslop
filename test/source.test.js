'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const source = require('../lib/source/source.js');
const { selectChangeSource, createLoadedSource } = source;
const { SOURCE_CAPS, capabilitiesFor, attachCapabilities } = source;
const { sessionCapabilities } = source;
const { createGitRepo } = require('../lib/git/git.js');

test('selectChangeSource recognizes a GitHub pull request URL', () => {
  const url = 'https://github.com/acme/app/pull/123';
  const selected = selectChangeSource([url]);
  assert.equal(selected.kind, 'pr');
  assert.deepEqual(selected.pr, { owner: 'acme', repo: 'app', number: 123 });
  assert.deepEqual(selected.paths, []);
});

test('selectChangeSource recognizes a GitLab merge request URL', () => {
  const url = 'https://gitlab.com/acme/app/-/merge_requests/123';
  const selected = selectChangeSource([url]);
  assert.equal(selected.kind, 'mr');
  assert.deepEqual(selected.mr, {
    host: 'gitlab.com',
    project: 'acme/app',
    number: 123,
    origin: 'https://gitlab.com',
  });
  assert.deepEqual(selected.paths, []);
});

test('selectChangeSource recognizes a GitHub issue URL', () => {
  const url = 'https://github.com/acme/app/issues/12';
  const selected = selectChangeSource([url, 'lib']);
  assert.equal(selected.kind, 'issue');
  assert.deepEqual(selected.issue, { owner: 'acme', repo: 'app', number: 12 });
  assert.deepEqual(selected.paths, ['lib']);
});

test('selectChangeSource recognizes a GitLab issue URL', () => {
  const url = 'https://gitlab.com/group/app/-/issues/4';
  const selected = selectChangeSource([url]);
  assert.equal(selected.kind, 'gl-issue');
  assert.deepEqual(selected.issue, {
    host: 'gitlab.com',
    project: 'group/app',
    number: 4,
    origin: 'https://gitlab.com',
  });
  assert.deepEqual(selected.paths, []);
});

test('selectChangeSource recognizes a GitHub issue list', () => {
  const list = 'https://github.com/tshemsedinov/reslop/issues';
  const repo = 'https://github.com/tshemsedinov/reslop';
  const fromList = selectChangeSource([list]);
  const fromRepo = selectChangeSource([repo]);
  const expected = { owner: 'tshemsedinov', repo: 'reslop', list: true };
  assert.equal(fromList.kind, 'issue');
  assert.deepEqual(fromList.issue, expected);
  assert.equal(fromRepo.kind, 'issue');
  assert.deepEqual(fromRepo.issue, expected);
});

test('selectChangeSource recognizes a GitLab issue list', () => {
  const list = 'https://gitlab.com/acme/app/-/issues';
  const repo = 'https://gitlab.com/acme/app';
  const fromList = selectChangeSource([list]);
  const fromRepo = selectChangeSource([repo]);
  assert.equal(fromList.kind, 'gl-issue');
  assert.equal(fromList.issue.project, 'acme/app');
  assert.equal(fromList.issue.list, true);
  assert.equal(fromRepo.kind, 'gl-issue');
  assert.equal(fromRepo.issue.project, 'acme/app');
  const numbered = selectChangeSource([
    'https://gitlab.com/acme/app/-/issues/4',
  ]);
  assert.equal(numbered.kind, 'gl-issue');
  assert.equal(numbered.issue.number, 4);
  assert.equal(numbered.issue.list, undefined);
});

test('selectChangeSource does not treat review as a subcommand', () => {
  const url = 'https://github.com/acme/app/pull/123';
  const selected = selectChangeSource(['review', url, 'lib']);
  assert.equal(selected.kind, 'local');
  assert.deepEqual(selected.paths, ['review', url, 'lib']);
});

test('selectChangeSource keeps local paths and commits', () => {
  assert.deepEqual(selectChangeSource([]), { kind: 'local', paths: [] });
  assert.deepEqual(selectChangeSource(['lib']), {
    kind: 'local',
    paths: ['lib'],
  });
  assert.deepEqual(selectChangeSource(['7ac260c', 'lib']), {
    kind: 'local',
    paths: ['7ac260c', 'lib'],
  });
  assert.deepEqual(selectChangeSource(['review', 'lib']), {
    kind: 'local',
    paths: ['review', 'lib'],
  });
});

test('createLoadedSource is read only and copies its items', async () => {
  const item = { origin: 'pr', file: { newPath: 'a.js' } };
  const loaded = { items: [item], sourceLabel: '#1' };
  const source = createLoadedSource(loaded);
  const first = await source.load();
  first.items.push({ origin: 'task' });
  const second = await source.load();
  assert.equal(second.items.length, 1);
  assert.equal(typeof source.add, 'undefined');
  assert.equal(typeof source.unstage, 'undefined');
  assert.equal(typeof source.revert, 'undefined');
  assert.equal(typeof source.revertFile, 'undefined');
  assert.equal(typeof source.commit, 'undefined');
  assert.equal(source.resolveRev(), null);
  assert.equal(second.items[0].origin, 'pr');
  assert.equal(source.capabilities.changes, false);
  assert.equal(source.capabilities.branches, false);
});

const hasMethod = (source, name) => typeof source[name] === 'function';

test('capability matrix covers local commit remotes and read-only', () => {
  assert.deepEqual(capabilitiesFor('commit'), {
    read: true,
    changes: false,
    branches: false,
    review: true,
  });
  assert.deepEqual(capabilitiesFor('pr'), SOURCE_CAPS.pr);
  assert.deepEqual(capabilitiesFor('mr'), SOURCE_CAPS.mr);
  assert.deepEqual(capabilitiesFor('issue'), SOURCE_CAPS.issue);
  assert.deepEqual(capabilitiesFor('gl-issue'), SOURCE_CAPS['gl-issue']);
  assert.equal(capabilitiesFor('issue').changes, false);
  assert.equal(capabilitiesFor('readonly').changes, false);
  assert.equal(capabilitiesFor('local', { readOnly: true }).changes, false);
  assert.equal(capabilitiesFor('local', { readOnly: true }).branches, false);
});

test('attachCapabilities omits writes the source does not advertise', () => {
  const impl = {
    load: () => ({ items: [] }),
    add: () => 'added',
    commit: () => 'committed',
    listBranches: () => [],
  };
  const remote = attachCapabilities(impl, capabilitiesFor('pr'));
  assert.equal(hasMethod(remote, 'load'), true);
  assert.equal(hasMethod(remote, 'add'), false);
  assert.equal(hasMethod(remote, 'commit'), false);
  assert.equal(hasMethod(remote, 'listBranches'), false);
  assert.equal(remote.add, undefined);
  const local = attachCapabilities(impl, capabilitiesFor('local'));
  assert.equal(local.add(), 'added');
  assert.equal(local.commit(), 'committed');
});

test('sessionCapabilities follows rev change source and -r', () => {
  assert.equal(sessionCapabilities({ rev: 'abc' }).changes, false);
  assert.equal(sessionCapabilities({ readOnly: true }).branches, false);
  const pr = sessionCapabilities({
    change: { source: 'pr' },
  });
  assert.equal(pr.changes, false);
  const mr = sessionCapabilities({
    change: { source: 'mr' },
  });
  assert.equal(mr.branches, false);
  const fromRepo = sessionCapabilities({
    repo: { capabilities: SOURCE_CAPS.local },
    readOnly: true,
  });
  assert.equal(fromRepo.changes, false);
});

test('the local git repo can amend a commit', () => {
  const repo = createGitRepo();
  assert.ok(hasMethod(repo, 'updateCommit'));
});
