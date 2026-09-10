'use strict';

const { delay } = require('metautil');

const diff = require('./diff.js');
const { parseDiff, itemsFromFiles } = diff;
const { itemPath } = require('./files.js');
const { foldDepItems } = require('./deps.js');

const GITHUB_API = 'https://api.github.com';
const API_VERSION = '2022-11-28';
const USER_AGENT = 'reslop';
const JSON_ACCEPT = 'application/vnd.github+json';
const DIFF_ACCEPT = 'application/vnd.github.diff';
const RETRY_ATTEMPTS = 3;
const RETRY_DELAY_MS = 200;
const TRANSIENT_STATUS = [429, 502, 503, 504];
const PR_TODO_FILE = 'pull request';
const LIST_PER_PAGE = 100;
const GRAPHQL_URL = `${GITHUB_API}/graphql`;
const REVIEW_THREADS_QUERY =
  'query($owner: String!, $name: String!, $number: Int!, $after: String) {' +
  ' repository(owner: $owner, name: $name) {' +
  ' pullRequest(number: $number) {' +
  ' reviewThreads(first: 100, after: $after) {' +
  ' pageInfo { hasNextPage endCursor }' +
  ' nodes { isResolved comments(first: 100) { nodes { databaseId } } }' +
  ' } } } }';

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
  } catch {
    // ignore: body is not JSON
  }
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

const headerValue = (headers, name) => {
  if (!headers) return '';
  if (typeof headers.get === 'function') {
    return headers.get(name) || '';
  }
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return `${value}`;
  }
  return '';
};

const parseLinkNext = (headers) => {
  const link = headerValue(headers, 'link');
  if (!link) return '';
  for (const part of link.split(',')) {
    const match = /<([^>]+)>\s*;\s*rel="?next"?/i.exec(part.trim());
    if (match) return match[1];
  }
  return '';
};

const parseGithubJson = (text, label) => {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw githubError('GITHUB_PARSE', `GitHub API: invalid ${label}`);
  }
  return data;
};

const requestGithub = async (url, options) => {
  const fetchImpl = options.fetch;
  if (typeof fetchImpl !== 'function') {
    throw githubError('GITHUB_FETCH', 'fetch is not available');
  }
  const token = options.token || '';
  const headers = { ...githubHeaders(token, options.accept) };
  if (options.contentType) headers['Content-Type'] = options.contentType;
  const retryOpts = options.retry ?? {};
  const method = options.method || 'GET';
  const body = options.body;
  return retry(async () => {
    let response;
    try {
      const init = { method, headers };
      if (body !== undefined) init.body = body;
      response = await fetchImpl(url, init);
    } catch (error) {
      throw wrapNetworkError(error);
    }
    const text = await response.text();
    if (!response.ok) throw githubHttpError(response.status, text, token);
    return { body: text, headers: response.headers };
  }, retryOpts);
};

const requestGithubList = async (url, options) => {
  const items = [];
  let next = url;
  while (next) {
    const page = await requestGithub(next, {
      ...options,
      accept: JSON_ACCEPT,
    });
    const data = parseGithubJson(page.body, 'list payload');
    if (!Array.isArray(data)) {
      throw githubError('GITHUB_PARSE', 'GitHub API: invalid list payload');
    }
    for (const entry of data) items.push(entry);
    next = parseLinkNext(page.headers);
  }
  return items;
};

const requestGraphql = async (query, variables, options) => {
  const payload = JSON.stringify({ query, variables });
  const page = await requestGithub(GRAPHQL_URL, {
    ...options,
    method: 'POST',
    accept: JSON_ACCEPT,
    contentType: 'application/json',
    body: payload,
  });
  const data = parseGithubJson(page.body, 'GraphQL payload');
  if (!isRecord(data)) {
    throw githubError('GITHUB_PARSE', 'GitHub API: invalid GraphQL payload');
  }
  return data;
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

const listUrl = (base) => {
  const url = new URL(base);
  url.searchParams.set('per_page', `${LIST_PER_PAGE}`);
  return url.toString();
};

const discussionUrls = (pr) => {
  const pull = prApiUrl(pr);
  const issue = pull.replace('/pulls/', '/issues/');
  return {
    reviewComments: listUrl(`${pull}/comments`),
    reviews: listUrl(`${pull}/reviews`),
    issueComments: listUrl(`${issue}/comments`),
  };
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

const pushChangeFile = (files, seen, rel) => {
  if (!rel || seen.has(rel)) return;
  seen.add(rel);
  files.push(rel);
};

const changeFiles = (items) => {
  const files = [];
  const seen = new Set();
  for (const item of items) {
    if (item.dep) {
      const depFiles = item.dep.files ?? [];
      for (const rel of depFiles) pushChangeFile(files, seen, rel);
      continue;
    }
    const rel = itemPath(item);
    pushChangeFile(files, seen, rel);
  }
  return files;
};

const parsePullRequestPayload = (text) => {
  const data = parseGithubJson(text, 'pull request payload');
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

const readCommentBody = (value) => `${value ?? ''}`.trim();

const reviewerOf = (record) => {
  const login = readLogin(record && record.user);
  return login || 'unknown';
};

const formatImportedText = (entry) => {
  const reviewer = entry.reviewer || 'unknown';
  const body = `${entry.body ?? ''}`.trim();
  return `@${reviewer} review at github: ${body}`;
};

const commentLine = (comment) => {
  const side = comment.side === 'LEFT' ? 'LEFT' : 'RIGHT';
  const raw = comment.line ?? comment['original_line'];
  const line = Number(raw);
  if (!Number.isFinite(line) || line < 1) return { side, line: 0 };
  return { side, line };
};

const sideLineNumber = (type, oldNo, newNo, side) => {
  if (side === 'LEFT') {
    if (type === 'add') return 0;
    return oldNo;
  }
  if (type === 'del') return 0;
  return newNo;
};

const locateLineInItem = (item, rel, line, side) => {
  const path = itemPath(item);
  if (path !== rel) return null;
  const hunk = item.hunk;
  if (!hunk || !line) return null;
  let oldNo = hunk.oldStart;
  let newNo = hunk.newStart;
  for (const entry of hunk.lines) {
    const at = sideLineNumber(entry.type, oldNo, newNo, side);
    if (at === line) {
      const inBlock = entry.blockId === item.blockId;
      return { inBlock };
    }
    if (entry.type === 'ctx' || entry.type === 'warn' || entry.type === 'del') {
      oldNo += 1;
    }
    if (entry.type === 'ctx' || entry.type === 'warn' || entry.type === 'add') {
      newNo += 1;
    }
  }
  return null;
};

const findItemForLine = (items, rel, line, side) => {
  let fallback = null;
  for (const item of items) {
    const hit = locateLineInItem(item, rel, line, side);
    if (!hit) continue;
    if (hit.inBlock) return item;
    if (!fallback) fallback = item;
  }
  return fallback;
};

const resolvedOf = (resolvedById, id) => {
  const commentId = Number(id);
  if (!Number.isFinite(commentId) || !resolvedById.has(commentId)) {
    return null;
  }
  return resolvedById.get(commentId);
};

const toImportedTodo = (file, entry) => ({
  kind: 'todo',
  file,
  text: formatImportedText(entry),
  done: entry.resolved === true,
});

const reviewCommentToNote = (comment, items, resolvedById, paths) => {
  if (!isRecord(comment)) return null;
  const body = readCommentBody(comment.body);
  if (!body) return null;
  const path = comment.path || '';
  if (path && !isPathInScope(path, paths)) return null;
  const { side, line } = commentLine(comment);
  const resolved = resolvedOf(resolvedById, comment.id);
  const entry = {
    reviewer: reviewerOf(comment),
    body,
    resolved,
  };
  const subject = comment['subject_type'] || 'line';
  const isFile = subject === 'file' || !line;
  if (!isFile && path) {
    const item = findItemForLine(items, path, line, side);
    if (item) {
      const hunk = item.hunk;
      return {
        kind: 'feedback',
        file: itemPath(item) || path,
        oldStart: hunk ? hunk.oldStart : 0,
        newStart: hunk ? hunk.newStart : 0,
        blockId: item.blockId ?? 0,
        origin: item.origin ?? 'pr',
        header: hunk ? hunk.header : '',
        text: formatImportedText(entry),
        done: resolved === true,
      };
    }
  }
  if (path) return toImportedTodo(path, entry);
  return toImportedTodo(PR_TODO_FILE, entry);
};

const summaryToTodo = (record) => {
  if (!isRecord(record)) return null;
  const body = readCommentBody(record.body);
  if (!body) return null;
  return toImportedTodo(PR_TODO_FILE, {
    reviewer: reviewerOf(record),
    body,
  });
};

const discussionToNotes = (discussion, items, paths = []) => {
  const feedback = [];
  const todos = [];
  const resolvedById = discussion.resolvedById ?? new Map();
  const reviewComments = discussion.reviewComments ?? [];
  for (const comment of reviewComments) {
    const note = reviewCommentToNote(comment, items, resolvedById, paths);
    if (!note) continue;
    if (note.kind === 'feedback') feedback.push(note);
    else todos.push(note);
  }
  const reviews = discussion.reviews ?? [];
  for (const review of reviews) {
    const todo = summaryToTodo(review);
    if (todo) todos.push(todo);
  }
  const issueComments = discussion.issueComments ?? [];
  for (const comment of issueComments) {
    const todo = summaryToTodo(comment);
    if (todo) todos.push(todo);
  }
  return { feedback, todos };
};

const loadReviewThreads = async (pr, options) => {
  const threads = [];
  let after = null;
  for (;;) {
    const payload = await requestGraphql(
      REVIEW_THREADS_QUERY,
      {
        owner: pr.owner,
        name: pr.repo,
        number: pr.number,
        after,
      },
      options,
    );
    const data = isRecord(payload.data) ? payload.data : null;
    if (!data) return threads;
    const repository = isRecord(data.repository) ? data.repository : {};
    const pullRequest = isRecord(repository.pullRequest)
      ? repository.pullRequest
      : {};
    const reviewThreads = isRecord(pullRequest.reviewThreads)
      ? pullRequest.reviewThreads
      : {};
    const nodes = Array.isArray(reviewThreads.nodes) ? reviewThreads.nodes : [];
    for (const thread of nodes) threads.push(thread);
    const pageInfo = isRecord(reviewThreads.pageInfo)
      ? reviewThreads.pageInfo
      : {};
    if (!pageInfo.hasNextPage) return threads;
    const cursor = pageInfo.endCursor || null;
    if (!cursor || cursor === after) return threads;
    after = cursor;
  }
};

const threadComments = (thread) => {
  if (!isRecord(thread)) return [];
  const comments = thread.comments;
  if (Array.isArray(comments)) return comments;
  if (isRecord(comments) && Array.isArray(comments.nodes)) {
    return comments.nodes;
  }
  return [];
};

const loadResolvedById = async (pr, options) => {
  const resolved = new Map();
  try {
    const threads = await loadReviewThreads(pr, options);
    for (const thread of threads) {
      const isResolved = thread.isResolved === true;
      for (const comment of threadComments(thread)) {
        if (!isRecord(comment)) continue;
        const id = Number(comment.databaseId);
        if (!Number.isFinite(id)) continue;
        resolved.set(id, isResolved);
      }
    }
  } catch {
    // ignore: resolved state is optional
  }
  return resolved;
};

const loadDiscussion = async (pr, options) => {
  const urls = discussionUrls(pr);
  const reviewComments = await requestGithubList(urls.reviewComments, options);
  const reviews = await requestGithubList(urls.reviews, options);
  const issueComments = await requestGithubList(urls.issueComments, options);
  const resolvedById = await loadResolvedById(pr, options);
  return { reviewComments, reviews, issueComments, resolvedById };
};

const emptyImported = () => ({ feedback: [], todos: [] });

const loadImportedNotes = async (pr, items, paths, options) => {
  try {
    const discussion = await loadDiscussion(pr, options);
    return discussionToNotes(discussion, items, paths);
  } catch {
    // ignore: discussion import is optional
    return emptyImported();
  }
};

const loadPullRequest = async (pr, options = {}) => {
  const token = options.token ?? githubToken(options.env);
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const paths = options.paths ?? [];
  const retryOpts = options.retry ?? {};
  const url = prApiUrl(pr);
  const request = { fetch: fetchImpl, token, retry: retryOpts };
  const jsonPage = await requestGithub(url, {
    ...request,
    accept: JSON_ACCEPT,
  });
  const data = parsePullRequestPayload(jsonPage.body);
  const diffPage = await requestGithub(url, {
    ...request,
    accept: DIFF_ACCEPT,
  });
  const parsed = parseDiff(diffPage.body);
  const files = filterChangeFiles(parsed, paths);
  const parsedItems = itemsFromFiles(files, 'pr');
  const items = foldDepItems(parsedItems);
  const change = toChange(pr, data, items);
  const sourceLabel = `#${change.number}`;
  const imported = await loadImportedNotes(pr, items, paths, request);
  return { top: options.cwd, items, sourceLabel, change, imported };
};

module.exports = {
  GITHUB_API,
  PR_TODO_FILE,
  parseGithubPrUrl,
  githubToken,
  filterChangeFiles,
  prApiUrl,
  formatImportedText,
  discussionToNotes,
  loadPullRequest,
};
