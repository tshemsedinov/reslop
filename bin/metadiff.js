#!/usr/bin/env node
'use strict';

const { run } = require('../lib/cli.js');
const { LEAVE_TERM } = require('../lib/session.js');

const errorMessage = (reason) => {
  if (reason instanceof Error) return reason.message;
  if (reason === null || reason === undefined) return '';
  if (typeof reason === 'string') return reason;
  return `${reason}`;
};

const fail = (reason) => {
  try {
    process.stdout.write(LEAVE_TERM);
  } catch {
    // stdout may already be closed
  }
  process.stderr.write(`metadiff: ${errorMessage(reason)}\n`);
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
