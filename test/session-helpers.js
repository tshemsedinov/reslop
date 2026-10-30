'use strict';

const assert = require('node:assert/strict');

const { Session } = require('../lib/session/session.js');
const helpers = require('./helpers.js');
const { uiSink, sampleHunk, tempDir, press, click } = helpers;
const ansi = require('../lib/term/ansi.js');
const { stripAnsi } = ansi;
const { dateStamp } = require('../lib/common/utilities.js');

const rowOf = (session, text) =>
  session.composer.tasks.taskTexts().findIndex((label) => label.includes(text));

const focusedRow = (session) =>
  session.composer.tasks.taskTexts()[session.tasksFocus];

// Focus on a row of the tasks screen; the block in the editor is written
// back first, as moving the focus does
const focusTask = (session, at) => {
  session.composer.tasks.closeEditor();
  session.tasksFocus = at;
};

// Writes the edited task back and edits it again, as a move away and back
const saveTask = (session) => {
  session.composer.tasks.closeEditor();
  session.composer.tasks.settle();
};

// Page Down until a row has the focus, as many times as the list needs
const pageTo = (session, label) => {
  for (let at = 0; at < 10 && focusedRow(session) !== label; at++) {
    press(session, 'pageDown');
  }
};

// Types tasks one below another on the tasks screen; the focus stays on
// the last one, out of the editor until the next key
const typeTasks = (session, ...texts) => {
  session.dispatch('tasks');
  texts.forEach((text, at) => {
    if (at) press(session, 'insert');
    session.pushInput(text);
  });
  session.composer.tasks.closeEditor();
};

const today = () => dateStamp(new Date());

const sampleItem = (name, origin = 'unstaged') => ({
  origin,
  file: {
    oldPath: name,
    newPath: name,
    isNew: false,
    isDeleted: false,
    isBinary: false,
    preamble: [`diff --git a/${name} b/${name}`],
    hunks: [],
  },
  hunk: sampleHunk([
    { type: 'del', text: 'a', noNl: false, blockId: 0 },
    { type: 'add', text: 'b', noNl: false, blockId: 0 },
  ]),
  blockId: 0,
  patchAdd: 'add',
  patchRevert: 'rev',
});

const mockRepo = (initial, top) => {
  let items = [...initial];
  const added = [];
  const reverted = [];
  const unstageCalls = [];
  const commits = [];
  const commitDrops = [];
  const applyFixups = [];
  const updates = [];
  const rewords = [];
  const pulls = [];
  const pushes = [];
  const checkouts = [];
  const created = [];
  const rebases = [];
  const drops = [];
  const edited = [];
  const listed = [];
  const writes = [];
  const stagedPaths = [];
  const fileBodies = Object.create(null);
  const extraFiles = [];
  let commitList = [
    {
      sha: 'aaa1111aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      shortSha: 'aaa1111',
      author: 'Ada',
      date: '2 hours ago',
      subject: 'land the change',
    },
    {
      sha: 'bbb2222bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      shortSha: 'bbb2222',
      author: 'Bob',
      date: 'yesterday',
      subject: 'init',
    },
  ];
  return {
    added,
    reverted,
    unstageCalls,
    commits,
    pulls,
    pushes,
    checkouts,
    created,
    rebases,
    drops,
    edited,
    listed,
    writes,
    stagedPaths,
    fileBodies,
    extraFiles,
    commitDrops,
    applyFixups,
    updates,
    rewords,
    load: () => ({ top, items: [...items], branch: 'main' }),
    add: (top, item) => {
      added.push(item);
      items = items.filter((entry) => entry !== item);
    },
    unstage: (top, item) => {
      unstageCalls.push(item);
      items = items.filter((entry) => entry !== item);
    },
    revert: (top, item) => {
      reverted.push(item);
      items = items.filter((entry) => entry !== item);
    },
    revertFile: (top, rel, group) => {
      const targets = group && group.length ? group : [];
      for (const item of targets) {
        reverted.push(item);
        items = items.filter((entry) => entry !== item);
      }
    },
    commit: (top, kind, message) => {
      commits.push({ top, kind, message });
    },
    lastMessage: () => 'previous message',
    listBranches: () => {
      listed.push(true);
      return [
        { name: 'main', current: true },
        { name: 'feat', current: false },
      ];
    },
    checkout: (top, name) => checkouts.push(name),
    createBranch: (top, name) => created.push(name),
    rebase: (top, onto) => rebases.push(onto),
    drop: (top, name) => drops.push(name),
    listCommits: () =>
      commitList.map((entry, index) => ({ ...entry, head: index === 0 })),
    dropCommit: (top, sha) => {
      commitDrops.push(sha);
      commitList = commitList.filter((entry) => entry.sha !== sha);
    },
    applyFixup: (top, sha) => {
      applyFixups.push(sha);
      commitList = commitList.filter((entry) => entry.sha !== sha);
    },
    updateCommit: (top, sha) => {
      updates.push(sha);
    },
    commitMessage: (top, sha) => {
      const entry = commitList.find((item) => item.sha === sha);
      if (entry && entry.subject) return entry.subject;
      return 'previous message';
    },
    reword: (top, sha, message, options = {}) => {
      rewords.push(
        options.now ? { sha, message, now: true } : { sha, message },
      );
      commitList = commitList.map((entry) => {
        if (entry.sha !== sha) return entry;
        const subject = `${message}`.split('\n')[0];
        return { ...entry, subject };
      });
    },
    setCommits: (next) => {
      commitList = next;
    },
    pull: () => pulls.push(true),
    push: () => pushes.push(true),
    edit: (top, item, text) => {
      edited.push({ top, item, text });
    },
    listFiles: () => {
      const names = new Set(extraFiles);
      for (const item of items) names.add(item.file.newPath);
      return [...names].sort();
    },
    fileText: (top, rel) => {
      if (Object.hasOwn(fileBodies, rel)) return fileBodies[rel];
      return 'b\n';
    },
    writeFile: (top, rel, text) => {
      fileBodies[rel] = text;
      writes.push({ top, rel, text });
    },
    stagePath: (top, rel) => {
      stagedPaths.push(rel);
    },
  };
};

const openSession = async (items, extra = {}) => {
  const stdout = extra.stdout ?? uiSink();
  const cwd = extra.cwd ?? tempDir('reslop-ui-');
  const repo = extra.repo ?? mockRepo(items, cwd);
  const session = new Session({
    color: false,
    startPane: 'diff',
    ...extra,
    cwd,
    stdout,
    repo,
  });
  // The worktree tiles and npm outdated would start git and npm
  session.worktrees.refreshTrees = async () => {};
  session.dashboard.tasks.npm.request = () => {};
  session.dashboard.runNpm = async () => {};
  await session.load();
  return { session, repo, stdout, cwd };
};

const clickStatusChoice = (session, id) => {
  session.draw();
  const hit = session.lastFrame.statusHits.find((entry) => entry.id === id);
  assert.ok(hit);
  click(session, hit.x0 + 1, hit.y);
};

const clickFooter = (session, id) => {
  session.draw();
  const hit = session.lastFrame.buttons.find((entry) => entry.id === id);
  assert.ok(hit);
  const y = session.lastFrame.height;
  click(session, hit.x0 + 1, y);
};

const dragBetween = (session, start, end) => {
  const base = { type: 'mouse', btn: 0 };
  session.handleEvent({ ...base, kind: 'press', button: 0, ...start });
  session.handleEvent({ ...base, kind: 'drag', button: 32, ...end });
  session.handleEvent({ ...base, kind: 'release', button: 0, ...end });
};

const listCell = (session, cursor, last = false) => {
  session.draw();
  const hits = session.lastFrame.fileHits.filter(
    (hit) => !hit.tree && hit.cursor === cursor,
  );
  const hit = last ? hits.at(-1) : hits[0];
  assert.ok(hit);
  return { x: 5, y: hit.y };
};

const modifiedClick = (session, cell, button) => {
  const event = { type: 'mouse', button, btn: 0, ...cell };
  session.handleEvent({ ...event, kind: 'press' });
  session.draw();
  session.handleEvent({ ...event, kind: 'release' });
};

const shiftClick = (session, cell) => modifiedClick(session, cell, 4);

const ctrlClick = (session, cell) => modifiedClick(session, cell, 16);

const frameBody = (session) => {
  session.draw();
  const bodyH = session.lastFrame.bodyH;
  const rows = session.lastFrame.rows.slice(1, 1 + bodyH);
  return rows.map((row) => stripAnsi(row));
};

module.exports = {
  rowOf,
  focusedRow,
  focusTask,
  saveTask,
  pageTo,
  typeTasks,
  today,
  sampleItem,
  mockRepo,
  openSession,
  clickStatusChoice,
  clickFooter,
  dragBetween,
  listCell,
  modifiedClick,
  shiftClick,
  ctrlClick,
  frameBody,
};
