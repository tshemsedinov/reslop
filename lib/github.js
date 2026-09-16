'use strict';

const { delay } = require('metautil');

const diff = require('./diff.js');
const { parseDiff, itemsFromFiles } = diff;
const { isPathInScope } = require('./files.js');
const { foldDepItems } = require('./deps.js');
const http = require('./remote/http.js');
const { createTransport, isRecord, oneLine, isAbortError } = http;
const { TRANSIENT_STATUS } = http;
const { parseLinkNext } = require('./remote/headers.js');
const { filterChangeFiles, changeFiles } = require('./remote/changes.js');
const remoteNotes = require('./remote/notes.js');
const { importedText, importedTodo, noteFromLocation } = remoteNotes;

const GITHUB_API = 'https://api.github.com';
const API_VERSION = '2022-11-28';
const USER_AGENT = 'reslop';
const JSON_ACCEPT = 'application/vnd.github+json';
const DIFF_ACCEPT = 'application/vnd.github.diff';
const PR_TODO_FILE = 'pull request';
const LIST_PER_PAGE = 100;
const IMPORT_HOST = 'github';
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

const githubError = (code, message) => {
  const error = new Error(message);
  error.code = code;
  return error;
};

const withStatus = (error, status) => {
  error.status = status;
  return error;
};

const asRecord = (value) => (isRecord(value) ? value : {});

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
  let detail = `GitHub API HTTP ${status}`;
  if (message) detail = `GitHub API: ${oneLine(message)}`;
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

const githubHeaders = (token, accept) => {
  const headers = {
    Accept: accept,
    'User-Agent': USER_AGENT,
    'X-GitHub-Api-Version': API_VERSION,
  };
  if (!token) return headers;
  return { ...headers, Authorization: `Bearer ${token}` };
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

const transportOf = (options) =>
  createTransport({
    fetch: options.fetch,
    delay: options.delay ?? delay,
    signal: options.signal,
  });

const requestPolicy = (options) => {
  const token = options.token || '';
  return {
    retry: options.retry ?? {},
    isRetryable,
    wrapNetwork: wrapNetworkError,
    missingFetch: () => githubError('GITHUB_FETCH', 'fetch is not available'),
    toHttpError: (status, body) => githubHttpError(status, body, token),
  };
};

const requestGithub = async (url, options) => {
  const token = options.token || '';
  const headers = { ...githubHeaders(token, options.accept) };
  if (options.contentType) headers['Content-Type'] = options.contentType;
  return transportOf(options).request(url, {
    ...requestPolicy(options),
    method: options.method || 'GET',
    headers,
    body: options.body,
  });
};

const requestGithubList = async (url, options) => {
  const token = options.token || '';
  return transportOf(options).listPages(url, {
    ...requestPolicy(options),
    method: 'GET',
    headers: githubHeaders(token, JSON_ACCEPT),
    parsePage: (text) => {
      const data = parseGithubJson(text, 'list payload');
      if (!Array.isArray(data)) {
        throw githubError('GITHUB_PARSE', 'GitHub API: invalid list payload');
      }
      return data;
    },
    nextPage: (headers) => parseLinkNext(headers),
  });
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

const formatImportedText = (entry) => importedText(entry, IMPORT_HOST);

const commentLine = (comment) => {
  const side = comment.side === 'LEFT' ? 'LEFT' : 'RIGHT';
  const raw = comment.line ?? comment['original_line'];
  const line = Number(raw);
  if (!Number.isFinite(line) || line < 1) return { side, line: 0 };
  return { side, line };
};

const resolvedOf = (resolvedById, id) => {
  const commentId = Number(id);
  if (!Number.isFinite(commentId) || !resolvedById.has(commentId)) {
    return null;
  }
  return resolvedById.get(commentId);
};

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
  if (subject === 'file') {
    if (path) return importedTodo(path, entry, IMPORT_HOST);
    return importedTodo(PR_TODO_FILE, entry, IMPORT_HOST);
  }
  return noteFromLocation(
    items,
    { path, line, side },
    entry,
    IMPORT_HOST,
    PR_TODO_FILE,
  );
};

const summaryToTodo = (record) => {
  if (!isRecord(record)) return null;
  const body = readCommentBody(record.body);
  if (!body) return null;
  return importedTodo(
    PR_TODO_FILE,
    {
      reviewer: reviewerOf(record),
      body,
    },
    IMPORT_HOST,
  );
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
    if (!isRecord(payload.data)) return threads;
    const data = payload.data;
    const repository = asRecord(data.repository);
    const pullRequest = asRecord(repository.pullRequest);
    const reviewThreads = asRecord(pullRequest.reviewThreads);
    const nodes = Array.isArray(reviewThreads.nodes) ? reviewThreads.nodes : [];
    for (const thread of nodes) threads.push(thread);
    const pageInfo = asRecord(reviewThreads.pageInfo);
    if (!pageInfo.hasNextPage) return threads;
    const cursor = pageInfo.endCursor || null;
    if (!cursor || cursor === after) return threads;
    after = cursor;
  }
};

const threadComments = (thread) => {
  if (!isRecord(thread)) return [];
  const comments = thread.comments;
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
  } catch (error) {
    if (isAbortError(error, options.signal)) throw error;
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

const loadImportedNotes = async (pr, items, paths, options) => {
  try {
    const discussion = await loadDiscussion(pr, options);
    return discussionToNotes(discussion, items, paths);
  } catch (error) {
    if (isAbortError(error, options.signal)) throw error;
    // ignore: discussion import is optional
    return { feedback: [], todos: [] };
  }
};

const loadPullRequest = async (pr, options = {}) => {
  const token = options.token ?? '';
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const paths = options.paths ?? [];
  const retryOpts = options.retry ?? {};
  const url = prApiUrl(pr);
  const request = {
    fetch: fetchImpl,
    token,
    retry: retryOpts,
    delay: options.delay,
    signal: options.signal,
  };
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
  parseGithubPrUrl,
  githubToken,
  filterChangeFiles,
  prApiUrl,
  formatImportedText,
  discussionToNotes,
  loadPullRequest,
};
