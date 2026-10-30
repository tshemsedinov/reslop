'use strict';

const { FIELD_KEYS, PRIORITIES } = require('./task.js');

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

// The fields an issue can fill; `result` is the agent's to write
const ISSUE_FIELDS = FIELD_KEYS.filter((key) => key !== 'result');

const FIELD_LINE = /^\s*(?:[-*]\s+)?\**([A-Za-z]+)\**\s*:\s*(.*)$/;

const FENCE = /^\s*(?:`{3,}|~{3,})/;

const CHECKBOX = /^\[[ xX]\] /;

const labelNames = (labels) =>
  (labels ?? []).map((label) => `${label}`.trim().toLowerCase());

const issueKind = (labels) => {
  const names = labelNames(labels);
  for (const [kind, words] of LABEL_KINDS) {
    if (names.some((name) => words.includes(name))) return kind;
  }
  return 'improvements';
};

const issuePriority = (labels) => {
  for (const name of labelNames(labels)) {
    const bare = name.replace(/^priority[:/\s-]*/, '');
    if (PRIORITIES.includes(bare)) return bare;
  }
  return '';
};

const fieldKey = (line) => {
  const match = FIELD_LINE.exec(line);
  if (!match) return null;
  const key = match[1].toLowerCase();
  return ISSUE_FIELDS.includes(key) ? { key, first: match[2] } : null;
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

// A check list is a checkbox list, whatever bullets the issue used
const checkValue = (lines) =>
  lines.map((line) => {
    const item = /^[-*]\s+(.*)$/.exec(line);
    if (!item) return line;
    return CHECKBOX.test(item[1]) ? `- ${item[1]}` : `- [ ] ${item[1]}`;
  });

const fieldValue = (key, first, rest) => {
  const lines = dedent(rest);
  const body = key === 'check' ? checkValue(lines) : lines;
  return [first.trim(), ...body].join('\n').trim();
};

// The fields of an issue body and the lines that are not fields. A field
// goes on over indented and list lines up to a blank line or another field;
// fences around a structured block are dropped
const parseIssueBody = (body) => {
  const fields = new Map();
  const rest = [];
  let field = null;
  const close = () => {
    if (!field) return;
    const value = fieldValue(field.key, field.first, field.lines);
    if (value && !fields.has(field.key)) fields.set(field.key, value);
    field = null;
  };
  for (const line of `${body ?? ''}`.split(/\r?\n/)) {
    if (FENCE.test(line)) continue;
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

const issueTaskText = (issue) => {
  const { fields, rest } = parseIssueBody(issue.body);
  fields.set('related', withUrl(fields.get('related') ?? '', issue.url));
  const priority = issuePriority(issue.labels);
  const head = priority ? `${priority}: ` : '';
  const title = `${issue.title ?? ''}`.replace(/\s+/g, ' ').trim();
  const lines = [`${head}${title || 'Untitled issue'}`];
  for (const key of ISSUE_FIELDS) {
    const value = fields.get(key);
    if (!value) continue;
    const [first, ...more] = value.split('\n');
    const list = first.startsWith('- ');
    lines.push(list ? `- ${key}:` : `- ${key}: ${first}`);
    for (const line of list ? value.split('\n') : more) {
      lines.push(line ? `  ${line}` : '');
    }
  }
  lines.push(...quotedText(issue, rest));
  return lines.join('\n');
};

module.exports = {
  issueKind,
  issuePriority,
  parseIssueBody,
  issueTaskText,
};
