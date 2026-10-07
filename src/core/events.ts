// Reads the app's own hook event log (<dataDir>/events.jsonl), written by the hook script.

import { existsSync } from 'node:fs'
import { readFile, rename, stat, writeFile } from 'node:fs/promises'
import { JsonlTail } from './jsonl-tail.ts'

export interface HookEvent {
  sessionId: string
  event: string
  time: number
  message?: string
  notificationType?: string
}

export interface HookState {
  /** Latest Notification that asks for the user (permission, question, dialog). */
  waitingAt: number | null
  waitingMessage: string | null
  /** Latest Notification that only says Claude is idle and waiting for input. */
  idleNotifiedAt: number | null
  stopAt: number | null
  promptAt: number | null
  startAt: number | null
  endAt: number | null
}

export function emptyHookState(): HookState {
  return { waitingAt: null, waitingMessage: null, idleNotifiedAt: null, stopAt: null, promptAt: null, startAt: null, endAt: null }
}

/** The idle reminder ("Claude is waiting for your input") is not a request for a decision. */
export function isIdleNotification(e: Pick<HookEvent, 'message' | 'notificationType'>): boolean {
  if (e.notificationType) return e.notificationType === 'idle_prompt'
  return /waiting for your input/i.test(e.message ?? '')
}

export function applyEvent(states: Map<string, HookState>, e: HookEvent): void {
  if (typeof e?.sessionId !== 'string' || typeof e.time !== 'number') return
  let s = states.get(e.sessionId)
  if (!s) states.set(e.sessionId, (s = emptyHookState()))
  switch (e.event) {
    case 'Notification':
      if (isIdleNotification(e)) s.idleNotifiedAt = e.time
      else {
        s.waitingAt = e.time
        s.waitingMessage = e.message ?? null
      }
      break
    case 'Stop':
      s.stopAt = e.time
      break
    case 'UserPromptSubmit':
      s.promptAt = e.time
      break
    case 'SessionStart':
      s.startAt = e.time
      break
    case 'SessionEnd':
      s.endAt = e.time
      break
  }
}

export class EventsReader {
  readonly states = new Map<string, HookState>()
  private tail: JsonlTail

  readonly filePath: string

  constructor(filePath: string) {
    this.filePath = filePath
    this.tail = new JsonlTail(filePath)
  }

  /** Returns the ids of sessions that received new events. */
  async update(): Promise<Set<string>> {
    const changed = new Set<string>()
    if (!existsSync(this.filePath)) return changed
    const onLine = (e: HookEvent) => {
      applyEvent(this.states, e)
      if (typeof e?.sessionId === 'string') changed.add(e.sessionId)
    }
    let res = await this.tail.read(onLine)
    if (res === -1) {
      this.states.clear()
      res = await this.tail.read(onLine)
    }
    return changed
  }
}

/**
 * Keeps the event log small: if it is over maxBytes, rewrites it with only the events
 * from the last keepDays. Call before the first read.
 */
export async function compactEvents(filePath: string, maxBytes = 5_000_000, keepDays = 14, now = Date.now()): Promise<void> {
  try {
    if ((await stat(filePath)).size <= maxBytes) return
    const cutoff = now - keepDays * 864e5
    const kept = (await readFile(filePath, 'utf8')).split('\n').filter((l) => {
      try {
        return JSON.parse(l).time >= cutoff
      } catch {
        return false
      }
    })
    const tmp = filePath + '.tmp'
    await writeFile(tmp, kept.length ? kept.join('\n') + '\n' : '')
    await rename(tmp, filePath)
  } catch {
    // Compaction is best effort.
  }
}
