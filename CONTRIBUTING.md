# Contributing to Vibe Session Manager

Thanks for wanting to help. Bug reports, ideas and pull requests are all welcome.

## Reporting a bug or asking for a feature

Open an [issue](https://github.com/Ruvan72/vibe-session-manager/issues/new/choose). For bugs, say which version of the app, of Windows, and of Claude Code or Codex you use, since the app reads their undocumented session files and a new release of either can change them.

**Never paste a real transcript into an issue.** Transcripts can contain secrets and customer data. If a session is shown wrongly, describe it, or cut the transcript down to the few lines that matter and replace anything private.

Security problems go through [SECURITY.md](SECURITY.md), not public issues.

## Getting started

You need Windows, [Node.js](https://nodejs.org/) 22.6 or later and git.

```sh
git clone https://github.com/Ruvan72/vibe-session-manager.git
cd vibe-session-manager
npm install
npm run dev
```

`npm run dev` and `npm start` remove `ELECTRON_RUN_AS_NODE` first. VS Code's extension host sets it, so it is also set in terminals that Claude Code starts, and it makes Electron start as plain Node. If you start Electron another way, unset it yourself.

| Command | What it does |
|---|---|
| `npm run dev` | Run the app with hot reload of the UI |
| `npm run build && npm start` | Run a production build |
| `npm test` | Unit tests (core and list logic) |
| `npm run typecheck` | Type-check main, preload and renderer |
| `npm run scan [-- words]` | Print the session list from your real `~/.claude` and `~/.codex`, optionally searched |
| `npm run demo-data -- <dir>` | Create fake `.claude` and `.codex` folders with sessions in every state |
| `npm run dist` | Build the installer and portable `.exe` in `dist/` |
| `npm run dist:dir` | Build only the unpacked app in `dist/win-unpacked/`, which is quicker |

## Layout

- `src/core`: plain TypeScript/Node with no Electron dependency. The transcript, live-status and hook-event readers, the Codex reader (`codex.ts`), the session model, search, time tracking, the hook installer and the launcher.
- `src/main`: Electron main process (tray, window, shortcuts, notifications, IPC).
- `src/preload`, `src/renderer`: the list UI (React).
- `src/shared`: types shared by all of the above.
- `test`: Vitest tests. `test/core/helpers.ts` builds synthetic transcript lines.
- `docs/SPEC.md`: the requirements and design decisions, including what is known about the Claude Code and Codex file formats.

Keep Electron out of `src/core` so it stays testable with plain Node.

## Working with fake data

Do not develop against your real sessions if you can avoid it, and never point a development build at your real `~/.claude/settings.json` when you work on the hook installer. Use demo data instead:

```sh
npm run demo-data -- C:\tmp\vsm-demo
```

Then start the app with these environment variables:

| Variable | Use |
|---|---|
| `VSM_CLAUDE_DIR=<dir>/.claude` | Read Claude Code data from here instead of `~/.claude` |
| `VSM_CODEX_DIR=<dir>/.codex` | Read Codex data from here instead of `~/.codex` |
| `VSM_DATA_DIR=<dir>/data` | Keep the app's own data here instead of `~/.vibe-session-manager` |
| `VSM_ASSUME_ALIVE=1` | Treat every live-status file as a running process |
| `VSM_THEME=dark` or `light` | Force a theme |
| `VSM_SCREENSHOT=<file.png>` | Render the window once, save it and quit |
| `VSM_DEBUG='{"query":"x","expandFirst":true,"labelMenu":true,"grouped":true,"repoMenu":true,"rename":true,"settings":true}'` | Set up the view before a screenshot |

The README screenshots are made this way, from `npm run build` and `npx electron . --force-device-scale-factor=2`.

## Pull requests

1. For anything bigger than a small fix, open an issue first so we can agree on the approach.
2. Keep a pull request to one change. Add or update tests in `test/` for logic in `src/core`.
3. Run `npm run typecheck` and `npm test` before you push. CI runs both.
4. Match the surrounding code: its naming, comment style and formatting.
5. UI text is plain English and short.
6. Update [docs/USAGE.md](docs/USAGE.md) or the README when you change what users see, and add a line under "Unreleased" in [CHANGELOG.md](CHANGELOG.md).

By sending a pull request you agree that your contribution is licensed under the [MIT License](LICENSE).

## Making a release

Maintainers only:

1. Move the "Unreleased" entries in `CHANGELOG.md` under the new version and set `version` in `package.json`.
2. Commit, then tag and push: `git tag v0.2.0 && git push origin v0.2.0`.
3. The release workflow builds the installer and portable `.exe` and attaches them to a draft GitHub release. Check it and publish it.

## Code of conduct

This project follows the [Code of Conduct](CODE_OF_CONDUCT.md). Be kind.
