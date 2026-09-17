'use strict';

const { diffChars } = require('./diff/inline.js');
const { isCtxType, pairIndices, attachInline } = require('./diff/align.js');
const { parseDiff } = require('./diff/parse.js');
const patch = require('./diff/patch.js');
const { splitHunk, flattenBlock, countSides, formatPatch } = patch;
const display = require('./diff/display.js');
const { DISPLAY_CONTEXT, displayLines, blockAddText } = display;
const edit = require('./diff/edit.js');
const { addBlockRange, replaceBlockAdds } = edit;
const items = require('./diff/items.js');
const { synthesizeNewFile, itemsFromFiles, refreshIndexPatches } = items;

module.exports = {
  DISPLAY_CONTEXT,
  isCtxType,
  diffChars,
  pairIndices,
  attachInline,
  parseDiff,
  splitHunk,
  flattenBlock,
  countSides,
  formatPatch,
  displayLines,
  blockAddText,
  addBlockRange,
  replaceBlockAdds,
  synthesizeNewFile,
  itemsFromFiles,
  refreshIndexPatches,
};
