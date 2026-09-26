'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { oneLine, requireOk, runGit, runGitAsync } = require('./git.js');

const BRANCH_FORMAT = [
  '%(HEAD)',
  '%(refname:short)',
  '%(objectname:short)',
  '%(committerdate:relative)',
  '%(upstream:track)',
  '%(subject)',
].join('%09');
const TRACK_AHEAD = /ahead (\d+)/;
const TRACK_BEHIND = /behind (\d+)/;
const ORIGIN_HEAD = 'refs/remotes/origin/HEAD';
const DEFAULT_BRANCHES = ['main', 'master'];
const PUSH_REJECTED = [
  'non-fast-forward',
  'failed to push some refs',
  'updates were rejected',
];

const commitMessage = (top, sha) => {
  const spec = `${sha ?? ''}`.trim() || 'HEAD';
  const result = runGit(['log', '-1', '--format=%B', spec], top);
  if (result.status !== 0) return '';
  return (result.stdout ?? '').replace(/\s+$/, '');
};

const lastMessage = (top) => commitMessage(top, 'HEAD');

const COMMIT_FIELDS = ['%H', '%h', '%an', '%ae', '%ar', '%ci', '%D', '%s'];
const COMMIT_FORMAT = `${COMMIT_FIELDS.join('%x1f')}%x1e%B`;
const COMMIT_LIMIT = 256;
const UNIT = '\x1f';
const RECORD = '\x1e';
const TAG_REF = /^tag: /;
const REMOTE_HEAD = /\/HEAD(?: -> |$)/;

const formatCommitRefs = (raw) => {
  const text = `${raw ?? ''}`.trim();
  if (!text) return '';
  const names = [];
  for (const part of text.split(', ')) {
    const name = part.trim();
    if (!name || TAG_REF.test(name)) continue;
    if (name !== 'HEAD' && REMOTE_HEAD.test(name)) continue;
    names.push(name);
  }
  return names.join(', ');
};

const parseCommitRecord = (record, index) => {
  const cut = record.indexOf(RECORD);
  if (cut < 0) return null;
  const parts = record.slice(0, cut).split(UNIT);
  if (parts.length < COMMIT_FIELDS.length) return null;
  const sha = (parts[0] ?? '').trim();
  if (!sha) return null;
  const body = record.slice(cut + 1).replace(/\s+$/, '');
  const read = (spec) => {
    const at = COMMIT_FIELDS.indexOf(spec);
    return (parts[at] ?? '').trim();
  };
  const subject = read('%s') || body.split('\n')[0].trim();
  return {
    sha,
    shortSha: read('%h') || sha.slice(0, 7),
    author: read('%an'),
    email: read('%ae'),
    date: read('%ar'),
    when: read('%ci'),
    refs: formatCommitRefs(read('%D')),
    subject,
    body,
    head: index === 0,
  };
};

const listCommits = (top) => {
  const args = [
    'log',
    '-z',
    `--format=${COMMIT_FORMAT}`,
    `--max-count=${COMMIT_LIMIT}`,
  ];
  const result = requireOk(runGit(args, top), 'log failed');
  const commits = [];
  for (const record of result.stdout.split('\0')) {
    if (!record) continue;
    const entry = parseCommitRecord(record, commits.length);
    if (entry) commits.push(entry);
  }
  return commits;
};

const namedCommit = (sha) => {
  const commit = `${sha ?? ''}`.trim();
  if (!commit) throw new Error('empty commit');
  return commit;
};

const resolveCommit = (top, sha) => {
  const result = requireOk(runGit(['rev-parse', sha], top), 'rev-parse failed');
  return (result.stdout ?? '').trim();
};

const dropHeadCommit = (top) => {
  requireOk(runGit(['reset', '--soft', 'HEAD~1'], top), 'drop failed');
};

const rebaseFailed = (result) => {
  if (result.status === 0) return '';
  return result.stderr || result.stdout || 'rebase failed';
};

const dropOlderCommit = (top, sha) => {
  const onto = `${sha}^`;
  const result = runGit(['rebase', '--onto', onto, sha], top);
  const failed = rebaseFailed(result);
  if (!failed) return;
  runGit(['rebase', '--abort'], top);
  throw new Error(oneLine(failed));
};

const dropOlderCommitAsync = async (top, sha) => {
  const onto = `${sha}^`;
  const result = await runGitAsync(['rebase', '--onto', onto, sha], top);
  const failed = rebaseFailed(result);
  if (!failed) return;
  await runGitAsync(['rebase', '--abort'], top);
  throw new Error(oneLine(failed));
};

const dropCommit = (top, sha) => {
  const spec = namedCommit(sha);
  const target = resolveCommit(top, spec);
  const parent = runGit(['rev-parse', '--verify', `${target}^`], top);
  if (parent.status !== 0) throw new Error('cannot drop root commit');
  const head = resolveCommit(top, 'HEAD');
  if (target === head) return void dropHeadCommit(top);
  dropOlderCommit(top, target);
};

const dropCommitAsync = async (top, sha) => {
  const spec = namedCommit(sha);
  const target = resolveCommit(top, spec);
  const parentArgs = ['rev-parse', '--verify', `${target}^`];
  const parent = await runGitAsync(parentArgs, top);
  if (parent.status !== 0) throw new Error('cannot drop root commit');
  const head = resolveCommit(top, 'HEAD');
  if (target === head) return void dropHeadCommit(top);
  await dropOlderCommitAsync(top, target);
};

const FIXUP_MARK = 'fixup!';
const AUTOSQUASH_ARGS = [
  '-c',
  'sequence.editor=:',
  'rebase',
  '--interactive',
  '--autosquash',
];

const isFixupSubject = (subject) =>
  `${subject ?? ''}`.trim().startsWith(FIXUP_MARK);

const fixupRest = (subject) => {
  let text = `${subject ?? ''}`.trim();
  while (text.startsWith(FIXUP_MARK)) {
    text = text.slice(FIXUP_MARK.length).trim();
  }
  return text;
};

const commitSubject = (top, sha) => {
  const args = ['log', '-1', '--format=%s', sha];
  const result = requireOk(runGit(args, top), 'log failed');
  return (result.stdout ?? '').trim();
};

const ancestorWithSubject = (top, sha, want) => {
  const args = ['log', '--format=%H%x1f%s', `${sha}^`];
  const result = runGit(args, top);
  if (result.status !== 0) return '';
  for (const line of result.stdout.split('\n')) {
    const cut = line.indexOf(UNIT);
    if (cut < 0) continue;
    const subject = line.slice(cut + 1).trim();
    if (subject !== want) continue;
    return line.slice(0, cut).trim();
  }
  return '';
};

const applyAutosquash = (top, ontoArgs) => {
  const result = runGit([...AUTOSQUASH_ARGS, ...ontoArgs], top);
  const failed = rebaseFailed(result);
  if (!failed) return;
  runGit(['rebase', '--abort'], top);
  throw new Error(oneLine(failed));
};

const applyAutosquashAsync = async (top, ontoArgs) => {
  const result = await runGitAsync([...AUTOSQUASH_ARGS, ...ontoArgs], top);
  const failed = rebaseFailed(result);
  if (!failed) return;
  await runGitAsync(['rebase', '--abort'], top);
  throw new Error(oneLine(failed));
};

const applyFixupOnto = (top, original, applyRange) => {
  const parent = runGit(['rev-parse', '--verify', `${original}^`], top);
  if (parent.status !== 0) return applyRange(top, ['--root']);
  return applyRange(top, [(parent.stdout ?? '').trim()]);
};

const applyFixup = (top, sha) => {
  const spec = namedCommit(sha);
  const commit = resolveCommit(top, spec);
  const subject = commitSubject(top, commit);
  if (!isFixupSubject(subject)) throw new Error('not a fixup commit');
  const want = fixupRest(subject);
  if (!want) throw new Error('no fixup target');
  const original = ancestorWithSubject(top, commit, want);
  if (!original) throw new Error('no fixup target');
  applyFixupOnto(top, original, applyAutosquash);
};

const applyFixupAsync = async (top, sha) => {
  const spec = namedCommit(sha);
  const commit = resolveCommit(top, spec);
  const subject = commitSubject(top, commit);
  if (!isFixupSubject(subject)) throw new Error('not a fixup commit');
  const want = fixupRest(subject);
  if (!want) throw new Error('no fixup target');
  const original = ancestorWithSubject(top, commit, want);
  if (!original) throw new Error('no fixup target');
  await applyFixupOnto(top, original, applyAutosquashAsync);
};

const messageBody = (message) => {
  const text = `${message ?? ''}`;
  return text.endsWith('\n') ? text : `${text}\n`;
};

const rewordHead = (top, message) => {
  const args = ['commit', '--amend', '--only', '-F', '-'];
  requireOk(runGit(args, top, messageBody(message)));
};

const REWORD_TODO = path.join(__dirname, 'git-reword-todo.js');

const prepareRewordEditor = (message) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reslop-reword-'));
  const msgFile = path.join(dir, 'MSG');
  fs.writeFileSync(msgFile, messageBody(message));
  const node = JSON.stringify(process.execPath);
  const script = JSON.stringify(REWORD_TODO);
  return {
    dir,
    env: {
      GIT_SEQUENCE_EDITOR: `${node} ${script}`,
      RESLOP_REWORD_FILE: msgFile,
    },
  };
};

const rewordRange = (top, sha, env) => {
  const parent = runGit(['rev-parse', '--verify', `${sha}^`], top);
  const onto =
    parent.status !== 0 ? ['--root'] : [(parent.stdout ?? '').trim()];
  return runGit(['rebase', '--interactive', ...onto], top, undefined, { env });
};

const rewordRangeAsync = async (top, sha, env) => {
  const parent = runGit(['rev-parse', '--verify', `${sha}^`], top);
  const onto =
    parent.status !== 0 ? ['--root'] : [(parent.stdout ?? '').trim()];
  return runGitAsync(['rebase', '--interactive', ...onto], top, { env });
};

const finishRewordRebase = (top, result) => {
  const failed = rebaseFailed(result);
  if (!failed) return;
  runGit(['rebase', '--abort'], top);
  throw new Error(oneLine(failed));
};

const rewordOlder = (top, sha, message) => {
  const prepared = prepareRewordEditor(message);
  try {
    const result = rewordRange(top, sha, prepared.env);
    finishRewordRebase(top, result);
  } finally {
    fs.rmSync(prepared.dir, { recursive: true, force: true });
  }
};

const rewordOlderAsync = async (top, sha, message) => {
  const prepared = prepareRewordEditor(message);
  try {
    const result = await rewordRangeAsync(top, sha, prepared.env);
    const failed = rebaseFailed(result);
    if (!failed) return;
    await runGitAsync(['rebase', '--abort'], top);
    throw new Error(oneLine(failed));
  } finally {
    fs.rmSync(prepared.dir, { recursive: true, force: true });
  }
};

const rewordCommit = (top, sha, message) => {
  const spec = namedCommit(sha);
  const commit = resolveCommit(top, spec);
  const head = resolveCommit(top, 'HEAD');
  if (commit === head) return void rewordHead(top, message);
  rewordOlder(top, commit, message);
};

const rewordCommitAsync = async (top, sha, message) => {
  const spec = namedCommit(sha);
  const commit = resolveCommit(top, spec);
  const head = resolveCommit(top, 'HEAD');
  if (commit === head) return void rewordHead(top, message);
  await rewordOlderAsync(top, commit, message);
};

const parseTrack = (text) => {
  const raw = `${text ?? ''}`.trim().replace(/^\[|\]$/g, '');
  if (!raw) return { ahead: 0, behind: 0, gone: false };
  if (raw === 'gone') return { ahead: 0, behind: 0, gone: true };
  const aheadMatch = TRACK_AHEAD.exec(raw);
  const behindMatch = TRACK_BEHIND.exec(raw);
  const ahead = aheadMatch ? Number(aheadMatch[1]) : 0;
  const behind = behindMatch ? Number(behindMatch[1]) : 0;
  return { ahead, behind, gone: false };
};

const parseBranchLine = (line) => {
  const parts = line.split('\t');
  if (parts.length < 2) return null;
  const name = (parts[1] ?? '').trim();
  if (!name) return null;
  const mark = parts[0] ?? '';
  const sha = (parts[2] ?? '').trim();
  const date = (parts[3] ?? '').trim();
  const track = parseTrack(parts[4]);
  const subject = parts.slice(5).join('\t').trim();
  return {
    name,
    current: mark.includes('*'),
    isDefault: false,
    sha,
    date,
    subject,
    ...track,
  };
};

const originHead = (top) => {
  const args = ['symbolic-ref', '--short', ORIGIN_HEAD];
  const result = runGit(args, top);
  if (result.status !== 0) return '';
  const ref = result.stdout.trim();
  const prefix = 'origin/';
  if (ref.startsWith(prefix)) return ref.slice(prefix.length);
  return ref;
};

const defaultBranch = (top, names) => {
  const remote = originHead(top);
  if (names.has(remote)) return remote;
  for (const name of DEFAULT_BRANCHES) {
    if (names.has(name)) return name;
  }
  return '';
};

const listBranches = (top) => {
  const args = ['for-each-ref', `--format=${BRANCH_FORMAT}`, 'refs/heads'];
  const result = requireOk(runGit(args, top), 'branch failed');
  const branches = [];
  for (const line of result.stdout.split('\n')) {
    if (!line) continue;
    const entry = parseBranchLine(line);
    if (entry) branches.push(entry);
  }
  const names = new Set();
  for (const entry of branches) names.add(entry.name);
  const primary = defaultBranch(top, names);
  const { length } = branches;
  const listed = new Array(length);
  for (let i = 0; i < length; i++) {
    const entry = branches[i];
    listed[i] = { ...entry, isDefault: entry.name === primary };
  }
  return listed;
};

const namedBranch = (name) => {
  const branch = `${name ?? ''}`.trim();
  if (!branch) throw new Error('empty branch name');
  return branch;
};

const checkoutBranch = (top, name) => {
  const branch = namedBranch(name);
  requireOk(runGit(['checkout', branch], top), 'checkout failed');
};

const checkoutBranchAsync = async (top, name) => {
  const branch = namedBranch(name);
  requireOk(await runGitAsync(['checkout', branch], top), 'checkout failed');
};

const createBranch = (top, name) => {
  const branch = namedBranch(name);
  const args = ['checkout', '-b', branch];
  requireOk(runGit(args, top), 'checkout failed');
};

const createBranchAsync = async (top, name) => {
  const branch = namedBranch(name);
  const args = ['checkout', '-b', branch];
  requireOk(await runGitAsync(args, top), 'checkout failed');
};

const rebaseBranch = (top, onto) => {
  const branch = namedBranch(onto);
  const result = runGit(['rebase', branch], top);
  const failed = rebaseFailed(result);
  if (!failed) return;
  runGit(['rebase', '--abort'], top);
  throw new Error(oneLine(failed));
};

const rebaseBranchAsync = async (top, onto) => {
  const branch = namedBranch(onto);
  const result = await runGitAsync(['rebase', branch], top);
  const failed = rebaseFailed(result);
  if (!failed) return;
  await runGitAsync(['rebase', '--abort'], top);
  throw new Error(oneLine(failed));
};

const dropBranch = (top, name) => {
  const branch = namedBranch(name);
  requireOk(runGit(['branch', '-D', branch], top), 'drop failed');
};

const dropBranchAsync = async (top, name) => {
  const branch = namedBranch(name);
  requireOk(await runGitAsync(['branch', '-D', branch], top), 'drop failed');
};

const pullChanges = (top) => {
  requireOk(runGit(['pull'], top), 'pull failed');
};

const pullChangesAsync = async (top) => {
  requireOk(await runGitAsync(['pull'], top), 'pull failed');
};

const isRejectedPush = (msg) => {
  const text = `${msg ?? ''}`.toLowerCase();
  for (const token of PUSH_REJECTED) {
    if (text.includes(token)) return true;
  }
  return false;
};

const pushError = (msg) => {
  const text = `${msg ?? ''}`;
  const rejected = isRejectedPush(text);
  const error = new Error(rejected ? 'push rejected' : oneLine(text));
  error.rejected = rejected;
  return error;
};

const pushBranch = (top) => {
  const result = runGit(['rev-parse', '--abbrev-ref', 'HEAD'], top);
  const name = (result.stdout ?? '').trim();
  if (!name || name === 'HEAD') return 'HEAD';
  return name;
};

const hasUpstream = (top) => {
  const args = [
    'rev-parse',
    '--abbrev-ref',
    '--symbolic-full-name',
    '@{upstream}',
  ];
  const result = runGit(args, top);
  return result.status === 0;
};

const pushCmd = (force, branch) => {
  const args = ['push'];
  if (force) args.push('--force-with-lease');
  if (branch) args.push('--set-upstream', 'origin', branch);
  return args;
};

const noUpstream = (msg) =>
  `${msg ?? ''}`.toLowerCase().includes('no upstream');

const finishPush = (result, force, branch, run) => {
  if (result.status === 0) return;
  const msg = result.stderr || result.stdout || 'push failed';
  if (!noUpstream(msg)) throw pushError(msg);
  const next = run(pushCmd(force, branch));
  if (next.status !== 0) {
    throw pushError(next.stderr || next.stdout || 'push failed');
  }
};

const pushChanges = (top, force) => {
  const useForce = force === true;
  const branch = pushBranch(top);
  const tracked = hasUpstream(top) ? '' : branch;
  const result = runGit(pushCmd(useForce, tracked), top);
  finishPush(result, useForce, branch, (args) => runGit(args, top));
};

const pushChangesAsync = async (top, force) => {
  const useForce = force === true;
  const branch = pushBranch(top);
  const tracked = hasUpstream(top) ? '' : branch;
  const result = await runGitAsync(pushCmd(useForce, tracked), top);
  if (result.status === 0) return;
  const msg = result.stderr || result.stdout || 'push failed';
  if (!noUpstream(msg)) throw pushError(msg);
  const next = await runGitAsync(pushCmd(useForce, branch), top);
  if (next.status !== 0) {
    throw pushError(next.stderr || next.stdout || 'push failed');
  }
};

const hasStaged = (top) => {
  const result = runGit(['diff', '--cached', '--quiet'], top);
  return result.status === 1;
};

const commitPlan = (kind, message) => {
  const args = ['commit'];
  if (kind === 'amend') args.push('--amend');
  args.push('-F', '-');
  const text = message ?? '';
  const body = text.endsWith('\n') ? text : `${text}\n`;
  return { args, body };
};

const commitChanges = (top, kind, message) => {
  const plan = commitPlan(kind, message);
  requireOk(runGit(plan.args, top, plan.body));
};

const commitChangesAsync = async (top, kind, message) => {
  const plan = commitPlan(kind, message);
  requireOk(await runGitAsync(plan.args, top, { input: plan.body }));
};

module.exports = {
  lastMessage,
  commitMessage,
  listCommits,
  listBranches,
  checkoutBranch,
  checkoutBranchAsync,
  createBranch,
  createBranchAsync,
  rebaseBranch,
  rebaseBranchAsync,
  dropCommit,
  dropCommitAsync,
  applyFixup,
  applyFixupAsync,
  rewordCommit,
  rewordCommitAsync,
  dropBranch,
  dropBranchAsync,
  pullChanges,
  pullChangesAsync,
  pushChanges,
  pushChangesAsync,
  hasStaged,
  commitChanges,
  commitChangesAsync,
};
