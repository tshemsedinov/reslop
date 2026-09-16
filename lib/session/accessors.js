'use strict';

const bindAccessors = (target, owner, names) => {
  for (const name of names) {
    Object.defineProperty(target, name, {
      configurable: true,
      enumerable: true,
      get: () => owner[name],
      set: (value) => {
        owner[name] = value;
      },
    });
  }
};

const bindGetters = (target, owner, names) => {
  for (const name of names) {
    Object.defineProperty(target, name, {
      configurable: true,
      enumerable: true,
      get: () => owner[name],
    });
  }
};

const bindAlias = (target, name, get, set) => {
  const desc = { configurable: true, enumerable: true, get };
  if (set) desc.set = set;
  Object.defineProperty(target, name, desc);
};

module.exports = { bindAccessors, bindGetters, bindAlias };
