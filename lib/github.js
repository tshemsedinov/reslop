'use strict';

const { delay } = require('metautil');

const diff = require('./diff.js');
const { parseDiff, itemsFromFiles } = diff;
const { itemPath } = require('./files.js');

const GITHUB_API = 'https://api.github.com';
const API_VERSION = '2022-11-28';
const USER_AGENT = 'reslop';
const JSON_ACCEPT = 'application/vnd.github+json';
const DIFF_ACCEPT = 'application/vnd.github.diff';
const RETRY_ATTEMPTS = 3;
const RETRY_DELAY_MS = 200;
const TRANSIENT_STATUS = [429, 502, 503, 504];

const GITHUB_PR_RE = new RegExp(
  String.raw`^(?:https?://)?(?:www\.)?github\.com/` +
    String.raw`([^/?#]+)/([^/?#]+)/pull/(\d+)` +
    String.raw`(?:\.diff|\.patch)?` +
    String.raw`(?:/(?:files|commits|checks|changes)?)?` +
    String.raw`/?(?:[?#].*)?$`,
  'i',
);

const isRecord = (value) =>
  !!value && typeof value === 'object' && !Array.isArray(value);

const oneLine = (text) => {
  const value = `${text ?? ''}`.trim();
  if (!value) return '';
  return value.split('\n')[0];
};

const githubError = (code, message) => {
  const error = new Error(message);
  error.code = code;
  return error;
};

const withStatus = (error, status) => {
  error.status = status;
  return error;
};

const parseGithubPrUrl = (text) => {
  if (typeof text !== 'string' || !text) return null;
  const match = GITHUB_PR_RE.exec(text.trim());
  if (!match) return null;
  const owner = match[1];
  const rawRepo = match[2];
  const repo = rawRepo.replace(/\.git$/i, '');
  const number = parseInt(match[3], 10);
  const hasNumber = Number.isFinite(number) && number >= 1;
  if (!owner || !repo || !hasNumber) return null;
  return { owner, repo, number };
};

const githubToken = (env) => {
  const from = env ?? process.env;
  if (!isRecord(from)) return '';
  return from.GITHUB_TOKEN || from.GH_TOKEN || '';
};

const parseApiMessage = (body) => {
  const text = `${body ?? ''}`.trim();
  if (!text) return '';
  try {
    const parsed = JSON.parse(text);
    if (isRecord(parsed) && typeof parsed.message === 'string') {
      return parsed.message;
    }
  } catch {}
  return oneLine(text);
};

const githubHttpError = (status, body, token) => {
  const message = parseApiMessage(body);
  if (status === 404) {
    const hint = token ? '' : ' (set GITHUB_TOKEN for private repositories)';
    const error = githubError(
      'GITHUB_NOT_FOUND',
      `GitHub pull request not found${hint}`,
    );
    return withStatus(error, status);
  }
  if (status === 401) {
    const error = githubError('GITHUB_AUTH', 'GitHub authentication failed');
    return withStatus(error, status);
  }
  if (status === 403 && /rate limit/i.test(message)) {
    const error = githubError(
      'GITHUB_RATE_LIMIT',
      'GitHub API rate limit exceeded',
    );
    return withStatus(error, status);
  }
  const detail = message
    ? `GitHub API: ${oneLine(message)}`
    : `GitHub API HTTP ${status}`;
  return withStatus(githubError('GITHUB_HTTP', detail), status);
};

const wrapNetworkError = (error) => {
  const detail = oneLine(error && error.message);
  const suffix = detail ? `: ${detail}` : '';
  const wrapped = githubError(
    'GITHUB_NETWORK',
    `GitHub request failed${suffix}`,
  );
  wrapped.cause = error;
  return wrapped;
};

const isRetryable = (error) => {
  if (error.code === 'GITHUB_NETWORK') return true;
  return TRANSIENT_STATUS.includes(error.status);
};

const retry = async (run, options) => {
  const attempts = options.attempts ?? RETRY_ATTEMPTS;
  const delayMs = options.delayMs ?? RETRY_DELAY_MS;
  let lastError = null;
  for (let i = 0; i < attempts; i++) {
    try {
      return await run();
    } catch (error) {
      lastError = error;
      const isLast = i === attempts - 1;
      if (isLast || !isRetryable(error)) throw error;
      await delay(delayMs * (i + 1));
    }
  }
  throw lastError;
};

const githubHeaders = (token, accept) => {
  const headers = {
    Accept: accept,
    'User-Agent': USER_AGENT,
    'X-GitHub-Api-Version': API_VERSION,
  };
  if (!token) return headers;
  return { ...headers, Authorization: `Bearer ${token}` };
};

const requestGithub = async (url, options) => {
  const fetchImpl = options.fetch;
  if (typeof fetchImpl !== 'function') {
    throw githubError('GITHUB_FETCH', 'fetch is not available');
  }
  const token = options.token || '';
  const headers = githubHeaders(token, options.accept);
  const retryOpts = options.retry ?? {};
  return retry(async () => {
    let response;
    try {
      response = await fetchImpl(url, { headers });
    } catch (error) {
      throw wrapNetworkError(error);
    }
    const body = await response.text();
    if (response.ok) return body;
    throw githubHttpError(response.status, body, token);
  }, retryOpts);
};

const changePath = (file) => file.newPath || file.oldPath || '';

const normalizePathSpec = (spec) =>
  `${spec ?? ''}`.replaceAll('\\', '/').replace(/\/+$/, '');

const isPathInScope = (rel, paths) => {
  if (!paths.length) return true;
  for (const spec of paths) {
    const norm = normalizePathSpec(spec);
    if (!norm || norm === '.') return true;
    if (rel === norm || rel.startsWith(`${norm}/`)) return true;
  }
  return false;
};

const filterChangeFiles = (files, paths) => {
  if (!paths.length) return files;
  const kept = [];
  for (const file of files) {
    if (isPathInScope(changePath(file), paths)) kept.push(file);
  }
  return kept;
};

const prApiUrl = (pr) => {
  const owner = encodeURIComponent(pr.owner);
  const repo = encodeURIComponent(pr.repo);
  return `${GITHUB_API}/repos/${owner}/${repo}/pulls/${pr.number}`;
};

const readLogin = (user) => {
  if (!isRecord(user)) return '';
  return user.login || '';
};

const readRef = (side) => {
  if (!isRecord(side)) return '';
  return side.ref || '';
};

const readRepoName = (data, pr) => {
  const base = isRecord(data.base) ? data.base : null;
  const repo = base && isRecord(base.repo) ? base.repo : null;
  const fromBase = repo && repo['full_name'];
  if (fromBase) return fromBase;
  return `${pr.owner}/${pr.repo}`;
};

const changeFiles = (items) => {
  const files = [];
  const seen = new Set();
  for (const item of items) {
    const rel = itemPath(item);
    if (!rel || seen.has(rel)) continue;
    seen.add(rel);
    files.push(rel);
  }
  return files;
};

const parsePullRequestPayload = (text) => {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw githubError(
      'GITHUB_PARSE',
      'GitHub API: invalid pull request payload',
    );
  }
  if (!isRecord(data)) {
    throw githubError(
      'GITHUB_PARSE',
      'GitHub API: invalid pull request payload',
    );
  }
  return data;
};

const toChange = (pr, data, items) => {
  const number = data.number || pr.number;
  const repository = readRepoName(data, pr);
  const title = data.title || '';
  const author = readLogin(data.user);
  const files = changeFiles(items);
  const base = readRef(data.base);
  const head = readRef(data.head);
  const fallbackUrl = `https://github.com/${repository}/pull/${number}`;
  const url = data['html_url'] || fallbackUrl;
  const id = `github.com/${repository}/pull/${number}`;
  return {
    id,
    source: 'github-pr',
    title,
    author,
    files,
    status: 'reviewing',
    base,
    head,
    url,
    repository,
    number,
  };
};

const loadPullRequest = async (pr, options = {}) => {
  const token = options.token ?? githubToken(options.env);
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const paths = options.paths ?? [];
  const retryOpts = options.retry ?? {};
  const url = prApiUrl(pr);
  const request = { fetch: fetchImpl, token, retry: retryOpts };
  const jsonText = await requestGithub(url, {
    ...request,
    accept: JSON_ACCEPT,
  });
  const data = parsePullRequestPayload(jsonText);
  const diffText = await requestGithub(url, {
    ...request,
    accept: DIFF_ACCEPT,
  });
  const parsed = parseDiff(diffText);
  const files = filterChangeFiles(parsed, paths);
  const items = itemsFromFiles(files, 'pr');
  const change = toChange(pr, data, items);
  const sourceLabel = `#${change.number}`;
  return { top: options.cwd, items, sourceLabel, change };
};

module.exports = {
  GITHUB_API,
  parseGithubPrUrl,
  githubToken,
  filterChangeFiles,
  prApiUrl,
  loadPullRequest,
};
