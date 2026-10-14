'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { MANIFEST, LOCKFILE } = require('../deps/deps.js');
const { collectReport } = require('../git/deps.js');

const REPORT_TTL_MS = 10 * 60 * 1000;
const MODULES_LOCK = path.join('node_modules', '.package-lock.json');

const answers = new Map();

const hashOf = (file) => {
  try {
    const bytes = fs.readFileSync(file);
    return crypto.createHash('sha1').update(bytes).digest('hex');
  } catch {
    return '';
  }
};

const stampOf = (file) => {
  try {
    const stat = fs.statSync(file);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return '';
  }
};

// `npm audit` reads the lockfile only, so equal lockfiles have equal answers
// in every worktree of a repository
const auditKey = (dir) => {
  const hash = hashOf(path.join(dir, LOCKFILE));
  return hash ? `audit:${hash}` : '';
};

// `npm outdated` reads what is installed, so it is kept for the directory
const outdatedKey = (dir) => {
  const files = [MANIFEST, LOCKFILE, MODULES_LOCK];
  const stamps = files.map((file) => stampOf(path.join(dir, file)));
  return `outdated:${path.resolve(dir)}:${stamps.join(':')}`;
};

// The answer is asked of npm once while the files stay as they are, however
// many times the tiles are read: npm goes to the network
const remembered = (key, collect, now = Date.now()) => {
  if (!key) return collect();
  const hit = answers.get(key);
  if (hit && now - hit.at < REPORT_TTL_MS) return hit.promise;
  const promise = collect();
  answers.set(key, { at: now, promise });
  promise.catch(() => answers.delete(key));
  return promise;
};

const sizeOf = async (collect, dir, kind) => {
  const report = await collect(dir, kind);
  return report ? report.size : 0;
};

const reportCounts = async (dir, collect = collectReport) => {
  const [audit, outdated] = await Promise.all([
    remembered(auditKey(dir), () => sizeOf(collect, dir, 'audit')),
    remembered(outdatedKey(dir), () => sizeOf(collect, dir, 'outdated')),
  ]);
  return { audit, outdated };
};

const forgetReports = () => answers.clear();

module.exports = {
  auditKey,
  outdatedKey,
  remembered,
  reportCounts,
  forgetReports,
};
