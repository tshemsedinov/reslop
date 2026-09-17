'use strict';

const { extractText, isRange } = require('../select.js');
const { hitAction } = require('../keys.js');

const mouseCell = (options, event) => {
  const size = options.getSize();
  const x = Math.min(Math.max(1, event.x), size.width);
  const y = Math.min(Math.max(1, event.y), size.height);
  return { x, y };
};

const onPress = (options, event) => {
  const nav = options.nav;
  const cell = mouseCell(options, event);
  nav.mouseAnchor = cell;
  nav.pendingClick = null;
  nav.selection = null;
  const frame = options.lastFrame();
  if (frame && cell.y === frame.height) {
    nav.pendingClick = hitAction(frame.buttons, cell.x - 1);
  }
};

const onDrag = (options, event) => {
  const nav = options.nav;
  if (!nav.mouseAnchor) return;
  nav.pendingClick = null;
  nav.selection = {
    start: nav.mouseAnchor,
    end: mouseCell(options, event),
  };
};

const clickButton = (options, cell, clickId) => {
  const nav = options.nav;
  const frame = options.lastFrame();
  if (!clickId || !frame || isRange(nav.selection)) return false;
  const id = hitAction(frame.buttons, cell.x - 1);
  if (id === clickId && cell.y === frame.height) {
    options.dispatch(id);
  }
  nav.selection = null;
  return true;
};

const clickHit = (options, hits, cell, onHit) => {
  const nav = options.nav;
  if (!hits || isRange(nav.selection)) return false;
  const x = cell.x - 1;
  const hit = hits.find((row) => {
    if (row.y !== cell.y) return false;
    if (row.x0 === undefined) return true;
    return x >= row.x0 && x < row.x1;
  });
  if (!hit) return false;
  onHit(options, hit);
  nav.selection = null;
  return true;
};

const copySelection = (options) => {
  const nav = options.nav;
  const frame = options.lastFrame();
  if (!isRange(nav.selection) || !frame) return;
  const text = extractText(frame.rows, nav.selection);
  if (!text) return;
  const ok = options.copyText(text, options.stdout());
  options.setStatus(ok ? 'copied' : 'copy failed');
};

const RELEASE_TARGETS = [
  {
    match: () => true,
    hits: 'statusHits',
    onHit: (options, hit) => {
      if (hit.id === 'branch') {
        options.onBranch();
        return;
      }
      options.confirmChoice(hit.id);
    },
  },
  {
    match: (options) => options.getPane() === 'files',
    hits: 'fileHits',
    onHit: (options, hit) => {
      options.nav.fileCursor = hit.cursor;
      options.onOpenFile();
    },
  },
  {
    match: (options) => options.getPane() === 'branches',
    hits: 'fileHits',
    onHit: (options, hit) => {
      options.nav.branchCursor = hit.cursor;
      options.onCheckoutBranch();
    },
  },
  {
    match: (options) => options.getPane() === 'diff',
    hits: 'todoHits',
    onHit: (options, hit) => options.onTodoHit(hit.cursor),
  },
  {
    match: (options) => options.getMode() === 'compose',
    hits: 'templateHits',
    onHit: (options, hit) => options.selectTemplate(hit.cursor),
  },
];

const onRelease = (options, event) => {
  const nav = options.nav;
  const cell = mouseCell(options, event);
  if (nav.mouseAnchor) {
    nav.selection = { start: nav.mouseAnchor, end: cell };
  }
  const clickId = nav.pendingClick;
  nav.pendingClick = null;
  nav.mouseAnchor = null;
  if (clickButton(options, cell, clickId)) return;
  const frame = options.lastFrame();
  for (const target of RELEASE_TARGETS) {
    if (!target.match(options)) continue;
    const hits = frame?.[target.hits];
    const opened = clickHit(options, hits, cell, target.onHit);
    if (opened) return;
  }
  copySelection(options);
};

const handle = (options, event) => {
  const kind = event.kind;
  const wheel = kind === 'wheelUp' || kind === 'wheelDown';
  if (!wheel && event.btn !== 0 && event.btn !== undefined) return;
  if (kind === 'wheelUp') return void options.onScroll(-1);
  if (kind === 'wheelDown') return void options.onScroll(1);
  if (kind === 'press') return void onPress(options, event);
  if (kind === 'drag') return void onDrag(options, event);
  if (kind === 'release') return void onRelease(options, event);
};

const createPointer = (options) => ({
  handle: (event) => handle(options, event),
  mouseCell: (event) => mouseCell(options, event),
});

module.exports = { createPointer };
