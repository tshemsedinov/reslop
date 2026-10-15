# Contributing

- [Issues](#issues)
- [Pull Requests](#pull-requests)

## Issues

There are two reasons to open an issue:

- Bug report
- Feature request

For bug reports please describe the bug with a clear and concise description,
steps to reproduce the behavior (usage example or test), expected behavior,
provide OS and Node.js version, you can upload screenshots and any additional
context for better understanding.

Please don't open an issue to ask questions.

Issues on GitHub are intended to be related to problems and feature requests
so we recommend not using this medium to ask them here grin. Thanks for
understanding!

If you have a question, please check out our support groups and channels for
developers community:

Telegram:

- Channel for Metarhia community: https://t.me/metarhia
- Group for Metarhia technology stack community: https://t.me/metaserverless
- Group for NodeUA community: https://t.me/nodeua

## Pull Requests

Before open pull request please follow checklist:

- [ ] tests and linter show no problems (`npm t`)
- [ ] tests are added/updated for bug fixes and new features
- [ ] code is properly formatted (`npm run fmt`)
- [ ] description of changes is added in CHANGELOG.md

## Slow tests

`npm test` does not run the files that start git, node, or npm processes.
On Windows each of those processes is slow, and together they were most of
the CI time. Run one of them directly:

```sh
node --test test/session.test.js
```

Run every process-starting file with `node scripts/run-tests.js --proc`.
The list is `PROCESS_TESTS` in `scripts/run-tests.js`. Add a new file there
when its tests start processes.

Starting a process is still slow on Windows. Keep the setup of a test short:
write the config of a repository with `configureRepo` from `test/helpers.js`
instead of `git config`. To see where the time goes:

- `node --test --test-reporter=./scripts/slow-tests.js` lists the slowest
  files and tests
- `node --require ./scripts/count-spawns.js --test` followed by
  `node scripts/count-spawns.js` counts the processes the tests start
