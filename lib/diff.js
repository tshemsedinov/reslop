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
const unit = require('./diff/unit.js');
const { unitLines, itemsForPath, blockLineRange, blockLineIndex } = unit;
const { hunkLineRange, hunkKey, sameHunk, splitEditor } = unit;
const { fileOffset, fileLines, sameBlock, splitFile } = unit;
const { fileLineIndex, attachEditSpans, mergeEditRows } = unit;

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
  splitFile,
  splitEditor,
  itemsForPath,
  unitLines,
  sameBlock,
  sameHunk,
  hunkKey,
  blockLineRange,
  hunkLineRange,
  blockLineIndex,
  fileOffset,
  fileLines,
  fileLineIndex,
  attachEditSpans,
  mergeEditRows,
};
