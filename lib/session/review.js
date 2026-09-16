'use strict';

const store = require('../review/store.js');
const { createStore, applyImportedNotes, setStatus } = store;
const storage = require('../review/storage.js');
const { listReviewNames, loadTemplates, resolveReviewPath } = storage;
const { loadReview, flushReview } = storage;

const createReviewController = (options) => {
  const io = options.storage;
  const state = {
    store: null,
    didResume: false,
    importedRemote: false,
  };

  const reset = () => {
    state.store = null;
    state.didResume = false;
    state.importedRemote = false;
  };

  const init = (dir, date, extra = {}) => {
    const forceNew = extra.forceNew ?? false;
    const names = listReviewNames(dir, io.readdirSync);
    const templates = loadTemplates(dir, io.readFileSync);
    const resolved = resolveReviewPath(dir, date, names, {
      forceNew,
      readFileSync: io.readFileSync,
    });
    if (resolved.resume) {
      state.store = loadReview(resolved.reviewPath, templates, io.readFileSync);
      state.didResume = true;
      return state.store;
    }
    state.store = createStore(resolved.reviewPath, templates);
    state.didResume = false;
    return state.store;
  };

  const applyImported = (imported) => {
    if (!imported || !state.store) return false;
    if (state.didResume || state.importedRemote) return false;
    applyImportedNotes(state.store, imported);
    state.importedRemote = true;
    return true;
  };

  const flush = (force = false) => {
    if (!state.store) return { ok: true, wrote: false };
    try {
      const writeFileSync = io.writeFileSync;
      const mkdirSync = io.mkdirSync;
      const wrote = flushReview(state.store, {
        writeFileSync,
        mkdirSync,
        force,
      });
      return { ok: true, wrote };
    } catch (error) {
      return { ok: false, wrote: false, error };
    }
  };

  const finishQuit = (status) => {
    setStatus(state.store, status);
    return flush();
  };

  return {
    get store() {
      return state.store;
    },
    get didResume() {
      return state.didResume;
    },
    get importedRemote() {
      return state.importedRemote;
    },
    reset,
    init,
    applyImported,
    flush,
    finishQuit,
  };
};

module.exports = { createReviewController };
