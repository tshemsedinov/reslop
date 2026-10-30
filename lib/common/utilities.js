'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { split, jsonParse } = require('metautil');

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

const cmpEn = new Intl.Collator('en').compare;

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

// Calls fn for each item, with at most `limit` calls running at a time
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
  const count = Math.min(limit, list.length);
  await Promise.all(Array.from({ length: count }, worker));
  return results;
};

const pad2 = (n) => `${n}`.padStart(2, '0');

const dateStamp = (date) => {
  const month = pad2(date.getMonth() + 1);
  return `${date.getFullYear()}-${month}-${pad2(date.getDate())}`;
};

module.exports = {
  parseVersion,
  cmpVersion,
  toInt,
  clamp,
  cmpEn,
  resource,
  relInside,
  readText,
  readJson,
  writeJson,
  listDir,
  errorMessage,
  listOf,
  trimText,
  unique,
  oneLine,
  flatText,
  asText,
  withNewline,
  withNotice,
  unquote,
  mapLimit,
  pad2,
  dateStamp,
};
