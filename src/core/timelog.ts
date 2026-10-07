// Time tracking (spec 3.7): active periods per session, stored as one JSON file per local day in
// <dataDir>/time/YYYY-MM-DD.json. The files outlive the transcripts, which Claude Code deletes
// after a while, and are plain enough to read or export by hand.

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Agent, DayFile, Interval, TimeEntry } from '../shared/types.ts'

/** Groups activity timestamps into periods; a gap longer than gapMs starts a new period. */
export function activityIntervals(times: number[], gapMs: number): Interval[] {
  const out: Interval[] = []
  for (const t of times) {
    const last = out[out.length - 1]
    if (last && t - last[1] <= gapMs) {
      if (t > last[1]) last[1] = t
    } else out.push([t, t])
  }
  return out
}

export function totalMs(intervals: Interval[]): number {
  return intervals.reduce((sum, [a, b]) => sum + (b - a), 0)
}

const pad = (n: number, w = 2) => String(Math.abs(n)).padStart(w, '0')

export function localDayKey(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function nextLocalMidnight(ms: number): number {
  const d = new Date(ms)
  d.setHours(24, 0, 0, 0)
  return d.getTime()
}

/** "2026-10-01T10:02:11+02:00" */
export function toLocalIso(ms: number): string {
  const d = new Date(ms)
  const off = -d.getTimezoneOffset()
  return (
    `${localDayKey(ms)}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${off >= 0 ? '+' : '-'}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`
  )
}

/** Splits periods at local midnight and groups them by local day. */
export function splitByDay(intervals: Interval[]): Map<string, Interval[]> {
  const out = new Map<string, Interval[]>()
  for (const [a, b] of intervals) {
    for (let start = a; ; ) {
      const midnight = nextLocalMidnight(start)
      const end = Math.min(b, midnight - 1)
      const key = localDayKey(start)
      if (!out.has(key)) out.set(key, [])
      out.get(key)!.push([start, end])
      if (b < midnight) break
      start = midnight
    }
  }
  return out
}

export interface SessionMeta {
  agent: Agent
  title: string
  repo: string
  worktree: string | null
  branch: string | null
  folder: string
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/

export class TimeLog {
  readonly dir: string
  private days = new Map<string, DayFile>()
  private dirty = new Set<string>()
  private timer: NodeJS.Timeout | null = null
  private flushDelayMs: number

  constructor(dir: string, flushDelayMs = 2000) {
    this.dir = dir
    this.flushDelayMs = flushDelayMs
  }

  /** The stored day, or an empty one. */
  getDay(date: string): DayFile {
    let day = this.days.get(date)
    if (!day) {
      day = { date, sessions: {} }
      try {
        const raw = JSON.parse(readFileSync(path.join(this.dir, `${date}.json`), 'utf8'))
        if (raw?.sessions && typeof raw.sessions === 'object') day.sessions = raw.sessions
      } catch {}
      this.days.set(date, day)
    }
    return day
  }

  /** Days with stored time, newest first. */
  listDays(): string[] {
    const days = new Set<string>()
    try {
      for (const f of readdirSync(this.dir)) if (f.endsWith('.json') && DAY_RE.test(f.slice(0, -5))) days.add(f.slice(0, -5))
    } catch {}
    for (const [d, day] of this.days) if (Object.keys(day.sessions).length) days.add(d)
    return [...days].sort().reverse()
  }

  /**
   * Replaces the session's stored periods with the given ones, on every day the session spans.
   * Days outside the transcript's span are left alone, so time from deleted transcripts stays.
   */
  setSession(id: string, meta: SessionMeta, intervals: Interval[]): void {
    const perDay = splitByDay(intervals)
    const candidates = new Set(perDay.keys())
    if (intervals.length) {
      const last = localDayKey(intervals[intervals.length - 1][1])
      for (let t = intervals[0][0], d = localDayKey(t); d <= last; t = nextLocalMidnight(t), d = localDayKey(t)) candidates.add(d)
    }
    for (const date of candidates) {
      const day = this.getDay(date)
      const ivs = perDay.get(date)
      if (!ivs) {
        if (day.sessions[id]) {
          delete day.sessions[id]
          this.markDirty(date)
        }
        continue
      }
      const entry: TimeEntry = {
        agent: meta.agent,
        title: meta.title,
        repo: meta.repo,
        worktree: meta.worktree,
        branch: meta.branch,
        folder: meta.folder,
        activeSeconds: Math.round(totalMs(ivs) / 1000),
        intervals: ivs.map(([a, b]) => [toLocalIso(a), toLocalIso(b)])
      }
      if (JSON.stringify(day.sessions[id]) !== JSON.stringify(entry)) {
        day.sessions[id] = entry
        this.markDirty(date)
      }
    }
  }

  private markDirty(date: string): void {
    this.dirty.add(date)
    if (!this.timer) this.timer = setTimeout(() => this.flush(), this.flushDelayMs)
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (!this.dirty.size) return
    try {
      if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true })
      for (const date of this.dirty) {
        const day = this.getDay(date)
        // Sessions in order of their first period, so the file reads like a timeline.
        const sessions = Object.fromEntries(Object.entries(day.sessions).sort((a, b) => (a[1].intervals[0]?.[0] ?? '').localeCompare(b[1].intervals[0]?.[0] ?? '')))
        const file = path.join(this.dir, `${date}.json`)
        writeFileSync(file + '.tmp', JSON.stringify({ date, sessions }, null, 2) + '\n')
        renameSync(file + '.tmp', file)
      }
      this.dirty.clear()
    } catch {
      // Try again on the next change.
    }
  }
}
