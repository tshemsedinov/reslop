'use strict';

// A reporter for `node --test` that tells where the time goes:
//   node --test --test-reporter=./scripts/slow-tests.js
// It prints the files and the tests by their duration, and the failures.

const path = require('node:path');

const TOP_FILES = 15;
const TOP_TESTS = 40;
const SLOW_MS = 1000;

const baseOf = (data) => (data.file ? path.basename(data.file) : '?');

const millis = (data) => Number(data.details?.duration_ms ?? 0);

const pad = (value, width) => `${value}`.padStart(width);

const failureText = (data) => {
  const error = data.details?.error;
  const cause = error?.cause ?? error;
  const text = cause?.message ?? cause ?? '';
  return `${text}`.split('\n')[0];
};

module.exports = async function* slowTests(source) {
  const files = new Map();
  const tests = [];
  const failed = [];
  let count = 0;
  for await (const event of source) {
    const { type, data } = event;
    if (type !== 'test:pass' && type !== 'test:fail') continue;
    if (data.details?.type === 'suite') continue;
    const ms = millis(data);
    if (data.nesting === 0 && data.file) {
      const name = baseOf(data);
      files.set(name, (files.get(name) ?? 0) + ms);
    }
    count += 1;
    tests.push({ file: baseOf(data), name: data.name, ms });
    if (type === 'test:fail') {
      failed.push({ name: data.name, why: failureText(data) });
    }
  }
  const byTime = (left, right) => right.ms - left.ms;
  const fileList = [...files].map(([name, ms]) => ({ name, ms }));
  fileList.sort(byTime);
  tests.sort(byTime);
  const total = tests.reduce((sum, test) => sum + test.ms, 0);
  const slow = tests.filter((test) => test.ms >= SLOW_MS).length;
  yield `# platform: ${process.platform} node ${process.version}\n`;
  yield `# tests: ${count}, time of all: ${Math.round(total)} ms, `;
  yield `slower than ${SLOW_MS} ms: ${slow}\n`;
  yield '# slowest files\n';
  for (const file of fileList.slice(0, TOP_FILES)) {
    yield `${pad(Math.round(file.ms), 8)} ms  ${file.name}\n`;
  }
  yield '# slowest tests\n';
  for (const test of tests.slice(0, TOP_TESTS)) {
    yield `${pad(Math.round(test.ms), 8)} ms  ${test.file}: ${test.name}\n`;
  }
  if (failed.length) yield '# failed\n';
  for (const test of failed) yield `${test.name}\n  ${test.why}\n`;
};
