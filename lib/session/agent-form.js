'use strict';

const path = require('node:path');
const fs = require('node:fs');

const { isHashObject } = require('metautil');

const { clamp, trimText } = require('../common/utilities.js');
const { REVIEW_DIR } = require('../common/files.js');
const plans = require('./plans.js');
const { planKey, planPart, planLabel, alignPlanLabels, NO_PLAN } = plans;
const review = require('../review/review.js');
const { latestReviewName, listReviewNames, planFileNames } = review;
const { planNameOf, planPathOf } = review;
const editorPart = require('../input/editor.js');
const { MenuPick, menuRows, pickDelta, lineKey } = editorPart;
const { RunPanel } = require('../render/log.js');
const { catalogOf, fitEffort, concrete } = require('../agents/models.js');

const ASKS = {
  login: (row) => `sign in to ${row.name}`,
  logout: (row) => `sign out of ${row.name}`,
};

const DOING = {
  login: (row) => `signing in to ${row.name}…`,
  logout: (row) => `signing out of ${row.name}…`,
};

const DONE = {
  login: (row) => `signed in to ${row.name}`,
  logout: (row) => `signed out of ${row.name}`,
};

const NO_ACCOUNT = { state: '', names: '', open: false };

const APPLY_FIELD = {
  model: (choices, picked, value) => choices.pickModel(picked, value),
  context: (choices, picked, value) => {
    picked.context = value;
  },
  effort: (choices, picked, value) => {
    picked.effort = value;
  },
};

// The keys a pick menu takes before its query does
const PICK_KEYS = {
  escape: (form) => form.closePick(),
  enter: (form) => form.acceptPick(),
  ' ': () => {},
};

// What Enter does on a field that has no pick menu
const FIELD_ENTER = {
  fast: (form) => form.toggleFast(),
  install: (form) => form.proposeInstall(),
  task: (form) => form.start(),
};

// The keys of the task box that are not typing
const TASK_KEYS = {
  enter: (form) => form.start(),
  up: (form) => form.moveTaskLine(-1),
  down: (form) => form.moveTaskLine(1),
  'shift-up': (form) => form.selectTaskLine(-1),
  'shift-down': (form) => form.selectTaskLine(1),
};

// The settings that were chosen, without the ones left at the default
const storedChoice = (picked) => {
  const fields = {
    model: trimText(picked.model),
    effort: concrete(picked.effort),
    fast: picked.fast === true,
    context: trimText(picked.context),
  };
  const chosen = {};
  for (const key in fields) {
    if (fields[key]) chosen[key] = fields[key];
  }
  return Object.keys(chosen).length ? chosen : null;
};

const restoreChoice = (picked, saved) => {
  if (isHashObject(saved)) Object.assign(picked, storedChoice(saved));
};

const attempt = async (run, row, options) => {
  try {
    return await run(row, options);
  } catch (error) {
    return { ok: false, error: error.message };
  }
};

const lastIndex = (list) => Math.max(0, list.length - 1);

const agentLabel = (row) => (row.bin ? row.name : `${row.name}  not installed`);

const NEVER = () => false;

// A plan that is busy gives way to the first plan that is not, not to none
const firstEnabled = (items, at, isOff) => {
  if (!isOff(items[at])) return at;
  const free = items.findIndex((item) => item !== NO_PLAN && !isOff(item));
  return free < 0 ? at : free;
};

// The choices one agent row offers, from what its session lists
class AgentOptions {
  constructor(row) {
    this.row = row;
    this.catalog = catalogOf(row.catalog);
    this.names = this.catalog.names;
  }

  // A saved model stays as it is until the agent has listed its own
  shown(model) {
    const saved = trimText(model);
    if (!this.catalog.loaded || this.catalog.find(saved)) return saved;
    return this.catalog.current || this.names[0] || '';
  }

  efforts(model) {
    return this.catalog.efforts(this.shown(model));
  }

  contexts(model) {
    return this.catalog.contexts(this.shown(model));
  }

  fasts(model) {
    return this.catalog.fasts(this.shown(model));
  }

  // Before the agent has listed anything the saved choice is all there is
  settings(picked) {
    if (this.catalog.loaded) {
      return this.catalog.resolve(this.shown(picked.model), picked);
    }
    return {
      effort: concrete(picked.effort),
      context: trimText(picked.context),
      fast: picked.fast === true ? 'on' : 'off',
    };
  }

  align(picked) {
    if (!this.catalog.loaded) return;
    picked.effort = fitEffort(this.efforts(picked.model), picked.effort);
  }

  normalize(picked) {
    this.align(picked);
    return this.shown(picked.model);
  }

  preferEffort(picked, level) {
    if (concrete(picked.effort)) return;
    if (this.efforts(picked.model).includes(level)) picked.effort = level;
  }

  pickModel(picked, model) {
    picked.model = model;
    this.align(picked);
  }

  toggleFast(picked) {
    if (this.fasts(picked.model).length < 2) return false;
    picked.fast = picked.fast !== true;
    return true;
  }
}

const optionsOf = (row) => new AgentOptions(row);

// The fields of the agents screen: the cursor over them, the combo boxes
// that drop a list of choices, the text box of the task, and the account of
// the agent with the sign-in and sign-out that are proposed and then done
class AgentForm extends RunPanel {
  // The fields the cursor visits, top to bottom, for the selected agent
  fieldList() {
    const row = this.selected();
    const list = ['agent'];
    if (row && row.bin) {
      const choices = optionsOf(row);
      const model = choices.normalize(this.choice(row.id));
      list.push('model');
      if (choices.efforts(model).length > 1) list.push('effort');
      if (choices.fasts(model).length > 1) list.push('fast');
      if (choices.contexts(model).length > 1) list.push('context');
    } else if (row && row.installable) {
      list.push('install');
    }
    list.push('plan', 'task');
    return list;
  }

  currentField() {
    return this.fieldList().includes(this.field) ? this.field : 'agent';
  }

  selectField(field) {
    if (!this.fieldList().includes(field)) return false;
    this.field = field;
    return true;
  }

  moveField(delta) {
    const list = this.fieldList();
    const at = Math.max(0, list.indexOf(this.currentField()));
    this.field = list[clamp(at + delta, 0, lastIndex(list))];
  }

  taskText() {
    return this.task.text.trim();
  }

  focusTask() {
    this.focus = 'cli';
    this.field = 'task';
  }

  // The cursor of the agents list belongs to the agent combo
  chooseAgent(index) {
    const nav = this.ui.nav;
    const next = clamp(index, 0, lastIndex(this.list));
    if (next === nav.agentCursor) return;
    nav.agentCursor = next;
    const row = this.selected();
    if (row) this.saveLastAgent(row.id);
    this.selectLastSession();
  }

  fieldItems(field, row) {
    if (field === 'plan') return this.planMenu();
    if (field === 'agent') return this.list.map(agentLabel);
    if (!row) return [];
    const choices = optionsOf(row);
    const picked = this.choice(row.id);
    if (field === 'model') return choices.names;
    if (field === 'context') return choices.contexts(picked.model);
    return choices.efforts(picked.model);
  }

  fieldStart(field, items, row) {
    if (field === 'agent') return Math.max(0, this.ui.nav.agentCursor);
    if (field === 'plan') {
      const file = planKey(this.planFile(), this.root);
      const current = this.noPlan() ? NO_PLAN : file;
      const at = items.findIndex((item) => planKey(item) === current);
      return firstEnabled(items, Math.max(0, at), this.busyCheck());
    }
    const picked = this.choice(row.id);
    const choices = optionsOf(row);
    const shown = { ...choices.settings(picked) };
    shown.model = choices.shown(picked.model);
    return Math.max(0, items.indexOf(shown[field]));
  }

  menuItems() {
    if (!this.pick) return [];
    return this.pick.filter(this.fieldItems(this.pick.field, this.selected()));
  }

  menuPage(fraction = 1) {
    const body = this.ui.lastFrame && this.ui.lastFrame.bodyH;
    return menuRows(body, fraction);
  }

  movePick(delta) {
    const items = this.menuItems();
    if (!items.length || !this.pick) return;
    const isOff = this.pick.field === 'plan' ? this.busyCheck() : NEVER;
    this.pick.move(delta, items, isOff);
  }

  dismissPick() {
    this.pick = null;
  }

  closePick() {
    if (!this.pick) return;
    this.dismissPick();
    this.ui.status = '';
    this.ui.paint();
  }

  noteQueryEdit(changed) {
    if (changed) {
      this.pick.touch();
      this.ui.status = '';
    }
    this.ui.paint();
  }

  openPick(field) {
    if (this.viewing) return;
    if (this.pick && this.pick.field === field) return void this.closePick();
    const row = this.selected();
    const anyAgent = field === 'agent' || field === 'plan';
    if (!row || (!row.bin && !anyAgent)) return;
    if (row.bin) optionsOf(row).normalize(this.choice(row.id));
    const items = this.fieldItems(field, row);
    if (items.length < 2) return;
    this.focus = 'cli';
    this.selectField(field);
    this.pick = new MenuPick(field, this.fieldStart(field, items, row));
    this.ui.status = '';
    this.ui.paint();
  }

  acceptPick(at = this.pick ? this.pick.cursor : 0) {
    const pick = this.pick;
    if (!pick) return;
    const items = this.menuItems();
    const value = items[Math.min(at, lastIndex(items))];
    if (pick.field === 'plan' && this.planBusy(value)) {
      this.ui.status = `busy ${planKey(value)}`;
      return void this.ui.paint();
    }
    const row = this.selected();
    this.dismissPick();
    const done = row && value ? this.applyPick(pick.field, row, value) : '';
    this.ui.status = done;
    this.ui.paint();
  }

  applyPick(field, row, value) {
    if (field === 'agent') {
      const at = this.list.findIndex((item) => agentLabel(item) === value);
      if (at < 0) return '';
      this.chooseAgent(at);
      return `agent ${this.list[at].name}`;
    }
    if (field === 'plan') {
      const name = planKey(value);
      const none = value === NO_PLAN;
      this.planPath = none ? NO_PLAN : planPathOf(this.root, name);
      return `plan ${name}`;
    }
    const picked = this.choice(row.id);
    const apply = APPLY_FIELD[field] ?? APPLY_FIELD.effort;
    apply(optionsOf(row), picked, value);
    this.saveChoice(row.id);
    if (field === 'model') void this.describeModel(row, picked.model);
    return `${field} ${picked[field]}`;
  }

  pickStep(key) {
    return pickDelta(key, this.menuPage(), this.menuPage(0.5));
  }

  onPickKey(key) {
    if (!this.pick) return;
    const own = PICK_KEYS[key];
    if (own) return void own(this);
    const handled = lineKey(this.pick.editor, key, this.ui, false);
    if (handled) return void this.noteQueryEdit(handled === 'text');
    const step = this.pickStep(key);
    if (step) this.movePick(step);
  }

  toggleFast() {
    if (this.viewing || this.pick) return;
    const row = this.selected();
    if (!row || !row.bin) {
      this.ui.status = 'not installed';
      return;
    }
    const picked = this.choice(row.id);
    const choices = optionsOf(row);
    this.focus = 'cli';
    this.selectField('fast');
    if (choices.toggleFast(picked)) this.saveChoice(row.id);
    this.ui.status = `fast ${choices.settings(picked).fast}`;
    this.ui.paint();
  }

  // The arrows set the fast mode: on is the left of the two, off the right
  setFast(state) {
    const row = this.selected();
    const same = row && row.bin;
    const now = same && optionsOf(row).settings(this.choice(row.id)).fast;
    if (now === state) return;
    this.toggleFast();
  }

  enter() {
    if (this.pick) return void this.acceptPick();
    if (this.viewing || this.focus === 'runs') return void this.start();
    const field = this.currentField();
    const enter = FIELD_ENTER[field];
    if (enter) return void enter(this);
    this.openPick(field);
  }

  // Wrapped lines of the task field move by the width it was painted with
  taskWidth() {
    const hits = this.ui.lastFrame?.editHits ?? [];
    const hit = hits.find((entry) => entry.editor === this.task);
    return hit ? hit.x1 - hit.textX : undefined;
  }

  // The task field takes the keys of a text box that starts the run on Enter
  onTaskKey(key) {
    const own = TASK_KEYS[key];
    if (own) return void own(this);
    const handled = lineKey(this.task, key, this.ui, true, true);
    if (handled) this.ui.paint();
  }

  // An arrow moves a line in the task, and out to the next field at its end
  moveTaskLine(delta) {
    const editor = this.task;
    const before = editor.cursor;
    editor.moveLine(delta, this.taskWidth());
    if (editor.cursor === before) this.moveField(delta);
    this.ui.paint();
  }

  selectTaskLine(delta) {
    this.task.moveLine(delta, this.taskWidth(), true);
    this.ui.paint();
  }

  noteAccount(row, auth) {
    if (!auth || !auth.state) return;
    const names = auth.names ?? '';
    this.accounts.set(row.id, {
      state: auth.state,
      names,
      open: Boolean(auth.method),
    });
  }

  account(row) {
    return (row && this.accounts.get(row.id)) || NO_ACCOUNT;
  }

  accountView() {
    const row = this.selected();
    if (!row || !row.bin) return { state: '', busy: '', names: '' };
    const { state, names } = this.account(row);
    const busy = this.authBusy === row.id ? this.authAction : '';
    return { state, busy, names, loading: !state && this.isProbing(row) };
  }

  authAsk() {
    const row = this.cliById(this.authTarget);
    const ask = ASKS[this.authAction];
    return row && ask ? ask(row) : '';
  }

  // The key and the button sign in when signed out and sign out when in
  proposeAuth() {
    if (this.viewing || this.pick) return;
    const row = this.selected();
    const note = (text) => {
      this.ui.status = text;
      this.ui.paint();
    };
    if (!row || !row.bin) return void note('not installed');
    if (this.authBusy) return void note('signing in or out');
    const { state } = this.account(row);
    if (!state) return void note(`${row.name}: sign-in status not known`);
    this.authTarget = row.id;
    this.authAction = state === 'in' ? 'logout' : 'login';
    this.ui.status = '';
    this.ui.mode = 'confirmAgentAuth';
    this.ui.paint();
  }

  cancelAuth() {
    this.authTarget = '';
    this.authAction = '';
    this.ui.mode = 'review';
    this.ui.paint();
  }

  confirmAuth() {
    const id = this.authTarget;
    const action = this.authAction;
    this.authTarget = '';
    this.ui.mode = 'review';
    void this.runAuth(id, action);
  }

  async runAuth(id, action) {
    const row = this.cliById(id);
    if (!row || !DOING[action]) return;
    this.authBusy = id;
    this.authAction = action;
    this.ui.status = DOING[action](row);
    this.ui.paint();
    const run = action === 'login' ? this.signIn : this.signOut;
    const result = await attempt(run, row, this.probeOptions(''));
    this.authBusy = '';
    this.authAction = '';
    this.ui.status = this.authDone(row, action, result);
    this.ui.paint();
  }

  authDone(row, action, result) {
    if (!result || !result.ok) return `${result ? result.error : 'failed'}`;
    const names = this.account(row).names;
    const state = action === 'login' ? 'in' : 'out';
    this.accounts.set(row.id, { ...this.account(row), state, names });
    // What a signed-out agent could not list is asked for again
    if (action === 'login') this.forgetModels(row);
    return DONE[action](row);
  }

  reviewChoices() {
    const names = planFileNames(this.root);
    const file = this.foundPlan();
    const current = file ? planNameOf(this.root, file) : '';
    if (current && !names.includes(current)) names.unshift(current);
    return names;
  }

  planPartOf(name) {
    return planPart(this.root, name, this.reviewStore());
  }

  // The part of the plan the next run reads
  currentPlanPart() {
    const file = this.planFile();
    return file ? this.planPartOf(file) : null;
  }

  planFace() {
    const part = this.currentPlanPart();
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
      const plan = `${job.plan ?? ''}`;
      if (plan) busy.add(planNameOf(this.root, path.resolve(this.root, plan)));
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
}

module.exports = {
  storedChoice,
  restoreChoice,
  lastIndex,
  optionsOf,
  AgentForm,
};
