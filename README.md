# 👁️ reslop — Review AI generated code and plan changes

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

- Leave feedback, issues/todos, and in-place code proposals as a repair plan.
- Review uncommitted git diffs, a given commit, a GitHub PR, or a GitLab MR.
- Stage, unstage, or revert each contiguous block of diff lines.
- Import GitHub PR and GitLab MR review comments into the local plan for AI.
- Commit, amend, or fixup staged changes from the file list.
- Branches: checkout, create, rebase, drop, pull and push.
- Review each npm dependency once across `package.json` and the lockfile.
- Propose unused removals, npm audit fixes, and outdated updates as diffs.
- Code highlighting, diff compare: unified, mixed, and side-by-side layouts.

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

| Key                 | Action                                        |
| ------------------- | --------------------------------------------- |
| `a` / `u` / `d`     | Stage / unstage / drop this diff              |
| `c`                 | File list: `c` commit / `a` amend / `f` fixup |
| `b`                 | List branches; `n` new; `r` rebase; `d` drop  |
| `p` / `s`           | git pull/push                                 |
| `f` / `t` / `e`     | Feedback / repo todo / edit added lines       |
| `r`                 | Reload diffs from disk                        |
| `m`                 | Mode: unified / mixed / side-by-side          |
| `⏎`                 | Open the selected file                        |
| `→` / `j`           | Next remaining diff / file                    |
| `←` / `k`           | Previous remaining diff / file                |
| `Ctrl-e` / `Ctrl-y` | Scroll one line down / up                     |
| `Ctrl-f` / `Ctrl-b` | Scroll page down / up                         |
| `Ctrl-d` / `Ctrl-u` | Scroll half-page down / up                    |
| `⌫` / `Del`         | Remove the selected todo                      |
| `Esc` / `q`         | Quit                                          |

## Future

- Import issues from GitHub and GitLab.
- Security and code-quality audit; propose a repair plan.
- Send anonymized code blocks for expert review.
- Send questions and the repair plan to experts for approval.
- Ask experts.
- Verify the codebase.
- Apply refactoring skills.
- Call agents, harnesses, and IDEs to execute prepared plans.

## License

Copyright (c) 2026 Timur Shemsedinov.
This is [MIT](./LICENSE) licensed software.
