# reslop

> Review diff and plan changes

- Prepare specs for the agent.
- Leave feedback, add todos.
- Generate a plan the agent executes.

Walk uncommitted git changes, a given commit, or a GitHub pull request.
Each contiguous block of diff lines can be staged, unstaged, reverted;
add review and todos. Commit and pull request review is read-only.

Intra-line highlighting paints the words that actually changed in a
stronger red/green. A close edit inside one word still marks only
those characters.

## Install

Global:

```bash
npm i -g reslop
```

Local:

```bash
npx reslop
```

Unregister:

```bash
npm run disable
```

## Usage

```bash
reslop
reslop -n
reslop path/to/folder
reslop path/to/file
reslop 7ac260c
reslop HEAD~1 path/to/file
reslop https://github.com/owner/repository/pull/123
reslop --help
```

Starts on the diff. No arguments, or a folder, reviews that scope.
A file argument opens that file's diff. A git revision that is not
also an existing path opens that commit's patch. Esc opens the file
list; Esc again quits.

Specs go in `.review/YYYY-MM-DD-NN.md` with frontmatter `status`:

| Status  | Meaning                                     |
| ------- | ------------------------------------------- |
| editing | Still writing the review in reslop          |
| ready   | Ready for AI to work through the checkboxes |
| partial | AI started; some items remain               |
| done    | All items marked `[x]`                      |

`reslop` resumes the latest file when its status is `editing`. Any other
status starts a new file. `-n` / `--new` always starts a new file. Quit asks
`f` (finish as `ready`, for the agent to execute) or `c` (keep `editing` and
continue next time). The agent should execute `ready` and `partial` reviews.
Files in `.review/` are omitted from the diff list.

A `##` heading names the file. Todos are checkboxes under it. Feedback is a
checkbox with ` - path:old:new:block` on the same line.

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
