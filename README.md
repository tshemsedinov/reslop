# reslop — Review diff and plan changes

> Turn generated changes into owned changes

Open a change, leave findings and todos, and prepare a repair plan
for the agent.

```text
Review → Plan → Repair → Verify
```

- Review uncommitted git diffs, a given commit, or a GitHub pull request.
- Stage, unstage, or revert each contiguous block of diff lines.
- Leave feedback and todos that become a repair plan for the agent.
- Import GitHub pull request review comments into the local plan for AI.
- Review each npm dependency once across `package.json` and the lockfile.
- Propose unused removals, npm audit fixes, and outdated updates as diffs.

Commit and pull request review is read-only. Applying a dependency
proposal stages the files and runs `npm i` or `npm uninstall`.

Intra-line highlighting paints the words that actually changed in a
stronger red/green. A close edit inside one word still marks only
those characters.

## Install

```bash
npm i -g reslop
```

## Usage

```bash
reslop
reslop -n
reslop path/file
reslop 7ac260c
reslop https://github.com/metarhia/metacom/pull/555
```

Reviews go in `.review/YYYY-MM-DD-NN.md` with frontmatter `status`:

- `editing`: still writing the review in reslop
- `ready`: ready for AI to work through the checkboxes
- `partial`: AI started; some items remain
- `done`: all items marked `[x]`

## Keys and buttons

| Key         | Action                                   |
| ----------- | ---------------------------------------- |
| `a`         | Stage this block (`git add`)             |
| `u`         | Unstage this block (keep worktree)       |
| `r`         | Restore this block to the last commit    |
| `s`         | Skip (leave unstaged, drop from review)  |
| `←` / `k`   | Previous remaining block / previous file |
| `→` / `j`   | Next remaining block / next file         |
| `Ctrl-e`    | Scroll down one line                     |
| `Ctrl-y`    | Scroll up one line                       |
| `Ctrl-f`    | Scroll page down                         |
| `Ctrl-b`    | Scroll page up                           |
| `Ctrl-d`    | Scroll half-page down                    |
| `Ctrl-u`    | Scroll half-page up                      |
| `l`         | File list (git status of this scope)     |
| `Esc`       | Quit file list or a tool                 |
| `m`         | Cycle unified / mixed / side-by-side     |
| `f`         | Feedback on this diff block              |
| `t`         | New todo for this file                   |
| `⌫` / `Del` | Remove the selected todo                 |
| `⏎`         | Open the selected file                   |
| `q`         | Quit                                     |
| `?`         | Help                                     |

## License

Copyright (c) 2026 Timur Shemsedinov.
This is [MIT](./LICENSE) licensed software.
