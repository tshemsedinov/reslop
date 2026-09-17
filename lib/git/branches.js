'use strict';

const { oneLine, requireOk, runGit, runGitAsync } = require('./run.js');

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

const lastMessage = (top) => {
  const result = runGit(['log', '-1', '--format=%B'], top);
  if (result.status !== 0) return '';
  return (result.stdout ?? '').replace(/\s+$/, '');
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
  const listed = [];
  for (const entry of branches) {
    const isDefault = entry.name === primary;
    listed.push({ ...entry, isDefault });
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

const rebaseFailed = (result) => {
  if (result.status === 0) return '';
  return result.stderr || result.stdout || 'rebase failed';
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
  if (kind === 'fixup') {
    const target = (message ?? '').trim() || 'HEAD';
    return { args: ['commit', `--fixup=${target}`], body: undefined };
  }
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
  listBranches,
  checkoutBranch,
  checkoutBranchAsync,
  createBranch,
  createBranchAsync,
  rebaseBranch,
  rebaseBranchAsync,
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
