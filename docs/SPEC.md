# Vibe Session Manager — requirements specification (desktop app)

Status: 2026-10-01. Phase 1 (MVP) is built, see README.md. Codex sessions (5.6), text size (3.3.1) and a standalone .exe (4.2) have been added. Jumping to a session via URI, and hooks against the real `~/.claude`, have not been tested yet.

## 1. Purpose

When you work with Claude Code in several VS Code windows at the same time (typically one per git worktree), you lose track of:

- which sessions exist, and in which repo, worktree and branch they are running,
- what each session is about, and when something last happened,
- which sessions are waiting for you (a question or a permission).

Claude Code's own history in VS Code only shows sessions for the folder that is open in the window. A session started in a worktree window can therefore not be found from the main repo's window.

The app gives one combined overview across all windows and editors, and with one click it can jump to the right window with the right session open.

The same applies to OpenAI Codex (the Codex app, Codex's VS Code extension and the CLI). Its sessions are shown in the same list, so there is one place for both agents (decided 2026-10-01).

## 2. Scope

- **Local sessions only.** Sessions running in the cloud on claude.ai/code or as Codex cloud tasks are not on disk and are not included.
- **The app only reads.** It never changes Claude Code's or Codex's files. There are two exceptions: a one-time setup of hooks in `~/.claude/settings.json`, which the user must approve, and renaming a Claude Code session (6), which appends one line to the session's transcript, exactly like Claude Code's own `/rename`.
- **No transcripts leave the machine.** See section 7.

## 3. What it must do

### 3.1 Session overview (MVP)

For each session the following is shown:

| Field | Content |
|---|---|
| Agent | Claude Code or Codex, shown as an icon to the left of the title (Claude's orange star / Codex's `>_`) |
| Title | Claude Code's auto-title, or the last prompt as a fallback. For Codex: the title from Codex's own list |
| Repo | The main repo's name, also for worktrees |
| Worktree / branch | Worktree name (if there is one) and git branch, including branch switches during the session |
| Home folder | The folder the session was started in (not the current `cwd`, see 5.1) |
| Timestamps | First and last activity |
| Live status | `busy` / `idle` / `closed` |
| Needs attention | Waiting for permission, has asked a question, or has finished a turn the user has not seen |
| Traffic light | Overall state, see 3.1.1 |
| Editor | VS Code, Cursor, terminal, etc. (from `entrypoint`) |

The default view is a **flat list sorted by date** (latest activity, newest first) with repo and worktree/branch on each row. Grouping by **repo** can be turned on: repos are sorted by name, within each group sessions are still sorted by date, and worktree/branch is shown on each row as in the flat list (decided 2026-10-06). There must be filters for traffic light color, "running now" and time range (today / 3 days / all), and a search field (3.5). Next to "Open only" is a dropdown with a checkbox per repo (with the number of sessions); if any are checked, only those repos are shown, otherwise all (decided 2026-10-05).

#### 3.1.1 Traffic light

Each session has one color that shows whether it needs something from the user:

| Color | Meaning | Source |
|---|---|---|
| Red | Waiting for you: permission or question | `Notification` hook. Without hooks: a guess from the transcript (5.3), shown as a red ring = "maybe" |
| Green | Working. An arc spins around the play icon (as in the tray icon) | live status `busy` |
| Yellow | Finished a turn you have not seen | `Stop` hook after the latest `UserPromptSubmit` |
| Gray | Nothing to do: seen and `idle`, or closed | — |

If several states apply, the first in the table wins (red before green before yellow before gray). The color is always shown together with an icon, so it can also be read without color vision.

For Codex, green and yellow come from Codex's own turn events (5.6), so they are reliable without hooks. Red is not shown for Codex, because Codex writes nothing when it is waiting for an approval.

### 3.2 Jump to session (MVP)

Double-click anywhere on a session's row (or press Enter on the selected row). A single click instead shows the detail (decided 2026-10-02), so you can read the last prompt and answer without leaving the list:

1. The VS Code window that has the session's home folder open is focused. If there is none, the folder is opened in a new window.
2. The session is opened in the Claude Code panel in that window.

For other editors and for Codex, see 5.4.

### 3.3 Notifications (MVP)

- The tray icon shows a badge with the number of red and yellow sessions. The badge is red if at least one is red, otherwise yellow.
- While at least one session is working (green), a green ring spins around the tray icon (one revolution per second, with the badge inside), and the taskbar button shows Windows' own indeterminate progress animation (decided 2026-10-02).
- An OS notification is shown when a session turns red. Clicking the notification jumps to the session (3.2). Notifications for yellow can be turned on in the settings (off by default, since it would otherwise fire after every turn).
- **Sound** (decided 2026-10-02): when a session finishes a turn, the app plays a short "blop" (synthesized, no sound file). The sound is skipped if the session's own window is in the foreground: a VS Code/Cursor window whose title contains the session's folder name (or workspace name), or the Codex app for threads started there. The foreground window's title is read with PowerShell (`GetForegroundWindow`), on Windows only; this takes about a second. Several sessions finishing at the same time produce one sound. The sound can be turned off, and "only when the window is not in the foreground" can be turned off, under Settings → Sound.
- Red and yellow are cleared when the user types in the session, or when it is marked as seen in the app.
- A session can be **marked as unread** (`Ctrl+U` or a button in the detail), e.g. when you have read the answer but cannot deal with it right now. It turns yellow again, even if it is closed, until you type in it or mark it as seen. Red and green still take precedence.

### 3.3.1 Shortcuts to what is urgent (MVP)

| Shortcut (default, can be changed) | Effect |
|---|---|
| Global: `Ctrl+Alt+Enter` (macOS `Cmd+Alt+Enter`) | Jump directly to the most urgent session: red before yellow, and the one that has waited longest first. Press again for the next one |
| Global: `Ctrl+Alt+Space` (macOS `Cmd+Alt+Space`) | Open the list with focus in the search field |
| In the list: `Ctrl+F` | Go to the search field and select the text |
| In the list: `↑` / `↓`, `Enter` | Select row, jump to session |
| In the list: `→` | Show detail |
| In the list: `Ctrl+1` … `Ctrl+9` | Jump to row 1–9 |
| In the list: `Ctrl+E` | Toggle between seen and unread (decided 2026-10-02): a red or yellow session is marked as seen, a gray one as unread (yellow again). A green session (working) is not affected, and the button in the detail is disabled |
| In the list: `Ctrl+U` | Mark the selected session as unread (yellow again) |
| In the list: `Ctrl+L` | Open the label list for the selected session (3.8) |
| In the list: `F2` | Rename the selected Claude Code session (6) |
| In the list: `Esc` | Clear search, otherwise close the window |
| In the window: `Ctrl` `+` / `Ctrl` `-` / `Ctrl+0` | Larger / smaller / normal text, as in an editor. The size is remembered (`zoomLevel` in `config.json`) |

### 3.4 Summaries (phase 2)

- A 2–3 sentence summary per session, generated with Claude Haiku when the session goes `idle`.
- Input: the user's prompts and Claude's last answer. Not tool calls and their output.
- The result is cached per session and only regenerated when the session has new activity.
- Must be possible to turn off. It sends session content to Anthropic's API.

### 3.5 Search (MVP)

- Free-text search in titles, the whole conversation (the user's prompts, Claude's and Codex's answers and pasted text, but not tool calls, their output or subagents), repo, worktree, branch and folder names, and agent (`claude` / `codex`) across all sessions. Summaries are included in phase 2.
- The list is filtered as you type. Words are matched regardless of order and case, and matches are highlighted.
- Search ignores the time filter, so older sessions can also be found.
- The index is built in the background at startup and is kept in memory only. Each prompt, each answer and each piece of pasted text is stored with at most 20,000 characters. The conversation text is not written to disk by the app (see 7).

### 3.6 Web view (phase 3, optional)

View the overview from another machine or a phone. Only metadata is synchronized (see 7).

### 3.7 Time tracking (MVP)

- For each session, the active time and the periods it was active in are shown (e.g. 08:02–09:15, 10:30–11:05).
- **Active time** is calculated from the timestamps in the transcript: activity with at most the *idle gap* in between (default 90 minutes, can be changed) belongs to the same period. A longer pause starts a new period and is not counted. A tool call that runs longer than the idle gap without writing anything is therefore not counted either.
- The **Time** tab shows one day at a time: total, per repo, and per session with periods. The totals add up the sessions' time: if two sessions run at the same time, the time counts for both (decided 2026-10-01). Left/right arrow switches day. Clicking a session jumps to it.
- **Copy day as CSV** (semicolon-separated, so Excel with e.g. Danish regional settings opens it directly): date, repo, worktree, branch, title, start, end, active minutes, periods, agent.
- Codex sessions are counted the same way. The activity is the timestamps in Codex's rollout files (5.6).
- The detail view shows time today, total time, and today's periods.

### 3.8 Labels (decided 2026-10-02)

A session can have one or more **labels**, e.g. that the work is waiting for a merge. Labels are a reminder list, not a state.

- Built-in labels: **Pending merge** (merge icon), **Needs attention** (flag), **Review with peer** (people). You can add more yourself and delete all of them, including the built-in ones.
- The **Labels** button in the detail (or `Ctrl+L`) opens a list with checkboxes: one per label. At the bottom you can type a new label and choose one of 10 icons: merge, flag, people, bug, star, clock, rocket, question, bookmark, blocked. The new label is applied to the session immediately. The cross next to a label deletes it entirely (after confirmation).
- The row shows the labels comma-separated with icon, in purple, after repo · branch. In the grouped view, the worktree/branch heading gets the labels' icons.
- For each label in use, a chip with a count is shown next to "Open only". It filters the list to that label.
- Sessions with labels stay in the list regardless of the time filter until the labels are removed. Searching for a label's name finds them.
- Labels do not affect the traffic light, the tray badge or the notifications, since they can stay on for days.
- Stored in `labels.json` in the app's data folder: the labels' name and icon, and which labels each session has.
- Not built: "Pending merge" being removed automatically when the branch has been merged (requires `git branch --merged` and knowledge of the main branch per repo).

## 4. Architecture

```
┌─────────────────────────── Desktop app (Electron, tray) ────────────────────────────┐
│                                                                                     │
│  core (TypeScript, no Electron dependencies)                                        │
│   ├─ transcript-reader   ~/.claude/projects/**/*.jsonl                              │
│   ├─ live-status-reader  ~/.claude/sessions/*.json                                  │
│   ├─ hook-event-reader   ~/.vibe-session-manager/events.jsonl                       │
│   ├─ codex-reader        ~/.codex/sessions/**/rollout-*.jsonl + index + locks       │
│   ├─ session-model       merges the sources into one list                           │
│   └─ launcher            jump to session (VS Code / Cursor / terminal)              │
│                                                                                     │
│  ui (renderer)           list, filters, detail view                                 │
│  tray + notifications                                                               │
└─────────────────────────────────────────────────────────────────────────────────────┘
        ▲ writes events                          │ opens window + session
        │                                        ▼
  hook script (Node)                     code <folder>  +  vscode://anthropic.claude-code/open?session=<id>
  called by Claude Code
```

### 4.1 Technology choices

- **Electron + TypeScript** (decided 2026-10-01). `core` is plain TypeScript/Node, so the same module can be reused unchanged in a VS Code extension or a Node backend for the web view. Tauri was rejected: its backend is Rust, so `core` would have to be rewritten or run as a separate Node process alongside it.
- **Cross-platform** (Windows, macOS, Linux): no native Node modules. Paths are always built with `path.join` and `os.homedir()`.
- **Packaging:** `electron-builder` (decided 2026-10-01), see 4.2.
- **Why an app and not a VS Code extension:** with worktrees you always have several windows open. One app means one instance (notifications only arrive once), also works with Cursor and the terminal, and can control which window gets focus. A VS Code extension can be added later on top of `core`.

### 4.2 Standalone .exe

`npm run dist` builds two files in `dist/` that do not require Node or the source code:

- **Installer** (`Vibe Session Manager Setup <version>.exe`, NSIS): installs for the current user only in `%LOCALAPPDATA%\Programs` without administrator rights, creates a Start menu shortcut, and can be uninstalled from Windows Settings. Recommended.
- **Portable** (`Vibe Session Manager <version> portable.exe`): a single file without installation. It unpacks itself into a temp folder on every start and therefore starts a little slower. "Start at login" points to the .exe file itself (`PORTABLE_EXECUTABLE_FILE`), not the temp folder.

Both use the same data folder (`~/.vibe-session-manager`) as the development build. The icon is drawn by the same code as the app's own icon (`scripts/app-icon.ts` → `build/icon.png`). The files are not code-signed, so SmartScreen warns the first time (see 8.4). macOS (`.dmg`) and Linux (`AppImage`) are configured in `package.json`, but must be built on that operating system and have not been tested.

## 5. Data sources

All formats below are **internal and undocumented** in Claude Code (observed in v2.1.281–2.1.286) and Codex (observed in v0.153–0.155). All parsing must live in `core`, be tolerant of unknown and missing fields, and fail per session instead of bringing down the whole list.

### 5.1 Transcripts — `~/.claude/projects/<encoded-path>/<sessionId>.jsonl`

One file per session, one JSON line per event. The folder name is the session's start folder with `:`, `\`, `/` and `.` replaced by `-`. Subagents are in `<sessionId>/subagents/` and must be ignored.

| Field / line type | Used for |
|---|---|
| `timestamp` (all lines) | first and last activity |
| `gitBranch` (all lines) | branch, including switches along the way |
| `cwd` (all lines) | **not** the home folder: follows every `cd` Claude makes |
| `attachment.type === "environment"` → `snapshot.isWorktree`, `snapshot.workingDirectory` | worktree flag and home folder (use the first one) |
| `type: "custom-title"` → `customTitle` | title the user has given the session (takes precedence over `aiTitle`) |
| `type: "ai-title"` → `aiTitle` | title (the latest one applies) |
| `type: "last-prompt"` → `lastPrompt` | fallback title |
| `type: "relocated"` → `relocatedCwd` | the session has been moved into a worktree; the transcript is now under the worktree's folder, and this becomes the home folder |
| `type: "worktree-state"` → `worktreeSession.worktreeName` | worktree name |
| `type: "user"` / `"assistant"`, `isSidechain`, `isMeta` | conversation content; skip `isSidechain`/`isMeta` |
| `origin.kind` on `user` lines | only `human` (or missing) are the user's own prompts; `task-notification` and `peer` are system messages |
| `entrypoint` | editor (`claude-vscode`, `cli` …) |

The files can be large (over 20 MB). Read incrementally: store a byte offset per file and only read new lines when the file grows.

### 5.2 Live status — `~/.claude/sessions/<pid>.json`

One file per running Claude Code process, e.g.:

```json
{"pid":31000,"sessionId":"2db47ab1-…","cwd":"c:\\dev\\…\\my-app","kind":"interactive",
 "entrypoint":"claude-vscode","name":"my-app-81","status":"idle",
 "updatedAt":1790260497737,"statusUpdatedAt":1790260497737,"version":"2.1.281"}
```

- `status` has been observed as `busy` and `idle`.
- A file can be left behind after a crash: check that `pid` is still running before the session is shown as live.

### 5.3 Hook events — `~/.vibe-session-manager/events.jsonl` (the app's own file)

This is the documented and reliable source for "needs attention". The app installs (after approval) a small Node script as a hook in `~/.claude/settings.json` for these events:

| Hook | Meaning in the app |
|---|---|
| `Notification` | the session is waiting for permission or input → **attention** |
| `Stop` | Claude has finished a turn → "unread answer" |
| `UserPromptSubmit` | the user has typed → clear attention |
| `SessionStart` / `SessionEnd` | quick update of the list |

The script reads the hook's JSON from stdin (`session_id`, `transcript_path`, `cwd`, `hook_event_name`, and `message` for `Notification`) and appends a line `{sessionId, event, message, time}` to `events.jsonl`. It must never block or fail noticeably: always exit 0, timeout under 1 second.

The setup must merge into existing hooks, not overwrite them, and must be removable again from the app.

Fallback without hooks: guess from the end of the transcript (a tool call without a result suggests a permission prompt, an answer ending in "?" suggests a question). Shown as "maybe".

### 5.4 Jump to session — launcher

**VS Code** (needs testing, see 8):

1. `code <home folder>`. If the folder is already open, that window gets focus. Otherwise a new one is opened.
2. Open `vscode://anthropic.claude-code/open?session=<sessionId>`. The Claude Code extension (v2.1.286) has a URI handler for `/open` that takes `session` (and optionally `prompt`) and calls `claude-vscode.primaryEditor.open`. VS Code sends the URI to the window that has focus, which is the one step 1 selected.

**Workspace files:** VS Code only reuses a window when it gets exactly what the window has open. If the folder was opened via a `.code-workspace` file, `code <folder>` opens a new window. The launcher therefore gives the CLI, in order of priority: (1) the open window (folder or workspace file from VS Code's `storage.json`) that shows the session's folder, (2) a workspace file in the folder or in a parent folder that contains it, (3) the folder itself. A window on the main repo is not used for a session in one of its worktrees.

The handler is not documented and may change. On failure the app falls back to step 1 alone and copies the session ID to the clipboard.

If the deep link does not work reliably (wrong window, or the handler disappears), a small VS Code companion extension will be built that focuses the window and opens the session itself. The launcher is therefore built so that the "open session" step itself can be swapped out.

**Cursor:** the same approach with `cursor <folder>` and `cursor://anthropic.claude-code/open?session=…` (not verified).

**Terminal / other editors:** open a terminal in the home folder with `claude --resume <sessionId>`.

**Codex** (based on `originator` in the session's `session_meta`):

| Started from | Jump |
|---|---|
| Codex app (`codex_work_desktop`) | `codex://threads/<threadId>`. This is the link Codex itself copies |
| VS Code extension (`codex_vscode`) | `code <home folder>` as above, then `vscode://openai.chatgpt/local/<threadId>`. The extension's URI handler passes the path on to its webview, which shows the conversation at `/local/<id>`. Found in the extension's code, not tested |
| CLI (`codex_cli_rs`, `codex_exec`) | `codex resume <threadId>` is copied |

Windows: `code` is `code.cmd` and must be started with `shell: true`. URIs are opened with `shell.openExternal` from Electron.

### 5.5 Time data — `~/.vibe-session-manager/time/<YYYY-MM-DD>.json` (the app's own file)

One JSON file per local day. Chosen because it is the simplest thing that works: no database or native modules, the files can be read and edited by hand, and they survive Claude Code deleting old transcripts.

```json
{
  "date": "2026-10-01",
  "sessions": {
    "<sessionId>": {
      "title": "Add notes field to API",
      "repo": "my-app",
      "worktree": "notes-field",
      "branch": "fix/api/notes-field",
      "folder": "C:\\dev\\my-app\\.claude\\worktrees\\notes-field",
      "activeSeconds": 2280,
      "intervals": [["2026-10-01T08:17:02+02:00", "2026-10-01T08:55:40+02:00"]]
    }
  }
}
```

- The transcript is the source as long as it exists: a session's periods are recalculated and replaced on the days the session spans. Days outside the span are not touched, so time from deleted transcripts is kept.
- Periods that cross midnight are split between the two days.
- The file stores agent, title and folder, but no prompts. Files from before Codex support have no `agent` and are Claude Code.

### 5.6 Codex — `~/.codex/`

Read only. The folder can be changed with `VSM_CODEX_DIR`.

| File | Used for |
|---|---|
| `sessions/YYYY/MM/DD/rollout-<time>-<threadId>.jsonl` | The conversation, one JSON line per event: `{timestamp, type, payload}`. A long thread continues in a new file `rollout-<time>-<threadId>_<segmentId>.jsonl` (with `history_base` in `session_meta`); the files are read in name order as one session |
| `session_index.jsonl` | `{id, thread_name}`: the title Codex shows. A later line for the same id wins (rename) |
| `thread-writer-locks/<threadId>.lock` | Exists while a Codex process has the thread open. Used as "open" (live status) |

Lines in the rollout file:

| Line type | Used for |
|---|---|
| `session_meta` → `cwd`, `git.branch`, `originator`, `cli_version` | home folder (without the `\\?\` prefix), branch, editor (5.4), version |
| `session_meta` with `parent_thread_id` or `source.subagent` | subagent and review threads; hidden, as in Codex's own list |
| `event_msg` `task_started` | a turn is in progress → **green**, as long as the thread is open and has written something within 30 minutes |
| `event_msg` `task_complete` | the turn is finished; corresponds to the `Stop` hook → **yellow** if you have not seen it |
| `event_msg` `turn_aborted` | the user aborted the turn; counts as seen |
| `event_msg` `item_completed` with `item.type` `UserMessage` / `AgentMessage` | prompts and answers. The VS Code extension prepends "# Context from my IDE setup" to the prompt; only the text after "## My request:" is used |
| `timestamp` (all lines) | first and last activity, time tracking |

Older Codex versions write `event_msg` `user_message` / `agent_message`; these are read too.

**What cannot be seen:** when Codex is waiting for an approval, nothing is written, so the session shows as green. A new chat only appears once the first message has been sent; before that, Codex has not stored anything. `state_5.sqlite` contains the same as the files above, but is not used: it requires an SQLite driver, and the number in the name changes with the schema.

## 6. UI

- **Tray icon** with a badge (number needing attention). Clicking it opens a small window with the list.
- **Global shortcuts** (configurable), see 3.3.1.
- **Search field** at the top of the list.
- **List:** flat and sorted by date, or grouped by repo → worktree/branch (3.1). Each row shows traffic light, agent icon, title, repo · branch and relative time. Clicking the row shows the detail, double-clicking jumps to the session. The row's tooltip says the same.
- **Hide** (decided 2026-10-02): the "Hide" button at the far right of the detail takes the session out of the list, the counters, the tray badge and the notifications. Claude Code's and Codex's files are not touched. An eye icon next to Sessions/Time shows the hidden sessions (dimmed, with "Unhide" in the detail). Hidden sessions are stored in `state.json` in the app's data folder. Their time still counts in Time. Deleting a session entirely is not built: it would break the principle that the app only reads (2), and for Codex it would leave broken rows in Codex's own databases.
- **Rename** (decided 2026-10-06): when the mouse is over the title of a Claude Code row, a pencil is shown to the right of it. Clicking the pencil (or `F2`) places a small field over the title with the current title selected. `Enter` saves, `Esc` or clicking elsewhere cancels; there is no save button. The new title is appended as a `custom-title` line (5.1) at the end of the transcript, so Claude Code and the VS Code extension show the same title. An empty or unchanged title writes nothing. Codex sessions cannot be renamed: Codex stores the title both in `session_index.jsonl` and in `state_5.sqlite`, and the app does not use SQLite (5.6), so Codex would keep showing the old title. A running Claude Code session keeps its title in memory; if you rename it in Claude Code afterwards, the newest one wins.
- **Detail** (click on the row, the arrow button on the right side of the row, or `→`): summary or last prompt, last answer, branch history, paths, session ID, and the buttons "Open", "Mark as seen" and "Copy resume command" (`claude --resume <id>` or `codex resume <id>`).
- **Keyboard:** see 3.3.1.
- Light and dark theme following the OS setting.
- Text size with `Ctrl` `+` / `-` / `0` (3.3.1).

## 7. Privacy and security

- Transcripts can contain confidential customer data (e.g. KYC information). It must **never** leave the machine through the app.
- Summaries (3.4) send an excerpt to Anthropic's API. This must be opt-in and possible to turn off per project.
- The web view (3.6) only synchronizes metadata: title, summary (if enabled), repo/branch name, timestamps and status. Login is required.
- The hook script only writes session ID, event name, time and the notification text. It writes no prompts.

## 8. Open questions and risks

1. **The URI jump has not been tested.** Does `vscode://…/open` always hit the window that just got focus, even when the window first has to be opened? This is **not a blocker**: if it does not work, it will be solved with a small VS Code companion extension (5.4).
2. **Undocumented formats** (5.1, 5.2, 5.6) can change with a Claude Code or Codex update. Mitigation: a tolerant parser, version checks, and showing "unknown format" instead of crashing.
3. **Several Claude installations** (VS Code, Cursor, CLI) share `~/.claude/`. This is confirmed for VS Code and the CLI, but not for Cursor.
4. **Distribution to others:** an installer and a portable .exe are built (4.2), but they are not code-signed, so SmartScreen warns ("More info" → "Run anyway"). Code signing on Windows and notarization on macOS are missing if the app is to be shared.
5. **Name:** the app is called "Vibe Session Manager" (package name `vibe-session-manager`).
6. **Codex in VS Code:** the jump via `vscode://openai.chatgpt/local/<id>` has not been tested (5.4).

## 9. Phases

| Phase | Content |
|---|---|
| 0 | Test the URI jump manually (8.1). Can happen in parallel with phase 1 |
| 1 (MVP) | `core` readers, session list sorted by date, traffic light, free-text search, shortcuts, time tracking, tray with badge, hook installation and events, jump to session for VS Code, Codex sessions, installer and portable .exe |
| 2 | Haiku summaries (also searchable), Cursor and terminal in the launcher |
| 3 | Optional web view (metadata only), optional VS Code extension on top of `core` |

## Appendix A — prototype scanner

Run 2026-10-01 against real data. Shows sessions from the last 3 days with status and an attention guess. It is the starting point for `core`.

```js
const fs=require("fs"),path=require("path"),os=require("os");
const root=path.join(os.homedir(),".claude");
const live={};
for(const f of fs.readdirSync(path.join(root,"sessions")).filter(f=>f.endsWith(".json"))){
  try{const o=JSON.parse(fs.readFileSync(path.join(root,"sessions",f),"utf8"));live[o.sessionId]=o}catch{}
}
const since=Date.now()-3*864e5, out=[];
for(const p of fs.readdirSync(path.join(root,"projects"))){
  const dir=path.join(root,"projects",p);
  for(const f of fs.readdirSync(dir).filter(f=>f.endsWith(".jsonl"))){
    const fp=path.join(dir,f); if(fs.statSync(fp).mtimeMs<since) continue;
    const s={id:f.slice(0,8),title:"",cwd:"",branch:"",worktree:false,first:null,last:null,lastPrompt:"",lastRole:"",pendingTool:false,lastText:""};
    for(const l of fs.readFileSync(fp,"utf8").split("\n")){ if(!l) continue; let o; try{o=JSON.parse(l)}catch{continue}
      if(o.timestamp){s.first??=o.timestamp; s.last=o.timestamp}
      if(o.cwd) s.cwd=o.cwd; if(o.gitBranch) s.branch=o.gitBranch;
      if(o.type==="ai-title") s.title=o.aiTitle;
      if(o.type==="last-prompt") s.lastPrompt=o.lastPrompt;
      if(o.attachment?.type==="environment") s.worktree=o.attachment.snapshot.isWorktree;
      if(o.type==="assistant"&&!o.isSidechain){const c=o.message.content||[];
        const t=c.filter(x=>x.type==="text").map(x=>x.text).join(" "); if(t) s.lastText=t;
        s.pendingTool=c.some(x=>x.type==="tool_use"); s.lastRole="assistant"}
      if(o.type==="user"&&!o.isSidechain){const c=o.message.content; const isResult=Array.isArray(c)&&c.some(x=>x.type==="tool_result"); if(isResult) s.pendingTool=false; else s.lastRole="user"}
    }
    const lv=Object.values(live).find(x=>x.sessionId.startsWith(s.id));
    s.status=lv?lv.status:"closed";
    s.attention = s.status==="busy"?"working": s.pendingTool?"waiting on permission?": /\?\s*$/.test(s.lastText.trim())?"asked you a question":"";
    out.push(s);
  }
}
out.sort((a,b)=>b.last.localeCompare(a.last));
for(const s of out) console.log(`${s.last.slice(5,16).replace("T"," ")} | ${s.status.padEnd(6)} | ${(s.attention||"-").padEnd(22)} | ${s.branch.padEnd(28)} | ${s.worktree?"WT ":"   "}${path.basename(s.cwd)} | ${s.title||s.lastPrompt.slice(0,50)}`);
```
