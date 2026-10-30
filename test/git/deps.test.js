'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { realpathSync } = fs;
const path = require('node:path');

const deps = require('../../lib/deps/deps.js');
const { foldDepItems } = deps;
const { proposeDepItems } = deps;
const manifest = require('../../lib/deps/manifest.js');
const { lockPackageCount } = manifest;
const git = require('../../lib/git/git.js');
const { load, loadExtras, addItem, unstageItem, revertItem } = git;
const gitDeps = require('../../lib/git/deps.js');
const { proposedNpmPlan, stagePath } = gitDeps;
const render = require('../../lib/render/render.js');
const { Session } = require('../../lib/session/session.js');
const { makeRepo, sink, openRepoSession } = require('../helpers.js');
const { stripAnsi, THEME, bg } = require('../../lib/term/ansi.js');
const depsHelpers = require('../deps-helpers.js');
const { pkgJson, pkgLib, noExportPkg, libPkg, lockV3, dummyItem } = depsHelpers;
const { sidesOf, hunkTexts, assertBlankAfter, depByName } = depsHelpers;
const { lodashOutdated } = depsHelpers;

const sessionFor = (dir) =>
  openRepoSession(dir, { stdout: sink(), startPane: 'diff' });

const parseGitJson = (repo, spec) => JSON.parse(repo.git(['show', spec]));

const proposedLodash = async (repo) => {
  const oldDeps = { lodash: '^4.17.20' };
  const extra = { description: 'keep me' };
  repo.write('package.json', pkgJson(oldDeps, extra));
  repo.write('package-lock.json', lockV3(oldDeps, { lodash: '4.17.20' }));
  repo.git(['add', '.']);
  repo.git(['commit', '-m', 'init']);
  repo.write('notes.txt', 'unrelated\n');
  const outdatedMap = lodashOutdated();
  const loaded = await load(repo.dir, [], {
    deferExtras: false,
    audit: true,
    outdatedMap,
    auditMap: null,
  });
  const item = depByName(loaded.items, 'lodash');
  const pkg = repo.read('package.json');
  const lock = repo.read('package-lock.json');
  return { loaded, item, pkg, lock };
};

const timedOut = () => {
  const error = new Error('timed out');
  error.code = 'ETIMEDOUT';
  return { status: null, error };
};

for (const pair of [
  ['nonzero', () => ({ status: 1, stderr: 'npm ERR! boom' }), /npm ERR! boom/],
  [
    'thrown',
    () => {
      throw new Error('install boom');
    },
    /install boom/,
  ],
  ['rejected', () => Promise.reject(new Error('install nope')), /install nope/],
  ['timed out', timedOut, /timed out/],
]) {
  const name = pair[0];
  const install = pair[1];
  const message = pair[2];
  test(`${name} npm runner restores owned dependency files`, async (t) => {
    const repo = makeRepo();
    t.after(repo.cleanup);
    const { loaded, item, pkg, lock } = await proposedLodash(repo);
    item.dep.install = install;
    await assert.rejects(() => addItem(loaded.top, item), message);
    assert.equal(repo.read('package.json'), pkg);
    assert.equal(repo.read('package-lock.json'), lock);
    assert.equal(repo.read('notes.txt'), 'unrelated\n');
  });
}

const dependencyStagingRepo = (t) => {
  const repo = makeRepo();
  t.after(repo.cleanup);
  const before = { lodash: '^4.17.20' };
  const after = { lodash: '^4.17.21', leftpad: '1.0.0' };
  repo.write('package.json', pkgJson(before));
  repo.write('package-lock.json', lockV3(before, { lodash: '4.17.20' }));
  repo.git(['add', '.']);
  repo.git(['commit', '-m', 'init']);
  repo.write('package.json', pkgJson(after));
  const versions = { lodash: '4.17.21', leftpad: '1.0.0' };
  repo.write('package-lock.json', lockV3(after, versions));
  for (const rel of ['package.json', 'package-lock.json']) {
    fs.utimesSync(path.join(repo.dir, rel), 1, 1);
  }
  return repo;
};

const dependencyFiles = (repo) =>
  ['package.json', 'package-lock.json'].map((rel) => {
    const file = path.join(repo.dir, rel);
    const { mtimeMs, mode, ino } = fs.statSync(file);
    return { text: repo.read(rel), mtimeMs, mode, ino };
  });

test('load folds local dependency files into one review item', async () => {
  const repo = makeRepo();
  try {
    const oldDeps = { lodash: '^4.17.20' };
    const newDeps = { lodash: '^4.17.21' };
    repo.write('keep.js', 'ok\n');
    repo.write('package.json', pkgJson(oldDeps));
    repo.write('package-lock.json', lockV3(oldDeps, { lodash: '4.17.20' }));
    repo.git(['add', '.']);
    repo.git(['commit', '-m', 'init']);
    repo.write('package.json', pkgJson(newDeps));
    repo.write('package-lock.json', lockV3(newDeps, { lodash: '4.17.21' }));
    const loaded = await load(repo.dir, [], { deferExtras: false });
    const depItems = loaded.items.filter((item) => item.dep);
    assert.equal(depItems.length, 1);
    assert.equal(depItems[0].origin, 'unstaged');
    assert.deepEqual(depItems[0].dep.files, [
      'package.json',
      'package-lock.json',
    ]);
  } finally {
    repo.cleanup();
  }
});

test('load marks an added dependency that is not imported', async () => {
  const repo = makeRepo();
  try {
    const oldDeps = { lodash: '^4.17.20' };
    const newDeps = { lodash: '^4.17.20', leftpad: '1.0.0' };
    const newVers = { lodash: '4.17.20', leftpad: '1.0.0' };
    repo.write('app.js', 'const _ = require("lodash");\n');
    repo.write('package.json', pkgLib(oldDeps));
    repo.write('package-lock.json', lockV3(oldDeps, { lodash: '4.17.20' }));
    repo.write('node_modules/leftpad/package.json', libPkg('leftpad'));
    repo.git(['add', '.']);
    repo.git(['commit', '-m', 'init']);
    repo.write('package.json', pkgLib(newDeps));
    repo.write('package-lock.json', lockV3(newDeps, newVers));
    const loaded = await load(repo.dir, [], { deferExtras: false });
    const leftpad = depByName(loaded.items, 'leftpad');
    assert.ok(leftpad);
    assert.equal(leftpad.dep.change.unused, true);
    assert.equal(leftpad.dep.change.propose, true);
  } finally {
    repo.cleanup();
  }
});

test('load proposes an unused dependency with no package diffs', async () => {
  const repo = makeRepo();
  try {
    const deps = { lodash: '^4.17.20', leftpad: '1.0.0' };
    repo.write('app.js', 'const _ = require("lodash");\n');
    repo.write('package.json', pkgLib(deps));
    repo.write(
      'package-lock.json',
      lockV3(deps, {
        lodash: '4.17.20',
        leftpad: '1.0.0',
      }),
    );
    repo.write('node_modules/leftpad/package.json', libPkg('leftpad'));
    repo.git(['add', '.']);
    repo.git(['commit', '-m', 'init']);
    const loaded = await load(repo.dir, [], {
      deferExtras: false,
      audit: true,
      outdatedMap: null,
      auditMap: null,
    });
    const item = depByName(loaded.items, 'leftpad');
    assert.ok(item);
    assert.equal(item.dep.change.propose, true);
    assert.equal(item.dep.change.unused, true);
    assertBlankAfter(hunkTexts(item), 'npm uninstall: dependency unused');
  } finally {
    repo.cleanup();
  }
});

test('deferred load shows unused deps after extras', async () => {
  const repo = makeRepo();
  try {
    const deps = { lodash: '^4.17.20', leftpad: '1.0.0' };
    repo.write('app.js', 'const _ = require("lodash");\n');
    repo.write('package.json', pkgLib(deps));
    repo.write(
      'package-lock.json',
      lockV3(deps, {
        lodash: '4.17.20',
        leftpad: '1.0.0',
      }),
    );
    repo.write('node_modules/leftpad/package.json', libPkg('leftpad'));
    repo.git(['add', '.']);
    repo.git(['commit', '-m', 'init']);
    const loaded = await load(repo.dir, [], { audit: true, deferExtras: true });
    assert.equal(depByName(loaded.items, 'leftpad'), null);
    assert.equal(loaded.pending, true);
    const extra = await loadExtras(loaded, {
      audit: true,
      outdatedMap: null,
      auditMap: null,
    });
    const item = depByName(extra.items, 'leftpad');
    assert.ok(item);
    assert.equal(item.dep.change.unused, true);
  } finally {
    repo.cleanup();
  }
});

test('load does not propose unused for a dep with no exports', async () => {
  const repo = makeRepo();
  try {
    const deps = { lodash: '^4.17.20', metaskills: '^1.0.5' };
    repo.write('app.js', 'const _ = require("lodash");\n');
    repo.write('package.json', pkgLib(deps));
    repo.write(
      'package-lock.json',
      lockV3(deps, {
        lodash: '4.17.20',
        metaskills: '1.0.5',
      }),
    );
    repo.write(
      'node_modules/metaskills/package.json',
      noExportPkg('metaskills'),
    );
    repo.git(['add', '.']);
    repo.git(['commit', '-m', 'init']);
    const loaded = await load(repo.dir, [], {
      deferExtras: false,
      audit: true,
      outdatedMap: null,
      auditMap: null,
    });
    assert.equal(depByName(loaded.items, 'metaskills'), null);
  } finally {
    repo.cleanup();
  }
});

test('load proposes an outdated dependency with no package diffs', async () => {
  const repo = makeRepo();
  try {
    repo.write('package.json', pkgJson({ lodash: '^4.17.20' }));
    repo.git(['add', '.']);
    repo.git(['commit', '-m', 'init']);
    const outdatedMap = lodashOutdated();
    const loaded = await load(repo.dir, [], {
      deferExtras: false,
      audit: true,
      outdatedMap,
      auditMap: null,
    });
    const lodash = depByName(loaded.items, 'lodash');
    assert.ok(lodash);
    assert.equal(lodash.dep.change.propose, true);
    assert.equal(lodash.dep.change.to, '^4.17.21');
    const lines = hunkTexts(lodash);
    assert.ok(lines.includes('npm outdated: dependency version changed'));
    assert.ok(!lines.some((line) => line.startsWith('npm outdated  ')));
  } finally {
    repo.cleanup();
  }
});

test('add on a proposed update writes package.json, runs npm i', async () => {
  const repo = makeRepo();
  try {
    const oldDeps = { lodash: '^4.17.20' };
    repo.write('package.json', pkgJson(oldDeps));
    repo.write('package-lock.json', lockV3(oldDeps, { lodash: '4.17.20' }));
    repo.git(['add', '.']);
    repo.git(['commit', '-m', 'init']);
    const outdatedMap = lodashOutdated();
    const loaded = await load(repo.dir, [], {
      deferExtras: false,
      audit: true,
      outdatedMap,
      auditMap: null,
    });
    const item = depByName(loaded.items, 'lodash');
    assert.ok(item);
    let installed = '';
    item.dep.install = (cwd) => {
      installed = cwd;
      const next = { lodash: '^4.17.21' };
      repo.write('package-lock.json', lockV3(next, { lodash: '4.17.21' }));
      return { status: 0 };
    };
    await addItem(loaded.top, item);
    assert.equal(realpathSync.native(installed), realpathSync.native(repo.dir));
    const pkg = JSON.parse(repo.read('package.json'));
    assert.equal(pkg.dependencies.lodash, '^4.17.21');
    const lock = JSON.parse(repo.read('package-lock.json'));
    assert.equal(lock.packages['node_modules/lodash'].version, '4.17.21');
    const cached = repo.git(['diff', '--cached', '--name-only']);
    assert.match(cached, /package\.json/);
    assert.match(cached, /package-lock\.json/);
  } finally {
    repo.cleanup();
  }
});

test('add on an unused dependency runs npm uninstall', async () => {
  const repo = makeRepo();
  try {
    const keep = { lodash: '^4.17.20' };
    const added = { lodash: '^4.17.20', leftpad: '1.0.0' };
    repo.write('app.js', 'const _ = require("lodash");\n');
    repo.write('package.json', pkgLib(keep));
    repo.write('package-lock.json', lockV3(keep, { lodash: '4.17.20' }));
    repo.write('node_modules/leftpad/package.json', libPkg('leftpad'));
    repo.git(['add', '.']);
    repo.git(['commit', '-m', 'init']);
    repo.write('package.json', pkgLib(added));
    repo.write(
      'package-lock.json',
      lockV3(added, {
        lodash: '4.17.20',
        leftpad: '1.0.0',
      }),
    );
    const loaded = await load(repo.dir, [], { deferExtras: false });
    const item = depByName(loaded.items, 'leftpad');
    assert.ok(item);
    let removed = '';
    item.dep.install = (cwd) => {
      removed = cwd;
      repo.write('package.json', pkgJson(keep));
      repo.write('package-lock.json', lockV3(keep, { lodash: '4.17.20' }));
      return { status: 0 };
    };
    await addItem(loaded.top, item);
    assert.equal(realpathSync.native(removed), realpathSync.native(repo.dir));
    const pkg = JSON.parse(repo.read('package.json'));
    assert.equal(pkg.dependencies.leftpad, undefined);
    const lock = JSON.parse(repo.read('package-lock.json'));
    assert.equal(lock.packages['node_modules/leftpad'], undefined);
  } finally {
    repo.cleanup();
  }
});

test('session add applies a proposed outdated update', async () => {
  const repo = makeRepo();
  try {
    const oldDeps = { lodash: '^4.17.20' };
    repo.write('package.json', pkgJson(oldDeps));
    repo.write('package-lock.json', lockV3(oldDeps, { lodash: '4.17.20' }));
    repo.git(['add', '.']);
    repo.git(['commit', '-m', 'init']);
    const outdatedMap = lodashOutdated();
    const stdout = sink();
    const session = new Session({
      repo: git.createGitRepo(),
      cwd: repo.dir,
      stdout,
      color: false,
      startPane: 'diff',
      audit: true,
      outdatedMap,
      auditMap: null,
    });
    await session.load();
    const item = depByName(session.items, 'lodash');
    assert.ok(item);
    item.dep.install = () => {
      const next = { lodash: '^4.17.21' };
      repo.write('package-lock.json', lockV3(next, { lodash: '4.17.21' }));
      return { status: 0 };
    };
    session.dispatch('add');
    await session.ops.idle();
    assert.equal(session.status, 'staged');
    const pkg = JSON.parse(repo.read('package.json'));
    assert.equal(pkg.dependencies.lodash, '^4.17.21');
    const staged = depByName(session.items, 'lodash');
    assert.ok(staged);
    assert.equal(staged.origin, 'staged');
    assert.equal(staged.dep.change.propose, undefined);
  } finally {
    repo.cleanup();
  }
});

test('session revert dismisses a proposed outdated update', async () => {
  const repo = makeRepo();
  try {
    repo.write('package.json', pkgJson({ lodash: '^4.17.20' }));
    repo.git(['add', '.']);
    repo.git(['commit', '-m', 'init']);
    const outdatedMap = lodashOutdated();
    const stdout = sink();
    const session = new Session({
      repo: git.createGitRepo(),
      cwd: repo.dir,
      stdout,
      color: false,
      startPane: 'diff',
      audit: true,
      outdatedMap,
      auditMap: null,
    });
    await session.load();
    assert.ok(depByName(session.items, 'lodash'));
    session.dispatch('revert');
    await session.ops.idle();
    assert.equal(repo.read('package.json'), pkgJson({ lodash: '^4.17.20' }));
    assert.equal(depByName(session.items, 'lodash'), null);
  } finally {
    repo.cleanup();
  }
});

test('proposedNpmPlan does not write the manifest', async () => {
  const repo = makeRepo();
  try {
    const { loaded, item, pkg } = await proposedLodash(repo);
    const plan = proposedNpmPlan(loaded.top, item);
    assert.ok(plan);
    assert.deepEqual(plan.npmArgs, ['i']);
    assert.equal(plan.prepareManifest, true);
    assert.equal(repo.read('package.json'), pkg);
  } finally {
    repo.cleanup();
  }
});

test('git staging failure restores owned dependency files', async () => {
  const repo = makeRepo();
  try {
    const { loaded, item, pkg, lock } = await proposedLodash(repo);
    await assert.rejects(
      () =>
        gitDeps.applyProposedUpdate(loaded.top, item, {
          run: () => {
            const next = { lodash: '^4.17.21' };
            repo.write(
              'package-lock.json',
              lockV3(next, { lodash: '4.17.21' }),
            );
            return { status: 0 };
          },
          stage: () => {
            throw new Error('add failed');
          },
        }),
      /add failed/,
    );
    assert.equal(repo.read('package.json'), pkg);
    assert.equal(repo.read('package-lock.json'), lock);
  } finally {
    repo.cleanup();
  }
});

test('captureFile distinguishes a missing file from an empty file', () => {
  const repo = makeRepo();
  try {
    const missing = gitDeps.captureFile(repo.dir, 'gone.txt');
    assert.equal(missing.existed, false);
    assert.equal(missing.text, '');
    repo.write('empty.txt', '');
    const empty = gitDeps.captureFile(repo.dir, 'empty.txt');
    assert.equal(empty.existed, true);
    assert.equal(empty.text, '');
    repo.write('empty.txt', 'changed\n');
    gitDeps.restoreFile(repo.dir, empty);
    assert.equal(repo.read('empty.txt'), '');
    repo.write('gone.txt', 'created\n');
    gitDeps.restoreFile(repo.dir, missing);
    assert.equal(repo.exists('gone.txt'), false);
  } finally {
    repo.cleanup();
  }
});

test('load keeps description and keywords as normal diffs', async () => {
  const repo = makeRepo();
  try {
    const oldDeps = { lodash: '^4.17.20' };
    const newDeps = { lodash: '^4.17.21' };
    const oldExtra = { description: 'old', keywords: ['cli'] };
    const newExtra = { description: 'new', keywords: ['tui'] };
    repo.write('package.json', pkgJson(oldDeps, oldExtra));
    repo.write('package-lock.json', lockV3(oldDeps, { lodash: '4.17.20' }));
    repo.git(['add', '.']);
    repo.git(['commit', '-m', 'init']);
    repo.write('package.json', pkgJson(newDeps, newExtra));
    repo.write('package-lock.json', lockV3(newDeps, { lodash: '4.17.21' }));
    const loaded = await load(repo.dir, [], { deferExtras: false });
    const depItems = loaded.items.filter((item) => item.dep);
    const jsonItems = [];
    for (const item of loaded.items) {
      if (item.dep) continue;
      if (item.file.newPath !== 'package.json') continue;
      jsonItems.push(item);
    }
    assert.equal(depItems.length, 1);
    assert.equal(depItems[0].dep.change.name, 'lodash');
    assert.ok(jsonItems.length >= 1);
    const texts = [];
    for (const item of jsonItems) {
      for (const line of hunkTexts(item)) texts.push(line);
    }
    assert.ok(texts.some((line) => line.includes('description')));
    const hasKeywords = texts.some((line) => line.includes('tui'));
    assert.ok(hasKeywords);
  } finally {
    repo.cleanup();
  }
});

test('load keeps one dep hunk when other fields change', async () => {
  const repo = makeRepo();
  try {
    const pad = {
      description: 'x'.repeat(80),
      keywords: ['cli'],
      license: 'MIT',
    };
    const oldDeps = { eslint: '^9.0.0', prettier: '^3.9.7' };
    const newDeps = { eslint: '^9.0.0', prettier: '^3.9.8' };
    const oldVers = { eslint: '9.0.0', prettier: '3.9.7' };
    const newVers = { eslint: '9.0.0', prettier: '3.9.8' };
    repo.write('package.json', pkgJson(oldDeps, { version: '0.1.8', ...pad }));
    repo.write('package-lock.json', lockV3(oldDeps, oldVers));
    repo.git(['add', '.']);
    repo.git(['commit', '-m', 'init']);
    repo.write('package.json', pkgJson(newDeps, { version: '0.1.9', ...pad }));
    repo.write('package-lock.json', lockV3(newDeps, newVers));
    const loaded = await load(repo.dir, [], { deferExtras: false });
    const prettier = depByName(loaded.items, 'prettier');
    assert.ok(prettier);
    const jsonItems = loaded.items.filter((item) => {
      if (item.dep) return false;
      return item.file.newPath === 'package.json';
    });
    const pkgItems = loaded.items.filter(
      (item) => item.file.newPath === 'package.json',
    );
    assert.ok(pkgItems.length >= 2);
    assert.equal(pkgItems[0].dep, undefined);
    assert.equal(pkgItems.at(-1), prettier);
    const texts = [];
    for (const item of jsonItems) {
      for (const line of hunkTexts(item)) texts.push(line);
    }
    assert.ok(texts.some((line) => line.includes('version')));
    assert.ok(!texts.some((line) => line.includes('prettier')));
  } finally {
    repo.cleanup();
  }
});

test('add unstage and revert apply to both dependency files', async () => {
  const repo = makeRepo();
  try {
    const oldDeps = { lodash: '^4.17.20' };
    const newDeps = { lodash: '^4.17.21' };
    repo.write('package.json', pkgJson(oldDeps));
    repo.write('package-lock.json', lockV3(oldDeps, { lodash: '4.17.20' }));
    repo.git(['add', '.']);
    repo.git(['commit', '-m', 'init']);
    repo.write('package.json', pkgJson(newDeps));
    repo.write('package-lock.json', lockV3(newDeps, { lodash: '4.17.21' }));
    const loaded = await load(repo.dir, [], { deferExtras: false });
    const item = loaded.items[0];
    assert.ok(item.dep);
    await addItem(loaded.top, item);
    const cached = repo.git(['diff', '--cached', '--name-only']);
    assert.match(cached, /package\.json/);
    assert.match(cached, /package-lock\.json/);
    assert.equal(repo.git(['diff', '--name-only']), '');
    item.origin = 'staged';
    await unstageItem(loaded.top, item);
    assert.equal(repo.git(['diff', '--cached', '--name-only']), '');
    assert.match(repo.git(['diff', '--name-only']), /package\.json/);
    await revertItem(loaded.top, item);
    assert.equal(repo.read('package.json'), pkgJson(oldDeps));
    assert.equal(
      repo.read('package-lock.json'),
      lockV3(oldDeps, { lodash: '4.17.20' }),
    );
  } finally {
    repo.cleanup();
  }
});

test('staging a package.json diff installs its lockfile', async () => {
  const repo = makeRepo();
  try {
    const dependencies = { lodash: '^4.17.20' };
    repo.write('package.json', pkgJson(dependencies, { version: '0.1.0' }));
    repo.write(
      'package-lock.json',
      lockV3(dependencies, { lodash: '4.17.20' }),
    );
    repo.git(['add', '.']);
    repo.git(['commit', '-m', 'init']);
    repo.write('package.json', pkgJson(dependencies, { version: '0.1.1' }));
    const loaded = await load(repo.dir, [], { deferExtras: false });
    const item = loaded.items.find((entry) => !entry.dep);
    assert.ok(item);
    let installed = '';
    await addItem(loaded.top, item, {
      run: (cwd, args) => {
        installed = `${cwd}\0${args.join(' ')}`;
        repo.write(
          'package-lock.json',
          lockV3(dependencies, { lodash: '4.17.21' }),
        );
        return { status: 0 };
      },
    });
    const parts = installed.split('\0');
    const cwd = parts[0];
    const args = parts[1];
    assert.equal(realpathSync.native(cwd), realpathSync.native(repo.dir));
    assert.equal(args, 'i');
    assert.equal(
      parseGitJson(repo, ':package-lock.json').packages['node_modules/lodash']
        .version,
      '4.17.21',
    );
    assert.match(
      repo.git(['diff', '--cached', '--name-only']),
      /package\.json/,
    );
    assert.match(
      repo.git(['diff', '--cached', '--name-only']),
      /package-lock\.json/,
    );
  } finally {
    repo.cleanup();
  }
});

test('staging a package.json path installs its lockfile', async () => {
  const repo = makeRepo();
  try {
    const dependencies = { lodash: '^4.17.20' };
    repo.write('package.json', pkgJson(dependencies, { version: '0.1.0' }));
    repo.git(['add', '.']);
    repo.git(['commit', '-m', 'init']);
    repo.write('package.json', pkgJson(dependencies, { version: '0.1.1' }));
    let installed = '';
    await stagePath(repo.dir, 'package.json', {
      run: (cwd, args) => {
        installed = `${cwd}\0${args.join(' ')}`;
        repo.write(
          'package-lock.json',
          lockV3(dependencies, { lodash: '4.17.21' }),
        );
        return { status: 0 };
      },
    });
    const parts = installed.split('\0');
    const cwd = parts[0];
    const args = parts[1];
    assert.equal(realpathSync.native(cwd), realpathSync.native(repo.dir));
    assert.equal(args, 'i');
    assert.match(
      repo.git(['diff', '--cached', '--name-only']),
      /package\.json/,
    );
    assert.match(
      repo.git(['diff', '--cached', '--name-only']),
      /package-lock\.json/,
    );
  } finally {
    repo.cleanup();
  }
});

test('add applies one dependency and leaves the other unstaged', async () => {
  const repo = makeRepo();
  try {
    const oldDeps = { lodash: '^4.17.20' };
    const newDeps = { lodash: '^4.17.21', leftpad: '1.0.0' };
    const newVers = { lodash: '4.17.21', leftpad: '1.0.0' };
    repo.write('package.json', pkgJson(oldDeps));
    repo.write('package-lock.json', lockV3(oldDeps, { lodash: '4.17.20' }));
    repo.git(['add', '.']);
    repo.git(['commit', '-m', 'init']);
    repo.write('package.json', pkgJson(newDeps));
    repo.write('package-lock.json', lockV3(newDeps, newVers));
    const loaded = await load(repo.dir, [], { deferExtras: false });
    const lodash = depByName(loaded.items, 'lodash');
    const leftpad = depByName(loaded.items, 'leftpad');
    assert.ok(lodash);
    assert.ok(leftpad);
    await addItem(loaded.top, lodash);
    const indexPkg = parseGitJson(repo, ':package.json');
    assert.equal(indexPkg.dependencies.lodash, '^4.17.21');
    assert.equal(indexPkg.dependencies.leftpad, undefined);
    const workPkg = JSON.parse(repo.read('package.json'));
    assert.equal(workPkg.dependencies.lodash, '^4.17.21');
    assert.equal(workPkg.dependencies.leftpad, '1.0.0');
    const indexLock = parseGitJson(repo, ':package-lock.json');
    const indexPkgs = indexLock.packages;
    assert.equal(indexPkgs['node_modules/lodash'].version, '4.17.21');
    assert.equal(indexPkgs['node_modules/leftpad'], undefined);
    const workLock = JSON.parse(repo.read('package-lock.json'));
    assert.equal(workLock.packages['node_modules/leftpad'].version, '1.0.0');
  } finally {
    repo.cleanup();
  }
});

test('revert applies one dependency and leaves the other', async () => {
  const repo = makeRepo();
  try {
    const oldDeps = { lodash: '^4.17.20' };
    const newDeps = { lodash: '^4.17.21', leftpad: '1.0.0' };
    const newVers = { lodash: '4.17.21', leftpad: '1.0.0' };
    repo.write('package.json', pkgJson(oldDeps));
    repo.write('package-lock.json', lockV3(oldDeps, { lodash: '4.17.20' }));
    repo.git(['add', '.']);
    repo.git(['commit', '-m', 'init']);
    repo.write('package.json', pkgJson(newDeps));
    repo.write('package-lock.json', lockV3(newDeps, newVers));
    const loaded = await load(repo.dir, [], { deferExtras: false });
    const lodash = depByName(loaded.items, 'lodash');
    await revertItem(loaded.top, lodash);
    const workPkg = JSON.parse(repo.read('package.json'));
    assert.equal(workPkg.dependencies.lodash, '^4.17.20');
    assert.equal(workPkg.dependencies.leftpad, '1.0.0');
    const workLock = JSON.parse(repo.read('package-lock.json'));
    const workPkgs = workLock.packages;
    assert.equal(workPkgs['node_modules/lodash'].version, '4.17.20');
    assert.equal(workPkgs['node_modules/leftpad'].version, '1.0.0');
    assert.equal(workPkgs[''].dependencies.lodash, '^4.17.20');
    assert.equal(workPkgs[''].dependencies.leftpad, '1.0.0');
  } finally {
    repo.cleanup();
  }
});

test('session a u r act on one dependency', async () => {
  const repo = makeRepo();
  try {
    const oldDeps = { lodash: '^4.17.20' };
    const newDeps = { lodash: '^4.17.21' };
    repo.write('package.json', pkgJson(oldDeps));
    repo.write('package-lock.json', lockV3(oldDeps, { lodash: '4.17.20' }));
    repo.git(['add', '.']);
    repo.git(['commit', '-m', 'init']);
    repo.write('package.json', pkgJson(newDeps));
    repo.write('package-lock.json', lockV3(newDeps, { lodash: '4.17.21' }));
    const session = await sessionFor(repo.dir);
    assert.equal(session.items.length, 1);
    assert.ok(session.items[0].dep);
    session.dispatch('add');
    await session.ops.idle();
    assert.equal(session.status, 'staged');
    const cached = repo.git(['diff', '--cached', '--name-only']);
    assert.match(cached, /package\.json/);
    session.dispatch('unstage');
    await session.ops.idle();
    assert.equal(session.status, 'unstaged');
    assert.equal(repo.git(['diff', '--cached']), '');
    session.dispatch('revert');
    await session.ops.idle();
    assert.equal(repo.read('package.json'), pkgJson(oldDeps));
    assert.equal(
      repo.read('package-lock.json'),
      lockV3(oldDeps, { lodash: '4.17.20' }),
    );
  } finally {
    repo.cleanup();
  }
});

test('session add stages only the current dependency', async () => {
  const repo = makeRepo();
  try {
    const oldDeps = { lodash: '^4.17.20' };
    const newDeps = { lodash: '^4.17.21', leftpad: '1.0.0' };
    const newVers = { lodash: '4.17.21', leftpad: '1.0.0' };
    repo.write('package.json', pkgJson(oldDeps));
    repo.write('package-lock.json', lockV3(oldDeps, { lodash: '4.17.20' }));
    repo.git(['add', '.']);
    repo.git(['commit', '-m', 'init']);
    repo.write('package.json', pkgJson(newDeps));
    repo.write('package-lock.json', lockV3(newDeps, newVers));
    const session = await sessionFor(repo.dir);
    assert.equal(session.items.length, 2);
    assert.equal(session.items[0].dep.change.name, 'leftpad');
    session.dispatch('add');
    await session.ops.idle();
    assert.equal(session.status, 'staged');
    const indexPkg = parseGitJson(repo, ':package.json');
    assert.equal(indexPkg.dependencies.leftpad, '1.0.0');
    assert.equal(indexPkg.dependencies.lodash, '^4.17.20');
    assert.equal(session.items[1].origin, 'unstaged');
    const workPkg = JSON.parse(repo.read('package.json'));
    assert.equal(workPkg.dependencies.lodash, '^4.17.21');
  } finally {
    repo.cleanup();
  }
});

test('files pane revert restores both dependency files', async () => {
  const repo = makeRepo();
  try {
    const oldDeps = { lodash: '^4.17.20' };
    const newDeps = { lodash: '^4.17.21' };
    repo.write('keep.js', 'ok\n');
    repo.write('package.json', pkgJson(oldDeps));
    repo.write('package-lock.json', lockV3(oldDeps, { lodash: '4.17.20' }));
    repo.git(['add', '.']);
    repo.git(['commit', '-m', 'init']);
    repo.write('keep.js', 'OK\n');
    repo.write('package.json', pkgJson(newDeps));
    repo.write('package-lock.json', lockV3(newDeps, { lodash: '4.17.21' }));
    const session = await sessionFor(repo.dir);
    session.showFiles();
    const files = session.fileList();
    const dep = files.find((entry) => entry.path === 'package.json');
    assert.ok(dep);
    session.fileCursor = files.indexOf(dep);
    session.dispatch('revert');
    await session.ops.idle();
    assert.equal(repo.read('package.json'), pkgJson(oldDeps));
    assert.equal(
      repo.read('package-lock.json'),
      lockV3(oldDeps, { lodash: '4.17.20' }),
    );
    assert.equal(repo.read('keep.js'), 'OK\n');
  } finally {
    repo.cleanup();
  }
});

test('render shows a readable dependency summary', () => {
  const oldDeps = { lodash: '^4.17.20' };
  const newDeps = { lodash: '^4.17.21' };
  const items = [dummyItem('package.json'), dummyItem('package-lock.json')];
  const folded = foldDepItems(
    items,
    sidesOf({
      'package.json': {
        oldText: pkgJson(oldDeps),
        newText: pkgJson(newDeps),
      },
      'package-lock.json': {
        oldText: lockV3(oldDeps, { lodash: '4.17.20' }),
        newText: lockV3(newDeps, { lodash: '4.17.21' }),
      },
    }),
  );
  const item = folded[0];
  const frame = render.renderFrame(
    {
      item,
      index: 0,
      total: 1,
      scroll: 0,
      status: '',
      counts: { staged: 0, unstaged: 1, untracked: 0 },
    },
    { width: 80, height: 16, color: false },
  );
  const text = stripAnsi(frame.text);
  assert.match(text, /Dependencies in package\.json & package-lock\.json/);
  assert.match(text, /dependency version changed/);
  assert.match(text, /lodash/);
  assert.doesNotMatch(text, /node_modules/);
});

test('render paints npm audit notes grey with separators', () => {
  const title =
    'brace-expansion: DoS via exponential-time expansion of ' +
    'consecutive non-expanding groups';
  const second = 'brace-expansion: DoS via unbounded expansion length';
  const audit = new Map();
  audit.set('brace-expansion', {
    severity: 'high',
    title,
    titles: [title, second],
    range: '<=1.1.17',
  });
  const pkg = pkgJson({ eslint: '^9.39.5' });
  const lockText = lockV3(
    { eslint: '^9.39.5' },
    { eslint: '9.39.5', 'brace-expansion': '1.1.15' },
  );
  const proposed = proposeDepItems(pkg, null, audit, { lockText });
  const item = proposed[0];
  const frame = render.renderFrame(
    {
      item,
      index: 0,
      total: 1,
      scroll: 0,
      status: '',
      counts: { staged: 0, unstaged: 1, untracked: 0 },
    },
    { width: 42, height: 24, color: true },
  );
  const text = stripAnsi(frame.text);
  assert.match(text, /lockfile vulnerable/);
  assert.match(text, /exponential-time/);
  assert.match(text, /unbounded expansion/);
  assert.doesNotMatch(text, /brace-expansion: brace-expansion:/);
  assert.match(text, /─/);
  const red = bg(THEME.delLineBg);
  const grey = bg(THEME.noteBg);
  const heading = frame.rows.some((row) => {
    if (!row.includes(red)) return false;
    return stripAnsi(row).includes('lockfile vulnerable');
  });
  const note = frame.rows.some((row) => {
    if (!row.includes(grey)) return false;
    return stripAnsi(row).includes('npm audit');
  });
  assert.ok(heading);
  assert.ok(note);
});

test('lockPackageCount ignores the root package entry', () => {
  const lock = {
    packages: {
      '': { dependencies: { lodash: '^4.17.21' } },
      'node_modules/lodash': { version: '4.17.21' },
    },
  };
  assert.equal(lockPackageCount(lock), 1);
});

test('partial dependency staging leaves the worktree untouched', async (t) => {
  const repo = dependencyStagingRepo(t);
  const before = dependencyFiles(repo);
  const item = depByName(
    (await load(repo.dir, [], { deferExtras: false })).items,
    'lodash',
  );
  await addItem(repo.dir, item);
  assert.deepEqual(dependencyFiles(repo), before);
  const staged = (await load(repo.dir, [], { deferExtras: false })).items.find(
    (entry) => entry.origin === 'staged' && entry.dep?.change.name === 'lodash',
  );
  await unstageItem(repo.dir, staged);
  assert.deepEqual(dependencyFiles(repo), before);
  assert.equal(repo.git(['diff', '--cached']), '');
});

test('failed dependency staging preserves worktree and index', async (t) => {
  const repo = dependencyStagingRepo(t);
  const before = dependencyFiles(repo);
  const item = depByName(
    (await load(repo.dir, [], { deferExtras: false })).items,
    'lodash',
  );
  repo.write('.git/index.lock', 'locked');
  await assert.rejects(() => addItem(repo.dir, item), /index.lock/);
  assert.deepEqual(dependencyFiles(repo), before);
  assert.equal(repo.git(['diff', '--cached']), '');
});

test('partial staging adds new dependency files to empty index', async (t) => {
  const repo = makeRepo();
  t.after(repo.cleanup);
  repo.write('package.json', pkgJson({ lodash: '^4.17.21' }));
  const before = repo.read('package.json');
  const item = depByName(
    (await load(repo.dir, [], { deferExtras: false })).items,
    'lodash',
  );
  assert.ok(item);
  await addItem(repo.dir, item);
  assert.equal(repo.read('package.json'), before);
  const indexed = parseGitJson(repo, ':package.json');
  assert.equal(indexed.dependencies.lodash, '^4.17.21');
});

test('dependency staging respects clean filters, edits no files', async (t) => {
  const repo = dependencyStagingRepo(t);
  const filter = path.join(repo.dir, 'clean.cjs');
  const script = `
    const fs = require('node:fs');
    const text = fs.readFileSync(0, 'utf8');
    process.stdout.write(text.replace('demo', 'clean'));
  `;
  repo.write('clean.cjs', script);
  const command = [process.execPath, filter]
    .map((value) => JSON.stringify(value))
    .join(' ');
  repo.git(['config', 'filter.dependency.clean', command]);
  repo.write('.gitattributes', 'package.json filter=dependency\n');
  const before = dependencyFiles(repo);
  const item = depByName(
    (await load(repo.dir, [], { deferExtras: false })).items,
    'lodash',
  );
  await addItem(repo.dir, item);
  assert.equal(parseGitJson(repo, ':package.json').name, 'clean');
  assert.deepEqual(dependencyFiles(repo), before);
});

test('a proposed update installs outside the write lock', async () => {
  const repo = makeRepo();
  try {
    const { loaded, item } = await proposedLodash(repo);
    const seen = [];
    let held = false;
    const locked = async (write) => {
      held = true;
      seen.push('lock');
      try {
        return await write();
      } finally {
        held = false;
        seen.push('unlock');
      }
    };
    const run = async () => {
      seen.push(`install held=${held}`);
      return { status: 0 };
    };
    const stage = async () => {
      seen.push(`stage held=${held}`);
    };
    await gitDeps.applyProposedUpdate(loaded.top, item, { run, stage, locked });
    const expected = [
      'install held=false',
      'lock',
      'stage held=true',
      'unlock',
    ];
    assert.deepEqual(seen.slice(-4), expected);
  } finally {
    repo.cleanup();
  }
});

test('a directory without package files does not ask npm', async () => {
  const repo = makeRepo();
  try {
    assert.equal(await gitDeps.collectReport(repo.dir, 'audit'), null);
    assert.equal(await gitDeps.collectReport(repo.dir, 'outdated'), null);
  } finally {
    repo.cleanup();
  }
});
