'use strict';

const path = require('node:path');
const { clamp } = require('../../common/utilities.js');
const { REVIEW_DIR } = require('../../common/files.js');
const { RunPanel } = require('../run-panel.js');
const { AgentOptions } = require('./options.js');
const { planKey, NO_PLAN } = require('./plans.js');
const { MenuPick, menuRows, pickDelta } = require('../../input/menu-pick.js');
const { lineKey } = require('../../input/line-edit.js');
const clipboard = require('../../term/clipboard.js');

const optionsOf = (row) => new AgentOptions(row);

const lastIndex = (list) => Math.max(0, list.length - 1);

const agentLabel = (row) => (row.bin ? row.name : `${row.name}  not installed`);

const APPLY_FIELD = {
  model: (choices, picked, value) => choices.pickModel(picked, value),
  context: (choices, picked, value) => {
    picked.context = value;
  },
  effort: (choices, picked, value) => {
    picked.effort = value;
  },
};

const NEVER = () => false;

// A plan that is busy gives way to the first plan that is not, not to none
const firstEnabled = (items, at, isOff) => {
  if (!isOff(items[at])) return at;
  const free = items.findIndex((item) => item !== NO_PLAN && !isOff(item));
  return free < 0 ? at : free;
};

// The fields of the agents screen: the cursor over them, the combo boxes
// that drop a list of choices and the text box of the task
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
      list.push('fast');
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
      const current = this.noPlan() ? NO_PLAN : planKey(this.planFile());
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
      this.ui.paint();
      return;
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
      this.planPath = none ? NO_PLAN : path.join(this.root, REVIEW_DIR, name);
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
    if (key === 'escape') return void this.closePick();
    if (key === 'enter') return void this.acceptPick();
    if (key === ' ') return;
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

  // Enter does what the field under the cursor offers
  enter() {
    if (this.pick) return void this.acceptPick();
    if (this.viewing || this.focus === 'runs') return void this.start();
    const field = this.currentField();
    if (field === 'fast') return void this.toggleFast();
    if (field === 'install') return void this.proposeInstall();
    if (field === 'task') return void this.start();
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
    const editor = this.task;
    if (key === 'enter') return void this.start();
    if (key === 'up' || key === 'down') {
      const delta = key === 'up' ? -1 : 1;
      const before = editor.cursor;
      editor.moveLine(delta, this.taskWidth());
      if (editor.cursor === before) this.moveField(delta);
      return void this.ui.paint();
    }
    if (key === 'shift-up' || key === 'shift-down') {
      const delta = key === 'shift-up' ? -1 : 1;
      editor.moveLine(delta, this.taskWidth(), true);
      return void this.ui.paint();
    }
    if (key === 'ctrl-v') {
      const text = `${clipboard.pasteText() ?? ''}`.replaceAll('\r', '');
      if (text) editor.insert(text);
      return void this.ui.paint();
    }
    const handled = lineKey(editor, key, this.ui, true);
    if (handled) this.ui.paint();
  }
}

module.exports = { AgentForm, optionsOf, lastIndex };
