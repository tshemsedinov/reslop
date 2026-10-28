# 👁️ reslop

## Review AI generated code and plan changes

[![ci status](https://github.com/tshemsedinov/reslop/workflows/Testing%20CI/badge.svg)](https://github.com/tshemsedinov/reslop/actions?query=workflow%3A%22Testing+CI%22+branch%3Amain)
[![snyk](https://snyk.io/test/github/tshemsedinov/reslop/badge.svg)](https://snyk.io/test/github/tshemsedinov/reslop)
[![npm version](https://badge.fury.io/js/reslop.svg)](https://badge.fury.io/js/reslop)
[![npm downloads](https://img.shields.io/npm/dt/reslop.svg)](https://www.npmjs.com/package/reslop)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/tshemsedinov/reslop/blob/main/LICENSE)

> Turn generated changes into owned changes

Open a change, leave findings and a backlog, and prepare a repair plan for the agent.

```text
Review → Plan → Repair → Verify
```

- Live dashboard: files and folder, diffs, tasks, branches, commits, run, agents, and npm, updated in real time
- Leave feedback, a project backlog, and in-place code proposals as a repair plan
- Review uncommitted git diffs, a given commit, a GitHub PR, or a GitLab MR
- File-scope review mode: not just diffs, with editor mode
- Stage, unstage, or revert each contiguous block of diff lines
- Auto-reload local diffs when files change, keeping the current screen
- Import GitHub PR and GitLab MR review comments, and GitHub/GitLab issues, into tasks and the local plan
- Commits list: brief and full, view a commit's diff, commit, update, amend, squash a range, apply a fixup onto its target, edit, fixup, and delete
- Branches: checkout, create, rebase with autoresolved conflicts, delete ranges, pull, and push; git worktrees as tiles above the branches
- npm scripts: run, edit, reorder, clean logs
- Reduced test and lint output for agents: failures and a short summary, not passing noise
- Review, renew, audit and update npm dependencies in `package.json` and the lockfile
- Auto-update reslop patch and minor releases; confirm a new major
- Work with git, npm, and fetch in the background; run tests in the background while you review
- Execute the plan in local agents over ACP, continue or start new session

## Install

```bash
npm i -g reslop
```

Works on Linux, macOS, and Windows. On Windows use Windows Terminal.
Requires Node.js `>=18.15.0`.

## Usage

- `reslop` live dashboard of this repository; press a block key to open its screen
- `reslop folder` tiles of the repositories in a folder, each with its git worktrees
- `reslop path/file` show only that path or file (starts on the file list)
- `reslop 7ac260c` show that commit (read-only)
- `reslop https://github.com/metarhia/metacom/pull/555` GitHub/GitLab PR/MR
- `reslop https://github.com/metarhia/metacom/issues/550` import GitHub/GitLab issue
- `reslop https://github.com/metarhia/metacom/issues` import all issues
- `reslop -r` read-only mode
- `reslop t -- <program> [args]` run one program and print a reduced report

Prefix each program in an npm script with `reslop t --`. Keep `&&` between those wraps, so each program is captured on its own and a failing step does not start the next one:

```json
"lint": "reslop t -- eslint . && reslop t -- prettier -c \"**/*.js\"",
"test": "reslop t -- npm run -s lint && reslop t -- node --test"
```

The report is Markdown: failures, diagnostics, and a short summary. Passing results are omitted and similar problems are grouped. The reduced report is saved as `.log/<name>.log` and the raw output as `.log/<name>.raw`. The report names the raw file for an agent to read when a detail is missing. Set `RESLOP_OUTPUT=raw` to pass the command through unchanged. The review screen runs scripts in raw mode and applies its own filter once.

Reviews go in `.plan/YYYY-MM-DD-NN.md` with frontmatter `status`:

- `editing`: writing the review in reslop; AI works through the checkboxes
- `partial`: AI started; some items remain
- `done`: all items marked `[x]`; adding an issue in reslop sets it back to `editing`

## Agents

reslop runs a plan in an agent over the [Agent Client Protocol](https://agentclientprotocol.com). An agent is listed as available when the command that serves ACP is on `PATH`:

| Agent       | Command              | Install                                           |
| ----------- | -------------------- | ------------------------------------------------- |
| Claude Code | `claude-agent-acp`   | `npm i -g @agentclientprotocol/claude-agent-acp`  |
| Codex       | `codex-acp`          | `npm i -g @agentclientprotocol/codex-acp`         |
| Cursor      | `cursor-agent acp`   | comes with the Cursor CLI                         |
| OpenCode    | `opencode acp`       | `npm i -g opencode-ai`                            |
| Antigravity | `agy_acp_server.par` | downloaded from the official ACP registry         |
| Junie       | `junie --acp=true`   | `npm i -g @jetbrains/junie`                       |
| Copilot     | `copilot --acp`      | `npm i -g @github/copilot`                        |
| Pi          | `pi-acp` and `pi`    | `npm i -g pi-acp @earendil-works/pi-coding-agent` |
| Kiro        | `kiro-cli acp`       | install script from cli.kiro.dev                  |
| Cline       | `cline --acp`        | `npm i -g cline`                                  |
| Windsurf    | `devin acp`          | install script from cli.devin.ai                  |
| Kilo Code   | `kilo acp`           | `npm i -g @kilocode/cli`                          |

## Future

- Search, blame, and file history in the review
- Security and code-quality audit; propose a repair plan
- Send anonymized code blocks for expert review
- Send questions and the repair plan to experts for approval
- Ask experts
- Apply refactoring skills
- Cherry-pick and interactive rebase
- Merge, rename, and conflict resolution

## License

Copyright (c) 2026 Timur Shemsedinov and other contributors (see github).
This is [MIT](./LICENSE) licensed software.
