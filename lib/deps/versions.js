'use strict';

const { SECTION_KEYS } = require('./manifest.js');

const applyWantedRange = (declared, wanted) => {
  if (!wanted) return declared ?? '';
  if (!declared) return wanted;
  if (/^(file:|git[+@:]|workspace:|https?:|npm:)/.test(declared)) {
    return declared;
  }
  if (declared.includes(' ') || declared.includes('|')) return declared;
  if (declared.includes('<') || declared.includes('>')) return declared;
  const prefix = declared.startsWith('^') || declared.startsWith('~');
  const mark = prefix ? declared[0] : '';
  return `${mark}${wanted}`;
};

const findDeclared = (pkg, name, type) => {
  if (type && SECTION_KEYS.includes(type)) {
    const map = pkg[type];
    if (map && typeof map[name] === 'string') {
      return { section: type, version: map[name] };
    }
  }
  for (const section of SECTION_KEYS) {
    const map = pkg[section];
    if (map && typeof map[name] === 'string') {
      return { section, version: map[name] };
    }
  }
  return null;
};

const VER_CORE = /^(\d+)\.(\d+)\.(\d+)/;

const parseVer = (text) => {
  const match = `${text}`.match(VER_CORE);
  if (!match) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  return [major, minor, patch];
};

const fmtVer = (parts) => `${parts[0]}.${parts[1]}.${parts[2]}`;

const cmpVer = (left, right) => {
  if (left[0] !== right[0]) return left[0] - right[0];
  if (left[1] !== right[1]) return left[1] - right[1];
  return left[2] - right[2];
};

const bumpPatch = (parts) => {
  const major = parts[0];
  const minor = parts[1];
  const patch = parts[2] + 1;
  return [major, minor, patch];
};

const clauseUpper = (clause) => {
  const pattern = /(<=?)\s*(\d+\.\d+\.\d+)/g;
  const matches = clause.matchAll(pattern);
  let best = null;
  for (const match of matches) {
    const op = match[1];
    const parsed = parseVer(match[2]);
    if (!parsed) continue;
    if (best && cmpVer(parsed, best.ver) >= 0) continue;
    best = { op, ver: parsed };
  }
  return best;
};

const patchedFromRange = (current, range) => {
  if (!current || !range) return '';
  const now = parseVer(current);
  if (!now) return '';
  const clauses = `${range}`.split('||');
  for (const clause of clauses) {
    const upper = clauseUpper(clause);
    if (!upper) continue;
    if (now[0] !== upper.ver[0]) continue;
    if (cmpVer(now, upper.ver) > 0) continue;
    if (upper.op === '<') return fmtVer(upper.ver);
    return fmtVer(bumpPatch(upper.ver));
  }
  return '';
};

const sameMajor = (from, to) => {
  const left = parseVer(from);
  const right = parseVer(to);
  if (!left || !right) return false;
  return left[0] === right[0];
};

const proposedLockVersion = (current, vul) => {
  if (!current) return '';
  if (!vul) return current;
  const fix = vul.fix;
  if (fix && sameMajor(current, fix) && fix !== current) return fix;
  const patched = patchedFromRange(current, vul.range);
  if (patched && patched !== current) return patched;
  return current;
};

const proposedWanted = (out, vul) => {
  if (out && out.wanted && out.wanted !== out.current) return out.wanted;
  if (vul && vul.fix) return vul.fix;
  return '';
};

module.exports = {
  applyWantedRange,
  findDeclared,
  patchedFromRange,
  proposedLockVersion,
  proposedWanted,
};
