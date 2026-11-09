// The API the preload script exposes to the renderer as window.api.

import type { AppSettings, ArchiveDoc, ArchiveHit, ArchiveStatus, DayFile, HooksStatus, JumpResult, LabelIcon, SearchHit, Snapshot, UsageSnapshot } from './types.ts'

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
  tab?: 'sessions' | 'time' | 'archive'
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
