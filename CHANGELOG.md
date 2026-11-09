# Changelog

All notable changes are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **Archive** tab and an opt-in setting to keep a copy of every Claude Code, Cowork and Codex conversation, so it survives closed windows, removed worktrees and Claude Code's cleanup. Search all of it, read it as Markdown with the matches highlighted, and open a session from the results. When its folder or transcript is gone, the app asks and brings them back first. See [docs/USAGE.md](docs/USAGE.md#archive).

## [0.1.2] - 2026-11-03

### Added

- Cowork sessions from the Claude desktop app are listed next to Claude Code and Codex sessions, with the app's title, the chosen folder, live status and time tracking. See the Cowork section in [docs/USAGE.md](docs/USAGE.md).
- **Plan usage** under the title bar: how much of the 5-hour and weekly limits Claude and Codex have used, with the time to the next reset. Codex usage comes from its session logs. Live Claude usage is opt-in in Settings and asks Anthropic with the sign-in token Claude Code keeps. See [docs/USAGE.md](docs/USAGE.md#plan-usage).

## [0.1.1] - 2026-10-15

### Changed

- The search field is framed in the accent colour while a search is applied, so it is obvious the list is filtered.
- Releases ship with a `SHA256SUMS.txt` file, and builds are signed when signing is configured.

## [0.1.0] - 2026-10-07

First public release.

### Added

- One list of all local Claude Code and Codex sessions across editor windows and worktrees, with repo, worktree and branch.
- Traffic light per session (waiting, working, finished and unseen, idle), from transcripts or, more reliably, from optional Claude Code hooks.
- Jump to a session in VS Code or Cursor, the Codex app or the Codex VS Code extension, and a global shortcut to the most urgent session.
- Tray badge, notifications and a sound when a session finishes or needs you.
- Search across titles, repos, branches and conversation text.
- Labels, rename (for Claude Code sessions) and hide.
- Time tracking per day, repo and session, with CSV export.
- Windows installer and portable `.exe`.

[Unreleased]: https://github.com/Ruvan72/vibe-session-manager/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/Ruvan72/vibe-session-manager/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/Ruvan72/vibe-session-manager/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/Ruvan72/vibe-session-manager/releases/tag/v0.1.0
