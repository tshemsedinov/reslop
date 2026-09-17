'use strict';

const contentLines = (content) => {
  if (content === '') return { lines: [], ended: false };
  const ended = content.endsWith('\n');
  const body = ended ? content.slice(0, -1) : content;
  return { lines: body.split('\n'), ended };
};

const joinLines = (lines, ended) => {
  const body = lines.join('\n');
  if (!ended) return body;
  if (!lines.length) return '\n';
  return `${body}\n`;
};

const addBlockRange = (hunk, blockId) => {
  let newLine = hunk.newStart;
  let start = 0;
  let count = 0;
  for (const line of hunk.lines) {
    if (line.type === 'del') {
      if (line.blockId === blockId && start === 0) start = newLine;
      continue;
    }
    if (line.type === 'add' && line.blockId === blockId) {
      if (count === 0) start = newLine;
      count += 1;
    }
    newLine += 1;
  }
  if (start === 0) start = hunk.newStart;
  return { start, count };
};

const replaceBlockAdds = (content, hunk, blockId, text) => {
  const range = addBlockRange(hunk, blockId);
  const parsed = contentLines(content);
  const last = parsed.lines.length;
  const from = Math.min(last, Math.max(0, range.start - 1));
  const added = text === '' ? [] : text.split('\n');
  const next = parsed.lines.slice();
  next.splice(from, range.count, ...added);
  return joinLines(next, parsed.ended);
};

module.exports = { addBlockRange, replaceBlockAdds };
