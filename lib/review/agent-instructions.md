Work through unchecked items.

- Run reviews with status `editing` or `partial`
- Do not start or change reviews with status `done`
- After finishing an item, mark it `[x]`
- Mark `[x]` only after the code changes are done and tests pass
- For `code` items, replace the added lines at the given location
- Set `status` to `partial` if any items remain, or `done` if all are `[x]`
- Do not redo items already marked `[x]`
- Run `npm t` for lint and tests that do not start processes
- Run tests that start processes with `reslop t -- node --test <files>`, never with bare `node --test`: it prints a reduced report and saves the raw log under `.log/`
- An item prefixed with `F<number>:` (case-insensitive, colon optional) gets its own commit in this repo
- Items with the same `F<number>` go into one commit
- Leave items without that prefix unstaged, do not commit or stage them
- Do not add `Authored-by` or `Co-authored-by` unless the issue asks for it
