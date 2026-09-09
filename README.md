# reslop — Review diff and plan changes

> Turn generated changes into owned changes

```text
Review → Plan → Repair → Verify
```

`0.1.x` implements Review: open a change, leave findings and todos, and
prepare a repair plan for the agent. Plan, repair, and verify come later.

- Prepare review findings and a repair plan for the agent.
- Leave feedback, add todos.
- Generate a plan the agent executes.

Walk uncommitted git changes, a given commit, or a GitHub pull request.
Each contiguous block of diff lines can be staged, unstaged, reverted;
add review and todos. Commit and pull request review is read-only.

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

| Key         | Action                                  |
| ----------- | --------------------------------------- |
| `a`         | Stage this block (`git add`)            |
| `u`         | Unstage this block (keep worktree)      |
| `r`         | Restore this block to the last commit   |
| `s`         | Skip (leave unstaged, drop from review) |
| `←`         | Previous remaining block                |
| `→`         | Next remaining block                    |
| `l`         | File list (git status of this scope)    |
| `Esc`       | Quit file list or a tool                |
| `m`         | Cycle unified / mixed / side-by-side    |
| `f`         | Feedback on this diff block             |
| `t`         | New todo for this file                  |
| `⌫` / `Del` | Remove the selected todo                |
| `⏎`         | Open the selected file                  |
| `q`         | Quit                                    |
| `?`         | Help                                    |

## License

Copyright (c) 2026 Timur Shemsedinov.
This is [MIT](./LICENSE) licensed software.
