'use strict';

const fs = require('node:fs');
const path = require('node:path');
const agents = require('../lib/agents/agents.js');
const { AGENTS } = agents;
const {
  makeRepo,
  uiSink,
  press,
  tempDir,
  openRepoSession,
} = require('./helpers.js');
const ansi = require('../lib/term/ansi.js');
const { stripAnsi } = ansi;

const makeBin = (dir, name) => {
  const file = path.join(dir, name);
  fs.writeFileSync(file, '#!/bin/sh\n');
  fs.chmodSync(file, 0o755);
  return file;
};

const fakePath = (...names) => {
  const dir = tempDir('reslop-bins-');
  const bins = {};
  for (const name of names) bins[name] = makeBin(dir, name);
  return { dir, bins, env: { PATH: dir } };
};

// The row of the agents table that a caption starts
const labelRow = (rows, label) =>
  rows.find((row) => new RegExp(`^ +${label} `).test(stripAnsi(row)));

const select = (id, category, currentValue, values) => ({
  id,
  category,
  type: 'select',
  currentValue,
  options: values.map((value) => ({ value, name: value })),
});

// What an agent answers to session/new, as far as the panel reads it
const acpState = (given) => {
  const { models, efforts, fast, listed, modes } = given;
  const configOptions = [];
  const current = given.current ?? models[0];
  if (modes) configOptions.push(select('mode', 'mode', modes[0], modes));
  if (!given.bare) {
    configOptions.push(select('model', 'model', current, models));
  }
  if (efforts) {
    const level = given.effort ?? 'high';
    configOptions.push(select('effort', 'thought_level', level, efforts));
  }
  if (fast) {
    configOptions.push(select('fast', 'model_config', 'off', ['on', 'off']));
  }
  const ids = listed ?? (given.bare ? models : null);
  const availableModels = (ids ?? []).map((modelId) => ({ modelId }));
  const listing = { currentModelId: current, availableModels };
  return {
    sessionId: 'session-1',
    configOptions,
    models: ids ? listing : null,
  };
};

const CLAUDE_STATE = acpState({
  models: ['sonnet', 'opus', 'haiku'],
  efforts: ['default', 'low', 'medium', 'high', 'max'],
  fast: true,
  modes: ['default', 'acceptEdits'],
});

const CURSOR_STATE = acpState({
  models: [
    'default[]',
    'grok-4.6[effort=high,fast=true]',
    'composer-2[fast=true]',
    'gpt-5[context=272k,reasoning=low,fast=false]',
    'gpt-5[context=1m,reasoning=low,fast=false]',
    'gpt-5[context=272k,reasoning=high,fast=false]',
    'gpt-5[context=1m,reasoning=high,fast=false]',
  ],
});

const CODEX_STATE = acpState({
  models: ['gpt-a', 'gpt-b'],
  efforts: ['low', 'medium', 'high'],
  listed: [
    'gpt-a[low]',
    'gpt-a[high]',
    'gpt-a[ultra]',
    'gpt-b[low]',
    'gpt-b[medium]',
  ],
});

const STATES = {
  claude: CLAUDE_STATE,
  cursor: CURSOR_STATE,
  codex: CODEX_STATE,
};

const listed = async (row) => STATES[row.id] ?? null;

const rowOf = (spec, catalog = null) => {
  const [name, ...args] = spec.commands[0];
  const { id } = spec;
  return { id, name: spec.name, bin: `/usr/bin/${name}`, args, spec, catalog };
};

const specOf = (id) => AGENTS.find((spec) => spec.id === id);

const openUi = async ({ color = false, columns, rows } = {}) => {
  const repo = makeRepo();
  repo.write('a.js', 'ok\n');
  repo.git(['add', '.']);
  repo.git(['commit', '-m', 'init']);
  const stdout = uiSink();
  if (columns) stdout.columns = columns;
  if (rows) stdout.rows = rows;
  const ui = await openRepoSession(repo.dir, { stdout, color });
  return { ui, repo, stdout };
};

// The session of openUi with fake agent bins on PATH, removed after the
// test. The options of openUi may come before the names.
const openAgents = async (t, ...names) => {
  const options = typeof names[0] === 'object' ? names.shift() : {};
  const { dir, bins, env } = fakePath(...names);
  const { ui, repo, stdout } = await openUi(options);
  t.after(() => {
    ui.agents.reset();
    repo.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { ui, repo, stdout, dir, bins, env };
};

const showAgents = async (ui, env, listModels = listed) => {
  ui.agents.listModels = listModels;
  ui.agents.refresh(env);
  await ui.agents.open();
};

const typeInto = (ui, text) => press(ui, ...text);

module.exports = {
  makeBin,
  fakePath,
  labelRow,
  select,
  acpState,
  CLAUDE_STATE,
  CURSOR_STATE,
  CODEX_STATE,
  STATES,
  listed,
  rowOf,
  specOf,
  openUi,
  openAgents,
  showAgents,
  typeInto,
};
