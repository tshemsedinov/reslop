'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { posixRel } = require('../common/files.js');

// Code locations in the `where` and `related` fields of a task: `path`,
// `path:line`, `path#symbol`, in backticks or not, in a list.

const TOKEN = /`([^`]+)`|[^\s,;`]+/g;

const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

const BARE_SCHEME = /^(?:file|mailto|javascript|data|vbscript):/i;

const TRAIL = /[.,;:)\]]+$/;

const LINE = /:(\d+)(?::\d+)?$/;

const EXTENSION = /\.[A-Za-z0-9]+(?:[:#]|$)/;

const isUrl = (token) => SCHEME.test(token) || BARE_SCHEME.test(token);

const looksLikePath = (token) =>
  token.includes('/') || token.includes('\\') || EXTENSION.test(token);

const parseToken = (raw) => {
  const token = raw.replace(TRAIL, '');
  if (!token) return null;
  if (isUrl(token)) return { raw, url: token };
  if (!looksLikePath(token)) return null;
  const hash = token.indexOf('#');
  const symbol = hash < 0 ? '' : token.slice(hash + 1);
  let file = hash < 0 ? token : token.slice(0, hash);
  const line = LINE.exec(file);
  if (line) file = file.slice(0, line.index);
  if (!file) return null;
  return { raw, path: file, line: line ? Number(line[1]) : 0, symbol };
};

const parseLocations = (value) => {
  const found = [];
  for (const match of `${value ?? ''}`.matchAll(TOKEN)) {
    const location = parseToken(match[1] ?? match[0]);
    if (location) found.push(location);
  }
  return found;
};

const refuse = (error) => ({ ok: false, error });

// A location as a path relative to the root, or why it is not opened
const resolveLocation = (root, location) => {
  if (!location) return refuse('no location');
  if (location.url) return refuse(`not opened: ${location.url}`);
  const file = location.path;
  const full = path.resolve(root, file);
  if (!fs.existsSync(full)) return refuse(`not found: ${file}`);
  const rel = posixRel(path.relative(root, full));
  return { ok: true, rel, line: location.line, symbol: location.symbol };
};

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const HEADING = /^#{1,6}\s+(.*?)\s*#*\s*$/;

// The anchor GitHub gives a Markdown heading
const slug = (text) =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s/g, '-');

const headingLine = (lines, anchor) =>
  lines.findIndex((line) => {
    const match = HEADING.exec(line);
    return match !== null && slug(match[1]) === anchor;
  });

// The line of a symbol such as `readLoop` or `TaskPage.rows`, or of a
// Markdown heading anchor: each part of a symbol is looked for after the
// line of the one before; -1 when one is missing
const symbolLine = (text, symbol) => {
  const lines = `${text ?? ''}`.split('\n');
  const heading = headingLine(lines, symbol.toLowerCase());
  if (heading >= 0) return heading;
  let from = 0;
  for (const part of symbol.split('.').filter(Boolean)) {
    const word = new RegExp(`\\b${escapeRegExp(part)}\\b`);
    let at = from;
    while (at < lines.length && !word.test(lines[at])) at += 1;
    if (at >= lines.length) return -1;
    from = at;
  }
  return from;
};

module.exports = { parseLocations, resolveLocation, symbolLine };
