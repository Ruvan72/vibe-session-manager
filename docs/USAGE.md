# Using Vibe Session Manager

## The list

The list is a normal window: it shows in the taskbar and Alt+Tab, and remembers where you put it. Closing it hides it to the tray, and clicking the tray icon brings it back. To stop the app, use **Quit** in the tray menu. Turn on **Start at login** in Settings or the tray menu so the app is there after a restart.

Click a session to show its details (last prompt, last reply, time) and click again to hide them. Double-click opens the session in its editor.

**Hide** (right side of the details) leaves a session out of the list, the counts, the tray badge and notifications. Its files are not touched, and it can be undone: the eye next to Sessions/Time shows hidden sessions (dimmed), and their details have **Unhide**. Hidden sessions are stored in `~/.vibe-session-manager/state.json`. Their time still counts in the Time tab.

**Rename** a Claude Code session with the pencil that appears right of its title when you point at it, or with `F2`. A small field opens over the title with the title selected: `Enter` keeps the new name, `Esc` or clicking elsewhere cancels. The name is stored in the session's own transcript as a `custom-title` line, the same way Claude Code's `/rename` does it, so Claude Code shows it too. Codex sessions cannot be renamed here: Codex also keeps the title in a SQLite database the app does not touch, so Codex would go on showing the old name.

**Labels** (details, or `Ctrl+L`) mark sessions as to-dos. It opens a checklist with **Pending merge**, **Needs attention**, **Review with peer** and any labels you added yourself. Below the list you can type a new label, pick one of 10 icons and add it. The × next to a label deletes it everywhere. A session shows its labels on its row, comma-separated, and each label in use gets a chip next to **Open only** that filters the list. Labelled sessions stay in the list whatever the time range is. Labels do not change the traffic light or the tray badge. They are stored in `~/.vibe-session-manager/labels.json`.

**Search** matches titles, repo, worktree and branch names, folders and the conversation itself (prompts, replies and pasted text, not tool output). Type `claude` or `codex` to see only one agent.

## Shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+Alt+Space` (global) | Open the list with focus in search |
| `Ctrl+Alt+Enter` (global) | Jump to the most urgent session (red before yellow, longest waiting first). Press again for the next one |
| `Ctrl+F` | Go to search (selects what is there) |
| `↑` `↓` `Enter` | Select, open |
| `→` / `←` | Show / hide details |
| `Ctrl+1` … `Ctrl+9` | Open row 1–9 |
| `Ctrl+E` | Toggle seen / unread. A red or yellow session is marked as seen, a grey one as unread (yellow). No effect on a working (green) session |
| `Ctrl+U` | Mark as unread: the session turns yellow again until you write in it or mark it as seen |
| `Ctrl+L` | Labels for the selected session |
| `F2` | Rename the selected Claude Code session |
| `Ctrl+T` | Switch between Sessions and Time |
| `Ctrl` `+` / `Ctrl` `-` / `Ctrl+0` | Larger / smaller / normal text. The size is remembered |
| `Esc` | Clear search, then minimize |

You can change the global shortcuts in Settings.

## Traffic light

| | Meaning |
|---|---|
| Red | Waiting for you: permission or question. Dashed ring with `?` = guessed |
| Green | Working. A ring turns around the play icon |
| Yellow | Finished a turn you have not seen |
| Grey | Nothing to do. Filled dot = open, ring = closed |

When a session finishes a turn, the app plays a short "blop", but not when that session's own window is in front: a VS Code or Cursor window on its folder, or the Codex app for Codex app threads. To check that, the app reads the title of the window in front (it takes about a second, so the sound comes a moment after the turn ends). Several sessions finishing together make one sound. Turn it off, or let it always play, under Settings → Sound.

The tray icon shows the number of red and yellow sessions. While a session is working, a green ring turns around it, and the taskbar button shows Windows' moving green progress bar.

### Claude Code hooks (optional)

Without hooks, the light is guessed from the end of the transcript. **Install hooks** (banner, Settings or tray menu) adds a small hook to `~/.claude/settings.json` for the `Notification`, `Stop`, `UserPromptSubmit`, `SessionStart` and `SessionEnd` events. The hook records session id, event name, time and notification text in `~/.vibe-session-manager/events.jsonl`. It never records prompts, always exits 0 and gives up after 800 ms, so it cannot block Claude Code.

Existing hooks and settings are kept, a backup is written to `settings.json.vsm-backup` the first time, and the hooks can be removed again from the same places.

## Codex

Sessions from OpenAI Codex (the Codex app, the Codex VS Code extension and the CLI) are listed next to the Claude Code sessions. An icon left of the title shows which agent a session belongs to: a starburst for Claude Code, `>_` for Codex.

The app reads `~/.codex` (set `VSM_CODEX_DIR` to use another folder) and never writes to it:

- the conversation files in `sessions/`, for prompts, replies, folder, branch and activity,
- `session_index.jsonl` for the titles the Codex UI shows,
- `thread-writer-locks/`, which shows which threads Codex has open.

Status and activity:

- **Green** while Codex works on a turn. A turn that has written nothing for 30 minutes counts as stuck, not working.
- **Yellow** when a turn finished and you have not seen it. This comes from Codex's own turn events, so it is reliable without any hooks.
- **Red is not shown for Codex.** Codex does not write anything to disk when it waits for an approval, so a waiting session shows as green.
- **Grey** with a filled dot while Codex has the thread open, a ring when it is closed.
- Active time counts in the Time tab like Claude Code sessions.

Subagent and review threads are left out, as in Codex's own list. A new Codex chat shows up once you have sent its first message; Codex does not save it before that.

Double-clicking a session opens it where it was started: `codex://threads/<id>` for the Codex app, the folder plus `vscode://openai.chatgpt/local/<id>` for the VS Code extension, and for the CLI the command `codex resume <id>` is copied.

## Time tracking

The **Time** tab (`Ctrl+T`) shows active time per day: a total, then each repo, then each session with its periods. A pause longer than the idle gap (90 min by default, see Settings) ends a period and is not counted. Sessions that run in parallel both count, so a day's total can be longer than the day. **Copy day as CSV** puts the day on the clipboard, separated by semicolons.

Time is stored as one JSON file per day in `~/.vibe-session-manager/time/`. The files keep the time after Claude Code deletes old transcripts. The CSV has an `agent` column (`claude` or `codex`).

## Files the app keeps

Everything lives in `~/.vibe-session-manager/`:

| File | Content |
|---|---|
| `config.json` | Settings |
| `state.json` | Seen marks, unread marks and hidden sessions |
| `labels.json` | Labels and which sessions have them |
| `time/<YYYY-MM-DD>.json` | Active time per day |
| `window.json` | Window position and size |
| `hook.cjs`, `events.jsonl` | The Claude Code hook and the events it records (only if hooks are installed) |

Deleting the folder resets the app. Remove the hooks first (Settings), or Claude Code will report a missing hook script.
