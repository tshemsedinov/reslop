# metadiff

Interactive terminal review of uncommitted git changes, or of a given
commit. Each contiguous block of diff lines can be staged, unstaged,
reverted to `HEAD`, skipped, or stepped with next/prev. Commit review
is read-only.

Intra-line highlighting paints the words that actually changed in a
stronger red/green. A close edit inside one word still marks only
those characters.

Specs: [specs/README.md](specs/README.md).

## Install

From this directory, install the `metadiff` command on PATH (any repo):

```bash
npm run enable
source ~/.bashrc   # or open a new terminal
```

That links `~/.local/bin/metadiff` and writes `~/.bashrc.d/metadiff.sh`
so `~/.local/bin` is on PATH. After pulling changes, run enable again.
Uninstall with `npm run disable`.

```bash
metadiff
metadiff -n
metadiff path/to/folder
metadiff path/to/file
metadiff 7ac260c
metadiff HEAD~1 path/to/file
metadiff --help
```

No arguments, or a folder, opens a file list. A file argument opens
that file's diff. A git revision that is not also an existing path
opens that commit's patch.

Notes go in `.review/YYYY-MM-DD-NN.md` with frontmatter `status`:

| Status  | Meaning                                     |
| ------- | ------------------------------------------- |
| editing | Still writing the review in metadiff        |
| ready   | Ready for AI to work through the checkboxes |
| partial | AI started; some items remain               |
| done    | All items marked `[x]`                      |

`metadiff` resumes the latest file when its status is `editing`. Any other
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
| `m`         | Cycle unified / mixed / side-by-side    |
| `f`         | Feedback on this diff block             |
| `t`         | New todo for this file                  |
| `⌫` / `Del` | Remove the selected todo                |
| `⏎`         | Open the selected file                  |
| `q`         | Quit                                    |
| `?`         | Help                                    |

The footer draws the same actions as clickable words (the bound
letter is bold white; no `[a Add]` brackets). Drag to select text;
release copies to the clipboard (OSC 52, then `wl-copy` / `xclip` /
`xsel`).

## License

Copyright (c) 2026 Timur Shemsedinov.
This is [MIT](./LICENSE) licensed software.
