'use strict';

const { delay, isHashObject } = require('metautil');

const RETRY_ATTEMPTS = 3;
const RETRY_DELAY_MS = 200;
const TRANSIENT_STATUS = [429, 502, 503, 504];

const isRecord = isHashObject;

const oneLine = (text) => {
  const value = `${text ?? ''}`.trim();
  if (!value) return '';
  return value.split('\n')[0];
};

const abortError = (signal) => {
  if (signal && signal.reason !== undefined) return signal.reason;
  const error = new Error('This operation was aborted');
  error.name = 'AbortError';
  return error;
};

const isAbortError = (error, signal) => {
  if (signal && signal.aborted) return true;
  if (!error || typeof error !== 'object') return false;
  if (error.name === 'AbortError') return true;
  if (error.code === 'ABORT') return true;
  return false;
};

const throwIfAborted = (signal) => {
  if (signal && signal.aborted) throw abortError(signal);
};

const createTransport = (deps = {}) => {
  const fetchImpl = deps.fetch;
  const rawDelay = deps.delay ?? delay;
  const delayFn = async (ms, abortSignal) => {
    try {
      await rawDelay(ms, abortSignal);
    } catch (error) {
      throwIfAborted(abortSignal);
      throw error;
    }
  };
  const signal = deps.signal;

  const retry = async (run, options = {}) => {
    const attempts = options.attempts ?? RETRY_ATTEMPTS;
    const delayMs = options.delayMs ?? RETRY_DELAY_MS;
    const isRetryable = options.isRetryable;
    for (let i = 0; ; i++) {
      try {
        return await run();
      } catch (error) {
        if (isAbortError(error, signal)) throw error;
        const isLast = i === attempts - 1;
        if (isLast || !isRetryable(error)) throw error;
        throwIfAborted(signal);
        await delayFn(delayMs * (i + 1), signal);
      }
    }
  };

  const request = async (url, options = {}) => {
    throwIfAborted(signal);
    if (typeof fetchImpl !== 'function') {
      throw options.missingFetch();
    }
    const headers = options.headers;
    const method = options.method || 'GET';
    const body = options.body;
    const wrapNetwork = options.wrapNetwork;
    const toHttpError = options.toHttpError;
    const retryOpts = options.retry ?? {};
    return retry(
      async () => {
        let response;
        try {
          const init = { method, headers };
          if (body !== undefined) init.body = body;
          if (signal) init.signal = signal;
          response = await fetchImpl(url, init);
        } catch (error) {
          if (isAbortError(error, signal)) throw error;
          throw wrapNetwork(error);
        }
        const text = await response.text();
        if (!response.ok) throw toHttpError(response.status, text);
        return { body: text, headers: response.headers };
      },
      { ...retryOpts, isRetryable: options.isRetryable },
    );
  };

  const listPages = async (url, options = {}) => {
    const items = [];
    let next = url;
    const parsePage = options.parsePage;
    const nextPage = options.nextPage;
    while (next) {
      const page = await request(next, options);
      const entries = parsePage(page.body);
      for (const entry of entries) items.push(entry);
      next = nextPage(page.headers, next);
    }
    return items;
  };

  return { retry, request, listPages };
};

module.exports = {
  RETRY_ATTEMPTS,
  RETRY_DELAY_MS,
  TRANSIENT_STATUS,
  isRecord,
  oneLine,
  isAbortError,
  createTransport,
};
