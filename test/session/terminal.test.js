'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { setTimeout: sleep } = require('node:timers/promises');

const { sink } = require('../helpers.js');
const { watchResize } = require('../../lib/session/terminal.js');
const terminal = require('../../lib/session/terminal.js');
const { Terminal, Progress, ENTER_TERM, LEAVE_TERM } = terminal;

const fakeStdin = () => {
  const stdin = new EventEmitter();
  stdin.raw = false;
  stdin.paused = true;
  stdin.setRawMode = (value) => {
    stdin.raw = value;
  };
  stdin.resume = () => {
    stdin.paused = false;
  };
  stdin.pause = () => {
    stdin.paused = true;
  };
  return stdin;
};

const openTerm = (extra = {}) => {
  const stdin = extra.stdin ?? fakeStdin();
  const stdout = extra.stdout ?? sink();
  const proc = extra.proc ?? new EventEmitter();
  const term = new Terminal({
    stdin,
    stdout,
    proc,
  });
  return { term, stdin, stdout, proc };
};
const emitSink = () => {
  const stdout = new EventEmitter();
  let text = '';
  stdout.write = (chunk) => {
    text += chunk;
    return true;
  };
  stdout.dump = () => text;
  return stdout;
};

test('watchResize removes listeners from stdout and process', () => {
  const stdout = new EventEmitter();
  const proc = new EventEmitter();
  let count = 0;
  const stop = watchResize(stdout, proc, () => {
    count += 1;
  });
  assert.equal(stdout.listenerCount('resize'), 1);
  assert.equal(proc.listenerCount('SIGWINCH'), 1);
  stdout.emit('resize');
  proc.emit('SIGWINCH');
  assert.equal(count, 2);
  stop();
  assert.equal(stdout.listenerCount('resize'), 0);
  assert.equal(proc.listenerCount('SIGWINCH'), 0);
  stdout.emit('resize');
  proc.emit('SIGWINCH');
  assert.equal(count, 2);
});

test('watchResize abort signal also removes listeners', () => {
  const stdout = new EventEmitter();
  const proc = new EventEmitter();
  const ac = new AbortController();
  watchResize(stdout, proc, () => {}, ac.signal);
  assert.equal(stdout.listenerCount('resize'), 1);
  ac.abort();
  assert.equal(stdout.listenerCount('resize'), 0);
  assert.equal(proc.listenerCount('SIGWINCH'), 0);
});

test('enter and leave restore raw mode and write term sequences', () => {
  const { term, stdin, stdout } = openTerm();
  term.enter();
  assert.equal(stdin.raw, true);
  assert.equal(stdin.paused, false);
  assert.equal(stdout.dump(), ENTER_TERM);
  term.leave();
  assert.equal(stdin.raw, false);
  assert.ok(stdout.dump().endsWith(LEAVE_TERM));
});

test('leaving turns off every terminal mode that entering turned on', () => {
  const { term, stdout } = openTerm();
  term.enter();
  const entered = stdout.dump();
  term.leave();
  const left = stdout.dump().slice(entered.length);
  const undo = [
    ['\x1b[>4;2m', '\x1b[>4;0m'],
    ['\x1b[>1u', '\x1b[<u'],
    ['\x1b[>1s', '\x1b[>0s'],
  ];
  for (const entry of undo) {
    const on = entry[0];
    const off = entry[1];
    assert.ok(entered.includes(on), JSON.stringify(on));
    assert.ok(left.includes(off), JSON.stringify(off));
  }
  const set = entered
    .split('\x1b[?')
    .slice(1)
    .map((part) => /^(\d+)h/.exec(part)?.[1])
    .filter(Boolean);
  assert.ok(set.length > 0);
  for (const mode of set) {
    const reset = left.includes(`\x1b[?${mode}l`);
    assert.ok(reset, `private mode ${mode} stays on after leaving`);
  }
  // Hidden cursor and no wrap are set by the l form, and put back by h
  assert.ok(left.includes('\x1b[?25h'));
  assert.ok(left.includes('\x1b[?7h'));
});

test('pause and resume restore listening after an external command', () => {
  const { term, stdin, stdout } = openTerm();
  let count = 0;
  term.enter();
  term.startListening({
    onData: () => {
      count += 1;
    },
    onResize: () => {},
  });
  assert.equal(stdin.listenerCount('data'), 1);
  term.pause();
  assert.equal(term.open, false);
  assert.equal(stdin.raw, false);
  assert.equal(stdin.paused, true);
  assert.equal(stdin.listenerCount('data'), 0);
  stdin.emit('data', 'x');
  assert.equal(count, 0);
  term.resume();
  assert.equal(term.open, true);
  assert.equal(stdin.raw, true);
  assert.equal(stdin.paused, false);
  assert.equal(stdin.listenerCount('data'), 1);
  stdin.emit('data', 'x');
  assert.equal(count, 1);
  assert.ok(stdout.dump().includes(LEAVE_TERM));
  assert.ok(stdout.dump().endsWith(ENTER_TERM));
});

test('close restores listener and timer counts', async () => {
  const stdin = fakeStdin();
  const stdout = emitSink();
  const proc = new EventEmitter();
  const term = new Terminal({ stdin, stdout, proc });
  const start = () => {
    term.startListening({
      onData: () => {},
      onResize: () => {},
    });
    term.later('save', () => {}, 1000);
    term.later('progress', () => {}, 1000);
  };
  start();
  assert.equal(stdin.listenerCount('data'), 1);
  assert.equal(stdout.listenerCount('resize'), 1);
  assert.equal(proc.listenerCount('SIGWINCH'), 1);
  assert.equal(term.timers.has('save'), true);
  assert.equal(term.timers.has('progress'), true);
  term.stopListening();
  term.clearTimers();
  assert.equal(stdin.listenerCount('data'), 0);
  assert.equal(stdout.listenerCount('resize'), 0);
  assert.equal(proc.listenerCount('SIGWINCH'), 0);
  assert.equal(term.timers.has('save'), false);
  assert.equal(term.timers.has('progress'), false);
  term.enter();
  start();
  await term.close();
  assert.equal(stdin.listenerCount('data'), 0);
  assert.equal(stdout.listenerCount('resize'), 0);
  assert.equal(proc.listenerCount('SIGWINCH'), 0);
  assert.equal(term.timers.has('save'), false);
  assert.equal(term.disposed, true);
  assert.equal(stdin.raw, false);
});

test('startup failure cleanup restores acquired terminal state', async () => {
  const { term, stdin, stdout, proc } = openTerm({ stdout: emitSink() });
  const run = () => {
    term.enter();
    term.startListening({
      onData: () => {},
      onResize: () => {},
    });
    term.later('save', () => {}, 1000);
    throw new Error('boom');
  };
  try {
    run();
  } catch (error) {
    assert.equal(error.message, 'boom');
    await term.close();
  }
  assert.equal(stdin.raw, false);
  assert.ok(stdout.dump().includes(LEAVE_TERM));
  assert.equal(stdin.listenerCount('data'), 0);
  assert.equal(proc.listenerCount('SIGWINCH'), 0);
  assert.equal(term.timers.has('save'), false);
  assert.equal(term.disposed, true);
});

test('unchanged frames still allow a cursor-only update', () => {
  const stdout = sink();
  const { term } = openTerm({ stdout });
  const size = { width: 80, height: 24 };
  const frame = { text: 'same', rows: ['same'] };
  term.paint(frame, size, { x: 1, y: 1 });
  const first = stdout.dump();
  assert.ok(first.includes('[?2026h'));
  term.paint(frame, size, { x: 1, y: 1 });
  assert.equal(stdout.dump(), first);
  term.paint(frame, size, { x: 4, y: 2 });
  const extra = stdout.dump().slice(first.length);
  assert.ok(extra.includes('[2;4H'));
  assert.ok(!extra.includes('[?2026h'));
});

test('paint after dispose writes nothing', async () => {
  const stdout = sink();
  const { term } = openTerm({ stdout });
  term.enter();
  stdout.dump();
  const before = stdout.dump();
  await term.close();
  const closed = stdout.dump();
  term.paint({ text: 'x', rows: ['x'] }, { width: 8, height: 4 }, null);
  assert.equal(stdout.dump(), closed);
  assert.ok(closed.length > before.length);
});

test('progress ticks only while an id is active', () => {
  const { term } = openTerm();
  let ticks = 0;
  const progress = new Progress(term, () => (ticks += 1), 1000);
  progress.start('busy');
  progress.start('install');
  assert.equal(term.timers.has('progress'), true);
  progress.tick();
  assert.equal(ticks, 1);
  progress.stop('busy');
  assert.equal(term.timers.has('progress'), true);
  progress.tick();
  assert.equal(ticks, 2);
  progress.stop('install');
  assert.equal(term.timers.has('progress'), false);
  progress.tick();
  assert.equal(ticks, 2);
});

test('later runs once and can be scheduled again', async () => {
  const { term } = openTerm();
  let runs = 0;
  term.later('save', () => (runs += 1), 5);
  term.later('save', () => (runs += 10), 5);
  assert.equal(term.timers.get('save').hasRef(), false);
  await sleep(30);
  assert.equal(runs, 1);
  assert.equal(term.timers.has('save'), false);
  term.later('save', () => (runs += 1), 5);
  await sleep(30);
  assert.equal(runs, 2);
  await term.close();
});

test('later can keep pending input alive until it runs', async () => {
  const { term } = openTerm();
  const completed = new Promise((resolve) => {
    term.later('input-escape', resolve, 5, { ref: true });
  });
  assert.equal(term.timers.get('input-escape').hasRef(), true);
  await completed;
  assert.equal(term.timers.has('input-escape'), false);
  await term.close();
});

test('close drains late reports before restoring cooked input', async () => {
  const { term, stdin, stdout } = openTerm();
  let handled = 0;
  term.enter();
  term.startListening({ onData: () => handled++, onResize: () => {} });
  const closing = term.close();
  assert.equal(stdin.raw, true);
  assert.ok(stdout.dump().endsWith(LEAVE_TERM));
  assert.equal(term.close(), closing);
  await sleep(10);
  stdin.emit('data', '\x1b[<35;12;4M');
  await sleep(10);
  stdin.emit('data', '\x1b[13;2u');
  assert.equal(stdin.raw, true);
  await closing;
  assert.equal(handled, 0);
  assert.equal(stdin.raw, false);
  assert.equal(stdin.paused, true);
  assert.equal(stdin.listenerCount('data'), 0);
});
