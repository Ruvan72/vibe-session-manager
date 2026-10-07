// Combines transcript, live status and hook events into one SessionView with a traffic light (spec 3.1.1).

import path from 'node:path'
import type { Agent, Interval, Light, LiveStatus, SessionView } from '../shared/types.ts'
import type { HookState } from './events.ts'
import type { LiveInfo } from './live.ts'
import type { RepoInfo } from './repo.ts'
import { clip, MAX_SHOWN_CHARS, type TranscriptState } from './transcript.ts'

export interface LightResult {
  light: Light
  guess: boolean
  reason: string
  waitingSince: number | null
}

const QUESTION_TOOLS = new Set(['AskUserQuestion'])

function max(...xs: (number | null | undefined)[]): number {
  let m = 0
  for (const x of xs) if (typeof x === 'number' && x > m) m = x
  return m
}

/**
 * Red: waiting for the user. Green: working. Yellow: finished a turn the user has not seen.
 * Grey: nothing to do. Earlier rules win.
 *
 * With hook events for the session the light is reliable; without them it is guessed from
 * the end of the transcript (guess = true).
 */
export function computeLight(
  t: TranscriptState,
  status: LiveStatus,
  hook: HookState | null,
  seenAt: number,
  statusAt: number | null = null
): LightResult {
  if (status === 'closed') return { light: 'grey', guess: false, reason: 'Closed', waitingSince: null }

  const answeredAt = max(t.lastHumanPromptTs, hook?.promptAt, seenAt)

  if (hook && (hook.startAt || hook.stopAt || hook.promptAt || hook.waitingAt || hook.idleNotifiedAt)) {
    // The request has been dealt with once the conversation moves on (e.g. the tool result after
    // a permission was granted), or once the process turns busy again after it. The tool result
    // only arrives when a long tool finishes, so the busy signal clears it sooner.
    const movedOn = (t.lastConvoTs ?? 0) > (hook.waitingAt ?? 0)
    const resumed = status === 'busy' && (statusAt ?? 0) > (hook.waitingAt ?? 0)
    if (hook.waitingAt && hook.waitingAt > answeredAt && !movedOn && !resumed) {
      return { light: 'red', guess: false, reason: hook.waitingMessage || 'Waiting for you', waitingSince: hook.waitingAt }
    }
    if (status === 'busy') return { light: 'green', guess: false, reason: 'Working', waitingSince: null }
    // The idle reminder follows a Stop by about a minute. It must not bring back a turn the user
    // has already seen, so it only counts when no Stop was recorded.
    const finishedAt = hook.stopAt ?? hook.idleNotifiedAt ?? 0
    if (finishedAt > answeredAt) return { light: 'yellow', guess: false, reason: 'Finished – not seen yet', waitingSince: finishedAt }
    return { light: 'grey', guess: false, reason: 'Idle', waitingSince: null }
  }

  if (status === 'busy') return { light: 'green', guess: false, reason: 'Working', waitingSince: null }
  if (t.pendingTools.size > 0 && max(t.lastConvoTs) > seenAt) {
    const asking = [...t.pendingTools.values()].some((n) => QUESTION_TOOLS.has(n))
    return { light: 'red', guess: true, reason: asking ? 'Asked you a question' : 'Waiting for permission?', waitingSince: t.lastConvoTs }
  }
  if (t.lastConvoRole === 'assistant' && t.lastReplyTs && t.lastReplyTs > answeredAt) {
    if (/\?\s*$/.test(t.lastReply)) return { light: 'red', guess: true, reason: 'Asked you a question?', waitingSince: t.lastReplyTs }
    return { light: 'yellow', guess: true, reason: 'Finished – not seen yet', waitingSince: t.lastReplyTs }
  }
  return { light: 'grey', guess: false, reason: 'Idle', waitingSince: null }
}

/**
 * A session the user marked as unread shows yellow until they write in it or mark it as seen.
 * Red and green still win: they say more about what the session needs right now.
 */
export function applyUnreadMark(l: LightResult, t: TranscriptState, hook: HookState | null, unreadAt: number | null): LightResult {
  if (!unreadAt || unreadAt <= max(t.lastHumanPromptTs, hook?.promptAt)) return l
  if (l.light === 'red' || l.light === 'green') return l
  return { light: 'yellow', guess: false, reason: 'Marked as unread', waitingSince: unreadAt }
}

const EDITORS: Record<string, string> = {
  'claude-vscode': 'VS Code',
  'claude-desktop': 'Claude Desktop',
  cli: 'Terminal',
  'sdk-cli': 'SDK',
  'sdk-ts': 'SDK',
  'sdk-py': 'SDK',
  // Codex "originator" values.
  codex_vscode: 'VS Code',
  codex_work_desktop: 'Codex app',
  'Codex Desktop': 'Codex app',
  codex_cli_rs: 'Terminal',
  codex_exec: 'Terminal'
}

export function editorName(entrypoint: string | null): string {
  if (!entrypoint) return 'Unknown'
  return EDITORS[entrypoint] ?? entrypoint
}

export function homeDirOf(t: TranscriptState, live: LiveInfo | null): string {
  return t.homeDir ?? t.firstCwd ?? live?.cwd ?? path.dirname(t.filePath)
}

export function titleOf(t: TranscriptState): string {
  const first = (s: string) => s.split('\n')[0].trim()
  return t.customTitle || t.aiTitle || (t.lastPromptLine && first(t.lastPromptLine)) || (t.prompts[0] && first(t.prompts[0])) || '(untitled session)'
}

export function buildView(
  t: TranscriptState,
  live: LiveInfo | null,
  hook: HookState | null,
  repo: RepoInfo,
  seenAt: number,
  intervals: Interval[] = [],
  unreadAt: number | null = null,
  agent: Agent = 'claude'
): SessionView {
  const status: LiveStatus = live ? live.status : 'closed'
  const l = applyUnreadMark(computeLight(t, status, hook, seenAt, live?.statusUpdatedAt ?? null), t, hook, unreadAt)
  // An idle process's status time says nothing about activity, a busy one's does.
  const lastActivity = max(t.lastTs, status === 'busy' ? live?.statusUpdatedAt : null, hook?.stopAt, hook?.waitingAt)
  return {
    id: t.sessionId,
    agent,
    title: titleOf(t),
    repo: repo.repoName,
    repoKey: repo.repoKey,
    worktree: t.worktreeName ?? repo.worktree,
    branch: t.branches[t.branches.length - 1] ?? null,
    branches: t.branches,
    homeDir: homeDirOf(t, live),
    firstActivity: t.firstTs ?? lastActivity,
    lastActivity,
    status,
    light: l.light,
    hidden: false,
    labels: [],
    lightGuess: l.guess,
    reason: l.reason,
    waitingSince: l.waitingSince,
    entrypoint: t.entrypoint ?? live?.entrypoint ?? null,
    editor: editorName(t.entrypoint ?? live?.entrypoint ?? null),
    lastPrompt: clip(t.prompts[t.prompts.length - 1] ?? t.lastPromptLine ?? '', MAX_SHOWN_CHARS),
    lastReply: t.lastReply,
    intervals,
    activeMs: intervals.reduce((sum, [a, b]) => sum + (b - a), 0),
    version: t.version
  }
}

const LIGHT_ORDER: Record<Light, number> = { red: 0, yellow: 1, green: 2, grey: 3 }

/** Sessions that need the user, most urgent first: red before yellow, longest waiting first. */
export function urgentQueue(sessions: SessionView[]): SessionView[] {
  return sessions
    .filter((s) => s.light === 'red' || s.light === 'yellow')
    .sort((a, b) => LIGHT_ORDER[a.light] - LIGHT_ORDER[b.light] || Number(a.lightGuess) - Number(b.lightGuess) || (a.waitingSince ?? 0) - (b.waitingSince ?? 0))
}
