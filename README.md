# 👁️ reslop — Review diff and plan changes

[![ci status](https://github.com/tshemsedinov/reslop/workflows/Testing%20CI/badge.svg)](https://github.com/tshemsedinov/reslop/actions?query=workflow%3A%22Testing+CI%22+branch%3Amain)
[![snyk](https://snyk.io/test/github/tshemsedinov/reslop/badge.svg)](https://snyk.io/test/github/tshemsedinov/reslop)
[![npm version](https://badge.fury.io/js/reslop.svg)](https://badge.fury.io/js/reslop)
[![npm downloads/month](https://img.shields.io/npm/dm/reslop.svg)](https://www.npmjs.com/package/reslop)
[![npm downloads](https://img.shields.io/npm/dt/reslop.svg)](https://www.npmjs.com/package/reslop)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/tshemsedinov/reslop/blob/main/LICENSE)

> Turn generated changes into owned changes

Open a change, leave findings and todos, and prepare a repair plan
for the agent.

```text
Review → Plan → Repair → Verify
```

- Review uncommitted git diffs, a given commit, a GitHub PR, or a GitLab MR.
- Stage, unstage, or revert each contiguous block of diff lines.
- Leave feedback, todos, and in-place code proposals that become a repair plan.
- Import GitHub PR and GitLab MR review comments into the local plan for AI.
- Review each npm dependency once across `package.json` and the lockfile.
- Propose unused removals, npm audit fixes, and outdated updates as diffs.

## Install

```bash
npm i -g reslop
```

Works on Linux, macOS, and Windows. On Windows use Windows Terminal.

## Usage

- `reslop` uncommitted diffs in this repository
- `reslop path/file` show only that path or file
- `reslop 7ac260c` show that commit (read-only)
- `reslop https://github.com/metarhia/metacom/pull/555` GitHub/GitLab PR/MR
- `reslop -n` start a new review even if the latest is still editing
- `reslop -r` read-only mode

Reviews go in `.review/YYYY-MM-DD-NN.md` with frontmatter `status`:

- `editing`: still writing the review in reslop
- `ready`: ready for AI to work through the checkboxes
- `partial`: AI started; some items remain
- `done`: all items marked `[x]`

## Hotkeys

| Key                 | Action                                          |
| ------------------- | ----------------------------------------------- |
| `a`                 | Stage this diff (git add)                       |
| `u`                 | Unstage this diff                               |
| `d`                 | Drop this diff to the last commit               |
| `c`                 | Commit: then `c` commit / `a` amend / `f` fixup |
| `f`                 | Feedback on this diff                           |
| `t`                 | New todo                                        |
| `e`                 | Edit added lines                                |
| `r`                 | Reload diffs from disk                          |
| `m`                 | Mode: unified / mixed / side-by-side            |
| `⏎`                 | Open the selected file                          |
| `→` / `j`           | Next remaining diff / next file                 |
| `←` / `k`           | Previous remaining diff / previous file         |
| `Ctrl-e` / `Ctrl-y` | Scroll one line down / up                       |
| `Ctrl-f` / `Ctrl-b` | Scroll page down / up                           |
| `Ctrl-d` / `Ctrl-u` | Scroll half-page down / up                      |
| `⌫` / `Del`         | Remove the selected todo                        |
| `Esc` / `q`         | Quit                                            |

## License

Copyright (c) 2026 Timur Shemsedinov.
This is [MIT](./LICENSE) licensed software.
