// Pure list logic for the renderer: filtering, grouping and time formatting.

import type { DayFile, Interval, Light, SearchHit, SessionView, TimeEntry } from '../../shared/types.ts'

export type Range = 'today' | '3d' | 'all'

export interface Filters {
  /** Empty = all colours. */
  lights: Light[]
  liveOnly: boolean
  range: Range
  /** Also list sessions the user hid. */
  showHidden?: boolean
  /** Only sessions with this label. */
  label?: string | null
  /** Only sessions in these repos (repoKey). Empty or missing = all repos. */
  repos?: string[]
}

export function rangeStart(range: Range, now: number): number {
  if (range === 'all') return 0
  if (range === '3d') return now - 3 * 864e5
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/**
 * Applies filters and search. Sessions that need attention, are working or have a label always
 * pass the time range, and a search ignores it, so older sessions can be found.
 * Result is sorted by last activity, newest first.
 */
export function visibleSessions(sessions: SessionView[], f: Filters, hits: SearchHit[] | null, now: number): SessionView[] {
  const hitIds = hits ? new Set(hits.map((h) => h.id)) : null
  const since = rangeStart(f.range, now)
  return sessions
    .filter((s) => (hitIds ? hitIds.has(s.id) : s.lastActivity >= since || s.light !== 'grey' || s.labels.length > 0))
    .filter((s) => !f.lights.length || f.lights.includes(s.light))
    .filter((s) => !f.liveOnly || s.status !== 'closed')
    .filter((s) => f.showHidden || !s.hidden)
    .filter((s) => !f.label || s.labels.includes(f.label))
    .filter((s) => !f.repos?.length || f.repos.includes(s.repoKey))
    .sort((a, b) => b.lastActivity - a.lastActivity)
}

export interface RepoOption {
  key: string
  label: string
  count: number
}

/** The repos for the repo filter, by name, with their number of sessions. Repos with only hidden sessions are left out unless they are shown. */
export function repoOptions(sessions: SessionView[], showHidden: boolean): RepoOption[] {
  const repos = new Map<string, RepoOption>()
  for (const s of sessions) {
    if (s.hidden && !showHidden) continue
    let r = repos.get(s.repoKey)
    if (!r) repos.set(s.repoKey, (r = { key: s.repoKey, label: s.repo, count: 0 }))
    r.count++
  }
  return [...repos.values()].sort((a, b) => byName(a.label, b.label) || a.key.localeCompare(b.key))
}

const byName = (a: string, b: string) => a.localeCompare(b, 'en', { sensitivity: 'base' })

export interface Group {
  key: string
  label: string
  sessions: SessionView[]
}

/** Sessions per repo. Repos are ordered by name; sessions keep their order (most recent first). */
export function groupSessions(sorted: SessionView[]): Group[] {
  const groups = new Map<string, Group>()
  for (const s of sorted) {
    let g = groups.get(s.repoKey)
    if (!g) groups.set(s.repoKey, (g = { key: s.repoKey, label: s.repo, sessions: [] }))
    g.sessions.push(s)
  }
  return [...groups.values()].sort((a, b) => byName(a.label, b.label) || a.key.localeCompare(b.key))
}

/** Sessions in on-screen order, for keyboard navigation and Ctrl+1…9. */
export function displayOrder(sorted: SessionView[], grouped: boolean): SessionView[] {
  return grouped ? flattenGroups(groupSessions(sorted)) : sorted
}

export function flattenGroups(groups: Group[]): SessionView[] {
  return groups.flatMap((g) => g.sessions)
}

export function relTime(ms: number, now: number): string {
  const s = Math.max(0, Math.round((now - ms) / 1000))
  if (s < 45) return 'now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h`
  const d = Math.round(h / 24)
  if (d < 7) return `${d}d`
  return new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}

export function absTime(ms: number): string {
  return new Date(ms).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}

export const LIGHT_LABEL: Record<Light, string> = {
  red: 'Waiting',
  yellow: 'Unread',
  green: 'Working',
  grey: 'Idle'
}

// ---------- time tracking ----------

export function formatDuration(ms: number): string {
  const min = Math.round(ms / 60_000)
  if (min < 1) return ms > 0 ? '<1m' : '0m'
  const h = Math.floor(min / 60)
  const m = min % 60
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`
}

const clock = (ms: number) => new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })

export function clockRange(a: number, b: number): string {
  return `${clock(a)}–${clock(b)}`
}

export function localDayStart(ms: number): number {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** The part of the periods that falls on the local day starting at dayStart. */
export function clipToDay(intervals: Interval[], dayStart: number): Interval[] {
  const end = new Date(dayStart)
  end.setDate(end.getDate() + 1)
  const dayEnd = end.getTime()
  return intervals.filter(([a, b]) => b >= dayStart && a < dayEnd).map(([a, b]) => [Math.max(a, dayStart), Math.min(b, dayEnd - 1)] as Interval)
}

export const sumMs = (intervals: Interval[]) => intervals.reduce((s, [a, b]) => s + (b - a), 0)

export function dayKey(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function shiftDay(key: string, days: number): string {
  const [y, m, d] = key.split('-').map(Number)
  return dayKey(new Date(y, m - 1, d + days).getTime())
}

export function dayLabel(key: string): string {
  const [y, m, d] = key.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })
}

export interface TimeRow {
  id: string
  entry: TimeEntry
  intervals: Interval[]
  ms: number
}

export interface TimeGroup {
  repo: string
  ms: number
  rows: TimeRow[]
}

export function dayRows(day: DayFile): TimeRow[] {
  return Object.entries(day.sessions)
    .map(([id, entry]) => {
      const intervals = entry.intervals.map(([a, b]) => [Date.parse(a), Date.parse(b)] as Interval)
      return { id, entry, intervals, ms: entry.activeSeconds * 1000 }
    })
    .sort((a, b) => (a.intervals[0]?.[0] ?? 0) - (b.intervals[0]?.[0] ?? 0))
}

/** Rows grouped by repo, repos in order of their first period. */
export function groupTimeRows(rows: TimeRow[]): TimeGroup[] {
  const groups = new Map<string, TimeGroup>()
  for (const r of rows) {
    let g = groups.get(r.entry.repo)
    if (!g) groups.set(r.entry.repo, (g = { repo: r.entry.repo, ms: 0, rows: [] }))
    g.rows.push(r)
    g.ms += r.ms
  }
  return [...groups.values()]
}

function csvCell(v: string | number): string {
  const s = String(v)
  return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** One line per session for the day. Semicolon-separated, which Excel with Danish settings opens directly. */
export function dayCsv(day: DayFile): string {
  const lines = [['date', 'repo', 'worktree', 'branch', 'title', 'start', 'end', 'active_minutes', 'periods', 'agent'].join(';')]
  for (const r of dayRows(day)) {
    const first = r.intervals[0]
    const last = r.intervals[r.intervals.length - 1]
    lines.push(
      [
        day.date,
        r.entry.repo,
        r.entry.worktree ?? '',
        r.entry.branch ?? '',
        r.entry.title,
        first ? clock(first[0]) : '',
        last ? clock(last[1]) : '',
        Math.round(r.ms / 60_000),
        r.intervals.map(([a, b]) => clockRange(a, b)).join(' '),
        r.entry.agent ?? 'claude'
      ]
        .map(csvCell)
        .join(';')
    )
  }
  return lines.join('\r\n') + '\r\n'
}
