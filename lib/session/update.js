'use strict';

const update = require('../update.js');
const { checkUpdate, installUpdate, markSkipped } = update;

const optsOf = (api) => {
  const value = api.options.updateOpts();
  if (!value || value === true) return {};
  return value;
};

const reset = (state) => {
  state.offer = false;
  state.from = '';
  state.to = '';
  state.checkPromise = null;
  state.installPromise = null;
};

const maybePrompt = (api) => {
  if (!api.state.offer) return;
  if (!api.options.didLoad()) return;
  if (api.options.getMode() !== 'review') return;
  api.options.setMode('confirmUpdate');
};

const runInstall = async (api, version) => {
  api.options.setStatus('updating reslop');
  api.options.startInstallProgress();
  api.options.paint();
  let ok = false;
  try {
    await installUpdate(version, optsOf(api));
    ok = true;
  } catch {
    // ignore install errors
  }
  api.options.stopInstallProgress();
  if (api.options.isDone() || !api.options.uiOpen()) return;
  api.options.setStatus(ok ? 'updated' : 'update failed');
  api.options.paint();
};

const acceptUpdate = (api) => {
  api.options.setMode('review');
  api.state.offer = false;
  const version = api.state.to;
  api.state.installPromise = runInstall(api, version);
};

const declineUpdate = (api) => {
  api.options.setMode('review');
  api.state.offer = false;
  api.options.setStatus('');
  markSkipped(api.state.to, optsOf(api));
};

const runOpenUpdate = async (api) => {
  let plan;
  try {
    plan = await checkUpdate(optsOf(api));
  } catch {
    return;
  }
  if (api.options.isDone()) return;
  if (plan.action === 'install') {
    api.state.installPromise = runInstall(api, plan.latest);
    await api.state.installPromise;
    return;
  }
  if (plan.action !== 'confirm') return;
  api.state.from = plan.current;
  api.state.to = plan.latest;
  api.state.offer = true;
  maybePrompt(api);
  api.options.paint();
};

const openUpdate = (api) => {
  if (api.options.updateOpts() === false) return Promise.resolve();
  if (api.state.checkPromise) return api.state.checkPromise;
  api.state.checkPromise = runOpenUpdate(api);
  return api.state.checkPromise;
};

const createUpdateCoordinator = (options) => {
  const state = {
    offer: false,
    from: '',
    to: '',
    checkPromise: null,
    installPromise: null,
  };
  const api = { options, state };
  return {
    get offer() {
      return state.offer;
    },
    set offer(value) {
      state.offer = value;
    },
    get from() {
      return state.from;
    },
    get to() {
      return state.to;
    },
    get checkPromise() {
      return state.checkPromise;
    },
    get installPromise() {
      return state.installPromise;
    },
    set installPromise(value) {
      state.installPromise = value;
    },
    reset: () => reset(state),
    maybePrompt: () => maybePrompt(api),
    accept: () => acceptUpdate(api),
    decline: () => declineUpdate(api),
    open: () => openUpdate(api),
  };
};

module.exports = { createUpdateCoordinator };
