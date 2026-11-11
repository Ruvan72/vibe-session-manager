// The API the preload script exposes to the renderer as window.api.

import type { AppSettings, ArchiveDoc, ArchiveHit, ArchiveStatus, DayFile, HooksStatus, JumpResult, LabelIcon, SearchHit, Snapshot, UsageSnapshot, WorkAgent, WorkCreateOptions, WorkLogScope, WorkLogTail, WorkOverview, WorkResult, WorkRun, WorkSetupInfo } from './types.ts'

export interface SettingsInfo {
  settings: AppSettings
  openAtLogin: boolean
  /** Shortcuts that could not be registered (usually taken by another app). */
  shortcutErrors: string[]
  version: string
  dataDir: string
}

export interface DebugActions {
  query?: string
  expandFirst?: boolean
  /** With expandFirst: also open the label menu. */
  labelMenu?: boolean
  settings?: boolean
  grouped?: boolean
  /** Open the repo filter dropdown. */
  repoMenu?: boolean
  /** Open the rename field on the first Claude Code row. */
  rename?: boolean
  tab?: 'sessions' | 'time' | 'archive' | 'work'
  /** On the Work tab: open the form for a new worktree, or the command log. */
  workCreate?: boolean
  workLog?: boolean
  /** Search the archive, and with archiveOpenFirst open the first result. */
  archiveQuery?: string
  archiveOpenFirst?: boolean
}

export interface Api {
  getSnapshot(): Promise<Snapshot>
  onSnapshot(cb: (s: Snapshot) => void): () => void
  /** Plan usage (5-hour and weekly limits) of Claude and Codex. */
  getUsage(): Promise<UsageSnapshot>
  onUsage(cb: (u: UsageSnapshot) => void): () => void
  /** Reads the usage sources again now. */
  refreshUsage(): Promise<void>
  search(query: string): Promise<SearchHit[]>
  jump(id: string): Promise<JumpResult>
  markSeen(id: string): Promise<void>
  markUnread(id: string): Promise<void>
  setHidden(id: string, hidden: boolean): Promise<void>
  /** Gives a Claude Code session a custom title, stored in its transcript. False if nothing was written. */
  rename(id: string, title: string): Promise<boolean>
  /** Puts a label on a session or takes it off. */
  setLabel(id: string, labelId: string, on: boolean): Promise<void>
  /** Adds a label definition (or returns the one with that name) and puts it on the session. */
  addLabel(id: string, name: string, icon: LabelIcon): Promise<void>
  /** Deletes a label definition and takes it off every session. */
  removeLabel(labelId: string): Promise<void>
  copyText(text: string): Promise<void>
  getSettings(): Promise<SettingsInfo>
  setSettings(patch: Partial<AppSettings> & { openAtLogin?: boolean }): Promise<SettingsInfo>
  installHooks(): Promise<HooksStatus>
  uninstallHooks(): Promise<HooksStatus>
  /** Hide to the tray. */
  hide(): Promise<void>
  minimize(): Promise<void>
  /** Days with stored time, newest first (YYYY-MM-DD). */
  getTimeDays(): Promise<string[]>
  getTimeDay(date: string): Promise<DayFile>
  openTimeFolder(): Promise<void>
  getArchiveStatus(): Promise<ArchiveStatus>
  onArchiveStatus(cb: (s: ArchiveStatus) => void): () => void
  /** Archived sessions that match, newest first. An empty query lists them all. */
  searchArchive(query: string): Promise<ArchiveHit[]>
  readArchive(id: string): Promise<ArchiveDoc | null>
  /** Opens the session in its editor, after asking to restore its folder or transcript if they are gone. */
  openArchived(id: string): Promise<JumpResult>
  /** Shows the session's conversation.md in Explorer. */
  revealArchived(id: string): Promise<void>
  openArchiveFolder(): Promise<void>
  /** Opens an http(s) link from a conversation in the browser. */
  openLink(url: string): Promise<void>
  /** The Work tab: repos, worktrees and where each stands. With fetch, asks the remotes first. */
  getWork(opts?: { fetch?: boolean }): Promise<WorkOverview>
  /** The commit, push or merge that is running, as its text grows; null when it is dismissed. */
  onWorkRun(cb: (run: WorkRun | null) => void): () => void
  /** Worktrees changed on disk; read the overview again. */
  onWorkChanged(cb: () => void): () => void
  /** Creates <repo>/.claude/worktrees/<name> on a new branch of that name, brings along what the options say, and opens the editor on it. */
  createWork(repoPath: string, name: string, opts: WorkCreateOptions): Promise<WorkResult>
  /** What the repo has that a new worktree can bring along: .env files, node_modules, an install command. */
  getWorkSetup(repoPath: string): Promise<WorkSetupInfo>
  /** Asks for a repo folder that is not in the list. Null when cancelled; else whether it could be added. */
  pickWorkRepo(): Promise<(WorkResult & { path: string }) | null>
  /** Opens (or focuses) the editor window for the worktree. */
  openWork(key: string): Promise<WorkResult>
  /** Lets the agent commit what is in the worktree; its text arrives through onWorkRun. */
  commitWork(key: string, agent: WorkAgent): Promise<WorkResult>
  pushWork(key: string): Promise<WorkResult>
  /** Asks first, then merges the worktree's branch into the given local branch, or into its base. */
  mergeWork(key: string, into?: string): Promise<WorkResult>
  /** Asks first, then pushes the branch if needed and opens a pull request into its base with the GitHub CLI. */
  prWork(key: string): Promise<WorkResult>
  /** Asks first, then removes the worktree and deletes its branch. */
  cleanupWork(key: string): Promise<WorkResult>
  stopWork(): Promise<void>
  /** Takes a finished run off the screen. */
  dismissWorkRun(): Promise<void>
  setWorkAgent(agent: WorkAgent): Promise<void>
  /** Shows the journal file in Explorer. */
  showWorkJournal(): Promise<void>
  /** The end of the command log: every command the Work tab ran, with its output. With a scope, only one worktree's or one action's. */
  readWorkLog(scope?: WorkLogScope): Promise<WorkLogTail>
  /** Opens the whole command log in the program for .log files. */
  openWorkLog(): Promise<void>
  onFocusSearch(cb: () => void): () => void
  onToast(cb: (message: string) => void): () => void
  /** Play the finish sound. */
  onPing(cb: () => void): () => void
  onDebug(cb: (actions: DebugActions) => void): () => void
}

declare global {
  interface Window {
    api: Api
  }
}
