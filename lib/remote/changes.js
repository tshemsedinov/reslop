'use strict';

const { itemPath, isPathInScope } = require('../files.js');
const { parseDiff, itemsFromFiles } = require('../diff/diff.js');
const { foldDepItems } = require('../deps.js');
const { isAbortError } = require('./http.js');

const changePath = (file) => file.newPath || file.oldPath || '';

const filterChangeFiles = (files, paths) => {
  if (!paths.length) return files;
  return files.filter((file) => isPathInScope(changePath(file), paths));
};

const changeFiles = (items) => {
  const files = new Set();
  for (const item of items) {
    const paths = item.dep ? item.dep.files : [itemPath(item)];
    for (const rel of paths ?? []) {
      if (rel) files.add(rel);
    }
  }
  return [...files];
};

const loadChange = async (ref, options, source) => {
  const { client, url, diffUrl = url, diffAccept } = source;
  const paths = options.paths ?? [];
  const request = {
    fetch: options.fetch ?? globalThis.fetch,
    token: options.token ?? '',
    retry: options.retry ?? {},
    signal: options.signal,
  };
  const jsonPage = await client.request(url, request);
  const data = client.parseJson(jsonPage.body, `${client.subject} payload`);
  const diffPage = await client.request(diffUrl, {
    ...request,
    accept: diffAccept,
  });
  const files = filterChangeFiles(parseDiff(diffPage.body), paths);
  const items = foldDepItems(itemsFromFiles(files, 'pr'));
  const change = source.toChange(ref, data, items);
  const sourceLabel = `${source.prefix}${change.number}`;
  let imported = { feedback: [], todos: [] };
  try {
    const discussion = await source.loadDiscussion(ref, request);
    imported = source.discussionToNotes(discussion, items, paths);
  } catch (error) {
    if (isAbortError(error, request.signal)) throw error;
    // Discussion import is optional.
  }
  return { top: options.cwd, items, sourceLabel, change, imported };
};

module.exports = { changePath, filterChangeFiles, changeFiles, loadChange };
