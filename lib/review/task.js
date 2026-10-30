'use strict';

const { TASK_FIELDS } = require('../common/files.js');
const { bare, isBlank } = require('./markdown.js');

const ITEM_HEAD = /^([-*+]) \[([ xX])\](?:[ \t](.*))?$/;

// `B1 high: title`, `F1: title`, `f1 title`, `high: title`, or a title
const TITLE =
  /^(?:([A-Za-z]\d+)(?::[ \t]*|[ \t]+|$))?(?:(critical|high|low):[ \t]*)?/i;

const FIELD = /^- ([a-z][a-z0-9_-]*):(?:[ \t](.*)|[ \t]*)$/;

const CHECK = /^(\s*)- \[([ xX])\](?:[ \t](.*))?$/;

const LEAD = /^[ \t]*/;

const DEFAULT_INDENT = '  ';

const PRIORITIES = ['critical', 'high', 'low'];

const FIELD_KEYS = TASK_FIELDS.map((field) => field.key);

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

const parseTitle = (rest) => {
  const match = TITLE.exec(rest);
  const head = match[0];
  return {
    id: match[1] ?? '',
    priority: (match[2] ?? '').toLowerCase(),
    head,
    title: rest.slice(head.length),
  };
};

const makeHead = (id, priority) => {
  if (!id && !priority) return '';
  if (!priority) return `${id}: `;
  return id ? `${id} ${priority}: ` : `${priority}: `;
};

// Where a field goes: after the nearest field before it in the vocabulary
const fieldRank = (key) => {
  const at = FIELD_KEYS.indexOf(key);
  return at < 0 ? FIELD_KEYS.length : at;
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
    Object.assign(this, parseTitle(this.rest));
    this.body = lines.slice(1).map(bare);
    this.indent = bodyIndent(this.body);
    this.fields = this.parseFields();
    this.checks = this.parseChecks();
  }

  get done() {
    return isDoneMark(this.mark);
  }

  get text() {
    const body = this.body.map((line) => dropIndent(line, this.indent));
    return [this.rest, ...body].join('\n').trim();
  }

  // Whether a body line starts at the body indent, where fields start
  isOwnLine(line) {
    if (!line.startsWith(this.indent)) return false;
    return !/^\s/.test(line.slice(this.indent.length));
  }

  // Fields as { key, value, start, end }; start and end are block lines
  parseFields() {
    const fields = [];
    let field = null;
    for (let i = 0; i < this.body.length; i++) {
      const line = this.body[i];
      if (isBlank(line)) continue;
      if (!this.isOwnLine(line)) {
        if (field) field.end = i + 2;
        continue;
      }
      const match = FIELD.exec(line.slice(this.indent.length));
      field = match ? { key: match[1], start: i + 1, end: i + 2 } : null;
      if (field) fields.push(field);
    }
    for (const entry of fields) entry.value = this.fieldValue(entry);
    return fields;
  }

  fieldValue(field) {
    const head = bare(this.lines[field.start]).slice(this.indent.length);
    const first = FIELD.exec(head)[2] ?? '';
    const rest = this.lines.slice(field.start + 1, field.end).map(bare);
    const inner = bodyIndent(rest);
    const lines = rest.map((line) => dropIndent(line, inner));
    return [first, ...lines].join('\n').trim();
  }

  parseChecks() {
    const field = this.field('check');
    if (!field) return [];
    const checks = [];
    for (let line = field.start + 1; line < field.end; line++) {
      const match = CHECK.exec(bare(this.lines[line]));
      if (!match) continue;
      checks.push({
        done: isDoneMark(match[2]),
        text: (match[3] ?? '').trim(),
        line,
      });
    }
    return checks;
  }

  field(key) {
    return this.fields.find((entry) => entry.key === key) ?? null;
  }

  value(key) {
    const field = this.field(key);
    return field ? field.value : '';
  }

  out(line) {
    return this.cr ? `${line}\r` : line;
  }

  headLine(mark, rest) {
    const tail = rest === '' ? '' : ` ${rest}`;
    return this.out(`${this.bullet} [${mark}]${tail}`);
  }

  setDone(done) {
    if (this.done === done) return this.lines;
    const mark = done ? 'x' : ' ';
    return [this.headLine(mark, this.rest), ...this.lines.slice(1)];
  }

  setTitle(title) {
    const rest = `${this.head}${title}`;
    return [this.headLine(this.mark, rest), ...this.lines.slice(1)];
  }

  setHead(id, priority) {
    const rest = `${makeHead(id, priority)}${this.title}`;
    return [this.headLine(this.mark, rest), ...this.lines.slice(1)];
  }

  setId(id) {
    return this.setHead(id, this.priority);
  }

  setPriority(priority) {
    const next = PRIORITIES.includes(priority) ? priority : '';
    return this.setHead(this.id, next);
  }

  // A value that starts with a list goes under the key, like `check`
  fieldLines(key, value) {
    const text = `${value}`.trim();
    const list = text.startsWith('- ');
    const [first = '', ...rest] = (list ? `\n${text}` : text).split('\n');
    const lead = first ? `- ${key}: ${first}` : `- ${key}:`;
    const lines = [this.out(`${this.indent}${lead}`)];
    for (const line of rest) {
      lines.push(this.out(line ? `${this.indent}  ${line}` : ''));
    }
    return lines;
  }

  // The block line a new field goes before
  fieldSlot(key) {
    const rank = fieldRank(key);
    let after = null;
    for (const field of this.fields) {
      if (fieldRank(field.key) <= rank) after = field;
    }
    if (after) return after.end;
    const first = this.fields[0];
    if (first) return first.start;
    let end = this.lines.length;
    while (end > 1 && isBlank(this.lines[end - 1])) end -= 1;
    return end;
  }

  // An empty value drops the field
  setField(key, value) {
    const text = `${value ?? ''}`.trim();
    const field = this.field(key);
    const lines = [...this.lines];
    const fresh = text ? this.fieldLines(key, text) : [];
    if (field) {
      lines.splice(field.start, field.end - field.start, ...fresh);
      return lines;
    }
    if (!text) return lines;
    lines.splice(this.fieldSlot(key), 0, ...fresh);
    return lines;
  }

  setCheck(index, done) {
    const check = this.checks[index];
    if (!check || check.done === done) return this.lines;
    const lines = [...this.lines];
    const line = bare(lines[check.line]);
    const match = CHECK.exec(line);
    const mark = done ? 'x' : ' ';
    const at = match[1].length + 3;
    lines[check.line] = this.out(
      `${line.slice(0, at)}${mark}${line.slice(at + 1)}`,
    );
    return lines;
  }

  // The lines for a new text; a line that reads the same keeps its bytes
  withText(text) {
    const [first = '', ...rest] = `${text ?? ''}`.trim().split('\n');
    const lines = [this.headLine(this.mark, first)];
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

module.exports = {
  TaskItem,
  taskLines,
  parseTitle,
  isDoneMark,
  PRIORITIES,
  FIELD_KEYS,
};
