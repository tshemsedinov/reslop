'use strict';

const init = require('eslint-config-metarhia');

module.exports = [
  ...init,
  {
    rules: {
      'no-nested-ternary': 'error',
      'multiline-ternary': ['error', 'never'],
    },
  },
];
