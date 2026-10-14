'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

process.env.GIT_TERMINAL_PROMPT = '0';
process.env.GCM_INTERACTIVE = 'Never';
process.env.GIT_CONFIG_NOSYSTEM = '1';

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

const makeRepo = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reslop-'));
  seedRepo(dir);
  const git = (args, input) => {
    const result = gitSync(args, dir, input);
    if (result.status !== 0) {
      const msg = result.stderr || result.stdout || 'git failed';
      throw new Error(msg.trim());
    }
    return result.stdout;
  };
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
  makeRepo,
  seedRepo,
  configureRepo,
  sink,
  uiSink,
  tempDir,
  sampleHunk,
  reviewView,
  removeTree,
};
