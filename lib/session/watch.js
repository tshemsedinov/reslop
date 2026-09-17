'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEBOUNCE_MS = 200;
const POLL_MS = 250;

const SKIP_DIRS = ['node_modules', '.review', 'coverage', 'dist', '.cache'];

const GIT_WATCH_NAMES = [
  'HEAD',
  'index',
  'packed-refs',
  'FETCH_HEAD',
  'ORIG_HEAD',
  'refs',
];

const linuxRecursiveNode = (version) => {
  const parts = `${version}`.split('.');
  const major = Number(parts[0]);
  const minor = Number(parts[1]);
  if (major > 19) return true;
  return major === 19 && minor >= 1;
};

const canWatchRecursive = (
  platform = process.platform,
  version = process.versions.node,
) => {
  if (platform === 'win32' || platform === 'darwin') return true;
  if (platform === 'linux') return linuxRecursiveNode(version);
  return false;
};

const ignoredName = (name) => {
  if (!name) return false;
  if (name.endsWith('.lock')) return true;
  if (name.endsWith('~')) return true;
  if (name.endsWith('.swp') || name.endsWith('.swo')) return true;
  if (name.startsWith('.#')) return true;
  if (name === '.DS_Store') return true;
  return false;
};

const ignoredGitRel = (parts) => {
  const name = parts[1] ?? '';
  if (!name) return false;
  if (GIT_WATCH_NAMES.includes(name)) return false;
  return true;
};

const ignoredRel = (rel) => {
  const norm = `${rel}`.replaceAll('\\', '/');
  if (!norm || norm === '.') return false;
  const parts = norm.split('/');
  for (const part of parts) {
    if (SKIP_DIRS.includes(part)) return true;
  }
  if (parts[0] === '.git') return ignoredGitRel(parts);
  return ignoredName(parts[parts.length - 1]);
};

const skipDirName = (name) => name === '.git' || SKIP_DIRS.includes(name);

const closeWatcher = (watcher) => {
  try {
    watcher.close();
  } catch {
    // already closed
  }
};

const schedule = (state) => {
  if (state.closed) return;
  if (state.timer !== null) state.clearTimeoutFn(state.timer);
  state.timer = state.setTimeoutFn(() => {
    state.timer = null;
    if (state.closed) return;
    state.onChange();
  }, state.debounceMs);
};

const handleWatchEvent = (state, dir, eventType, filename) => {
  if (state.closed) return;
  const name = filename ? `${filename}` : '';
  const rel = name ? path.relative(state.root, path.join(dir, name)) : '';
  if (rel && ignoredRel(rel)) return;
  if (eventType === 'rename' && name) {
    state.watchNewDir(path.join(dir, name));
  }
  schedule(state);
};

const watchOne = (state, target, extra = {}) => {
  if (state.closed) return;
  if (state.watched.has(target)) return;
  try {
    const onEvent = (eventType, filename) => {
      handleWatchEvent(state, target, eventType, filename);
    };
    const watcher = state.watchFn(
      target,
      { persistent: true, encoding: 'utf8', ...extra },
      onEvent,
    );
    if (typeof watcher.on === 'function') {
      watcher.on('error', () => {});
    }
    state.watched.add(target);
    state.watchers.push(watcher);
  } catch {
    // missing path or too many watchers
  }
};

const watchTree = (state, dir) => {
  watchOne(state, dir, state.dirWatchOpts);
  if (state.recursive) return;
  let entries;
  try {
    entries = state.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (skipDirName(entry.name)) continue;
    watchTree(state, path.join(dir, entry.name));
  }
};

const maybeWatchNewDir = (state, full) => {
  if (state.recursive) return;
  let stat;
  try {
    stat = state.statSync(full);
  } catch {
    return;
  }
  if (!stat.isDirectory()) return;
  if (skipDirName(path.basename(full))) return;
  watchTree(state, full);
};

const watchScope = (state, spec) => {
  const target = path.resolve(state.root, spec);
  let stat;
  try {
    stat = state.statSync(target);
  } catch {
    watchOne(state, path.dirname(target));
    return;
  }
  if (stat.isDirectory()) {
    watchTree(state, target);
    return;
  }
  watchOne(state, path.dirname(target));
};

const watchGit = (state) => {
  const gitDir = path.resolve(state.root, '.git');
  watchOne(state, gitDir);
  watchOne(state, path.resolve(gitDir, 'refs'));
};

const stopState = (state) => {
  state.closed = true;
  if (state.timer !== null) state.clearTimeoutFn(state.timer);
  state.timer = null;
  while (state.watchers.length) closeWatcher(state.watchers.pop());
  state.watched.clear();
};

const watchFiles = (state, rels) => {
  for (const rel of rels) {
    if (!rel) continue;
    const full = path.resolve(state.root, rel);
    watchOne(state, path.dirname(full));
  }
};

const createDiskWatcher = (options) => {
  const recursive = options.recursive ?? canWatchRecursive();
  const state = {
    root: path.resolve(options.root),
    watchFn: options.watch ?? fs.watch,
    readdirSync: options.readdirSync ?? fs.readdirSync,
    statSync: options.statSync ?? fs.statSync,
    setTimeoutFn: options.setTimeout ?? setTimeout,
    clearTimeoutFn: options.clearTimeout ?? clearTimeout,
    debounceMs: options.debounceMs ?? DEBOUNCE_MS,
    onChange: options.onChange,
    recursive,
    dirWatchOpts: recursive ? { recursive: true } : {},
    watchers: [],
    watched: new Set(),
    timer: null,
    closed: false,
    watchNewDir: (full) => maybeWatchNewDir(state, full),
  };
  const scopes = options.paths && options.paths.length ? options.paths : ['.'];
  for (const spec of scopes) watchScope(state, spec);
  watchGit(state);
  return {
    close: () => stopState(state),
    watchFiles: (rels) => watchFiles(state, rels),
  };
};

module.exports = {
  DEBOUNCE_MS,
  POLL_MS,
  canWatchRecursive,
  ignoredRel,
  createDiskWatcher,
};
