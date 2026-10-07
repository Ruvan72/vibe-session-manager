// Reads OpenAI Codex sessions ("threads") from ~/.codex, so they can be listed next to Claude Code's.
// Like Claude Code's transcripts the format is internal and undocumented (observed in Codex 0.153–0.155):
// every field is optional and unknown line types are ignored.
//
//   sessions/YYYY/MM/DD/rollout-<time>-<threadId>[_<segmentId>].jsonl   the conversation, one JSON line per event.
//                                                                        A long thread continues in further files.
//   session_index.jsonl                                                  {id, thread_name}: the title the Codex UI shows
//   thread-writer-locks/<threadId>.lock                                  present while a Codex process has the thread open

import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import type { HookState } from './events.ts'
import { JsonlTail } from './jsonl-tail.ts'
import type { LiveInfo } from './live.ts'
import { clip, emptyTranscript, MAX_SHOWN_CHARS, MAX_TEXT_CHARS, type TranscriptState } from './transcript.ts'

/** An open turn with no new lines for this long is treated as stuck (e.g. Codex was killed mid-turn). */
export const CODEX_STALE_TURN_MS = 30 * 60_000
/** Without a lock file, a thread still counts as open this long after its last line. */
const UNLOCKED_LIVE_MS = 2 * 60_000

export interface CodexExtra {
  /** Subagent and review threads; Codex hides them from its own list, and so do we. */
  hidden: boolean
  originator: string | null
  /** A turn has started and not yet completed or been aborted. */
  turnOpen: boolean
  /** When the turn last started, completed or was aborted. */
  turnChangedAt: number | null
  /** Last completed turn. Plays the role of Claude Code's Stop hook. */
  completedAt: number | null
  /** Last turn the user interrupted; they are looking at it, so it is not "unread". */
  abortedAt: number | null
  /** The current turn has written an agent message. */
  turnHasReply: boolean
}

export interface CodexState extends TranscriptState {
  codex: CodexExtra
}

export function emptyCodexState(threadId: string, filePath: string): CodexState {
  return {
    ...emptyTranscript(threadId, filePath),
    codex: { hidden: false, originator: null, turnOpen: false, turnChangedAt: null, completedAt: null, abortedAt: null, turnHasReply: false }
  }
}

const ROLLOUT_RE = /^rollout-[\dT:-]+-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:_[0-9a-f-]+)?\.jsonl$/i

/** The thread id in a rollout file name, or null if the name does not look like one. */
export function threadIdOf(fileName: string): string | null {
  return ROLLOUT_RE.exec(fileName)?.[1] ?? null
}

/** Windows long-path prefix that Codex sometimes writes into paths. */
export function stripLongPath(p: string): string {
  return p.startsWith('\\\\?\\') ? p.slice(4) : p
}

function ts(v: unknown): number | null {
  if (typeof v !== 'string') return null
  const t = Date.parse(v)
  return Number.isNaN(t) ? null : t
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((b) => b && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
}

/** The text the human typed. The VS Code extension puts open tabs etc. in front of it. */
export function cleanCodexPrompt(text: string): string {
  const req = /^## My request(?: for Codex)?:\s*$/m.exec(text)
  if (req) text = text.slice(req.index + req[0].length)
  else if (/^# Context from my IDE setup:/.test(text)) return ''
  return text.trim()
}

function markConvo(s: TranscriptState, role: 'user' | 'assistant', t: number | null): void {
  s.lastConvoRole = role
  if (t !== null && (s.lastConvoTs === null || t >= s.lastConvoTs)) s.lastConvoTs = t
}

function onPrompt(s: CodexState, text: string, t: number | null): void {
  const clean = cleanCodexPrompt(text)
  if (!clean) return
  s.prompts.push(clip(clean, MAX_TEXT_CHARS))
  if (t !== null) s.lastHumanPromptTs = t
  markConvo(s, 'user', t)
}

function onReply(s: CodexState, text: string, t: number | null): void {
  const trimmed = text.trim()
  if (!trimmed) return
  const kept = clip(trimmed, MAX_TEXT_CHARS)
  s.texts.push(kept)
  s.lastReply = clip(kept, MAX_SHOWN_CHARS)
  s.lastReplyTs = t
  s.codex.turnHasReply = true
  markConvo(s, 'assistant', t)
}

export function applyCodexLine(s: CodexState, o: any): void {
  const t = ts(o.timestamp)
  if (t !== null) {
    if (s.firstTs === null || t < s.firstTs) s.firstTs = t
    if (s.lastTs === null || t > s.lastTs) s.lastTs = t
    const prev = s.activity[s.activity.length - 1]
    if (prev === undefined || t >= prev + 1000) s.activity.push(t)
  }
  const p = o.payload
  if (!p || typeof p !== 'object') return

  switch (o.type) {
    case 'session_meta': {
      // A continuation file repeats the meta; the first one decides.
      if (s.codex.originator === null && typeof p.originator === 'string') s.codex.originator = p.originator
      if (s.entrypoint === null && typeof p.originator === 'string') s.entrypoint = p.originator
      if (typeof p.cli_version === 'string') s.version = p.cli_version
      if (!s.homeDir && typeof p.cwd === 'string') s.homeDir = stripLongPath(p.cwd)
      if (!s.firstCwd && typeof p.cwd === 'string') s.firstCwd = stripLongPath(p.cwd)
      const branch = p.git?.branch
      if (typeof branch === 'string' && branch && s.branches[s.branches.length - 1] !== branch) s.branches.push(branch)
      if (p.parent_thread_id || (p.source && typeof p.source === 'object' && p.source.subagent)) s.codex.hidden = true
      return
    }
    case 'event_msg':
      applyEvent(s, p, t)
      return
  }
}

function applyEvent(s: CodexState, p: any, t: number | null): void {
  switch (p.type) {
    case 'task_started':
      s.codex.turnOpen = true
      s.codex.turnChangedAt = t
      s.codex.turnHasReply = false
      return
    case 'task_complete':
      s.codex.turnOpen = false
      s.codex.turnChangedAt = t
      s.codex.completedAt = t
      // Normally the final AgentMessage came just before; this covers versions without item events.
      if (!s.codex.turnHasReply && typeof p.last_agent_message === 'string') onReply(s, p.last_agent_message, t)
      return
    case 'turn_aborted':
      s.codex.turnOpen = false
      s.codex.turnChangedAt = t
      s.codex.abortedAt = t
      return
    case 'item_completed': {
      const item = p.item
      if (item?.type === 'UserMessage') onPrompt(s, textOf(item.content), t)
      else if (item?.type === 'AgentMessage') onReply(s, textOf(item.content), t)
      return
    }
    // Older Codex versions.
    case 'user_message':
      if (typeof p.message === 'string') onPrompt(s, p.message, t)
      return
    case 'agent_message':
      if (typeof p.message === 'string') onReply(s, p.message, t)
      return
  }
}

/** Keeps one Codex thread's parsed state up to date as its rollout files grow. */
export class CodexReader {
  readonly agent = 'codex' as const
  readonly sessionId: string
  state: CodexState
  private files: string[] = []
  private tails: JsonlTail[] = []

  constructor(threadId: string, files: string[]) {
    this.sessionId = threadId
    this.state = emptyCodexState(threadId, files[0] ?? '')
    this.useFiles(files)
  }

  get filePath(): string {
    return this.files[0] ?? ''
  }

  get mtimeMs(): number {
    return Math.max(0, ...this.tails.map((t) => t.mtimeMs))
  }

  get hidden(): boolean {
    return this.state.codex.hidden
  }

  /** Accepts the thread's current file list if it only adds files. Returns false if the reader must start over. */
  useFiles(files: string[]): boolean {
    if (files.length < this.files.length || this.files.some((f, i) => f !== files[i])) return false
    for (const f of files.slice(this.files.length)) {
      this.files.push(f)
      this.tails.push(new JsonlTail(f))
    }
    return true
  }

  async needsRead(): Promise<boolean> {
    for (const tail of this.tails) {
      const st = await stat(tail.filePath).catch(() => null)
      if (st && (st.size !== tail.size || st.mtimeMs !== tail.mtimeMs)) return true
    }
    return false
  }

  /** Reads new lines from every file, oldest file first. Returns true if anything changed. */
  async update(): Promise<boolean> {
    let lines = 0
    for (const tail of this.tails) {
      const res = await tail.read((o) => applyCodexLine(this.state, o))
      if (res === -1) {
        // A file shrank: start over with all files.
        for (const t of this.tails) t.reset()
        this.state = emptyCodexState(this.sessionId, this.filePath)
        for (const t of this.tails) await t.read((o) => applyCodexLine(this.state, o))
        return true
      }
      this.state.badLines += res.bad
      lines += res.lines
    }
    return lines > 0
  }
}

/** Rollout files grouped by thread id, each group in file-name (= time) order. */
export async function listCodexRollouts(sessionsDir: string): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>()
  const walk = async (dir: string, depth: number): Promise<void> => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    await Promise.all(
      entries.map(async (e) => {
        const p = path.join(dir, e.name)
        if (e.isDirectory()) {
          if (depth < 3) await walk(p, depth + 1)
        } else if (e.isFile()) {
          const id = threadIdOf(e.name)
          if (id) out.set(id, [...(out.get(id) ?? []), p])
        }
      })
    )
  }
  await walk(sessionsDir, 0)
  for (const files of out.values()) files.sort((a, b) => path.basename(a).localeCompare(path.basename(b)))
  return out
}

/** Thread ids that a Codex process has open right now. */
export async function readCodexLocks(locksDir: string): Promise<Set<string>> {
  try {
    return new Set((await readdir(locksDir)).filter((f) => f.endsWith('.lock') && !f.startsWith('.')).map((f) => f.slice(0, -'.lock'.length)))
  } catch {
    return new Set()
  }
}

/** Thread titles from session_index.jsonl; a later line for the same thread wins (renames). */
export class CodexIndex {
  readonly names = new Map<string, string>()
  private tail: JsonlTail

  constructor(filePath: string) {
    this.tail = new JsonlTail(filePath)
  }

  /** Returns the ids whose title may have changed. */
  async update(): Promise<Set<string>> {
    const changed = new Set<string>()
    const onLine = (o: any) => {
      if (typeof o?.id !== 'string' || typeof o.thread_name !== 'string' || !o.thread_name.trim()) return
      if (this.names.get(o.id) !== o.thread_name.trim()) changed.add(o.id)
      this.names.set(o.id, o.thread_name.trim())
    }
    try {
      let res = await this.tail.read(onLine)
      if (res === -1) {
        for (const id of this.names.keys()) changed.add(id)
        this.names.clear()
        res = await this.tail.read(onLine)
      }
    } catch {
      // No index yet.
    }
    return changed
  }
}

/** Codex's equivalent of Claude Code's live-status file, or null when the thread is closed. */
export function codexLive(s: CodexState, locked: boolean, now = Date.now()): LiveInfo | null {
  const recent = s.lastTs !== null && now - s.lastTs < UNLOCKED_LIVE_MS
  if (!locked && !(s.codex.turnOpen && recent)) return null
  const busy = s.codex.turnOpen && s.lastTs !== null && now - s.lastTs < CODEX_STALE_TURN_MS
  return {
    pid: 0,
    sessionId: s.sessionId,
    status: busy ? 'busy' : 'idle',
    statusUpdatedAt: s.codex.turnChangedAt,
    cwd: s.homeDir,
    entrypoint: s.codex.originator,
    name: null
  }
}

/**
 * The rollout records turn starts and ends, so Codex sessions get the same reliable yellow as
 * Claude Code sessions with hooks. Codex does not record when it waits for an approval, so red is
 * never set from here.
 */
export function codexHookState(s: CodexState): HookState {
  const prompt = Math.max(s.lastHumanPromptTs ?? 0, s.codex.abortedAt ?? 0)
  return {
    waitingAt: null,
    waitingMessage: null,
    idleNotifiedAt: null,
    stopAt: s.codex.completedAt,
    promptAt: prompt || null,
    startAt: s.firstTs,
    endAt: null
  }
}
