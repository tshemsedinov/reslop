'use strict';

const { IS_WIN, spawnBase } = require('../common/process.js');
const { commandEnv, RunProcess, killTree } = require('../runs/process.js');
const protocol = require('./acp.js');
const { AcpConnection, AcpSession, methodMissing } = protocol;
const { AUTH_REQUIRED, METHOD_NOT_FOUND } = protocol;
const { authMethod, authNames } = protocol;
const { decidePermission } = require('./allow.js');
const models = require('./models.js');
const { modelChange, effortChange, contextChange, fastChange } = models;
const { modeChange, modelRequest, catalogOf } = models;
const { Transcript } = require('./transcript.js');
const PKG = require('../../package.json');

const PROBE_MS = 30000;
const REVERT_MS = 15000;
const STOP_MS = 3000;
const CLIENT = { name: PKG.name, version: PKG.version };
const WIN_SCRIPT = /\.(?:cmd|bat)$/i;

// The review screen forces raw output. An agent needs the reduced test report.
const agentEnv = (extra) => {
  const env = commandEnv({ ...process.env, ...extra });
  delete env.RESLOP_OUTPUT;
  return env;
};

// npm installs an adapter on Windows as a script only a shell can start
const spawnOptions = (cmd, cwd, env) => {
  const shell = IS_WIN && WIN_SCRIPT.test(cmd);
  return spawnBase({ cwd, env: agentEnv(env), detached: !IS_WIN, shell });
};

const connect = (cmd, args, cwd, env, handlers) => {
  const connection = new AcpConnection(handlers);
  const quoted = IS_WIN && WIN_SCRIPT.test(cmd) ? `"${cmd}"` : cmd;
  return connection.start(quoted, args, spawnOptions(cmd, cwd, env));
};

const tryConnect = (cmd, args, cwd, env, handlers) => {
  try {
    return connect(cmd, args, cwd, env, handlers);
  } catch (error) {
    return { child: null, error };
  }
};

const tokensOf = (result, used) => {
  const usage = result && result.usage;
  const total = usage ? Number(usage.totalTokens) : NaN;
  return Number.isFinite(total) ? total : used;
};

// One plan handed to an agent over ACP: a session, its settings, one prompt
class AcpRun extends RunProcess {
  constructor(launch, onData, onClose) {
    super(onData, onClose);
    this.launch = launch;
    this.transcript = new Transcript();
    this.session = `${launch.session ?? ''}`;
    this.acp = null;
    this.cwd = '';
  }

  start(cwd, env) {
    const { cmd, args } = this.launch;
    this.cwd = cwd;
    this.transcript = new Transcript(cwd);
    const handlers = {
      notify: (method, params) => this.onNotify(method, params),
      request: (method, params) => this.onRequest(method, params),
    };
    const connection = tryConnect(cmd, args ?? [], cwd, env, handlers);
    if (!connection.child) {
      this.fail(connection.error);
      return this;
    }
    this.child = connection.child;
    this.acp = new AcpSession(connection, cwd, CLIENT);
    this.acp.onAuth = (method) => {
      this.transcript.note(`signing in: ${method.name ?? method.id}`);
      this.push();
    };
    this.drive().then(
      (status) => this.end(status),
      (error) => this.fail(error),
    );
    return this;
  }

  async drive() {
    const { launch, acp } = this;
    const state = await acp.open(launch.session, true);
    this.session = state.sessionId;
    this.push();
    const picked = launch.choice ?? {};
    await acp.change(modelChange(acp.state, picked));
    await acp.change(effortChange(acp.state, picked));
    await acp.change(contextChange(acp.state, picked));
    await acp.change(fastChange(acp.state, picked));
    await acp.change(modeChange(acp.state, launch.mode));
    const result = await acp.prompt(launch.prompt);
    this.transcript.tokens = tokensOf(result, this.transcript.tokens);
    const reason = `${result.stopReason ?? ''}`;
    if (reason === 'end_turn') return 0;
    this.transcript.note(`stopped: ${reason || 'no reason given'}`);
    return 1;
  }

  onNotify(method, params) {
    if (method !== 'session/update' || this.acp.replaying) return;
    this.acp.absorb(params.update ?? {});
    this.transcript.update(params.update);
    this.push();
  }

  onRequest(method, params) {
    if (method !== 'session/request_permission') throw methodMissing(method);
    const { allowed, outcome } = decidePermission(params, this.cwd);
    if (!allowed) {
      this.transcript.deny(params.toolCall ?? {});
      this.push();
    }
    return { outcome };
  }

  stats() {
    const { transcript } = this;
    return {
      session: this.session,
      files: transcript.files.size || null,
      tokens: transcript.tokens,
    };
  }

  push() {
    if (!this.closed) this.show(this.transcript.text());
  }

  fail(error) {
    if (this.closed) return;
    this.transcript.fail(error);
    this.end(1);
  }

  end(status) {
    if (this.closed) return;
    this.text = this.transcript.text();
    this.settled = true;
    this.onClose({ status, text: this.text, stats: this.stats() });
    this.release();
  }

  // A stopped agent is asked to end its turn, so that it can still answer
  kill() {
    if (this.closed) return;
    this.stopped = true;
    if (this.acp) this.acp.cancel();
    this.release(STOP_MS);
  }

  // The run is over for its job; the agent stays until its settings are back
  release(wait = REVERT_MS) {
    const { child, acp } = this;
    if (!child) return;
    let over = false;
    const onExit = () => killTree(child);
    const timer = setTimeout(onExit, wait);
    const done = () => {
      if (over) return;
      over = true;
      clearTimeout(timer);
      process.off('exit', onExit);
      if (child.exitCode === null && !child.signalCode) killTree(child);
    };
    process.once('exit', onExit);
    child.once('close', done);
    if (acp) acp.revert().then(done, done);
    else done();
  }
}

const startRun = (cwd, launch, onData, onClose) =>
  new AcpRun(launch, onData, onClose).start(cwd, launch.env);

// The settings of a model show once a session is set to it
const describeModels = async (session, names, found) => {
  const base = session.state;
  const catalog = catalogOf(base);
  found.state = base;
  if (!catalog.configId) return;
  const byModel = new Map([[catalog.currentId, base.configOptions]]);
  found.state = { ...base, byModel };
  try {
    for (const name of names) {
      const { id } = catalog.resolve(name, {});
      if (!id || byModel.has(id)) continue;
      await session.change(modelRequest(catalog, id));
      byModel.set(id, session.state.configOptions);
    }
  } finally {
    await session.revert();
  }
};

// What a new session of the agent offers, read without sending a prompt.
// Whether the agent let a session open says if it is signed in: that goes
// to options.auth, as 'in', 'out', or not at all when it is not known
const probeSession = async (row, options = {}) => {
  const { signal, cwd = process.cwd(), models = [] } = options;
  if (signal && signal.aborted) return null;
  const connection = tryConnect(row.bin, row.args ?? [], cwd, options.env, {});
  if (!connection.child) return null;
  const session = new AcpSession(connection, cwd, CLIENT);
  const found = { state: null };
  const auth = options.auth ?? {};
  let timer = null;
  let onAbort = null;
  const aborted = new Promise((resolve) => {
    onAbort = () => resolve();
    timer = setTimeout(onAbort, options.timeout ?? PROBE_MS);
    if (signal) signal.addEventListener('abort', onAbort);
  });
  const asked = session.open().then(() => {
    auth.state = 'in';
    return describeModels(session, models, found);
  });
  try {
    await Promise.race([asked, aborted]);
  } catch (error) {
    // What the agent answered before it failed is still what it offers
    if (error && error.code === AUTH_REQUIRED) auth.state = 'out';
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
    auth.names = authNames(session.init);
    auth.method = authMethod(session.init);
    killTree(connection.child);
  }
  return found.state;
};

// Signing in can wait for a person in a browser, so it has long to take
const AUTH_MS = 300000;

// An agent is started for one sign-in or sign-out and ended after it
const withAgent = async (row, options, work) => {
  const { signal, cwd = process.cwd(), timeout = AUTH_MS } = options;
  if (signal && signal.aborted) return { ok: false, error: 'stopped' };
  const connection = tryConnect(row.bin, row.args ?? [], cwd, options.env, {});
  if (!connection.child) return { ok: false, error: 'cannot start the agent' };
  const session = new AcpSession(connection, cwd, CLIENT);
  let timer = null;
  let onAbort = null;
  const over = new Promise((resolve) => {
    onAbort = () => resolve({ ok: false, error: 'stopped' });
    timer = setTimeout(onAbort, timeout);
    if (signal) signal.addEventListener('abort', onAbort);
  });
  try {
    return await Promise.race([work(session, cwd), over]);
  } catch (error) {
    return { ok: false, error: error.message };
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
    killTree(connection.child);
  }
};

const loginWork = async (session, cwd) => {
  await session.handshake();
  const method = authMethod(session.init);
  if (!method) {
    const names = authNames(session.init);
    if (names) return { ok: false, error: `sign in outside reslop: ${names}` };
    return { ok: false, error: 'no sign-in here' };
  }
  const { connection } = session;
  await connection.request('authenticate', { methodId: method.id });
  await connection.request('session/new', { cwd, mcpServers: [] });
  return { ok: true };
};

const logoutWork = async (session) => {
  await session.handshake();
  try {
    await session.connection.request('logout', {});
    return { ok: true };
  } catch (error) {
    if (error.code !== METHOD_NOT_FOUND) throw error;
    return { ok: false, error: 'sign out in the CLI of the agent' };
  }
};

const loginAgent = (row, options = {}) => withAgent(row, options, loginWork);

const logoutAgent = (row, options = {}) => withAgent(row, options, logoutWork);

module.exports = {
  startRun,
  probeSession,
  loginAgent,
  logoutAgent,
};
