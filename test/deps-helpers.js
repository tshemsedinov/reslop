'use strict';

const assert = require('node:assert/strict');

const pkgJson = (dependencies, extra = {}) => {
  const body = { name: 'demo', ...extra, dependencies };
  return `${JSON.stringify(body, null, 2)}\n`;
};

const pkgLib = (dependencies, extra = {}) =>
  pkgJson(dependencies, { main: 'index.js', ...extra });

const noExportPkg = (name) => {
  const bin = { [name]: 'cli.js' };
  return `${JSON.stringify({ name, bin }, null, 2)}\n`;
};

const libPkg = (name) => {
  const body = { name, main: 'index.js' };
  return `${JSON.stringify(body, null, 2)}\n`;
};

const lockV3 = (dependencies, versions) => {
  const packages = { '': { dependencies } };
  for (const name of Object.keys(versions)) {
    const version = versions[name];
    packages[`node_modules/${name}`] = { version };
  }
  const body = { lockfileVersion: 3, packages };
  return `${JSON.stringify(body, null, 2)}\n`;
};

const dummyFile = (rel, isNew = false) => {
  const oldPath = rel;
  const newPath = rel;
  const isDeleted = false;
  const isBinary = false;
  const preamble = [];
  const hunks = [];
  return { oldPath, newPath, isNew, isDeleted, isBinary, preamble, hunks };
};

const dummyItem = (rel, origin = 'unstaged', isNew = false) => {
  const file = dummyFile(rel, isNew);
  const lines = [{ type: 'add', text: 'x', noNl: false, blockId: 0 }];
  const oldStart = 1;
  const oldCount = 1;
  const newStart = 1;
  const newCount = 1;
  const header = '@@ -1,1 +1,1 @@';
  const hunk = { oldStart, oldCount, newStart, newCount, header, lines };
  const blockId = 0;
  const patchAdd = '';
  const patchRevert = '';
  return { origin, file, hunk, blockId, patchAdd, patchRevert };
};

const sidesOf = (files) => (origin, rel) => {
  const pair = files[rel];
  if (!pair) return { oldText: '', newText: '' };
  return pair;
};

const hunkTexts = (item) => item.hunk.lines.map((line) => line.text);

const assertBlankAfter = (lines, heading) => {
  const at = lines.indexOf(heading);
  assert.ok(at >= 0, heading);
  assert.equal(lines[at + 1], '');
};

const depByName = (items, name) => {
  for (const item of items) {
    const change = item.dep && item.dep.change;
    if (change && change.name === name) return item;
  }
  return null;
};

// What npm outdated says about lodash ^4.17.20
const lodashOutdated = () =>
  new Map([
    [
      'lodash',
      {
        current: '4.17.20',
        wanted: '4.17.21',
        latest: '4.17.21',
        type: 'dependencies',
      },
    ],
  ]);

module.exports = {
  pkgJson,
  pkgLib,
  noExportPkg,
  libPkg,
  lockV3,
  dummyFile,
  dummyItem,
  sidesOf,
  hunkTexts,
  assertBlankAfter,
  depByName,
  lodashOutdated,
};
