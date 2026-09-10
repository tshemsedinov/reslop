#!/usr/bin/env node
'use strict';

const { run, failLine } = require('../lib/cli.js');
const { LEAVE_TERM } = require('../lib/session.js');

const fail = (reason) => {
  try {
    process.stdout.write(LEAVE_TERM);
  } catch {}
  process.stderr.write(failLine(reason));
  process.exit(1);
};

process.on('uncaughtException', (error) => fail(error));
process.on('unhandledRejection', (reason) => fail(reason));

run(process).then(
  (code) => {
    process.exit(code);
  },
  (error) => fail(error),
);
