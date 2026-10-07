import { inflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { drawTrayIcon } from '../../src/main/icon.ts'
import { clipToDay, dayCsv, displayOrder, formatDuration, groupSessions, relTime, repoOptions, shiftDay, visibleSessions } from '../../src/renderer/src/view.ts'
import type { SessionView } from '../../src/shared/types.ts'

const NOW = Date.parse('2026-10-01T12:00:00')
const H = 3600_000
const s = (id: string, hoursAgo: number, extra: Partial<SessionView> = {}) =>
  ({ id, labels: [], lastActivity: NOW - hoursAgo * H, light: 'grey', status: 'idle', repo: 'r', repoKey: 'r', worktree: null, branch: 'main', ...extra }) as SessionView

describe('visibleSessions', () => {
  const all = [s('old', 100), s('today', 1), s('yesterday', 20), s('waiting-old', 200, { light: 'red' }), s('closed', 2, { status: 'closed' })]
  const f = { lights: [], liveOnly: false, range: '3d' as const }

  it('sorts by date and applies the range, but always keeps sessions that need attention', () => {
    expect(visibleSessions(all, f, null, NOW).map((x) => x.id)).toEqual(['today', 'closed', 'yesterday', 'waiting-old'])
    expect(visibleSessions(all, { ...f, range: 'today' }, null, NOW).map((x) => x.id)).toEqual(['today', 'closed', 'waiting-old'])
  })

  it('filters by colour and open sessions', () => {
    expect(visibleSessions(all, { ...f, lights: ['red'] }, null, NOW).map((x) => x.id)).toEqual(['waiting-old'])
    expect(visibleSessions(all, { ...f, liveOnly: true }, null, NOW).map((x) => x.id)).not.toContain('closed')
  })

  it('search results ignore the time range', () => {
    expect(visibleSessions(all, f, [{ id: 'old', snippet: null }], NOW).map((x) => x.id)).toEqual(['old'])
  })

  it('leaves hidden sessions out, also from search, unless they are shown', () => {
    const withHidden = [...all, s('hidden', 1, { hidden: true })]
    expect(visibleSessions(withHidden, f, null, NOW).map((x) => x.id)).not.toContain('hidden')
    expect(visibleSessions(withHidden, f, [{ id: 'hidden', snippet: null }], NOW)).toEqual([])
    expect(visibleSessions(withHidden, { ...f, showHidden: true }, null, NOW).map((x) => x.id)).toContain('hidden')
  })

  it('keeps labelled sessions regardless of the range, and can show only one label', () => {
    const withLabel = [...all, s('merge-old', 500, { labels: ['pending-merge'] })]
    expect(visibleSessions(withLabel, f, null, NOW).map((x) => x.id)).toContain('merge-old')
    expect(visibleSessions(withLabel, { ...f, label: 'pending-merge' }, null, NOW).map((x) => x.id)).toEqual(['merge-old'])
  })

  it('shows only the ticked repos, and all repos when none are ticked', () => {
    const multi = [s('a1', 1, { repoKey: 'a' }), s('b1', 2, { repoKey: 'b' }), s('c1', 3, { repoKey: 'c' })]
    expect(visibleSessions(multi, { ...f, repos: ['a', 'c'] }, null, NOW).map((x) => x.id)).toEqual(['a1', 'c1'])
    expect(visibleSessions(multi, { ...f, repos: [] }, null, NOW).map((x) => x.id)).toEqual(['a1', 'b1', 'c1'])
  })
})

describe('repoOptions', () => {
  it('lists repos by name with counts, leaving out repos with only hidden sessions', () => {
    const list = [
      s('1', 1, { repo: 'web', repoKey: 'k/web' }),
      s('2', 1, { repo: 'api', repoKey: 'k/api' }),
      s('3', 1, { repo: 'web', repoKey: 'k/web' }),
      s('4', 1, { repo: 'old', repoKey: 'k/old', hidden: true })
    ]
    expect(repoOptions(list, false)).toEqual([
      { key: 'k/api', label: 'api', count: 1 },
      { key: 'k/web', label: 'web', count: 2 }
    ])
    expect(repoOptions(list, true).map((r) => r.key)).toEqual(['k/api', 'k/old', 'k/web'])
  })
})

describe('grouping', () => {
  it('groups by repo name, keeps the session order within a repo and keeps display order consistent', () => {
    const list = [s('b', 1, { repoKey: 'y', repo: 'Y' }), s('a', 2, { repoKey: 'x', repo: 'x', worktree: 'wt' }), s('c', 3, { repoKey: 'x', repo: 'x' }), s('d', 4, { repoKey: 'x', repo: 'x', worktree: 'wt' })]
    const groups = groupSessions(list)
    expect(groups.map((g) => [g.label, g.sessions.map((x) => x.id)])).toEqual([
      ['x', ['a', 'c', 'd']],
      ['Y', ['b']]
    ])
    expect(displayOrder(list, true).map((x) => x.id)).toEqual(['a', 'c', 'd', 'b'])
  })
})

describe('relTime', () => {
  it('formats compactly', () => {
    expect(relTime(NOW - 10_000, NOW)).toBe('now')
    expect(relTime(NOW - 5 * 60_000, NOW)).toBe('5m')
    expect(relTime(NOW - 3 * H, NOW)).toBe('3h')
    expect(relTime(NOW - 50 * H, NOW)).toBe('2d')
  })
})

describe('tray icon', () => {
  it('produces a valid PNG of the requested size', () => {
    const png = drawTrayIcon(32, 12, 'red')
    expect(png.subarray(1, 4).toString()).toBe('PNG')
    expect(png.readUInt32BE(16)).toBe(32)
    const idatLen = png.readUInt32BE(33)
    expect(png.subarray(37, 41).toString()).toBe('IDAT')
    expect(inflateSync(png.subarray(41, 41 + idatLen)).length).toBe((32 * 4 + 1) * 32)
  })
})

describe('time helpers', () => {
  it('formats durations', () => {
    expect(formatDuration(0)).toBe('0m')
    expect(formatDuration(20_000)).toBe('<1m')
    expect(formatDuration(65 * 60_000)).toBe('1h 05m')
  })

  it('clips periods to a local day', () => {
    const day = new Date(2026, 9, 1).getTime()
    expect(clipToDay([[day - H, day + H], [day + 30 * H, day + 31 * H]], day)).toEqual([[day, day + H]])
    expect(shiftDay('2026-10-31', 1)).toBe('2026-11-01')
  })

  it('exports a day as semicolon CSV with quoting', () => {
    const csv = dayCsv({
      date: '2026-10-01',
      sessions: {
        s1: { title: 'Fix; "quoted"', repo: 'shop', worktree: null, branch: 'main', folder: 'x', activeSeconds: 5400, intervals: [['2026-10-01T09:00:00+02:00', '2026-10-01T10:30:00+02:00']] }
      }
    })
    const [head, row] = csv.trim().split('\r\n')
    expect(head).toBe('date;repo;worktree;branch;title;start;end;active_minutes;periods;agent')
    expect(row.startsWith('2026-10-01;shop;;main;"Fix; ""quoted""";')).toBe(true)
    expect(row).toContain(';90;')
    // Day files from before Codex support have no agent: they are Claude Code.
    expect(row.endsWith(';claude')).toBe(true)
  })
})
