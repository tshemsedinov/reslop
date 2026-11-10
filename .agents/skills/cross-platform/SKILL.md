---
name: cross-platform
description: Write and review portable Node.js code and tests for Linux, macOS and Windows. Use for paths, files, processes, npm/git commands, watchers, timing, Node compatibility, or platform-specific CI failures.
---

# Cross-platform

A local pass verifies only the host and Node version that ran it. Apply these
checks to the changed behavior; keep unrelated portability work out of scope.

## Workflow

1. Read project instructions for checks and helpers. Inspect helpers before reuse.
2. Check `node -p "process.platform"`, `node --version`, `package.json` engines
   and the CI matrix. Review the relevant rules below for untested targets.
3. Fix the cause and test it. Do not skip failing tests, weaken assertions or
   add sleeps to get a pass. Fix nonportable fixtures.
4. Run required checks. Report commands, results, host, Node version and relevant
   untested behavior. Never claim another OS passed through mocks.

## Paths and files

- Use `path` for paths, `os.tmpdir()` for temp roots and `os.homedir()` for home.
  Create isolated temp directories with the project helper or `fs.mkdtemp`.
- Compare existing path identities through the project's canonicalizer:
  macOS `/var` may resolve through `/private/var`. `realpath` needs existing paths.
- Normalize separators at output boundaries only when the format requires `/`.
  Root stripping must handle mixed separators and directory boundaries:
  `C:\repo` must not match `C:\repository`.
- Match filename/import case exactly. Avoid Windows reserved names (also
  `aux.txt`), reserved characters, trailing dots/spaces and case-only duplicates.
  Case sensitivity depends on the filesystem; do not lowercase all paths.
- Windows symlinks may require privileges. Exercise supported fallbacks; skip
  only intentionally unsupported features under project policy, with a reason.

## Processes

- Reuse process helpers. Prefer an executable plus argument array; use
  `process.execPath` for Node. Windows `.cmd` launchers need shell handling;
  `shell: true` alone does not preserve arbitrary argument quoting.
- Use `path.delimiter` for PATH. On Windows preserve its existing key spelling;
  avoid both `PATH` and `Path`. Match `PATHEXT` case-insensitively but return the
  executable's on-disk spelling.
- POSIX entrypoints need executable git mode and LF shebangs. Executed fake tools
  need portable launchers (Node plus a Windows shim when needed); discovery-only
  placeholders need not run. A shell fixture is no reason to skip a portable test.
- Windows termination does not run POSIX signal handlers. Negative PIDs and
  process groups are POSIX-only; provide cleanup for each supported system.
- Shipped code and npm scripts must avoid POSIX-only utilities, inline environment
  assignments and shell-specific quoting/backgrounding. Prefer Node helpers and
  double-quote globs. Interactive commands need only suit the host.

## Cleanup and timing

- Register cleanup when acquiring resources. Stop children and await `close`;
  close streams, handles and watchers before renaming/removing their files.
- Reuse async cleanup helpers with bounded removal retries (`maxRetries`,
  `retryDelay`). Retries do not replace closing resources; synchronous waits can
  block children from finishing.
- Watcher events repeat, coalesce and arrive late. Assert final observable state
  with bounded condition waits, not OS event counts, sleeps or frame counts.
  Test debounce policy separately with controlled events/time.
- Timestamp-only caches miss same-tick changes. Preserve the project's
  invalidation/settling policy; test changed contents with unchanged timestamps.

## Text, versions and coverage

- Configure fixture git identity and line endings through project helpers.
  Parse line-oriented output with LF/CRLF support; preserve bytes in exact-content
  tests. Use `.gitattributes` where tracked files require fixed endings.
- Check APIs, syntax, flags and dependencies against the minimum Node version,
  including its minor version. Verify test commands discover all intended files.
- Test platform decisions with an injected `platform` defaulting to
  `process.platform`; do not reassign it globally. Test foreign path syntax with
  `path.posix` and `path.win32`, including roots, UNC paths and spaces as relevant.
- Pure tests cannot verify Windows locks/quoting or macOS watcher delivery. Use
  other runtimes/systems when available; mounted containers retain some host
  filesystem behavior.

For a pasted CI failure, identify its OS, Node version and failing invariant.
Reproduce locally as closely as possible, fix it, then run the regression and
required checks. State any reproduction limit. Refine this skill only if its
existing rules would have missed the demonstrated cause.
