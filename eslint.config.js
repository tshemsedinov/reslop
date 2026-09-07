'use strict';

const init = require('eslint-config-metarhia');

module.exports = [
  ...init,
  {
    rules: {
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
];
