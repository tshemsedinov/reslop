'use strict';

const { jsonParse, isHashObject } = require('metautil');
const { stripAnsi } = require('../term/ansi.js');
const { trimText } = require('../common/utilities.js');

const MODEL_ID = /^[A-Za-z][A-Za-z0-9_./:+#-]*$/;
const SKIP_TOKEN = new RegExp(
  '^(no|available|loading|fetching|usage|help|try|tip|error|' +
    'warning|command|commands|options|flag|version|' +
    'unknown|invalid)$',
  'i',
);
const CURSOR_ROW = /^([A-Za-z][A-Za-z0-9_./:+#-]*)\s+-\s+\S/;
const CURSOR_NOISE = /^(?:loading models|available models$|tip:|no models)/i;
const AVAILABLE_LINE = /^Available models:\s*(.+)$/i;
const WIDE_LABEL = /\b1M\b/;
const CONTEXT_TAG = /\[context=[^\]]*\]$/;
// list-models repeats one slug for every context, so 500k is unlabeled
const MODEL_CONTEXTS = {
  'grok-4.7': ['256k', '500k'],
};
const JSON_KEYS = ['slug', 'id', 'model', 'modelID', 'name'];
const OPTION_LINE = /^\s*(?:-\w,\s*)?--[\w-]+/;
// (a, b), <a|b>, {a,b} or [possible values: a, b] in an option's help
const VALUE_LIST =
  /[(<[{](?:[a-z ]+:)?\s*("?[\w-]+"?(?:\s*[,|]\s*"?[\w-]+"?)+)\s*[)>\]}]/i;
const QUOTED_NAME = /'([A-Za-z][\w.:-]*)'/g;
const FAST = '-fast';
const THINKING = '-thinking';

const EFFORT_LEVELS = [
  'extra-high',
  'xhigh',
  'minimal',
  'medium',
  'none',
  'high',
  'max',
  'low',
];

const EFFORT_RANK = [
  'default',
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'extra-high',
  'max',
];

const textLines = (text) => {
  const lines = [];
  for (const raw of stripAnsi(`${text ?? ''}`).split('\n')) {
    const line = raw.trim();
    if (line) lines.push(line);
  }
  return lines;
};

const uniqueNames = (names) => {
  const unique = new Set();
  for (const raw of names) {
    const name = trimText(raw);
    if (name) unique.add(name);
  }
  return [...unique];
};

const parseNameList = (text) => {
  const names = [];
  for (const line of textLines(text)) {
    const token = line.split(/\s+/)[0].replace(/:+$/, '');
    if (MODEL_ID.test(token) && !SKIP_TOKEN.test(token)) names.push(token);
  }
  return uniqueNames(names);
};

const parseCursorModels = (text) => {
  const names = [];
  for (const line of textLines(text)) {
    if (CURSOR_NOISE.test(line)) continue;
    const listed = AVAILABLE_LINE.exec(line);
    const row = listed ? null : CURSOR_ROW.exec(line);
    if (listed) names.push(...listed[1].split(','));
    else if (row) names.push(row[1]);
  }
  return names.length ? uniqueNames(names) : parseNameList(text);
};

const parseCursorWide = (text) => {
  const names = [];
  for (const line of textLines(text)) {
    const row = CURSOR_ROW.exec(line);
    if (row && WIDE_LABEL.test(line)) names.push(row[1]);
  }
  return uniqueNames(names);
};

// The help of one option: its line and the indented lines that follow
const optionHelp = (text, flag) => {
  const lines = stripAnsi(`${text ?? ''}`).split('\n');
  const named = (line) => OPTION_LINE.test(line) && line.includes(flag);
  const at = flag ? lines.findIndex(named) : -1;
  if (at < 0) return '';
  const block = [lines[at]];
  for (const line of lines.slice(at + 1)) {
    if (OPTION_LINE.test(line) || /^\S/.test(line)) break;
    block.push(line.trim());
  }
  return block.join(' ');
};

const optionValues = (text, flag) => {
  const listed = VALUE_LIST.exec(optionHelp(text, flag));
  if (!listed) return [];
  const values = listed[1].split(/[,|]/);
  return uniqueNames(values.map((value) => value.replaceAll('"', '')));
};

const parseHelpModels = (text) => {
  const help = optionHelp(text, '--model');
  return uniqueNames([...help.matchAll(QUOTED_NAME)].map((hit) => hit[1]));
};

const jsonStart = (text) => {
  const starts = [text.indexOf('{'), text.indexOf('[')].filter((at) => at >= 0);
  return starts.length ? Math.min(...starts) : -1;
};

const jsonModelId = (value) => {
  for (const key of JSON_KEYS) {
    const id = value[key];
    if (typeof id === 'string' && id.trim()) return id.trim();
  }
  return '';
};

const jsonEfforts = (value) => {
  const listed = value.supported_reasoning_levels;
  if (!Array.isArray(listed)) return [];
  const levels = listed.map((item) =>
    isHashObject(item) ? item.effort : item,
  );
  return uniqueNames(levels.filter((level) => typeof level === 'string'));
};

const collectJsonModels = (value, found) => {
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === 'string') found.push({ id: item, efforts: [] });
      else collectJsonModels(item, found);
    }
    return found;
  }
  if (!isHashObject(value)) return found;
  const id = jsonModelId(value);
  const shown = id && value.visibility !== 'hide';
  if (shown) found.push({ id, efforts: jsonEfforts(value) });
  if (value.models) collectJsonModels(value.models, found);
  if (value.data) collectJsonModels(value.data, found);
  return found;
};

const jsonModels = (text) => {
  const start = jsonStart(text);
  const data = start < 0 ? null : jsonParse(text.slice(start));
  return collectJsonModels(data, []);
};

const parseJsonModels = (text) => {
  const plain = stripAnsi(`${text ?? ''}`);
  const names = jsonModels(plain).map((model) => model.id);
  return names.length ? uniqueNames(names) : parseNameList(plain);
};

// Effort levels each model lists for itself, keyed by the model id
const parseJsonEfforts = (text) => {
  const efforts = new Map();
  for (const model of jsonModels(stripAnsi(`${text ?? ''}`))) {
    if (model.efforts.length) efforts.set(model.id, model.efforts);
  }
  return efforts;
};

// A full listing replaces the built-in names, a partial one extends them
const mergeModels = (fallback, listed, partial = false) => {
  const names = listed ?? [];
  const kept = partial || !names.length;
  const known = kept && fallback ? fallback : [];
  return uniqueNames(['default', ...names, ...known]);
};

const cutSuffix = (name, suffix) => {
  if (!name.endsWith(suffix) || name.length <= suffix.length) return '';
  return name.slice(0, -suffix.length);
};

const withoutFast = (name) => cutSuffix(name, FAST) || name;

const effortTail = (name) => {
  for (const level of EFFORT_LEVELS) {
    const base = cutSuffix(name, `-${level}`);
    if (base) return { base, level };
  }
  return null;
};

const hasFastTail = (name) => {
  const unfast = cutSuffix(name, FAST);
  if (!unfast) return false;
  const unthink = cutSuffix(unfast, THINKING);
  return Boolean(effortTail(unfast) || (unthink && effortTail(unthink)));
};

const splitEffortModel = (id) => {
  const name = trimText(id);
  if (!name) return null;
  const fast = hasFastTail(name);
  let rest = fast ? cutSuffix(name, FAST) : name;
  let thinking = '';
  const unthink = cutSuffix(rest, THINKING);
  if (unthink && effortTail(unthink)) {
    rest = unthink;
    thinking = 'after';
  }
  const hit = effortTail(rest);
  if (!hit) return null;
  const before = cutSuffix(hit.base, THINKING);
  if (before) thinking = 'before';
  const base = before || hit.base;
  return { base, effort: hit.level, thinking, fast, id: name };
};

const contextFamily = (model) => {
  const raw = `${model ?? ''}`.replace(CONTEXT_TAG, '').trim();
  const base = withoutFast(raw);
  const part = splitEffortModel(base);
  return part ? part.base : base;
};

const contextMenu = (model, wide, catalog, fallback) => {
  const sizes = [];
  for (const size of fallback ?? []) {
    const text = trimText(size);
    if (text && text !== 'default') sizes.push(text);
  }
  if (!sizes.length) return [];
  const named = MODEL_CONTEXTS[contextFamily(model)];
  if (named) return named.slice();
  if (!trimText(model) || catalog.hasWide(wide, model)) return sizes;
  return sizes.filter((size) => size !== '1m');
};

const modelLabel = (part) => {
  const thinking = part.thinking ? THINKING : '';
  return `${part.base}${thinking}${part.fast ? FAST : ''}`;
};

const groupKey = (part) =>
  `${part.base}\0${part.thinking}\0${part.fast ? 'fast' : ''}`;

const rankedLevels = (ids) => {
  const levels = EFFORT_RANK.filter((level) => ids.has(level));
  for (const level of ids.keys()) {
    if (!levels.includes(level)) levels.push(level);
  }
  return levels;
};

const groupEntry = (group) => ({
  model: group.model,
  encoded: true,
  levels: rankedLevels(group.ids),
  ids: group.ids,
});

const plainEntry = (name) => ({
  model: name,
  encoded: false,
  levels: [],
  ids: new Map([['default', name]]),
});

const defaultGroup = (groups, name) => {
  const direct = groups.get(`${name}\0\0`);
  if (direct && !direct.ids.has('default')) return direct;
  for (const group of groups.values()) {
    if (group.model === name && !group.ids.has('default')) return group;
  }
  return null;
};

const groupModels = (ids) => {
  const names = uniqueNames(ids ?? []);
  const groups = new Map();
  const owners = new Map();
  const plain = [];
  for (const name of names) {
    const part = splitEffortModel(name);
    if (!part) {
      plain.push(name);
      continue;
    }
    const key = groupKey(part);
    if (!groups.has(key)) {
      groups.set(key, { model: modelLabel(part), ids: new Map() });
    }
    const group = groups.get(key);
    if (!group.ids.has(part.effort)) group.ids.set(part.effort, name);
    owners.set(name, group);
  }
  for (const name of plain) {
    const group = defaultGroup(groups, name);
    if (!group) continue;
    group.ids.set('default', name);
    owners.set(name, group);
  }
  const entries = [];
  const listed = new Set();
  for (const name of names) {
    const group = owners.get(name) ?? null;
    const slot = group ?? name;
    if (listed.has(slot)) continue;
    listed.add(slot);
    entries.push(group ? groupEntry(group) : plainEntry(name));
  }
  return entries;
};

const fitEffort = (levels, effort) => {
  const want = trimText(effort) || 'default';
  if (!levels || !levels.length) return 'default';
  if (levels.includes(want)) return want;
  const named = levels.find((level) => {
    const name = trimText(level);
    return name && name !== 'default';
  });
  return named ?? levels[0];
};

const plainResolved = (model, effort, params = true) => ({
  model,
  encoded: false,
  effort,
  family: model,
  levels: [],
  params,
});

const entryResolved = (entry, effort, params = true) => {
  if (!entry.encoded) return plainResolved(entry.model, effort, params);
  const level = fitEffort(entry.levels, effort);
  return {
    model: entry.ids.get(level) ?? entry.model,
    encoded: true,
    effort: level,
    family: entry.model,
    levels: entry.levels,
    params: false,
  };
};

const entryNames = (entry) => [entry.model, ...entry.ids.values()];

class ModelCatalog {
  constructor(ids) {
    this.entries = groupModels(ids);
    this.byName = new Map();
    for (const entry of this.entries) {
      if (!this.byName.has(entry.model)) this.byName.set(entry.model, entry);
    }
    const encoded = this.entries.some((entry) => entry.encoded);
    this.bracketParams = !encoded;
  }

  find(name) {
    return this.byName.get(name) ?? null;
  }

  hasFast() {
    return this.entries.some((entry) => entry.model.endsWith(FAST));
  }

  prefixed(entry, name) {
    if (entry && entry.encoded) return null;
    const base = withoutFast(entry ? entry.model : trimText(name));
    if (!base || base.startsWith('cursor-')) return null;
    const found = this.find(`cursor-${base}`);
    return found && found.encoded ? found : null;
  }

  resolve(choice) {
    const effort = trimText(choice.effort) || 'default';
    const params = this.bracketParams;
    const entry = this.find(choice.model);
    const prefixed = this.prefixed(entry, choice.model);
    if (prefixed) return entryResolved(prefixed, effort, params);
    if (entry) return entryResolved(entry, effort, params);
    const part = splitEffortModel(choice.model);
    const family = part ? this.find(modelLabel(part)) : null;
    if (!family) return plainResolved(choice.model, effort, params);
    const level = effort === 'default' ? part.effort : effort;
    return entryResolved(family, level, params);
  }

  withFast(resolved, fast) {
    const family = `${resolved.family ?? ''}`;
    const onFast = family.endsWith(FAST);
    if (!family || (fast === true) === onFast) return resolved;
    const other = onFast ? withoutFast(family) : `${family}${FAST}`;
    const entry = this.find(other);
    const params = resolved.params;
    return entry ? entryResolved(entry, resolved.effort, params) : resolved;
  }

  hasWide(wide, model) {
    if (!(wide instanceof Set)) return true;
    const raw = `${model ?? ''}`.replace(CONTEXT_TAG, '');
    const base = withoutFast(raw);
    if (!base || base === 'default') return true;
    if (wide.has(raw) || wide.has(base)) return true;
    const wanted = new Set([base, `${base}${FAST}`, raw]);
    return this.entries.some((entry) => {
      const names = entryNames(entry);
      if (!names.some((name) => wanted.has(name))) return false;
      return names.some((name) => wide.has(name));
    });
  }
}

const EMPTY_CATALOG = new ModelCatalog([]);
const catalogs = new WeakMap();

const catalogOf = (models) => {
  if (!Array.isArray(models)) return EMPTY_CATALOG;
  if (!catalogs.has(models)) catalogs.set(models, new ModelCatalog(models));
  return catalogs.get(models);
};

const emptyChoice = (row) => ({
  model: row && row.models && row.models[0] ? row.models[0] : 'default',
  effort: 'default',
  extra: '',
  fast: false,
  context: '',
});

module.exports = {
  catalogOf,
  parseNameList,
  parseCursorModels,
  parseCursorWide,
  parseJsonModels,
  parseJsonEfforts,
  parseHelpModels,
  optionValues,
  mergeModels,
  contextMenu,
  groupModels,
  fitEffort,
  withoutFast,
  emptyChoice,
};
