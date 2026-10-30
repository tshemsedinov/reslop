'use strict';

const { stripAnsi } = require('../term/ansi.js');
const { buildDocument } = require('../report/parse.js');
const report = require('../report/render.js');
const { renderDocument, renderReport } = report;
const runStore = require('../runs/runs.js');
const { Tracker, summarizeDocument } = runStore;
const { runName } = require('../dashboard/model.js');
const { reduceOutput, relativize } = require('../runs/output.js');
const { fileName } = require('../runs/logs.js');
const utilities = require('../common/utilities.js');
const { trimText, pad2, dateStamp, flatText } = utilities;
const { fieldTaskText } = require('../review/task.js');

const TESTS_RE = /^(?:TAP version \d+|\s*(?:not )?ok\b|[ℹi]\s+tests\s+\d+)/m;

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
      name: flatText(one.name),
      message: flatText(local(one.message)),
      expected: flatText(one.expected),
      actual: flatText(one.actual),
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
  const lines = output
    .split('\n')
    .map((line) => flatText(line))
    .filter(Boolean);
  const at = lines.findIndex((line) => /error|fail|exception/i.test(line));
  return at < 0 ? '' : lines.slice(at, at + 2).join(' ');
};

const whereOf = (one) => {
  const text = [one.message, ...one.traces].join('\n');
  return [...new Set(locationsIn(text))].slice(0, WHERE_MAX).join(', ');
};

const taskText = (title, fields) =>
  fieldTaskText(
    clip(title),
    fields.map(([key, value]) => [key, value && clip(value)]),
  );

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

const filteredOutput = (raw, root, status, rawFile) => {
  const text = stripAnsi(`${raw ?? ''}`);
  if (status === '' || !TESTS_RE.test(text)) {
    const output = reduceOutput(raw, root, status);
    return { output, log: output, result: null };
  }
  const doc = buildDocument(raw, '', root, status, 'test');
  const result = summarizeDocument(doc);
  const output = renderReport(doc);
  const log = renderDocument(doc, rawFile);
  return { output, log, result };
};

const runLabel = (entry) =>
  entry.kind === 'bin' ? `npm exec ${entry.name}` : `npm run ${entry.name}`;

const historyMark = (run) => {
  if (run.status === 'running') return 'run';
  if (run.status === 'stopped') return 'stop';
  if (run.exit === 0 || run.exit === '0') return 'pass';
  return 'fail';
};

const historyCounts = (run) => {
  const result = run.result;
  if (result && typeof result.tests === 'number') {
    const fail = result.failed ?? 0;
    const ok = result.passed ?? Math.max(0, result.tests - fail);
    return { done: result.tests, ok, fail, total: result.tests };
  }
  const progress = run.progress;
  if (!progress) return null;
  const ok = progress.done ?? 0;
  const fail = progress.failed ?? 0;
  if (!ok && !fail && !(progress.expected > 0)) return null;
  const total = progress.expected > 0 ? progress.expected : null;
  return { done: ok + fail, ok, fail, total };
};

const countText = (value) => (typeof value === 'number' ? `${value}` : '');

const historyExit = (run, counts) => {
  if (counts || run.status !== 'exited') return '';
  if (run.exit === '' || run.exit === null || run.exit === undefined) return '';
  return `exit ${run.exit}`;
};

const earlierTotal = (list, run) => {
  let best = 0;
  let at = -1;
  for (const item of list) {
    if (item === run || item.name !== run.name) continue;
    if (item.status === 'running') continue;
    const counts = historyCounts(item);
    if (!counts || typeof counts.total !== 'number') continue;
    const started = item.startedAt || 0;
    if (started < at) continue;
    at = started;
    best = counts.total;
  }
  return best;
};

const noteTests = (run, list, text) => {
  const plain = stripAnsi(`${text ?? ''}`);
  if (!TESTS_RE.test(plain)) return;
  const tracker = new Tracker();
  tracker.feed(plain);
  if (!Object.hasOwn(run, 'expected')) run.expected = earlierTotal(list, run);
  run.progress = {
    done: tracker.progress.done,
    failed: tracker.progress.failed,
    expected: run.expected,
  };
};

const RUN_KEEP = 50;

const LOG_GAP_MS = 2000;

const RESLOP_RUN = /^reslop(?:\.js)?\s+t\s+--\s+/;

const RESLOP_T = /reslop(?:\.js)?\s+t\s+--/;

const launchedReslop = (run) => {
  if (run.externalId) return false;
  const command = `${run.command ?? ''}`;
  return RESLOP_T.test(command);
};

const historyName = (run) => {
  const script = trimText(run.name);
  if (script) return script;
  return trimText(run.command).replace(RESLOP_RUN, '');
};

const sameWindow = (left, right) => {
  const start = Number(left.startedAt) || 0;
  const end = Number(left.endedAt) || start;
  const at = Number(right.startedAt) || 0;
  const done = Number(right.endedAt) || at;
  return done >= start - LOG_GAP_MS && at <= end + LOG_GAP_MS;
};

const externalStatus = (record) => {
  if (record.status === 'running') return 'running';
  if (record.status === 'aborted') return 'stopped';
  return 'exited';
};

const externalExit = (record) => {
  if (record.status === 'running' || record.status === 'aborted') return '';
  if (record.exit === null || record.exit === undefined) return '';
  return record.exit;
};

const progressCount = (progress, key) => {
  if (!progress || typeof progress[key] !== 'number') return 0;
  return progress[key];
};

const progressSame = (left, right) => {
  const done = progressCount(left, 'done') === progressCount(right, 'done');
  const leftFailed = progressCount(left, 'failed');
  const rightFailed = progressCount(right, 'failed');
  const failed = leftFailed === rightFailed;
  const leftExpected = progressCount(left, 'expected');
  const rightExpected = progressCount(right, 'expected');
  const expected = leftExpected === rightExpected;
  return done && failed && expected;
};

const resultSame = (left, right) => {
  if (!left && !right) return true;
  if (!left || !right) return false;
  return (
    left.tests === right.tests &&
    left.passed === right.passed &&
    left.failed === right.failed &&
    left.errors === right.errors
  );
};

const applyExternal = (run, record) => {
  const status = externalStatus(record);
  const exit = externalExit(record);
  const endedAt = Number(record.endedAt) || 0;
  const progress = record.progress ?? null;
  const result = record.result ?? null;
  const same =
    run.status === status &&
    run.exit === exit &&
    (run.endedAt || 0) === endedAt &&
    progressSame(run.progress, progress) &&
    resultSame(run.result, result);
  if (same) return false;
  run.status = status;
  run.exit = exit;
  run.endedAt = endedAt;
  run.progress = progress;
  run.result = result;
  return true;
};

const recordedItem = (record) => {
  const script = trimText(record.script);
  const command = trimText(record.command);
  const name = runName({ command, script }).replace(RESLOP_RUN, '');
  return {
    name,
    kind: script ? 'script' : 'command',
    script,
    command,
    status: externalStatus(record),
    exit: externalExit(record),
    startedAt: Number(record.startedAt) || 0,
    endedAt: Number(record.endedAt) || 0,
    logName: fileName(record.log),
    rawName: fileName(record.raw),
    externalId: `${record.id ?? ''}`,
    result: record.result ?? null,
    progress: record.progress ?? null,
  };
};

const whenLabel = (ms) => {
  if (!ms) return '';
  const date = new Date(ms);
  const hh = pad2(date.getHours());
  const mm = pad2(date.getMinutes());
  const time = `${hh}:${mm}`;
  if (dateStamp(date) === dateStamp(new Date())) return time;
  const month = pad2(date.getMonth() + 1);
  const day = pad2(date.getDate());
  return `${month}-${day} ${time}`;
};

const elapsedText = (run, now) => {
  const end =
    run.status === 'running' ? now : run.endedAt || run.startedAt || 0;
  const ms = Math.max(0, end - (run.startedAt || end));
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const rest = sec % 60;
  return `${min}m${pad2(rest)}s`;
};

module.exports = {
  filteredOutput,
  runLabel,
  historyMark,
  historyCounts,
  countText,
  historyExit,
  noteTests,
  RUN_KEEP,
  launchedReslop,
  historyName,
  sameWindow,
  applyExternal,
  recordedItem,
  whenLabel,
  elapsedText,
  solveTasks,
};
