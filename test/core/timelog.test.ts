import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { SearchIndex } from '../../src/core/search.ts'
import { activityIntervals, localDayKey, splitByDay, TimeLog, toLocalIso, totalMs } from '../../src/core/timelog.ts'
import { tmpDir } from './helpers.ts'

const local = (y: number, mo: number, d: number, h: number, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime()
const MIN = 60_000

describe('activityIntervals', () => {
  it('joins activity separated by at most the gap', () => {
    const t0 = local(2026, 10, 1, 9)
    const times = [t0, t0 + 2 * MIN, t0 + 14 * MIN, t0 + 40 * MIN, t0 + 41 * MIN]
    expect(activityIntervals(times, 15 * MIN)).toEqual([
      [t0, t0 + 14 * MIN],
      [t0 + 40 * MIN, t0 + 41 * MIN]
    ])
    expect(totalMs(activityIntervals(times, 15 * MIN))).toBe(15 * MIN)
    expect(activityIntervals(times, 60 * MIN)).toEqual([[t0, t0 + 41 * MIN]])
  })
})

describe('splitByDay', () => {
  it('splits a period at local midnight', () => {
    const days = splitByDay([[local(2026, 10, 1, 23, 50), local(2026, 10, 2, 0, 20)]])
    expect([...days.keys()]).toEqual(['2026-10-01', '2026-10-02'])
    expect(totalMs(days.get('2026-10-01')!)).toBe(10 * MIN - 1)
    expect(totalMs(days.get('2026-10-02')!)).toBe(20 * MIN)
  })

  it('formats local ISO times with offset', () => {
    expect(toLocalIso(local(2026, 10, 1, 9, 5))).toMatch(/^2026-10-01T09:05:00[+-]\d\d:\d\d$/)
    expect(localDayKey(local(2026, 1, 2, 3))).toBe('2026-01-02')
  })
})

describe('TimeLog', () => {
  const meta = { agent: 'claude' as const, title: 'Fix bug', repo: 'shop', worktree: null, branch: 'main', folder: 'c:\\dev\\shop' }

  it('writes one readable file per day', () => {
    const dir = path.join(tmpDir(), 'time')
    const log = new TimeLog(dir)
    log.setSession('s1', meta, [
      [local(2026, 10, 1, 9), local(2026, 10, 1, 10)],
      [local(2026, 10, 2, 8), local(2026, 10, 2, 8, 30)]
    ])
    log.flush()
    expect(readdirSync(dir).sort()).toEqual(['2026-10-01.json', '2026-10-02.json'])
    const day = JSON.parse(readFileSync(path.join(dir, '2026-10-01.json'), 'utf8'))
    expect(day.sessions.s1).toMatchObject({ title: 'Fix bug', repo: 'shop', activeSeconds: 3600 })
    expect(day.sessions.s1.intervals[0][0]).toMatch(/^2026-10-01T09:00:00/)
    expect(new TimeLog(dir).getDay('2026-10-02').sessions.s1.activeSeconds).toBe(1800)
    expect(new TimeLog(dir).listDays()).toEqual(['2026-10-02', '2026-10-01'])
  })

  it('removes a session from days it no longer covers within its span, and keeps days outside it', () => {
    const log = new TimeLog(path.join(tmpDir(), 'time'))
    log.setSession('s1', meta, [
      [local(2026, 9, 1, 9), local(2026, 9, 1, 10)],
      [local(2026, 10, 1, 9), local(2026, 10, 1, 10)],
      [local(2026, 10, 3, 9), local(2026, 10, 3, 10)]
    ])
    // Later the transcript covers 1–3 Oct but has no activity on the 1st any more.
    log.setSession('s1', meta, [
      [local(2026, 10, 1, 0), local(2026, 10, 1, 0)],
      [local(2026, 10, 2, 9), local(2026, 10, 3, 10)]
    ])
    expect(log.getDay('2026-09-01').sessions.s1).toBeDefined()
    expect(log.getDay('2026-10-01').sessions.s1.activeSeconds).toBe(0)
    expect(log.getDay('2026-10-02').sessions.s1).toBeDefined()
    log.setSession('s1', meta, [[local(2026, 10, 2, 9), local(2026, 10, 3, 10)]])
    expect(log.getDay('2026-10-01').sessions.s1).toBeDefined()
  })
})

describe('SearchIndex.set', () => {
  it('reports whether searchable content changed', () => {
    const idx = new SearchIndex()
    expect(idx.set({ id: 'a', meta: ['t'], texts: ['p1'] })).toBe(true)
    expect(idx.set({ id: 'a', meta: ['t'], texts: ['p1'] })).toBe(false)
    expect(idx.set({ id: 'a', meta: ['t'], texts: ['p1', 'p2'] })).toBe(true)
  })
})
