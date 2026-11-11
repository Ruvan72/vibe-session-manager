// Pure list logic for the renderer: filtering, grouping and time formatting.

import type { DayFile, Interval, Light, SearchHit, SessionView, TimeEntry, UsageWindow, WorkItem, WorkJournalEntry, WorkState } from '../../shared/types.ts'

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

/** A usage window is current until its reset time has passed; after that its percentage says nothing about the new window. */
export function usageLive(w: UsageWindow | null, now: number): w is UsageWindow {
  return !!w && (w.resetsAt === null || w.resetsAt > now)
}

/** Time left until a reset: "<1m", "45m", "2h 10m", "4d 3h". */
export function formatReset(resetsAt: number, now: number): string {
  const min = Math.ceil(Math.max(0, resetsAt - now) / 60_000)
  if (min < 1) return '<1m'
  if (min < 60) return `${min}m`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h}h ${String(min % 60).padStart(2, '0')}m`
  return `${Math.floor(h / 24)}d ${h % 24}h`
}

/** How full a usage bar looks: calm below 70 %, warning from 70 %, alarm from 90 %. */
export function usageLevel(percent: number): 'ok' | 'warn' | 'high' {
  return percent >= 90 ? 'high' : percent >= 70 ? 'warn' : 'ok'
}

export function absTime(ms: number): string {
  return new Date(ms).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}

/** Matches every word of a search, for highlighting. Null when there is nothing to highlight. */
export function highlightRegex(query: string): RegExp | null {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return null
  // Longest first, so "merge" does not take the start of "merged" when both are searched for.
  const alts = words.sort((a, b) => b.length - a.length).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  return new RegExp(alts.join('|'), 'giu')
}

/** Splits text into the parts that match and those that do not, in order. */
export function highlightParts(text: string, re: RegExp | null): { text: string; hit: boolean }[] {
  if (!re) return [{ text, hit: false }]
  const parts: { text: string; hit: boolean }[] = []
  let at = 0
  for (const m of text.matchAll(re)) {
    if (m.index > at) parts.push({ text: text.slice(at, m.index), hit: false })
    parts.push({ text: m[0], hit: true })
    at = m.index + m[0].length
  }
  if (at < text.length) parts.push({ text: text.slice(at), hit: false })
  return parts
}

/** The heading conversation.md puts above a turn, as its kind; null for any other heading. */
export function turnKind(heading: string): 'user' | 'agent' | null {
  const m = /^(You|Task for subagent|Claude|Codex|Subagent)(?: · \d{4}-\d{2}-\d{2} \d{2}:\d{2})?$/.exec(heading)
  if (!m) return null
  return m[1] === 'You' || m[1] === 'Task for subagent' ? 'user' : 'agent'
}

export function isWebLink(href: string): boolean {
  return /^https?:\/\//i.test(href)
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  if (n < 1024 * 1024 * 1024) return `${Math.round(n / (1024 * 1024))} MB`
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`
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

export const WORK_STATE_LABEL: Record<WorkState, string> = {
  orphaned: 'Folder gone',
  working: 'Agent working',
  uncommitted: 'Uncommitted',
  new: 'New',
  'pending-merge': 'Pending merge',
  unpushed: 'To push',
  ready: 'Ready for cleanup'
}

const count = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/** The line next to the state of a worktree or the repo's own folder: what is in it, and how far that has come. */
export function workDetail(i: WorkItem): string {
  const base = i.base ?? 'a base branch'
  const notIn = i.ahead ? `${count(i.ahead, 'commit')} not in ${base}` : null
  const changed = i.changed ? `${count(i.changed, 'file')} changed` : null
  const push = !i.hasRemote || !i.branch ? null : i.toPush === null ? 'not pushed' : i.toPush > 0 ? `${count(i.toPush, 'commit')} to push` : 'pushed'
  const join = (...parts: (string | null)[]) => parts.filter(Boolean).join(' · ')
  switch (i.state) {
    case 'orphaned':
      return join('Git still has the worktree on record', notIn)
    case 'working':
      return join(changed, notIn) || 'A session is busy here'
    case 'uncommitted':
      // In the repo's own folder, commits waiting for a push are work too.
      return join(changed, notIn, i.root && i.toPush ? `${count(i.toPush, 'commit')} to push` : null)
    case 'new':
      return `No commits yet · from ${base}`
    case 'pending-merge':
      return join(notIn ?? `Not in ${base}`, push)
    case 'unpushed':
      return `${count(i.toPush ?? 0, 'commit')} to push`
    case 'ready':
      return `Everything is in ${base}`
  }
}

const AGENT_SHORT = { claude: 'Claude', codex: 'Codex' } as const

/** One line of the Work tab's history. */
export function workJournalText(e: WorkJournalEntry): string {
  // The branch that was picked for the merge, which need not be the base.
  const into = e.detail?.startsWith('into ') ? ` ${e.detail}` : e.base ? ` into ${e.base}` : ''
  const text = {
    create: [`Created ${e.worktree}${e.base ? ` from ${e.base}` : ''}`, `Could not create ${e.worktree}`],
    install: [`Installed packages in ${e.worktree}`, `Install in ${e.worktree} failed`],
    commit: [`${e.agent ? AGENT_SHORT[e.agent] : 'The agent'} committed in ${e.worktree}`, `Commit in ${e.worktree} did not finish`],
    push: [`Pushed ${e.branch ?? e.worktree}`, `Could not push ${e.branch ?? e.worktree}`],
    merge: [`Merged ${e.branch ?? e.worktree}${into}`, `Could not merge ${e.branch ?? e.worktree}${into}`],
    cleanup: [`Removed ${e.worktree}`, `Could not remove ${e.worktree}`]
  }[e.action][e.ok ? 0 : 1]
  // "into main" and "to origin" are already in the sentence.
  const extra = e.detail && !/^(into|to) /.test(e.detail) ? (e.action === 'create' ? `, ${e.detail}` : ` (${e.detail})`) : ''
  return text + extra
}
