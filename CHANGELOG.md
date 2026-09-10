# Changelog

## [Unreleased][unreleased]

- Dependency review: each dependency once across package.json and package-lock
- Mark unused npm dependencies: that are not imported or used
- Mark dependency review items, show npm audit findings
- Show npm outdated and npm audit updates as proposed diffs
- Propose a lockfile version bump for transitive dependencies

## [0.1.1][] - 2026-09-10

- Open a GitHub pull request by URL and review its diff
- Import GitHub pull request review comments into the local review
- Improve TUI navigation and hotkeys
- CLI simplification and optimisation
- Fix diff highlighting for snake_case identifier changes
- Updated package metadata and README

## [0.1.0][] - 2026-09-07

- Interactive review of uncommitted git diffs with stage, unstage, revert
- Feedback and todos that produce a repair plan for an agent
- Intra-line highlighting in unified, mixed, and side-by-side layouts

[unreleased]: https://github.com/tshemsedinov/reslop/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/tshemsedinov/reslop/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/tshemsedinov/reslop/releases/tag/v0.1.0
