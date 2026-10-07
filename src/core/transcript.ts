// Parses Claude Code transcripts (~/.claude/projects/<encoded-dir>/<sessionId>.jsonl).
// The format is internal and undocumented: every field is optional, unknown line types are ignored.

import { stat } from 'node:fs/promises'
import { JsonlTail } from './jsonl-tail.ts'

/** Longest prompt, reply or pasted text kept for search. */
export const MAX_TEXT_CHARS = 20_000
/** Longest prompt or reply shown in the details. */
export const MAX_SHOWN_CHARS = 4000

export interface TranscriptState {
  sessionId: string
  filePath: string
  firstTs: number | null
  lastTs: number | null
  /** Last user/assistant line in the main conversation (not subagents). */
  lastConvoTs: number | null
  lastConvoRole: 'user' | 'assistant' | null
  lastHumanPromptTs: number | null
  /** First environment snapshot's working directory, overridden by a later relocation. */
  homeDir: string | null
  firstCwd: string | null
  isWorktree: boolean | null
  worktreeName: string | null
  branches: string[]
  aiTitle: string | null
  customTitle: string | null
  lastPromptLine: string | null
  entrypoint: string | null
  version: string | null
  prompts: string[]
  /** The rest of the conversation for search: replies and pasted text, oldest first. */
  texts: string[]
  lastReply: string
  lastReplyTs: number | null
  /** tool_use ids without a tool_result yet, mapped to the tool name. */
  pendingTools: Map<string, string>
  /** Timestamps of all activity, ascending, at most one per second. Basis for time tracking. */
  activity: number[]
  badLines: number
}

export function emptyTranscript(sessionId: string, filePath: string): TranscriptState {
  return {
    sessionId,
    filePath,
    firstTs: null,
    lastTs: null,
    lastConvoTs: null,
    lastConvoRole: null,
    lastHumanPromptTs: null,
    homeDir: null,
    firstCwd: null,
    isWorktree: null,
    worktreeName: null,
    branches: [],
    aiTitle: null,
    customTitle: null,
    lastPromptLine: null,
    entrypoint: null,
    version: null,
    prompts: [],
    texts: [],
    lastReply: '',
    lastReplyTs: null,
    pendingTools: new Map(),
    activity: [],
    badLines: 0
  }
}

const STRIP_BLOCKS = [
  'ide_opened_file',
  'ide_selection',
  'system-reminder',
  'local-command-caveat',
  'local-command-stdout',
  'local-command-stderr',
  'command-message',
  'pasted_content'
]
const STRIP_RE = new RegExp(`<(${STRIP_BLOCKS.join('|')})\\b[^>]*>[\\s\\S]*?</\\1>`, 'g')
const PASTED_RE = /<pasted_content\b[^>]*>([\s\S]*?)<\/pasted_content>/g

/** The text blocks of a message, joined. */
function messageText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
}

/** Turns raw user message content into the text the human actually typed, or '' if there is none. */
export function cleanPrompt(content: unknown): string {
  let text = messageText(content)
  const cmd = /<command-name>\s*([^<]*?)\s*<\/command-name>/.exec(text)
  if (cmd) {
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1]?.trim()
    const name = cmd[1].startsWith('/') ? cmd[1] : `/${cmd[1]}`
    return args ? `${name} ${args}` : name
  }
  text = text.replace(STRIP_RE, '').trim()
  if (/^\[Request interrupted by user/.test(text)) return ''
  return text
}

function ts(v: unknown): number | null {
  if (typeof v !== 'string') return null
  const t = Date.parse(v)
  return Number.isNaN(t) ? null : t
}

export function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s
}

export function applyLine(s: TranscriptState, o: any): void {
  const t = ts(o.timestamp)
  if (t !== null) {
    if (s.firstTs === null || t < s.firstTs) s.firstTs = t
    if (s.lastTs === null || t > s.lastTs) s.lastTs = t
    const prev = s.activity[s.activity.length - 1]
    if (prev === undefined || t >= prev + 1000) s.activity.push(t)
  }
  if (typeof o.gitBranch === 'string' && o.gitBranch && s.branches[s.branches.length - 1] !== o.gitBranch) {
    s.branches.push(o.gitBranch)
  }
  if (typeof o.cwd === 'string' && !s.firstCwd) s.firstCwd = o.cwd
  if (typeof o.entrypoint === 'string') s.entrypoint = o.entrypoint
  if (typeof o.version === 'string') s.version = o.version

  switch (o.type) {
    case 'ai-title':
      if (typeof o.aiTitle === 'string' && o.aiTitle.trim()) s.aiTitle = o.aiTitle.trim()
      return
    case 'custom-title':
      if (typeof o.customTitle === 'string') s.customTitle = o.customTitle.trim() || null
      return
    case 'last-prompt':
      if (typeof o.lastPrompt === 'string') s.lastPromptLine = o.lastPrompt
      return
    case 'relocated':
      if (typeof o.relocatedCwd === 'string') s.homeDir = o.relocatedCwd
      return
    case 'worktree-state': {
      const name = o.worktreeSession?.worktreeName
      if (typeof name === 'string') s.worktreeName = name
      return
    }
    case 'attachment': {
      const a = o.attachment
      if (a?.type === 'environment' && a.snapshot) {
        if (!s.homeDir && typeof a.snapshot.workingDirectory === 'string') s.homeDir = a.snapshot.workingDirectory
        if (s.isWorktree === null && typeof a.snapshot.isWorktree === 'boolean') s.isWorktree = a.snapshot.isWorktree
      }
      return
    }
    case 'user':
      if (!o.isSidechain) applyUser(s, o, t)
      return
    case 'assistant':
      if (!o.isSidechain) applyAssistant(s, o, t)
      return
  }
}

function applyUser(s: TranscriptState, o: any, t: number | null): void {
  const content = o.message?.content
  if (Array.isArray(content) && content.some((b) => b?.type === 'tool_result')) {
    for (const b of content) if (b?.type === 'tool_result') s.pendingTools.delete(b.tool_use_id)
    markConvo(s, 'user', t)
    return
  }
  if (o.isMeta || o.isCompactSummary || o.isVisibleInTranscriptOnly) return
  const kind = o.origin?.kind
  if (kind !== undefined && kind !== 'human') return
  let pasted = false
  for (const m of messageText(content).matchAll(PASTED_RE)) {
    const p = m[1].trim()
    if (p) {
      s.texts.push(clip(p, MAX_TEXT_CHARS))
      pasted = true
    }
  }
  const text = cleanPrompt(content)
  // A message with only pasted text is still a human turn.
  if (!text && !pasted) return
  if (text) s.prompts.push(clip(text, MAX_TEXT_CHARS))
  s.pendingTools.clear()
  if (t !== null) s.lastHumanPromptTs = t
  markConvo(s, 'user', t)
}

function applyAssistant(s: TranscriptState, o: any, t: number | null): void {
  const content = o.message?.content
  if (!Array.isArray(content)) return
  const text = content
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
    .trim()
  if (text) {
    const kept = clip(text, MAX_TEXT_CHARS)
    s.texts.push(kept)
    s.lastReply = clip(kept, MAX_SHOWN_CHARS)
    s.lastReplyTs = t
  }
  for (const b of content) {
    if (b?.type === 'tool_use' && typeof b.id === 'string') s.pendingTools.set(b.id, String(b.name ?? ''))
  }
  markConvo(s, 'assistant', t)
}

function markConvo(s: TranscriptState, role: 'user' | 'assistant', t: number | null): void {
  s.lastConvoRole = role
  if (t !== null && (s.lastConvoTs === null || t >= s.lastConvoTs)) s.lastConvoTs = t
}

/** Keeps a transcript's parsed state up to date as the file grows. */
export class TranscriptReader {
  readonly agent = 'claude' as const
  readonly tail: JsonlTail
  state: TranscriptState

  readonly sessionId: string
  readonly filePath: string

  constructor(sessionId: string, filePath: string) {
    this.sessionId = sessionId
    this.filePath = filePath
    this.tail = new JsonlTail(filePath)
    this.state = emptyTranscript(sessionId, filePath)
  }

  get mtimeMs(): number {
    return this.tail.mtimeMs
  }

  /** True if the reader can go on with these files; false if it must start over. */
  useFiles(files: string[]): boolean {
    return files.length === 1 && files[0] === this.filePath
  }

  async needsRead(): Promise<boolean> {
    const st = await stat(this.filePath).catch(() => null)
    return !!st && (st.size !== this.tail.size || st.mtimeMs !== this.tail.mtimeMs)
  }

  /** Reads new lines. Returns true if anything changed. */
  async update(): Promise<boolean> {
    let res = await this.tail.read((o) => applyLine(this.state, o))
    if (res === -1) {
      this.state = emptyTranscript(this.sessionId, this.filePath)
      res = await this.tail.read((o) => applyLine(this.state, o))
      if (res === -1) return true
    }
    this.state.badLines += res.bad
    return res.lines > 0
  }
}
