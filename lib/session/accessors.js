'use strict';

const bindAlias = (target, name, get, set) => {
  const desc = { configurable: true, enumerable: true, get };
  if (set) desc.set = set;
  Object.defineProperty(target, name, desc);
};

const bindAccessors = (target, owner, names) => {
  for (const name of names) {
    const get = () => owner[name];
    const set = (value) => {
      owner[name] = value;
    };
    bindAlias(target, name, get, set);
  }
};

const bindGetters = (target, owner, names) => {
  for (const name of names) {
    bindAlias(target, name, () => owner[name]);
  }
};

module.exports = { bindAccessors, bindGetters, bindAlias };
