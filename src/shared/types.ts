// Types shared between core, the Electron main process and the renderer.

export type Light = 'red' | 'green' | 'yellow' | 'grey'
export type LiveStatus = 'busy' | 'idle' | 'closed'
/** Which coding agent the session belongs to. */
export type Agent = 'claude' | 'codex'

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
  zoomLevel: 0
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
