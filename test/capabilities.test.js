'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const caps = require('../lib/capabilities.js');
const { SOURCE_CAPS, capabilitiesFor, attachCapabilities } = caps;
const { sessionCapabilities, createReviewStorage } = caps;
const { CHANGE_METHODS, BRANCH_METHODS } = caps;

const hasMethod = (source, name) => typeof source[name] === 'function';

test('capability matrix covers local commit remotes and read-only', () => {
  assert.deepEqual(SOURCE_CAPS.local, {
    read: true,
    changes: true,
    branches: true,
    review: true,
  });
  assert.deepEqual(capabilitiesFor('commit'), {
    read: true,
    changes: false,
    branches: false,
    review: true,
  });
  assert.deepEqual(capabilitiesFor('github-pr'), SOURCE_CAPS['github-pr']);
  assert.deepEqual(capabilitiesFor('gitlab-mr'), SOURCE_CAPS['gitlab-mr']);
  assert.equal(capabilitiesFor('read-only').changes, false);
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
  const remote = attachCapabilities(impl, capabilitiesFor('github-pr'));
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
    change: { source: 'github-pr' },
  });
  assert.equal(pr.changes, false);
  const mr = sessionCapabilities({
    change: { source: 'gitlab-mr' },
  });
  assert.equal(mr.branches, false);
  const fromRepo = sessionCapabilities({
    repo: { capabilities: SOURCE_CAPS.local },
    readOnly: true,
  });
  assert.equal(fromRepo.changes, false);
});

test('createReviewStorage uses injected fs methods', () => {
  const io = {
    readdirSync: () => ['a.md'],
    readFileSync: () => 'text',
    writeFileSync: () => 'wrote',
    mkdirSync: () => 'made',
  };
  const storage = createReviewStorage(io);
  assert.deepEqual(storage.readdirSync(), ['a.md']);
  assert.equal(storage.readFileSync(), 'text');
  assert.equal(storage.writeFileSync(), 'wrote');
  assert.equal(storage.mkdirSync(), 'made');
});

test('change and branch method lists stay explicit', () => {
  assert.ok(CHANGE_METHODS.includes('add'));
  assert.ok(CHANGE_METHODS.includes('revertFile'));
  assert.ok(CHANGE_METHODS.includes('edit'));
  assert.ok(BRANCH_METHODS.includes('push'));
  assert.ok(BRANCH_METHODS.includes('createBranchAsync'));
});
