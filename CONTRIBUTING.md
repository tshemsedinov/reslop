# Contributing

- [Issues](#issues)
- [Pull Requests](#pull-requests)

## Issues

There are two reasons to open an issue:

- Bug report
- Feature request

For bug reports, please include a clear and concise description, steps to
reproduce the behavior (a usage example or a test), and the expected behavior.
Provide the OS and Node.js version. You can upload screenshots and any other
context that helps.

Please don't open an issue to ask a question.

Issues on GitHub are for problems and feature requests, so please do not use
them to ask questions. Thanks for understanding!

If you have a question, please check our support groups and channels for the
developer community:

Telegram:

- Channel for Metarhia community: https://t.me/metarhia
- Group for Metarhia technology stack community: https://t.me/metaserverless
- Group for NodeUA community: https://t.me/nodeua

## Pull Requests

Before opening a pull request, please follow this checklist:

- [ ] tests and linter show no problems (`npm t`)
- [ ] tests are added/updated for bug fixes and new features
- [ ] code is properly formatted (`npm run fmt`)
- [ ] description of changes is added in CHANGELOG.md

## Slow tests

Tests that start git, node, or npm are slow on Windows. Run one file directly:

```sh
node --test test/git/git.test.js
```

Keep the setup of a test short: write the config of a repository with
`configureRepo` from `test/helpers.js` instead of `git config`.
