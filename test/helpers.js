'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { setTimeout: wait } = require('node:timers/promises');

const clipboard = require('../lib/term/clipboard.js');

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

// One real init for the process. Copying it avoids a git process per test,
// which is most of the time on Windows.
let template = '';
const templateRepo = () => {
  if (template) return template;
  template = fs.mkdtempSync(path.join(os.tmpdir(), 'reslop-git-'));
  const init = gitSync(['init', '-b', 'main'], template);
  if (init.status !== 0) {
    const msg = init.stderr || init.stdout || 'git init failed';
    throw new Error(msg.trim());
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
    const msg = result.stderr || result.stdout || 'git failed';
    throw new Error(msg.trim());
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

// The process object that loadSession and the cli read
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

const jsonResponse = (status, body, extraHeaders = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: extraHeaders,
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

module.exports = {
  gitIn,
  makeRepo,
  seedRepo,
  configureRepo,
  sink,
  uiSink,
  tempDir,
  sampleHunk,
  reviewView,
  removeTree,
  press,
  click,
  rightClick,
  wait,
  waitUntil,
  fakeProc,
  stopSession,
  openRepoSession,
  CHANGE_DIFF,
  jsonResponse,
};
