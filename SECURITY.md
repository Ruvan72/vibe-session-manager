# Security policy

## Supported versions

Only the latest release gets security fixes.

## Reporting a vulnerability

Please **do not open a public issue** for a security problem. Report it privately through GitHub instead: on the repository's **Security** tab, click **Report a vulnerability** ([direct link](https://github.com/Ruvan72/vibe-session-manager/security/advisories/new)).

Say what the problem is, how to reproduce it and what an attacker could do with it. You will get an answer within a week. Once a fix is released, you are credited in the advisory unless you prefer not to be.

## What is in scope

The app reads files that can contain secrets, and it changes a few files outside its own folder, so these matter most:

- Anything that could make transcript content leave the machine.
- The hook installer, which edits `~/.claude/settings.json`, and the hook script it installs, which Claude Code runs on every hook event.
- The rename feature, which appends a line to a session transcript.
- Opening sessions: the launcher runs the editor's command line and opens `vscode://`, `cursor://` and `codex://` links built from data in session files.
- The installer and the release builds.

Problems in Claude Code, Codex, VS Code or Electron themselves should go to those projects.
