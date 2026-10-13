'use strict';

const { isHashObject } = require('metautil');
const { trimText } = require('../../common/utilities.js');

const models = require('../../agents/models.js');
const { catalogOf, fitEffort, concrete } = models;

const STORED_FIELDS = ['model', 'effort', 'context'];

// The choices one agent row offers, from what its session lists
class AgentOptions {
  constructor(row) {
    this.row = row;
    this.catalog = catalogOf(row.catalog);
    this.names = this.catalog.names;
  }

  // A saved model stays as it is until the agent has listed its own
  shown(model) {
    const saved = trimText(model);
    if (!this.catalog.loaded || this.catalog.find(saved)) return saved;
    return this.catalog.current || this.names[0] || '';
  }

  efforts(model) {
    return this.catalog.efforts(this.shown(model));
  }

  contexts(model) {
    return this.catalog.contexts(this.shown(model));
  }

  fasts(model) {
    return this.catalog.fasts(this.shown(model));
  }

  // Before the agent has listed anything the saved choice is all there is
  settings(picked) {
    if (this.catalog.loaded) {
      return this.catalog.resolve(this.shown(picked.model), picked);
    }
    return {
      effort: concrete(picked.effort),
      context: trimText(picked.context),
      fast: picked.fast === true ? 'on' : 'off',
    };
  }

  align(picked) {
    if (!this.catalog.loaded) return;
    picked.effort = fitEffort(this.efforts(picked.model), picked.effort);
  }

  normalize(picked) {
    this.align(picked);
    return this.shown(picked.model);
  }

  preferEffort(picked, level) {
    if (concrete(picked.effort)) return;
    if (this.efforts(picked.model).includes(level)) picked.effort = level;
  }

  pickModel(picked, model) {
    picked.model = model;
    this.align(picked);
  }

  toggleFast(picked) {
    if (this.fasts(picked.model).length < 2) return false;
    picked.fast = picked.fast !== true;
    return true;
  }
}

const storedChoice = (picked) => {
  const fields = [
    ['model', trimText(picked.model)],
    ['effort', concrete(picked.effort)],
    ['fast', picked.fast === true],
    ['context', trimText(picked.context)],
  ];
  const stored = Object.fromEntries(fields.filter((field) => field[1]));
  return Object.keys(stored).length ? stored : null;
};

const restoreChoice = (picked, saved) => {
  if (!isHashObject(saved)) return;
  const stored = storedChoice(saved) ?? {};
  for (const field of STORED_FIELDS) {
    if (stored[field]) picked[field] = stored[field];
  }
  if (stored.fast) picked.fast = true;
};

module.exports = { AgentOptions, restoreChoice, storedChoice };
