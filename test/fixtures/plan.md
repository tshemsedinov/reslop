---
status: editing
owner: reslop
---

# Watcher and input fixes

## Agent instructions

Work through unchecked items, one commit per ID.

- Run `npm t` before marking an item `[x]`

## Bug Reports and Fixes

- [ ] B1 high: A lone Escape ends the read loop on the file list
  - where: `lib/session/session.js` readLoop, lib/session/terminal.js
  - problem: the escape timer resolves the loop before the next key arrives
  - evidence: `test/session.test.js` "one standalone Escape ends the read loop"
    fails when the timer fires first
  - expected: a lone Escape leaves the screen, a sequence stays one key
  - check:
    - [x] the read loop survives a lone Escape
    - [ ] terminal tests pass
- [x] B2: Ignore editor swap files in the disk watcher
  - where: lib/dashboard/watch.js#ignoredName
  - result: `.swp` and `.swo` are skipped; watch tests pass
- [ ] high: Watcher misses a review written through a symlink

## Refactoring and Technical debt

- [ ] D1: Split decodeChunk into one function per escape kind
  - where: lib/input/keys.js#decodeChunk
  - constraints: keep the decoded events byte for byte; no new dependencies
  - owner: keep this unknown key
- [ ] low: Rename `fileText` in lib/session/unit.js

  Free text after a blank line stays with the task.

## Notes

The watcher skips these folders:

- `node_modules`, `coverage`, `dist`
- `.plan` itself, unless a review file changes

```js
const SKIP_DIRS = ['node_modules', REVIEW_DIR, 'coverage', 'dist', '.cache'];
// ## not a heading inside a fence
```

| key    | action   |
| ------ | -------- |
| insert | new task |

## lib/diff/align.js

- [ ] keep the gap between the two sides - lib/diff/align.js:12:12:0
- [x] code `lib/diff/align.js:40:40:1`

```
const gap = 1;
```
