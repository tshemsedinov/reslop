'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { split, jsonParse } = require('metautil');

const cmpEn = new Intl.Collator('en').compare;

const parseVersion = (text) => {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(`${text ?? ''}`);
  if (!match) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  return { major, minor, patch };
};

const cmpVersion = (left, right) => {
  const major = left.major - right.major;
  const minor = left.minor - right.minor;
  const patch = left.patch - right.patch;
  return major || minor || patch;
};

const toInt = (text) => parseInt(text, 10);

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

const resource = (dir, name) => fs.readFileSync(path.join(dir, name), 'utf8');

// The path of a file under root, '' for root itself, or null for a path
// outside of it; a name like `..x` is still inside
const relInside = (root, file) => {
  const rel = path.relative(root, file);
  const up = rel === '..' || rel.startsWith(`..${path.sep}`);
  return up || path.isAbsolute(rel) ? null : rel;
};

const readText = (file) => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
};

const readJson = (file) => jsonParse(readText(file));

const writeJson = (file, data) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
};

const listDir = (dir) => {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
};

const listEntries = (dir) => {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
};

const errorMessage = (reason) => {
  if (reason instanceof Error) return reason.message;
  return `${reason ?? ''}`;
};

const listOf = (value) => (Array.isArray(value) ? value : []);

const trimText = (value) => `${value ?? ''}`.trim();

const unique = (values) => [...new Set(values.filter(Boolean))];

const oneLine = (text, fallback = '') => {
  const body = `${text ?? ''}`.trim();
  const first = split(body, '\n')[0];
  return first || fallback;
};

// The text on one line with single spaces, cut with … past max characters
const flatText = (text, max = Infinity) => {
  const line = `${text ?? ''}`.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

const withNewline = (text) => {
  const body = `${text ?? ''}`;
  return !body || body.endsWith('\n') ? body : `${body}\n`;
};

const withNotice = (text, notice) => {
  const body = `${text ?? ''}`;
  if (body.endsWith(`${notice}\n`)) return body;
  return `${withNewline(body)}${notice}\n`;
};

const asText = (value) => (typeof value === 'string' ? value : '');

const unquote = (value) => {
  const text = `${value ?? ''}`;
  if (text.length < 2) return text;
  const open = text[0];
  const quoted = open === text.at(-1) && (open === '"' || open === '\x27');
  return quoted ? text.slice(1, -1) : text;
};

const mapLimit = async (list, limit, fn) => {
  const results = new Array(list.length);
  let next = 0;
  const worker = async () => {
    while (next < list.length) {
      const index = next;
      next += 1;
      results[index] = await fn(list[index]);
    }
  };
  const length = Math.min(limit, list.length);
  await Promise.all(Array.from({ length }, worker));
  return results;
};

const changedSpan = (base, next) => {
  const limit = Math.min(base.length, next.length);
  let start = 0;
  while (start < limit && base[start] === next[start]) start += 1;
  let tail = 0;
  const room = limit - start;
  while (tail < room && base.at(-1 - tail) === next.at(-1 - tail)) tail += 1;
  return {
    start,
    end: base.length - tail,
    text: next.slice(start, next.length - tail),
  };
};

// Both edits of base in one text, or null when their spans overlap or touch
const mergeTexts = (base, ours, theirs) => {
  const one = changedSpan(base, ours);
  const two = changedSpan(base, theirs);
  if (one.end >= two.start && two.end >= one.start) return null;
  const pair = one.start < two.start ? [one, two] : [two, one];
  const first = pair[0];
  const last = pair[1];
  return [
    base.slice(0, first.start),
    first.text,
    base.slice(first.end, last.start),
    last.text,
    base.slice(last.end),
  ].join('');
};

const pad2 = (value) => `${value}`.padStart(2, '0');

const dateStamp = (date) => {
  const month = pad2(date.getMonth() + 1);
  return `${date.getFullYear()}-${month}-${pad2(date.getDate())}`;
};

module.exports = {
  cmpEn,
  parseVersion,
  cmpVersion,
  toInt,
  clamp,
  resource,
  relInside,
  readText,
  readJson,
  writeJson,
  listDir,
  listEntries,
  errorMessage,
  listOf,
  trimText,
  unique,
  oneLine,
  flatText,
  withNewline,
  withNotice,
  asText,
  unquote,
  mapLimit,
  mergeTexts,
  pad2,
  dateStamp,
};
