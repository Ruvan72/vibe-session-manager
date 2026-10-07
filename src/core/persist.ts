// Small JSON files in the app's data dir: user settings and "seen" marks.

import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { DEFAULT_SETTINGS, type AppSettings } from '../shared/types.ts'

function readJson(file: string): any {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function writeJson(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true })
  const tmp = file + '.tmp'
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n')
  renameSync(tmp, file)
}

/**
 * First start after the app was renamed: copies the data dir from its old name, so settings, seen marks,
 * labels and time carry over. The old dir is left in place; hooks installed from it keep working until
 * upgradeLegacyHooks points them here. Returns true if it copied.
 */
export function adoptLegacyDataDir(legacyDir: string, dataDir: string): boolean {
  if (existsSync(dataDir) || !existsSync(legacyDir)) return false
  // Copy next to it first, so a copy that fails half-way is not taken for a finished one on the next start.
  const tmp = dataDir + '.tmp'
  cpSync(legacyDir, tmp, { recursive: true, force: true })
  renameSync(tmp, dataDir)
  return true
}

export function loadSettings(dataDir: string): AppSettings {
  const raw = readJson(path.join(dataDir, 'config.json')) ?? {}
  return { ...DEFAULT_SETTINGS, ...raw, shortcuts: { ...DEFAULT_SETTINGS.shortcuts, ...(raw.shortcuts ?? {}) } }
}

export function saveSettings(dataDir: string, settings: AppSettings): void {
  writeJson(path.join(dataDir, 'config.json'), settings)
}

/**
 * When the user last saw each session, which sessions they marked as unread, and which they hid. On the very
 * first run everything before that moment counts as seen, so old finished turns do not all
 * light up yellow.
 */
export class SeenStore {
  readonly initializedAt: number
  private seen: Record<string, number>
  private unread: Record<string, number>
  private hidden: Record<string, number>
  /** Sessions marked "pending merge" before labels existed; moved to the labels once. */
  private legacyMerge: string[]
  private file: string
  private timer: NodeJS.Timeout | null = null

  constructor(dataDir: string, now = Date.now()) {
    this.file = path.join(dataDir, 'state.json')
    const raw = existsSync(this.file) ? readJson(this.file) : null
    this.initializedAt = typeof raw?.initializedAt === 'number' ? raw.initializedAt : now
    this.seen = raw?.seen && typeof raw.seen === 'object' ? raw.seen : {}
    this.unread = raw?.unread && typeof raw.unread === 'object' ? raw.unread : {}
    this.hidden = raw?.hidden && typeof raw.hidden === 'object' ? raw.hidden : {}
    this.legacyMerge = raw?.pendingMerge && typeof raw.pendingMerge === 'object' ? Object.keys(raw.pendingMerge) : []
    if (!raw) this.flush()
  }

  get(id: string): number {
    return Math.max(this.initializedAt, this.seen[id] ?? 0)
  }

  /** When the session was marked as unread, or null. */
  unreadAt(id: string): number | null {
    return this.unread[id] ?? null
  }

  mark(id: string, at = Date.now()): void {
    this.seen[id] = at
    delete this.unread[id]
    this.schedule()
  }

  isHidden(id: string): boolean {
    return id in this.hidden
  }

  /** Hidden sessions are left out of the list (unless the user shows them), the counts and notifications. */
  setHidden(id: string, hidden: boolean, at = Date.now()): void {
    if (hidden) this.hidden[id] = at
    else delete this.hidden[id]
    this.schedule()
  }

  /** Returns the old "pending merge" marks once; they are dropped from state.json on the next write. */
  takeLegacyPendingMerge(): string[] {
    const ids = this.legacyMerge
    this.legacyMerge = []
    if (ids.length) this.schedule()
    return ids
  }

  markUnread(id: string, at = Date.now()): void {
    this.unread[id] = at
    this.schedule()
  }

  private schedule(): void {
    if (!this.timer) this.timer = setTimeout(() => this.flush(), 500)
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    try {
      writeJson(this.file, { initializedAt: this.initializedAt, seen: this.seen, unread: this.unread, hidden: this.hidden })
    } catch {}
  }
}
