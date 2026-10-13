'use strict';

const path = require('node:path');
const { isHashObject } = require('metautil');
const { pad2, withNotice, readText } = require('../../common/utilities.js');
const { LOG_DIR } = require('../../common/files.js');
const { choiceOf } = require('../../agents/models.js');

const RUN_KEEP = 40;

const OUTPUT_KEEP = 100000;

const exitLabel = (status) => {
  if (status === null || status === undefined || status === '') {
    return 'stopped';
  }
  return `exit ${status}`;
};

const elapsedSeconds = (job, now = Date.now()) => {
  const start = Number(job && job.startedAt) || 0;
  if (!start) return 0;
  const end = job.status === 'running' ? now : Number(job.endedAt) || now;
  return Math.max(0, Math.floor((end - start) / 1000));
};

const elapsedLabel = (job, now = Date.now()) => {
  const start = Number(job && job.startedAt) || 0;
  if (!start) return '';
  const sec = elapsedSeconds(job, now);
  const hours = Math.floor(sec / 3600);
  const mins = Math.floor((sec % 3600) / 60);
  const secs = pad2(sec % 60);
  if (hours) return `${hours}:${pad2(mins)}:${secs}`;
  return `${mins}:${secs}`;
};

const textOf = (value, fallback = '') => `${value ?? fallback}`;

const countOf = (value) => {
  const raw = `${value ?? ''}`.replaceAll(',', '');
  const number = Number(raw);
  if (!Number.isFinite(number) || number < 0) return null;
  return Math.floor(number);
};

const countField = (value) => {
  if (value === undefined || value === null || value === '') return null;
  return countOf(value);
};

const restoredState = (item) => {
  if (item.running === true || item.status === 'running') {
    return { status: 'running', exit: null };
  }
  if (item.stopped === true || item.status === 'stopped') {
    return { status: 'stopped', exit: null };
  }
  if (typeof item.exit === 'number') {
    return { status: `exit ${item.exit}`, exit: item.exit };
  }
  const status = textOf(item.status);
  const code = status.startsWith('exit ') ? Number(status.slice(5)) : NaN;
  if (Number.isFinite(code)) return { status, exit: code };
  return { status: status || 'stopped', exit: null };
};

const outcome = (job) => {
  if (job.status === 'running') return { running: true };
  if (typeof job.exit === 'number') return { exit: job.exit };
  return { stopped: true };
};

const applyElapsed = (job, item) => {
  if (job.endedAt || !job.startedAt) return;
  const elapsed = Number(item.elapsed);
  if (!Number.isFinite(elapsed)) return;
  job.endedAt = job.startedAt + elapsed * 1000;
};

const readLog = (root, name) =>
  root && name ? readText(path.join(root, LOG_DIR, name)) : '';

class AgentJob {
  constructor(fields) {
    this.id = fields.id;
    this.cliId = fields.cliId;
    this.name = fields.name;
    this.model = fields.model;
    this.choice = choiceOf(fields.choice ?? { model: fields.model });
    this.resume = textOf(fields.resume);
    this.command = fields.command;
    this.plan = fields.plan;
    this.action = fields.action;
    this.status = fields.status;
    this.exit = fields.exit;
    this.output = fields.output;
    this.session = textOf(fields.session);
    this.files = countField(fields.files);
    this.tokens = countField(fields.tokens);
    this.child = null;
    this.startedAt = fields.startedAt;
    this.endedAt = fields.endedAt;
    this.stopping = false;
    this.logName = textOf(fields.logName);
    this.rawName = textOf(fields.rawName);
    this.rawText = textOf(fields.rawText);
    this.held = fields.held === true;
    this.dirty = fields.dirty === true;
    this.loggedAt = 0;
  }

  static launch(id, launch, model) {
    return new AgentJob({
      id,
      cliId: launch.id,
      name: launch.name,
      model,
      choice: launch.choice,
      resume: launch.session,
      command: launch.command,
      plan: launch.plan,
      action: launch.kind,
      status: 'running',
      exit: null,
      output: '',
      session: launch.session,
      startedAt: Date.now(),
      endedAt: 0,
      dirty: true,
    });
  }

  static restore(item, fallbackId) {
    const state = restoredState(item);
    const inline = textOf(item.output);
    const job = new AgentJob({
      id: Number(item.id) || fallbackId,
      cliId: textOf(item.cliId),
      name: textOf(item.name),
      model: textOf(item.model),
      choice: item.choice,
      resume: item.resume,
      command: textOf(item.command),
      plan: textOf(item.plan),
      action: textOf(item.action, 'run'),
      status: state.status,
      exit: state.exit,
      output: inline,
      logName: item.log,
      rawName: item.raw,
      held: !inline,
      dirty: Boolean(inline),
      session: item.session,
      files: item.files,
      tokens: item.tokens,
      startedAt: Number(item.startedAt) || 0,
      endedAt: Number(item.endedAt) || 0,
    });
    if (state.status !== 'running') applyElapsed(job, item);
    if (job.status !== 'running') return job;
    job.status = 'stopped';
    job.output = withNotice(job.output, 'interrupted');
    job.endedAt ||= job.startedAt || Date.now();
    return job;
  }

  elapsed(now = Date.now()) {
    return elapsedLabel(this, now);
  }

  // The session is known as soon as it opens, long before the run ends
  captureStats(given) {
    const { child } = this;
    const live = child && typeof child.stats === 'function';
    const stats = given ?? (live ? child.stats() : null);
    if (!stats) return;
    if (stats.session) this.session = stats.session;
    if (typeof stats.files === 'number') this.files = stats.files;
    if (typeof stats.tokens === 'number') this.tokens = stats.tokens;
  }

  syncRaw() {
    const { child } = this;
    if (child && typeof child.raw === 'function') this.rawText = child.raw();
  }

  record() {
    this.captureStats();
    const saved = {
      id: this.id,
      cliId: this.cliId,
      name: this.name,
      model: this.model,
      choice: this.choice,
      command: this.command,
      plan: this.plan,
      action: this.action,
      ...outcome(this),
      elapsed: elapsedSeconds(this),
      startedAt: this.startedAt,
    };
    if (this.logName) saved.log = this.logName;
    if (this.rawName) saved.raw = this.rawName;
    if (this.resume) saved.resume = this.resume;
    if (this.session) saved.session = this.session;
    if (typeof this.files === 'number') saved.files = this.files;
    return saved;
  }

  close(status, exit, output) {
    this.status = status;
    this.exit = exit;
    this.output = output;
    this.endedAt = Date.now();
    this.child = null;
    this.stopping = false;
  }

  stop() {
    this.close('stopped', null, withNotice(this.output, 'terminated'));
  }

  finish(result) {
    this.captureStats(result.stats);
    this.close(exitLabel(result.status), result.status, result.text ?? '');
  }
}

const launchJob = (id, launch, model) => AgentJob.launch(id, launch, model);

const restoreJobs = (saved) => {
  const jobs = [];
  let nextId = 1;
  for (const item of Array.isArray(saved) ? saved : []) {
    // Signing in was a run of its own before agents were reached over ACP
    if (!isHashObject(item) || item.action === 'login') continue;
    const job = AgentJob.restore(item, nextId);
    nextId = Math.max(nextId, job.id + 1);
    jobs.push(job);
  }
  return { jobs, nextId };
};

module.exports = {
  RUN_KEEP,
  OUTPUT_KEEP,
  elapsedLabel,
  textOf,
  readLog,
  launchJob,
  restoreJobs,
};
