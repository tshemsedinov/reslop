'use strict';

const { extractText, isRange } = require('../select.js');
const { hitAction } = require('../keys.js');

const mouseCell = (api, event) => {
  const size = api.options.getSize();
  const x = Math.min(Math.max(1, event.x), size.width);
  const y = Math.min(Math.max(1, event.y), size.height);
  return { x, y };
};

const onPress = (api, event) => {
  const nav = api.options.nav;
  const cell = mouseCell(api, event);
  nav.mouseAnchor = cell;
  nav.pendingClick = null;
  nav.selection = null;
  const frame = api.options.lastFrame();
  if (frame && cell.y === frame.height) {
    nav.pendingClick = hitAction(frame.buttons, cell.x - 1);
  }
};

const onDrag = (api, event) => {
  const nav = api.options.nav;
  if (!nav.mouseAnchor) return;
  nav.pendingClick = null;
  nav.selection = {
    start: nav.mouseAnchor,
    end: mouseCell(api, event),
  };
};

const clickButton = (api, cell, clickId) => {
  const nav = api.options.nav;
  const frame = api.options.lastFrame();
  if (!clickId || !frame || isRange(nav.selection)) return false;
  const id = hitAction(frame.buttons, cell.x - 1);
  if (id === clickId && cell.y === frame.height) {
    api.options.dispatch(id);
  }
  nav.selection = null;
  return true;
};

const clickHit = (api, hits, cell, onHit) => {
  const nav = api.options.nav;
  if (!hits || isRange(nav.selection)) return false;
  const x = cell.x - 1;
  const hit = hits.find((row) => {
    if (row.y !== cell.y) return false;
    if (row.x0 === undefined) return true;
    return x >= row.x0 && x < row.x1;
  });
  if (!hit) return false;
  onHit(hit);
  nav.selection = null;
  return true;
};

const copySelection = (api) => {
  const nav = api.options.nav;
  const frame = api.options.lastFrame();
  if (!isRange(nav.selection) || !frame) return;
  const text = extractText(frame.rows, nav.selection);
  if (!text) return;
  const ok = api.options.copyText(text, api.options.stdout());
  api.options.setStatus(ok ? 'copied' : 'copy failed');
};

const releaseHits = (api) => {
  const nav = api.options.nav;
  const { options } = api;
  return [
    {
      match: () => true,
      hits: (frame) => frame?.statusHits,
      onHit: () => options.onBranch(),
    },
    {
      match: () => options.getPane() === 'files',
      hits: (frame) => frame?.fileHits,
      onHit: (hit) => {
        nav.fileCursor = hit.cursor;
        options.onOpenFile();
      },
    },
    {
      match: () => options.getPane() === 'branches',
      hits: (frame) => frame?.fileHits,
      onHit: (hit) => {
        nav.branchCursor = hit.cursor;
        options.onCheckoutBranch();
      },
    },
    {
      match: () => options.getPane() === 'diff',
      hits: (frame) => frame?.todoHits,
      onHit: (hit) => options.onTodoHit(hit.cursor),
    },
    {
      match: () => options.getMode() === 'compose',
      hits: (frame) => frame?.templateHits,
      onHit: (hit) => options.selectTemplate(hit.cursor),
    },
  ];
};

const onRelease = (api, event) => {
  const nav = api.options.nav;
  const cell = mouseCell(api, event);
  if (nav.mouseAnchor) {
    nav.selection = { start: nav.mouseAnchor, end: cell };
  }
  const clickId = nav.pendingClick;
  nav.pendingClick = null;
  nav.mouseAnchor = null;
  if (clickButton(api, cell, clickId)) return;
  const frame = api.options.lastFrame();
  for (const target of releaseHits(api)) {
    if (!target.match()) continue;
    const hits = target.hits(frame);
    const opened = clickHit(api, hits, cell, (hit) => {
      target.onHit(hit);
    });
    if (opened) return;
  }
  copySelection(api);
};

const handle = (api, event) => {
  const kind = event.kind;
  const wheel = kind === 'wheelUp' || kind === 'wheelDown';
  if (!wheel && event.btn !== 0 && event.btn !== undefined) return;
  if (kind === 'wheelUp') return void api.options.onScroll(-1);
  if (kind === 'wheelDown') return void api.options.onScroll(1);
  if (kind === 'press') return void onPress(api, event);
  if (kind === 'drag') return void onDrag(api, event);
  if (kind === 'release') return void onRelease(api, event);
};

const createPointer = (options) => {
  const api = { options };
  return {
    handle: (event) => handle(api, event),
    mouseCell: (event) => mouseCell(api, event),
  };
};

module.exports = { createPointer };
