'use strict';

const path = require('node:path');
const { isHashObject } = require('metautil');

const TITLE_MAX = 200;
const TOOL_MARK = { completed: '✔', failed: '✖' };
const RUNNING_MARK = '▸';
const THOUGHT_MARK = '│ ';
const WRITE_KINDS = ['edit', 'delete', 'move'];
const CHUNK_KIND = new Map([
  ['agent_message_chunk', 'text'],
  ['agent_thought_chunk', 'thought'],
]);

const oneLine = (text) => {
  const line = `${text ?? ''}`.replace(/\s+/g, ' ').trim();
  return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1)}…` : line;
};

const chunkText = (content) => {
  if (!isHashObject(content)) return '';
  return content.type === 'text' ? `${content.text ?? ''}` : '';
};

const quoted = (text) =>
  text
    .replace(/\n+$/, '')
    .split('\n')
    .map((line) => `${THOUGHT_MARK}${line}`)
    .join('\n');

const FACE = {
  text: (block) => block.text.replace(/\n+$/, ''),
  thought: (block) => quoted(block.text),
  note: (block) => `△ ${block.text}`,
  tool: (block) => {
    const title = block.title || block.tool || 'tool';
    if (block.denied) return `${TOOL_MARK.failed} denied: ${title}`;
    return `${TOOL_MARK[block.status] ?? RUNNING_MARK} ${title}`;
  },
};

// The session updates of a run as the text its log shows
class Transcript {
  constructor(root = '') {
    // Agents name files by full path: inside the repository it is noise
    this.prefix = root ? `${root}${path.sep}` : '';
    this.blocks = [];
    this.tools = new Map();
    this.files = new Set();
    this.tokens = null;
    this.cache = null;
  }

  add(block) {
    this.blocks.push(block);
    this.cache = null;
    return block;
  }

  note(text) {
    const line = oneLine(text);
    if (line) this.add({ kind: 'note', text: line });
  }

  fail(error) {
    const text = `${(error && error.message) || error || 'failed'}`.trim();
    this.add({ kind: 'text', text: `✖ ${text}` });
  }

  write(kind, text) {
    if (!text) return;
    const last = this.blocks.at(-1);
    if (last && last.kind === kind) last.text += text;
    else this.add({ kind, text });
    this.cache = null;
  }

  title(text) {
    const line = this.prefix ? text.replaceAll(this.prefix, '') : text;
    return oneLine(line);
  }

  deny(call) {
    this.tool(call).denied = true;
  }

  tool(update) {
    const id = `${update.toolCallId ?? ''}`;
    const known = this.tools.get(id);
    const block = known ?? this.add({ kind: 'tool', title: '', status: '' });
    if (!known) this.tools.set(id, block);
    const { title, status, kind } = update;
    if (typeof title === 'string') block.title = this.title(title);
    if (typeof status === 'string') block.status = status;
    if (typeof kind === 'string') block.tool = kind;
    this.cache = null;
    if (!WRITE_KINDS.includes(block.tool)) return block;
    const listed = Array.isArray(update.locations) ? update.locations : [];
    for (const location of listed) {
      const file = isHashObject(location) ? location.path : '';
      if (file) this.files.add(file);
    }
    return block;
  }

  update(update) {
    if (!isHashObject(update)) return;
    const type = update.sessionUpdate;
    const kind = CHUNK_KIND.get(type);
    if (kind) return void this.write(kind, chunkText(update.content));
    if (type === 'tool_call' || type === 'tool_call_update') {
      return void this.tool(update);
    }
    if (type !== 'usage_update') return;
    if (Number.isFinite(update.used)) this.tokens = update.used;
  }

  text() {
    if (this.cache !== null) return this.cache;
    let out = '';
    let prev = '';
    for (const block of this.blocks) {
      const face = FACE[block.kind](block);
      if (!face) continue;
      const joined = prev === 'tool' && block.kind === 'tool';
      if (out) out += joined ? '\n' : '\n\n';
      out += face;
      prev = block.kind;
    }
    this.cache = out ? `${out}\n` : '';
    return this.cache;
  }
}

module.exports = { Transcript };
