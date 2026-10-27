'use strict';

const { extractText, isRange } = require('../term/select.js');
const { scrollAtThumb, scrollThumb } = require('../render/primitives.js');
const editorPointer = require('./editor-pointer.js');
const { hitAt, offsetOf, focusField, beginEditDrag } = editorPointer;
const { moveEditDrag, TEXT_ACTIONS, textEditor, textDisabled } = editorPointer;
const { runTextAction } = editorPointer;
const filesPane = require('./files-pane.js');
const { hitAction } = require('../input/keys.js');
const inputActions = require('../input/actions.js');
const { actionLetter, disabledActions, isFixupCommit } = inputActions;
const { dimFooterActions, extraFooterActions } = require('../render/footer.js');
const { copyText } = require('../term/clipboard.js');
const { stopImport } = require('./prompts.js');
const { clamp } = require('../common/utilities.js');
const { COMBO_FIELDS } = require('../render/agents.js');
const { currentTarget } = require('./view.js');
const { startListPointer, moveListPointer } = require('./list-pointer.js');

const mouseCell = (ui, event) => {
  const size = ui.lastSize ?? ui.getSize();
  const x = Math.min(Math.max(1, event.x), size.width);
  const y = Math.min(Math.max(1, event.y), size.height);
  return { x, y };
};

const onLogBar = (bar, cell) => {
  if (!bar || cell.x !== bar.x) return false;
  const index = cell.y - bar.y;
  return index >= 0 && index < bar.height;
};

const logLocal = (bar, cell) => {
  const local = cell.y - bar.y - bar.track;
  if (local < 0) return 0;
  const last = bar.rows - 1;
  if (local > last) return last;
  return local;
};

const logGrab = (local, thumb) => {
  if (local <= thumb.at) return 0;
  const end = thumb.at + thumb.size - 1;
  if (local >= end) return thumb.size - 1;
  return local - thumb.at;
};

const moveLogBar = (ui, cell) => {
  const bar = ui.lastFrame && ui.lastFrame.scrollBar;
  const drag = ui.nav.scrollDrag;
  if (!bar || !drag) return;
  const top = logLocal(bar, cell) - drag.grab;
  const at = scrollAtThumb(top, drag.thumb);
  const panel = ui.pane === 'npm' ? ui.npm : ui.agents;
  if (panel.viewing) panel.placeLog(at);
  else panel.placeRuns(at);
};

const startLogDrag = (ui, cell) => {
  const bar = ui.lastFrame && ui.lastFrame.scrollBar;
  if (!onLogBar(bar, cell)) return false;
  const thumb = scrollThumb(bar.count, bar.rows, bar.start);
  if (!thumb) return false;
  const nav = ui.nav;
  const local = logLocal(bar, cell);
  nav.scrollDrag = { grab: logGrab(local, thumb), thumb };
  nav.mouseAnchor = null;
  nav.pendingClick = null;
  nav.selection = null;
  moveLogBar(ui, cell);
  return true;
};

const dismissImport = (ui, event) => {
  if (ui.mode !== 'import') return;
  const frame = ui.lastFrame;
  const cell = mouseCell(ui, event);
  const onField = frame && cell.y === frame.height - 1;
  if (onField) return;
  stopImport(ui);
};

const CONTEXT_ACTIONS = {
  repos: ['open', 'worktreeNew', 'worktreeDrop'],
  files: ['open', 'add', 'unstage', 'revert', 'ignore', 'code'],
  branch: [
    'open',
    'newBranch',
    'worktreeBranch',
    'rebase',
    'drop',
    'pull',
    'push',
  ],
  tree: ['open', 'worktreeNew', 'worktreeDrop'],
  commits: ['open', 'apply', 'reword', 'drop', 'view'],
  packages: ['packageNew', 'packageDrop', 'packageWanted', 'packageLatest'],
  npm: ['open', 'npmEdit', 'npmDrop', 'npmLogs'],
  npmRuns: ['open'],
  agents: ['open', 'agentFast', 'agentInstall', 'agentStart'],
  agentRuns: ['open', 'agentStart'],
  tasks: ['open', 'check', 'import', 'drop'],
};

const EMPTY_ACTIONS = {
  repos: ['worktreeNew'],
  files: [],
  branches: ['newBranch', 'worktreeBranch', 'pull', 'push'],
  commits: ['newCommit', 'view', 'pull', 'push'],
  npm: ['npmNew', 'npmLogs'],
  packages: ['packageNew'],
  agents: [],
  tasks: ['import'],
};

const rowHit = (hits, cell) => {
  const x = cell.x - 1;
  return (hits ?? []).find((hit) => {
    if (hit.y !== cell.y) return false;
    if (hit.x0 === undefined) return true;
    return x >= hit.x0 && x < hit.x1;
  });
};

const selectRow = (rows, name) => {
  const at = rows.rows.findIndex((row) => row.name === name);
  if (at >= 0) rows.cursor = at;
};

const selectBranchRow = (ui, hit) => {
  ui.nav.treeFocus = Boolean(hit.tree);
  if (!hit.tree) {
    ui.nav.branchCursor = hit.cursor;
    return CONTEXT_ACTIONS.branch;
  }
  selectRow(ui.trees, hit.cursor);
  return CONTEXT_ACTIONS.tree;
};

const selectNpmRow = (ui, hit) => {
  if (hit.side !== 'runs') {
    ui.nav.npmCursor = hit.cursor;
    ui.npm.focusCommands();
    return CONTEXT_ACTIONS.npm;
  }
  ui.npm.runCursor = hit.cursor;
  ui.npm.focusRuns();
  return CONTEXT_ACTIONS.npmRuns;
};

const selectAgentRow = (ui, hit) => {
  if (hit.side !== 'runs') {
    ui.agents.focusCli();
    ui.agents.selectField(hit.field);
    return CONTEXT_ACTIONS.agents;
  }
  ui.agents.runCursor = hit.cursor;
  ui.agents.focus = 'runs';
  return CONTEXT_ACTIONS.agentRuns;
};

// A right click selects the row under it and says which actions it has
const SELECT_ROW = {
  repos: (ui, hit) => {
    selectRow(ui.workspace, hit.cursor);
    return CONTEXT_ACTIONS.repos;
  },
  files: (ui, hit) => {
    ui.nav.fileCursor = hit.cursor;
    return CONTEXT_ACTIONS.files;
  },
  branches: selectBranchRow,
  commits: (ui, hit) => {
    ui.nav.commitCursor = hit.cursor;
    const entry = ui.commits.selected();
    const rowActions = CONTEXT_ACTIONS.commits;
    if (isFixupCommit(entry)) return rowActions;
    return rowActions.filter((id) => id !== 'apply');
  },
  packages: (ui, hit) => {
    ui.nav.packagesCursor = hit.cursor;
    return CONTEXT_ACTIONS.packages;
  },
  npm: selectNpmRow,
  agents: selectAgentRow,
  tasks: (ui, hit) => {
    ui.nav.tasksFocus = hit.cursor;
    return CONTEXT_ACTIONS.tasks;
  },
};

const selectContextRow = (ui, hit) => SELECT_ROW[ui.pane]?.(ui, hit) ?? [];

const BRANCH_WRITES = [
  'newBranch',
  'worktreeBranch',
  'worktreeNew',
  'worktreeDrop',
  'rebase',
  'drop',
  'pull',
  'push',
  'newCommit',
  'apply',
  'reword',
  'updateTime',
  'squash',
];

const CHANGE_WRITES = ['add', 'unstage', 'revert', 'ignore'];

// What a source that cannot change branches or files leaves out
const capabilityOff = (ui, actions) => {
  const pane = ui.pane;
  const off = [];
  if (!ui.capabilities.branches && pane !== 'tasks') {
    off.push(...BRANCH_WRITES);
    if (pane === 'branches') off.push('open');
  }
  if (!ui.capabilities.changes) {
    off.push(...CHANGE_WRITES);
    if (pane === 'files') off.push('code');
    const npmIds = (id) => id.startsWith('package') || id.startsWith('npm');
    off.push(...actions.filter(npmIds));
  }
  return off;
};

// The main worktree, the one in use and the one shown cannot be dropped
const worktreeOff = (ui) => {
  if (ui.pane !== 'repos' && !ui.worktrees.focused()) return [];
  const { trees, worktrees } = ui;
  const row = worktrees.selected();
  const shown = ui.pane === 'branches' && trees.currentIndex() === trees.cursor;
  const off = [];
  if (!row || row.main || worktrees.workingIn(row) || shown) {
    off.push('worktreeDrop');
  }
  if (!row || worktrees.busy) off.push('worktreeNew');
  return off;
};

const agentOff = (ui) => {
  const row = ui.agents.selected();
  const off = [];
  if (!row || !row.bin) off.push('agentFast');
  if (!row || row.bin || !row.installable) off.push('agentInstall');
  return off;
};

const taskOff = (ui) => {
  const row = ui.composer.tasks.rowAt(ui.nav.tasksFocus);
  return !row || row.draft ? ['drop', 'check'] : [];
};

const BRANCH_ONLY = ['open', 'worktreeBranch'];
const SCRIPT_ONLY = ['npmEdit', 'npmDrop'];
const isScript = (entry) => entry?.kind === 'script';

const PANE_OFF = {
  branches: (ui) => (ui.gitBranches.selected() ? [] : BRANCH_ONLY),
  npm: (ui) => (isScript(ui.npm.selected()) ? [] : SCRIPT_ONLY),
  agents: agentOff,
  tasks: taskOff,
};

const noneOff = () => [];

const contextDisabled = (ui, actions) => {
  const pane = ui.pane;
  const paneOff = PANE_OFF[pane] ?? noneOff;
  const batch = ui.nav.multiselect ? ['drop', 'updateTime', 'squash'] : [];
  const disabled = disabledActions(pane, currentTarget(ui));
  const off = new Set([
    ...disabled.filter((id) => !batch.includes(id)),
    ...dimFooterActions(ui.view()),
    ...capabilityOff(ui, actions),
    ...worktreeOff(ui),
    ...paneOff(ui),
  ]);
  return [...off].filter((id) => actions.includes(id));
};

const comboAt = (ui, cell) => {
  if (ui.agents.pick || ui.composer.tasks.planOpen) return true;
  const status = rowHit(ui.lastFrame?.statusHits, cell);
  if (status && ['plan', 'plan-item', 'branch'].includes(status.id)) {
    return true;
  }
  const hit = rowHit(ui.lastFrame?.fileHits, cell);
  return (
    ui.pane === 'agents' && hit && [...COMBO_FIELDS, 'menu'].includes(hit.field)
  );
};

const openContextMenu = (
  ui,
  cell,
  actions,
  disabled,
  editor,
  keepRange = false,
) => {
  const anchor = keepRange ? ui.nav.listAnchor : null;
  const picked = keepRange ? ui.nav.listPicked : null;
  ui.nav.clearSelection();
  ui.nav.listAnchor = anchor;
  ui.nav.listPicked = picked;
  const menu = { x: cell.x - 1, y: cell.y, actions, cursor: 0, disabled };
  ui.nav.contextMenu = editor ? { ...menu, editor } : menu;
  ui.paint();
};

const onContextPress = (ui, event) => {
  ui.nav.listDrag = null;
  const frame = ui.lastFrame;
  if (!frame) return;
  const cell = mouseCell(ui, event);
  ui.nav.contextMenu = null;
  if (ui.pane === 'dashboard' || comboAt(ui, cell)) return void ui.paint();
  const editor = textEditor(ui, cell);
  if (editor) {
    const hit = hitAt(frame.editHits ?? [], cell);
    if (ui.mode === 'compose' && (!hit || !focusField(ui, hit))) return;
    if (editor === ui.agents.task) ui.agents.focusTask();
    if (hit && !editor.hasSelect()) editor.place(offsetOf(hit, cell.x));
    const disabled = textDisabled(editor);
    return void openContextMenu(ui, cell, TEXT_ACTIONS, disabled, editor);
  }
  if (ui.mode !== 'review' || cell.y <= 1 || cell.y >= frame.height - 1) return;
  const hits = ui.pane === 'tasks' ? frame.taskHits : frame.fileHits;
  const hit = rowHit(hits, cell);
  if (!hit && ui.pane === 'branches') ui.nav.treeFocus = false;
  const keepRange =
    ui.nav.multiselect && ui.view().listSelection.includes(hit?.cursor);
  if (!keepRange) ui.nav.clearListPick();
  let actions = EMPTY_ACTIONS[ui.pane];
  if (keepRange) actions = extraFooterActions(ui.view());
  if (hit && !keepRange) actions = selectContextRow(ui, hit);
  if (!actions?.length) return void ui.paint();
  openContextMenu(
    ui,
    cell,
    actions,
    contextDisabled(ui, actions),
    null,
    keepRange,
  );
};

const MARK_KEY = { del: 'delete', ins: 'insert', space: ' ' };

const contextKey = (mark) => MARK_KEY[mark] ?? mark?.replace('+', '-');

const runContextAction = (ui, action) => {
  const menu = ui.nav.contextMenu;
  if (!menu || (menu.disabled ?? []).includes(action)) return;
  ui.nav.contextMenu = null;
  if (!runTextAction(ui, menu, action)) ui.dispatch(action);
  ui.paint();
};

const handleContextKey = (ui, key) => {
  const menu = ui.nav.contextMenu;
  if (!menu) return false;
  if (key === 'escape') {
    ui.nav.contextMenu = null;
    ui.paint();
    return true;
  }
  if (key === 'up' || key === 'down') {
    const delta = key === 'up' ? -1 : 1;
    const last = menu.actions.length - 1;
    menu.cursor = clamp(menu.cursor + delta, 0, last);
    ui.paint();
    return true;
  }
  let action = key === 'enter' ? menu.actions[menu.cursor] : null;
  if (!action) {
    action = menu.actions.find((id) => contextKey(actionLetter(id)) === key);
  }
  if (!action) return true;
  runContextAction(ui, action);
  return true;
};

const onPress = (ui, event) => {
  const nav = ui.nav;
  nav.listDrag = null;
  const cell = mouseCell(ui, event);
  if (nav.contextMenu) {
    const hit = rowHit(ui.lastFrame?.contextHits, cell);
    if (hit) return;
    nav.contextMenu = null;
  }
  dismissImport(ui, event);
  if (beginEditDrag(ui, cell, Boolean(event.button & 4))) return;
  if (startLogDrag(ui, cell)) return;
  if (startListPointer(ui, event, cell)) return;
  nav.scrollDrag = null;
  nav.mouseAnchor = cell;
  nav.pendingClick = null;
  nav.selection = null;
  const frame = ui.lastFrame;
  if (frame && cell.y === frame.height) {
    nav.pendingClick = hitAction(frame.buttons, cell.x - 1);
  }
};

const onDrag = (ui, event) => {
  const nav = ui.nav;
  const cell = mouseCell(ui, event);
  if (moveEditDrag(ui, cell)) return;
  if (nav.scrollDrag) return void moveLogBar(ui, cell);
  if (moveListPointer(ui, cell)) return;
  if (!nav.mouseAnchor) return;
  nav.pendingClick = null;
  nav.selection = {
    start: nav.mouseAnchor,
    end: cell,
  };
};

const clickButton = (ui, cell, clickId) => {
  const nav = ui.nav;
  const frame = ui.lastFrame;
  if (!clickId || !frame || isRange(nav.selection)) return false;
  const id = hitAction(frame.buttons, cell.x - 1);
  if (id === clickId && cell.y === frame.height) {
    ui.dispatch(id);
  }
  nav.selection = null;
  return true;
};

const DOUBLE_CLICK_MS = 500;

const armDoubleClick = (nav, pane, cursor) => {
  const now = Date.now();
  const prev = nav.lastClick;
  const again =
    prev !== null &&
    prev.pane === pane &&
    prev.cursor === cursor &&
    now - prev.at <= DOUBLE_CLICK_MS;
  nav.lastClick = { pane, cursor, at: now };
  return again;
};

const clickHit = (ui, hits, cell, onHit) => {
  const nav = ui.nav;
  if (!hits || isRange(nav.selection)) return false;
  const hit = rowHit(hits, cell);
  if (!hit) return false;
  onHit(ui, hit);
  nav.selection = null;
  return true;
};

const copySelection = (ui) => {
  const nav = ui.nav;
  const frame = ui.lastFrame;
  if (!isRange(nav.selection) || !frame) return;
  const text = extractText(frame.rows, nav.selection);
  if (!text) return;
  const ok = copyText(text, ui.stdout);
  ui.status = ok ? 'copied' : 'copy failed';
};

const onAgentRunHit = (ui, hit) => {
  ui.agents.focus = 'runs';
  ui.agents.runCursor = hit.cursor;
  const again = armDoubleClick(ui.nav, 'agent-runs', hit.cursor);
  if (!again || ui.mode !== 'review') return;
  const session = ui.agents.selectedSession();
  if (ui.agents.openRunRow(session)) return;
  ui.agents.start();
};

// What a click on a field that is not a combo box does
const FIELD_CLICK = {
  fast: (agents) => agents.toggleFast(),
  install: (agents) => agents.proposeInstall(),
  auth: (agents) => agents.proposeAuth(),
};

// A click on a field of the table selects it and does what the field offers
const onAgentHit = (ui, hit) => {
  if (hit.side === 'runs') return void onAgentRunHit(ui, hit);
  ui.agents.focusCli();
  ui.agents.selectField(hit.field);
  if (COMBO_FIELDS.includes(hit.field)) {
    return void ui.agents.openPick(hit.field);
  }
  FIELD_CLICK[hit.field]?.(ui.agents);
};

// A click on the status row: the branch, the plan combo or a prompt choice
const STATUS_CLICK = {
  branch: (ui) => ui.gitBranches.onBranch(),
  plan: (ui) => ui.composer.tasks.togglePlanMenu(),
  'plan-item': (ui, hit) => ui.composer.tasks.choosePlan(hit.cursor),
};

const chooseStatus = (ui, hit) => {
  if (ui.composer.tasks.planOpen) ui.composer.tasks.closePlanMenu();
  ui.confirmChoice(hit.id);
};

const RELEASE_TARGETS = [
  {
    match: () => true,
    hits: 'statusHits',
    onHit: (ui, hit) => (STATUS_CLICK[hit.id] ?? chooseStatus)(ui, hit),
  },
  {
    match: (ui) => ui.pane === 'dashboard',
    hits: 'fileHits',
    onHit: (ui, hit) => ui.dashboard.open(hit.cursor),
  },
  {
    match: (ui) => ui.pane === 'repos',
    hits: 'fileHits',
    onHit: (ui, hit) => {
      void ui.workspace.openAt(hit.cursor);
    },
  },
  {
    match: (ui) => ui.pane === 'files',
    hits: 'fileHits',
    onHit: (ui, hit) => {
      const again = armDoubleClick(ui.nav, 'files', hit.cursor);
      ui.nav.fileCursor = hit.cursor;
      if (again) filesPane.onOpenFile(ui);
    },
  },
  {
    match: (ui) => ui.pane === 'branches',
    hits: 'fileHits',
    onHit: (ui, hit) => {
      if (hit.tree) return void ui.worktrees.pickTile(hit.cursor);
      ui.nav.treeFocus = false;
      const again = armDoubleClick(ui.nav, 'branches', hit.cursor);
      ui.nav.clearListPick();
      ui.nav.branchCursor = hit.cursor;
      if (again) ui.gitBranches.onCheckoutBranch();
    },
  },
  {
    match: (ui) => ui.pane === 'commits',
    hits: 'fileHits',
    onHit: (ui, hit) => {
      if (ui.mode === 'compose') return;
      const again = armDoubleClick(ui.nav, 'commits', hit.cursor);
      ui.nav.clearListPick();
      ui.nav.commitCursor = hit.cursor;
      if (again) filesPane.onOpenFile(ui);
    },
  },
  {
    match: (ui) => ui.pane === 'packages',
    hits: 'fileHits',
    onHit: (ui, hit) => {
      ui.nav.clearListPick();
      ui.nav.packagesCursor = hit.cursor;
    },
  },
  {
    match: (ui) => ui.pane === 'agents',
    hits: 'fileHits',
    onHit: onAgentHit,
  },
  {
    match: (ui) => ui.pane === 'npm',
    hits: 'fileHits',
    onHit: (ui, hit) => {
      if (hit.side === 'runs') {
        ui.npm.runCursor = hit.cursor;
        ui.npm.focusRuns();
        const again = armDoubleClick(ui.nav, 'npm-runs', hit.cursor);
        if (again && ui.mode === 'review') ui.npm.run();
        return;
      }
      ui.npm.focusCommands();
      const again = armDoubleClick(ui.nav, 'npm', hit.cursor);
      ui.nav.npmCursor = hit.cursor;
      ui.npm.clampRuns();
      if (again && ui.mode === 'review') ui.npm.run();
    },
  },
  {
    match: (ui) => ui.pane === 'tasks',
    hits: 'taskHits',
    onHit: (ui, hit) => {
      if (hit.check) return void ui.composer.tasks.onTaskCheck(hit.cursor);
      ui.composer.tasks.onTaskHit(hit.cursor);
    },
  },
  {
    match: (ui) => ui.mode === 'compose',
    hits: 'templateHits',
    onHit: (ui, hit) => ui.selectTemplate(hit.cursor),
  },
];

const frameHits = (ui, accept) => (ui.lastFrame?.fileHits ?? []).filter(accept);

const switchAgentCombo = (ui, cell) => {
  const hits = frameHits(ui, (hit) => COMBO_FIELDS.includes(hit.field));
  return clickHit(ui, hits, cell, (ui, hit) => {
    const same =
      ui.agents.pick.field === hit.field && ui.nav.agentCursor === hit.cursor;
    if (same) {
      ui.agents.closePick();
      return;
    }
    ui.agents.dismissPick();
    ui.agents.focusCli();
    ui.nav.agentCursor = hit.cursor;
    ui.agents.openPick(hit.field);
    if (!ui.agents.pick) ui.paint();
  });
};

const releaseAgentMenu = (ui, cell) => {
  const hits = frameHits(ui, (hit) => hit.field === 'menu');
  const accept = (ui, hit) => ui.agents.acceptPick(hit.cursor);
  if (clickHit(ui, hits, cell, accept)) return;
  if (switchAgentCombo(ui, cell)) return;
  ui.agents.closePick();
};

const onRelease = (ui, event) => {
  const nav = ui.nav;
  const cell = mouseCell(ui, event);
  if (nav.contextMenu) {
    const hit = rowHit(ui.lastFrame?.contextHits, cell);
    if (hit) return void runContextAction(ui, hit.id);
    nav.contextMenu = null;
    ui.paint();
    return;
  }
  if (moveEditDrag(ui, cell, true)) return;
  if (moveListPointer(ui, cell, true)) return;
  dismissImport(ui, event);
  if (nav.scrollDrag) {
    moveLogBar(ui, cell);
    nav.scrollDrag = null;
    nav.mouseAnchor = null;
    nav.pendingClick = null;
    nav.selection = null;
    return;
  }
  if (nav.mouseAnchor) {
    nav.selection = { start: nav.mouseAnchor, end: cell };
  }
  const clickId = nav.pendingClick;
  nav.pendingClick = null;
  nav.mouseAnchor = null;
  if (clickButton(ui, cell, clickId)) return;
  if (ui.pane === 'agents' && ui.agents.pick) {
    return void releaseAgentMenu(ui, cell);
  }
  const frame = ui.lastFrame;
  for (const target of RELEASE_TARGETS) {
    if (!target.match(ui)) continue;
    const hits = frame?.[target.hits];
    const opened = clickHit(ui, hits, cell, target.onHit);
    if (opened) return;
  }
  copySelection(ui);
};

const POINTER_HANDLERS = {
  wheelUp: (ui) => filesPane.onScroll(ui, -1),
  wheelDown: (ui) => filesPane.onScroll(ui, 1),
  press: onPress,
  drag: onDrag,
  release: onRelease,
};

const handlePointer = (ui, event) => {
  const kind = event.kind;
  if (ui.nav.contextMenu && ['move', 'drag'].includes(kind)) {
    const hit = rowHit(ui.lastFrame?.contextHits, mouseCell(ui, event));
    if (hit && !hit.disabled && hit.cursor !== ui.nav.contextMenu.cursor) {
      ui.nav.contextMenu.cursor = hit.cursor;
      ui.paint();
    }
    return;
  }
  if (kind === 'move') return;
  if (kind === 'press' && event.btn === 2) {
    onContextPress(ui, event);
    return;
  }
  if (event.btn === 2) return;
  const handler = POINTER_HANDLERS[kind];
  if (!handler) return;
  const isWheel = kind === 'wheelUp' || kind === 'wheelDown';
  if (!isWheel && event.btn !== 0 && event.btn !== undefined) return;
  handler(ui, event);
};

module.exports = {
  handlePointer,
  handleContextKey,
};
