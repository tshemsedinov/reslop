'use strict';

const path = require('node:path');

const { npmBin, npmOpts } = require('../sys.js');
const { depFileMeta, LOCKFILE } = require('../deps.js');
const proc = require('../git/proc.js');
const { runProc, runProcSync } = proc;

const AUDIT_MS = 15000;
const INSTALL_MS = 120000;

const npmProcOptions = (cwd, extra = {}) => ({
  cwd,
  encoding: proc.DEFAULT_ENCODING,
  maxBuffer: proc.DEFAULT_MAX_BUFFER,
  timeout: extra.timeout,
  signal: extra.signal,
  shell: npmOpts().shell,
});

const runNpm = (cwd, args) =>
  runProcSync(npmBin(), args, npmProcOptions(cwd, { timeout: INSTALL_MS }));

const runNpmAsync = (cwd, args, extra = {}) =>
  runProc(
    npmBin(),
    args,
    npmProcOptions(cwd, { timeout: INSTALL_MS, signal: extra.signal }),
  );

const runNpmJson = (top, args, timeout) => {
  const result = runProcSync(npmBin(), args, npmProcOptions(top, { timeout }));
  if (result.error) return '';
  return result.stdout || '';
};

const runNpmJsonAsync = async (top, args, timeout, signal) => {
  const result = await runProc(
    npmBin(),
    args,
    npmProcOptions(top, { timeout, signal }),
  );
  if (result.error) return '';
  return result.stdout || '';
};

const depChange = (item) => item.dep?.change ?? null;

const depPaths = (item) => item.dep?.files ?? [];

const firstDepRel = (files, kind) => {
  for (const rel of files) {
    const meta = depFileMeta(rel);
    if (meta && meta.kind === kind) return rel;
  }
  return '';
};

const proposedNpmPlan = (top, item) => {
  const change = depChange(item);
  if (!change) return null;
  const files = depPaths(item);
  const lockOnly = change.section === 'resolved';
  const removing = !!change.unused;
  const manifest = firstDepRel(files, 'manifest');
  const lockRel = firstDepRel(files, 'lockfile');
  const picked = lockOnly ? lockRel : manifest;
  const target = picked || files[0] || '';
  const meta = depFileMeta(target);
  if (!meta) return null;
  const cwd = meta.dir === '.' ? top : path.join(top, meta.dir);
  let npmArgs = ['i'];
  if (removing) npmArgs = ['uninstall', change.name];
  else if (lockOnly) npmArgs = ['audit', 'fix'];
  const fail = removing ? 'npm uninstall failed' : 'npm i failed';
  const dirLock = meta.dir === '.' ? LOCKFILE : `${meta.dir}/${LOCKFILE}`;
  const lockPath = lockRel || dirLock;
  const prepareManifest = !lockOnly && !removing && !!manifest;
  return {
    cwd,
    npmArgs,
    fail,
    lockOnly,
    lockPath,
    manifest,
    prepareManifest,
    runner: item.dep.install,
  };
};

module.exports = {
  AUDIT_MS,
  INSTALL_MS,
  runNpm,
  runNpmAsync,
  runNpmJson,
  runNpmJsonAsync,
  proposedNpmPlan,
};
