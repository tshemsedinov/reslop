'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');

const helpers = require('../helpers.js');
const { tempDir, press, click } = helpers;
const review = require('../../lib/review/review.js');
const { ReviewStore, serializeReview } = review;
const { parseReview } = review;
const ansi = require('../../lib/term/ansi.js');
const { stripAnsi } = ansi;
const { REVIEW_DIR } = require('../../lib/common/files.js');
const sessionHelpers = require('../session-helpers.js');
const { rowOf, focusedRow, saveTask, pageTo, typeTasks } = sessionHelpers;
const { today, sampleItem, mockRepo, openSession } = sessionHelpers;
const { clickStatusChoice, clickFooter } = sessionHelpers;

for (const sequence of [
  '\x1b[13;2u',
  '\x1b[13;5u',
  '\x1b[13;6u',
  '\x1b[27;2;13~',
  '\x1b[27;5;13~',
  '\x1b[27;6;13~',
]) {
  test(`fragmented ${JSON.stringify(sequence)} stays in the task`, async () => {
    const { session } = await openSession([sampleItem('a.js')]);
    session.dispatch('tasks');
    session.pushInput('beforeafter');
    saveTask(session);
    const editor = session.editor;
    editor.place(6);
    for (const byte of sequence) {
      session.pushInput(byte);
      assert.equal(session.mode, 'compose');
      assert.equal(session.editor, editor);
    }
    assert.equal(editor.text, 'before\nafter');
    saveTask(session);
    assert.equal(session.notes.tasks.length, 1);
    assert.equal(session.notes.tasks[0].text, 'before\nafter');
  });
}

const taskRows = (session) =>
  session.composer.tasks.taskTexts().filter((text) => /^\[[ xX]\] /.test(text));

const taskAt = (session, index) => {
  const labels = session.composer.tasks.taskTexts();
  const rows = labels.map((label, at) => (/^\[[ xX]\] /.test(label) ? at : -1));
  return rows.filter((at) => at >= 0)[index] ?? -1;
};

for (const pair of [
  ['kitty', '\x1b[13;2u', '\x1b[13;5u'],
  ['xterm', '\x1b[27;2;13~', '\x1b[27;5;13~'],
  ['line feed', '\n', '\n'],
]) {
  const name = pair[0];
  const shift = pair[1];
  const ctrl = pair[2];
  test(`${name} adds lines inside an existing task`, async () => {
    const { session } = await openSession([sampleItem('a.js')]);
    session.dispatch('tasks');
    session.pushInput('alphaomega');
    saveTask(session);
    const id = session.notes.tasks[0].id;
    const editor = session.editor;
    editor.place(5);
    session.pushInput(`${shift}middle`);
    session.autosave();
    assert.equal(session.editor, editor);
    assert.equal(session.mode, 'compose');
    assert.equal(session.notes.tasks.length, 1);
    assert.equal(session.notes.tasks[0].id, id);
    session.pushInput(`${ctrl}tail`);
    assert.equal(session.editor, editor);
    assert.equal(session.tasksFocus, taskAt(session, 0));
    saveTask(session);
    assert.equal(session.notes.tasks.length, 1);
    assert.equal(session.notes.tasks[0].text, 'alpha\nmiddle\ntailomega');
    const saved = fs.readFileSync(session.notes.reviewPath, 'utf8');
    assert.equal(parseReview(saved).tasks[0].text, 'alpha\nmiddle\ntailomega');
  });
}

test('import url closes when focus leaves the field', async () => {
  const { session } = await openSession([sampleItem('a.js')]);
  const begin = () => {
    session.dispatch('tasks');
    press(session, 'ctrl-i');
    session.pushInput('https://example.com');
    session.draw();
  };
  const closed = () => {
    assert.equal(session.view().import, null);
    assert.notEqual(session.mode, 'import');
    session.draw();
    const status = stripAnsi(session.lastFrame.rows.at(-2));
    assert.equal(status.startsWith(' url '), false);
  };
  begin();
  click(session, 4, session.lastFrame.height - 1);
  assert.equal(session.mode, 'import');
  assert.match(session.view().import.url, /example\.com/);
  const task = session.lastFrame.taskHits.find((hit) => hit.y);
  assert.ok(task);
  click(session, 2, task.y);
  closed();
  begin();
  press(session, 'ctrl-down');
  closed();
  begin();
  clickFooter(session, 'back');
  assert.notEqual(session.pane, 'tasks');
  closed();
});

test('tasks import asks for a url and applies the pull request', async () => {
  const { session } = await openSession([sampleItem('a.js')], {
    loadPullRequest: async () => ({
      imported: {
        blockTasks: [],
        tasks: [
          {
            file: 'pull request',
            text: '@bob review at github: add tests',
            done: false,
          },
        ],
      },
    }),
  });
  session.dispatch('tasks');
  press(session, 'ctrl-i');
  assert.equal(session.mode, 'import');
  session.draw();
  const asking = stripAnsi(session.lastFrame.rows.at(-2));
  assert.match(asking, /^ url /);
  session.pushInput('notaurl');
  press(session, 'enter');
  assert.notEqual(session.mode, 'import');
  assert.equal(session.status, 'bad url');
  press(session, 'ctrl-i');
  session.pushInput('https://github.com/acme/demo/pull/7');
  session.draw();
  const typed = stripAnsi(session.lastFrame.rows.at(-2));
  assert.match(typed, /github\.com\/acme\/demo\/pull\/7/);
  press(session, 'enter');
  await session.importPromise;
  assert.equal(session.status, 'imported');
  assert.equal(session.notes.tasks.length, 1);
  assert.match(session.notes.tasks[0].text, /add tests/);
});

test('an empty import url stays focused after backspace', async () => {
  const { session } = await openSession([sampleItem('a.js')]);
  session.dispatch('tasks');
  press(session, 'ctrl-i');
  session.pushInput('x');
  press(session, 'backspace');
  assert.equal(session.nav.import.url, '');
  press(session, 'backspace');
  assert.equal(session.mode, 'import');
  assert.equal(session.nav.import.url, '');
});

test('tasks import prefills an editable repository url', async () => {
  const item = sampleItem('a.js');
  const cwd = tempDir('reslop-ui-');
  const repo = mockRepo([item], cwd);
  const load = repo.load;
  repo.load = () => ({
    ...load(),
    repositoryUrl: 'https://github.com/acme/demo',
  });
  const { session } = await openSession([item], { cwd, repo });
  session.dispatch('tasks');
  press(session, 'ctrl-i');
  assert.equal(session.nav.import.url, 'https://github.com/acme/demo');
  session.pushInput('/issues/4');
  assert.equal(session.nav.import.url, 'https://github.com/acme/demo/issues/4');
});

test('tasks import accepts a github or gitlab issue url', async () => {
  const { session } = await openSession([sampleItem('a.js')], {
    loadGithubIssue: async () => ({
      imported: {
        blockTasks: [],
        tasks: [
          {
            file: 'issue',
            text: '@alice review at github: add the flag',
            done: false,
          },
        ],
      },
    }),
    loadGitlabIssue: async () => ({
      imported: {
        blockTasks: [],
        tasks: [
          {
            file: 'issue',
            text: '@bob review at gitlab: from gitlab',
            done: false,
          },
        ],
      },
    }),
  });
  session.dispatch('tasks');
  press(session, 'ctrl-i');
  session.pushInput('https://github.com/acme/demo/issues/4');
  press(session, 'enter');
  await session.importPromise;
  assert.equal(session.status, 'imported');
  assert.match(session.notes.tasks[0].text, /add the flag/);
  press(session, 'ctrl-i');
  session.pushInput('https://gitlab.com/acme/demo/-/issues/8');
  press(session, 'enter');
  await session.importPromise;
  assert.equal(session.notes.tasks.length, 2);
  assert.match(session.notes.tasks[1].text, /from gitlab/);
});

test('tasks import accepts a github or gitlab issue list', async () => {
  let githubTarget = null;
  let gitlabTarget = null;
  const { session } = await openSession([sampleItem('a.js')], {
    loadGithubIssue: async (issue) => {
      githubTarget = issue;
      return {
        imported: {
          blockTasks: [],
          tasks: [
            {
              file: 'issue',
              text: '@ScriptHound at github: line numbers',
              done: false,
            },
          ],
        },
      };
    },
    loadGitlabIssue: async (issue) => {
      gitlabTarget = issue;
      return {
        imported: {
          blockTasks: [],
          tasks: [
            {
              file: 'issue',
              text: '@bob at gitlab: from the list',
              done: false,
            },
          ],
        },
      };
    },
  });
  session.dispatch('tasks');
  press(session, 'ctrl-i');
  session.pushInput('https://github.com/tshemsedinov/reslop/issues');
  press(session, 'enter');
  await session.importPromise;
  assert.equal(session.status, 'imported');
  assert.deepEqual(githubTarget, {
    owner: 'tshemsedinov',
    repo: 'reslop',
    list: true,
  });
  assert.match(session.notes.tasks[0].text, /@ScriptHound at github:/);
  press(session, 'ctrl-i');
  session.pushInput('https://gitlab.com/acme/demo');
  press(session, 'enter');
  await session.importPromise;
  assert.equal(gitlabTarget.project, 'acme/demo');
  assert.equal(gitlabTarget.list, true);
  assert.match(session.notes.tasks[1].text, /@bob at gitlab:/);
});

test('todo edits in the list not the note line', async () => {
  const { session, stdout } = await openSession([sampleItem('a.js')]);
  stdout.rows = 24;
  session.dispatch('tasks');
  session.pushInput('in the list');
  session.draw();
  const body = stripAnsi(session.lastFrame.rows.join('\n'));
  assert.match(body, /\[ \] in the list/);
  assert.doesNotMatch(body, /Bug Reports and Fixes/);
  assert.doesNotMatch(body, /Security/);
  assert.equal(body.split('in the list').length - 1, 1);
  assert.equal(session.view().compose, null);
  assert.ok(session.view().taskEdit);
  const focus = session.tasksFocus;
  const hit = session.lastFrame.taskHits.find((row) => row.cursor === focus);
  assert.ok(hit);
  assert.equal(session.lastFrame.cursor.y, hit.y);
});

test('t from any file adds a repo todo and starts editing', async () => {
  const { session } = await openSession(
    [sampleItem('a.js'), sampleItem('b.js')],
    {
      startPane: 'files',
    },
  );
  session.dispatch('scrollDown');
  assert.equal(session.fileCursor, 1);
  session.dispatch('tasks');
  assert.equal(session.pane, 'tasks');
  assert.equal(session.current().origin, 'task');
  assert.equal(session.current().file.newPath, 'TODOs');
  assert.equal(session.mode, 'compose');
  assert.equal(session.composeKind, 'tasks');
  assert.equal(focusedRow(session), '[ ] ');
  assert.deepEqual(taskRows(session), ['[ ] ']);
  press(session, 'escape');
  session.dispatch('files');
  session.fileCursor = 0;
  session.dispatch('tasks');
  assert.equal(session.current().file.newPath, 'TODOs');
  assert.equal(session.mode, 'compose');
  assert.equal(session.editor.text, '');
});

test('t opens the repo todo page and lets you edit it', async () => {
  const a = sampleItem('a.js');
  const b = sampleItem('b.js');
  const { session } = await openSession([a, b]);
  const files = session.fileList();
  assert.equal(files[0].path, 'a.js');
  assert.equal(
    files.some((entry) => entry.kind === 'tasks'),
    false,
  );
  session.dispatch('tasks');
  assert.equal(session.pane, 'tasks');
  assert.equal(session.current().origin, 'task');
  assert.equal(session.current().file.newPath, 'TODOs');
  assert.equal(session.mode, 'compose');
  assert.equal(session.items[0].origin, 'unstaged');
  session.pushInput('rewrite loop');
  press(session, 'insert');
  assert.equal(session.items[0].file.newPath, 'a.js');
  assert.equal(session.items[1].file.newPath, 'b.js');
  assert.equal(session.current().origin, 'task');
  assert.deepEqual(taskRows(session), ['[ ] rewrite loop', '[ ] ']);
  assert.equal(session.view().total, 2);
  assert.equal(session.view().counts.tasks, 1);
  assert.equal(session.view().counts.feedback, 0);
  assert.equal(session.mode, 'compose');
  assert.equal(session.editor.text, '');
  assert.equal(session.composer.idleNoteText(), '');
  session.pushInput('add tests');
  press(session, 'up');
  assert.equal(session.editor.text, 'rewrite loop');
  assert.deepEqual(taskRows(session), ['[ ] rewrite loop', '[ ] add tests']);
  assert.equal(focusedRow(session), '[ ] rewrite loop');
  press(session, 'escape');
  assert.equal(session.pane, 'files');
  assert.equal(session.current().file.newPath, 'a.js');
});

test('an empty plan has a new task to type into', async () => {
  const { session } = await openSession([sampleItem('a.js')]);
  session.composer.tasks.openTasksPage();
  assert.deepEqual(session.composer.tasks.taskTexts(), ['Agent instructions']);
  session.pushInput('write tests');
  assert.equal(session.mode, 'compose');
  assert.equal(session.composeTaskId, null);
  press(session, 'insert');
  assert.deepEqual(session.composer.tasks.taskTexts(), [
    'Agent instructions',
    'Feature requests and Enhancements',
    '[ ] write tests',
    '[ ] ',
  ]);
  press(session, 'backspace');
  assert.equal(focusedRow(session), '[ ] write tests');
  assert.equal(session.editor.text, 'write tests');
});

test('the agent instructions open on focus to read and edit', async () => {
  const { session } = await openSession([sampleItem('a.js')]);
  session.composer.tasks.openTasksPage();
  session.draw();
  const plain = () => session.lastFrame.rows.map((row) => stripAnsi(row));
  const open = () =>
    session.composer.tasks
      .taskTexts()
      .some((row) => row.includes('Read the fields'));
  assert.equal(open(), false);
  press(session, 'up');
  session.draw();
  assert.equal(open(), true);
  assert.match(focusedRow(session), /^- A task with a quoted/);
  assert.equal(session.mode, 'compose');
  session.dispatch('home');
  assert.equal(focusedRow(session), 'Agent instructions');
  assert.equal(session.mode, 'review');
  press(session, 'down');
  assert.match(focusedRow(session), /^Work through unchecked/);
  assert.equal(session.mode, 'compose');
  session.pushInput(' Ask first.');
  press(session, 'up');
  const text = fs.readFileSync(session.notes.reviewPath, 'utf8');
  assert.match(text, /^Work through unchecked items\. Ask first\.$/m);
  press(session, 'tab');
  session.draw();
  assert.equal(open(), false);
  const peek = plain().filter((row) => row.includes('Work through unchecked'));
  assert.deepEqual(
    peek.map((row) => row.trim()),
    ['Work through unchecked items. Ask first.'],
  );
});

test('a click on a task edits it at once', async () => {
  const { session } = await openSession([sampleItem('a.js')]);
  session.dispatch('tasks');
  session.pushInput('first note');
  press(session, 'insert');
  session.pushInput('second note');
  press(session, 'up');
  const first = rowOf(session, 'first note');
  const second = rowOf(session, 'second note');
  assert.equal(session.tasksFocus, first);
  assert.equal(session.editor.text, 'first note');
  session.draw();
  const other = session.lastFrame.taskHits.find((row) => row.cursor === second);
  assert.ok(other);
  click(session, 8, other.y);
  assert.equal(session.tasksFocus, second);
  assert.equal(session.mode, 'compose');
  assert.equal(session.editor.text, 'second note');
});

test('alt+enter adds lines and escape saves and leaves', async () => {
  const { session } = await openSession([sampleItem('a.js')]);
  session.dispatch('tasks');
  session.pushInput('first\x1b\rsecond');
  assert.equal(session.mode, 'compose');
  assert.equal(session.tasksFocus, taskAt(session, 0));
  assert.equal(session.editor.text, 'first\nsecond');
  press(session, 'insert');
  session.pushInput('another');
  press(session, 'up');
  const ids = session.notes.tasks.map((task) => task.id);
  assert.equal(session.tasksFocus, taskAt(session, 0));
  const editor = session.editor;
  editor.place(2);
  session.pushInput('\x1b\rA\x1b\rB');
  assert.equal(session.editor, editor);
  assert.equal(session.editor.text, 'fi\nA\nBrst\nsecond');
  assert.equal(session.tasksFocus, taskAt(session, 0));
  assert.equal(session.composeTaskId, ids[0]);
  press(session, 'escape');
  assert.equal(session.mode, 'review');
  assert.notEqual(session.pane, 'tasks');
  assert.equal(session.editor, null);
  assert.deepEqual(
    session.notes.tasks.map((task) => task.id),
    ids,
  );
  const saved = fs.readFileSync(session.notes.reviewPath, 'utf8');
  assert.deepEqual(
    parseReview(saved).tasks.map((task) => task.text),
    ['fi\nA\nBrst\nsecond', 'another'],
  );
});

test('a standalone Escape still saves and leaves the task editor', async () => {
  const { session } = await openSession([sampleItem('a.js')]);
  session.dispatch('tasks');
  session.pushInput('task text\x1b');
  assert.equal(session.mode, 'compose');
  await new Promise((resolve) => {
    setTimeout(resolve, 100);
  });
  assert.equal(session.mode, 'review');
  assert.equal(session.notes.tasks[0].text, 'task text');
  assert.equal(session.term.carry, '');
});

test('one standalone Escape ends the read loop on the file list', async (t) => {
  const stdin = new EventEmitter();
  const { session } = await openSession([sampleItem('a.js')], {
    startPane: 'files',
    stdin,
  });
  const ended = session.readLoop();
  t.after(() => session.finishInput());
  stdin.emit('data', Buffer.from('\x1b'));
  assert.equal(session.term.timers.get('input-escape').hasRef(), true);
  await ended;
  assert.equal(session.done, true);
  assert.equal(session.finishReadLoop, null);
  assert.equal(stdin.listenerCount('data'), 0);
  assert.equal(session.term.timers.size, 0);
});

test('todo list stays on screen while composing', async () => {
  const { session } = await openSession([sampleItem('a.js')]);
  session.dispatch('tasks');
  session.pushInput('first note');
  saveTask(session);
  session.composer.tasks.newTask();
  session.pushInput('draft two');
  assert.equal(session.mode, 'compose');
  session.draw();
  const body = stripAnsi(session.lastFrame.rows.join('\n'));
  assert.match(body, /\[ \] first note/);
  const first = rowOf(session, 'first note');
  const hit = session.lastFrame.taskHits.find((row) => row.cursor === first);
  assert.ok(hit);
  click(session, 8, hit.y);
  click(session, 8, hit.y);
  assert.equal(session.mode, 'compose');
  assert.equal(session.editor.text, 'first note');
  assert.equal(session.notes.tasks.length, 2);
  assert.equal(session.notes.tasks[1].text, 'draft two');
});

test('ctrl+r removes a task and backspace an emptied one', async () => {
  const { session } = await openSession([sampleItem('a.js')]);
  session.dispatch('tasks');
  session.pushInput('first note');
  press(session, 'insert');
  session.pushInput('second note');
  press(session, 'ctrl-r');
  assert.deepEqual(taskRows(session), ['[ ] first note']);
  assert.equal(session.tasksFocus, taskAt(session, 0));
  assert.equal(session.editor.text, 'first note');
  assert.equal(session.current().origin, 'task');
  press(session, 'ctrl-a', 'backspace');
  assert.deepEqual(taskRows(session), ['[ ] ']);
  press(session, 'backspace');
  assert.deepEqual(taskRows(session), []);
  assert.equal(focusedRow(session), 'Feature requests and Enhancements');
  assert.equal(session.editor.text, 'Feature requests and Enhancements');
  assert.equal(session.current().origin, 'task');
});

test('empty autosave does not persist a draft todo', async () => {
  const { session } = await openSession([sampleItem('a.js')]);
  session.dispatch('tasks');
  assert.equal(session.composeTaskId, null);
  session.autosave();
  assert.equal(session.notes.tasks.length, 0);
  session.pushInput('keep this');
  press(session, 'enter');
  assert.equal(session.composeTaskId, null);
  session.autosave();
  assert.deepEqual(
    session.notes.tasks.map((task) => task.text),
    ['keep this'],
  );
  assert.equal(session.current().origin, 'task');
});

test('todo autosave updates one draft instead of duplicating', async () => {
  const { session } = await openSession([sampleItem('a.js')]);
  session.dispatch('tasks');
  session.pushInput('keep this');
  session.autosave();
  assert.equal(session.notes.tasks.length, 1);
  assert.equal(session.composeTaskId, session.notes.tasks[0].id);
  session.autosave();
  assert.equal(session.notes.tasks.length, 1);
  session.pushInput(' more');
  session.autosave();
  assert.equal(session.notes.tasks.length, 1);
  assert.equal(session.notes.tasks[0].text, 'keep this more');
  press(session, 'escape');
  assert.equal(session.mode, 'review');
  assert.equal(session.editor, null);
  assert.deepEqual(
    session.notes.tasks.map((task) => task.text),
    ['keep this more'],
  );
});

test('up edits the task above from the end of its text', async () => {
  const { session } = await openSession([sampleItem('a.js')]);
  session.dispatch('tasks');
  session.pushInput('first');
  press(session, 'insert', 'up');
  assert.equal(session.tasksFocus, taskAt(session, 0));
  session.pushInput('+more');
  assert.equal(session.mode, 'compose');
  assert.equal(session.editor.text, 'first+more');
  assert.equal(session.editor.cursor, 'first+more'.length);
});

test('page keys jump the tasks list', async () => {
  const { session } = await openSession([sampleItem('a.js')]);
  typeTasks(session, 'one', 'two', 'three');
  press(session, 'pageUp');
  assert.equal(session.tasksFocus, 0);
  assert.equal(focusedRow(session), 'Agent instructions');
  press(session, 'pageDown');
  assert.ok(session.tasksFocus > 0);
  pageTo(session, '[ ] three');
  assert.equal(focusedRow(session), '[ ] three');
  assert.equal(session.editor.text, 'three');
});

test('todo edit arrows move across todos without leaving edit', async () => {
  const { session } = await openSession([sampleItem('a.js')]);
  typeTasks(session, 'first', 'second');
  press(session, 'up');
  assert.equal(session.mode, 'compose');
  assert.equal(session.tasksFocus, taskAt(session, 0));
  assert.equal(session.editor.text, 'first');
  assert.equal(session.editor.cursor, 'first'.length);
  press(session, 'up');
  assert.equal(session.mode, 'compose');
  assert.equal(focusedRow(session), 'Feature requests and Enhancements');
  assert.equal(session.editor.text, 'Feature requests and Enhancements');
  press(session, 'down');
  assert.equal(session.tasksFocus, taskAt(session, 0));
  press(session, 'down');
  assert.equal(session.mode, 'compose');
  assert.equal(session.tasksFocus, taskAt(session, 1));
  assert.equal(session.editor.text, 'second');
  press(session, 'down');
  assert.equal(session.mode, 'compose');
  assert.equal(session.tasksFocus, taskAt(session, 1));
  assert.equal(session.editor.text, 'second');
  assert.deepEqual(taskRows(session), ['[ ] first', '[ ] second']);
});

test('todo edit arrows move inside a multiline todo', async () => {
  const { session } = await openSession([sampleItem('a.js')]);
  typeTasks(session, 'first', 'second');
  session.notes.setTaskText(session.notes.tasks[1].id, 'one\ntwo\nthree');
  session.composer.tasks.settle();
  assert.equal(session.mode, 'compose');
  assert.equal(session.editor.linePos().line, 0);
  press(session, 'down', 'down');
  assert.equal(session.tasksFocus, taskAt(session, 1));
  assert.equal(session.editor.linePos().line, 2);
  press(session, 'down');
  assert.equal(session.tasksFocus, taskAt(session, 1));
  assert.equal(session.editor.linePos().line, 2);
  press(session, 'up', 'up', 'up');
  assert.equal(session.tasksFocus, taskAt(session, 0));
  assert.equal(session.editor.text, 'first');
  press(session, 'down');
  assert.equal(session.tasksFocus, taskAt(session, 1));
  assert.equal(session.editor.text, 'one\ntwo\nthree');
  assert.equal(session.editor.linePos().line, 0);
});

test('todo edit arrows move across wrapped lines', async () => {
  const { session } = await openSession([sampleItem('a.js')]);
  typeTasks(session, 'first', 'second');
  const long = 'x'.repeat(90);
  session.notes.setTaskText(session.notes.tasks[1].id, long);
  press(session, 'up');
  assert.equal(session.tasksFocus, taskAt(session, 1));
  assert.ok(session.editor.cursor < long.length);
  press(session, 'down');
  assert.equal(session.tasksFocus, taskAt(session, 1));
  assert.equal(session.editor.cursor, long.length);
  press(session, 'up', 'up');
  assert.equal(session.tasksFocus, taskAt(session, 0));
});

test('todo edit page keys jump across todos', async () => {
  const { session } = await openSession([sampleItem('a.js')]);
  typeTasks(session, 'first', 'second', 'third');
  press(session, 'pageUp');
  assert.equal(focusedRow(session), 'Agent instructions');
  pageTo(session, '[ ] third');
  assert.equal(session.tasksFocus, taskAt(session, 2));
  assert.equal(session.editor.text, 'third');
});

test('enter breaks the line, insert starts a task below', async () => {
  const { session } = await openSession([sampleItem('a.js')]);
  session.dispatch('tasks');
  assert.deepEqual(taskRows(session), ['[ ] ']);
  session.pushInput('first');
  press(session, 'insert');
  assert.equal(session.editor.text, '');
  assert.deepEqual(taskRows(session), ['[ ] first', '[ ] ']);
  assert.equal(session.tasksFocus, taskAt(session, 1));
  session.pushInput('second');
  press(session, 'up', 'home', 'right', 'right', 'enter');
  assert.equal(session.editor.text, 'fi\nrst');
  press(session, 'end', 'enter');
  session.pushInput('- where: lib/a.js');
  press(session, 'down');
  assert.equal(session.notes.tasks[0].text, 'fi\nrst\n- where: lib/a.js');
  assert.equal(session.notes.tasks[0].item.value('where'), 'lib/a.js');
  assert.deepEqual(
    session.notes.tasks.map((task) => task.item.title),
    ['fi', 'second'],
  );
});

test('todo save recovers if the stub was dropped', async () => {
  const { session } = await openSession([sampleItem('a.js')]);
  session.dispatch('tasks');
  for (const task of session.notes.tasks) session.notes.removeTask(task.id);
  session.pushInput('still here');
  press(session, 'insert');
  assert.equal(session.notes.tasks.length, 1);
  assert.equal(session.notes.tasks[0].text, 'still here');
  assert.equal(session.current().origin, 'task');
});

test('quit with notes keeps the review status', async () => {
  const item = sampleItem('a.js');
  const { session } = await openSession([item]);
  session.dispatch('blockTask');
  session.pushInput('nits');
  press(session, 'ctrl-s');
  session.notes.status = 'partial';
  session.notes.dirty = true;
  session.dispatch('quit');
  assert.equal(session.done, true);
  assert.equal(session.mode, 'review');
  const md = fs.readFileSync(session.notes.reviewPath, 'utf8');
  assert.match(md, /nits/);
  assert.match(md, /status: partial/);
});

test('quit warns before terminating a running test or agent', async () => {
  const { session } = await openSession([sampleItem('a.js')]);
  let testsKilled = false;
  let agentsKilled = false;
  session.npm.runs.push({
    id: 1,
    name: 'test',
    kind: 'script',
    status: 'running',
    stopping: false,
    raw: '',
    output: '',
    startedAt: Date.now(),
    endedAt: 0,
    exit: '',
    child: {
      kill() {
        testsKilled = true;
      },
    },
  });
  session.agents.jobs.push({
    status: 'running',
    child: {
      kill() {
        agentsKilled = true;
      },
    },
  });
  session.notes.status = 'editing';
  session.dispatch('quit');
  assert.equal(session.done, false);
  assert.equal(session.mode, 'confirmQuit');
  session.draw();
  const asking = stripAnsi(session.lastFrame.rows.at(-2));
  assert.match(asking, /exit will terminate tests and agents/);
  assert.match(asking, /y\/n/);
  session.pushInput('n');
  assert.equal(session.done, false);
  assert.equal(session.mode, 'review');
  assert.equal(testsKilled, false);
  session.dispatch('quit');
  clickStatusChoice(session, 'y');
  assert.equal(session.done, true);
  assert.equal(testsKilled, true);
  assert.equal(agentsKilled, true);
  assert.equal(session.notes.status, 'editing');
});

test('initReview resumes latest editing file', async () => {
  const cwd = tempDir('reslop-ui-');
  const name = `${today()}-00.md`;
  const reviewPath = path.join(cwd, REVIEW_DIR, name);
  const draft = new ReviewStore(reviewPath);
  draft.addTask('a.js', 'rewrite loop');
  fs.mkdirSync(path.dirname(reviewPath), { recursive: true });
  fs.writeFileSync(reviewPath, serializeReview(draft), 'utf8');
  const { session } = await openSession([sampleItem('a.js')], { cwd });
  assert.equal(session.notes.reviewPath, reviewPath);
  assert.equal(session.notes.status, 'editing');
  assert.equal(session.notes.tasks[0].text, 'rewrite loop');
  assert.equal(
    session.fileList().some((entry) => entry.kind === 'tasks'),
    false,
  );
});

test('initReview starts a new file when latest is partial', async () => {
  const cwd = tempDir('reslop-ui-');
  const name = `${today()}-00.md`;
  const reviewPath = path.join(cwd, REVIEW_DIR, name);
  const draft = new ReviewStore(reviewPath);
  draft.status = 'partial';
  draft.addTask('a.js', 'rewrite loop');
  fs.mkdirSync(path.dirname(reviewPath), { recursive: true });
  fs.writeFileSync(reviewPath, serializeReview(draft), 'utf8');
  const { session } = await openSession([sampleItem('a.js')], { cwd });
  assert.equal(
    session.notes.reviewPath,
    path.join(cwd, REVIEW_DIR, `${today()}-01.md`),
  );
  assert.equal(session.notes.tasks.length, 0);
});

test('newReview starts a new file even if latest is editing', async () => {
  const cwd = tempDir('reslop-ui-');
  const name = `${today()}-00.md`;
  const reviewPath = path.join(cwd, REVIEW_DIR, name);
  const draft = new ReviewStore(reviewPath);
  draft.addTask('a.js', 'rewrite loop');
  fs.mkdirSync(path.dirname(reviewPath), { recursive: true });
  fs.writeFileSync(reviewPath, serializeReview(draft), 'utf8');
  const { session } = await openSession([sampleItem('a.js')], {
    cwd,
    newReview: true,
  });
  assert.equal(
    session.notes.reviewPath,
    path.join(cwd, REVIEW_DIR, `${today()}-01.md`),
  );
  assert.equal(session.notes.tasks.length, 0);
});
