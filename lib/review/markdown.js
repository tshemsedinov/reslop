'use strict';

// A Markdown file as a list of blocks that print back to the same bytes.
// Lines keep their own `\r`, so CRLF, mixed ends, and a missing final
// newline survive a parse and print untouched.

const HEADING = /^(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;

const CLOSING_HASHES = /(?:^|[ \t]+)#+$/;

const ITEM = /^[-*+] \[[ xX]\](?:[ \t]|$)/;

const CODE_ITEM = /^- \[([ xX])\] code `([^`]+)`\s*$/;

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;

const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

const INDENTED = /^(?: {2}|\t)/;

const bare = (line) => (line.endsWith('\r') ? line.slice(0, -1) : line);

const isBlank = (line) => bare(line).trim() === '';

// The text of a block without its line ends
const blockText = (block) => block.lines.map(bare).join('\n');

const fenceOf = (line) => {
  const match = FENCE_OPEN.exec(bare(line));
  if (!match) return null;
  const mark = match[1];
  if (mark[0] === '`' && match[2].includes('`')) return null;
  return { char: mark[0], size: mark.length, info: match[2].trim() };
};

const closesFence = (line, fence) => {
  const match = FENCE_CLOSE.exec(bare(line));
  if (!match) return false;
  return match[1][0] === fence.char && match[1].length >= fence.size;
};

const headingOf = (line) => {
  const match = HEADING.exec(bare(line));
  if (!match) return null;
  const text = (match[2] ?? '').replace(CLOSING_HASHES, '').trim();
  return { level: match[1].length, text };
};

const isItemLine = (line) => ITEM.test(bare(line));

// The line after the fence that opens at `at`, or the end of the text
const scanFence = (lines, at, fence, trim) => {
  for (let i = at + 1; i < lines.length; i++) {
    const line = trim ? lines[i].trimStart() : lines[i];
    if (closesFence(line, fence)) return i + 1;
  }
  return lines.length;
};

// A checkbox item owns indented and blank lines up to the next unindented
// one; blank lines at its end belong to the gap after it
const scanItem = (lines, at) => {
  let i = at + 1;
  let end = i;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) {
      i += 1;
      continue;
    }
    if (!INDENTED.test(line)) break;
    const fence = fenceOf(line.trimStart());
    i = fence ? scanFence(lines, i, fence, true) : i + 1;
    end = i;
  }
  return end;
};

// A code proposal is a checkbox followed by an unindented fence
const scanCodeItem = (lines, at) => {
  let i = at + 1;
  while (i < lines.length && isBlank(lines[i])) i += 1;
  const fence = i < lines.length ? fenceOf(lines[i]) : null;
  if (!fence) return scanItem(lines, at);
  return scanFence(lines, i, fence, false);
};

const startsBlock = (line) => {
  if (isBlank(line)) return true;
  if (headingOf(line) || isItemLine(line)) return true;
  return fenceOf(line) !== null;
};

// A line that starts an item of a plain list, `- x`, `* x`, or `1. x`
const LIST_LINE = /^\s*(?:[-*+]|\d+[.)])\s+\S/;

// A paragraph, or one item of a plain list with the lines that go on it;
// the next item is a block of its own, so each can be edited alone
const scanText = (lines, at) => {
  let i = at + 1;
  while (i < lines.length && !startsBlock(lines[i])) {
    if (LIST_LINE.test(bare(lines[i]))) break;
    i += 1;
  }
  return i;
};

const scanBlank = (lines, at) => {
  let i = at + 1;
  while (i < lines.length && isBlank(lines[i])) i += 1;
  return i;
};

const frontmatterEnd = (lines) => {
  if (!lines.length || bare(lines[0]) !== '---') return 0;
  for (let i = 1; i < lines.length; i++) {
    if (bare(lines[i]) === '---') return i + 1;
  }
  return 0;
};

const FIELD_LINE = /^([A-Za-z][\w-]*):\s?(.*)$/;

const frontmatterFields = (lines) => {
  const fields = {};
  for (const line of lines.slice(1, -1)) {
    const match = FIELD_LINE.exec(bare(line));
    if (match) fields[match[1]] = match[2].trim();
  }
  return fields;
};

const splitLines = (text) => {
  if (text === '') return { lines: [], final: true };
  const final = text.endsWith('\n');
  const body = final ? text.slice(0, -1) : text;
  return { lines: body.split('\n'), final };
};

const detectEol = (text) => {
  const at = text.indexOf('\n');
  return at > 0 && text[at - 1] === '\r' ? '\r\n' : '\n';
};

const nextBlock = (lines, at) => {
  const line = lines[at];
  if (isBlank(line)) return { type: 'blank', end: scanBlank(lines, at) };
  const heading = headingOf(line);
  if (heading) return { type: 'heading', end: at + 1 };
  if (CODE_ITEM.test(bare(line))) {
    return { type: 'item', end: scanCodeItem(lines, at), code: true };
  }
  if (isItemLine(line)) return { type: 'item', end: scanItem(lines, at) };
  const fence = fenceOf(line);
  if (fence) {
    const end = scanFence(lines, at, fence, false);
    return { type: 'text', end, fence: true };
  }
  return { type: 'text', end: scanText(lines, at) };
};

class MarkdownDoc {
  constructor(eol = '\n', final = true) {
    this.eol = eol;
    this.final = final;
    this.blocks = [];
    this.nextId = 1;
    this.version = 0;
    this.laidOut = -1;
  }

  static parse(text) {
    const source = `${text ?? ''}`;
    const { lines, final } = splitLines(source);
    const doc = new MarkdownDoc(detectEol(source), final);
    let at = frontmatterEnd(lines);
    if (at) doc.blocks.push(doc.block('frontmatter', lines.slice(0, at)));
    while (at < lines.length) {
      const found = nextBlock(lines, at);
      const block = doc.block(found.type, lines.slice(at, found.end));
      if (found.code) block.code = true;
      if (found.fence) block.fence = true;
      doc.blocks.push(block);
      at = found.end;
    }
    return doc;
  }

  block(type, lines) {
    const block = { type, lines, id: this.nextId, start: 0, heading: null };
    this.nextId += 1;
    if (type === 'heading') Object.assign(block, headingOf(lines[0]));
    return block;
  }

  // A new line in the file's own line ending
  line(text) {
    return this.eol === '\r\n' ? `${text}\r` : text;
  }

  toString() {
    const lines = [];
    for (const block of this.blocks) lines.push(...block.lines);
    if (!lines.length) return '';
    return lines.join('\n') + (this.final ? '\n' : '');
  }

  get frontmatter() {
    const first = this.blocks[0];
    return first && first.type === 'frontmatter' ? first : null;
  }

  frontmatterFields() {
    const block = this.frontmatter;
    return block ? frontmatterFields(block.lines) : {};
  }

  touch() {
    this.version += 1;
  }

  // The first line and the owning heading of every block
  layout() {
    if (this.laidOut === this.version) return this.blocks;
    let line = 0;
    let heading = null;
    for (const block of this.blocks) {
      block.start = line;
      line += block.lines.length;
      block.heading = heading;
      if (block.type === 'heading') heading = block;
    }
    this.laidOut = this.version;
    return this.blocks;
  }

  indexOf(block) {
    return this.blocks.indexOf(block);
  }

  byId(id) {
    return this.blocks.find((block) => block.id === id) ?? null;
  }

  replace(block, lines) {
    const same =
      block.lines.length === lines.length &&
      block.lines.every((line, i) => line === lines[i]);
    if (same) return false;
    block.lines = lines;
    if (block.type === 'heading') Object.assign(block, headingOf(lines[0]));
    this.touch();
    return true;
  }

  insert(at, block) {
    const index = Math.max(0, Math.min(at, this.blocks.length));
    this.blocks.splice(index, 0, block);
    this.touch();
    return block;
  }

  remove(block) {
    const at = this.indexOf(block);
    if (at < 0) return false;
    this.blocks.splice(at, 1);
    this.touch();
    return true;
  }
}

// The frontmatter fields of a text, read without parsing the rest
const textFrontmatter = (text) => {
  const { lines } = splitLines(`${text ?? ''}`);
  const end = frontmatterEnd(lines);
  return end ? frontmatterFields(lines.slice(0, end)) : {};
};

module.exports = {
  MarkdownDoc,
  CODE_ITEM,
  bare,
  isBlank,
  blockText,
  headingOf,
  fenceOf,
  closesFence,
  textFrontmatter,
};
