'use strict';

const { isAbortError } = require('./load.js');
const { itemKey } = require('./items.js');
const review = require('../review.js');
const { hasNotes } = review;

const loadOptions = (api, extra = {}) => {
  const commit = api.options.rev();
  const audit = api.options.audit();
  const outdatedMap = api.options.outdatedMap();
  const auditMap = api.options.auditMap();
  return { commit, audit, outdatedMap, auditMap, ...extra };
};

const shouldDeferExtras = (api) => {
  if (!api.options.audit()) return false;
  if (
    api.options.outdatedMap() !== undefined &&
    api.options.auditMap() !== undefined
  ) {
    return false;
  }
  return true;
};

const bumpLoad = (api) => api.loader.bump();

const endReadLoop = (api) => {
  const finish = api.options.finishReadLoop();
  if (finish) finish();
};

const finishIfEmpty = (api, kind) => {
  if (api.options.items().length) return;
  const notes = api.options.notes();
  if (notes && hasNotes(notes)) return;
  if (kind === 'keep') return;
  if (notes && hasNotes(notes)) api.options.flushReview();
  api.options.setDone(true);
  api.options.setExitCode(0);
  api.options.setStatus('nothing to review');
  api.options.setEmptyReview(kind === 'open');
  endReadLoop(api);
};

const failOpen = (api, error) => {
  if (isAbortError(error)) return;
  api.options.setLoadError(error);
  api.options.setDone(true);
  api.options.setExitCode(1);
  api.options.setBusy('');
  api.options.stopProgress();
  endReadLoop(api);
};

const applyLoaded = (api, loaded) => {
  const { options, loader, collection } = api;
  if (
    loaded.generation !== undefined &&
    !loader.accept(loaded.generation, options.isDone())
  ) {
    return false;
  }
  const wasTodo = options.nav.todoOpen === true;
  const here = itemKey(options.current());
  options.setTop(loaded.top ?? options.cwd());
  collection.replace(loaded.items);
  if (loaded.rev) options.setRev(loaded.rev);
  if (loaded.revShort) {
    options.setRevShort(loaded.revShort);
  } else if (options.rev() && !options.revShort()) {
    options.setRevShort(options.rev().slice(0, 7));
  }
  if (loaded.sourceLabel) options.setSourceLabel(loaded.sourceLabel);
  if (loaded.change) options.setChange(loaded.change);
  if (loaded.branch !== undefined) options.setBranch(loaded.branch || '');
  const repository = options.change() ? options.change().repository : '';
  if (!options.repoName() && repository) options.setRepoName(repository);
  if (!options.notes()) options.initReview();
  options.review.applyImported(loaded.imported);
  options.nav.todoOpen = wasTodo;
  if (here && !wasTodo) {
    const idx = collection.findIndexByKey(here);
    if (idx >= 0) options.nav.index = idx;
  }
  options.clampIndex();
  options.syncReviewPath();
  options.syncFileCursor();
  options.setDidLoad(true);
  options.setPendingExtras(loaded.pending === true);
  return true;
};

const load = (api) => {
  const loaded = api.options
    .repo()
    .load(api.options.cwd(), api.options.paths(), loadOptions(api));
  applyLoaded(api, loaded);
};

const followExtras = async (api, loaded, gen, kind) => {
  const extra = loadOptions(api, {
    paths: api.options.paths(),
    signal: api.loader.signal,
  });
  let next;
  try {
    next = await api.loader.fetchExtras(api.options.repo(), loaded, extra);
  } catch (error) {
    if (!api.loader.isCurrent(gen)) return;
    failOpen(api, error);
    return;
  }
  if (!api.loader.isCurrent(gen)) return;
  if (api.options.isDone()) {
    api.options.clearBusy();
    return;
  }
  if (!next) {
    api.options.clearBusy();
    api.options.setPendingExtras(false);
    api.options.paint();
    finishIfEmpty(api, kind);
    return;
  }
  applyLoaded(api, api.loader.tag(next, gen));
  api.options.clearBusy();
  api.options.paint();
  finishIfEmpty(api, kind);
};

const runOpenLoad = async (api) => {
  const gen = api.loader.gen;
  const extra = loadOptions(api, {
    deferExtras: shouldDeferExtras(api),
    signal: api.loader.signal,
  });
  api.options.resetProgressFrame();
  api.options.setBusy('loading');
  api.options.paint();
  let loaded;
  try {
    loaded = await api.loader.fetchSnapshot(
      api.options.repo(),
      api.options.cwd(),
      api.options.paths(),
      extra,
    );
  } catch (error) {
    if (!api.loader.isCurrent(gen)) return;
    failOpen(api, error);
    return;
  }
  if (!api.loader.isCurrent(gen)) return;
  if (api.options.isDone()) {
    api.options.clearBusy();
    return;
  }
  applyLoaded(api, api.loader.tag(loaded, gen));
  if (loaded.pending) {
    api.options.setBusy('checking npm');
    api.options.paint();
    await followExtras(api, loaded, gen, 'open');
    return;
  }
  api.options.clearBusy();
  api.options.paint();
  finishIfEmpty(api, 'open');
};

const openLoad = (api) => {
  if (api.options.loadPromise()) return api.options.loadPromise();
  if (api.options.didLoad() && !api.options.pendingExtras()) {
    api.options.setLoadPromise(Promise.resolve());
    return api.options.loadPromise();
  }
  bumpLoad(api);
  api.options.setLoadPromise(runOpenLoad(api));
  return api.options.loadPromise();
};

const loadReady = async (api) => {
  api.options.ensureRepo();
  await openLoad(api);
  if (api.options.loadError()) throw api.options.loadError();
};

const refreshFromRepoAsync = async (api, extra = {}, startedGen) => {
  const gen = startedGen ?? api.loader.gen;
  const keepEmpty = extra.keepEmpty === true;
  const loadedOpts = loadOptions(api, {
    deferExtras: shouldDeferExtras(api),
    signal: api.loader.signal,
  });
  api.options.resetProgressFrame();
  api.options.setBusy('loading');
  api.options.paint();
  let loaded;
  try {
    loaded = await api.loader.fetchSnapshot(
      api.options.repo(),
      api.options.cwd(),
      api.options.paths(),
      loadedOpts,
    );
  } catch (error) {
    if (!api.loader.isCurrent(gen)) return;
    failOpen(api, error);
    return;
  }
  if (!api.loader.isCurrent(gen)) return;
  if (api.options.isDone()) {
    api.options.clearBusy();
    return;
  }
  applyLoaded(api, api.loader.tag(loaded, gen));
  api.options.nav.scroll = 0;
  api.options.nav.clearSelection();
  if (extra.afterLoad) extra.afterLoad();
  if (loaded.pending) {
    api.options.setBusy('checking npm');
    const kind = keepEmpty ? 'keep' : 'reload';
    await followExtras(api, loaded, gen, kind);
    return;
  }
  api.options.clearBusy();
  if (!keepEmpty) finishIfEmpty(api, 'reload');
  if (extra.doneStatus && !api.options.status() && !api.options.busy()) {
    api.options.setStatus(extra.doneStatus);
  }
  api.options.paint();
};

const refreshFromRepo = (api, extra = {}) => {
  api.options.setLoadPromise(null);
  const gen = bumpLoad(api);
  if (api.options.uiOpen() && api.options.repo().loadAsync) {
    return void refreshFromRepoAsync(api, extra, gen);
  }
  const loadedOpts = loadOptions(api, {
    deferExtras: shouldDeferExtras(api),
  });
  const loaded = api.options
    .repo()
    .load(api.options.cwd(), api.options.paths(), loadedOpts);
  applyLoaded(api, api.loader.tag(loaded, gen));
  api.options.nav.scroll = 0;
  api.options.nav.clearSelection();
  if (extra.afterLoad) extra.afterLoad();
  const keepEmpty = extra.keepEmpty === true;
  if (loaded.pending) {
    api.options.setBusy('checking npm');
    const kind = keepEmpty ? 'keep' : 'reload';
    followExtras(api, loaded, gen, kind);
    return;
  }
  if (keepEmpty) return;
  finishIfEmpty(api, 'reload');
  if (
    extra.doneStatus &&
    !api.options.isDone() &&
    !api.options.pendingExtras()
  ) {
    api.options.setStatus(extra.doneStatus);
  }
};

const reloadAfterChange = (api, afterLoad) => {
  const here = api.options.nav.index;
  const restore = () => {
    api.options.nav.index = here;
    api.options.clampIndex();
    api.options.syncReviewPath();
    api.options.syncFileCursor();
    if (afterLoad) afterLoad();
  };
  if (api.options.uiOpen() && api.options.repo().loadAsync) {
    refreshFromRepo(api, { afterLoad: restore });
    return;
  }
  refreshFromRepo(api);
  restore();
};

const onReload = (api) => {
  api.collection.dismissed.clear();
  api.options.setStatus('');
  refreshFromRepo(api, { doneStatus: 'reloaded' });
};

const createLifecycle = (options) => {
  const api = {
    options,
    loader: options.loader,
    collection: options.collection,
  };
  return {
    loadOptions: (extra) => loadOptions(api, extra),
    shouldDeferExtras: () => shouldDeferExtras(api),
    bumpLoad: () => bumpLoad(api),
    applyLoaded: (loaded) => applyLoaded(api, loaded),
    load: () => load(api),
    followExtras: (loaded, gen, kind) => followExtras(api, loaded, gen, kind),
    openLoad: () => openLoad(api),
    runOpenLoad: () => runOpenLoad(api),
    loadReady: () => loadReady(api),
    refreshFromRepo: (extra) => refreshFromRepo(api, extra),
    refreshFromRepoAsync: (extra, gen) => refreshFromRepoAsync(api, extra, gen),
    reloadAfterChange: (afterLoad) => reloadAfterChange(api, afterLoad),
    onReload: () => onReload(api),
    finishIfEmpty: (kind) => finishIfEmpty(api, kind),
    failOpen: (error) => failOpen(api, error),
  };
};

module.exports = { createLifecycle };
