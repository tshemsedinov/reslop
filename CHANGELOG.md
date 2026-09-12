# Changelog

## [Unreleased][unreleased]

## [0.1.3][] - 2026-09-12

- Showed added/removed and staged/total counts in the file list
- Highlighted JSX and TSX syntax, including
- Added vim-style j/k navigation and Ctrl scrolling
- Improved TUI/UX with background git and npm checks to avoid a freeze

## [0.1.2][] - 2026-09-11

- Review each dependency once across package.json and package-lock
- Mark unused npm dependencies that are not imported or used
- Propose unused dependency removals and run npm uninstall
- Mark dependency review items and show npm audit findings
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

[unreleased]: https://github.com/tshemsedinov/reslop/compare/v0.1.3...HEAD
[0.1.3]: https://github.com/tshemsedinov/reslop/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/tshemsedinov/reslop/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/tshemsedinov/reslop/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/tshemsedinov/reslop/releases/tag/v0.1.0
