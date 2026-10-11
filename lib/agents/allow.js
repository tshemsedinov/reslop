'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { jsonParse, isHashObject } = require('metautil');
const { writeJson, trimText } = require('../common/utilities.js');

const { planAllows: PLAN_ALLOWS } = require('./approvals.json');

const cursorConfigPath = (env = process.env) => {
  const override = trimText(env.RESLOP_CURSOR_CONFIG);
  if (override) return override;
  const root = trimText(env.CURSOR_CONFIG_DIR);
  const dir = root || path.join(os.homedir(), '.cursor');
  return path.join(dir, 'cli-config.json');
};

const readConfig = (file) => {
  let text = null;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (!error || error.code !== 'ENOENT') return null;
  }
  if (text === null) return {};
  const data = jsonParse(text);
  if (!isHashObject(data)) return null;
  return data;
};

const allowList = (data) => {
  if (!data.permissions || typeof data.permissions !== 'object') {
    data.permissions = { allow: [], deny: [] };
  }
  if (!Array.isArray(data.permissions.allow)) data.permissions.allow = [];
  if (!Array.isArray(data.permissions.deny)) data.permissions.deny = [];
  return data.permissions.allow;
};

const ensureAllows = (file, entries) => {
  const data = readConfig(file);
  if (!data) return false;
  const allow = allowList(data);
  let changed = false;
  for (const entry of entries) {
    const token = trimText(entry);
    if (!token || allow.includes(token)) continue;
    allow.push(token);
    changed = true;
  }
  if (!changed) return true;
  if (!data.version) data.version = 1;
  if (!data.approvalMode) data.approvalMode = 'allowlist';
  try {
    writeJson(file, data);
    return true;
  } catch {
    return false;
  }
};

const ensurePlanAllows = (env = process.env) =>
  ensureAllows(cursorConfigPath(env), PLAN_ALLOWS);

module.exports = {
  PLAN_ALLOWS,
  cursorConfigPath,
  ensureAllows,
  ensurePlanAllows,
};
