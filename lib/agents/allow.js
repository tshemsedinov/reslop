'use strict';

const path = require('node:path');
const { isHashObject } = require('metautil');
const { trimText } = require('../common/utilities.js');

const { commands: COMMANDS, filters: FILTERS } = require('./allow.json');

const ALLOWED = new Set([...COMMANDS, ...FILTERS]);
const READ_KINDS = ['read', 'search', 'think'];
const WRITE_KINDS = ['edit', 'delete', 'move'];
const SHELLS = ['sh', 'bash', 'zsh'];
const HEREDOC = /<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n[ \t]*\2(?=\s|\)|$)/g;
// Output to the terminal or nowhere is the only redirect that writes nothing
const QUIET_REDIRECT = /&?\d?>&\d|&?\d?>>?\s*\/dev\/null/g;
const SEPARATOR = /&&|\|\||\$\(|[;|&\n()`]/;
const QUOTE = String.fromCharCode(39);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/;

const shellScript = (argv) => {
  const parts = argv.map((part) => `${part ?? ''}`);
  const isShell = SHELLS.includes(path.basename(parts[0] ?? ''));
  const flag = parts.findIndex((part) => /^-[a-z]*c$/.test(part));
  if (isShell && flag > 0 && parts[flag + 1]) return parts[flag + 1];
  return parts.join(' ');
};

const commandOf = (call) => {
  const input = isHashObject(call.rawInput) ? call.rawInput : {};
  const raw = input.command ?? input.cmd;
  if (Array.isArray(raw)) return shellScript(raw);
  if (typeof raw === 'string' && raw.trim()) return raw;
  return trimText(call.title).replace(/^`+|`+$/g, '');
};

// Quoted text is data, except a substitution inside double quotes
class ShellScan {
  constructor(script) {
    this.script = script;
    this.at = 0;
    this.code = '';
  }

  single() {
    const end = this.script.indexOf(QUOTE, this.at + 1);
    this.at = end < 0 ? this.script.length : end + 1;
    this.code += '_';
  }

  substitution(close, open) {
    const end = this.script.indexOf(close, this.at + open.length);
    const stop = end < 0 ? this.script.length : end;
    this.code += ` ${this.script.slice(this.at, stop)}${close} `;
    this.at = stop + 1;
  }

  double() {
    const { script } = this;
    this.at += 1;
    this.code += '_';
    while (this.at < script.length && script[this.at] !== '"') {
      const char = script[this.at];
      if (char === '\\') this.at += 2;
      else if (char === '`') this.substitution('`', '`');
      else if (script.startsWith('$(', this.at)) this.substitution(')', '$(');
      else this.at += 1;
    }
    this.at += 1;
  }

  plain(char) {
    const escaped = char === '\\';
    this.code += escaped ? '_' : char;
    this.at += escaped ? 2 : 1;
  }

  run() {
    const { script } = this;
    while (this.at < script.length) {
      const char = script[this.at];
      if (char === QUOTE) this.single();
      else if (char === '"') this.double();
      else this.plain(char);
    }
    return this.code;
  }
}

const binaryOf = (segment) => {
  let rest = segment.trim();
  while (ASSIGNMENT.test(rest)) rest = rest.replace(ASSIGNMENT, '');
  const word = rest.split(/\s+/)[0] ?? '';
  return path.basename(word);
};

// An agent that may run node can run anything, so this is no sandbox: it stops
// a run from reaching for tools that executing a plan does not need
const commandAllowed = (command) => {
  const script = `${command ?? ''}`.replace(HEREDOC, ' ');
  const code = new ShellScan(script).run().replace(QUIET_REDIRECT, ' ');
  if (code.includes('>')) return false;
  const segments = code.split(SEPARATOR).map((part) => part.trim());
  const named = segments.filter(Boolean);
  return named.length > 0 && named.every((part) => ALLOWED.has(binaryOf(part)));
};

const inside = (root, file) => {
  const rel = path.relative(root, path.resolve(root, file));
  return !rel.startsWith('..') && !path.isAbsolute(rel);
};

const pathsOf = (call) => {
  const listed = Array.isArray(call.locations) ? call.locations : [];
  const paths = [];
  for (const location of listed) {
    const file = isHashObject(location) ? location.path : '';
    if (typeof file === 'string' && file) paths.push(file);
  }
  return paths;
};

const callAllowed = (call, root) => {
  const kind = `${call.kind ?? ''}`;
  if (READ_KINDS.includes(kind)) return true;
  if (kind === 'execute') return commandAllowed(commandOf(call));
  if (!WRITE_KINDS.includes(kind)) return false;
  const paths = pathsOf(call);
  return paths.length > 0 && paths.every((file) => inside(root, file));
};

const optionId = (options, kinds) => {
  for (const kind of kinds) {
    const found = options.find((option) => option.kind === kind);
    if (found) return found.optionId;
  }
  return null;
};

// A run has nobody to ask: edits in the repository and the commands a plan
// needs are approved for one call, everything else is refused
const decidePermission = (params, root) => {
  const call = isHashObject(params.toolCall) ? params.toolCall : {};
  const listed = Array.isArray(params.options) ? params.options : [];
  const options = listed.filter(isHashObject);
  const allowed = callAllowed(call, root);
  const kinds = allowed
    ? ['allow_once', 'allow_always']
    : ['reject_once', 'reject_always'];
  const id = optionId(options, kinds);
  if (id === null) return { allowed: false, outcome: { outcome: 'cancelled' } };
  return { allowed, outcome: { outcome: 'selected', optionId: id } };
};

module.exports = {
  COMMANDS,
  commandOf,
  commandAllowed,
  callAllowed,
  decidePermission,
};
