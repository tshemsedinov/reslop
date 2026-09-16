'use strict';

const { spawn, spawnSync } = require('node:child_process');

const { spawnBase } = require('../sys.js');

const DEFAULT_ENCODING = 'utf8';
const DEFAULT_MAX_BUFFER = 32 * 1024 * 1024;

const oneLine = (text, fallback = 'failed') => {
  const line = `${text ?? ''}`.trim().split('\n')[0];
  return line || fallback;
};

const abortError = () => {
  const error = new Error('aborted');
  error.code = 'ABORT';
  return error;
};

const isAbort = (error) => !!(error && error.code === 'ABORT');

const asOutput = (value) => {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  return `${value}`;
};

const procResult = (values = {}) => {
  const status = values.status ?? null;
  const stdout = asOutput(values.stdout);
  const stderr = asOutput(values.stderr);
  const error = values.error ?? null;
  return { status, stdout, stderr, error };
};

const spawnOptions = (options = {}) => {
  const encoding = options.encoding ?? DEFAULT_ENCODING;
  const maxBuffer = options.maxBuffer ?? DEFAULT_MAX_BUFFER;
  const opts = spawnBase({
    cwd: options.cwd,
    env: options.env,
    encoding,
    input: options.input,
    maxBuffer,
    timeout: options.timeout,
  });
  if (options.shell) opts.shell = true;
  return opts;
};

const runProcSync = (cmd, args, options = {}) => {
  const result = spawnSync(cmd, args, spawnOptions(options));
  return procResult({
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    error: result.error,
  });
};

const attachOutput = (stream, encoding, onChunk) => {
  if (!stream) return;
  stream.setEncoding(encoding);
  stream.on('data', onChunk);
};

const writeInput = (child, input) => {
  if (!child.stdin) return;
  try {
    if (input) child.stdin.end(input);
    else child.stdin.end();
  } catch {
    // closed
  }
};

const listenChild = (child, options, resolve) => {
  const encoding = options.encoding ?? DEFAULT_ENCODING;
  const maxBuffer = options.maxBuffer ?? DEFAULT_MAX_BUFFER;
  const timeout = options.timeout;
  const input = options.input;
  const signal = options.signal;
  let stdout = '';
  let stderr = '';
  let settled = false;
  let timer = null;
  let onAbort = null;
  const finish = (result) => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    timer = null;
    if (signal && onAbort) {
      signal.removeEventListener('abort', onAbort);
    }
    onAbort = null;
    resolve(result);
  };
  onAbort = () => {
    child.kill();
    finish(procResult({ stdout, stderr, error: abortError() }));
  };
  const append = (kind, chunk) => {
    if (kind === 'out') stdout += chunk;
    else stderr += chunk;
    if (stdout.length + stderr.length <= maxBuffer) return;
    child.kill();
    const error = new Error('maxBuffer exceeded');
    error.code = 'ENOBUFS';
    finish(procResult({ stdout, stderr, error }));
  };
  if (signal) signal.addEventListener('abort', onAbort);
  if (timeout) {
    timer = setTimeout(() => {
      child.kill();
      const error = new Error('timed out');
      error.code = 'ETIMEDOUT';
      finish(procResult({ stdout, stderr, error }));
    }, timeout);
  }
  if (signal && signal.aborted) onAbort();
  attachOutput(child.stdout, encoding, (chunk) => append('out', chunk));
  attachOutput(child.stderr, encoding, (chunk) => append('err', chunk));
  child.on('error', (error) => {
    finish(procResult({ stdout, stderr, error }));
  });
  child.on('close', (status) => {
    finish(procResult({ status, stdout, stderr }));
  });
  writeInput(child, input);
};

const runProc = (cmd, args, options = {}) =>
  new Promise((resolve) => {
    const signal = options.signal;
    if (signal && signal.aborted) {
      resolve(procResult({ error: abortError() }));
      return;
    }
    const spawnOpts = { cwd: options.cwd, env: options.env };
    if (options.shell) spawnOpts.shell = true;
    let child;
    try {
      child = spawn(cmd, args, spawnBase(spawnOpts));
    } catch (error) {
      resolve(procResult({ error }));
      return;
    }
    listenChild(child, options, resolve);
  });

module.exports = {
  DEFAULT_ENCODING,
  DEFAULT_MAX_BUFFER,
  oneLine,
  abortError,
  isAbort,
  procResult,
  runProcSync,
  runProc,
};
