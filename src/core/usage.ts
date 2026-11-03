// Plan usage: how much of the 5-hour and weekly limits Claude and Codex have used.
//
// Claude: Claude Code keeps its sign-in token in ~/.claude/.credentials.json. With the user's opt-in the token asks
//   GET https://api.anthropic.com/api/oauth/usage
// (undocumented, the endpoint Claude Code's own /usage view reads) for {five_hour, seven_day}: {utilization, resets_at}.
// Without opt-in, only a local cache file is read, if a status line helper writes one (~/.claude/vscode-claude-status-cache.json).
// The token is only read, never refreshed (refreshing could sign Claude Code out), never stored and never logged.
//
// Codex: every token_count event in a rollout file carries rate_limits {primary, secondary}: used_percent, window_minutes,
// resets_at. The newest such event in the newest rollout files is the current state.

import { EventEmitter } from 'node:events'
import { existsSync, readFileSync } from 'node:fs'
import { open, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import type { AgentUsage, UsageSnapshot, UsageWindow } from '../shared/types.ts'

export const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const STATUS_CACHE_FILE = 'vscode-claude-status-cache.json'
/** How often local files are read, and how often (at most) the API is asked. */
const LOCAL_POLL_MS = 30_000
const API_MIN_INTERVAL_MS = 5 * 60_000
const API_BACKOFF_MS = 15 * 60_000
const API_TIMEOUT_MS = 10_000
const TOKEN_SKEW_MS = 30_000
const TAIL_BYTES = 256 * 1024

const clampPct = (n: number) => Math.max(0, Math.min(100, n))

/** Epoch seconds, epoch milliseconds or an ISO string to epoch ms; null if it is none of those. */
function toMs(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v < 1e12 ? v * 1000 : v
  if (typeof v === 'string') {
    const t = Date.parse(v)
    return Number.isNaN(t) ? null : t
  }
  return null
}

// ---------- Claude ----------

function apiWindow(v: unknown): UsageWindow | null {
  // null means no window is running: nothing used.
  if (v === null) return { percent: 0, resetsAt: null }
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  const used = o.utilization ?? o.used_percentage
  if (typeof used !== 'number' || !Number.isFinite(used)) return null
  return { percent: clampPct(used), resetsAt: toMs(o.resets_at ?? o.resetsAt) }
}

/** The /api/oauth/usage response, or null if it has neither window (the format changed). */
export function parseOAuthUsage(json: unknown, now: number): AgentUsage | null {
  if (!json || typeof json !== 'object') return null
  const o = json as Record<string, unknown>
  const fiveHour = apiWindow(o.five_hour)
  const sevenDay = apiWindow(o.seven_day)
  if (!fiveHour && !sevenDay) return null
  return { source: 'api', updatedAt: now, fiveHour, sevenDay }
}

/** The cache file a status line helper writes from Claude Code's status line payload. */
export function parseStatusCache(json: unknown): AgentUsage | null {
  const u = (json as any)?.usageData
  if (!u || typeof u !== 'object') return null
  const win = (frac: unknown, reset: unknown): UsageWindow | null =>
    typeof frac === 'number' && Number.isFinite(frac) ? { percent: clampPct(Math.round(frac * 1000) / 10), resetsAt: toMs(reset) } : null
  const fiveHour = win(u.utilization5h, u.reset5hAt)
  const sevenDay = win(u.utilization7d, u.reset7dAt)
  if (!fiveHour && !sevenDay) return null
  return { source: 'statusline', updatedAt: toMs((json as any).updatedAt) ?? 0, fiveHour, sevenDay }
}

export type Credentials = { token: string; plan: string | null } | { token: null; error: string | null }

/**
 * The access token Claude Code stored. `error` is null when there is simply no Claude account to ask (API-key users),
 * and a sentence for the UI when there is one but it cannot be used right now.
 */
export function readClaudeCredentials(claudeDir: string, now: number): Credentials {
  let raw: any
  try {
    raw = JSON.parse(readFileSync(path.join(claudeDir, '.credentials.json'), 'utf8'))
  } catch {
    return { token: null, error: null }
  }
  const oauth = raw?.claudeAiOauth
  if (!oauth || typeof oauth.accessToken !== 'string' || !oauth.accessToken) return { token: null, error: null }
  if (typeof oauth.expiresAt === 'number' && oauth.expiresAt <= now + TOKEN_SKEW_MS) {
    return { token: null, error: 'The Claude sign-in has expired. Use Claude Code once and it refreshes.' }
  }
  return { token: oauth.accessToken, plan: typeof oauth.subscriptionType === 'string' ? oauth.subscriptionType : null }
}

type FetchLike = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{
  status: number
  json(): Promise<unknown>
  headers: { get(name: string): string | null }
}>

type ApiResult = { usage: AgentUsage } | { error: string; retryAfterMs?: number }

export async function fetchClaudeUsage(token: string, fetchFn: FetchLike, now: number): Promise<ApiResult> {
  try {
    const res = await fetchFn(USAGE_URL, {
      headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20', 'User-Agent': 'vibe-session-manager' },
      signal: AbortSignal.timeout(API_TIMEOUT_MS)
    })
    if (res.status === 401 || res.status === 403) return { error: 'Claude refused the sign-in token. Use Claude Code once and it refreshes.' }
    if (res.status === 429) {
      const secs = Number(res.headers.get('retry-after'))
      return { error: 'Claude asked to slow down; trying again later.', retryAfterMs: Number.isFinite(secs) && secs > 0 ? secs * 1000 : API_BACKOFF_MS }
    }
    if (res.status !== 200) return { error: `Claude usage is unavailable (HTTP ${res.status}).`, retryAfterMs: API_BACKOFF_MS }
    const usage = parseOAuthUsage(await res.json(), now)
    return usage ? { usage } : { error: 'Claude usage came back in a format this version does not know.', retryAfterMs: API_BACKOFF_MS }
  } catch {
    return { error: 'Could not reach Claude to read the usage.' }
  }
}

// ---------- Codex ----------

/** Codex's rate_limits object. The window length tells which is which; the plain order is the fallback. */
export function parseCodexRateLimits(rl: any, updatedAt: number): AgentUsage | null {
  if (!rl || typeof rl !== 'object') return null
  if (typeof rl.limit_id === 'string' && rl.limit_id !== 'codex') return null
  const win = (w: any): { win: UsageWindow; minutes: number | null } | null =>
    w && typeof w.used_percent === 'number' && Number.isFinite(w.used_percent)
      ? { win: { percent: clampPct(w.used_percent), resetsAt: toMs(w.resets_at) }, minutes: typeof w.window_minutes === 'number' ? w.window_minutes : null }
      : null
  const windows = [win(rl.primary), win(rl.secondary)].filter((w): w is NonNullable<typeof w> => !!w)
  if (!windows.length) return null
  let fiveHour: UsageWindow | null = null
  let sevenDay: UsageWindow | null = null
  for (const [i, w] of windows.entries()) {
    const long = w.minutes !== null ? w.minutes >= 24 * 60 : i === 1
    if (long) sevenDay ??= w.win
    else fiveHour ??= w.win
  }
  return { source: 'log', updatedAt, fiveHour, sevenDay }
}

async function listDesc(dir: string, re: RegExp): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((n) => re.test(n)).sort((a, b) => Number(b) - Number(a))
  } catch {
    return []
  }
}

/** The most recently modified rollout files across all session dates. */
async function newestRollouts(codexDir: string, limit: number): Promise<{ file: string; mtime: number; size: number }[]> {
  const root = path.join(codexDir, 'sessions')
  const found: { file: string; mtime: number; size: number }[] = []
  for (const y of await listDesc(root, /^\d{4}$/)) {
    for (const m of await listDesc(path.join(root, y), /^\d{2}$/)) {
      for (const d of await listDesc(path.join(root, y, m), /^\d{2}$/)) {
        const dir = path.join(root, y, m, d)
        let names: string[] = []
        try {
          names = (await readdir(dir)).filter((n) => n.endsWith('.jsonl'))
        } catch {}
        for (const n of names) {
          try {
            const s = await stat(path.join(dir, n))
            found.push({ file: path.join(dir, n), mtime: s.mtimeMs, size: s.size })
          } catch {}
        }
      }
    }
  }
  return found.sort((a, b) => b.mtime - a.mtime).slice(0, limit)
}

async function readTail(file: string, size: number): Promise<string> {
  const fh = await open(file, 'r')
  try {
    const len = Math.min(size, TAIL_BYTES)
    const buf = Buffer.alloc(len)
    await fh.read(buf, 0, len, size - len)
    const text = buf.toString('utf8')
    // A tail starts mid-line; drop that piece.
    return size > len ? text.slice(text.indexOf('\n') + 1) : text
  } finally {
    await fh.close()
  }
}

/** Newest rate_limits event of one rollout file's tail. */
export function lastRateLimits(tail: string, fallbackTime: number): AgentUsage | null {
  const lines = tail.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"rate_limits"')) continue
    try {
      const o = JSON.parse(lines[i])
      const usage = parseCodexRateLimits(o?.payload?.rate_limits ?? o?.rate_limits, toMs(o?.timestamp) ?? fallbackTime)
      if (usage) return usage
    } catch {}
  }
  return null
}

const codexCache = new Map<string, { key: string; usage: AgentUsage | null }>()

export async function readCodexUsage(codexDir: string): Promise<AgentUsage | null> {
  let best: AgentUsage | null = null
  for (const f of await newestRollouts(codexDir, 4)) {
    const key = `${f.mtime}:${f.size}`
    let hit = codexCache.get(f.file)
    if (hit?.key !== key) {
      let usage: AgentUsage | null = null
      try {
        usage = lastRateLimits(await readTail(f.file, f.size), f.mtime)
      } catch {}
      hit = { key, usage }
      if (codexCache.size > 50) codexCache.clear()
      codexCache.set(f.file, hit)
    }
    if (hit.usage && (!best || hit.usage.updatedAt > best.updatedAt)) best = hit.usage
  }
  return best
}

// ---------- monitor ----------

export interface UsageMonitorOptions {
  claudeDir: string
  codexDir: string
  fetch?: FetchLike
  now?: () => number
  /** Ask the Claude API for live usage. Off until the user opts in. */
  fromApi?: boolean
  enabled?: boolean
}

export class UsageMonitor extends EventEmitter {
  private fromApi: boolean
  private enabled: boolean
  private claude: AgentUsage | null = null
  private codex: AgentUsage | null = null
  private note: string | null = null
  private lastApi: AgentUsage | null = null
  private nextApiAt = 0
  private timer: NodeJS.Timeout | null = null
  private running: Promise<void> | null = null
  private last = ''
  private readonly now: () => number
  private readonly fetchFn: FetchLike

  private readonly opts: UsageMonitorOptions

  constructor(opts: UsageMonitorOptions) {
    super()
    this.opts = opts
    this.fromApi = !!opts.fromApi
    this.enabled = opts.enabled ?? true
    this.now = opts.now ?? Date.now
    this.fetchFn = opts.fetch ?? ((url, init) => fetch(url, init))
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => void this.refresh(), LOCAL_POLL_MS)
    this.timer.unref?.()
    void this.refresh()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  configure(o: { fromApi?: boolean; enabled?: boolean }): void {
    if (o.fromApi !== undefined && o.fromApi !== this.fromApi) {
      this.fromApi = o.fromApi
      this.nextApiAt = 0
      this.note = null
    }
    if (o.enabled !== undefined) this.enabled = o.enabled
    void this.refresh()
  }

  snapshot(): UsageSnapshot {
    return { enabled: this.enabled, fromApi: this.fromApi, claude: this.claude, codex: this.codex, claudeNote: this.note }
  }

  /** Reads the sources again. Calls overlapping a running refresh share it. */
  refresh(): Promise<void> {
    this.running ??= this.run().finally(() => {
      this.running = null
    })
    return this.running
  }

  private async run(): Promise<void> {
    if (this.enabled) {
      const now = this.now()
      this.codex = await readCodexUsage(this.opts.codexDir)
      if (this.enabled) await this.refreshClaude(now)
    }
    const snap = this.snapshot()
    const key = JSON.stringify(snap)
    if (key !== this.last) {
      this.last = key
      this.emit('change', snap)
    }
  }

  private async refreshClaude(now: number): Promise<void> {
    if (this.fromApi && now >= this.nextApiAt) {
      const cred = readClaudeCredentials(this.opts.claudeDir, now)
      if (cred.token === null) {
        this.note = cred.error
        this.nextApiAt = now + (cred.error ? 60_000 : API_MIN_INTERVAL_MS)
      } else {
        const res = await fetchClaudeUsage(cred.token, this.fetchFn, now)
        if ('usage' in res) {
          this.lastApi = res.usage
          this.note = null
          this.nextApiAt = now + API_MIN_INTERVAL_MS
        } else {
          this.note = res.error
          this.nextApiAt = now + (res.retryAfterMs ?? API_MIN_INTERVAL_MS)
        }
      }
    }
    let cache: AgentUsage | null = null
    try {
      const file = path.join(this.opts.claudeDir, STATUS_CACHE_FILE)
      if (existsSync(file)) cache = parseStatusCache(JSON.parse(readFileSync(file, 'utf8')))
    } catch {}
    const candidates = [this.fromApi ? this.lastApi : null, cache].filter((u): u is AgentUsage => !!u)
    this.claude = candidates.sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null
  }
}
