'use strict';

const { bare, isBlank } = require('./markdown.js');

const ITEM_HEAD = /^([-*+]) \[([ xX])\](?:[ \t](.*))?$/;

const LEAD = /^[ \t]*/;

const DEFAULT_INDENT = '  ';

const isDoneMark = (mark) => mark === 'x' || mark === 'X';

// The shortest indent of the body lines, the one the text drops and adds
const bodyIndent = (lines) => {
  let indent = null;
  for (const line of lines) {
    if (isBlank(line)) continue;
    const lead = LEAD.exec(line)[0];
    if (indent === null || lead.length < indent.length) indent = lead;
  }
  return indent || DEFAULT_INDENT;
};

const dropIndent = (line, indent) => {
  if (line.startsWith(indent)) return line.slice(indent.length);
  return line.trimStart();
};

// A view over the lines of one task block. Setters return new lines and
// copy every line they do not own.
class TaskItem {
  constructor(lines) {
    this.lines = lines;
    this.cr = lines[0].endsWith('\r');
    const head = ITEM_HEAD.exec(bare(lines[0])) ?? ['', '-', ' ', ''];
    this.bullet = head[1];
    this.mark = head[2];
    this.rest = head[3] ?? '';
    this.body = lines.slice(1).map(bare);
    this.indent = bodyIndent(this.body);
  }

  get done() {
    return isDoneMark(this.mark);
  }

  get text() {
    const body = this.body.map((line) => dropIndent(line, this.indent));
    return [this.rest, ...body].join('\n').trim();
  }

  out(line) {
    return this.cr ? `${line}\r` : line;
  }

  head(mark, rest) {
    const tail = rest === '' ? '' : ` ${rest}`;
    return this.out(`${this.bullet} [${mark}]${tail}`);
  }

  setDone(done) {
    if (this.done === done) return this.lines;
    const mark = done ? 'x' : ' ';
    return [this.head(mark, this.rest), ...this.lines.slice(1)];
  }

  // The lines for a new text; a line that reads the same keeps its bytes
  withText(text) {
    const [first = '', ...rest] = `${text ?? ''}`.trim().split('\n');
    const lines = [this.head(this.mark, first)];
    const old = this.lines.slice(1);
    for (let i = 0; i < rest.length; i++) {
      const line = rest[i];
      const prev = old[i];
      if (prev !== undefined && dropIndent(bare(prev), this.indent) === line) {
        lines.push(prev);
        continue;
      }
      lines.push(this.out(line ? `${this.indent}${line}` : ''));
    }
    return lines;
  }
}

const taskLines = (text, done, cr = false) => {
  const mark = done ? 'x' : ' ';
  const item = new TaskItem([cr ? `- [${mark}]\r` : `- [${mark}]`]);
  return item.withText(text);
};

module.exports = { TaskItem, taskLines, isDoneMark };
