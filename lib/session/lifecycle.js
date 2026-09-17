'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { isAbortError } = require('./load.js');
const { createDiskWatcher, POLL_MS } = require('./watch.js');
const files = require('../files.js');
const { itemPath } = files;
const { MANIFEST, LOCKFILE } = require('../deps/manifest.js');
const review = require('../review.js');
const { hasNotes } = review;

const loadOptions = (api, extra = {}) => {
  const { loadConfig, ui } = api;
  return {
    commit: ui.rev,
    audit: loadConfig.audit,
    outdatedMap: loadConfig.outdatedMap,
    auditMap: loadConfig.auditMap,
    ...extra,
  };
};

const shouldDeferExtras = (api) => {
  const { loadConfig } = api;
  const audit = !!loadConfig.audit;
  const waitingOutdated = loadConfig.outdatedMap === undefined;
  const waitingAudit = loadConfig.auditMap === undefined;
  return audit && (waitingOutdated || waitingAudit);
};

const watchOpts = (api) => api.watch ?? {};

const endReadLoop = (api) => {
  const finish = api.ui.finishReadLoop;
  if (finish) finish();
};

const markLoaded = (api) => {
  api.loader.didLoad = true;
  api.updater.maybePrompt();
};

const isWorktree = (ui) => !ui.rev && !ui.change;

const kindFromExtra = (extra = {}) => {
  if (extra.keepView === true) return 'watch';
  if (extra.keepEmpty === true) return 'keep';
  return 'reload';
};

const shouldResetNav = (kind) => kind !== 'open' && kind !== 'watch';

const finishIfEmpty = (api, kind) => {
  const { collection, review: notes, ui, nav } = api;
  if (collection.items.length) return;
  if (notes.store && hasNotes(notes.store)) return;
  if (kind === 'keep') return;
  if (isWorktree(ui)) {
    if (nav.pane === 'diff') nav.pane = 'files';
    return;
  }
  ui.done = true;
  ui.exitCode = 0;
  ui.status = 'nothing to review';
  ui.emptyReview = kind === 'open';
  endReadLoop(api);
};

const failOpen = (api, error) => {
  if (isAbortError(error)) return;
  const { ui, ops } = api;
  ui.loadError = error;
  ui.done = true;
  ui.exitCode = 1;
  ops.setBusy('');
  ui.stopProgress();
  endReadLoop(api);
};

const restoreAfterLoad = (api, here, wasTodo) => {
  const { collection, nav, ui } = api;
  nav.todoOpen = wasTodo;
  if (here && !wasTodo) {
    const idx = collection.findRestoredIndex(here);
    if (idx >= 0) nav.index = idx;
  }
  ui.clampIndex();
  nav.restoreFileCursor(ui.fileList());
  ui.syncReviewPath();
  ui.syncFileCursor();
};

const itemRels = (collection) => {
  const rels = [];
  for (const item of collection.items) {
    const rel = itemPath(item);
    if (!rel) continue;
    if (rels.includes(rel)) continue;
    rels.push(rel);
  }
  return rels;
};

const syncItemWatches = (api) => {
  if (!api.diskWatcher) return;
  api.diskWatcher.watchFiles(itemRels(api.collection));
};

const applyLoaded = (api, loaded) => {
  const { loader, collection, review: notes, nav, ui } = api;
  if (loaded.generation !== undefined) {
    if (!loader.accept(loaded.generation, ui.done)) return false;
  }
  const wasTodo = nav.todoOpen === true;
  const here = ui.current();
  ui.top = loaded.top ?? api.loadConfig.cwd;
  collection.replace(loaded.items);
  if (loaded.rev) ui.rev = loaded.rev;
  if (loaded.revShort) {
    ui.revShort = loaded.revShort;
  } else if (ui.rev && !ui.revShort) {
    ui.revShort = ui.rev.slice(0, 7);
  }
  if (loaded.sourceLabel) ui.sourceLabel = loaded.sourceLabel;
  if (loaded.change) ui.change = loaded.change;
  if (loaded.branch !== undefined) ui.branch = loaded.branch || '';
  const repository = ui.change ? ui.change.repository : '';
  if (!ui.repoName && repository) ui.repoName = repository;
  if (!notes.store) ui.initReview();
  notes.applyImported(loaded.imported);
  restoreAfterLoad(api, here, wasTodo);
  markLoaded(api);
  loader.pendingExtras = loaded.pending === true;
  syncItemWatches(api);
  return true;
};

const load = (api) => {
  const { loadConfig } = api;
  const loaded = loadConfig.repo.load(
    loadConfig.cwd,
    loadConfig.paths,
    loadOptions(api),
  );
  applyLoaded(api, loaded);
};

const fileStamp = (top, rel, statSync) => {
  const full = path.join(top, rel);
  try {
    const stat = statSync(full);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return 'missing';
  }
};

const npmStamp = (api) => {
  const extra = watchOpts(api);
  const statSync = extra.statSync ?? fs.statSync;
  const top = api.ui.top || api.loadConfig.cwd;
  const pkg = fileStamp(top, MANIFEST, statSync);
  const lock = fileStamp(top, LOCKFILE, statSync);
  return `${pkg}|${lock}`;
};

const cacheNpmExtras = (api, loaded) => {
  api.npmExtras = {
    stamp: npmStamp(api),
    auditMap: loaded.auditMap ?? null,
    outdatedMap: loaded.outdatedMap ?? null,
    usedNames: loaded.usedNames ?? null,
    exportEntries: loaded.exportEntries,
  };
};

const clearNpmExtras = (api) => {
  api.npmExtras = null;
};

const followExtras = async (api, loaded, gen, kind) => {
  const extra = loadOptions(api, {
    paths: api.loadConfig.paths,
    signal: api.loader.signal,
  });
  let next;
  try {
    next = await api.loader.fetchExtras(api.loadConfig.repo, loaded, extra);
  } catch (error) {
    if (!api.loader.isCurrent(gen)) return;
    failOpen(api, error);
    return;
  }
  if (!api.loader.isCurrent(gen)) return;
  if (api.ui.done) {
    api.ops.clearBusy();
    return;
  }
  if (!next) {
    api.ops.clearBusy();
    api.loader.pendingExtras = false;
    api.ui.paint();
    finishIfEmpty(api, kind);
    return;
  }
  applyLoaded(api, api.loader.tag(next, gen));
  cacheNpmExtras(api, next);
  api.ops.clearBusy();
  api.ui.paint();
  finishIfEmpty(api, kind);
};

const npmReuseOpts = (api, extra = {}) => {
  const opts = {};
  if (extra.signal) opts.signal = extra.signal;
  if (extra.keepView !== true) return opts;
  const cached = api.npmExtras;
  if (!cached) return opts;
  if (cached.stamp !== npmStamp(api)) return opts;
  opts.deferExtras = false;
  opts.collect = false;
  opts.auditMap = cached.auditMap;
  opts.outdatedMap = cached.outdatedMap;
  opts.usedNames = cached.usedNames;
  opts.exportEntries = cached.exportEntries;
  return opts;
};

const snapshotOpts = (api, extra = {}) =>
  loadOptions(api, {
    deferExtras: shouldDeferExtras(api),
    ...npmReuseOpts(api, extra),
  });

const resetNavAfterLoad = (api, extra = {}) => {
  api.nav.scroll = 0;
  api.nav.clearSelection();
  if (extra.afterLoad) extra.afterLoad();
};

const afterSnapshot = (api, kind, extra = {}) => {
  if (shouldResetNav(kind)) {
    resetNavAfterLoad(api, extra);
    return;
  }
  if (extra.afterLoad) extra.afterLoad();
};

const beginSnapshot = (api, extra) => {
  if (extra.quiet === true) return;
  api.ui.progressFrame = 0;
  api.ops.setBusy('loading');
  api.ui.paint();
};

const runSnapshot = async (api, gen, kind, extra = {}) => {
  beginSnapshot(api, extra);
  let loaded;
  try {
    loaded = await api.loader.fetchSnapshot(
      api.loadConfig.repo,
      api.loadConfig.cwd,
      api.loadConfig.paths,
      snapshotOpts(api, {
        signal: api.loader.signal,
        keepView: extra.keepView,
      }),
    );
  } catch (error) {
    if (!api.loader.isCurrent(gen)) return;
    failOpen(api, error);
    return;
  }
  if (!api.loader.isCurrent(gen)) return;
  if (api.ui.done) {
    api.ops.clearBusy();
    return;
  }
  applyLoaded(api, api.loader.tag(loaded, gen));
  afterSnapshot(api, kind, extra);
  if (loaded.pending) {
    api.ops.setBusy('checking npm');
    if (kind === 'open' || extra.quiet === true) api.ui.paint();
    await followExtras(api, loaded, gen, kind);
    return;
  }
  api.ops.clearBusy();
  finishIfEmpty(api, kind);
  if (extra.doneStatus && !api.ui.status && !api.ops.busy) {
    api.ui.status = extra.doneStatus;
  }
  api.ui.paint();
};

const openLoad = (api) => {
  const { loader } = api;
  if (loader.promise) return loader.promise;
  if (loader.didLoad && !loader.pendingExtras) {
    loader.promise = Promise.resolve();
    return loader.promise;
  }
  const gen = loader.bump();
  loader.promise = runSnapshot(api, gen, 'open');
  return loader.promise;
};

const loadReady = async (api) => {
  api.ui.ensureRepo();
  await openLoad(api);
  if (api.ui.loadError) throw api.ui.loadError;
};

const refreshFromRepo = (api, extra = {}) => {
  api.loader.promise = null;
  const gen = api.loader.bump();
  const kind = kindFromExtra(extra);
  if (api.ui.uiOpen && api.loadConfig.repo.loadAsync) {
    return void runSnapshot(api, gen, kind, extra);
  }
  const loaded = api.loadConfig.repo.load(
    api.loadConfig.cwd,
    api.loadConfig.paths,
    snapshotOpts(api, extra),
  );
  applyLoaded(api, api.loader.tag(loaded, gen));
  afterSnapshot(api, kind, extra);
  if (loaded.pending) {
    api.ops.setBusy('checking npm');
    followExtras(api, loaded, gen, kind);
    return;
  }
  if (kind === 'keep') return;
  finishIfEmpty(api, kind);
  if (extra.doneStatus && !api.ui.done && !api.loader.pendingExtras) {
    api.ui.status = extra.doneStatus;
  }
  if (kind === 'watch') api.ui.paint();
};

const reloadAfterChange = (api, afterLoad) => {
  const here = api.nav.index;
  const restore = () => {
    api.nav.index = here;
    api.ui.clampIndex();
    api.ui.syncReviewPath();
    api.ui.syncFileCursor();
    if (afterLoad) afterLoad();
  };
  if (api.ui.uiOpen && api.loadConfig.repo.loadAsync) {
    refreshFromRepo(api, { afterLoad: restore });
    return;
  }
  refreshFromRepo(api);
  restore();
};

const onReload = (api) => {
  api.collection.dismissed.clear();
  api.ui.status = '';
  refreshFromRepo(api, { doneStatus: 'reloaded' });
};

const clearWatchRetry = (api) => {
  if (api.watchRetry === null) return;
  const extra = watchOpts(api);
  const clearTimeoutFn = extra.clearTimeout ?? clearTimeout;
  clearTimeoutFn(api.watchRetry);
  api.watchRetry = null;
};

const shouldDeferWatch = (api) => {
  const { ui, ops } = api;
  if (ui.done) return true;
  if (!ui.uiOpen) return true;
  if (!api.loader.didLoad) return true;
  if (ops.gitBusy) return true;
  if (ui.mode !== 'review') return true;
  return false;
};

const onDiskChange = (api) => {
  if (shouldDeferWatch(api)) {
    if (api.watchRetry !== null) return;
    const extra = watchOpts(api);
    const setTimeoutFn = extra.setTimeout ?? setTimeout;
    const delay = extra.debounceMs ?? 200;
    api.watchRetry = setTimeoutFn(() => {
      api.watchRetry = null;
      onDiskChange(api);
    }, delay);
    return;
  }
  refreshFromRepo(api, { keepView: true, quiet: true });
};

const currentFileStamp = (api) => {
  if (api.nav.pane !== 'diff') return '';
  const rel = itemPath(api.ui.current());
  if (!rel) return '';
  const extra = watchOpts(api);
  const statSync = extra.statSync ?? fs.statSync;
  const full = path.join(api.ui.top || api.loadConfig.cwd, rel);
  let stat;
  try {
    stat = statSync(full);
  } catch {
    return `${rel}:missing`;
  }
  return `${rel}:${stat.mtimeMs}:${stat.size}`;
};

const pollCurrentFile = (api) => {
  const stamp = currentFileStamp(api);
  if (!stamp) {
    api.watchStamp = '';
    return;
  }
  if (!api.watchStamp) {
    api.watchStamp = stamp;
    return;
  }
  if (stamp === api.watchStamp) return;
  api.watchStamp = stamp;
  onDiskChange(api);
};

const stopWatch = (api) => {
  clearWatchRetry(api);
  api.watchStamp = '';
  if (api.ui.term) api.ui.term.stopTimer('watch');
  if (!api.diskWatcher) return;
  api.diskWatcher.close();
  api.diskWatcher = null;
};

const startWatch = (api) => {
  stopWatch(api);
  if (!isWorktree(api.ui)) return;
  const root = api.ui.top || api.loadConfig.cwd;
  if (!root) return;
  const extra = watchOpts(api);
  api.diskWatcher = createDiskWatcher({
    root,
    paths: api.loadConfig.paths,
    onChange: () => onDiskChange(api),
    ...extra,
  });
  syncItemWatches(api);
  if (!api.ui.term) return;
  api.ui.term.startTimer('watch', () => pollCurrentFile(api), POLL_MS);
};

const createLifecycle = (api) => {
  api.diskWatcher = null;
  api.watchRetry = null;
  api.watchStamp = '';
  api.npmExtras = null;
  return {
    applyLoaded: (loaded) => applyLoaded(api, loaded),
    load: () => load(api),
    openLoad: () => openLoad(api),
    loadReady: () => loadReady(api),
    refreshFromRepo: (extra) => refreshFromRepo(api, extra),
    reloadAfterChange: (afterLoad) => reloadAfterChange(api, afterLoad),
    onReload: () => onReload(api),
    onDiskChange: () => onDiskChange(api),
    pollCurrentFile: () => pollCurrentFile(api),
    startWatch: () => startWatch(api),
    stopWatch: () => stopWatch(api),
    clearNpmExtras: () => clearNpmExtras(api),
  };
};

module.exports = { createLifecycle };
