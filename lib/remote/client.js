'use strict';

const { jsonParse, isHashObject } = require('metautil');
const { createTransport, TRANSIENT_STATUS, oneLine } = require('./http.js');

const listUrl = (base) => {
  const url = new URL(base);
  url.searchParams.set('per_page', '100');
  return url.toString();
};

const createClient = ({ name, subject, headers, nextPage }) => {
  const prefix = name.toUpperCase();
  const error = (code, message, extra = {}) =>
    Object.assign(new Error(message), { code: `${prefix}_${code}`, ...extra });

  const parseJson = (text, label, validate = isHashObject) => {
    const data = jsonParse(text ?? '');
    if (!validate(data)) throw error('PARSE', `${name} API: invalid ${label}`);
    return data;
  };

  const httpError = (status, body, token) => {
    const text = `${body ?? ''}`.trim();
    const parsed = jsonParse(text);
    const fields = name === 'GitLab' ? ['message', 'error'] : ['message'];
    const field = fields.find((key) => typeof parsed?.[key] === 'string');
    const message =
      isHashObject(parsed) && field ? parsed[field] : oneLine(text);
    if (status === 404) {
      const hint = token
        ? ''
        : ` (set ${prefix}_TOKEN for private repositories)`;
      return error('NOT_FOUND', `${name} ${subject} not found${hint}`, {
        status,
      });
    }
    if (status === 401) {
      return error('AUTH', `${name} authentication failed`, { status });
    }
    const rateLimit = status === 403 && /rate limit/i.test(message);
    if (rateLimit || (name === 'GitLab' && status === 429)) {
      return error('RATE_LIMIT', `${name} API rate limit exceeded`, { status });
    }
    const detail = message ? `: ${oneLine(message)}` : ` HTTP ${status}`;
    return error('HTTP', `${name} API${detail}`, { status });
  };

  const policy = (options) => ({
    retry: options.retry ?? {},
    isRetryable: (err) =>
      err.code === `${prefix}_NETWORK` || TRANSIENT_STATUS.includes(err.status),
    missingFetch: () => error('FETCH', 'fetch is not available'),
    toHttpError: (status, body) => httpError(status, body, options.token),
    wrapNetwork: (cause) => {
      const detail = oneLine(cause && cause.message);
      const suffix = detail ? `: ${detail}` : '';
      return error('NETWORK', `${name} request failed${suffix}`, { cause });
    },
    method: options.method || 'GET',
    headers: headers(options.token || '', options.accept),
  });

  const request = (url, options) => {
    const init = policy(options);
    if (options.contentType) init.headers['Content-Type'] = options.contentType;
    return createTransport(options).request(url, {
      ...init,
      body: options.body,
    });
  };

  const list = (url, options) =>
    createTransport(options).listPages(url, {
      ...policy(options),
      method: 'GET',
      parsePage: (text) => parseJson(text, 'list payload', Array.isArray),
      nextPage,
    });

  return { parseJson, request, list, subject };
};

module.exports = { createClient, listUrl };
