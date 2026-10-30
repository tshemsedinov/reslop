'use strict';

const { TaskItem, taskLines, FIELD_KEYS, PRIORITIES } = require('./task.js');
const { fenceOf } = require('./markdown.js');

// An issue imported into a plan becomes one task: its title, its kind and
// priority from labels, the known `key: value` lines of its body as fields,
// and everything else quoted under it. Imported text is data for the agent
// to read, never instructions to follow, so it stays quoted.

const LABEL_KINDS = [
  ['bugs', ['bug', 'defect', 'regression']],
  ['security', ['security', 'vulnerability']],
  ['features', ['enhancement', 'feature', 'feature request']],
  ['debt', ['refactor', 'refactoring', 'debt', 'tech debt', 'cleanup']],
  ['research', ['research', 'question', 'spike']],
];

// Older names an issue may use, read into the field that took them over
const FOLDED = { evidence: 'problem', constraints: 'do' };

// The fields an issue can fill; `result` is the agent's to write
const ISSUE_FIELDS = FIELD_KEYS.filter((key) => key !== 'result');
const READ_FIELDS = [...ISSUE_FIELDS, ...Object.keys(FOLDED)];

const FIELD_LINE = /^\s*(?:[-*]\s+)?\**([A-Za-z]+)\**\s*:\s*(.*)$/;

const labelNames = (labels) =>
  (labels ?? []).map((label) => `${label}`.trim().toLowerCase());

const issueKind = (labels) => {
  const names = labelNames(labels);
  for (const [kind, words] of LABEL_KINDS) {
    if (names.some((name) => words.includes(name))) return kind;
  }
  return 'improvements';
};

// An issue labelled critical or urgent is high: those are not priorities
const PRIORITY_ALIAS = { critical: 'high', urgent: 'high' };

const issuePriority = (labels) => {
  for (const name of labelNames(labels)) {
    const bare = name.replace(/^priority[:/\s-]*/, '');
    const priority = PRIORITY_ALIAS[bare] ?? bare;
    if (PRIORITIES.includes(priority)) return priority;
  }
  return '';
};

const fieldKey = (line) => {
  const match = FIELD_LINE.exec(line);
  if (!match) return null;
  const key = match[1].toLowerCase();
  return READ_FIELDS.includes(key) ? { key, first: match[2] } : null;
};

const dedent = (lines) => {
  let indent = Infinity;
  for (const line of lines) {
    if (!line.trim()) continue;
    indent = Math.min(indent, line.length - line.trimStart().length);
  }
  if (!Number.isFinite(indent)) return lines;
  return lines.map((line) => line.slice(indent));
};

const fieldValue = (first, rest) =>
  [first.trim(), ...dedent(rest)].join('\n').trim();

// The fields of an issue body and the lines that are not fields. A field
// goes on over indented and list lines up to a blank line or another field;
// fences around a structured block are dropped
const parseIssueBody = (body) => {
  const fields = new Map();
  const rest = [];
  let field = null;
  const close = () => {
    if (!field) return;
    const value = fieldValue(field.first, field.lines);
    if (value && !fields.has(field.key)) fields.set(field.key, value);
    field = null;
  };
  for (const line of `${body ?? ''}`.split(/\r?\n/)) {
    if (fenceOf(line)) continue;
    const found = fieldKey(line);
    if (found) {
      close();
      field = { ...found, lines: [] };
      continue;
    }
    const goesOn = /^(?:\s+\S|[-*]\s)/.test(line);
    if (field && goesOn) {
      field.lines.push(line);
      continue;
    }
    close();
    rest.push(line);
  }
  close();
  return { fields, rest };
};

const trimBlank = (lines) => {
  let start = 0;
  let end = lines.length;
  while (start < end && !lines[start].trim()) start += 1;
  while (end > start && !lines[end - 1].trim()) end -= 1;
  return lines.slice(start, end);
};

const quote = (lines) => lines.map((line) => (line ? `> ${line}` : '>'));

// What the issue and its comments said, quoted, author first
const quotedText = (issue, rest) => {
  const host = issue.host || 'remote';
  const said = [`@${issue.author || 'unknown'} at ${host}:`];
  const own = trimBlank(rest);
  if (own.length) said.push(...own);
  for (const comment of issue.comments ?? []) {
    const text = trimBlank(`${comment.body ?? ''}`.split(/\r?\n/));
    if (!text.length) continue;
    said.push('', `@${comment.author || 'unknown'} at ${host}:`, ...text);
  }
  return quote(said);
};

const withUrl = (related, url) => {
  if (!url || related.includes(url)) return related;
  return related ? `${url}, ${related}` : url;
};

// `evidence: ...` goes under the problem, `constraints: ...` under do
const foldFields = (fields) => {
  for (const [old, key] of Object.entries(FOLDED)) {
    const value = fields.get(old);
    if (!value) continue;
    const own = fields.get(key);
    fields.set(key, own ? `${own}\n${value}` : value);
    fields.delete(old);
  }
  return fields;
};

const issueTaskText = (issue) => {
  const { fields: read, rest } = parseIssueBody(issue.body);
  const fields = foldFields(read);
  fields.set('related', withUrl(fields.get('related') ?? '', issue.url));
  const priority = issuePriority(issue.labels);
  const head = priority ? `${priority}: ` : '';
  const title = `${issue.title ?? ''}`.replace(/\s+/g, ' ').trim();
  let lines = taskLines(`${head}${title || 'Untitled issue'}`, false);
  for (const key of ISSUE_FIELDS) {
    const value = fields.get(key);
    if (value) lines = new TaskItem(lines).setField(key, value);
  }
  const task = new TaskItem(lines).text;
  return [task, ...quotedText(issue, rest)].join('\n');
};

module.exports = {
  issueKind,
  issuePriority,
  parseIssueBody,
  issueTaskText,
};
