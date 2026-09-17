'use strict';

const { jsonParse, isHashObject } = require('metautil');

const SEVERITY_RANK = { critical: 4, high: 3, moderate: 2, low: 1, info: 0 };

const namedTitle = (name, title) => {
  if (!title) return '';
  if (!name) return title;
  const prefix = `${name}: `;
  if (title.startsWith(prefix)) return title;
  return `${prefix}${title}`;
};

const viaNotes = (via, pkgName) => {
  if (!Array.isArray(via)) return [];
  const notes = [];
  for (const item of via) {
    if (!item || typeof item !== 'object') continue;
    const title = typeof item.title === 'string' ? item.title : '';
    if (!title) continue;
    const hasName = typeof item.name === 'string' && item.name;
    const named = hasName ? item.name : pkgName;
    const note = namedTitle(named, title);
    if (!notes.includes(note)) notes.push(note);
  }
  return notes;
};

const severityRank = (severity) => SEVERITY_RANK[severity] ?? 0;

const auditFix = (entry) => {
  const available = entry.fixAvailable;
  if (!available || typeof available !== 'object') return '';
  if (typeof available.version !== 'string') return '';
  return available.version;
};

const auditEntryNames = (key, entry) => {
  const names = [];
  const primary = entry.name || key;
  if (primary) names.push(primary);
  const effects = entry.effects;
  if (!Array.isArray(effects)) return names;
  for (const effect of effects) {
    if (typeof effect === 'string' && effect) names.push(effect);
  }
  return names;
};

const keepHighestAudit = (audit, name, severity, fix, range, notes) => {
  if (!name || !severity || severity === 'info') return;
  const titles = [];
  for (const note of notes) {
    if (note && !titles.includes(note)) titles.push(note);
  }
  const prev = audit.get(name);
  if (prev && severityRank(prev.severity) >= severityRank(severity)) {
    const merged = [...prev.titles];
    for (const note of titles) {
      if (!merged.includes(note)) merged.push(note);
    }
    const next = {
      ...prev,
      titles: merged,
      fix: prev.fix || fix,
      range: prev.range || range,
    };
    audit.set(name, next);
    return;
  }
  const title = titles[0] || '';
  const next = { name, severity, title, titles, fix, range };
  next.fix ||= '';
  next.range ||= '';
  audit.set(name, next);
};

const parseAuditReport = (text) => {
  const audit = new Map();
  if (!text || !`${text}`.trim()) return audit;
  const data = jsonParse(text);
  if (!isHashObject(data)) return audit;
  const vulns = data.vulnerabilities;
  if (vulns && typeof vulns === 'object') {
    for (const key of Object.keys(vulns)) {
      const entry = vulns[key];
      if (!entry || typeof entry !== 'object') continue;
      const severity = entry.severity;
      const names = auditEntryNames(key, entry);
      const pkgName = entry.name || key;
      const titles = viaNotes(entry.via, pkgName);
      const fix = auditFix(entry);
      const range = typeof entry.range === 'string' ? entry.range : '';
      for (const name of names) {
        keepHighestAudit(audit, name, severity, fix, range, titles);
      }
    }
  }
  const advisories = data.advisories;
  if (advisories && typeof advisories === 'object') {
    for (const entry of Object.values(advisories)) {
      if (!entry || typeof entry !== 'object') continue;
      const name = entry.module_name || entry.name;
      const severity = entry.severity;
      const raw = typeof entry.title === 'string' ? entry.title : '';
      const title = namedTitle(name, raw);
      const titles = title ? [title] : [];
      const fix = auditFix(entry);
      const range = typeof entry.range === 'string' ? entry.range : '';
      keepHighestAudit(audit, name, severity, fix, range, titles);
    }
  }
  return audit;
};

const parseOutdatedReport = (text) => {
  const outdated = new Map();
  if (!text || !`${text}`.trim()) return outdated;
  const data = jsonParse(text);
  if (!isHashObject(data)) return outdated;
  for (const name of Object.keys(data)) {
    const entry = data[name];
    if (!entry || typeof entry !== 'object') continue;
    const current = typeof entry.current === 'string' ? entry.current : '';
    const wanted = typeof entry.wanted === 'string' ? entry.wanted : '';
    const latest = typeof entry.latest === 'string' ? entry.latest : '';
    const type = typeof entry.type === 'string' ? entry.type : '';
    if (!wanted) continue;
    outdated.set(name, { current, wanted, latest, type });
  }
  return outdated;
};

const markAuditChanges = (changes, audit) => {
  if (!audit) return changes;
  const marked = [];
  for (const change of changes) {
    if (change.action === 'removed' || change.section === 'field') {
      marked.push(change);
      continue;
    }
    const found = audit.get(change.name);
    if (!found) {
      marked.push(change);
      continue;
    }
    marked.push({ ...change, audit: found });
  }
  return marked;
};

const markOutdatedChanges = (changes, outdated) => {
  if (!outdated) return changes;
  const marked = [];
  for (const change of changes) {
    if (change.action === 'removed' || change.section === 'field') {
      marked.push(change);
      continue;
    }
    const found = outdated.get(change.name);
    if (!found) {
      marked.push(change);
      continue;
    }
    if (found.wanted && found.wanted === found.current) {
      marked.push(change);
      continue;
    }
    marked.push({ ...change, outdated: found });
  }
  return marked;
};

module.exports = {
  parseAuditReport,
  parseOutdatedReport,
  markAuditChanges,
  markOutdatedChanges,
};
