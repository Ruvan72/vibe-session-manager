// Keeps the full session list up to date by polling the data sources (spec 5): Claude Code's
// transcripts, live-status files and hook events, Codex's rollouts (spec 5.6) and the Claude
// desktop app's Cowork sessions.

import { EventEmitter } from 'node:events'
import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import type { Agent, DayFile, HooksStatus, LabelIcon, SearchHit, SessionView, Snapshot } from '../shared/types.ts'
import { LabelStore } from './labels.ts'
import { CodexIndex, codexHookState, codexLive, CodexReader, listCodexRollouts, readCodexLocks } from './codex.ts'
import { CoworkIndex, coworkHomeDir, coworkRepo, listCoworkSessions, type CoworkSource } from './cowork.ts'
import { compactEvents, EventsReader } from './events.ts'
import { EVENTS_FILE, getHooksStatus } from './hooks.ts'
import { readLiveSessions, type LiveInfo } from './live.ts'
import { buildView, urgentQueue } from './model.ts'
import { SeenStore } from './persist.ts'
import { appendCustomTitle } from './rename.ts'
import { RepoResolver } from './repo.ts'
import { SearchIndex } from './search.ts'
import { activityIntervals, TimeLog } from './timelog.ts'
import { TranscriptReader } from './transcript.ts'

export interface StoreOptions {
  claudeDir: string
  /** ~/.codex. Leave out to list Claude Code sessions only. */
  codexDir?: string
  /** Claude Desktop's local-agent-mode-sessions folder (see cowork.ts). Leave out to skip Cowork sessions. */
  coworkDir?: string
  dataDir: string
  pollMs?: number
  /** Activity gaps longer than this end an active period. Default 90 minutes. */
  idleGapMs?: number
  /** Override for tests. */
  isAlive?: (pid: number) => boolean
}

export interface StoreEvents {
  change: [Snapshot]
  /** A session turned red (waiting for the user). */
  waiting: [SessionView]
  /** A session turned yellow (finished a turn). */
  finished: [SessionView]
}

/** Transcripts untouched for this long are only checked every SLOW_EVERY polls. */
const QUIET_MS = 10 * 60_000
const SLOW_EVERY = 10

const yieldToEventLoop = () => new Promise<void>((r) => setImmediate(r))

type Reader = TranscriptReader | CodexReader

/** One session's files on disk: a Claude Code or Cowork transcript, or a Codex thread's rollout files in order. */
interface Source {
  sessionId: string
  agent: Agent
  files: string[]
}

function newReader(src: Source): Reader {
  return src.agent === 'codex' ? new CodexReader(src.sessionId, src.files) : new TranscriptReader(src.sessionId, src.files[0], src.agent)
}

export class SessionStore extends EventEmitter<StoreEvents> {
  readonly projectsDir: string
  readonly sessionsDir: string
  readonly settingsPath: string
  readonly seen: SeenStore
  readonly timelog: TimeLog
  readonly labels: LabelStore

  private opts: StoreOptions
  private idleGapMs: number
  private readers = new Map<string, Reader>()
  private errors = new Map<string, string>()
  private live = new Map<string, LiveInfo>()
  private events: EventsReader
  private codexIndex: CodexIndex | null
  private codexLocks = new Set<string>()
  private coworkIndex: CoworkIndex | null
  /** The Cowork sources of the last listing, by session id. */
  private coworkSources = new Map<string, CoworkSource>()
  private repos = new RepoResolver()
  private index = new SearchIndex()
  private searchVersion = 0
  private views = new Map<string, SessionView>()
  private viewKeys = new Map<string, string>()
  private hooks: HooksStatus = 'none'
  private scanning = true
  private timer: NodeJS.Timeout | null = null
  private polling = false
  private pollCount = 0

  constructor(opts: StoreOptions) {
    super()
    this.opts = opts
    this.idleGapMs = opts.idleGapMs ?? 90 * 60_000
    this.projectsDir = path.join(opts.claudeDir, 'projects')
    this.sessionsDir = path.join(opts.claudeDir, 'sessions')
    this.settingsPath = path.join(opts.claudeDir, 'settings.json')
    this.events = new EventsReader(path.join(opts.dataDir, EVENTS_FILE))
    this.seen = new SeenStore(opts.dataDir)
    this.timelog = new TimeLog(path.join(opts.dataDir, 'time'))
    this.labels = new LabelStore(opts.dataDir)
    for (const id of this.seen.takeLegacyPendingMerge()) this.labels.set(id, 'pending-merge', true)
    this.codexIndex = opts.codexDir ? new CodexIndex(path.join(opts.codexDir, 'session_index.jsonl')) : null
    this.coworkIndex = opts.coworkDir ? new CoworkIndex() : null
  }

  async start(): Promise<void> {
    await compactEvents(path.join(this.opts.dataDir, EVENTS_FILE))
    this.hooks = await getHooksStatus(this.settingsPath)
    await this.initialScan()
    this.timer = setInterval(() => void this.poll(), this.opts.pollMs ?? 1000)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.seen.flush()
    this.timelog.flush()
    this.labels.flush()
  }

  private labelNames(ids: string[]): string[] {
    return this.labels.list().filter((d) => ids.includes(d.id)).map((d) => d.name)
  }

  snapshot(): Snapshot {
    const sessions = [...this.views.values()].sort((a, b) => b.lastActivity - a.lastActivity)
    const counts = { red: 0, yellow: 0, green: 0 }
    for (const s of sessions) if (s.light !== 'grey' && !s.hidden) counts[s.light]++
    return { sessions, hooks: this.hooks, scanning: this.scanning, counts, searchVersion: this.searchVersion, labels: this.labels.list() }
  }

  get(id: string): SessionView | undefined {
    return this.views.get(id)
  }

  urgent(): SessionView[] {
    return urgentQueue([...this.views.values()].filter((s) => !s.hidden))
  }

  search(query: string): SearchHit[] {
    return this.index.search(query)
  }

  markSeen(id: string): void {
    this.seen.mark(id)
    this.rebuild(new Set([id]), false)
  }

  setLabel(id: string, labelId: string, on: boolean): void {
    this.labels.set(id, labelId, on)
    this.rebuild(new Set([id]), false)
  }

  addLabel(id: string, name: string, icon: LabelIcon): void {
    if (!name.trim()) return
    const def = this.labels.add(name, icon)
    this.labels.set(id, def.id, true)
    this.rebuild(new Set([id]), false, true)
  }

  removeLabel(labelId: string): void {
    this.rebuild(new Set(this.labels.remove(labelId)), false, true)
  }

  setHidden(id: string, hidden: boolean): void {
    this.seen.setHidden(id, hidden)
    this.rebuild(new Set([id]), false)
  }

  /**
   * Renames a Claude Code session in its transcript, where Claude Code reads it too. Codex keeps its
   * titles in a SQLite database as well, so a Codex rename would not show in Codex; it is not offered.
   */
  async rename(id: string, title: string): Promise<boolean> {
    const reader = this.readers.get(id)
    // The Claude app keeps a Cowork session's title in its own file, which would win over the transcript.
    if (!(reader instanceof TranscriptReader) || reader.agent !== 'claude') return false
    if (!(await appendCustomTitle(reader.filePath, id, title))) return false
    // Two reads of the same transcript at once would apply the new lines twice.
    while (this.polling) await new Promise((r) => setTimeout(r, 10))
    this.polling = true
    try {
      if (this.readers.get(id) === reader) await this.readTranscript(reader)
      this.rebuild(new Set([id]), false)
    } finally {
      this.polling = false
    }
    return true
  }

  /** Makes the session yellow again, e.g. read but not dealt with yet. */
  markUnread(id: string): void {
    this.seen.markUnread(id)
    this.rebuild(new Set([id]), false)
  }

  timeDays(): string[] {
    return this.timelog.listDays()
  }

  timeDay(date: string): DayFile {
    return this.timelog.getDay(date)
  }

  /** Changes the idle gap and recomputes all active periods. */
  setIdleGap(ms: number): void {
    if (ms === this.idleGapMs || !(ms > 0)) return
    this.idleGapMs = ms
    this.rebuild(new Set(this.readers.keys()), false)
  }

  async refreshHooksStatus(): Promise<HooksStatus> {
    const prev = this.hooks
    this.hooks = await getHooksStatus(this.settingsPath)
    if (prev !== this.hooks) this.rebuild(new Set(this.readers.keys()), false, true)
    return this.hooks
  }

  /** Reads everything once, newest files first, publishing progress as it goes. */
  private async initialScan(): Promise<void> {
    this.live = await readLiveSessions(this.sessionsDir, this.opts.isAlive)
    await this.events.update()
    await this.codexIndex?.update()
    if (this.opts.codexDir) this.codexLocks = await readCodexLocks(path.join(this.opts.codexDir, 'thread-writer-locks'))
    const sources = await this.listSources()
    await this.coworkIndex?.update([...this.coworkSources.values()])
    for (const [id, info] of (await this.readCoworkLive(Date.now(), true)).live) this.live.set(id, info)
    const withTime = await Promise.all(sources.map(async (f) => ({ ...f, mtime: (await stat(f.files[f.files.length - 1]).catch(() => null))?.mtimeMs ?? 0 })))
    withTime.sort((a, b) => b.mtime - a.mtime)

    let batch = new Set<string>()
    let lastEmit = Date.now()
    for (const f of withTime) {
      const reader = newReader(f)
      this.readers.set(f.sessionId, reader)
      await this.readTranscript(reader)
      batch.add(f.sessionId)
      if (Date.now() - lastEmit > 250) {
        this.rebuild(batch, false)
        batch = new Set()
        lastEmit = Date.now()
      }
      await yieldToEventLoop()
    }
    this.scanning = false
    this.rebuild(batch, false, true)
  }

  private async listSources(): Promise<Source[]> {
    const [claude, codex, cowork] = await Promise.all([
      this.listTranscripts(),
      this.opts.codexDir ? listCodexRollouts(path.join(this.opts.codexDir, 'sessions')) : null,
      this.opts.coworkDir ? listCoworkSessions(this.opts.coworkDir) : null
    ])
    const out: Source[] = claude.map((f) => ({ sessionId: f.sessionId, agent: 'claude', files: [f.filePath] }))
    for (const [sessionId, files] of codex ?? []) out.push({ sessionId, agent: 'codex', files })
    this.coworkSources = new Map()
    for (const c of cowork ?? []) {
      // A Claude Code session id is unique; a Cowork transcript never shares one with ~/.claude.
      if (this.coworkSources.has(c.sessionId)) continue
      this.coworkSources.set(c.sessionId, c)
      out.push({ sessionId: c.sessionId, agent: 'cowork', files: [c.filePath] })
    }
    return out
  }

  /**
   * Live status of Cowork sessions, from the status file in each session's own config folder. Only
   * sessions that run on the host are checked: in Cowork's VM the pids are the VM's. Quiet sessions
   * are skipped except on slow rounds, so an idle machine does not read dozens of folders a second.
   */
  private async readCoworkLive(now: number, all: boolean): Promise<{ live: Map<string, LiveInfo>; checked: Set<string> }> {
    const live = new Map<string, LiveInfo>()
    const checked = new Set<string>()
    if (!this.coworkIndex) return { live, checked }
    await Promise.all(
      [...this.coworkSources.values()].map(async (c) => {
        const meta = this.coworkIndex!.metas.get(c.sessionId)
        if (meta && !meta.hostLoop) return
        const reader = this.readers.get(c.sessionId)
        if (!all && !this.live.has(c.sessionId) && reader && now - reader.mtimeMs > QUIET_MS) return
        checked.add(c.sessionId)
        const info = (await readLiveSessions(path.join(c.sessionDir, '.claude', 'sessions'), this.opts.isAlive)).get(c.sessionId)
        if (info) live.set(c.sessionId, info)
      })
    )
    return { live, checked }
  }

  private async listTranscripts(): Promise<{ sessionId: string; filePath: string }[]> {
    let dirs: string[]
    try {
      dirs = await readdir(this.projectsDir)
    } catch {
      return []
    }
    const perDir = await Promise.all(
      dirs.map(async (d) => {
        try {
          const entries = await readdir(path.join(this.projectsDir, d), { withFileTypes: true })
          return entries
            .filter((e) => e.isFile() && e.name.endsWith('.jsonl'))
            .map((e) => ({ sessionId: e.name.slice(0, -'.jsonl'.length), filePath: path.join(this.projectsDir, d, e.name) }))
        } catch {
          return []
        }
      })
    )
    return perDir.flat()
  }

  private async readTranscript(reader: Reader): Promise<boolean> {
    try {
      const changed = await reader.update()
      if (this.errors.delete(reader.sessionId)) return true
      return changed
    } catch (e: any) {
      this.errors.set(reader.sessionId, String(e?.message ?? e))
      return true
    }
  }

  async poll(): Promise<void> {
    if (this.polling) return
    this.polling = true
    try {
      const changed = new Set<string>()
      const slowRound = ++this.pollCount % SLOW_EVERY === 0

      const live = await readLiveSessions(this.sessionsDir, this.opts.isAlive)
      const cowork = await this.readCoworkLive(Date.now(), slowRound)
      for (const [id, info] of cowork.live) live.set(id, info)
      // Cowork sessions not checked this round keep their last known status.
      for (const [id, info] of this.live) if (this.coworkSources.has(id) && !cowork.checked.has(id)) live.set(id, info)
      for (const id of new Set([...live.keys(), ...this.live.keys()])) {
        const a = live.get(id)
        const b = this.live.get(id)
        if (a?.status !== b?.status || a?.pid !== b?.pid || a?.statusUpdatedAt !== b?.statusUpdatedAt) changed.add(id)
      }
      this.live = live

      for (const id of await this.events.update()) changed.add(id)

      if (this.opts.codexDir) {
        for (const id of (await this.codexIndex?.update()) ?? []) changed.add(id)
        const locks = await readCodexLocks(path.join(this.opts.codexDir, 'thread-writer-locks'))
        for (const id of locks) if (!this.codexLocks.has(id)) changed.add(id)
        for (const id of this.codexLocks) if (!locks.has(id)) changed.add(id)
        this.codexLocks = locks
      }

      const sources = await this.listSources()
      for (const id of (await this.coworkIndex?.update([...this.coworkSources.values()])) ?? []) changed.add(id)
      const present = new Set<string>()
      const now = Date.now()
      const toRead: Reader[] = []
      await Promise.all(
        sources.map(async (f) => {
          present.add(f.sessionId)
          let reader = this.readers.get(f.sessionId)
          if (!reader || reader.agent !== f.agent || !reader.useFiles(f.files)) {
            reader = newReader(f)
            this.readers.set(f.sessionId, reader)
            toRead.push(reader)
            return
          }
          // Quiet, closed sessions rarely wake up; check them less often.
          const open = f.agent === 'codex' ? this.codexLocks.has(f.sessionId) : live.has(f.sessionId)
          if (!slowRound && !open && now - reader.mtimeMs > QUIET_MS) return
          if (await reader.needsRead()) toRead.push(reader)
        })
      )
      // A Codex turn that stops writing goes from busy to stuck without any file changing.
      if (slowRound) for (const r of this.readers.values()) if (r instanceof CodexReader && r.state.codex.turnOpen) changed.add(r.sessionId)
      for (const reader of toRead) if (await this.readTranscript(reader)) changed.add(reader.sessionId)
      for (const id of [...this.readers.keys()]) {
        if (!present.has(id)) {
          this.readers.delete(id)
          changed.add(id)
        }
      }

      if (this.pollCount % 5 === 0) {
        const prev = this.hooks
        this.hooks = await getHooksStatus(this.settingsPath)
        if (prev !== this.hooks) for (const id of this.readers.keys()) changed.add(id)
      }

      this.rebuild(changed, true)
    } finally {
      this.polling = false
    }
  }

  /** Recomputes the views for the given sessions and emits change/transition events. */
  private rebuild(ids: Set<string>, notify: boolean, force = false): void {
    let any = force
    for (const id of ids) {
      const reader = this.readers.get(id)
      const prev = this.views.get(id)
      if (!reader) {
        if (prev) {
          this.views.delete(id)
          this.viewKeys.delete(id)
          if (this.index.delete(id)) this.searchVersion++
          any = true
        }
        continue
      }
      let t = reader.state
      let live = this.live.get(id) ?? null
      let hook = this.hooks === 'none' ? null : (this.events.states.get(id) ?? null)
      if (reader instanceof CodexReader) {
        if (reader.hidden) {
          if (prev) {
            this.views.delete(id)
            this.viewKeys.delete(id)
            if (this.index.delete(id)) this.searchVersion++
            any = true
          }
          continue
        }
        live = codexLive(reader.state, this.codexLocks.has(id))
        hook = codexHookState(reader.state)
        const name = this.codexIndex?.names.get(id)
        if (name) t = { ...t, customTitle: name }
      }
      let repo = null
      const cowork = reader.agent === 'cowork' ? this.coworkSources.get(id) : undefined
      if (cowork) {
        const meta = this.coworkIndex?.metas.get(id) ?? null
        if (meta?.archived) {
          if (prev) {
            this.views.delete(id)
            this.viewKeys.delete(id)
            if (this.index.delete(id)) this.searchVersion++
            any = true
          }
          continue
        }
        // The Claude app's title wins; the branch is "HEAD" in the scratch folder and says nothing.
        t = { ...t, customTitle: meta?.title ?? t.customTitle, homeDir: coworkHomeDir(meta, cowork.sessionDir), branches: [] }
        repo = meta?.folders[0] ? this.repos.get(meta.folders[0]) : coworkRepo(cowork.sessionDir)
      }
      if (t.firstTs === null && !live) continue
      const intervals = activityIntervals(t.activity, this.idleGapMs)
      repo ??= this.repos.get(t.homeDir ?? t.firstCwd ?? path.dirname(t.filePath))
      const view = buildView(t, live, hook, repo, this.seen.get(id), intervals, this.seen.unreadAt(id), reader.agent)
      const err = this.errors.get(id)
      if (err) view.error = err
      view.hidden = this.seen.isHidden(id)
      view.labels = this.labels.of(id)

      // New text does not always change the view (e.g. a message with only pasted text), so index first.
      if (this.index.set({ id, meta: [view.title, view.repo, view.worktree ?? '', ...view.branches, view.homeDir, id, view.agent, ...this.labelNames(view.labels)], texts: [...t.prompts, ...t.texts] })) {
        this.searchVersion++
        any = true
      }
      const key = JSON.stringify(view)
      if (key === this.viewKeys.get(id)) continue
      this.views.set(id, view)
      this.viewKeys.set(id, key)
      this.timelog.setSession(id, { agent: view.agent, title: view.title, repo: view.repo, worktree: view.worktree, branch: view.branch, folder: view.homeDir }, intervals)
      any = true

      if (notify && !view.hidden && (prev ? prev.light !== view.light : !this.scanning)) {
        if (view.light === 'red') this.emit('waiting', view)
        else if (view.light === 'yellow') this.emit('finished', view)
      }
    }
    if (any) this.emit('change', this.snapshot())
  }
}
