'use strict';

const { countSides, isCtxType } = require('../diff.js');

const DEP_CAPTION = 'Dependencies in package.json & package-lock.json';

const changeMarks = (change) => {
  const marks = [];
  if (change.unused) marks.push('unused');
  if (change.outdated && !change.propose) marks.push('outdated');
  if (change.audit) marks.push(change.audit.severity);
  return marks;
};

const changeSources = (change) => {
  const sources = [];
  if (change.unused) {
    sources.push('npm uninstall');
    return sources;
  }
  if (change.propose && change.outdated) sources.push('npm outdated');
  if (change.audit) sources.push('npm audit');
  return sources;
};

const sectionTitle = (section, action, marks, sources) => {
  const title = action === 'changed' ? 'version changed' : action;
  const kind = section.replace(/ies$/, 'y');
  let label = `${kind} ${title}`;
  if (section === 'field') label = `package.json ${title}`;
  if (section === 'resolved' && action === 'vulnerable') {
    label = 'lockfile vulnerable';
  } else if (section === 'resolved') {
    label = `lockfile resolved ${title}`;
  }
  if (marks.includes('unused')) {
    label = `${kind} unused`;
    const extra = [];
    for (const mark of marks) {
      if (mark !== 'unused') extra.push(mark);
    }
    if (extra.length) label = `${label}, ${extra.join(', ')}`;
  } else if (marks.length) {
    label = `${label}, ${marks.join(', ')}`;
  }
  if (!sources.length) return label;
  return `${sources.join(', ')}: ${label}`;
};

const entryText = (change, side) => {
  const version = side === 'old' ? change.from : change.to;
  return `"${change.name}": "${version}"`;
};

const ctxLine = (text) => {
  const type = 'ctx';
  return { type, text };
};

const warnLine = (text) => {
  const type = 'warn';
  return { type, text };
};

const noteLine = (text) => {
  const type = 'note';
  return { type, text };
};

const noteSepLine = () => {
  const type = 'noteSep';
  const text = '';
  return { type, text };
};

const changeLine = (type, change, side) => {
  const text = entryText(change, side);
  return { type, text };
};

const pushChangeLines = (rows, change) => {
  if (change.unused) {
    const side = change.action === 'added' ? 'new' : 'old';
    rows.push(changeLine('del', change, side));
    return;
  }
  if (change.action === 'added') {
    rows.push(changeLine('add', change, 'new'));
    return;
  }
  if (change.action === 'removed') {
    rows.push(changeLine('del', change, 'old'));
    return;
  }
  if (change.from === change.to) {
    rows.push(changeLine('ctx', change, 'old'));
    return;
  }
  rows.push(changeLine('del', change, 'old'));
  rows.push(changeLine('add', change, 'new'));
};

const lockCountText = (oldCount, newCount) => {
  if (oldCount === newCount) return '';
  return `lockfile packages  ${oldCount} → ${newCount}`;
};

const auditNoteTexts = (audit) => {
  if (!audit) return [];
  const notes = [];
  if (Array.isArray(audit.titles)) {
    for (const note of audit.titles) {
      if (note && !notes.includes(note)) notes.push(note);
    }
  } else if (audit.title) {
    notes.push(audit.title);
  }
  const severity = audit.severity;
  if (!notes.length) return [`npm audit  ${severity}`];
  const texts = [];
  for (const note of notes) {
    texts.push(`npm audit  ${severity}  ${note}`);
  }
  return texts;
};

const pushAuditNotes = (rows, audit) => {
  const texts = auditNoteTexts(audit);
  if (!texts.length) return;
  rows.push(ctxLine(''));
  let first = true;
  for (const text of texts) {
    if (!first) rows.push(noteSepLine());
    first = false;
    rows.push(noteLine(text));
  }
};

const buildRows = (change, oldCount, newCount) => {
  const rows = [ctxLine(DEP_CAPTION), ctxLine('')];
  if (change) {
    const marks = changeMarks(change);
    const sources = changeSources(change);
    const title = sectionTitle(change.section, change.action, marks, sources);
    const audited = sources.includes('npm audit');
    rows.push(audited ? warnLine(title) : ctxLine(title));
    rows.push(ctxLine(''));
    pushChangeLines(rows, change);
    pushAuditNotes(rows, change.audit);
  }
  const countLine = lockCountText(oldCount, newCount);
  if (countLine) {
    if (rows.at(-1).text !== '') rows.push(ctxLine(''));
    rows.push(ctxLine(countLine));
  }
  if (!change && !countLine) rows.push(ctxLine('lockfile updated'));
  return rows;
};

const toHunkLine = (row, blockId) => {
  const type = row.type;
  const text = row.text;
  const noNl = false;
  const id = isCtxType(type) ? null : blockId;
  return { type, text, noNl, blockId: id };
};

const makeHunk = (rows, blockId) => {
  const lines = rows.map((row) => toHunkLine(row, blockId));
  const counts = countSides(lines);
  const oldCount = counts.oldCount;
  const newCount = counts.newCount;
  const header = `@@ -1,${oldCount} +1,${newCount} @@`;
  return { oldStart: 1, oldCount, newStart: 1, newCount, header, lines };
};

module.exports = { DEP_CAPTION, buildRows, makeHunk };
