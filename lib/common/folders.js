'use strict';

const { cmpEn } = require('./utilities.js');

const ROOT = '.';

const folderOf = (rel) => {
  const at = rel.lastIndexOf('/');
  return at < 0 ? ROOT : rel.slice(0, at);
};

const baseName = (rel) => rel.slice(rel.lastIndexOf('/') + 1);

const ancestors = (folder) => {
  const list = [];
  for (let at = folder; at !== ROOT; at = folderOf(at)) list.push(at);
  list.push(ROOT);
  return list;
};

const holds = (folder, rel) => folder === ROOT || rel.startsWith(`${folder}/`);

// The folder itself when a listed file is somewhere below it, else the
// nearest parent that still has one: the root always does
const shownFolder = (entries, folder) => {
  const used = (at) => entries.some((entry) => holds(at, entry.path));
  let at = folder || ROOT;
  while (at !== ROOT && !used(at)) at = folderOf(at);
  return at;
};

const inFolder = (entries, folder) =>
  entries.filter((entry) => folderOf(entry.path) === folder);

const folderNode = (key, depth) => ({
  key,
  name: key === ROOT ? '/' : baseName(key),
  depth,
  files: 0,
  bytes: 0,
  lines: 0,
  sized: false,
  children: [],
});

const nodeOf = (nodes, key) => {
  const known = nodes.get(key);
  if (known) return known;
  const parent = nodeOf(nodes, folderOf(key));
  const node = folderNode(key, parent.depth + 1);
  parent.children.push(node);
  nodes.set(key, node);
  return node;
};

const flatten = (node, rows) => {
  const { children, ...row } = node;
  rows.push(row);
  children.sort((left, right) => cmpEn(left.name, right.name));
  for (const child of children) flatten(child, rows);
  return rows;
};

// Every folder of the listed files in tree order, each with the totals of
// all the files below it
const folderTree = (entries, stats = new Map()) => {
  const root = folderNode(ROOT, 0);
  const nodes = new Map([[ROOT, root]]);
  for (const entry of entries) {
    if (!entry.path) continue;
    const stat = stats.get(entry.path);
    nodeOf(nodes, folderOf(entry.path));
    for (const key of ancestors(folderOf(entry.path))) {
      const node = nodes.get(key);
      node.files += 1;
      if (!stat) continue;
      node.sized = true;
      node.bytes += stat.size;
      node.lines += stat.lines;
    }
  }
  return flatten(root, []);
};

module.exports = {
  ROOT,
  folderOf,
  baseName,
  shownFolder,
  inFolder,
  folderTree,
};
