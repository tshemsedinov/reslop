'use strict';

const { presentRows, presentCursor } = require('../render/render.js');

const INPUT_QUIET_MS = 40;
const INPUT_DRAIN_MAX_MS = 200;

// Report Shift+Enter and Ctrl+Enter: xterm modifyOtherKeys, kitty protocol
const KEYS_ON = '\x1b[>4;2m\x1b[>1u';
const KEYS_OFF = '\x1b[<u\x1b[>4;0m';

// XTSHIFTESCAPE: report Shift in mouse clicks. Otherwise the terminal keeps
// Shift+click for its own text selection and the list never sees it.
const SHIFT_ON = '\x1b[>1s';
const SHIFT_OFF = '\x1b[>0s';

const ENTER = '\x1b[?1049h\x1b[?25l\x1b[?7l\x1b[?1003h\x1b[?1006h';
const MOUSE_OFF = '\x1b[?1006l\x1b[?1003l\x1b[?7h';
const CURSOR_ON = '\x1b[0 q\x1b[?12l\x1b[?25h\x1b[?1049l';

const ENTER_TERM = ENTER + SHIFT_ON + KEYS_ON;
const RESET_PAINT = '\x1b[?2026l\x1b[0m';
const LEAVE_TERM = SHIFT_OFF + MOUSE_OFF + KEYS_OFF + RESET_PAINT + CURSOR_ON;

const listen = (emitter, event, handler) => {
  if (!emitter || typeof emitter.on !== 'function') return () => {};
  emitter.on(event, handler);
  return () => {
    if (typeof emitter.removeListener === 'function') {
      return void emitter.removeListener(event, handler);
    }
    if (typeof emitter.off === 'function') emitter.off(event, handler);
  };
};

const watchResize = (stdout, proc, onResize, signal) => {
  const stopStdout = listen(stdout, 'resize', onResize);
  let stopProc = () => {};
  try {
    stopProc = listen(proc, 'SIGWINCH', onResize);
  } catch {
    // SIGWINCH is not available on Windows
  }
  const stop = () => {
    stopStdout();
    stopProc();
  };
  if (signal) {
    if (signal.aborted) stop();
    else signal.addEventListener('abort', stop, { once: true });
  }
  return stop;
};

// Disable reports before draining them, while raw mode still prevents echo.
const drainInput = (stdin) => {
  if (!stdin || typeof stdin.on !== 'function') return Promise.resolve();
  return new Promise((resolve) => {
    let quiet = null;
    let limit = null;
    let stop = () => {};
    const finish = () => {
      clearTimeout(quiet);
      clearTimeout(limit);
      stop();
      if (stdin.pause) stdin.pause();
      resolve();
    };
    const activity = () => {
      clearTimeout(quiet);
      quiet = setTimeout(finish, INPUT_QUIET_MS);
    };
    stop = listen(stdin, 'data', activity);
    limit = setTimeout(finish, INPUT_DRAIN_MAX_MS);
    activity();
    if (stdin.resume) stdin.resume();
  });
};

const sameCursor = (a, b) => {
  if (!a || !b) return !a && !b;
  return a.x === b.x && a.y === b.y;
};

const sameSize = (a, b) => {
  if (a === null) return false;
  const sameWidth = a.width === b.width;
  const sameHeight = a.height === b.height;
  return sameWidth && sameHeight;
};

class Terminal {
  constructor({ stdin = null, stdout, proc = process }) {
    this.stdin = stdin;
    this.stdout = stdout;
    this.proc = proc;
    this.timers = new Map();
    this.disposers = [];
    this.open = false;
    this.disposed = false;
    this.closePromise = null;
    this.resetCache();
  }

  resetCache() {
    this.carry = '';
    this.lastFrame = null;
    this.lastCursor = null;
    this.lastSize = null;
  }

  cancel(name) {
    const id = this.timers.get(name);
    if (id === undefined) return;
    clearTimeout(id);
    this.timers.delete(name);
  }

  later(name, fn, ms, { ref = false } = {}) {
    if (this.disposed || this.timers.has(name)) return;
    const id = setTimeout(() => {
      this.timers.delete(name);
      fn();
    }, ms);
    if (!ref) id.unref();
    this.timers.set(name, id);
  }

  clearTimers() {
    for (const id of this.timers.values()) clearTimeout(id);
    this.timers.clear();
  }

  enter() {
    if (this.disposed) return;
    const stdin = this.stdin;
    if (stdin && stdin.setRawMode) stdin.setRawMode(true);
    if (stdin && stdin.resume) stdin.resume();
    this.stdout.write(ENTER_TERM);
    this.open = true;
  }

  leave() {
    if (!this.open) return;
    this.stdout.write(LEAVE_TERM);
    if (this.stdin && this.stdin.setRawMode) this.stdin.setRawMode(false);
    this.open = false;
  }

  close() {
    if (this.closePromise) return this.closePromise;
    this.stopListening();
    this.clearTimers();
    this.disposed = true;
    if (!this.open) return Promise.resolve();
    this.stdout.write(LEAVE_TERM);
    this.open = false;
    this.closePromise = drainInput(this.stdin).finally(() => {
      if (this.stdin && this.stdin.setRawMode) this.stdin.setRawMode(false);
    });
    return this.closePromise;
  }

  startListening({ onData, onResize }) {
    if (this.disposed) return;
    this.listenOpts = { onData, onResize };
    this.disposers.push(listen(this.stdin, 'data', onData));
    this.disposers.push(watchResize(this.stdout, this.proc, onResize));
  }

  stopListening() {
    while (this.disposers.length) this.disposers.pop()();
  }

  pause() {
    this.stopListening();
    this.leave();
    if (this.stdin && this.stdin.pause) this.stdin.pause();
    this.resetCache();
  }

  resume() {
    if (this.disposed || this.open) return;
    this.enter();
    if (this.listenOpts) this.startListening(this.listenOpts);
  }

  paint(frame, size, cursor) {
    if (this.disposed) return;
    const clear = !sameSize(this.lastSize, size);
    const last = this.lastFrame;
    this.lastFrame = frame;
    if (!clear && last && last.text === frame.text) {
      if (sameCursor(this.lastCursor, cursor)) return;
      this.lastCursor = cursor;
      return void this.stdout.write(presentCursor(cursor));
    }
    this.lastSize = size;
    this.lastCursor = cursor;
    const prev = clear || !last ? null : last.rows;
    this.stdout.write(presentRows(frame.rows, { clear, cursor, prev }));
  }
}

class Progress {
  constructor(term, onTick, intervalMs) {
    this.term = term;
    this.onTick = onTick;
    this.intervalMs = intervalMs;
    this.active = new Set();
  }

  tick() {
    if (!this.active.size) return;
    this.onTick();
    this.schedule();
  }

  schedule() {
    this.term.later('progress', () => this.tick(), this.intervalMs);
  }

  start(id) {
    this.active.add(id);
    this.schedule();
  }

  stop(id) {
    this.active.delete(id);
    if (!this.active.size) this.term.cancel('progress');
  }

  clear() {
    this.active.clear();
    this.term.cancel('progress');
  }

  size() {
    return this.active.size;
  }
}

module.exports = { ENTER_TERM, LEAVE_TERM, watchResize, Terminal, Progress };
