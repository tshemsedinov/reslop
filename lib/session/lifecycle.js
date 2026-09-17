'use strict';

const { isAbortError } = require('./load.js');
const { itemKey } = require('./items.js');
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

const endReadLoop = (api) => {
  const finish = api.ui.finishReadLoop;
  if (finish) finish();
};

const markLoaded = (api) => {
  api.loader.didLoad = true;
  api.updater.maybePrompt();
};

const finishIfEmpty = (api, kind) => {
  const { collection, review: notes, ui } = api;
  if (collection.items.length) return;
  if (notes.store && hasNotes(notes.store)) return;
  if (kind === 'keep') return;
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

const applyLoaded = (api, loaded) => {
  const { loader, collection, review: notes, nav, ui } = api;
  if (loaded.generation !== undefined) {
    if (!loader.accept(loaded.generation, ui.done)) return false;
  }
  const wasTodo = nav.todoOpen === true;
  const here = itemKey(ui.current());
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
  nav.todoOpen = wasTodo;
  if (here && !wasTodo) {
    const idx = collection.findIndexByKey(here);
    if (idx >= 0) nav.index = idx;
  }
  ui.clampIndex();
  ui.syncReviewPath();
  ui.syncFileCursor();
  markLoaded(api);
  loader.pendingExtras = loaded.pending === true;
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
  api.ops.clearBusy();
  api.ui.paint();
  finishIfEmpty(api, kind);
};

const snapshotOpts = (api, extra = {}) =>
  loadOptions(api, {
    deferExtras: shouldDeferExtras(api),
    ...extra,
  });

const resetNavAfterLoad = (api, extra = {}) => {
  api.nav.scroll = 0;
  api.nav.clearSelection();
  if (extra.afterLoad) extra.afterLoad();
};

const runSnapshot = async (api, gen, kind, extra = {}) => {
  api.ui.progressFrame = 0;
  api.ops.setBusy('loading');
  api.ui.paint();
  let loaded;
  try {
    loaded = await api.loader.fetchSnapshot(
      api.loadConfig.repo,
      api.loadConfig.cwd,
      api.loadConfig.paths,
      snapshotOpts(api, { signal: api.loader.signal }),
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
  if (kind !== 'open') resetNavAfterLoad(api, extra);
  if (loaded.pending) {
    api.ops.setBusy('checking npm');
    if (kind === 'open') api.ui.paint();
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
  const kind = extra.keepEmpty === true ? 'keep' : 'reload';
  if (api.ui.uiOpen && api.loadConfig.repo.loadAsync) {
    return void runSnapshot(api, gen, kind, extra);
  }
  const loaded = api.loadConfig.repo.load(
    api.loadConfig.cwd,
    api.loadConfig.paths,
    snapshotOpts(api),
  );
  applyLoaded(api, api.loader.tag(loaded, gen));
  resetNavAfterLoad(api, extra);
  if (loaded.pending) {
    api.ops.setBusy('checking npm');
    followExtras(api, loaded, gen, kind);
    return;
  }
  if (kind === 'keep') return;
  finishIfEmpty(api, 'reload');
  if (extra.doneStatus && !api.ui.done && !api.loader.pendingExtras) {
    api.ui.status = extra.doneStatus;
  }
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

const createLifecycle = (api) => ({
  applyLoaded: (loaded) => applyLoaded(api, loaded),
  load: () => load(api),
  openLoad: () => openLoad(api),
  loadReady: () => loadReady(api),
  refreshFromRepo: (extra) => refreshFromRepo(api, extra),
  reloadAfterChange: (afterLoad) => reloadAfterChange(api, afterLoad),
  onReload: () => onReload(api),
});

module.exports = { createLifecycle };
