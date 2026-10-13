'use strict';

const { spawn } = require('node:child_process');
const { jsonParse, isHashObject } = require('metautil');

const PROTOCOL_VERSION = 1;
const METHOD_NOT_FOUND = -32601;
const INTERNAL_ERROR = -32603;
const AUTH_REQUIRED = -32000;
const STDERR_KEEP = 2000;
const SECRET_AUTH = ['env_var', 'terminal'];

const errorText = (error) => {
  const data = isHashObject(error.data) ? error.data : {};
  const detail = data.message ?? data.details ?? error.data;
  const text = typeof detail === 'string' ? detail.trim() : '';
  return text || `${error.message ?? 'agent error'}`;
};

class AcpError extends Error {
  constructor(error) {
    super(errorText(error));
    this.code = error.code;
    this.data = error.data;
  }
}

const rpcError = (message, code) => Object.assign(new Error(message), { code });

const methodMissing = (method) =>
  rpcError(`Method not found: ${method}`, METHOD_NOT_FOUND);

const exitMessage = (status, stderr) => {
  const code = typeof status === 'number' ? ` with code ${status}` : '';
  const tail = stderr.trim();
  return tail ? `agent exited${code}\n${tail}` : `agent exited${code}`;
};

// JSON-RPC over the stdio of one agent process, a message per line
class AcpConnection {
  constructor(handlers = {}) {
    this.onNotify = handlers.notify ?? (() => {});
    this.onRequest = handlers.request ?? null;
    this.child = null;
    this.pending = new Map();
    this.nextId = 1;
    this.buffer = '';
    this.stderr = '';
    this.failure = null;
  }

  start(cmd, args, options) {
    const stdio = ['pipe', 'pipe', 'pipe'];
    const child = spawn(cmd, args, { ...options, stdio });
    this.child = child;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this.read(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-STDERR_KEEP);
    });
    // A closed pipe is reported by the exit of the process
    child.stdin.on('error', () => {});
    child.on('error', (error) => this.fail(error));
    child.on('close', (status) => {
      this.fail(new Error(exitMessage(status, this.stderr)));
    });
    return this;
  }

  fail(error) {
    if (this.failure) return;
    this.failure = error;
    for (const waiter of this.pending.values()) waiter.reject(error);
    this.pending.clear();
  }

  send(message) {
    const stdin = this.child && this.child.stdin;
    if (this.failure || !stdin || !stdin.writable) return;
    stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  }

  request(method, params) {
    if (this.failure) return Promise.reject(this.failure);
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ id, method, params });
    });
  }

  notify(method, params) {
    this.send({ method, params });
  }

  read(chunk) {
    const lines = `${this.buffer}${chunk}`.split('\n');
    this.buffer = lines.pop();
    for (const line of lines) {
      const message = line.trim() ? jsonParse(line) : null;
      if (isHashObject(message)) this.dispatch(message);
    }
  }

  dispatch(message) {
    const { id, method } = message;
    if (typeof method !== 'string') return void this.settle(message);
    if (id === undefined || id === null) {
      return void this.onNotify(method, message.params ?? {});
    }
    this.answer(id, method, message.params ?? {});
  }

  settle(message) {
    const waiter = this.pending.get(message.id);
    if (!waiter) return;
    this.pending.delete(message.id);
    if (message.error) waiter.reject(new AcpError(message.error));
    else waiter.resolve(message.result ?? {});
  }

  async answer(id, method, params) {
    try {
      if (!this.onRequest) throw methodMissing(method);
      const result = await this.onRequest(method, params);
      this.send({ id, result: result ?? {} });
    } catch (error) {
      const code = typeof error.code === 'number' ? error.code : INTERNAL_ERROR;
      this.send({ id, error: { code, message: error.message } });
    }
  }
}

const authMethod = (init) => {
  const methods = Array.isArray(init.authMethods) ? init.authMethods : [];
  const open = (method) => {
    if (!isHashObject(method) || typeof method.id !== 'string') return false;
    if (SECRET_AUTH.includes(method.type)) return false;
    const meta = isHashObject(method._meta) ? method._meta : {};
    return !Object.keys(meta).some((key) => /api.?key/i.test(key));
  };
  return methods.find(open) ?? null;
};

const sessionState = (sessionId, result) => ({
  sessionId,
  configOptions: Array.isArray(result.configOptions)
    ? result.configOptions
    : [],
  models: isHashObject(result.models) ? result.models : null,
  modes: isHashObject(result.modes) ? result.modes : null,
});

// One agent session: opened or continued, configured, then prompted
class AcpSession {
  constructor(connection, cwd, info) {
    this.connection = connection;
    this.cwd = cwd;
    this.info = info;
    this.init = {};
    this.state = sessionState('', {});
    this.replaying = false;
    this.undone = [];
    this.onAuth = () => {};
  }

  get id() {
    return this.state.sessionId;
  }

  request(method, params = {}) {
    const sessionId = this.id;
    return this.connection.request(method, { sessionId, ...params });
  }

  async handshake() {
    this.init = await this.connection.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
        // Cursor lists the settings of a model only to a client that asks
        _meta: { parameterizedModelPicker: true },
      },
      clientInfo: this.info,
    });
  }

  // Signing in can open a browser, so only a run is allowed to start it
  async signedIn(call, login) {
    try {
      return await call();
    } catch (error) {
      const asked = login && error.code === AUTH_REQUIRED;
      const method = asked ? authMethod(this.init) : null;
      if (!method) throw error;
      this.onAuth(method);
      await this.connection.request('authenticate', { methodId: method.id });
      return call();
    }
  }

  continueMethod() {
    const caps = this.init.agentCapabilities ?? {};
    const session = caps.sessionCapabilities ?? {};
    if (isHashObject(session.resume)) return 'session/resume';
    if (caps.loadSession === true) return 'session/load';
    throw new Error('agent cannot continue a session');
  }

  async open(sessionId = '', login = false) {
    await this.handshake();
    const params = { cwd: this.cwd, mcpServers: [] };
    if (!sessionId) {
      const start = () => this.connection.request('session/new', params);
      const result = await this.signedIn(start, login);
      this.state = sessionState(`${result.sessionId ?? ''}`, result);
      return this.state;
    }
    const method = this.continueMethod();
    const resume = () =>
      this.connection.request(method, { ...params, sessionId });
    // A loaded session replays its history as updates before it answers
    this.replaying = true;
    try {
      const result = await this.signedIn(resume, login);
      this.state = sessionState(sessionId, result);
    } finally {
      this.replaying = false;
    }
    return this.state;
  }

  // The request that puts back what a change is about to replace
  undoOf(step) {
    const { state } = this;
    const { configId, modelId, modeId } = step.params;
    const option = state.configOptions.find(
      (item) => isHashObject(item) && item.id === configId,
    );
    const params = {};
    if (option) Object.assign(params, { configId, value: option.currentValue });
    if (modelId && state.models) params.modelId = state.models.currentModelId;
    if (modeId && state.modes) params.modeId = state.modes.currentModeId;
    return Object.keys(params).length ? { method: step.method, params } : null;
  }

  async apply(step) {
    const result = await this.request(step.method, step.params);
    const state = { ...this.state };
    if (Array.isArray(result.configOptions)) {
      state.configOptions = result.configOptions;
    }
    const { modelId, modeId } = step.params;
    if (modelId && state.models) {
      state.models = { ...state.models, currentModelId: modelId };
    }
    if (modeId && state.modes) {
      state.modes = { ...state.modes, currentModeId: modeId };
    }
    this.state = state;
  }

  async change(step) {
    if (!step) return;
    const undo = this.undoOf(step);
    await this.apply(step);
    if (undo) this.undone.push(undo);
  }

  // An agent can keep what a session was set to as the defaults of the user
  async revert() {
    const steps = this.undone.reverse();
    this.undone = [];
    for (const step of steps) {
      try {
        await this.apply(step);
      } catch {
        // an agent that is gone has nothing left to put back
      }
    }
  }

  absorb(update) {
    if (update.sessionUpdate !== 'config_option_update') return;
    if (!Array.isArray(update.configOptions)) return;
    this.state = { ...this.state, configOptions: update.configOptions };
  }

  cancel() {
    const sessionId = this.id;
    if (sessionId) this.connection.notify('session/cancel', { sessionId });
  }

  prompt(text) {
    return this.request('session/prompt', {
      prompt: [{ type: 'text', text }],
    });
  }
}

module.exports = {
  AcpConnection,
  AcpSession,
  methodMissing,
  authMethod,
};
