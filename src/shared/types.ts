// Types shared between core, the Electron main process and the renderer.

export type Light = 'red' | 'green' | 'yellow' | 'grey'
export type LiveStatus = 'busy' | 'idle' | 'closed'
/** Which agent the session belongs to: Claude Code, OpenAI Codex, or Cowork in the Claude desktop app. */
export type Agent = 'claude' | 'codex' | 'cowork'

export interface SessionView {
  id: string
  agent: Agent
  title: string
  /** Display name of the main repo, also for worktrees. */
  repo: string
  /** Normalised main-repo path, used for grouping. */
  repoKey: string
  worktree: string | null
  branch: string | null
  branches: string[]
  /** The folder the session lives in (the one the editor window must have open). */
  homeDir: string
  firstActivity: number
  lastActivity: number
  status: LiveStatus
  light: Light
  /** Hidden by the user: left out of the list, the counts and notifications unless shown. */
  hidden: boolean
  /** Ids of the labels the user put on the session (see LabelDef), in label order. Not part of the light. */
  labels: string[]
  /** True when the light is guessed from the transcript instead of hook events. */
  lightGuess: boolean
  reason: string
  waitingSince: number | null
  entrypoint: string | null
  editor: string
  lastPrompt: string
  lastReply: string
  version: string | null
  /** Active periods: activity with no gap longer than the idle gap setting. */
  intervals: Interval[]
  activeMs: number
  /** Set when the transcript could not be read. */
  error?: string
}

export interface Snapshot {
  sessions: SessionView[]
  hooks: HooksStatus
  scanning: boolean
  counts: { red: number; yellow: number; green: number }
  /** Changes only when searchable content changes, so the UI knows when to search again. */
  searchVersion: number
  /** All label definitions, in the order the label menu shows them. */
  labels: LabelDef[]
}

/** The icons a label can have. */
export const LABEL_ICONS = ['merge', 'flag', 'users', 'bug', 'star', 'clock', 'rocket', 'question', 'bookmark', 'block'] as const
export type LabelIcon = (typeof LABEL_ICONS)[number]

export interface LabelDef {
  id: string
  name: string
  icon: LabelIcon
}

/** The labels a new install starts with; the user can add and delete labels. */
export const DEFAULT_LABELS: LabelDef[] = [
  { id: 'pending-merge', name: 'Pending merge', icon: 'merge' },
  { id: 'needs-attention', name: 'Needs attention', icon: 'flag' },
  { id: 'review-with-peer', name: 'Review with peer', icon: 'users' }
]

export type HooksStatus = 'installed' | 'partial' | 'none' | 'error'

export interface SearchHit {
  id: string
  snippet: string | null
}

export interface AppSettings {
  notifyOnYellow: boolean
  /** Play a short sound when a session finishes a turn. */
  soundOnFinish: boolean
  /** …but not when the session's own window is in front (Windows; elsewhere the sound always plays). */
  soundOnlyWhenAway: boolean
  /** CLI used to focus/open the editor window, e.g. "code" or "cursor". */
  editorCommand: string
  /** URI scheme for the Claude Code extension's /open handler, e.g. "vscode" or "cursor". */
  uriScheme: string
  /** Wait between focusing the window and sending the session URI. */
  launchDelayMs: number
  /** Activity gaps longer than this end an active period (time tracking). */
  idleGapMinutes: number
  shortcuts: { openList: string; jumpUrgent: string }
  /** Text size as an Electron zoom level (0 = 100 %). Changed with Ctrl+plus, Ctrl+minus and Ctrl+0. */
  zoomLevel: number
  /** Show the 5-hour and weekly plan usage under the title bar. */
  showUsage: boolean
  /** Ask api.anthropic.com for live Claude usage, with the sign-in token Claude Code stores. Off until the user turns it on. */
  usageFromApi: boolean
  /** Keep a copy of every conversation in the app's data dir. Off until the user turns it on. */
  archiveConversations: boolean
}

export const DEFAULT_SETTINGS: AppSettings = {
  notifyOnYellow: false,
  soundOnFinish: true,
  soundOnlyWhenAway: true,
  editorCommand: 'code',
  uriScheme: 'vscode',
  launchDelayMs: 700,
  idleGapMinutes: 90,
  shortcuts: { openList: 'CommandOrControl+Alt+Space', jumpUrgent: 'CommandOrControl+Alt+Enter' },
  zoomLevel: 0,
  showUsage: true,
  usageFromApi: false,
  archiveConversations: false
}

/** What the archive remembers about a session, so it can be found after its transcript or folder is gone. */
export interface ArchiveSessionInfo {
  id: string
  agent: Agent
  title: string
  repo: string
  /** The main repo's folder, for recreating a worktree. */
  repoPath: string
  worktree: string | null
  branch: string | null
  /** The folder the session lives in. */
  homeDir: string
  entrypoint: string | null
  firstActivity: number
  lastActivity: number
}

/** Checked each time a session is listed: what is still on disk, and whether opening it must restore something first. */
export interface ArchiveOpenState {
  folderExists: boolean
  transcriptExists: boolean
  needsRestore: boolean
}

export interface ArchiveHit extends ArchiveSessionInfo {
  /** Text around the first match in the conversation; null when only the title or names match. */
  snippet: string | null
  open: ArchiveOpenState
}

export interface ArchiveDoc extends ArchiveSessionInfo {
  /** The conversation as Markdown. */
  markdown: string
  open: ArchiveOpenState
}

export interface ArchiveStatus {
  /** The user's "keep a copy of every conversation" setting. */
  enabled: boolean
  /** A pass over the sessions is under way. */
  running: boolean
  /** Sessions handled and in total in the current pass. */
  done: number
  total: number
  /** Sessions in the archive. */
  sessions: number
  bytes: number
  /** Changes when archived content changes, so the UI knows when to read again. */
  version: number
  dir: string
  /** The last error of a pass, if a session could not be copied. */
  error: string | null
}

/** One usage window (5 hours or a week). */
export interface UsageWindow {
  /** 0–100. */
  percent: number
  /** Epoch ms when the window resets; null when no window is running. */
  resetsAt: number | null
}

/** Where a usage reading came from: Claude's API, a status line cache file, or Codex's session logs. */
export type UsageSource = 'api' | 'statusline' | 'log'

export interface AgentUsage {
  source: UsageSource
  /** Epoch ms of the reading. */
  updatedAt: number
  fiveHour: UsageWindow | null
  sevenDay: UsageWindow | null
  /** Weekly limits that only count one model (Claude's Fable limit), when the API reports any. */
  scoped?: ScopedUsageWindow[]
}

export interface ScopedUsageWindow extends UsageWindow {
  /** What the limit counts, as the API names it ("Fable"). */
  name: string
}

export interface UsageSnapshot {
  /** The user's "show usage" setting. */
  enabled: boolean
  /** The user's "live Claude usage" setting. */
  fromApi: boolean
  claude: AgentUsage | null
  codex: AgentUsage | null
  /** Why live Claude usage is not available right now, for the UI. */
  claudeNote: string | null
}

export interface JumpResult {
  ok: boolean
  message?: string
}

/** [start, end] in epoch ms. */
export type Interval = [number, number]

/** One session's active time on one day, as stored in <dataDir>/time/<date>.json. */
export interface TimeEntry {
  /** Missing in files written before Codex support; those are all Claude Code. */
  agent?: Agent
  title: string
  repo: string
  worktree: string | null
  branch: string | null
  folder: string
  activeSeconds: number
  /** Local ISO times with offset, e.g. "2026-10-01T10:02:11+02:00". */
  intervals: [string, string][]
}

export interface DayFile {
  /** Local date, YYYY-MM-DD. */
  date: string
  sessions: Record<string, TimeEntry>
}

/** Agents that can do work from the Work tab; each needs its CLI on the machine. */
export type WorkAgent = 'claude' | 'codex'

/**
 * Where a worktree stands, in the order it is decided: its folder is gone, an agent is busy in it, it has
 * uncommitted files, it has no commits of its own yet, its commits are not in the base branch, or all is merged.
 * 'unpushed' is only for the repo's own folder: all is committed and merged, but the remote does not have it.
 */
export type WorkState = 'orphaned' | 'working' | 'uncommitted' | 'new' | 'pending-merge' | 'unpushed' | 'ready'

/** One checkout of a repo the app knows: a linked git worktree, or the repo's own folder when it has work in it. */
export interface WorkItem {
  /** Normalised folder path; what the actions take. */
  key: string
  repoPath: string
  repo: string
  /** The repo's own folder, not a linked worktree. It is never removed. */
  root: boolean
  /** The folder's name. */
  name: string
  path: string
  /** Null when HEAD is detached. */
  branch: string | null
  /** The branch its work goes back into: the one it was created from here, else the repo's default branch. */
  base: string | null
  state: WorkState
  /** Files with uncommitted changes, untracked ones included. */
  changed: number
  /** Commits that are not in the base branch. */
  ahead: number
  /** Commits not on the remote yet; null when the branch has never been pushed. */
  toPush: number | null
  hasRemote: boolean
  /** A session is open in the folder (working or waiting). */
  sessionOpen: boolean
  /** Locked with `git worktree lock`. */
  locked: boolean
  lastCommitAt: number | null
  /** The open pull request for its branch, as far as the app knows: one it made, or one the last refresh found. */
  pr: WorkPr | null
}

export interface WorkPr {
  number: number
  url: string
}

export interface WorkRepo {
  path: string
  name: string
  /** The branch checked out in the repo's root, which a new worktree branches from. */
  branch: string | null
  /** The repo's local branches, the one last committed to first: what a worktree's branch can be merged into. */
  branches: string[]
}

/** A commit, push or merge that is running or has just ended, with the text it printed. */
export interface WorkRun {
  id: number
  /** The WorkItem it works on. */
  key: string
  kind: 'commit' | 'push' | 'merge' | 'install' | 'pr'
  title: string
  agent: WorkAgent | null
  text: string
  status: 'running' | 'ok' | 'failed' | 'stopped'
}

/** One line of <dataDir>/work/journal.jsonl: something the Work tab did. */
export interface WorkJournalEntry {
  /** ISO time. */
  at: string
  action: 'create' | 'install' | 'commit' | 'push' | 'merge' | 'pr' | 'cleanup'
  repo: string
  repoPath: string
  worktree: string
  branch: string | null
  base: string | null
  agent?: WorkAgent
  ok: boolean
  detail?: string
  /** The heading time of its part of the command log. Entries from before the log had a part per action lack it. */
  log?: string
  /** The pull request that was opened. */
  url?: string
}

export interface WorkOverview {
  /** The agents whose CLI is installed. */
  agents: WorkAgent[]
  /** The agent the user picked last, if it is still installed. */
  agent: WorkAgent | null
  /** The GitHub CLI is installed, which is what makes pull requests. */
  gh: boolean
  repos: WorkRepo[]
  /** The repo a worktree was last created in. */
  lastRepo: string | null
  items: WorkItem[]
  /** Newest first. */
  journal: WorkJournalEntry[]
  /** The options a worktree was last created with. */
  setup: WorkCreateOptions
  run: WorkRun | null
}

/** What to bring along into a new worktree, which starts with only the files git tracks. */
export interface WorkCreateOptions {
  /** Copy the repo's untracked .env* files to the same places in the worktree. */
  copyEnv: boolean
  /**
   * node_modules: leave it out, link to the repo's own (a junction on Windows), or run the package
   * manager's install in the worktree.
   */
  deps: 'none' | 'link' | 'install'
}

/** What a repo has that the options can bring along. */
export interface WorkSetupInfo {
  /** Untracked .env* files, relative to the repo root. */
  envFiles: string[]
  /** Folders with a node_modules next to a tracked package.json, relative to the repo root ('' is the root). */
  nodeModules: string[]
  /** The install command for the root package.json, or null when there is none. */
  install: string | null
}

/** The part of the command log to read: what was run for one worktree (its key), or one action of the history (its log id). */
export interface WorkLogScope {
  key?: string
  id?: string
}

/** The end of <dataDir>/work/commands.log, or of the part that was asked for. */
export interface WorkLogTail {
  file: string
  text: string
  /** The file is longer than what is shown. */
  truncated: boolean
}

export interface WorkResult {
  ok: boolean
  message?: string
}
