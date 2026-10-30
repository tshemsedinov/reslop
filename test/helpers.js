'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { setTimeout: wait } = require('node:timers/promises');
const assert = require('node:assert/strict');

const clipboard = require('../lib/term/select.js');

process.env.GIT_TERMINAL_PROMPT = '0';
process.env.GCM_INTERACTIVE = 'Never';
process.env.GIT_CONFIG_NOSYSTEM = '1';
clipboard.useSystemTools(false);

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};

const RM_OPTIONS = {
  recursive: true,
  force: true,
  maxRetries: 10,
  retryDelay: 100,
};

const REPO_CONFIG = [
  '[user]',
  '\temail = test@example.com',
  '\tname = Test',
  '[commit]',
  '\tgpgsign = false',
  '[core]',
  '\tautocrlf = false',
  '\teol = lf',
  '',
].join('\n');

// One real init for the process. Copying it avoids a git process per test,
// which is most of the time on Windows.
let template = '';

// A pull or merge request diff: one changed hunk in two files
const CHANGE_DIFF = `diff --git a/lib/parser.js b/lib/parser.js
index 1111111..2222222 100644
--- a/lib/parser.js
+++ b/lib/parser.js
@@ -1,3 +1,4 @@
 keep
-old
+new
 keep
diff --git a/README.md b/README.md
index 1111111..2222222 100644
--- a/README.md
+++ b/README.md
@@ -1,1 +1,1 @@
-hello
+Hello
`;

const YES_NO = [
  ['y', 'y'],
  ['n', '/n'],
];

// The identity and the line ends of a repository: writing them is one
// process fewer for each, and starting a process is slow on Windows
const configureRepo = (dir) => {
  fs.appendFileSync(path.join(dir, '.git', 'config'), REPO_CONFIG);
};

const gitSync = (args, cwd, input) =>
  spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    input,
    env: gitEnv,
    windowsHide: true,
  });

const templateRepo = () => {
  if (template) return template;
  template = fs.mkdtempSync(path.join(os.tmpdir(), 'reslop-git-'));
  const init = gitSync(['init', '-b', 'main'], template);
  if (init.status !== 0) {
    const message = init.stderr || init.stdout || 'git init failed';
    throw new Error(message.trim());
  }
  configureRepo(template);
  return template;
};

const seedRepo = (dir) => {
  fs.mkdirSync(dir, { recursive: true });
  const from = path.join(templateRepo(), '.git');
  fs.cpSync(from, path.join(dir, '.git'), { recursive: true });
};

const gitIn = (cwd, args, input) => {
  const result = gitSync(args, cwd, input);
  if (result.status !== 0) {
    const message = result.stderr || result.stdout || 'git failed';
    throw new Error(message.trim());
  }
  return result.stdout;
};

const makeRepo = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reslop-'));
  seedRepo(dir);
  const git = (args, input) => gitIn(dir, args, input);
  const write = (rel, content) => {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  };
  const read = (rel) => fs.readFileSync(path.join(dir, rel), 'utf8');
  const exists = (rel) => fs.existsSync(path.join(dir, rel));
  const cleanup = () => fs.rmSync(dir, RM_OPTIONS);
  return { dir, git, write, read, exists, cleanup };
};

const sink = () => {
  let text = '';
  return {
    isTTY: false,
    columns: 80,
    rows: 24,
    write: (chunk) => {
      text += chunk;
      return true;
    },
    dump: () => text,
  };
};

const uiSink = () => {
  const stdout = sink();
  stdout.rows = 16;
  return stdout;
};

const tempDir = (prefix = 'reslop-') =>
  fs.mkdtempSync(path.join(os.tmpdir(), prefix));

const sampleHunk = (lines) => ({
  oldStart: 1,
  oldCount: 1,
  newStart: 1,
  newCount: 1,
  header: '@@ -1,1 +1,1 @@',
  lines,
});

const press = (ui, ...keys) => {
  for (const key of keys) ui.handleEvent({ type: 'key', key });
};

const click = (ui, x, y) => {
  const event = { type: 'mouse', button: 0, btn: 0, x, y };
  ui.handleEvent({ ...event, kind: 'press', press: true });
  ui.handleEvent({ ...event, kind: 'release', press: false });
};

// The menu opens on the press, so there is no release to send
const rightClick = (ui, x, y) => {
  const event = { type: 'mouse', button: 2, btn: 2, x, y };
  ui.handleEvent({ ...event, kind: 'press', press: true });
  ui.draw();
};

const waitUntil = async (check, ms = 4000) => {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (check()) return true;
    await wait(25);
  }
  return false;
};

const fakeProc = (cwd, extra = {}) => {
  const stdout = sink();
  const stderr = sink();
  return {
    argv: extra.argv ?? ['node', 'reslop'],
    cwd: () => cwd,
    stdin: { isTTY: extra.tty ?? false },
    stdout,
    stderr,
    env: extra.env ?? {},
    stdoutText: () => stdout.dump(),
    stderrText: () => stderr.dump(),
  };
};

// A session on a real repository, opened the way the cli opens one
const openRepoSession = async (cwd, extra = {}) => {
  const { Session } = require('../lib/session/session.js');
  const { createGitRepo } = require('../lib/git/git.js');
  const ui = new Session({
    cwd,
    stdout: uiSink(),
    repo: createGitRepo(),
    color: false,
    startPane: 'dashboard',
    ...extra,
  });
  await ui.ensureRepo();
  await ui.load();
  return ui;
};

// Stops what a loaded session keeps running, so the test can exit
const stopSession = (session) => {
  session.loader.abort();
  session.lifecycle.stopWatch();
  session.dashboard.stop();
  session.workspace.stop();
  session.progress.clear();
  session.term.clearTimers();
};

const jsonResponse = (status, body, headers = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers,
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
});

const removeTree = (dir) => fs.promises.rm(dir, RM_OPTIONS);

const reviewView = (item, extra = {}) => ({
  item,
  index: 0,
  total: 1,
  scroll: 0,
  status: '',
  counts: { staged: 0, unstaged: 1, untracked: 0 },
  repoName: 'demo',
  ...extra,
});

const sessionFor = (dir) =>
  openRepoSession(dir, { stdout: sink(), startPane: 'diff' });

const openDashboard = async (rows = 40, columns = 120) => {
  const { Session } = require('../lib/session/session.js');
  const { createGitRepo } = require('../lib/git/git.js');
  const repo = makeRepo();
  repo.write('lib/a.js', 'one\ntwo\n');
  repo.write('package.json', '{"name":"demo","scripts":{"test":"true"}}');
  repo.git(['add', '.']);
  repo.git(['commit', '-m', 'first commit']);
  repo.write('lib/a.js', 'one\ntwo\nthree\n');
  const stdout = { isTTY: false, columns, rows, write: () => true };
  const ui = new Session({
    cwd: repo.dir,
    stdout,
    repo: createGitRepo(),
    color: false,
    startPane: 'dashboard',
  });
  await ui.ensureRepo();
  await ui.loadReady();
  ui.uiOpen = true;
  ui.lifecycle.startWatch();
  ui.dashboard.start();
  const close = async () => {
    ui.lifecycle.stopWatch();
    ui.dashboard.stop();
    await removeTree(repo.dir);
  };
  return { ui, repo, close };
};

const frameText = (ui) => {
  const { stripAnsi } = require('../lib/term/ansi.js');
  ui.draw();
  return stripAnsi(ui.lastFrame.rows.join('\n'));
};

const labels = (...texts) => texts.map((text) => ({ type: 'label', text }));

// A y/n style prompt on the status line: its text, one warn color and one
// hit per choice, as [id, label] pairs
const assertPrompt = (view, text, choices) => {
  const { renderFrame } = require('../lib/render/render.js');
  const { THEME, fg, bg, stripAnsi } = require('../lib/term/ansi.js');
  const frame = renderFrame(view, { width: 80, height: 16, color: true });
  const statusRow = frame.rows.at(-2);
  const plain = stripAnsi(statusRow);
  assert.ok(plain.startsWith(text), plain);
  assert.ok(statusRow.includes(fg(THEME.mutedFg)));
  assert.ok(statusRow.includes(bg(THEME.chromeBg)));
  const warns = statusRow.split(fg(THEME.warnFg)).length - 1;
  assert.equal(warns, choices.length);
  const hits = frame.statusHits.map((hit) => {
    assert.equal(hit.y, frame.rows.length - 1);
    return [hit.id, plain.slice(hit.x0, hit.x1).trim()];
  });
  assert.deepEqual(hits, choices);
  return { frame, statusRow, plain };
};

module.exports = {
  wait,
  CHANGE_DIFF,
  YES_NO,
  configureRepo,
  seedRepo,
  gitIn,
  makeRepo,
  sink,
  uiSink,
  tempDir,
  sampleHunk,
  press,
  click,
  rightClick,
  waitUntil,
  fakeProc,
  openRepoSession,
  stopSession,
  jsonResponse,
  removeTree,
  reviewView,
  sessionFor,
  openDashboard,
  frameText,
  labels,
  assertPrompt,
};
