'use strict';

const { parsePlan } = require('./blocks.js');
const { TaskItem, itemHead } = require('./task.js');
const { blockText } = require('./markdown.js');

// A three-way merge of the plan reslop holds with the file an agent or an
// editor changed since the last read or write. Blocks are aligned by key:
// a task by its ID or title, a note by its location, a heading by its text,
// anything else by its text, then by position.

const normal = (text) => text.replace(/\s+/g, ' ').trim().toLowerCase();

const taskKey = (block) => {
  const { id, title } = itemHead(block.lines[0]);
  if (id) return `task:${id.toUpperCase()}`;
  return `task:${normal(title)}`;
};

const blockKey = (block) => {
  const { type } = block;
  if (type === 'task') return taskKey(block);
  if (type === 'feedback' || type === 'code') return `${type}:${block.key}`;
  if (type === 'heading') return `heading:${block.level}:${normal(block.text)}`;
  if (type === 'frontmatter') return 'frontmatter';
  return `text:${normal(blockText(block))}`;
};

// A non-blank block and the blank lines after it
const unitsOf = (doc) => {
  const lead = [];
  const units = [];
  for (const block of doc.blocks) {
    if (block.type === 'blank') {
      if (units.length) units[units.length - 1].gaps.push(block);
      else lead.push(block);
      continue;
    }
    units.push({ block, key: blockKey(block), gaps: [], index: units.length });
  }
  return { lead, units };
};

const sameBlock = (left, right) => blockText(left) === blockText(right);

const pickDone = (baseDone, ourDone, theirDone) => {
  if (ourDone === theirDone) return ourDone;
  if (theirDone === baseDone) return ourDone;
  if (ourDone === baseDone) return theirDone;
  return ourDone;
};

// Pairs base units with one side: by key first, then an unmatched block of
// the same type right after a pair
const pairUnits = (base, side) => {
  const pairs = new Map();
  const used = new Set();
  const byKey = new Map();
  for (const unit of side) {
    const list = byKey.get(unit.key);
    if (list) list.push(unit);
    else byKey.set(unit.key, [unit]);
  }
  for (const unit of base) {
    const found = (byKey.get(unit.key) ?? []).find((one) => !used.has(one));
    if (!found) continue;
    pairs.set(unit, found);
    used.add(found);
  }
  for (let i = 0; i < base.length; i++) {
    const unit = base[i];
    if (pairs.has(unit)) continue;
    const prev = i > 0 ? pairs.get(base[i - 1]) : null;
    if (i > 0 && !prev) continue;
    const next = side[prev ? prev.index + 1 : 0];
    if (!next || used.has(next) || next.block.type !== unit.block.type) {
      continue;
    }
    pairs.set(unit, next);
    used.add(next);
  }
  return { pairs, used };
};

const reverse = (pairs) => {
  const back = new Map();
  for (const [base, side] of pairs) back.set(side, base);
  return back;
};

// Done marks and check ticks merge one by one; fields only theirs has, like
// a `result` an agent wrote, join ours
const mergeTask = (base, ours, theirs) => {
  const b = new TaskItem(base.lines);
  const t = new TaskItem(theirs.lines);
  let item = new TaskItem(ours.lines);
  const done = pickDone(b.done, item.done, t.done);
  item = new TaskItem(item.setDone(done));
  for (let i = 0; i < item.checks.length; i++) {
    const text = item.checks[i].text;
    const their = t.checks.find((check) => check.text === text);
    if (!their) continue;
    const was = b.checks.find((check) => check.text === text);
    const baseDone = was ? was.done : item.checks[i].done;
    const next = pickDone(baseDone, item.checks[i].done, their.done);
    item = new TaskItem(item.setCheck(i, next));
  }
  for (const field of t.fields) {
    if (item.field(field.key) || b.field(field.key)) continue;
    item = new TaskItem(item.setField(field.key, field.value));
  }
  return item.lines;
};

const mergeBlock = (base, ours, theirs) => {
  if (sameBlock(ours, base)) return theirs.lines;
  if (sameBlock(theirs, base)) return ours.lines;
  if (ours.type === 'task' && theirs.type === 'task') {
    return mergeTask(base, ours, theirs);
  }
  return ours.lines;
};

// A removed block hands its blank lines to the one before it
const dropUnit = (merged, unit) => {
  const prev = merged[merged.length - 1];
  if (prev && !prev.gaps.length) prev.gaps = unit.gaps;
};

class BlockMerge {
  constructor(store, baseDoc, theirDoc) {
    this.doc = store.doc;
    this.base = unitsOf(baseDoc).units;
    this.ours = unitsOf(this.doc);
    this.theirs = unitsOf(theirDoc).units;
    const ours = pairUnits(this.base, this.ours.units);
    const theirs = pairUnits(this.base, this.theirs);
    this.oursBase = reverse(ours.pairs);
    this.baseTheirs = theirs.pairs;
    this.theirsBase = reverse(theirs.pairs);
    this.usedTheirs = theirs.used;
    this.alias = new Map();
  }

  // A block of theirs as a block of our doc, with a new id
  adopt(block) {
    const fresh = this.doc.block(block.type, block.lines);
    for (const key of ['level', 'text', 'key', 'note', 'code', 'fence']) {
      if (block[key] !== undefined) fresh[key] = block[key];
    }
    return fresh;
  }

  gapsOf(unit) {
    return unit ? unit.gaps.map((gap) => this.adopt(gap)) : [];
  }

  // Both sides added a block with the same key
  freshTwin(unit) {
    const twin = this.theirs.find(
      (their) =>
        !this.usedTheirs.has(their) &&
        !this.alias.has(their) &&
        their.key === unit.key,
    );
    if (!twin) return;
    this.alias.set(twin, unit);
    const ours = new TaskItem(unit.block.lines);
    const done = ours.done || new TaskItem(twin.block.lines).done;
    if (unit.block.type === 'task') unit.block.lines = ours.setDone(done);
  }

  keepOurs() {
    const merged = [];
    for (const unit of this.ours.units) {
      const base = this.oursBase.get(unit);
      if (!base) {
        this.freshTwin(unit);
        merged.push(unit);
        continue;
      }
      const theirs = this.baseTheirs.get(base);
      if (theirs) {
        const lines = mergeBlock(base.block, unit.block, theirs.block);
        if (lines === theirs.block.lines && theirs.block.note) {
          unit.block.note = theirs.block.note;
        }
        unit.block.lines = lines;
        this.alias.set(theirs, unit);
        merged.push(unit);
        continue;
      }
      if (sameBlock(unit.block, base.block)) dropUnit(merged, unit);
      else merged.push(unit);
    }
    return merged;
  }

  theirPlace(merged, index) {
    for (let j = index - 1; j >= 0; j--) {
      const at = merged.indexOf(this.alias.get(this.theirs[j]));
      if (at >= 0) return { at: at + 1, prev: this.theirs[j] };
    }
    for (let j = index + 1; j < this.theirs.length; j++) {
      const at = merged.indexOf(this.alias.get(this.theirs[j]));
      if (at >= 0) return { at, prev: null };
    }
    return { at: merged.length, prev: null };
  }

  // A block only theirs has goes after its nearest neighbor. When the block
  // after it is the one that followed it on disk, both gaps come from disk;
  // otherwise it takes the gap its neighbor had here
  addTheirs(merged) {
    for (let i = 0; i < this.theirs.length; i++) {
      const their = this.theirs[i];
      if (this.alias.has(their)) continue;
      const base = this.theirsBase.get(their);
      if (base && sameBlock(their.block, base.block)) continue;
      const { at, prev } = this.theirPlace(merged, i);
      const unit = { block: this.adopt(their.block), gaps: this.gapsOf(their) };
      const before = merged[at - 1];
      if (prev && before) {
        const next = this.alias.get(this.theirs[i + 1]);
        if (next !== merged[at]) unit.gaps = before.gaps;
        before.gaps = this.gapsOf(prev);
      }
      merged.splice(at, 0, unit);
      this.alias.set(their, unit);
    }
    return merged;
  }

  run() {
    const merged = this.addTheirs(this.keepOurs());
    const blocks = [...this.ours.lead];
    for (const unit of merged) blocks.push(unit.block, ...unit.gaps);
    this.doc.blocks = blocks;
    this.doc.touch();
  }
}

// The disk text as the new doc, its blocks keeping the ids of ours so the
// screen keeps its focus
const carryIds = (ours, next) => {
  const old = unitsOf(ours).units;
  const { pairs } = pairUnits(old, unitsOf(next).units);
  const kept = new Map();
  for (const [unit, their] of pairs) kept.set(their.block, unit.block.id);
  for (const block of next.blocks) {
    block.id = kept.get(block) ?? ours.nextId++;
  }
  next.nextId = ours.nextId;
  return next;
};

const mergeReview = (store, text) => {
  const base = store.baseline ?? '';
  if (text === base) return;
  const ours = store.doc.toString();
  if (ours === base) {
    store.doc = carryIds(store.doc, parsePlan(text));
  } else {
    const baseDoc = parsePlan(base);
    const theirDoc = parsePlan(text);
    new BlockMerge(store, baseDoc, theirDoc).run();
    if (ours.endsWith('\n') === base.endsWith('\n')) {
      store.doc.final = theirDoc.final;
    }
  }
  store.baseline = text;
};

module.exports = { mergeReview, carryIds };
