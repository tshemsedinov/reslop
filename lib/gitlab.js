'use strict';

const { delay } = require('metautil');

const diff = require('./diff.js');
const { parseDiff, itemsFromFiles, isCtxType } = diff;
const { itemPath, isPathInScope } = require('./files.js');
const { foldDepItems } = require('./deps.js');

const USER_AGENT = 'reslop';
const JSON_ACCEPT = 'application/json';
const DIFF_ACCEPT = 'text/plain';
const RETRY_ATTEMPTS = 3;
const RETRY_DELAY_MS = 200;
const TRANSIENT_STATUS = [429, 502, 503, 504];
const MR_TODO_FILE = 'merge request';
const LIST_PER_PAGE = 100;

const GITLAB_MR_RE = new RegExp(
  String.raw`^(?:(https?)://)?(?:www\.)?([^/?#]+)/` +
    String.raw`(.+?)(?:/-)?/merge_requests/(\d+)` +
    String.raw`(?:\.diff|\.patch)?` +
    String.raw`(?:/(?:diffs|commits|pipelines|changes)?)?` +
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

const gitlabError = (code, message) => {
  const error = new Error(message);
  error.code = code;
  return error;
};

const withStatus = (error, status) => {
  error.status = status;
  return error;
};

const parseGitlabMrUrl = (text) => {
  if (typeof text !== 'string' || !text) return null;
  const match = GITLAB_MR_RE.exec(text.trim());
  if (!match) return null;
  const scheme = (match[1] || 'https').toLowerCase();
  const host = match[2];
  const rawProject = match[3];
  const project = rawProject.replace(/\.git$/i, '');
  const number = parseInt(match[4], 10);
  const hasNumber = Number.isFinite(number) && number >= 1;
  if (!host || !project || !hasNumber) return null;
  const origin = `${scheme}://${host}`;
  return { host, project, number, origin };
};

const gitlabToken = (env) => {
  const from = env ?? process.env;
  return from.GITLAB_TOKEN || from.GL_TOKEN || '';
};

const parseApiMessage = (body) => {
  const text = `${body ?? ''}`.trim();
  if (!text) return '';
  try {
    const parsed = JSON.parse(text);
    if (isRecord(parsed)) {
      if (typeof parsed.message === 'string') return parsed.message;
      if (typeof parsed.error === 'string') return parsed.error;
    }
  } catch {
    // ignore: body is not JSON
  }
  return oneLine(text);
};

const gitlabHttpError = (status, body, token) => {
  const message = parseApiMessage(body);
  if (status === 404) {
    const hint = token ? '' : ' (set GITLAB_TOKEN for private repositories)';
    const error = gitlabError(
      'GITLAB_NOT_FOUND',
      `GitLab merge request not found${hint}`,
    );
    return withStatus(error, status);
  }
  if (status === 401) {
    const error = gitlabError('GITLAB_AUTH', 'GitLab authentication failed');
    return withStatus(error, status);
  }
  if (status === 429) {
    const error = gitlabError(
      'GITLAB_RATE_LIMIT',
      'GitLab API rate limit exceeded',
    );
    return withStatus(error, status);
  }
  if (status === 403 && /rate limit/i.test(message)) {
    const error = gitlabError(
      'GITLAB_RATE_LIMIT',
      'GitLab API rate limit exceeded',
    );
    return withStatus(error, status);
  }
  const detail = message
    ? `GitLab API: ${oneLine(message)}`
    : `GitLab API HTTP ${status}`;
  return withStatus(gitlabError('GITLAB_HTTP', detail), status);
};

const wrapNetworkError = (error) => {
  const detail = oneLine(error && error.message);
  const suffix = detail ? `: ${detail}` : '';
  const wrapped = gitlabError(
    'GITLAB_NETWORK',
    `GitLab request failed${suffix}`,
  );
  wrapped.cause = error;
  return wrapped;
};

const isRetryable = (error) => {
  if (error.code === 'GITLAB_NETWORK') return true;
  return TRANSIENT_STATUS.includes(error.status);
};

const retry = async (run, options) => {
  const attempts = options.attempts ?? RETRY_ATTEMPTS;
  const delayMs = options.delayMs ?? RETRY_DELAY_MS;
  for (let i = 0; ; i++) {
    try {
      return await run();
    } catch (error) {
      const isLast = i === attempts - 1;
      if (isLast || !isRetryable(error)) throw error;
      await delay(delayMs * (i + 1));
    }
  }
};

const gitlabHeaders = (token, accept) => {
  const headers = {
    Accept: accept,
    'User-Agent': USER_AGENT,
  };
  if (!token) return headers;
  return { ...headers, 'PRIVATE-TOKEN': token };
};

const headerValue = (headers, name) => {
  if (!headers) return '';
  if (typeof headers.get === 'function') {
    return headers.get(name) || '';
  }
  const wanted = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    const value = headers[key];
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

const parseNextPage = (headers, currentUrl) => {
  const fromLink = parseLinkNext(headers);
  if (fromLink) return fromLink;
  const page = headerValue(headers, 'x-next-page');
  if (!page) return '';
  const url = new URL(currentUrl);
  url.searchParams.set('page', page);
  return url.toString();
};

const parseGitlabJson = (text, label) => {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw gitlabError('GITLAB_PARSE', `GitLab API: invalid ${label}`);
  }
  return data;
};

const requestGitlab = async (url, options) => {
  const fetchImpl = options.fetch;
  if (typeof fetchImpl !== 'function') {
    throw gitlabError('GITLAB_FETCH', 'fetch is not available');
  }
  const token = options.token || '';
  const headers = gitlabHeaders(token, options.accept);
  const retryOpts = options.retry ?? {};
  const method = options.method || 'GET';
  return retry(async () => {
    let response;
    try {
      response = await fetchImpl(url, { method, headers });
    } catch (error) {
      throw wrapNetworkError(error);
    }
    const text = await response.text();
    if (!response.ok) throw gitlabHttpError(response.status, text, token);
    return { body: text, headers: response.headers };
  }, retryOpts);
};

const requestGitlabList = async (url, options) => {
  const items = [];
  let next = url;
  while (next) {
    const page = await requestGitlab(next, {
      ...options,
      accept: JSON_ACCEPT,
    });
    const data = parseGitlabJson(page.body, 'list payload');
    if (!Array.isArray(data)) {
      throw gitlabError('GITLAB_PARSE', 'GitLab API: invalid list payload');
    }
    for (const entry of data) items.push(entry);
    next = parseNextPage(page.headers, next);
  }
  return items;
};

const changePath = (file) => file.newPath || file.oldPath || '';

const filterChangeFiles = (files, paths) => {
  if (!paths.length) return files;
  const kept = [];
  for (const file of files) {
    if (isPathInScope(changePath(file), paths)) kept.push(file);
  }
  return kept;
};

const mrApiUrl = (mr) => {
  const project = encodeURIComponent(mr.project);
  const base = `${mr.origin}/api/v4/projects/${project}`;
  return `${base}/merge_requests/${mr.number}`;
};

const listUrl = (base) => {
  const url = new URL(base);
  url.searchParams.set('per_page', `${LIST_PER_PAGE}`);
  return url.toString();
};

const readUsername = (user) => {
  if (!isRecord(user)) return '';
  return user.username || '';
};

const readProject = (data, mr) => {
  const refs = isRecord(data.references) ? data.references : null;
  const full = refs && refs.full;
  if (typeof full === 'string') {
    const cut = full.lastIndexOf('!');
    if (cut > 0) return full.slice(0, cut);
  }
  return mr.project;
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

const parseMergeRequestPayload = (text) => {
  const data = parseGitlabJson(text, 'merge request payload');
  if (!isRecord(data)) {
    throw gitlabError(
      'GITLAB_PARSE',
      'GitLab API: invalid merge request payload',
    );
  }
  return data;
};

const toChange = (mr, data, items) => {
  const number = data.iid || mr.number;
  const repository = readProject(data, mr);
  const title = data.title || '';
  const author = readUsername(data.author);
  const files = changeFiles(items);
  const base = data.target_branch || '';
  const head = data.source_branch || '';
  const fallbackUrl = `${mr.origin}/${repository}/-/merge_requests/${number}`;
  const url = data.web_url || fallbackUrl;
  const id = `${mr.host}/${repository}/merge_requests/${number}`;
  return {
    id,
    source: 'gitlab-mr',
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
  const login = readUsername(record && record.author);
  return login || 'unknown';
};

const formatImportedText = (entry) => {
  const reviewer = entry.reviewer || 'unknown';
  const body = `${entry.body ?? ''}`.trim();
  return `@${reviewer} review at gitlab: ${body}`;
};

const noteLine = (position) => {
  if (!isRecord(position)) return { side: 'RIGHT', line: 0 };
  const kind = position.position_type || 'text';
  if (kind === 'file' || kind === 'image') {
    return { side: 'RIGHT', line: 0 };
  }
  const newLine = Number(position.new_line);
  if (Number.isFinite(newLine) && newLine >= 1) {
    return { side: 'RIGHT', line: newLine };
  }
  const oldLine = Number(position.old_line);
  if (Number.isFinite(oldLine) && oldLine >= 1) {
    return { side: 'LEFT', line: oldLine };
  }
  return { side: 'RIGHT', line: 0 };
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
    if (isCtxType(entry.type) || entry.type === 'del') {
      oldNo += 1;
    }
    if (isCtxType(entry.type) || entry.type === 'add') {
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

const toImportedTodo = (file, entry) => ({
  kind: 'todo',
  file,
  text: formatImportedText(entry),
  done: entry.resolved === true,
});

const noteToImported = (note, items, paths) => {
  if (!isRecord(note) || note.system === true) return null;
  const body = readCommentBody(note.body);
  if (!body) return null;
  const resolved = note.resolved === true;
  const entry = {
    reviewer: reviewerOf(note),
    body,
    resolved,
  };
  if (note.type !== 'DiffNote') {
    return toImportedTodo(MR_TODO_FILE, entry);
  }
  const position = isRecord(note.position) ? note.position : null;
  const path = position ? position.new_path || position.old_path || '' : '';
  if (path && !isPathInScope(path, paths)) return null;
  const { side, line } = noteLine(position);
  const isFile = !line;
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
        done: resolved,
      };
    }
  }
  if (path) return toImportedTodo(path, entry);
  return toImportedTodo(MR_TODO_FILE, entry);
};

const discussionToNotes = (discussions, items, paths = []) => {
  const feedback = [];
  const todos = [];
  const threads = discussions ?? [];
  for (const discussion of threads) {
    if (!isRecord(discussion)) continue;
    const notes = Array.isArray(discussion.notes) ? discussion.notes : [];
    for (const note of notes) {
      const mapped = noteToImported(note, items, paths);
      if (!mapped) continue;
      if (mapped.kind === 'feedback') feedback.push(mapped);
      else todos.push(mapped);
    }
  }
  return { feedback, todos };
};

const loadDiscussion = async (mr, options) => {
  const url = listUrl(`${mrApiUrl(mr)}/discussions`);
  return requestGitlabList(url, options);
};

const loadImportedNotes = async (mr, items, paths, options) => {
  try {
    const discussions = await loadDiscussion(mr, options);
    return discussionToNotes(discussions, items, paths);
  } catch {
    // ignore: discussion import is optional
    return { feedback: [], todos: [] };
  }
};

const loadMergeRequest = async (mr, options = {}) => {
  const token = options.token ?? '';
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const paths = options.paths ?? [];
  const retryOpts = options.retry ?? {};
  const url = mrApiUrl(mr);
  const request = { fetch: fetchImpl, token, retry: retryOpts };
  const jsonPage = await requestGitlab(url, {
    ...request,
    accept: JSON_ACCEPT,
  });
  const data = parseMergeRequestPayload(jsonPage.body);
  const diffPage = await requestGitlab(`${url}/raw_diffs`, {
    ...request,
    accept: DIFF_ACCEPT,
  });
  const parsed = parseDiff(diffPage.body);
  const files = filterChangeFiles(parsed, paths);
  const parsedItems = itemsFromFiles(files, 'pr');
  const items = foldDepItems(parsedItems);
  const change = toChange(mr, data, items);
  const sourceLabel = `!${change.number}`;
  const imported = await loadImportedNotes(mr, items, paths, request);
  return { top: options.cwd, items, sourceLabel, change, imported };
};

module.exports = {
  parseGitlabMrUrl,
  gitlabToken,
  filterChangeFiles,
  mrApiUrl,
  formatImportedText,
  discussionToNotes,
  loadMergeRequest,
};
