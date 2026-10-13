'use strict';

const { isHashObject } = require('metautil');
const { trimText } = require('../common/utilities.js');

const EFFORT_KEYS = ['effort', 'reasoning_effort', 'reasoning'];
const MODEL_ID = /^([^[\]]+)\[(.*)\]$/;
const FAST_NAME = /fast/i;
const CONTEXT_NAME = /^context/i;
const FAST_VALUES = ['off', 'on'];
const SWITCHES = [FAST_VALUES, ['false', 'true']];

const EFFORT_RANK = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'extra-high',
  'max',
  'ultra',
];

const concrete = (name) => {
  const text = trimText(name);
  return text === 'default' ? '' : text;
};

const unique = (values) => [...new Set(values.filter(Boolean))];

const switchValue = (value) => {
  if (value === 'true' || value === 'on') return 'on';
  if (value === 'false' || value === 'off') return 'off';
  return '';
};

// name[key=value,...] or name[effort]: one model id carries its own settings
const parseModelId = (id) => {
  const text = trimText(id);
  const variant = { id: text, name: text, effort: '', context: '', fast: '' };
  const match = MODEL_ID.exec(text);
  if (!match) return variant;
  variant.name = match[1].trim();
  for (const part of match[2].split(',')) {
    const [key, ...rest] = part.split('=');
    const value = rest.join('=').trim();
    const name = key.trim();
    if (!rest.length) variant.effort ||= name;
    else if (EFFORT_KEYS.includes(name)) variant.effort = value;
    else if (name === 'context') variant.context = value;
    else if (name === 'fast') variant.fast = switchValue(value);
  }
  return variant;
};

const optionValues = (option) => {
  const values = [];
  const collect = (items) => {
    for (const item of Array.isArray(items) ? items : []) {
      if (!isHashObject(item)) continue;
      if (Array.isArray(item.options)) collect(item.options);
      else if (typeof item.value === 'string') values.push(item.value);
    }
  };
  collect(option ? option.options : []);
  return values;
};

const selects = (options) => {
  const listed = Array.isArray(options) ? options : [];
  return listed.filter(
    (option) => isHashObject(option) && typeof option.id === 'string',
  );
};

const optionIn = (options, category) => {
  const listed = selects(options);
  const byCategory = listed.find((option) => option.category === category);
  return byCategory ?? listed.find((option) => option.id === category) ?? null;
};

const optionsOf = (state) => (state ? state.configOptions : null);

const optionOf = (state, category) => optionIn(optionsOf(state), category);

// A switch is named by the agent: on and off, or true and false
const fastIn = (options) => {
  for (const option of selects(options)) {
    if (!FAST_NAME.test(option.id)) continue;
    const values = optionValues(option);
    const pair = SWITCHES.find((names) =>
      names.every((value) => values.includes(value)),
    );
    if (pair) return { option, off: pair[0], on: pair[1] };
  }
  return null;
};

const contextIn = (options) =>
  selects(options).find((option) => CONTEXT_NAME.test(option.id)) ?? null;

const listedModels = (state) => {
  const models = state && isHashObject(state.models) ? state.models : {};
  const listed = Array.isArray(models.availableModels)
    ? models.availableModels
    : [];
  const ids = listed.map((model) => (isHashObject(model) ? model.modelId : ''));
  const current = trimText(models.currentModelId);
  return { ids: ids.filter((id) => typeof id === 'string' && id), current };
};

const groupVariants = (ids) => {
  const entries = new Map();
  for (const id of ids) {
    const variant = parseModelId(id);
    if (!variant.name) continue;
    if (!entries.has(variant.name)) {
      entries.set(variant.name, { name: variant.name, variants: [] });
    }
    entries.get(variant.name).variants.push(variant);
  }
  return entries;
};

const rankOf = (level) => {
  const at = EFFORT_RANK.indexOf(level);
  return at < 0 ? EFFORT_RANK.length : at;
};

const fitEffort = (levels, effort) => {
  const want = concrete(effort);
  if (!levels || !levels.length) return want;
  if (levels.length === 1) return levels[0];
  if (!want || levels.includes(want)) return want;
  let best = levels[0];
  for (const level of levels) {
    const gap = Math.abs(rankOf(level) - rankOf(want));
    if (gap < Math.abs(rankOf(best) - rankOf(want))) best = level;
  }
  return best;
};

const byRank = (left, right) => rankOf(left) - rankOf(right);

const variantValues = (entry, field) =>
  entry ? unique(entry.variants.map((variant) => variant[field])) : [];

// What one agent session offers: its models and the settings of each
class ModelCatalog {
  constructor(state) {
    const option = optionOf(state, 'model');
    const listed = listedModels(state);
    const ids = option ? optionValues(option) : listed.ids;
    const current = option ? option.currentValue : listed.current;
    this.loaded = Boolean(state);
    this.configId = option ? option.id : '';
    this.entries = groupVariants(ids);
    this.names = [...this.entries.keys()];
    this.currentId = trimText(current);
    this.current = parseModelId(this.currentId).name;
    // The model list can name the efforts of each model the option leaves out
    this.listed = option ? groupVariants(listed.ids) : new Map();
    this.session = selects(optionsOf(state));
    // An agent asked model by model has options that are not the session's
    this.byModel = state && state.byModel instanceof Map ? state.byModel : null;
  }

  find(name) {
    return this.entries.get(trimText(name)) ?? null;
  }

  described(entry) {
    const { byModel } = this;
    const variant = entry.variants.find((item) => byModel.has(item.id));
    return variant ? byModel.get(variant.id) : null;
  }

  // The settings of a model are unknown until the agent was asked about it
  unknown(name) {
    const entry = this.find(name);
    return Boolean(entry && this.byModel && !this.described(entry));
  }

  options(name) {
    const entry = this.find(name);
    if (!entry) return [];
    if (!this.byModel) return this.session;
    return this.described(entry) ?? [];
  }

  efforts(name) {
    const own = variantValues(this.find(name), 'effort');
    if (own.length) return own.sort(byRank);
    const listed = variantValues(this.listed.get(trimText(name)), 'effort');
    if (listed.length) return listed.sort(byRank);
    const option = optionIn(this.options(name), 'thought_level');
    return unique(optionValues(option).map(concrete));
  }

  contexts(name) {
    const own = variantValues(this.find(name), 'context');
    return own.length ? own : optionValues(contextIn(this.options(name)));
  }

  fasts(name) {
    const own = variantValues(this.find(name), 'fast');
    if (own.length) return own;
    return fastIn(this.options(name)) ? FAST_VALUES : [];
  }

  variant(entry, picked) {
    const effort = concrete(picked.effort);
    const context = trimText(picked.context);
    const fast = picked.fast === true ? 'on' : 'off';
    let best = null;
    let top = -1;
    for (const variant of entry.variants) {
      let score = variant.id === this.currentId ? 1 : 0;
      if (effort && variant.effort === effort) score += 8;
      if (context && variant.context === context) score += 4;
      if (variant.fast === fast) score += 2;
      if (score > top) [best, top] = [variant, score];
    }
    return best;
  }

  // What a run of the model gets: the picked settings where it offers them
  resolve(name, picked) {
    const entry = this.find(name);
    const variant = entry ? this.variant(entry, picked) : {};
    const options = this.options(name);
    const given = (option) => trimText(option ? option.currentValue : '');
    const pick = (offered, want, option) =>
      offered.includes(want) ? want : given(option);
    const levels = this.efforts(name);
    const effort = optionIn(options, 'thought_level');
    const level = concrete(pick(levels, concrete(picked.effort), effort));
    const sizes = this.contexts(name);
    const size = pick(sizes, trimText(picked.context), contextIn(options));
    const asked = fastIn(options) && picked.fast === true ? 'on' : 'off';
    return {
      id: variant.id ?? '',
      effort: variant.effort || (levels.includes(level) ? level : ''),
      context: variant.context || (sizes.includes(size) ? size : ''),
      fast: variant.fast || asked,
    };
  }
}

const EMPTY_CATALOG = new ModelCatalog(null);
const catalogs = new WeakMap();

const catalogOf = (state) => {
  if (!isHashObject(state)) return EMPTY_CATALOG;
  if (!catalogs.has(state)) catalogs.set(state, new ModelCatalog(state));
  return catalogs.get(state);
};

const setOption = (option, value) => {
  if (!option || option.currentValue === value) return null;
  if (!optionValues(option).includes(value)) return null;
  const params = { configId: option.id, value };
  return { method: 'session/set_config_option', params };
};

const modelRequest = (catalog, id) => {
  if (!catalog.configId) {
    return { method: 'session/set_model', params: { modelId: id } };
  }
  const params = { configId: catalog.configId, value: id };
  return { method: 'session/set_config_option', params };
};

// An unlisted model keeps the one the agent already runs
const modelChange = (state, picked) => {
  const catalog = catalogOf(state);
  const name = catalog.find(picked.model) ? picked.model : catalog.current;
  const { id } = catalog.resolve(name, picked);
  if (!id || id === catalog.currentId) return null;
  return modelRequest(catalog, id);
};

const effortChange = (state, picked) =>
  setOption(optionOf(state, 'thought_level'), concrete(picked.effort));

const contextChange = (state, picked) =>
  setOption(contextIn(optionsOf(state)), trimText(picked.context));

const fastChange = (state, picked) => {
  const fast = fastIn(optionsOf(state));
  if (!fast) return null;
  return setOption(fast.option, picked.fast === true ? fast.on : fast.off);
};

const modeChange = (state, mode) => {
  if (!mode) return null;
  const option = optionOf(state, 'mode');
  if (option) return setOption(option, mode);
  const modes = state && isHashObject(state.modes) ? state.modes : {};
  const listed = Array.isArray(modes.availableModes)
    ? modes.availableModes
    : [];
  const offered = listed.some((item) => isHashObject(item) && item.id === mode);
  if (!offered || modes.currentModeId === mode) return null;
  return { method: 'session/set_mode', params: { modeId: mode } };
};

const emptyChoice = () => ({ model: '', effort: '', fast: false, context: '' });

const choiceOf = (picked) => {
  const from = isHashObject(picked) ? picked : {};
  return {
    model: trimText(from.model),
    effort: concrete(from.effort),
    fast: from.fast === true,
    context: trimText(from.context),
  };
};

module.exports = {
  concrete,
  parseModelId,
  catalogOf,
  fitEffort,
  modelRequest,
  modelChange,
  effortChange,
  contextChange,
  fastChange,
  modeChange,
  emptyChoice,
  choiceOf,
};
