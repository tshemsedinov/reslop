Work through unchecked items.

- Run reviews with status `editing` or `partial`
- Do not start or change reviews with status `done`
- After finishing an item, mark it `[x]`
- Mark `[x]` only after the code changes are done and tests pass
- For `code` items, replace the added lines at the given location
- Set `status` to `partial` if any items remain, or `done` if all are `[x]`
- Do not redo items already marked `[x]`
- Run the full check with `npm t`
- Run specific test files with `reslop t -- node --test <files>`
- An item prefixed with `F<number>:` gets its own commit in this repo
- Leave items without that prefix unstaged, do not commit or stage them
- Do not add `Authored-by` or `Co-authored-by` unless the issue asks for it
