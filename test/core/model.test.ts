import { describe, expect, it } from 'vitest'
import { emptyHookState, type HookState } from '../../src/core/events.ts'
import { applyUnreadMark, computeLight, titleOf, urgentQueue } from '../../src/core/model.ts'
import { applyLine, emptyTranscript } from '../../src/core/transcript.ts'
import type { SessionView } from '../../src/shared/types.ts'
import { L } from './helpers.ts'

const T = (...lines: object[]) => {
  const s = emptyTranscript('sess-1', 'x.jsonl')
  for (const l of lines) applyLine(s, l)
  return s
}
const at = (iso: string) => Date.parse(iso)
const hook = (h: Partial<HookState>): HookState => ({ ...emptyHookState(), startAt: 1, ...h })

describe('computeLight with hook events', () => {
  const t = T(L.prompt('2026-10-01T10:00:00Z', 'go'), L.toolUse('2026-10-01T10:00:05Z', 't1'))

  it('closed sessions are grey', () => {
    expect(computeLight(t, 'closed', hook({ waitingAt: at('2026-10-01T10:00:06Z') }), 0).light).toBe('grey')
  })

  it('a permission notification is red, and beats busy', () => {
    const r = computeLight(t, 'busy', hook({ waitingAt: at('2026-10-01T10:00:06Z'), waitingMessage: 'Claude needs your permission to use Bash' }), 0)
    expect(r).toMatchObject({ light: 'red', guess: false, reason: 'Claude needs your permission to use Bash' })
  })

  it('red clears once the transcript moves on after the notification', () => {
    const moved = T(L.prompt('2026-10-01T10:00:00Z', 'go'), L.toolUse('2026-10-01T10:00:05Z', 't1'), L.toolResult('2026-10-01T10:00:20Z', 't1'))
    expect(computeLight(moved, 'busy', hook({ waitingAt: at('2026-10-01T10:00:06Z') }), 0).light).toBe('green')
  })

  it('red clears when the process turns busy again after the notification (long tool approved)', () => {
    const h = hook({ waitingAt: at('2026-10-01T10:00:06Z') })
    expect(computeLight(t, 'busy', h, 0, at('2026-10-01T10:00:10Z')).light).toBe('green')
    expect(computeLight(t, 'busy', h, 0, at('2026-10-01T10:00:01Z')).light).toBe('red')
  })

  it('the idle reminder after a seen Stop does not bring yellow back', () => {
    const h = hook({ promptAt: at('2026-10-01T10:00:00Z'), stopAt: at('2026-10-01T10:00:30Z'), idleNotifiedAt: at('2026-10-01T10:01:30Z') })
    expect(computeLight(t, 'idle', h, at('2026-10-01T10:00:40Z')).light).toBe('grey')
  })

  it('red clears when marked as seen', () => {
    expect(computeLight(t, 'idle', hook({ waitingAt: at('2026-10-01T10:00:06Z') }), at('2026-10-01T10:01:00Z')).light).toBe('grey')
  })

  it('Stop after the last prompt is yellow until seen or answered', () => {
    const h = hook({ promptAt: at('2026-10-01T10:00:00Z'), stopAt: at('2026-10-01T10:00:30Z') })
    expect(computeLight(t, 'idle', h, 0)).toMatchObject({ light: 'yellow', waitingSince: at('2026-10-01T10:00:30Z') })
    expect(computeLight(t, 'idle', h, at('2026-10-01T10:00:40Z')).light).toBe('grey')
    expect(computeLight(t, 'idle', { ...h, promptAt: at('2026-10-01T10:00:50Z') }, 0).light).toBe('grey')
  })

  it('the idle reminder is yellow, not red', () => {
    expect(computeLight(t, 'idle', hook({ idleNotifiedAt: at('2026-10-01T10:02:00Z') }), 0).light).toBe('yellow')
  })
})

describe('computeLight guessed from the transcript', () => {
  it('busy is green', () => {
    expect(computeLight(T(L.prompt('2026-10-01T10:00:00Z', 'go')), 'busy', null, 0).light).toBe('green')
  })
  it('an unanswered tool call while idle is a guessed red', () => {
    const r = computeLight(T(L.prompt('2026-10-01T10:00:00Z', 'go'), L.toolUse('2026-10-01T10:00:05Z', 't1')), 'idle', null, 0)
    expect(r).toMatchObject({ light: 'red', guess: true, reason: 'Waiting for permission?' })
  })
  it('AskUserQuestion is a question', () => {
    const r = computeLight(T(L.toolUse('2026-10-01T10:00:05Z', 't1', 'AskUserQuestion')), 'idle', null, 0)
    expect(r.reason).toBe('Asked you a question')
  })
  it('a reply ending in ? is a guessed red, other replies yellow', () => {
    expect(computeLight(T(L.prompt('2026-10-01T10:00:00Z', 'go'), L.reply('2026-10-01T10:00:05Z', 'Should I?')), 'idle', null, 0).light).toBe('red')
    expect(computeLight(T(L.prompt('2026-10-01T10:00:00Z', 'go'), L.reply('2026-10-01T10:00:05Z', 'Done.')), 'idle', null, 0)).toMatchObject({
      light: 'yellow',
      guess: true
    })
  })
  it('replies older than "seen" are grey', () => {
    expect(computeLight(T(L.reply('2026-10-01T10:00:05Z', 'Done.')), 'idle', null, at('2026-10-01T11:00:00Z')).light).toBe('grey')
  })
})

describe('applyUnreadMark', () => {
  const t = T(L.prompt('2026-10-01T10:00:00Z', 'go'), L.reply('2026-10-01T10:00:05Z', 'Done.'))
  const grey = computeLight(t, 'closed', null, 0)
  const marked = at('2026-10-01T11:00:00Z')

  it('turns grey sessions yellow, also closed ones', () => {
    expect(applyUnreadMark(grey, t, null, marked)).toMatchObject({ light: 'yellow', reason: 'Marked as unread', waitingSince: marked })
  })

  it('does not override red or green', () => {
    const busy = computeLight(t, 'busy', null, 0)
    expect(applyUnreadMark(busy, t, null, marked).light).toBe('green')
  })

  it('ends when the user writes in the session after marking', () => {
    const later = T(L.prompt('2026-10-01T10:00:00Z', 'go'), L.prompt('2026-10-01T12:00:00Z', 'ok, now'))
    expect(applyUnreadMark(grey, later, null, marked).light).toBe('grey')
    expect(applyUnreadMark(grey, t, null, null).light).toBe('grey')
  })
})

describe('titleOf', () => {
  it('prefers custom title, then AI title, then last prompt', () => {
    expect(titleOf(T(L.aiTitle('AI'), L.customTitle('Mine')))).toBe('Mine')
    expect(titleOf(T(L.aiTitle('AI'), L.lastPrompt('prompt')))).toBe('AI')
    expect(titleOf(T(L.lastPrompt('line one\nline two')))).toBe('line one')
    expect(titleOf(T())).toBe('(untitled session)')
  })
})

describe('urgentQueue', () => {
  const v = (id: string, light: SessionView['light'], waitingSince: number, lightGuess = false) => ({ id, light, waitingSince, lightGuess }) as SessionView
  it('orders red before yellow, sure before guessed, longest waiting first', () => {
    const q = urgentQueue([v('y', 'yellow', 1), v('r2', 'red', 5), v('g', 'green', 0), v('r1', 'red', 3), v('rq', 'red', 1, true)])
    expect(q.map((s) => s.id)).toEqual(['r1', 'r2', 'rq', 'y'])
  })
})
