'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  startAgent,
  listModels,
  catalogOf,
} = require('../lib/agents/agents.js');
const { AcpConnection, authMethod } = require('../lib/agents/acp.js');
const { Transcript } = require('../lib/agents/transcript.js');
const { tempDir, removeTree } = require('./helpers.js');

const FIXTURE = path.join(__dirname, 'acp-agent.js');

const launchOf = (scenario, extra = {}) => ({
  cmd: process.execPath,
  args: [FIXTURE, '--acp', scenario],
  prompt: 'do the plan',
  mode: 'acceptEdits',
  choice: { model: 'sonnet', effort: 'medium', fast: true },
  session: '',
  ...extra,
});

const runToEnd = (dir, launch) =>
  new Promise((resolve) => {
    const shown = [];
    const onData = (text) => shown.push(text);
    const onClose = (result) => resolve({ ...result, shown });
    startAgent(dir, launch, onData, onClose);
  });

const inTemp = async (body) => {
  const dir = tempDir('reslop-acp-');
  try {
    await body(dir);
  } finally {
    await removeTree(dir);
  }
};

test('a run opens a session, sets it up and sends the plan', async () => {
  await inTemp(async (dir) => {
    const result = await runToEnd(dir, launchOf(''));
    assert.equal(result.status, 0);
    const lines = result.text.split('\n');
    assert.ok(lines.includes('│ thinking it over'));
    assert.ok(lines.includes('got: do the plan'));
    assert.ok(lines.includes('✔ Edit a.js'));
    assert.ok(lines.includes('settings: acceptEdits sonnet medium on'));
    const calls = 'calls: model=sonnet effort=medium fast=on mode=acceptEdits';
    assert.ok(lines.includes(calls));
    assert.ok(lines.includes('output: unset'));
    assert.deepEqual(result.stats, {
      session: 'session-1',
      files: 1,
      tokens: 1234,
    });
    assert.ok(result.shown.length > 1);
    assert.equal(result.shown.at(-1), result.text);
  });
});

test('a run answers permission requests by itself', async () => {
  await inTemp(async (dir) => {
    const result = await runToEnd(dir, launchOf(''));
    const lines = result.text.split('\n');
    assert.ok(lines.includes('asked: allow_once reject_once'));
    assert.ok(lines.includes('✖ denied: rm -rf /'));
    assert.equal(result.text.includes('denied: npm test'), false);
  });
});

test('a run leaves the settings it was not asked to change', async () => {
  await inTemp(async (dir) => {
    const launch = launchOf('', { choice: {}, mode: '' });
    const result = await runToEnd(dir, launch);
    assert.equal(result.status, 0);
    const lines = result.text.split('\n');
    assert.ok(lines.includes('settings: default opus high off'));
    assert.ok(lines.includes('calls: '));
  });
});

test('a setting the agent rejects fails the run', async () => {
  await inTemp(async (dir) => {
    const state = await listModels(
      { bin: process.execPath, args: [FIXTURE, '--acp'] },
      { cwd: dir },
    );
    assert.deepEqual(catalogOf(state).names, ['opus', 'sonnet']);
    const launch = launchOf('strict', { choice: { model: 'sonnet' } });
    const result = await runToEnd(dir, launch);
    assert.equal(result.status, 1);
    assert.match(result.text, /✖ Invalid value: sonnet/);
    assert.equal(result.text.includes('got:'), false);
  });
});

test('a run continues a session by resuming or loading it', async () => {
  await inTemp(async (dir) => {
    const resumed = await runToEnd(dir, launchOf('', { session: 'old-1' }));
    assert.equal(resumed.status, 0);
    assert.match(resumed.text, /calls: resume:old-1 model=sonnet/);
    assert.equal(resumed.stats.session, 'old-1');
    const loaded = await runToEnd(dir, launchOf('load', { session: 'old-2' }));
    assert.equal(loaded.status, 0);
    assert.match(loaded.text, /calls: load:old-2 model=sonnet/);
    assert.equal(loaded.text.includes('an earlier answer'), false);
    assert.equal(loaded.stats.session, 'old-2');
  });
});

test('a run signs in when the agent asks for it', async () => {
  await inTemp(async (dir) => {
    const result = await runToEnd(dir, launchOf('auth'));
    assert.equal(result.status, 0);
    assert.match(result.text, /^△ signing in: Browser login\n/);
    assert.match(result.text, /got: do the plan/);
    const locked = await runToEnd(dir, launchOf('locked'));
    assert.equal(locked.status, 1);
    assert.match(locked.text, /✖ Authentication required/);
    assert.equal(locked.stats.session, '');
  });
});

test('a run fails when the agent refuses, dies or cannot start', async () => {
  await inTemp(async (dir) => {
    const refused = await runToEnd(dir, launchOf('refuse'));
    assert.equal(refused.status, 1);
    assert.match(refused.text, /△ stopped: refusal\n$/);
    const crashed = await runToEnd(dir, launchOf('crash'));
    assert.equal(crashed.status, 1);
    assert.match(crashed.text, /✖ agent exited with code 3\nagent blew up/);
    assert.equal(crashed.stats.session, 'session-1');
    const missing = path.join(dir, 'no-such-agent');
    const absent = await runToEnd(dir, launchOf('', { cmd: missing }));
    assert.equal(absent.status, 1);
    assert.match(absent.text, /ENOENT/);
  });
});

const logOf = (file) => {
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  return text.split('\n').filter(Boolean);
};

const until = (ready) =>
  new Promise((resolve) => {
    const check = () => {
      if (ready()) resolve();
      else setTimeout(check, 5);
    };
    check();
  });

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test('a stopped run ends its agent and reports nothing more', async () => {
  await inTemp(async (dir) => {
    let closed = 0;
    const onClose = () => {
      closed += 1;
    };
    const file = path.join(dir, 'agent.log');
    const launch = launchOf('hang', { env: { ACP_AGENT_LOG: file } });
    const run = startAgent(dir, launch, () => {}, onClose);
    await until(() => run.raw().includes('thinking it over'));
    assert.equal(run.stats().session, 'session-1');
    const { pid } = run.child;
    assert.equal(alive(pid), true);
    run.kill();
    assert.equal(run.closed, true);
    await until(() => !alive(pid));
    assert.equal(closed, 0);
    const log = logOf(file);
    assert.ok(log.includes('cancel'));
    assert.ok(log.indexOf('cancel') > log.indexOf('model=sonnet'));
    assert.equal(log.at(-1), 'model=opus');
  });
});

test('a run sets what its model offers and puts the session back', async () => {
  await inTemp(async (dir) => {
    const file = path.join(dir, 'agent.log');
    const env = { ACP_AGENT_LOG: file };
    const choice = {
      model: 'sonnet',
      effort: 'low',
      context: '1m',
      fast: true,
    };
    const result = await runToEnd(dir, launchOf('params', { choice, env }));
    assert.equal(result.status, 0);
    const lines = result.text.split('\n');
    assert.ok(lines.includes('settings: acceptEdits sonnet 1m low'));
    const sets = [
      'model=sonnet',
      'reasoning_effort=low',
      'context=1m',
      'mode=acceptEdits',
    ];
    const back = [
      'mode=default',
      'context=200k',
      'reasoning_effort=medium',
      'model=opus',
    ];
    await until(() => logOf(file).length === sets.length + back.length);
    assert.deepEqual(logOf(file), [...sets, ...back]);
  });
});

test('fast mode is switched in the words of the agent', async () => {
  await inTemp(async (dir) => {
    const file = path.join(dir, 'agent.log');
    const env = { ACP_AGENT_LOG: file };
    const choice = { model: 'opus', effort: 'high', fast: false };
    const launch = launchOf('params', { choice, env, mode: '' });
    const result = await runToEnd(dir, launch);
    assert.equal(result.status, 0);
    assert.match(result.text, /settings: default opus high false\n/);
    await until(() => logOf(file).length === 2);
    assert.deepEqual(logOf(file), ['fast=false', 'fast=true']);
  });
});

test('the settings of a model are read by asking about it', async () => {
  await inTemp(async (dir) => {
    const file = path.join(dir, 'agent.log');
    const row = { bin: process.execPath, args: [FIXTURE, '--acp', 'params'] };
    const options = { cwd: dir, env: { ACP_AGENT_LOG: file } };
    const first = catalogOf(await listModels(row, options));
    assert.deepEqual(first.names, ['opus', 'sonnet']);
    assert.equal(first.unknown('opus'), false);
    assert.deepEqual(first.efforts('opus'), ['low', 'medium', 'high']);
    assert.deepEqual(first.fasts('opus'), ['off', 'on']);
    assert.equal(first.unknown('sonnet'), true);
    assert.deepEqual(first.efforts('sonnet'), []);
    assert.deepEqual(logOf(file), []);
    const asked = { ...options, models: ['sonnet', 'opus', 'gone'] };
    const second = catalogOf(await listModels(row, asked));
    assert.equal(second.unknown('sonnet'), false);
    assert.deepEqual(second.efforts('sonnet'), ['low', 'medium']);
    assert.deepEqual(second.contexts('sonnet'), ['200k', '1m']);
    assert.deepEqual(second.fasts('sonnet'), []);
    assert.deepEqual(second.contexts('opus'), []);
    assert.equal(second.current, 'opus');
    assert.deepEqual(logOf(file), ['model=sonnet', 'model=opus']);
    const picked = { effort: 'high', context: '1m', fast: true };
    assert.deepEqual(second.resolve('sonnet', picked), {
      id: 'sonnet',
      effort: 'medium',
      context: '1m',
      fast: 'off',
    });
    assert.deepEqual(second.resolve('opus', picked), {
      id: 'opus',
      effort: 'high',
      context: '',
      fast: 'on',
    });
  });
});

test('models are listed without signing in or sending a prompt', async () => {
  await inTemp(async (dir) => {
    const row = (scenario) => ({
      bin: process.execPath,
      args: [FIXTURE, '--acp', scenario],
    });
    const state = await listModels(row(''), { cwd: dir });
    const catalog = catalogOf(state);
    assert.deepEqual(catalog.names, ['opus', 'sonnet']);
    assert.equal(catalog.current, 'opus');
    assert.deepEqual(catalog.efforts('opus'), ['low', 'medium', 'high']);
    assert.deepEqual(catalog.fasts('opus'), ['off', 'on']);
    assert.equal(await listModels(row('auth'), { cwd: dir }), null);
    assert.equal(await listModels({ bin: '' }), null);
    const gone = { bin: path.join(dir, 'missing'), args: [] };
    assert.equal(await listModels(gone, { cwd: dir }), null);
    const aborted = new AbortController();
    aborted.abort();
    const options = { cwd: dir, signal: aborted.signal };
    assert.equal(await listModels(row(''), options), null);
    const slow = {
      bin: process.execPath,
      args: ['-e', 'setTimeout(()=>{},9e3)'],
    };
    const started = Date.now();
    assert.equal(await listModels(slow, { cwd: dir, timeout: 50 }), null);
    assert.ok(Date.now() - started < 5000);
  });
});

test('a connection matches answers and serves requests', async () => {
  const sent = [];
  const notes = [];
  const connection = new AcpConnection({
    notify: (method, params) => notes.push([method, params]),
    request: (method) => {
      if (method === 'ask') return { answer: 42 };
      throw Object.assign(new Error('nope'), { code: -32601 });
    },
  });
  const stdin = {
    writable: true,
    write: (line) => sent.push(JSON.parse(line)),
  };
  connection.child = { stdin };
  const first = connection.request('one', { a: 1 });
  const second = connection.request('two');
  assert.deepEqual(sent[0], {
    jsonrpc: '2.0',
    id: 1,
    method: 'one',
    params: { a: 1 },
  });
  connection.read('not json\n{"jsonrpc":"2.0","id":2,"res');
  connection.read('ult":{"ok":true}}\n\n');
  assert.deepEqual(await second, { ok: true });
  const failure = {
    code: -32000,
    message: 'Auth',
    data: { message: 'Sign in' },
  };
  connection.read(`${JSON.stringify({ id: 1, error: failure })}\n`);
  await assert.rejects(first, { message: 'Sign in', code: -32000 });
  connection.read('{"method":"session/update","params":{"x":1}}\n');
  assert.deepEqual(notes, [['session/update', { x: 1 }]]);
  connection.read('{"id":"a","method":"ask"}\n{"id":"b","method":"other"}\n');
  await new Promise((resolve) => {
    setImmediate(resolve);
  });
  const answered = (id) => sent.find((message) => message.id === id);
  assert.deepEqual(answered('a').result, { answer: 42 });
  assert.deepEqual(answered('b').error, { code: -32601, message: 'nope' });
  const pending = connection.request('three');
  connection.fail(new Error('agent exited'));
  await assert.rejects(pending, /agent exited/);
  await assert.rejects(connection.request('four'), /agent exited/);
});

test('signing in skips the methods that need a secret', () => {
  const methods = [
    { id: 'api-key', name: 'API Key', _meta: { 'api-key': {} } },
    { id: 'env', name: 'Env', type: 'env_var' },
    { id: 'chat', name: 'Chat login' },
  ];
  assert.equal(authMethod({ authMethods: methods }).id, 'chat');
  assert.equal(authMethod({ authMethods: methods.slice(0, 2) }), null);
  assert.equal(authMethod({}), null);
});

test('a transcript turns session updates into the log text', () => {
  const root = path.resolve('/work/repo');
  const file = path.join(root, 'lib', 'a.js');
  const transcript = new Transcript(root);
  const chunk = (sessionUpdate, text) => ({
    sessionUpdate,
    content: { type: 'text', text },
  });
  transcript.update(chunk('agent_thought_chunk', 'first\nsecond'));
  transcript.update(chunk('agent_message_chunk', 'Hello'));
  transcript.update(chunk('agent_message_chunk', ' world\n'));
  transcript.update({
    sessionUpdate: 'tool_call',
    toolCallId: 't1',
    title: `Edit ${file}`,
    kind: 'edit',
    status: 'pending',
    locations: [{ path: file }],
  });
  transcript.update({
    sessionUpdate: 'tool_call',
    toolCallId: 't2',
    kind: 'execute',
  });
  assert.equal(
    transcript.text(),
    '│ first\n│ second\n\nHello world\n\n▸ Edit lib/a.js\n▸ execute\n',
  );
  transcript.update({
    sessionUpdate: 'tool_call_update',
    toolCallId: 't1',
    status: 'completed',
  });
  transcript.update({
    sessionUpdate: 'tool_call_update',
    toolCallId: 't2',
    title: '`npm   test`\n',
    status: 'failed',
  });
  transcript.deny({ toolCallId: 't3', title: 'rm -rf /', kind: 'execute' });
  transcript.update(chunk('agent_message_chunk', 'Done'));
  transcript.update({ sessionUpdate: 'usage_update', used: 77, size: 100 });
  transcript.update({ sessionUpdate: 'plan', entries: [] });
  transcript.update(chunk('user_message_chunk', 'ignored'));
  transcript.update(null);
  transcript.note('stopped: refusal');
  const head = '│ first\n│ second\n\nHello world';
  const tools = '✔ Edit lib/a.js\n✖ `npm test`\n✖ denied: rm -rf /';
  const tail = 'Done\n\n△ stopped: refusal\n';
  assert.equal(transcript.text(), `${head}\n\n${tools}\n\n${tail}`);
  assert.deepEqual([...transcript.files], [file]);
  assert.equal(transcript.tokens, 77);
  assert.equal(new Transcript().text(), '');
});
