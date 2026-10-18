'use strict';

const { clamp, trimText } = require('../common/utilities.js');
const ansi = require('../term/ansi.js');
const { THEME, paint, visibleWidth, trimVisible, stampVisible } = ansi;
const primitives = require('./primitives.js');
const { scrollMark, editSpan } = primitives;
const { LIST_PAD, paintBodyFill, fill } = primitives;
const { paintCursorList, paneResult } = primitives;
const { seg } = require('./tiles.js');
const { dropBox, menuFaces } = require('./menu.js');
const table = require('./table.js');
const { waiting, notice, cell, cellSegs } = table;
const { tableLines, titleAside } = table;
const logPaint = require('./log.js');
const { LOG_PAD_X } = logPaint;
const { paintNpmLog, withLogScroller } = logPaint;
const { paintField, queryTones, fieldHit } = require('./field.js');
const { paintMarkedWord } = require('./footer.js');
const { wrapDoc, wrapMultiline, cursorInWrap } = require('../term/wrap.js');

const BUBBLE = '●';
const BUBBLE_GAP = 1;
const COLUMN_GAP = 2;
const PAD_W = 2;
const RUN_TAIL = 2;
const RUNS_SHARE = 0.3;
const RUNS_MIN = 16;
const LABEL_GAP = 2;
const BOX_MAX = 40;
const BOX_MIN = 4;
const PROGRESS_MAX = 26;
const TOGGLE_STATES = ['on', 'off'];
const FAST_W = TOGGLE_STATES.reduce((sum, state) => sum + state.length + 2, 0);
const TRACE = '─';
const READ_ONLY = ['text', 'status'];
const UNSET = 'default';
const INSTALL_LABEL = ' install ';
const INSTALL_KEY = 'i';
const TASK_HINT =
  'Text typed here goes to the agent before the plan. ' +
  'Enter starts the run, Shift+Enter adds a line.';

const LABELS = {
  agent: 'agent',
  auth: 'account',
  model: 'model',
  effort: 'effort',
  fast: 'fast mode',
  context: 'context',
  plan: 'plan',
  status: 'Status',
};

// The letter of a label that its key presses
const HOT_KEYS = {
  agent: 'a',
  model: 'm',
  effort: 'e',
  fast: 'o',
  context: 'x',
  plan: 'p',
};

const LABEL_W = Math.max(...Object.values(LABELS).map(visibleWidth));

const MENU_FIELDS = new Set(['agent', 'model', 'effort', 'context', 'plan']);

const padTrim = (text, width) => {
  const shown = trimVisible(`${text ?? ''}`, width);
  return shown + ' '.repeat(Math.max(0, width - visibleWidth(shown)));
};

const typedQuery = (search, field) => {
  if (!search || search.field !== field) return '';
  return `${search.query ?? ''}`;
};

const paintLabel = (field, text, color) => {
  const fgRgb = THEME.mutedFg;
  const bgRgb = THEME.ctxBg;
  const lead = ' '.repeat(Math.max(0, LABEL_W - visibleWidth(text)));
  let out = paint(lead, fgRgb, bgRgb, color);
  const hot = HOT_KEYS[field];
  const at = hot ? text.indexOf(hot) : -1;
  if (at < 0) return out + paint(text, fgRgb, bgRgb, color);
  out += paint(text.slice(0, at), fgRgb, bgRgb, color);
  out += paint(hot, THEME.buttonHotFg, bgRgb, color, true);
  return out + paint(text.slice(at + hot.length), fgRgb, bgRgb, color);
};

const boxTone = (selected) => ({
  fgRgb: selected ? THEME.popupFg : THEME.chromeFg,
  bgRgb: selected ? THEME.popupBg : THEME.noteBg,
});

// A combo box shows its value, and the typed query when open
const paintCombo = (spec, ctx) => {
  const { width, color } = ctx;
  const { fgRgb, bgRgb } = boxTone(spec.selected);
  const inner = Math.max(0, width - 2);
  const query = typedQuery(ctx.search, spec.field);
  let mid = paint(padTrim(spec.value, inner), fgRgb, bgRgb, color);
  if (query && ctx.search.editor) {
    ctx.search.editor.reveal(inner);
    const tones = queryTones(THEME.warnFg, bgRgb);
    mid = paintField(query, ctx.search.editor, inner, color, tones);
  }
  const edge = paint(' ', fgRgb, bgRgb, color);
  return edge + mid + edge;
};

// Both states show; the one that is set has the colors inverted
const paintToggle = (spec, ctx) => {
  const { fgRgb, bgRgb } = boxTone(spec.selected);
  let out = '';
  for (const state of TOGGLE_STATES) {
    const set = spec.value === state;
    const chipFg = set ? bgRgb : fgRgb;
    const chipBg = set ? fgRgb : bgRgb;
    out += paint(` ${state} `, chipFg, chipBg, ctx.color, set);
  }
  return out;
};

// Keep the plan progress compact even when the panel is wide
const paintProgress = (spec, ctx, room) => {
  const { color } = ctx;
  const text = `${spec.value ?? ''}`;
  const [done, total] = text.split('/').map(Number);
  const barW = Math.min(PROGRESS_MAX, room - visibleWidth(text) - 1);
  const { chromeFg, warnFg, heatTrack, ctxBg } = THEME;
  if (!total || barW < 1) {
    return paint(padTrim(text, room), chromeFg, ctxBg, color);
  }
  const on = Math.round(clamp(done / total, 0, 1) * barW);
  const rest = barW - on;
  let out = paint(`${text} `, chromeFg, ctxBg, color);
  out += paint(TRACE.repeat(on), warnFg, ctxBg, color);
  out += paint(TRACE.repeat(rest), heatTrack, ctxBg, color);
  const pad = room - visibleWidth(text) - 1 - barW;
  return out + fill(pad, chromeFg, ctxBg, color);
};

const STATE_W = 9;

// The status of the plan and its progress, a count and a line, in one row
const paintStatus = (spec, ctx, room) => {
  const { status = '', progress = '' } = spec.plan ?? {};
  const head = padTrim(status, Math.min(STATE_W, room));
  const left = Math.max(0, room - visibleWidth(head));
  const text = paint(head, THEME.chromeFg, THEME.ctxBg, ctx.color);
  return text + paintProgress({ value: progress }, ctx, left);
};

const paintInstall = (spec, ctx, room) => {
  const { color } = ctx;
  const selected = spec.selected;
  const mark = {
    bgRgb: selected ? THEME.popupBg : THEME.buttonBg,
    fgRgb: selected ? THEME.popupFg : THEME.buttonFg,
    hotFg: THEME.buttonHotFg,
    missFg: THEME.buttonHotFg,
    missBold: true,
  };
  const button = paintMarkedWord(INSTALL_LABEL, INSTALL_KEY, color, mark);
  const left = Math.max(0, room - visibleWidth(INSTALL_LABEL) - 1);
  const command = padTrim(spec.value, left);
  const gap = paint(' ', THEME.mutedFg, THEME.ctxBg, color);
  return button + gap + paint(command, THEME.mutedFg, THEME.ctxBg, color);
};

const AUTH_KEY = 'l';
const STATUS_W = 14;

const ACCOUNT_TEXT = {
  in: ['logged in', 'pkgDepFg'],
  out: ['not logged in', 'warnFg'],
  '': ['unknown', 'mutedFg'],
};

const BUSY_TEXT = {
  login: 'signing in…',
  logout: 'signing out…',
};

// The button of the account says what a press does
const accountButton = (account) => {
  if (account.busy) return '';
  if (account.state === 'in') return ' logout ';
  return account.state === 'out' ? ' login ' : '';
};

// Whether the agent is signed in, and the button that signs in or out
const paintAccount = (spec, ctx, room) => {
  const { color } = ctx;
  const account = spec.account ?? {};
  const known = ACCOUNT_TEXT[account.state ?? ''] ?? ACCOUNT_TEXT[''];
  const busy = [BUSY_TEXT[account.busy], 'warnFg'];
  // An agent that is still being asked is loading, not unknown
  const asked = ['loading…', 'mutedFg'];
  let [label, tone] = known;
  if (account.loading) [label, tone] = asked;
  if (account.busy) [label, tone] = busy;
  const shown = padTrim(label, Math.min(STATUS_W, room));
  let out = paint(shown, THEME[tone], THEME.ctxBg, color);
  const word = accountButton(account);
  const left = room - visibleWidth(shown);
  if (!word || left < visibleWidth(word)) {
    return out + paint(' '.repeat(left), THEME.ctxFg, THEME.ctxBg, color);
  }
  const selected = spec.selected;
  const mark = {
    bgRgb: selected ? THEME.popupBg : THEME.buttonBg,
    fgRgb: selected ? THEME.popupFg : THEME.buttonFg,
    hotFg: THEME.buttonHotFg,
    missFg: THEME.buttonHotFg,
    missBold: true,
  };
  out += paintMarkedWord(word, AUTH_KEY, color, mark);
  const rest = left - visibleWidth(word);
  return out + paint(' '.repeat(rest), THEME.ctxFg, THEME.ctxBg, color);
};

const paintText = (spec, ctx, room) => {
  const tone = spec.tone ?? THEME.chromeFg;
  return paint(padTrim(spec.value, room), tone, THEME.ctxBg, ctx.color);
};

const PLAIN_VALUE = { status: paintStatus, account: paintAccount };

// The value and the columns it takes of the room that is left of the label
const rowValue = (spec, ctx, room) => {
  const boxW = clamp(room, 0, BOX_MAX);
  if (spec.kind === 'install') {
    return { face: paintInstall(spec, ctx, room), used: room };
  }
  if (spec.kind === 'combo' && boxW >= BOX_MIN) {
    return { face: paintCombo(spec, { ...ctx, width: boxW }), used: boxW };
  }
  if (spec.kind === 'toggle' && room >= FAST_W) {
    return { face: paintToggle(spec, ctx), used: FAST_W };
  }
  if (!spec.label) return { face: paintText(spec, ctx, room), used: room };
  // Plain values start where the text of a combo box starts
  const lead = paint(' ', THEME.ctxFg, THEME.ctxBg, ctx.color);
  const inner = Math.max(0, room - 1);
  const paintOf = PLAIN_VALUE[spec.kind] ?? paintText;
  return { face: lead + paintOf(spec, ctx, inner), used: room };
};

const paintRow = (spec, ctx) => {
  const { color } = ctx;
  const bgRgb = THEME.ctxBg;
  const room = Math.max(0, ctx.width - PAD_W - LABEL_W - LABEL_GAP);
  const lead = paint(' '.repeat(PAD_W), THEME.ctxFg, bgRgb, color);
  const text = LABELS[spec.label] ?? '';
  const label = paintLabel(spec.field, text, color);
  const gap = paint(' '.repeat(LABEL_GAP), THEME.ctxFg, bgRgb, color);
  const { face, used } = rowValue(spec, ctx, room);
  const tail = fill(room - used, THEME.ctxFg, bgRgb, color);
  return lead + label + gap + face + tail;
};

const blankRow = (width, color) => paintBodyFill(width, color, 'files');

// A setting the agent or the model does not have is not shown
const settingRows = (row) => {
  const name = row ? row.name : '';
  const rows = [{ kind: 'combo', label: 'agent', field: 'agent', value: name }];
  if (!row || !row.bin) return rows;
  const efforts = row.efforts ?? [];
  const contexts = row.contexts ?? [];
  const fasts = row.fasts ?? [];
  const pickable = (list) => (list.length > 1 ? 'combo' : 'text');
  // A setting nobody chose shows the word for the default of the agent
  const shown = (list, value) => value || UNSET;
  rows.push({
    kind: 'combo',
    label: 'model',
    field: 'model',
    value: row.model || UNSET,
  });
  if (efforts.length) {
    const kind = pickable(efforts);
    const value = shown(efforts, row.effort);
    rows.push({ kind, label: 'effort', field: 'effort', value });
  }
  if (fasts.length > 1) {
    rows.push({
      kind: 'toggle',
      label: 'fast',
      field: 'fast',
      value: row.fast,
    });
  }
  if (contexts.length) {
    const kind = pickable(contexts);
    const value = shown(contexts, row.context);
    rows.push({ kind, label: 'context', field: 'context', value });
  }
  return rows;
};

const planRows = (view) => {
  const plan = view.agentPlan ?? {};
  return [
    { kind: 'combo', label: 'plan', field: 'plan', value: plan.name ?? '' },
    { kind: 'status', label: 'status', field: 'status', plan },
  ];
};

const installRows = (row, view) => {
  if (!row || row.bin) return [];
  const command = view.agentInstallCommand || row.hint || '';
  if (!row.installable) {
    return [{ kind: 'text', value: command, tone: THEME.warnFg }];
  }
  return [{ kind: 'install', field: 'install', value: command }];
};

const GAP = { kind: 'gap' };

const accountRows = (row, view) => {
  if (!row || !row.bin) return [];
  const account = view.agentAccount ?? {};
  return [{ kind: 'account', label: 'auth', field: 'auth', account }];
};

// An agent that is missing shows what installs it, one that is installed
// shows its account, in the same place under the settings
const panelSpecs = (row, view) => {
  const specs = [GAP, ...settingRows(row), GAP];
  const slot = [...installRows(row, view), ...accountRows(row, view)];
  if (slot.length) specs.push(...slot, GAP);
  specs.push(...planRows(view));
  return specs;
};

const windowStart = (focus, count, room) =>
  clamp(focus - room + 1, 0, Math.max(0, count - room));

const statusTone = (status) => {
  if (status === 'running') return THEME.warnFg;
  if (status === 'exit 0') return THEME.pkgDepFg;
  if (status === 'stopped' || `${status ?? ''}`.startsWith('exit')) {
    return THEME.errorFg;
  }
  return THEME.mutedFg;
};

const statusWidth = (rows) => {
  let width = 7;
  for (const row of rows) {
    width = Math.max(width, visibleWidth(row.status || ''));
  }
  return Math.min(10, width);
};

const buttonFill = (width, color) =>
  fill(width, THEME.chromeFg, THEME.buttonBg, color);

const paintRunRow = (row, width, color, selected, statusW) => {
  const bgRgb = selected ? THEME.checkBg : THEME.ctxBg;
  const fgRgb = THEME.chromeFg;
  const prefix = ' '.repeat(PAD_W);
  const tail = ' '.repeat(RUN_TAIL);
  if (row.empty || row.fresh || row.session) {
    const rest = Math.max(0, width - PAD_W - RUN_TAIL);
    const label = trimVisible(row.empty ? 'none' : row.name || '', rest);
    const pad = ' '.repeat(Math.max(0, rest - visibleWidth(label)));
    const line = `${prefix}${label}${pad}${tail}`;
    if (!color) {
      if (row.empty) return { row: line, hit: false };
      return { row: line };
    }
    const face = paint(line, fgRgb, bgRgb, color);
    if (row.empty) return { row: face, hit: false };
    return { row: face };
  }
  const budget = Math.max(0, width - PAD_W - RUN_TAIL);
  const statusRoom = Math.min(statusW, budget);
  const status = trimVisible(row.status || '', statusRoom);
  const statusPad = ' '.repeat(statusRoom - visibleWidth(status));
  let gap = '';
  let command = '';
  if (budget > statusRoom) {
    gap = ' ';
    const cmdW = budget - statusRoom - gap.length;
    const detail = [row.elapsed, row.progress, row.command]
      .filter(Boolean)
      .join(' ');
    const shown = trimVisible(detail, cmdW);
    command = `${shown}${' '.repeat(Math.max(0, cmdW - visibleWidth(shown)))}`;
  }
  const line = `${prefix}${status}${statusPad}${gap}${command}`;
  const pad = ' '.repeat(Math.max(0, width - RUN_TAIL - visibleWidth(line)));
  const text = `${line}${pad}${tail}`;
  if (!color) return { row: text };
  const tone = statusTone(row.status);
  let out = paint(prefix, fgRgb, bgRgb, color);
  out += paint(`${status}${statusPad}`, tone, bgRgb, color);
  out += paint(`${gap}${command}${pad}${tail}`, fgRgb, bgRgb, color);
  return { row: out };
};

const withRunScroller = (
  painted,
  count,
  start,
  bodyH,
  width,
  color,
  runCursor,
) => {
  const pad = bodyH >= LIST_PAD * 2 + 1 ? LIST_PAD : 0;
  const rows = Math.max(1, bodyH - pad * 2);
  const overflow = count > rows;
  const body = painted.body.map((line, index) => {
    const at = index - pad;
    const onText = at >= 0 && at < rows;
    let mark = '';
    if (overflow && onText) mark = scrollMark(at, count, rows, start);
    if (overflow && !onText) mark = 'track';
    const selected = onText && runCursor === start + at;
    // The scroller column is black like the list, not grey
    const rowBg = selected ? THEME.checkBg : THEME.ctxBg;
    return withLogScroller(line, mark, width, color, rowBg);
  });
  const fileHits = painted.fileHits;
  if (!overflow) return { ...painted, body, fileHits };
  const scrollBar = {
    col: width,
    row: 0,
    height: body.length,
    track: pad,
    rows,
    count,
    start,
  };
  return { ...painted, body, fileHits, scrollBar };
};

// The text box of the prompt takes the right panel, a row short of its edges
const paintPrompt = (view, ctx, rowsH) => {
  const { width, color, origin } = ctx;
  const boxW = width - 2;
  const textW = boxW - 2;
  const result = { rows: [], fileHits: [], editHits: [], cursor: null };
  const blank = fill(width, THEME.chromeFg, THEME.buttonBg, color);
  const room = rowsH - 2;
  if (room < 1 || textW < 1) {
    while (result.rows.length < rowsH) result.rows.push(blank);
    return result;
  }
  const editor = view.agentTask;
  const text = editor ? editor.text : '';
  const focused = ctx.field === 'task' && ctx.focus && !view.agentPick;
  // The text is on the color of the panel, typed or not
  const fgRgb = THEME.chromeFg;
  const bgRgb = THEME.buttonBg;
  const doc = wrapDoc(text, textW);
  const at = cursorInWrap(text, editor ? editor.cursor : 0, textW);
  const top = windowStart(at.row, doc.length, room);
  const hint = text ? [] : wrapMultiline(TASK_HINT, textW);
  const side = fill(1, THEME.chromeFg, THEME.buttonBg, color);
  result.rows.push(blank);
  for (let i = 0; i < room; i++) {
    const piece = doc[top + i];
    const muted = !text && hint[i] !== undefined;
    const shown = piece ? piece.text : '';
    const face = muted ? hint[i] : shown;
    const tone = muted ? THEME.mutedFg : fgRgb;
    const edge = paint(' ', tone, bgRgb, color);
    const mid = paint(padTrim(face, textW), tone, bgRgb, color);
    result.rows.push(side + edge + mid + edge + side);
    // A click below the text puts the caret at its end
    const under = piece ?? { start: text.length, text: '' };
    const textX = origin + 3;
    const span = editSpan(
      origin + 2,
      textX,
      textX + textW,
      under.start,
      under.text,
    );
    result.editHits.push({ row: 1 + i, ...span, editor });
    const y = ctx.headerLines + 1 + i + 1;
    result.fileHits.push({
      y,
      cursor: ctx.cursor,
      field: 'task',
      side: 'task',
    });
  }
  result.rows.push(blank);
  while (result.rows.length < rowsH) result.rows.push(blank);
  const inside = at.row >= top && at.row < top + room;
  if (focused && inside) {
    result.cursor = { x: origin + 3 + at.col, row: 1 + at.row - top };
  }
  return result;
};

// The sessions fill the left panel under the table
const paintSessions = (view, ctx, first, rowsH) => {
  const { width, color } = ctx;
  const runs = view.agentRuns ?? [];
  const fresh = { fresh: true, name: '<start new session>' };
  const runRows = runs.length ? runs : [fresh];
  const runCursor = view.agentRunCursor ?? 0;
  const runW = statusWidth(runs);
  const paintRun = (entry, selected) =>
    paintRunRow(entry, width, color, selected, runW);
  const pane = {
    width,
    color,
    bodyH: rowsH,
    headerLines: ctx.headerLines + first,
    offset: view.agentRunScroll ?? 0,
    blank: blankRow(width, color),
  };
  const list = paintCursorList(runRows, runCursor, pane, paintRun);
  while (list.body.length < rowsH) list.body.push(pane.blank);
  const hits = list.fileHits.map((hit) => ({ ...hit, side: 'runs' }));
  const scrolled = withRunScroller(
    { body: list.body, fileHits: hits },
    runRows.length,
    list.listScroll,
    rowsH,
    width,
    color,
    runCursor,
  );
  const bar = scrolled.scrollBar;
  const scrollBar = bar ? { ...bar, row: bar.row + first } : null;
  return { ...scrolled, scrollBar, runScroll: list.listScroll };
};

// Where a row can be clicked: a button covers its own cells, a box the row
const buttonOf = (spec) => {
  const x0 = PAD_W + LABEL_W + LABEL_GAP;
  if (spec.kind === 'install') {
    return { x0, x1: x0 + visibleWidth(INSTALL_LABEL) };
  }
  if (spec.kind === 'account') {
    const word = accountButton(spec.account ?? {});
    if (!word) return null;
    const from = x0 + 1 + STATUS_W;
    return { x0: from, x1: from + visibleWidth(word) };
  }
  return {};
};

const paintPanel = (view, width, color, bodyH, headerLines) => {
  const rows = view.agents ?? [];
  const cursor = view.agentCursor ?? 0;
  const row = rows[cursor] ?? null;
  const field = view.agentField ?? 'agent';
  const focus = view.agentFocus !== 'runs';
  let search = null;
  if (view.agentPick && view.agentQuery) {
    const query = view.agentQuery;
    search = { field: view.agentPick, query, editor: view.agentEditor };
  }
  const ctx = { width, color, field, focus, search, cursor, headerLines };
  const body = [];
  const fileHits = [];
  const rowOf = {};
  for (const spec of panelSpecs(row, view)) {
    if (body.length >= bodyH) break;
    if (spec.kind === 'gap') {
      body.push(blankRow(width, color));
      continue;
    }
    const selected = spec.field === field && focus;
    const painted = paintRow({ ...spec, selected }, ctx);
    if (spec.field) rowOf[spec.field] = body.length;
    const button = buttonOf(spec);
    if (spec.field && !READ_ONLY.includes(spec.kind) && button) {
      const y = headerLines + body.length + 1;
      const hit = { y, cursor, field: spec.field };
      if (button.x0 !== undefined) {
        hit.x0 = button.x0;
        hit.x1 = button.x1;
      }
      fileHits.push(hit);
    }
    body.push(painted);
  }
  const first = body.length;
  const sessions = paintSessions(view, ctx, first, Math.max(0, bodyH - first));
  body.push(...sessions.body);
  fileHits.push(...sessions.fileHits);
  const layout = { rowOf, valueX: PAD_W + LABEL_W + LABEL_GAP };
  return {
    ...paneResult({ body, fileHits }),
    scrollBar: sessions.scrollBar,
    runScroll: sessions.runScroll,
    layout,
  };
};

const overlayMenu = (painted, view, layout, width, color, headerLines) => {
  const options = view.agentMenu ?? [];
  const field = MENU_FIELDS.has(view.agentPick) ? view.agentPick : 'model';
  const rowAt = layout.rowOf[field];
  if (rowAt === undefined) return painted;
  const below = painted.body.length - rowAt - 1;
  const above = rowAt;
  const down = below >= above;
  const room = Math.max(1, down ? below : above);
  const cursor = view.agentPickCursor;
  const box = dropBox(options, cursor, view.agentMenuScroll, room);
  const off = new Set(view.agentMenuOff ?? []);
  // The list is as wide as the combo box it drops from
  const columnW = clamp(width - layout.valueX, 0, BOX_MAX);
  const x = layout.valueX;
  const boxW = columnW;
  const origin = down ? rowAt + 1 : Math.max(0, rowAt - box.span);
  const faces = menuFaces(options, box, boxW, color, view.agentQuery, off);
  const body = painted.body.slice();
  const fileHits = painted.fileHits.slice();
  for (let i = 0; i < faces.length && origin + i < body.length; i++) {
    const at = origin + i;
    body[at] = stampVisible(body[at], x, faces[i].face);
    const option = box.start + i;
    if (options[option] === undefined) continue;
    fileHits.unshift({
      y: headerLines + at + 1,
      cursor: option,
      x0: x,
      x1: x + boxW,
      field: 'menu',
    });
  }
  const editHits = painted.editHits.slice();
  // A click on the combo while no query is typed closes it
  if (view.agentEditor && view.agentQuery) {
    const hit = fieldHit(view.agentEditor, layout.valueX + 1, columnW - 2, 0);
    editHits.push({ ...hit, y: headerLines + rowAt + 1, row: rowAt });
  }
  return { ...painted, body, fileHits, editHits, menuScroll: box.start };
};

const chooserSplit = (width) => {
  const share = Math.floor(width * RUNS_SHARE);
  const rightW = clamp(share, Math.min(RUNS_MIN, width), width);
  return { leftW: Math.max(0, width - rightW), rightW };
};

// The table and the sessions on the left, the prompt on the right
const joinPanes = (left, right, width, color, bodyH) => {
  const { leftW, rightW } = chooserSplit(width);
  const blankL = paintBodyFill(leftW, color, 'files');
  const blankR = buttonFill(rightW, color);
  const count = Math.max(left.body.length, right.body.length, bodyH);
  const body = [];
  for (let i = 0; i < count; i++) {
    const sideL = left.body[i] ?? blankL;
    const sideR = right.body[i] ?? blankR;
    body.push(`${sideL}${sideR}`);
  }
  const place = (hits, origin, size, side) =>
    hits.map((hit) => ({
      ...hit,
      x0: (hit.x0 ?? 0) + origin,
      x1: (hit.x1 ?? size) + origin,
      side: hit.side ?? side,
    }));
  const fileHits = [
    ...place(left.fileHits, 0, leftW, 'cli'),
    ...place(right.fileHits, leftW, rightW, 'task'),
  ];
  return paneResult({
    body,
    fileHits,
    editHits: right.editHits,
    cursor: right.cursor,
    splitBody: true,
    listScroll: left.listScroll,
  });
};

const logBanner = (text, width, color, fgRgb) => {
  const inner = Math.max(1, width - LOG_PAD_X * 2);
  const shown = trimVisible(text, inner);
  const lead = ' '.repeat(clamp(width, 0, LOG_PAD_X));
  const pad = Math.max(0, width - lead.length - visibleWidth(shown));
  const line = `${lead}${shown}${' '.repeat(pad)}`;
  if (!color) return line;
  return paint(line, fgRgb, THEME.ctxBg, color);
};

const paintAgentLog = (view, width, color, bodyH) => {
  const head = [fill(width, THEME.ctxFg, THEME.ctxBg, color)];
  const command = trimText(view.agentCommand);
  if (command) head.push(logBanner(command, width, color, THEME.chromeFg));
  const summary = [view.agentStatus, view.agentElapsed, view.agentProgress]
    .filter(Boolean)
    .join('  ');
  if (summary) {
    head.push(logBanner(summary, width, color, statusTone(view.agentStatus)));
  }
  const logH = Math.max(0, bodyH - head.length);
  if (!logH) return paneResult({ body: head.slice(0, bodyH) });
  const log = paintNpmLog(
    {
      npmOutput: view.agentOutput,
      npmRunning: view.agentRunning,
      npmFollow: view.agentFollow,
      npmScroll: view.agentScroll,
      progressFrame: view.progressFrame,
      logScroller: true,
    },
    width,
    color,
    logH,
  );
  const bar = log.scrollBar;
  if (bar) log.scrollBar = { ...bar, row: bar.row + head.length };
  log.body.unshift(...head);
  return log;
};

const paintBodyAgents = (view, width, color, bodyH, headerLines) => {
  if (view.agentView) return paintAgentLog(view, width, color, bodyH);
  const { leftW, rightW } = chooserSplit(width);
  const panel = paintPanel(view, leftW, color, bodyH, headerLines);
  const field = view.agentField ?? 'agent';
  const focus = view.agentFocus !== 'runs';
  const cursor = view.agentCursor ?? 0;
  const ctx = { width: rightW, color, field, focus, cursor, headerLines };
  const prompt = paintPrompt(view, { ...ctx, origin: leftW }, bodyH);
  const joined = joinPanes(
    panel,
    { ...prompt, body: prompt.rows },
    width,
    color,
    bodyH,
  );
  const shown = { ...joined, scrollBar: panel.scrollBar };
  shown.runScroll = panel.runScroll;
  if (!view.agentMenu) return shown;
  return overlayMenu(shown, view, panel.layout, leftW, color, headerLines);
};

const runningTone = (tone, frame) =>
  Math.abs(frame ?? 0) % 2 ? 'muted' : tone;

// The last column clips its names when the tile is narrow
const agentCells = (item, frame, last) => {
  if (!item) return [];
  const live = item.running > 0;
  const statusTone = live ? runningTone('add', frame) : 'muted';
  const idleTone = item.bin ? 'text' : 'muted';
  const nameTone = live ? runningTone('sha', frame) : idleTone;
  const segs = [seg(item.name, nameTone)];
  if (live) segs.push(seg(` (${item.running})`, statusTone, true));
  const name = cellSegs(segs);
  name.flex = last;
  name.gap = BUBBLE_GAP;
  return [cell(BUBBLE, statusTone), name];
};

// Two columns while both fit their widest agent, else one
const columnCount = (items, width) => {
  let name = 0;
  for (const item of items) {
    const sessions = item.running ? ` (${item.running})` : '';
    name = Math.max(name, visibleWidth(`${item.name}${sessions}`));
  }
  const entry = visibleWidth(BUBBLE) + BUBBLE_GAP + name;
  return entry * 2 + COLUMN_GAP <= width ? 2 : 1;
};

// Agents fill the left column first
const agentsBlock = (model, width, height, ctx, tile) => {
  const data = model.agents;
  if (!data || !data.ready) return waiting('detecting agents…');
  const aside = [seg(`${data.running || 0}`, 'key', true)];
  const titleLine = titleAside(tile, aside, width);
  const items = data.items ?? [];
  if (!items.length) return notice('no agents', titleLine);
  const columns = columnCount(items, width);
  const perColumn = Math.ceil(items.length / columns);
  const count = Math.min(Math.max(0, height), perColumn);
  const rows = [];
  for (let i = 0; i < count; i++) {
    const left = agentCells(items[i], ctx.frame, columns === 1);
    if (columns === 1) {
      rows.push(left);
      continue;
    }
    const right = agentCells(items[i + count], ctx.frame, true);
    rows.push([...left, ...right]);
  }
  return { titleLine, lines: tableLines(rows, width, COLUMN_GAP) };
};

module.exports = { paintBodyAgents, agentsBlock };
