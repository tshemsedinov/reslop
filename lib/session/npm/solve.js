'use strict';

const { buildDocument } = require('../../report/parse.js');
const { relativize } = require('../../runs/output.js');
const { TaskItem, taskLines } = require('../../review/task.js');
const { stripAnsi } = require('../../term/ansi.js');

// A failed run as tasks an agent can act on, one for each distinct error;
// the report has merged the tests that fail the same way. Each field is
// one plain line: the title names what fails, `where` its files,
// `problem` the error, and `check` the command that has to pass. The log
// is not copied.

const TASKS_MAX = 10;
const WHERE_MAX = 3;
const TEXT_MAX = 300;

// `lib/a.js:12` in a trace or a message; never node internals or packages
const LOCATION =
  /(?:^|[\s(])((?:\.{0,2}\/)?[\w@.-]+(?:\/[\w@.-]+)*\.\w+):(\d+)/g;

const oneLine = (text) => `${text ?? ''}`.replace(/\s+/g, ' ').trim();

// Long text ends at a word, so what is left reads as words
const clip = (text, max = TEXT_MAX) => {
  if (text.length <= max) return text;
  const cut = text.lastIndexOf(' ', max);
  return `${text.slice(0, cut > 0 ? cut : max)} …`;
};

const locationsIn = (text) => {
  const found = [];
  for (const match of text.matchAll(LOCATION)) {
    const file = match[1];
    if (file.startsWith('node:') || file.includes('node_modules/')) continue;
    found.push(`${file}:${match[2]}`);
  }
  return found;
};

// The failures a run reports, with paths from the root
const failures = (run, root) => {
  const raw = stripAnsi(`${run.raw ?? run.output ?? ''}`);
  const doc = buildDocument(raw, '', root, run.exit, 'test');
  const local = (text) => relativize(`${text ?? ''}`, root);
  return doc.reports
    .flatMap((report) => report.problems)
    .filter((one) => one.severity !== 'warning')
    .map((one) => ({
      name: oneLine(one.name),
      message: oneLine(local(one.message)),
      expected: oneLine(one.expected),
      actual: oneLine(one.actual),
      traces: one.traces.map(local),
      count: one.count,
    }));
};

const errorText = (one) => {
  if (!one.expected && !one.actual) return one.message;
  return `${one.message} (expected ${one.expected}, actual ${one.actual})`;
};

// The line of the output that says what went wrong and the one after it,
// which often carries the message
const errorLine = (output) => {
  const lines = output.split('\n').map(oneLine).filter(Boolean);
  const at = lines.findIndex((line) => /error|fail|exception/i.test(line));
  return at < 0 ? '' : lines.slice(at, at + 2).join(' ');
};

const whereOf = (one) => {
  const text = [one.message, ...one.traces].join('\n');
  return [...new Set(locationsIn(text))].slice(0, WHERE_MAX).join(', ');
};

const taskText = (title, fields) => {
  let lines = taskLines(clip(title), false);
  for (const [key, value] of fields) {
    if (value) lines = new TaskItem(lines).setField(key, clip(value));
  }
  return new TaskItem(lines).text;
};

// A test and the others that fail the same way
const titleOf = (one) =>
  one.count > 1 ? `${one.name}, and ${one.count - 1} more` : one.name;

// The texts of the tasks for a failed run; `output` is its filtered log.
// Without a named failure the run is one task: plain output read as one
// message, where the line that names the error says more
const solveTasks = (run, command, output, root) => {
  const found = failures(run, root);
  const check = ['check', `\`${command}\` passes`];
  const named = found.filter((one) => one.name);
  if (!named.length) {
    const [first] = found;
    const problem = errorLine(output) || first?.message || '';
    const where = first ? whereOf(first) : '';
    const fields = [['where', where], ['problem', problem], check];
    return [taskText(`\`${command}\` fails`, fields)];
  }
  const texts = named.slice(0, TASKS_MAX).map((one) => {
    const fields = [
      ['where', whereOf(one)],
      ['problem', errorText(one)],
      check,
    ];
    return taskText(titleOf(one), fields);
  });
  return [...new Set(texts)];
};

module.exports = { solveTasks };
