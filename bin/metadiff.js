#!/usr/bin/env node
'use strict';

const { run } = require('../lib/cli.js');

run(process).then(
  (code) => {
    process.exit(code);
  },
  (error) => {
    process.stderr.write(`metadiff: ${error.message}\n`);
    process.exit(1);
  },
);
