'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { clamp } = require('../../common/utilities.js');
const agents = require('../../agents/agents.js');
const { detectAgents, listModels, startAgent, buildLaunch } = agents;
const { signIn, signOut } = agents;
const { emptyChoice, catalogOf, buildInstall } = agents;
const review = require('../../review/review.js');
const { latestReviewName, listReviewNames, planFileNames } = review;
const { REVIEW_DIR } = require('../../common/files.js');
const render = require('../../render/log.js');
const { logRowCount } = render;
const { AgentForm, optionsOf, lastIndex } = require('./form.js');
const options = require('./options.js');
const { restoreChoice, storedChoice } = options;
const jobs = require('./jobs.js');
const { AwayRuns } = require('./away.js');
const { readPrefs, writePrefs } = require('../prefs.js');
const { elapsedLabel, launchJob, assignLog, stemOf } = jobs;
const { restoreJobs, readRunList, saveRunFiles } = jobs;
const { panelSessions, orderedSessions, runBlock } = jobs;
const { runningJobs, withLiveRuns } = jobs;
const plans = require('./plans.js');
const { planKey, planProgress, planPart, planLabel, alignPlanLabels } = plans;
const { planCaption, NO_PLAN } = plans;
const { NO_PICK, NO_LIST, NO_JOB } = require('./view.js');
const { Editor } = require('../../input/editor.js');

const TITLE_MAX = 72;

// How many agents are asked for their models and sign-in at the same time
const PROBE_POOL = 3;

const taskCaption = (task) => {
  const line = task.split('\n', 1)[0].trim();
  if (line.length <= TITLE_MAX) return line;
  return `${line.slice(0, TITLE_MAX - 1)}…`;
};

const STEM_ID = /-agent-\d+$/;

const continuedId = (session) => {
  const id = session && session.id ? `${session.id}` : '';
  if (STEM_ID.test(id)) return '';
  return id;
};

const cacheKey = (row) => `${row.id}:${row.bin}`;

const listQuietly = async (list, row, options) => {
  try {
    return await list(row, options);
  } catch {
    return null;
  }
};

class AgentsController extends AgentForm {
  constructor(ui) {
    super(ui);
    this.spawn = startAgent;
    this.listModels = listModels;
    this.signIn = signIn;
    this.signOut = signOut;
    this.probes = null;
    this.reset();
  }

  get root() {
    return this.ui.top || this.ui.cwd;
  }

  reset() {
    this.killAll();
    this.list = [];
    this.choices = new Map();
    this.loaded = new Map();
    this.asking = new Set();
    // A reset drops the answers of the probes that are still on their way
    this.modelsEpoch = (this.modelsEpoch ?? 0) + 1;
    this.probing = new Set();
    this.jobs = [];
    this.away = new AwayRuns();
    this.installs = new Map();
    this.installTarget = '';
    this.accounts = new Map();
    this.authBusy = '';
    this.authAction = '';
    this.authTarget = '';
    this.nextId = 1;
    this.viewing = false;
    this.viewId = 0;
    this.opened = false;
    this.runsRoot = '';
    this.pick = null;
    this.planPath = '';
    this.field = 'agent';
    this.task = new Editor('');
    this.focus = 'cli';
    this.runCursor = 0;
    this.runScroll = 0;
    this.followEnd = true;
    this.logScroll = 0;
    this.viewSession = '';
    this.historyText = '';
    this.historyAt = 0;
    this.env = process.env;
    this.refresh();
    this.loadRuns();
  }

  killAll() {
    if (this.probes) this.probes.abort();
    this.probes = null;
    for (const job of this.everyJob()) {
      if (job.child) job.child.kill();
    }
  }

  // The install of an adapter is watched like a run but is no session
  everyJob() {
    const installs = this.installs ? this.installs.values() : [];
    const runs = this.jobs ?? [];
    const away = this.away ? this.away.jobs() : [];
    return [...runs, ...away, ...installs];
  }

  reviewStore() {
    return this.ui.review ? this.ui.review.store : null;
  }

  applyCached(row) {
    const cached = this.loaded.get(cacheKey(row));
    if (cached) row.catalog = cached;
  }

  refresh(env = this.env) {
    this.env = env;
    const prev = this.choices;
    this.list = detectAgents(env);
    this.choices = new Map();
    for (const row of this.list) {
      this.applyCached(row);
      this.choices.set(row.id, prev.get(row.id) ?? emptyChoice());
    }
    this.loadChoices();
    this.clampCursor();
  }

  loadChoices() {
    if (!this.root) return;
    const saved = readPrefs(this.root).agents;
    for (const row of this.list) {
      const picked = this.choice(row.id);
      restoreChoice(picked, saved[row.id]);
      optionsOf(row).preferEffort(picked, 'medium');
    }
  }

  saveChoice(id) {
    const picked = this.choices.get(id);
    const row = this.cliById(id);
    if (!this.root || !picked || !row) return;
    const data = readPrefs(this.root);
    const saved = { ...data.agents };
    const stored = storedChoice(picked);
    if (stored) saved[id] = stored;
    else delete saved[id];
    writePrefs(this.root, { ...data, agents: saved });
  }

  loadRuns() {
    if (!this.root) return;
    const restored = restoreJobs(readRunList(this.root));
    this.jobs = restored.jobs;
    this.nextId = restored.nextId;
    this.runsRoot = this.root;
  }

  // The repository can change after construction: its runs and its saved
  // sessions must come from the same directory. A run that goes on in the
  // previous one stays with it
  syncRuns() {
    if (!this.root || this.root === this.runsRoot) return;
    this.away.park(this.runsRoot, this.jobs);
    const parked = this.away.take(this.root);
    if (parked) this.jobs = parked;
    else this.loadRuns();
    this.runsRoot = this.root;
    const last = this.jobs.reduce((max, job) => Math.max(max, job.id), 0);
    this.nextId = Math.max(this.nextId, last + 1);
    this.viewId = 0;
  }

  retarget() {
    this.viewing = false;
    this.viewId = 0;
    this.pick = null;
    this.viewSession = '';
  }

  // The runs in work by directory, for the screen of worktrees
  liveByRoot() {
    return this.away.counts(this.runsRoot, this.jobs);
  }

  saveRuns() {
    if (!this.root) return;
    saveRunFiles(this.runsRoot || this.root, this.jobs);
    this.away.save();
  }

  clampCursor() {
    const nav = this.ui.nav;
    nav.agentCursor = clamp(nav.agentCursor ?? 0, 0, lastIndex(this.list));
  }

  selected() {
    return this.list[this.ui.nav.agentCursor] ?? null;
  }

  cliById(id) {
    return this.list.find((row) => row.id === id) ?? null;
  }

  choice(id) {
    const row = this.cliById(id);
    if (!row) return emptyChoice();
    if (!this.choices.has(id)) this.choices.set(id, emptyChoice());
    return this.choices.get(id);
  }

  // Name, status and progress of the plan the next run reads
  planInfo() {
    if (this.noPlan()) return { name: NO_PLAN, status: '', progress: '' };
    const file = this.planFile();
    const part = file ? this.planPartOf(file) : null;
    if (!part) return { name: '', status: '', progress: '' };
    return { name: part.name, status: part.status, progress: part.progress };
  }

  rows() {
    const plan = this.planFace();
    const planBusy = this.planBusy(this.planFile());
    return this.list.map((row) => {
      const picked = this.choice(row.id);
      const choices = optionsOf(row);
      const model = choices.normalize(picked);
      const { effort, fast, context } = choices.settings(picked);
      return {
        ...row,
        model,
        effort,
        efforts: choices.efforts(model),
        fast,
        fasts: choices.fasts(model),
        context,
        contexts: choices.contexts(model),
        plan: row.bin ? plan : '',
        planBusy: Boolean(row.bin && planBusy),
      };
    });
  }

  sessionRows() {
    const cli = this.selected();
    const id = cli && cli.bin ? cli.id : '';
    const saved = panelSessions(this.root, this.jobs, id);
    const running = runningJobs(this.jobs, id);
    const progressOf = (job) =>
      planProgress(job.plan, this.root, this.reviewStore());
    const rows = withLiveRuns(saved, running, progressOf);
    this.runCursor = clamp(this.runCursor, 0, lastIndex(rows));
    return rows;
  }

  openRunRow(row) {
    if (!row) return false;
    if (row.jobId) {
      const job = this.jobById(row.jobId);
      if (job && job.status === 'running') {
        this.openView(job.id);
        return true;
      }
    }
    if (!row.id) return false;
    this.openSession(row.id);
    return true;
  }

  selectedSession() {
    return this.sessionRows()[this.runCursor] || null;
  }

  focusRuns() {
    if (this.viewing || this.pick) return;
    this.focus = 'runs';
    this.sessionRows();
  }

  focusCli() {
    if (this.viewing || this.pick) return;
    this.focus = 'cli';
  }

  toggleFocus() {
    if (this.focus === 'runs') this.focusCli();
    else this.focusRuns();
  }

  jobById(id) {
    return this.everyJob().find((job) => job.id === id) ?? null;
  }

  viewedJob() {
    return this.jobById(this.viewId);
  }

  runningJob(id) {
    const live = (job) => job.cliId === id && job.status === 'running';
    return this.jobs.findLast(live) ?? null;
  }

  runningCount() {
    const live = (job) => job.status === 'running';
    return this.everyJob().filter(live).length;
  }

  summary() {
    const items = this.rows().map((row) => {
      let running = 0;
      for (const job of this.jobs) {
        if (job.cliId === row.id && job.status === 'running') running += 1;
      }
      return { ...row, running };
    });
    return {
      ready: true,
      installed: items.filter((row) => row.bin).length,
      total: items.length,
      items,
      running: this.runningCount(),
    };
  }

  visibleText() {
    if (this.viewSession) return this.historyText;
    const job = this.viewedJob();
    return job ? job.output : '';
  }

  pickView(onAgents) {
    const pick = onAgents ? this.pick : null;
    if (!pick) return NO_PICK;
    const menu = this.menuItems();
    const onPlan = pick.field === 'plan';
    return {
      agentPick: pick.field,
      agentMenu: menu,
      agentQuery: pick.query,
      agentEditor: pick.editor,
      agentMenuOff: onPlan ? menu.filter(this.busyCheck()) : [],
      agentPickCursor: pick.cursor,
      agentMenuScroll: pick.scroll,
    };
  }

  listView(onAgents) {
    if (!onAgents) return NO_LIST;
    const agentRuns = this.sessionRows();
    const selected = agentRuns[this.runCursor];
    const running = Boolean(selected && selected.status === 'running');
    const fresh = Boolean(selected && selected.fresh);
    const resume = Boolean(continuedId(selected));
    const agentCanStart = running || fresh || resume;
    let agentStartMode = 'resume';
    if (running) agentStartMode = 'stop';
    else if (!selected || fresh) agentStartMode = 'start';
    return {
      agents: this.rows(),
      agentField: this.currentField(),
      agentPlan: this.planInfo(),
      agentTask: this.task,
      agentAccount: this.accountView(),
      agentAuthAsk: this.authAsk(),
      agentInstallCommand: this.installCommand(),
      agentInstallPackage: this.installPackage(),
      agentRuns,
      agentRunCursor: this.runCursor,
      agentRunScroll: this.runScroll,
      agentFocus: this.focus,
      agentCanStart,
      agentStartMode,
      agentPlanCount: this.reviewChoices().length,
      agentView: this.viewing,
    };
  }

  sessionView(session) {
    const named = this.sessionRows().find((item) => item.id === session);
    const agentCommand = named ? named.name : session;
    return { ...NO_JOB, agentOutput: this.historyText, agentCommand };
  }

  jobView() {
    if (this.viewSession) return this.sessionView(this.viewSession);
    const job = this.viewedJob();
    if (!job) return NO_JOB;
    const running = job.status === 'running';
    const name = stemOf(job.logName);
    const agentCommand = job.title || name || job.command;
    return {
      agentOutput: job.output,
      agentCommand,
      agentElapsed: elapsedLabel(job),
      agentProgress: planProgress(job.plan, this.root, this.reviewStore()),
      agentRunning: running,
      agentStatus: job.status,
    };
  }

  view(onAgents) {
    return {
      agentCursor: this.ui.nav.agentCursor,
      agentFollow: this.followEnd,
      agentScroll: this.logScroll,
      ...this.listView(onAgents),
      ...this.pickView(onAgents),
      ...this.jobView(),
    };
  }

  firstInstalled() {
    return Math.max(
      0,
      this.list.findIndex((row) => row.bin),
    );
  }

  restoreSelection() {
    const nav = this.ui.nav;
    const row = this.selected();
    if (this.opened && row && row.bin) return;
    nav.resetListScroll('agents');
    nav.agentCursor = this.firstInstalled();
    this.field = 'agent';
    this.focus = 'cli';
    this.selectLastSession();
  }

  // The session of the last run is the one selected, a new one only if none
  selectLastSession() {
    this.runCursor = 0;
    this.runCursor = this.sessionRows().length > 1 ? 1 : 0;
    this.runScroll = 0;
  }

  open() {
    const nav = this.ui.nav;
    this.syncRuns();
    this.refresh();
    this.viewing = false;
    nav.pane = 'agents';
    nav.clearSelection();
    this.restoreSelection();
    this.opened = true;
    this.ui.status = '';
    return this.loadModels();
  }

  isProbing(row) {
    return this.probing.has(cacheKey(row));
  }

  // The agent the screen opens on, which is the one to know about first
  defaultRow() {
    const row = this.selected();
    if (this.opened && row && row.bin) return row;
    return this.list[this.firstInstalled()] ?? null;
  }

  // The agents to ask, installed ones only, the default one first
  pendingRows() {
    const first = this.defaultRow();
    const waiting = this.list.filter((row) => {
      const key = cacheKey(row);
      return row.bin && !this.loaded.has(key) && !this.probing.has(key);
    });
    const rank = (row) => (first && row.id === first.id ? 0 : 1);
    return waiting.sort((left, right) => rank(left) - rank(right));
  }

  // A few agents are asked at a time, so that the first is not slowed
  async loadModels() {
    const epoch = this.modelsEpoch;
    const queue = this.pendingRows();
    if (!queue.length) return;
    for (const row of queue) this.probing.add(cacheKey(row));
    const work = async () => {
      while (queue.length) {
        await this.fetchModels(queue.shift(), epoch);
        if (epoch === this.modelsEpoch) this.ui.paint();
      }
    };
    const size = Math.min(PROBE_POOL, queue.length);
    await Promise.all(Array.from({ length: size }, work));
  }

  probeOptions(model) {
    this.probes ??= new AbortController();
    const { signal } = this.probes;
    const models = model ? [model] : [];
    return { env: this.env, cwd: this.root, signal, models };
  }

  // The agent lists its models only to a session, so one is opened to ask
  async fetchModels(row, epoch) {
    try {
      await this.probeModels(row, epoch);
    } finally {
      if (epoch === this.modelsEpoch) this.probing.delete(cacheKey(row));
    }
  }

  async probeModels(row, epoch) {
    const auth = {};
    const options = { ...this.probeOptions(this.choice(row.id).model), auth };
    const catalog = await listQuietly(this.listModels, row, options);
    if (epoch === this.modelsEpoch) this.noteAccount(row, auth);
    if (epoch !== this.modelsEpoch || !catalog) return;
    this.loaded.set(cacheKey(row), catalog);
    const current = this.cliById(row.id);
    if (!current || current.bin !== row.bin) return;
    this.applyCached(current);
    optionsOf(current).preferEffort(this.choice(current.id), 'medium');
  }

  // A model list that was refused is asked for again once signed in
  forgetModels(row) {
    this.loaded.delete(cacheKey(row));
    void this.loadModels();
  }

  // The settings of a model come from asking the agent about that model
  async describeModel(row, model) {
    const key = cacheKey(row);
    const mark = `${key}:${model}`;
    const known = this.loaded.get(key);
    if (!known || !catalogOf(known).unknown(model)) return;
    if (this.asking.has(mark)) return;
    this.asking.add(mark);
    const options = this.probeOptions(model);
    const found = await listQuietly(this.listModels, row, options);
    this.asking.delete(mark);
    const cached = this.loaded.get(key);
    if (!cached || !found || !(found.byModel instanceof Map)) return;
    const prior = cached.byModel ?? [];
    const byModel = new Map([...prior, ...found.byModel]);
    this.loaded.set(key, { ...cached, byModel });
    const current = this.cliById(row.id);
    if (current && current.bin === row.bin) this.applyCached(current);
    this.ui.paint();
  }

  logWidth() {
    const size = this.ui.lastSize;
    return size && size.width ? size.width : 0;
  }

  prependOlder() {
    if (!this.viewSession || this.historyAt <= 0) return 0;
    const runs = orderedSessions(this.jobs, this.viewSession);
    const job = runs[this.historyAt - 1];
    if (!job) return 0;
    const block = runBlock(this.root, job);
    const added = logRowCount(`${block}\n`, this.logWidth(), false);
    this.historyAt -= 1;
    const prev = this.historyText;
    this.historyText = prev ? `${block}\n${prev}` : block;
    return added;
  }

  scrollLog(delta) {
    const atTop = !this.followEnd && this.logScroll === 0;
    if (delta < 0 && atTop) {
      const added = this.prependOlder();
      if (added) this.logScroll = added;
    }
    const job = this.viewSession ? null : this.viewedJob();
    const running = Boolean(job && job.status === 'running');
    this.scrollLogBy(delta, this.visibleText(), running);
  }

  move(delta) {
    if (this.pick) return void this.movePick(delta);
    if (this.viewing) return void this.scrollLog(delta);
    this.ui.status = '';
    if (this.focus === 'runs') {
      const last = lastIndex(this.sessionRows());
      this.runCursor = clamp(this.runCursor + delta, 0, last);
      return;
    }
    this.moveField(delta);
  }

  reviewChoices() {
    const names = planFileNames(this.root);
    const file = this.foundPlan();
    const current = file ? path.basename(file) : '';
    if (current && !names.includes(current)) names.unshift(current);
    return names;
  }

  planPartOf(name) {
    const dir = path.join(this.root, REVIEW_DIR);
    return planPart(dir, name, this.reviewStore());
  }

  planFace() {
    const file = this.planFile();
    const part = file ? this.planPartOf(file) : null;
    return part ? planLabel(part) : '';
  }

  planMenu() {
    const parts = this.reviewChoices().map((name) => this.planPartOf(name));
    return [NO_PLAN, ...alignPlanLabels(parts.filter(Boolean))];
  }

  noPlan() {
    return this.planPath === NO_PLAN;
  }

  latestPlan() {
    const latest = latestReviewName(listReviewNames(this.root));
    return latest ? path.join(this.root, REVIEW_DIR, latest) : '';
  }

  planFile() {
    return this.noPlan() ? '' : this.foundPlan();
  }

  // The plan that is read when none is chosen out of the combo box
  foundPlan() {
    const chosen = this.noPlan() ? '' : this.planPath;
    if (chosen && fs.existsSync(chosen)) return chosen;
    const store = this.reviewStore();
    if (store && store.reviewPath) return store.reviewPath;
    return this.latestPlan();
  }

  savePlan(store) {
    if (store.dirty) this.ui.flushReview(true);
    if (fs.existsSync(store.reviewPath)) return true;
    store.dirty = true;
    this.ui.flushReview(true);
    return fs.existsSync(store.reviewPath);
  }

  ensurePlan() {
    if (this.noPlan()) return '';
    const store = this.reviewStore();
    const live = store ? store.reviewPath : '';
    const chosen = this.planPath;
    if (chosen && chosen !== live && fs.existsSync(chosen)) return chosen;
    if (live && this.savePlan(store)) return live;
    return this.latestPlan();
  }

  busyPlans() {
    const busy = new Set();
    for (const job of this.jobs) {
      if (job.status !== 'running') continue;
      const name = path.basename(`${job.plan ?? ''}`);
      if (name) busy.add(name);
    }
    return busy;
  }

  busyCheck() {
    const busy = this.busyPlans();
    return (file) => busy.has(planKey(file));
  }

  planBusy(file) {
    return this.busyPlans().has(planKey(file));
  }

  openSession(id) {
    const runs = orderedSessions(this.jobs, id);
    if (!runs.length) {
      this.ui.status = 'no log for this session';
      this.ui.paint();
      return;
    }
    const last = runs.at(-1);
    this.viewing = true;
    this.viewSession = id;
    this.viewId = 0;
    this.historyAt = runs.length - 1;
    this.historyText = runBlock(this.root, last);
    this.followEnd = true;
    this.logScroll = 0;
    this.ui.status = '';
    this.ui.paint();
  }

  openView(id) {
    if (!this.jobById(id)) return;
    this.viewing = true;
    this.viewSession = '';
    this.historyText = '';
    this.viewId = id;
    this.followEnd = true;
    this.logScroll = 0;
    this.ui.status = '';
    this.ui.paint();
  }

  closeView() {
    this.viewing = false;
    this.viewSession = '';
    this.historyText = '';
    this.ui.status = '';
    this.ui.paint();
  }

  syncProgress() {
    if (this.runningCount()) this.ui.progress.start('agents');
    else this.ui.progress.stop('agents');
  }

  keepLog(job) {
    const now = Date.now();
    if (now - job.loggedAt < 150) return;
    job.loggedAt = now;
    this.saveRuns();
  }

  showOutput(job, text) {
    job.output = text;
    job.dirty = true;
    job.captureStats();
    this.keepLog(job);
    const watched = this.viewing && this.viewId === job.id;
    if (watched || this.ui.nav.pane === 'agents') this.ui.paint();
  }

  settleJob(job, result) {
    job.syncRaw();
    job.dirty = true;
    if (result) job.finish(result);
    else job.stop();
    this.saveRuns();
    this.syncProgress();
  }

  finishJob(job, result) {
    if (job.status !== 'running') return;
    const stopped = job.stopping;
    this.settleJob(job, stopped ? null : result);
    if (stopped && this.viewing && this.viewId === job.id) {
      this.ui.status = 'stopped';
    }
    this.ui.paint();
  }

  startLaunch(launch, model) {
    if (!launch.ok) {
      this.ui.status = launch.error;
      return;
    }
    const job = launchJob(this.nextId, launch, model);
    this.nextId += 1;
    this.jobs.push(job);
    assignLog(this.root, job);
    const onData = (text) => this.showOutput(job, text);
    const onClose = (result) => this.finishJob(job, result);
    const child = this.spawn(this.root, launch, onData, onClose);
    if (job.status === 'running') job.child = child;
    this.saveRuns();
    this.syncProgress();
    if (this.jobs.at(-1) === job) this.openView(job.id);
  }

  // A task typed by hand goes to the agent before the plan
  startJob(row, sessionId = '') {
    const picked = this.choice(row.id);
    const task = this.taskText();
    const plan = this.ensurePlan();
    const launch = buildLaunch(row, picked, plan, this.root, sessionId, task);
    const title = task
      ? taskCaption(task)
      : planCaption(this.root, launch.plan);
    this.startLaunch({ ...launch, title }, picked.model);
    if (task && launch.ok) this.task = new Editor('');
  }

  prepareStart() {
    const row = this.selected();
    const live = row ? this.runningJob(row.id) : null;
    if (live) {
      this.openView(live.id);
      return null;
    }
    if (!row || !row.bin) {
      this.ui.status = 'not installed';
      return null;
    }
    const file = this.planFile();
    if (file && this.planBusy(file)) {
      this.ui.status = `busy ${path.basename(file)}`;
      return null;
    }
    return row;
  }

  rerun() {
    if (!this.viewing) return;
    const job = this.viewedJob();
    if (!job || job.status === 'running') return;
    if (job.action === 'install') {
      this.closeView();
      return void this.install(job.cliId);
    }
    const row = this.cliById(job.cliId);
    const plan = job.plan ? path.resolve(this.root, job.plan) : '';
    const resume = job.resume;
    const launch = buildLaunch(
      row,
      job.choice,
      plan,
      this.root,
      resume,
      job.task,
    );
    const title = planCaption(this.root, launch.plan) || job.title;
    this.startLaunch({ ...launch, title }, job.model);
  }

  installPackage() {
    const row = this.cliById(this.installTarget);
    return row ? row.package || row.installLabel : '';
  }

  // What the install button of the selected agent would run
  installCommand() {
    const row = this.selected();
    if (!row || row.bin) return '';
    const launch = buildInstall(row);
    return launch.ok ? launch.command : '';
  }

  proposeInstall() {
    if (this.viewing || this.pick) return;
    const row = this.selected();
    this.selectField('install');
    const live = row ? this.installs.get(row.id) : null;
    if (live && live.status === 'running') return void this.openView(live.id);
    const launch = buildInstall(row);
    if (!launch.ok) {
      this.ui.status = launch.error;
      return void this.ui.paint();
    }
    this.installTarget = row.id;
    this.ui.status = '';
    this.ui.mode = 'confirmAgentInstall';
    this.ui.paint();
  }

  cancelInstall() {
    this.installTarget = '';
    this.ui.mode = 'review';
    this.ui.paint();
  }

  confirmInstall() {
    const id = this.installTarget;
    this.installTarget = '';
    this.ui.mode = 'review';
    this.install(id);
  }

  install(id = '') {
    if (this.viewing || this.pick) return;
    const row = id ? this.cliById(id) : this.selected();
    const launch = buildInstall(row);
    if (!launch.ok) {
      this.ui.status = launch.error;
      return void this.ui.paint();
    }
    const job = launchJob(this.nextId, launch, '');
    this.nextId += 1;
    this.installs.set(row.id, job);
    const onData = (text) => this.showOutput(job, text);
    const onClose = (result) => this.finishInstall(job, result);
    const child = this.spawn(this.root, launch, onData, onClose);
    if (job.status === 'running') job.child = child;
    this.syncProgress();
    this.openView(job.id);
  }

  // Refresh PATH and managed registry locations after the installer exits.
  finishInstall(job, result) {
    if (job.status !== 'running') return;
    const stopped = job.stopping;
    this.settleJob(job, stopped ? null : result);
    this.ui.status = stopped ? 'stopped' : this.installOutcome(job, result);
    this.ui.paint();
  }

  installOutcome(job, result) {
    if (result.status !== 0) return 'install failed';
    this.refresh();
    const row = this.cliById(job.cliId);
    if (!row || !row.bin) return 'installed, but not found';
    void this.loadModels();
    return `installed ${job.name}`;
  }

  start() {
    if (this.pick) return void this.acceptPick();
    const session = this.selectedSession();
    if (this.focus === 'runs' && this.openRunRow(session)) return;
    const row = this.prepareStart();
    if (row) this.startJob(row, continuedId(session));
  }

  startSelected() {
    if (this.viewing || this.pick) return;
    const session = this.selectedSession();
    if (session && session.status === 'running') {
      return void this.stopSession(session);
    }
    if (!session) return;
    const resume = session.fresh ? '' : continuedId(session);
    if (!session.fresh && !resume) return;
    const row = this.prepareStart();
    if (row) this.startJob(row, resume);
  }

  // The key of the start stops the session that is selected and running
  stopSession(session) {
    this.terminate(this.jobById(session.jobId));
  }

  terminate(job) {
    if (!job || job.status !== 'running' || !job.child) return;
    job.stopping = true;
    job.child.kill();
    if (job.status !== 'running') return;
    this.settleJob(job, null);
    this.ui.status = 'stopped';
    this.ui.paint();
  }

  selectedJob() {
    const row = this.selected();
    return row ? this.runningJob(row.id) : null;
  }

  stop() {
    const job = this.viewing ? this.viewedJob() : this.selectedJob();
    this.terminate(job);
  }
}

module.exports = { AgentsController };
