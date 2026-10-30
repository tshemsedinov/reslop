'use strict';

const { withNotice, withNewline, clamp } = require('../common/utilities.js');
const { startNpm } = require('../runs/process.js');
const { RunPanel } = require('../render/log.js');
const { loggedText } = require('../report/render.js');
const { readRuns } = require('../runs/runs.js');
const { foldSteps } = require('../dashboard/model.js');
const scripts = require('../runs/scripts.js');
const { listCommands, saveScript, removeScripts, reorderScript } = scripts;
const { reduceOutput } = require('../runs/output.js');
const logs = require('../runs/logs.js');
const { nextLogFile, saveLogs, readSavedRuns, readLogPair } = logs;
const { staleLogFiles, removeStaleLogs, fileName } = logs;
const historyPart = require('./npm-history.js');
const { launchedReslop, RUN_KEEP, historyCounts, historyExit } = historyPart;
const { historyName, historyMark, countText, elapsedText } = historyPart;
const { whenLabel, runLabel, applyExternal, solveTasks } = historyPart;
const { recordedItem, sameWindow, noteTests, filteredOutput } = historyPart;
const { manifestWritable } = require('./packages.js');
const { size } = require('../common/format.js');
const { TASKS_FILE } = require('../common/files.js');
const { stripAnsi } = require('../term/ansi.js');

const NAME_RE = /^[\w:.-]+$/;

const OUTPUT_MS = 60;

const newRun = (id, fields) => ({
  id,
  raw: '',
  output: '',
  child: null,
  stopping: false,
  followEnd: true,
  logScroll: 0,
  result: null,
  progress: null,
  ...fields,
});

// The output of a run as a task reads it: the filtered log when there is one
const runText = (run, root) => {
  if (run.raw) return filteredOutput(run.raw, root, run.exit).output;
  return reduceOutput(run.output, root, '');
};

// The output a run ends with: what it printed, or a notice that it stopped
const runOutput = (run, result, end) => {
  const { stopped, top, rawFile } = end;
  if (!stopped) return filteredOutput(result.text, top, result.status, rawFile);
  const output = withNotice(reduceOutput(run.raw, top, ''), 'terminated');
  return { output, log: output };
};

const entryOf = ({ name, kind, command }) => ({ name, kind, command });

class NpmController extends RunPanel {
  constructor(ui) {
    super(ui);
    this.reset();
  }

  // Runs belong to the worktree they started in and go on while another
  // one is shown
  get runs() {
    let list = this.byTop.get(this.ui.top);
    if (!list) {
      list = [];
      this.byTop.set(this.ui.top, list);
    }
    return list;
  }

  set runs(list) {
    this.byTop.set(this.ui.top, list);
  }

  get runCursor() {
    return this.ui.nav.npmRunCursor;
  }

  set runCursor(value) {
    this.ui.nav.npmRunCursor = value;
  }

  everyRun() {
    return [...this.byTop.values()].flat();
  }

  reset() {
    for (const run of this.byTop ? this.everyRun() : []) {
      if (run.status === 'running' && run.child) run.child.kill();
    }
    this.byTop = new Map();
    this.nextId = 1;
    this.viewId = 0;
    this.focus = 'commands';
    this.runCursor = 0;
    this.runScroll = 0;
    this.commands = [];
    this.viewing = false;
    this.verbose = false;
    this.editName = '';
    this.editField = '';
    this.draftName = '';
    this.draftCommand = '';
    this.dropName = '';
    this.dropNames = [];
    this.dropKind = '';
    this.logBytes = 0;
    this.ui.progress.stop('npm');
  }

  get logLabel() {
    if (!this.logBytes) return '';
    return `old logs ${size(this.logBytes)}`;
  }

  get running() {
    return this.everyRun().some((run) => run.status === 'running');
  }

  // The count of runs in work by the directory they started in
  liveByRoot() {
    const live = new Map();
    for (const run of this.everyRun()) {
      if (run.status !== 'running') continue;
      live.set(run.top, (live.get(run.top) ?? 0) + 1);
    }
    return live;
  }

  // Another worktree is shown: its commands and runs replace these
  retarget() {
    this.viewing = false;
    this.verbose = false;
    this.viewId = 0;
    this.runCursor = 0;
    this.commands = [];
    this.dropName = '';
    this.dropNames = [];
    this.logBytes = 0;
  }

  view(active) {
    return {
      npmCommands: this.commands,
      npmCursor: this.ui.nav.npmCursor,
      npmView: this.viewing,
      npmOutput: this.output,
      npmFollow: this.followEnd,
      npmScroll: this.logScroll,
      npmRuns: active ? this.sessionRows() : [],
      npmRunCursor: this.runCursor,
      npmFocus: this.focus,
      npmRunScroll: this.runScroll,
      npmEditName: this.editName,
      npmEditField: this.editField,
      npmDraftName: this.draftName,
      npmDraftCommand: this.draftCommand,
      npmRunning: this.viewedRunning(),
      npmCanSolve: this.canSolve(),
      npmLogs: active ? this.logLabel : '',
    };
  }

  get output() {
    const run = this.viewedRun();
    if (!run) return '';
    if (this.verbose) return withNewline(run.raw);
    this.syncOutput(run);
    return run.output ?? '';
  }

  get followEnd() {
    const run = this.viewedRun();
    if (!run) return true;
    return run.followEnd !== false;
  }

  set followEnd(value) {
    const run = this.viewedRun();
    if (run) run.followEnd = value;
  }

  get logScroll() {
    return this.viewedRun()?.logScroll ?? 0;
  }

  set logScroll(value) {
    const run = this.viewedRun();
    if (run) run.logScroll = value;
  }

  dashboardRuns() {
    return this.historyRuns().map((run) => ({
      name: run.name,
      kind: run.kind,
      command: run.command,
      label: run.label,
      running: run.status === 'running',
      exit: run.exit,
      startedAt: run.startedAt || 0,
      endedAt: run.endedAt || 0,
      progress: run.progress,
      result: run.result,
    }));
  }

  get lastRun() {
    const live = this.runs.find((run) => run.status === 'running');
    const run = live || this.runs.at(-1);
    if (!run) return null;
    return {
      label: run.label,
      running: run.status === 'running',
      exit: run.exit,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
    };
  }

  viewedRun() {
    return this.runs.find((run) => run.id === this.viewId) || null;
  }

  viewedRunning() {
    if (!this.viewing) return this.running;
    const run = this.viewedRun();
    return Boolean(run && run.status === 'running');
  }

  canSolve() {
    const run = this.viewedRun();
    if (!this.viewing || !run || run.status !== 'exited') return false;
    return run.exit !== 0 && run.exit !== '0' && run.exit !== '';
  }

  solve() {
    const ui = this.ui;
    if (!this.canSolve() || !ui.review.store) return;
    const run = this.viewedRun();
    this.hydrate(run);
    this.syncOutput(run);
    const root = run.top ?? ui.top;
    const output = stripAnsi(runText(run, root)).trim();
    const command = run.command || run.label || runLabel(run);
    const store = ui.review.store;
    // A task the plan already has open is not added again
    const open = store.tasks.filter((task) => !task.done);
    const known = new Map(open.map((task) => [task.text, task]));
    const added = solveTasks(run, command, output, root).map(
      (text) =>
        known.get(text) ?? store.addTask(TASKS_FILE, text, false, 'bugs'),
    );
    this.closeView();
    const tasks = ui.composer.tasks;
    tasks.openTasksPage();
    tasks.followRow({ task: added[0] });
    ui.flushReview(true);
  }

  historyRuns() {
    const runs = this.runs.filter((run) => !launchedReslop(run));
    return foldSteps(runs).slice(0, RUN_KEEP);
  }

  sessionRows() {
    const now = Date.now();
    return this.historyRuns().map((run) => {
      const counts = historyCounts(run);
      const exitText = historyExit(run, counts);
      return {
        id: run.id,
        name: historyName(run),
        live: run.status === 'running',
        mark: historyMark(run),
        done: countText(counts?.done),
        ok: countText(counts?.ok),
        fail: countText(counts?.fail),
        total: counts ? countText(counts.total) : exitText,
        exitLabel: exitText !== '',
        okN: counts ? counts.ok : null,
        failN: counts ? counts.fail : null,
        elapsed: elapsedText(run, now),
        when: whenLabel(run.startedAt || run.endedAt || 0),
      };
    });
  }

  clampRuns() {
    const last = Math.max(0, this.historyRuns().length - 1);
    this.runCursor = clamp(this.runCursor, 0, last);
  }

  focusRun(run) {
    const at = this.commands.findIndex(
      (entry) => entry.name === run.name && entry.kind === run.kind,
    );
    if (at >= 0) this.ui.nav.npmCursor = at;
    const index = this.historyRuns().findIndex((item) => item.id === run.id);
    if (index >= 0) this.runCursor = index;
  }

  selected() {
    return this.commands[this.ui.nav.npmCursor];
  }

  refresh() {
    this.commands = listCommands(this.ui.top);
    const last = this.commands.length - 1;
    const nav = this.ui.nav;
    nav.npmCursor = clamp(nav.npmCursor, 0, last);
  }

  refreshLogs() {
    try {
      this.logBytes = staleLogFiles(this.ui.top).bytes;
    } catch (error) {
      this.logBytes = 0;
      this.ui.status = error.message;
    }
  }

  adopt(item) {
    const run = newRun(this.nextId, {
      name: item.name,
      kind: item.kind,
      script: item.script ?? '',
      command: item.command ?? '',
      label: item.kind === 'command' ? historyName(item) : runLabel(item),
      status: item.status,
      exit: item.exit,
      startedAt: item.startedAt,
      endedAt: item.endedAt,
      logName: item.logName,
      rawName: item.rawName,
      externalId: item.externalId || '',
      top: this.ui.top,
      result: item.result ?? null,
      progress: item.progress ?? null,
      saved: true,
      hydrated: false,
    });
    this.nextId += 1;
    return run;
  }

  knownLogs() {
    const known = new Set();
    for (const run of this.runs) {
      if (run.logName) known.add(run.logName);
      if (run.externalId) known.add(run.externalId);
    }
    return known;
  }

  findRecorded(key, logName) {
    return this.runs.find((run) => {
      if (key && run.externalId === key) return true;
      return Boolean(logName && run.externalId && run.logName === logName);
    });
  }

  absorbRecorded(recorded, known, added) {
    let changed = false;
    for (const record of recorded) {
      const logName = fileName(record.log);
      const key = `${record.id ?? ''}`;
      const found = this.findRecorded(key, logName);
      if (found) {
        if (applyExternal(found, record)) changed = true;
        continue;
      }
      const seenLog = logName && known.has(logName);
      const seenKey = key && known.has(key);
      if (seenLog || seenKey) continue;
      if (logName) known.add(logName);
      if (key) known.add(key);
      added.push(this.adopt(recordedItem(record)));
      changed = true;
    }
    return changed;
  }

  settleLost(recorded) {
    const live = new Set(recorded.map((record) => `${record.id ?? ''}`));
    let changed = false;
    for (const run of this.runs) {
      const external = run.externalId && run.status === 'running';
      if (!external || live.has(run.externalId)) continue;
      run.status = 'stopped';
      run.exit = '';
      run.endedAt ||= Date.now();
      changed = true;
    }
    return changed;
  }

  storeAdded(added) {
    if (!added.length) return;
    const running = this.runs.filter((run) => run.status === 'running');
    const done = this.runs.filter((run) => run.status !== 'running');
    done.push(...added);
    done.sort((left, right) => {
      const at = left.startedAt - right.startedAt;
      if (at) return at;
      return left.id - right.id;
    });
    this.runs = [...done, ...running];
  }

  followAdded(added) {
    const current = this.viewedRun();
    if (!this.viewing || !current?.externalId || !current.script) return false;
    if (current.followEnd === false) return false;
    const next = added
      .filter(
        (run) =>
          run.script === current.script &&
          run.startedAt >= current.startedAt &&
          sameWindow(current, run),
      )
      .sort((left, right) => left.startedAt - right.startedAt)
      .at(-1);
    if (!next) return false;
    this.viewId = next.id;
    this.focusRun(next);
    return true;
  }

  followExternal() {
    this.syncProgress();
    if (this.ui.nav.pane === 'npm') this.ui.paint();
  }

  refreshRecorded() {
    let recorded = null;
    try {
      recorded = readRuns(this.ui.top);
    } catch {
      // unreadable runs
    }
    if (!recorded) return;
    const added = [];
    let changed = this.absorbRecorded(recorded, this.knownLogs(), added);
    if (this.settleLost(recorded)) changed = true;
    this.storeAdded(added);
    if (this.followAdded(added)) changed = true;
    if (this.hydrate(this.viewedRun())) changed = true;
    if (changed) this.followExternal();
  }

  loadSaved() {
    const known = this.knownLogs();
    let saved = null;
    let recorded = null;
    try {
      saved = readSavedRuns(this.ui.top, this.commands);
      recorded = readRuns(this.ui.top);
    } catch (error) {
      this.ui.status = error.message;
    }
    if (!saved || !recorded) return;
    const added = [];
    for (const item of saved) {
      if (!item.logName || known.has(item.logName)) continue;
      known.add(item.logName);
      added.push(this.adopt(item));
    }
    const changed = this.absorbRecorded(recorded, known, added);
    this.storeAdded(added);
    if (changed) this.followExternal();
  }

  siblingText(run) {
    const name = historyName(run);
    for (const other of this.runs) {
      if (other === run || historyName(other) !== name) continue;
      if (!sameWindow(run, other)) continue;
      const saved = readLogPair(this.ui.top, other.logName, other.rawName);
      const output = other.output || saved.output;
      const raw = other.raw || saved.raw;
      if (!output && !raw) continue;
      return { output, raw: raw || output };
    }
    return { output: '', raw: '' };
  }

  // A saved .log is Markdown for agents, the screen shows the raw text filtered
  styledOutput(run, raw) {
    const top = run.top ?? this.ui.top;
    const exited = run.status === 'exited' ? run.exit : '';
    return filteredOutput(raw, top, exited).output;
  }

  hydrate(run) {
    if (!run || !run.logName) return false;
    const settled = run.externalId && run.status !== 'running';
    if (!settled && (run.hydrated || run.output || run.raw)) return false;
    const text = readLogPair(this.ui.top, run.logName, run.rawName);
    const saved = text.output || text.raw ? text : this.siblingText(run);
    if (!saved.output && !saved.raw) return false;
    const raw = saved.raw || saved.output;
    const output = saved.raw ? this.styledOutput(run, saved.raw) : saved.output;
    if (run.output === output && run.raw === raw) return false;
    run.output = output;
    run.raw = raw;
    run.hydrated = true;
    return true;
  }

  open() {
    if (this.ui.mode === 'compose') return;
    this.refresh();
    this.refreshLogs();
    const fresh = this.runs.length === 0;
    this.loadSaved();
    if (fresh && this.historyRuns().length) this.runCursor = 0;
    this.viewing = false;
    this.verbose = false;
    this.ui.nav.openList('npm');
    this.ui.nav.listSide = this.focus === 'runs' ? 'runs' : 'commands';
    this.ui.status = '';
  }

  syncProgress() {
    if (this.running) this.ui.progress.start('npm');
    else this.ui.progress.stop('npm');
  }

  placeRuns(start) {
    const bar = this.ui.lastFrame && this.ui.lastFrame.scrollBar;
    if (!bar) return;
    super.placeRuns(start);
    const top = this.runScroll;
    const last = Math.max(0, this.historyRuns().length - 1);
    if (this.runCursor < top) this.runCursor = top;
    const bottom = Math.min(last, top + bar.rows - 1);
    if (this.runCursor > bottom) this.runCursor = bottom;
  }

  scrollLog(delta) {
    this.scrollLogBy(delta, this.output, this.viewedRunning());
  }

  moveRun(delta, extend = false) {
    const nav = this.ui.nav;
    nav.listSide = 'runs';
    nav.moveList(delta, this.historyRuns().length, extend);
    this.ui.status = '';
    this.ui.paint();
  }

  move(delta, extend = false) {
    if (this.viewing) return void this.scrollLog(delta);
    const nav = this.ui.nav;
    const runs = this.focus === 'runs';
    nav.listSide = runs ? 'runs' : 'commands';
    if (runs) return void this.moveRun(delta, extend);
    const before = nav.npmCursor;
    nav.moveList(delta, this.commands.length, extend);
    if (nav.npmCursor === before && !extend) return;
    this.clampRuns();
    this.ui.status = '';
  }

  pointList(side) {
    const nav = this.ui.nav;
    const stay = this.focus === side && nav.listSide === side;
    this.focus = side;
    nav.listSide = side;
    if (stay) return;
    nav.clearListPick();
    if (side === 'runs') this.clampRuns();
    this.ui.paint();
  }

  focusCommands() {
    this.pointList('commands');
  }

  focusRuns() {
    this.pointList('runs');
  }

  toggleFocus() {
    if (this.focus === 'runs') this.focusCommands();
    else this.focusRuns();
  }

  showOutput(run, text) {
    if (run.status !== 'running' || run.stopping) return;
    run.raw = text;
    run.stale = true;
    const wait = OUTPUT_MS - (Date.now() - (run.shownAt ?? 0));
    if (wait <= 0) return void this.flushOutput(run);
    const flush = () => this.flushOutput(run);
    this.ui.term.later(`npm-output-${run.id}`, flush, wait);
  }

  syncOutput(run) {
    if (!run.stale) return false;
    run.stale = false;
    run.shownAt = Date.now();
    const top = run.top ?? this.ui.top;
    noteTests(run, this.byTop.get(top) ?? this.runs, run.raw);
    run.output = filteredOutput(run.raw, top, '').output;
    return true;
  }

  flushOutput(run) {
    if (!this.syncOutput(run)) return;
    const pane = this.ui.nav.pane;
    if (pane === 'npm' || pane === 'dashboard') this.ui.paint();
  }

  async finishRun(run, entry, result) {
    const ui = this.ui;
    const top = run.top ?? ui.top;
    const stopped = run.stopping === true;
    const raw = stopped ? withNotice(run.raw, 'terminated') : result.text;
    let slot = null;
    try {
      slot = nextLogFile(top, entry.name);
    } catch (error) {
      ui.status = error.message;
    }
    const rawFile = slot ? slot.rawName : '';
    const filtered = runOutput(run, result, { stopped, top, rawFile });
    run.raw = raw;
    run.stale = false;
    run.exit = stopped ? '' : result.status;
    run.status = stopped ? 'stopped' : 'exited';
    run.output = filtered.output;
    if (filtered.result) run.result = filtered.result;
    run.endedAt = Date.now();
    run.child = null;
    run.stopping = false;
    const watched = this.viewing && this.viewId === run.id;
    if (stopped && watched) ui.status = 'terminated';
    this.syncProgress();
    ui.paint();
    if (launchedReslop(run)) return;
    if (!slot) return;
    run.logName = slot.name;
    run.rawName = slot.rawName;
    try {
      await saveLogs(slot, loggedText(filtered.log, slot.rawName), raw, run);
    } catch (error) {
      ui.status = error.message;
      ui.paint();
    }
  }

  startRun(entry, openLog = false) {
    const ui = this.ui;
    const run = newRun(this.nextId, {
      name: entry.name,
      kind: entry.kind,
      command: entry.command ?? '',
      label: runLabel(entry),
      status: 'running',
      exit: '',
      startedAt: Date.now(),
      endedAt: 0,
      top: ui.top,
    });
    this.nextId += 1;
    this.runs.push(run);
    if (openLog) {
      this.viewing = true;
      this.viewId = run.id;
    }
    this.focusRun(run);
    ui.status = '';
    this.syncProgress();
    const start = (ui.repo && ui.repo.runNpmCommand) || startNpm;
    const child = start(
      ui.top,
      entry,
      (text) => this.showOutput(run, text),
      (result) => this.finishRun(run, entry, result),
    );
    if (run.status === 'running') run.child = child;
    ui.paint();
    return child;
  }

  openView(id) {
    const run = this.runs.find((item) => item.id === id);
    if (!run) return;
    this.hydrate(run);
    this.verbose = false;
    this.viewing = true;
    this.viewId = id;
    this.ui.status = '';
    this.ui.paint();
  }

  run() {
    if (this.viewing) return null;
    if (this.focus === 'runs') {
      const picked = this.historyRuns()[this.runCursor];
      if (picked) {
        this.openView(picked.id);
        return null;
      }
    }
    const entry = this.selected();
    if (!entry) return null;
    this.verbose = false;
    return this.startRun(entry);
  }

  rerun() {
    if (!this.viewing) return;
    const current = this.viewedRun();
    const entry = current ? entryOf(current) : this.selected();
    if (entry && entry.name) this.startRun(entry, true);
  }

  closeView() {
    this.viewing = false;
    this.verbose = false;
    this.ui.status = '';
    this.ui.paint();
  }

  stop(run = this.viewedRun()) {
    if (!run || run.status !== 'running') return;
    this.syncOutput(run);
    run.stopping = true;
    if (run.child) run.child.kill();
    if (run.status !== 'running') return void this.syncProgress();
    run.raw = withNotice(run.raw, 'terminated');
    run.output = withNotice(run.output, 'terminated');
    run.status = 'stopped';
    run.exit = '';
    run.endedAt = Date.now();
    run.child = null;
    const watched = this.viewing && this.viewId === run.id;
    if (watched) this.ui.status = 'terminated';
    this.syncProgress();
    this.ui.paint();
  }

  stopAll() {
    for (const run of this.everyRun()) this.stop(run);
  }

  toggleVerbose() {
    if (!this.viewing || !this.viewedRun()) return;
    this.verbose = !this.verbose;
    this.ui.status = this.verbose ? 'verbose' : 'filtered';
    this.ui.paint();
  }

  editable() {
    if (this.viewing) return false;
    return manifestWritable(this.ui);
  }

  selectedScript() {
    if (!this.editable()) return null;
    const entry = this.selected();
    if (entry && entry.kind === 'script') return entry;
    this.ui.status = 'not a script';
    return null;
  }

  focusScript(name) {
    const at = this.commands.findIndex((entry) => entry.name === name);
    if (at >= 0) this.ui.nav.npmCursor = at;
  }

  startEdit(name, command) {
    this.editName = name;
    this.editField = 'name';
    this.draftName = name;
    this.draftCommand = command;
    this.ui.composer.openCompose('npm', name);
  }

  edit() {
    const entry = this.selectedScript();
    if (entry) this.startEdit(entry.name, entry.command ?? '');
  }

  create() {
    if (this.editable()) this.startEdit('', '');
  }

  switchField(editor, field, text) {
    this.editField = field;
    editor.replace(text);
    this.ui.status = '';
  }

  finishName(editor) {
    const name = editor.text.trim();
    if (!name || !NAME_RE.test(name)) {
      this.ui.status = 'name';
      return false;
    }
    this.draftName = name;
    this.switchField(editor, 'command', this.draftCommand);
    return true;
  }

  focusField(field) {
    const editor = this.ui.editor;
    if (!editor) return false;
    if (field === this.editField) return true;
    if (field === 'command') return this.finishName(editor);
    this.draftCommand = editor.text;
    this.switchField(editor, 'name', this.draftName);
    return true;
  }

  writeScripts(write) {
    try {
      this.ui.ignoreWatch();
      write(this.ui.top);
      return true;
    } catch (error) {
      this.ui.status = error.message;
      return false;
    }
  }

  finishEdit() {
    const ui = this.ui;
    const editor = ui.composer.editor;
    if (!editor) return;
    if (this.editField !== 'command') return void this.finishName(editor);
    const command = editor.text.trim();
    if (!command) {
      ui.status = 'command';
      return;
    }
    const parsed = { name: this.draftName, command };
    const write = (top) => saveScript(top, this.editName, parsed);
    if (!this.writeScripts(write)) return;
    this.editField = '';
    ui.composer.closeCompose();
    this.refresh();
    this.focusScript(parsed.name);
    ui.status = 'saved';
  }

  confirm(kind, name) {
    this.dropKind = kind;
    this.dropName = name;
    this.ui.mode = 'confirmDrop';
    this.ui.status = '';
  }

  chosenScripts() {
    if (!this.editable()) return [];
    const rows = this.commands;
    const nav = this.ui.nav;
    const script = (entry) => entry?.kind === 'script';
    const range = nav.multiselect && this.focus !== 'runs';
    const picked = range ? nav.listSelection(rows, script) : [nav.npmCursor];
    return picked.map((index) => rows[index]).filter(script);
  }

  askDrop() {
    if (this.ui.nav.multiselect && this.focus === 'runs') return;
    const rows = this.chosenScripts();
    if (!rows.length) {
      if (!this.ui.nav.multiselect) this.selectedScript();
      else this.ui.status = 'not a script';
      return;
    }
    this.dropNames = rows.map((entry) => entry.name);
    this.confirm('script', this.dropNames.join(', '));
  }

  askLogs() {
    if (!this.editable()) return;
    this.refreshLogs();
    if (!this.logBytes) return;
    const total = size(this.logBytes);
    this.confirm('logs', `logs older than 5 days (${total})`);
  }

  cancelDrop() {
    this.dropName = '';
    this.dropNames = [];
    this.dropKind = '';
    this.ui.mode = 'review';
    this.ui.status = '';
  }

  confirmDrop() {
    const ui = this.ui;
    const kind = this.dropKind;
    const name = this.dropName;
    const names = this.dropNames.length ? this.dropNames : [name];
    this.dropName = '';
    this.dropNames = [];
    this.dropKind = '';
    ui.mode = 'review';
    if (kind === 'logs') {
      try {
        removeStaleLogs(ui.top);
      } catch (error) {
        ui.status = error.message;
        return void this.refreshLogs();
      }
      this.refreshLogs();
      ui.status = 'dropped logs';
      return;
    }
    const listed = names.filter(Boolean);
    if (!listed.length) return;
    let removed = false;
    const write = (top) => {
      removed = removeScripts(top, listed);
    };
    if (!this.writeScripts(write) || !removed) return;
    this.refresh();
    ui.nav.clearListPick();
    ui.status = `dropped ${name}`;
  }

  reorder(delta) {
    if (this.ui.nav.multiselect) return;
    const entry = this.selectedScript();
    if (!entry) return;
    let moved = false;
    const write = (top) => {
      moved = reorderScript(top, entry.name, delta);
    };
    if (!this.writeScripts(write) || !moved) return;
    this.refresh();
    this.focusScript(entry.name);
    this.ui.status = '';
  }
}

module.exports = {
  NpmController,
};
