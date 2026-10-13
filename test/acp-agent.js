'use strict';

// A scripted ACP agent for the tests: `node acp-agent.js --acp [scenario]`

const fs = require('node:fs');

const AUTH_REQUIRED = -32000;

// In the params scenario every model has options of its own, kept per model
const PARAMS = {
  opus: [
    ['effort', 'thought_level', ['low', 'medium', 'high'], 'high'],
    ['fast', 'model_config', ['false', 'true'], 'true'],
  ],
  sonnet: [
    ['context', 'model_config', ['200k', '1m'], '200k'],
    ['reasoning_effort', 'thought_level', ['low', 'medium'], 'medium'],
  ],
};

const note = (line) => {
  const file = process.env.ACP_AGENT_LOG;
  if (file) fs.appendFileSync(file, `${line}\n`);
};

const select = (id, category, currentValue, values) => ({
  id,
  category,
  type: 'select',
  currentValue,
  options: values.map((value) => ({ value, name: value })),
});

const serve = (scenario) => {
  const config = {
    mode: select('mode', 'mode', 'default', ['default', 'acceptEdits']),
    model: select('model', 'model', 'opus', ['opus', 'sonnet']),
    effort: select('effort', 'thought_level', 'high', [
      'default',
      'low',
      'medium',
      'high',
    ]),
    fast: select('fast', 'model_config', 'off', ['on', 'off']),
  };
  const chosen = {};
  const paramOptions = () => {
    const model = config.model.currentValue;
    const own = PARAMS[model].map(([id, category, values, initial]) =>
      select(id, category, chosen[`${model}.${id}`] ?? initial, values),
    );
    return [config.mode, config.model, ...own];
  };
  const options = () =>
    scenario === 'params' ? paramOptions() : Object.values(config);
  const calls = [];
  let signedIn = scenario !== 'auth' && scenario !== 'locked';
  let nextId = 1;
  const waiting = new Map();

  const send = (message) => {
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  };

  const update = (sessionId, body) => {
    send({ method: 'session/update', params: { sessionId, update: body } });
  };

  const say = (sessionId, text, kind = 'agent_message_chunk') => {
    update(sessionId, { sessionUpdate: kind, content: { type: 'text', text } });
  };

  const ask = (sessionId, toolCall) =>
    new Promise((resolve) => {
      const id = `ask-${nextId}`;
      nextId += 1;
      waiting.set(id, resolve);
      const kinds = ['allow_once', 'allow_always', 'reject_once'];
      const choices = kinds.map((kind) => ({
        optionId: kind,
        kind,
        name: kind,
      }));
      const params = { sessionId, toolCall, options: choices };
      send({ id, method: 'session/request_permission', params });
    });

  const execute = (toolCallId, command) => ({
    toolCallId,
    title: command,
    kind: 'execute',
    rawInput: { command },
  });

  const prompt = async (sessionId, params) => {
    if (scenario === 'crash') {
      process.stderr.write('agent blew up\n');
      process.exit(3);
    }
    say(sessionId, 'thinking it over\n', 'agent_thought_chunk');
    if (scenario === 'hang') return null;
    say(sessionId, `got: ${params.prompt[0].text}\n`);
    const edit = {
      sessionUpdate: 'tool_call',
      toolCallId: 'edit-1',
      title: 'Edit a.js',
      kind: 'edit',
      status: 'pending',
      locations: [{ path: 'a.js' }],
    };
    update(sessionId, edit);
    const test = await ask(sessionId, execute('run-1', 'npm test'));
    const wipe = await ask(sessionId, execute('run-2', 'rm -rf /'));
    const done = { sessionUpdate: 'tool_call_update', toolCallId: 'edit-1' };
    update(sessionId, { ...done, status: 'completed' });
    const settings = options().map((item) => item.currentValue);
    say(sessionId, `settings: ${settings.join(' ')}\n`);
    say(sessionId, `asked: ${test.optionId} ${wipe.optionId}\n`);
    say(sessionId, `calls: ${calls.join(' ')}\n`);
    say(sessionId, `output: ${process.env.RESLOP_OUTPUT ?? 'unset'}\n`);
    update(sessionId, { sessionUpdate: 'usage_update', used: 1234, size: 9 });
    return { stopReason: scenario === 'refuse' ? 'refusal' : 'end_turn' };
  };

  const opened = (extra = {}) => {
    if (!signedIn) {
      const error = new Error('Authentication required');
      throw Object.assign(error, { code: AUTH_REQUIRED });
    }
    return { ...extra, configOptions: options() };
  };

  const handlers = {
    initialize: () => ({
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: scenario === 'load',
        sessionCapabilities: scenario === 'load' ? {} : { resume: {} },
      },
      authMethods:
        scenario === 'auth' ? [{ id: 'browser', name: 'Browser login' }] : [],
    }),
    authenticate: () => {
      signedIn = true;
      return {};
    },
    'session/new': () => opened({ sessionId: 'session-1' }),
    'session/resume': (params) => {
      calls.push(`resume:${params.sessionId}`);
      return opened();
    },
    'session/load': (params) => {
      calls.push(`load:${params.sessionId}`);
      say(params.sessionId, 'an earlier answer\n');
      return opened();
    },
    'session/set_config_option': (params) => {
      const { configId, value } = params;
      const option = options().find((item) => item.id === configId);
      const offered = option ? option.options : [];
      const known = offered.some((item) => item.value === value);
      const refused = !known || scenario === 'strict';
      if (refused) throw new Error(`Invalid value: ${value}`);
      const model = config.model.currentValue;
      if (config[configId] === option) option.currentValue = value;
      else chosen[`${model}.${configId}`] = value;
      calls.push(`${configId}=${value}`);
      note(`${configId}=${value}`);
      return { configOptions: options() };
    },
    'session/prompt': (params) => prompt(params.sessionId, params),
  };

  const answer = async (message) => {
    const handler = handlers[message.method];
    try {
      if (!handler) throw new Error(`Method not found: ${message.method}`);
      const result = await handler(message.params ?? {});
      if (result) send({ id: message.id, result });
    } catch (error) {
      const code = error.code ?? -32603;
      send({ id: message.id, error: { code, message: error.message } });
    }
  };

  const receive = (message) => {
    if (message.method === 'session/cancel') return void note('cancel');
    if (message.method) return void answer(message);
    const resolve = waiting.get(message.id);
    waiting.delete(message.id);
    if (resolve) resolve(message.result.outcome);
  };

  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    const lines = `${buffer}${chunk}`.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      if (line.trim()) receive(JSON.parse(line));
    }
  });
};

const at = process.argv.indexOf('--acp');
if (at > 0) serve(process.argv[at + 1] ?? '');
