import { inflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { drawTrayIcon } from '../../src/main/icon.ts'
import { clipToDay, dayCsv, displayOrder, flattenGroups, formatDuration, groupSessions, inRepos, relTime, repoNameOptions, repoOptions, shiftDay, visibleSessions, workDetail, workJournalText } from '../../src/renderer/src/view.ts'
import type { SessionView, WorkItem, WorkJournalEntry } from '../../src/shared/types.ts'

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

describe('pinned sessions', () => {
  const f = { lights: [], liveOnly: false, range: 'all' as const }
  const ids = (list: SessionView[]) => list.map((x) => x.id)
  const at = (id: string, lastActivity: number, extra: Partial<SessionView> = {}) => s(id, 0, { lastActivity, ...extra })

  it('come first, newest first, then the others', () => {
    const list = [at('A', 300), at('B', 100, { pinned: true }), at('C', 200, { pinned: true })]
    expect(ids(visibleSessions(list, f, null, NOW))).toEqual(['C', 'B', 'A'])
  })

  it('stay in the list whatever the time range', () => {
    const old = s('old', 48, { pinned: true })
    expect(ids(visibleSessions([old], { ...f, range: 'today' }, null, NOW))).toEqual(['old'])
    expect(ids(visibleSessions([{ ...old, pinned: false }], { ...f, range: 'today' }, null, NOW))).toEqual([])
  })

  const p = (extra: Partial<SessionView> = {}) => s('p', 1, { pinned: true, light: 'grey', status: 'closed', repoKey: 'k/a', labels: [], ...extra })

  it('are left out by a colour filter without their light', () => {
    expect(ids(visibleSessions([p()], { ...f, lights: ['red'] }, null, NOW))).toEqual([])
  })

  it('are left out by Open only when closed', () => {
    expect(ids(visibleSessions([p()], { ...f, liveOnly: true }, null, NOW))).toEqual([])
  })

  it('are left out by a repo filter without their repo', () => {
    expect(ids(visibleSessions([p()], { ...f, repos: ['k/b'] }, null, NOW))).toEqual([])
  })

  it('are left out by a label filter for a label they do not have', () => {
    expect(ids(visibleSessions([p()], { ...f, label: 'pending-merge' }, null, NOW))).toEqual([])
  })

  it('are left out when hidden and hidden sessions are not shown', () => {
    expect(ids(visibleSessions([p({ hidden: true })], { ...f, showHidden: false }, null, NOW))).toEqual([])
  })

  it('are left out by a search that does not find them', () => {
    expect(ids(visibleSessions([p()], f, [{ id: 'other', snippet: null }], NOW))).toEqual([])
  })

  it('get their own Pinned group above the repos, and not in their repo group', () => {
    const list = visibleSessions(
      [
        at('x1', 500, { repoKey: 'x', repo: 'x' }),
        at('y1', 400, { repoKey: 'y', repo: 'Y' }),
        at('xp-old', 100, { repoKey: 'x', repo: 'x', pinned: true }),
        at('yp-new', 300, { repoKey: 'y', repo: 'Y', pinned: true }),
        at('zp', 200, { repoKey: 'z', repo: 'z', pinned: true })
      ],
      f,
      null,
      NOW
    )
    const groups = groupSessions(list)
    expect(groups.map((g) => [g.key, g.label, ids(g.sessions)])).toEqual([
      ['__pinned', 'Pinned', ['yp-new', 'zp', 'xp-old']],
      ['x', 'x', ['x1']],
      ['y', 'Y', ['y1']]
    ])
  })

  it('leave the grouping as it was when none are pinned', () => {
    const list = [s('b', 1, { repoKey: 'y', repo: 'Y' }), s('a', 2, { repoKey: 'x', repo: 'x' })]
    expect(groupSessions(list)).toEqual([
      { key: 'x', label: 'x', sessions: [list[1]] },
      { key: 'y', label: 'Y', sessions: [list[0]] }
    ])
  })

  it('come first in the display order, grouped or flat', () => {
    const list = visibleSessions([at('b', 500, { repoKey: 'b', repo: 'b' }), at('a', 400, { repoKey: 'a', repo: 'a' }), at('p', 100, { repoKey: 'b', repo: 'b', pinned: true })], f, null, NOW)
    expect(ids(displayOrder(list, true))).toEqual(['p', 'a', 'b'])
    expect(ids(flattenGroups(groupSessions(list)))).toEqual(['p', 'a', 'b'])
    expect(ids(displayOrder(list, false))).toEqual(['p', 'b', 'a'])
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

describe('repoNameOptions', () => {
  it('counts repos by name and keeps picked repos that are not in the list', () => {
    expect(repoNameOptions(['web', 'Api', 'web'], ['gone'])).toEqual([
      { key: 'Api', label: 'Api', count: 1 },
      { key: 'gone', label: 'gone', count: 0 },
      { key: 'web', label: 'web', count: 2 }
    ])
  })

  it('lets everything through when nothing is picked', () => {
    expect(inRepos('web', [])).toBe(true)
    expect(inRepos('web', ['api'])).toBe(false)
    expect(inRepos('api', ['api'])).toBe(true)
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

describe('work', () => {
  const item = (extra: Partial<WorkItem>): WorkItem => ({ key: 'k', repoPath: 'c:\\dev\\r', repo: 'r', root: false, name: 'fix', path: 'c:\\dev\\r\\.claude\\worktrees\\fix', branch: 'fix', base: 'main', state: 'new', changed: 0, ahead: 0, toPush: null, hasRemote: true, sessionOpen: false, locked: false, lastCommitAt: null, pr: null, ...extra })

  it('says what is in a worktree and how far it has come', () => {
    expect(workDetail(item({}))).toBe('No commits yet · from main')
    expect(workDetail(item({ state: 'uncommitted', changed: 1, ahead: 2 }))).toBe('1 file changed · 2 commits not in main')
    expect(workDetail(item({ state: 'pending-merge', ahead: 1 }))).toBe('1 commit not in main · not pushed')
    expect(workDetail(item({ state: 'pending-merge', ahead: 3, toPush: 2 }))).toBe('3 commits not in main · 2 commits to push')
    expect(workDetail(item({ state: 'pending-merge', ahead: 3, toPush: 0 }))).toBe('3 commits not in main · pushed')
    expect(workDetail(item({ state: 'pending-merge', ahead: 3, hasRemote: false }))).toBe('3 commits not in main')
    expect(workDetail(item({ state: 'pending-merge', ahead: 1, toPush: 0, pr: { number: 8, url: 'https://github.com/o/r/pull/8' } }))).toBe('1 commit not in main · pushed · pull request #8 open')
    expect(workDetail(item({ state: 'ready' }))).toBe('Everything is in main')
    expect(workDetail(item({ state: 'working' }))).toBe('A session is busy here')
  })

  it("says what is left in the repo's own folder", () => {
    const own = (extra: Partial<WorkItem>) => item({ root: true, name: 'r', path: 'c:\\dev\\r', branch: 'main', base: null, toPush: 0, ...extra })
    expect(workDetail(own({ state: 'uncommitted', changed: 2 }))).toBe('2 files changed')
    expect(workDetail(own({ state: 'uncommitted', changed: 1, toPush: 3 }))).toBe('1 file changed · 3 commits to push')
    expect(workDetail(own({ state: 'unpushed', toPush: 1 }))).toBe('1 commit to push')
    expect(workDetail(own({ state: 'pending-merge', branch: 'feat', base: 'main', ahead: 2 }))).toBe('2 commits not in main · pushed')
  })

  it('tells the history in sentences', () => {
    const e = (extra: Partial<WorkJournalEntry>): WorkJournalEntry => ({ at: '2026-11-11T10:00:00.000Z', action: 'create', repo: 'r', repoPath: 'c:\\dev\\r', worktree: 'fix', branch: 'fix', base: 'main', ok: true, ...extra })
    expect(workJournalText(e({}))).toBe('Created fix from main')
    expect(workJournalText(e({ action: 'commit', agent: 'claude' }))).toBe('Claude committed in fix')
    expect(workJournalText(e({ action: 'commit', agent: 'claude', ok: false, detail: 'stopped' }))).toBe('Commit in fix did not finish (stopped)')
    expect(workJournalText(e({ action: 'merge', detail: 'into main' }))).toBe('Merged fix into main')
    expect(workJournalText(e({ action: 'merge', detail: 'into dev', ok: false }))).toBe('Could not merge fix into dev')
    expect(workJournalText(e({ action: 'pr', detail: 'into main', url: 'https://github.com/o/r/pull/8' }))).toBe('Opened a pull request for fix into main')
    expect(workJournalText(e({ action: 'pr', detail: 'into main', ok: false }))).toBe('Could not open a pull request for fix into main')
    expect(workJournalText(e({ action: 'cleanup', detail: 'discarded unmerged work' }))).toBe('Removed fix (discarded unmerged work)')
  })
})
