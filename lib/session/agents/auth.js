'use strict';

const { RunPanel } = require('../run-panel.js');

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

const attempt = async (run, row, options) => {
  try {
    return await run(row, options);
  } catch (error) {
    return { ok: false, error: error.message };
  }
};

const NO_ACCOUNT = { state: '', names: '', open: false };

// Whether the agents are signed in, found by opening a session of each, and
// the sign-in and sign-out that are proposed to the person and then done
class AgentAuth extends RunPanel {
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

  // What the screen shows of the account of the selected agent
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
}

module.exports = { AgentAuth };
