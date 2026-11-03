import { mkdirSync, utimesSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  fetchClaudeUsage,
  lastRateLimits,
  parseCodexRateLimits,
  parseOAuthUsage,
  parseStatusCache,
  readClaudeCredentials,
  readCodexUsage,
  UsageMonitor,
  USAGE_URL
} from '../../src/core/usage.ts'
import { formatReset, usageLevel, usageLive } from '../../src/renderer/src/view.ts'
import type { UsageSnapshot } from '../../src/shared/types.ts'
import { jsonl, tmpDir } from './helpers.ts'

const NOW = Date.parse('2026-11-03T12:00:00Z')
const H = 3600_000

describe('Claude usage parsing', () => {
  it('reads the oauth usage response, with ISO reset times', () => {
    const u = parseOAuthUsage(
      { five_hour: { utilization: 37.5, resets_at: '2026-11-03T14:00:00.123456+00:00' }, seven_day: { utilization: 12, resets_at: '2026-11-08T09:00:00+00:00' }, seven_day_opus: null },
      NOW
    )
    expect(u).toEqual({
      source: 'api',
      updatedAt: NOW,
      fiveHour: { percent: 37.5, resetsAt: Date.parse('2026-11-03T14:00:00.123Z') },
      sevenDay: { percent: 12, resetsAt: Date.parse('2026-11-08T09:00:00Z') }
    })
  })

  it('treats a null window as nothing used, and clamps silly values', () => {
    const u = parseOAuthUsage({ five_hour: null, seven_day: { utilization: 140, resets_at: null } }, NOW)
    expect(u?.fiveHour).toEqual({ percent: 0, resetsAt: null })
    expect(u?.sevenDay).toEqual({ percent: 100, resetsAt: null })
  })

  it('gives up on a format it does not know instead of showing zeros', () => {
    expect(parseOAuthUsage({ limits: [{ kind: 'x' }] }, NOW)).toBeNull()
    expect(parseOAuthUsage(null, NOW)).toBeNull()
    expect(parseOAuthUsage('nope', NOW)).toBeNull()
  })

  it('reads the status line cache file (fractions, epoch seconds)', () => {
    const u = parseStatusCache({ version: 2, updatedAt: '2026-11-03T11:00:00.000Z', usageData: { utilization5h: 0.03, utilization7d: 0.07, reset5hAt: 1791546600, reset7dAt: 1791828000 } })
    expect(u).toEqual({
      source: 'statusline',
      updatedAt: Date.parse('2026-11-03T11:00:00Z'),
      fiveHour: { percent: 3, resetsAt: 1791546600_000 },
      sevenDay: { percent: 7, resetsAt: 1791828000_000 }
    })
    expect(parseStatusCache({})).toBeNull()
  })
})

describe('Claude sign-in token', () => {
  const creds = (dir: string, oauth: object | null) => writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify(oauth === null ? { mcpOAuth: {} } : { claudeAiOauth: oauth }))

  it('returns a valid token and the plan', () => {
    const dir = tmpDir()
    creds(dir, { accessToken: 'tok', expiresAt: NOW + H, subscriptionType: 'max' })
    expect(readClaudeCredentials(dir, NOW)).toEqual({ token: 'tok', plan: 'max' })
  })

  it('stays silent without a Claude account (API-key users, no file)', () => {
    const dir = tmpDir()
    expect(readClaudeCredentials(dir, NOW)).toEqual({ token: null, error: null })
    creds(dir, null)
    expect(readClaudeCredentials(dir, NOW)).toEqual({ token: null, error: null })
  })

  it('does not use an expired token, and tells why', () => {
    const dir = tmpDir()
    creds(dir, { accessToken: 'tok', expiresAt: NOW - 1000 })
    const r = readClaudeCredentials(dir, NOW)
    expect(r.token).toBeNull()
    expect((r as { error: string }).error).toMatch(/expired/)
  })
})

describe('Claude usage request', () => {
  const reply = (status: number, body: unknown = {}, headers: Record<string, string> = {}) => async () => ({
    status,
    json: async () => body,
    headers: { get: (n: string) => headers[n.toLowerCase()] ?? null }
  })

  it('sends the token to the usage URL and nowhere else', async () => {
    const fetchFn = vi.fn(reply(200, { five_hour: { utilization: 10, resets_at: '2026-11-03T14:00:00Z' } }))
    const res = await fetchClaudeUsage('secret-token', fetchFn, NOW)
    expect('usage' in res && res.usage.fiveHour?.percent).toBe(10)
    expect(fetchFn).toHaveBeenCalledTimes(1)
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, { headers: Record<string, string> }]
    expect(url).toBe(USAGE_URL)
    expect(init.headers.Authorization).toBe('Bearer secret-token')
  })

  it('maps failures to a sentence, honours Retry-After and never throws', async () => {
    expect(await fetchClaudeUsage('t', reply(401), NOW)).toMatchObject({ error: expect.stringMatching(/sign-in/) })
    expect(await fetchClaudeUsage('t', reply(429, {}, { 'retry-after': '120' }), NOW)).toMatchObject({ retryAfterMs: 120_000 })
    expect(await fetchClaudeUsage('t', reply(500), NOW)).toMatchObject({ error: expect.stringMatching(/500/) })
    expect(await fetchClaudeUsage('t', reply(200, { surprise: true }), NOW)).toMatchObject({ error: expect.stringMatching(/format/) })
    expect(await fetchClaudeUsage('t', async () => { throw new Error('offline') }, NOW)).toMatchObject({ error: expect.stringMatching(/reach/) })
  })
})

describe('Codex usage', () => {
  const rl = (primary: number, secondary: number, extra: object = {}) => ({
    limit_id: 'codex',
    limit_name: null,
    primary: { used_percent: primary, window_minutes: 300, resets_at: 1793459713 },
    secondary: { used_percent: secondary, window_minutes: 10080, resets_at: 1793951020 },
    credits: { has_credits: true },
    ...extra
  })
  const tokenCount = (ts: string, limits: unknown) => ({ timestamp: ts, type: 'event_msg', payload: { type: 'token_count', info: null, rate_limits: limits } })

  it('maps primary and secondary by window length', () => {
    expect(parseCodexRateLimits(rl(5, 1), 7)).toEqual({
      source: 'log',
      updatedAt: 7,
      fiveHour: { percent: 5, resetsAt: 1793459713_000 },
      sevenDay: { percent: 1, resetsAt: 1793951020_000 }
    })
    // A plan with only a weekly window reports it as primary.
    const weekly = parseCodexRateLimits({ limit_id: 'codex', primary: { used_percent: 40, window_minutes: 10080, resets_at: 1793951020 }, secondary: null }, 7)
    expect(weekly?.fiveHour).toBeNull()
    expect(weekly?.sevenDay?.percent).toBe(40)
  })

  it('ignores other limit ids', () => {
    expect(parseCodexRateLimits(rl(5, 1, { limit_id: 'codex_other' }), 7)).toBeNull()
  })

  it('takes the newest rate_limits event of a tail, skipping a cut-off first line and events without limits', () => {
    const tail = jsonl(tokenCount('2026-11-03T10:00:00Z', rl(5, 1)), tokenCount('2026-11-03T11:00:00Z', rl(9, 2)), tokenCount('2026-11-03T11:30:00Z', null), { type: 'event_msg', payload: { type: 'task_complete' } })
    const u = lastRateLimits(tail + '{"broken', 0)
    expect(u?.fiveHour?.percent).toBe(9)
    expect(u?.updatedAt).toBe(Date.parse('2026-11-03T11:00:00Z'))
  })

  it('reads the newest rollouts in a codex dir', async () => {
    const dir = tmpDir()
    const day = path.join(dir, 'sessions', '2026', '11', '03')
    mkdirSync(day, { recursive: true })
    const old = path.join(day, 'rollout-a.jsonl')
    const fresh = path.join(day, 'rollout-b.jsonl')
    writeFileSync(old, jsonl(tokenCount('2026-11-03T09:00:00Z', rl(1, 1))))
    writeFileSync(fresh, jsonl(tokenCount('2026-11-03T11:00:00Z', rl(20, 4))))
    utimesSync(old, new Date(NOW - 3 * H), new Date(NOW - 3 * H))
    utimesSync(fresh, new Date(NOW - H), new Date(NOW - H))
    const u = await readCodexUsage(dir)
    expect(u?.fiveHour?.percent).toBe(20)
    expect(u?.sevenDay?.percent).toBe(4)
  })

  it('returns null for a missing codex dir', async () => {
    expect(await readCodexUsage(path.join(tmpDir(), 'nope'))).toBeNull()
  })

  it.each(['2026/11/01', '2026/10/31', '2025/12/31'])('reads recently updated sessions in older directories (%s)', async (olderDate) => {
    const dir = tmpDir()
    const readings = [
      { date: olderDate, percent: 90, time: NOW },
      { date: '2026/11/02', percent: 10, time: NOW - 24 * H },
      { date: '2026/11/03', percent: 20, time: NOW - H }
    ]
    for (const reading of readings) {
      const day = path.join(dir, 'sessions', reading.date)
      mkdirSync(day, { recursive: true })
      const file = path.join(day, 'rollout-session.jsonl')
      const time = new Date(reading.time)
      writeFileSync(file, jsonl(tokenCount(time.toISOString(), rl(reading.percent, 4))))
      utimesSync(file, time, time)
    }

    expect(await readCodexUsage(dir)).toMatchObject({ updatedAt: NOW, fiveHour: { percent: 90 } })
  })
})

describe('UsageMonitor', () => {
  let monitor: UsageMonitor | null = null
  afterEach(() => monitor?.stop())

  const setup = (oauth: object | null = { accessToken: 'tok', expiresAt: NOW + H, subscriptionType: 'pro' }) => {
    const claudeDir = tmpDir()
    if (oauth) writeFileSync(path.join(claudeDir, '.credentials.json'), JSON.stringify({ claudeAiOauth: oauth }))
    return { claudeDir, codexDir: tmpDir() }
  }
  const ok = (pct: number) => async () => ({
    status: 200,
    json: async () => ({ five_hour: { utilization: pct, resets_at: '2026-11-03T14:00:00Z' }, seven_day: { utilization: 2, resets_at: '2026-11-08T09:00:00Z' } }),
    headers: { get: () => null }
  })

  it('does not call the API unless the user opted in', async () => {
    const fetchFn = vi.fn(ok(30))
    monitor = new UsageMonitor({ ...setup(), fetch: fetchFn, now: () => NOW })
    await monitor.refresh()
    expect(fetchFn).not.toHaveBeenCalled()
    expect(monitor.snapshot().claude).toBeNull()
  })

  it.each([{ enabled: false }, { fromApi: false }])('does not start an API request after disabling usage during a scan (%j)', async (setting) => {
    const fetchFn = vi.fn(ok(30))
    monitor = new UsageMonitor({ ...setup(), fetch: fetchFn, now: () => NOW, fromApi: true })
    const seen: UsageSnapshot[] = []
    monitor.on('change', (snapshot) => seen.push(snapshot))

    const pending = monitor.refresh()
    monitor.configure(setting)
    await pending

    expect(fetchFn).not.toHaveBeenCalled()
    expect(seen.at(-1)).toMatchObject(setting)
    monitor.configure({ enabled: true, fromApi: true })
    await monitor.refresh()
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(monitor.snapshot().claude?.fiveHour?.percent).toBe(30)
  })

  it('reads live Claude usage once opted in, and emits the change', async () => {
    const fetchFn = vi.fn(ok(30))
    monitor = new UsageMonitor({ ...setup(), fetch: fetchFn, now: () => NOW })
    const seen: UsageSnapshot[] = []
    monitor.on('change', (s) => seen.push(s))
    monitor.configure({ fromApi: true })
    await monitor.refresh()
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(monitor.snapshot().claude?.fiveHour?.percent).toBe(30)
    expect(monitor.snapshot().claudeNote).toBeNull()
    expect(seen.at(-1)?.claude?.source).toBe('api')
  })

  it('asks the API at most once per interval, however often it refreshes', async () => {
    const fetchFn = vi.fn(ok(30))
    let now = NOW
    monitor = new UsageMonitor({ ...setup(), fetch: fetchFn, now: () => now, fromApi: true })
    await monitor.refresh()
    await monitor.refresh()
    now += 60_000
    await monitor.refresh()
    expect(fetchFn).toHaveBeenCalledTimes(1)
    now += 5 * 60_000
    await monitor.refresh()
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })

  it('keeps the last good reading and explains when a later request fails', async () => {
    let now = NOW
    let fail = false
    const fetchFn = vi.fn(async () => (fail ? { status: 500, json: async () => ({}), headers: { get: () => null } } : await ok(44)()))
    monitor = new UsageMonitor({ ...setup(), fetch: fetchFn, now: () => now, fromApi: true })
    await monitor.refresh()
    fail = true
    now += 6 * 60_000
    await monitor.refresh()
    expect(monitor.snapshot().claude?.fiveHour?.percent).toBe(44)
    expect(monitor.snapshot().claudeNote).toMatch(/500/)
  })

  it('does not call the API with an expired token', async () => {
    const fetchFn = vi.fn(ok(30))
    monitor = new UsageMonitor({ ...setup({ accessToken: 'tok', expiresAt: NOW - 1 }), fetch: fetchFn, now: () => NOW, fromApi: true })
    await monitor.refresh()
    expect(fetchFn).not.toHaveBeenCalled()
    expect(monitor.snapshot().claudeNote).toMatch(/expired/)
  })

  it('falls back to the status line cache when the API is off', async () => {
    const dirs = setup(null)
    writeFileSync(path.join(dirs.claudeDir, 'vscode-claude-status-cache.json'), JSON.stringify({ updatedAt: '2026-11-03T11:00:00Z', usageData: { utilization5h: 0.5, utilization7d: 0.1, reset5hAt: 1793459713, reset7dAt: 1793951020 } }))
    monitor = new UsageMonitor({ ...dirs, now: () => NOW })
    await monitor.refresh()
    expect(monitor.snapshot().claude).toMatchObject({ source: 'statusline', fiveHour: { percent: 50 } })
  })

  it('reads nothing when switched off', async () => {
    const dirs = setup(null)
    const day = path.join(dirs.codexDir, 'sessions', '2026', '11', '03')
    mkdirSync(day, { recursive: true })
    writeFileSync(path.join(day, 'rollout-a.jsonl'), jsonl({ timestamp: '2026-11-03T11:00:00Z', payload: { rate_limits: { limit_id: 'codex', primary: { used_percent: 5, window_minutes: 300, resets_at: 1793459713 } } } }))
    monitor = new UsageMonitor({ ...dirs, now: () => NOW, enabled: false })
    await monitor.refresh()
    expect(monitor.snapshot()).toMatchObject({ enabled: false, codex: null, claude: null })
    monitor.configure({ enabled: true })
    await monitor.refresh()
    expect(monitor.snapshot().codex?.fiveHour?.percent).toBe(5)
  })
})

describe('usage display helpers', () => {
  it('counts a window as current until its reset time has passed', () => {
    expect(usageLive({ percent: 5, resetsAt: NOW + 1 }, NOW)).toBe(true)
    expect(usageLive({ percent: 5, resetsAt: NOW }, NOW)).toBe(false)
    expect(usageLive({ percent: 0, resetsAt: null }, NOW)).toBe(true)
    expect(usageLive(null, NOW)).toBe(false)
  })

  it('formats the time to a reset', () => {
    expect(formatReset(NOW + 20_000, NOW)).toBe('1m')
    expect(formatReset(NOW - 5, NOW)).toBe('<1m')
    expect(formatReset(NOW + 45 * 60_000, NOW)).toBe('45m')
    expect(formatReset(NOW + 2 * H + 10 * 60_000, NOW)).toBe('2h 10m')
    expect(formatReset(NOW + 4 * 24 * H + 3 * H, NOW)).toBe('4d 3h')
  })

  it('warns from 70 % and alarms from 90 %', () => {
    expect([0, 69, 70, 89, 90, 100].map(usageLevel)).toEqual(['ok', 'ok', 'warn', 'warn', 'high', 'high'])
  })
})
