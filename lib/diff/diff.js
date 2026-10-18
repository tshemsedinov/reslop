'use strict';

const inline = require('./inline.js');
const align = require('./align.js');
const parse = require('./parse.js');
const patch = require('./patch.js');
const unit = require('./unit.js');

module.exports = {
  diffChars: inline.diffChars,
  isCtxType: patch.isCtxType,
  pairIndices: align.pairIndices,
  attachInline: align.attachInline,
  DISPLAY_CONTEXT: align.DISPLAY_CONTEXT,
  displayLines: align.displayLines,
  blockAddText: align.blockAddText,
  parseDiff: parse.parseDiff,
  splitHunk: patch.splitHunk,
  flattenBlock: patch.flattenBlock,
  formatPatch: patch.formatPatch,
  addBlockRange: patch.addBlockRange,
  replaceBlockAdds: patch.replaceBlockAdds,
  synthesizeNewFile: patch.synthesizeNewFile,
  itemsFromFiles: patch.itemsFromFiles,
  refreshIndexPatches: patch.refreshIndexPatches,
  ...unit,
};
