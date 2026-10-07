import { appendFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { applyLine, cleanPrompt, emptyTranscript, TranscriptReader } from '../../src/core/transcript.ts'
import { JsonlTail } from '../../src/core/jsonl-tail.ts'
import { L, jsonl, tmpDir } from './helpers.ts'

const parse = (...lines: object[]) => {
  const s = emptyTranscript('sess-1', 'x.jsonl')
  for (const l of lines) applyLine(s, l)
  return s
}

describe('cleanPrompt', () => {
  it('strips IDE context and system reminders', () => {
    const text = '<ide_opened_file>The user opened a.ts</ide_opened_file><system-reminder>x</system-reminder>Fix the bug'
    expect(cleanPrompt([{ type: 'text', text }])).toBe('Fix the bug')
  })
  it('renders slash commands', () => {
    expect(cleanPrompt('<command-message>review</command-message>\n<command-name>/review</command-name>\n<command-args>123</command-args>')).toBe('/review 123')
  })
  it('drops interrupts and empty content', () => {
    expect(cleanPrompt('[Request interrupted by user]')).toBe('')
    expect(cleanPrompt([{ type: 'image' }])).toBe('')
  })
})

describe('applyLine', () => {
  it('collects times, branch history, home dir and titles', () => {
    const s = parse(
      L.env('2026-10-01T10:00:00Z', 'c:\\dev\\repo'),
      L.prompt('2026-10-01T10:00:01Z', 'first'),
      L.reply('2026-10-01T10:00:05Z', 'done', { gitBranch: 'feature', cwd: 'c:\\dev\\repo\\sub' }),
      L.aiTitle('Old title'),
      L.aiTitle('New title'),
      L.lastPrompt('first')
    )
    expect(s.firstTs).toBe(Date.parse('2026-10-01T10:00:00Z'))
    expect(s.lastTs).toBe(Date.parse('2026-10-01T10:00:05Z'))
    expect(s.branches).toEqual(['main', 'feature'])
    expect(s.homeDir).toBe('c:\\dev\\repo')
    expect(s.aiTitle).toBe('New title')
    expect(s.prompts).toEqual(['first'])
    expect(s.lastReply).toBe('done')
    expect(s.lastConvoRole).toBe('assistant')
  })

  it('custom title and relocation win', () => {
    const s = parse(L.env('2026-10-01T10:00:00Z', 'c:\\dev\\repo'), L.aiTitle('AI'), L.customTitle('Mine'), L.relocated('c:\\dev\\repo\\.claude\\worktrees\\wt'), L.worktreeState('wt'))
    expect(s.customTitle).toBe('Mine')
    expect(s.homeDir).toBe('c:\\dev\\repo\\.claude\\worktrees\\wt')
    expect(s.worktreeName).toBe('wt')
  })

  it('ignores sidechain, meta and non-human prompts', () => {
    const s = parse(
      L.prompt('2026-10-01T10:00:00Z', 'sub', { isSidechain: true }),
      L.prompt('2026-10-01T10:00:01Z', 'meta', { isMeta: true }),
      L.prompt('2026-10-01T10:00:02Z', '<task-notification>x</task-notification>', { origin: { kind: 'task-notification' } }),
      L.prompt('2026-10-01T10:00:03Z', 'real')
    )
    expect(s.prompts).toEqual(['real'])
    expect(s.lastHumanPromptTs).toBe(Date.parse('2026-10-01T10:00:03Z'))
  })

  it('keeps replies and pasted text for search, but not subagent replies', () => {
    const s = parse(
      L.prompt('2026-10-01T10:00:00Z', 'look at this <pasted_content id="1">stack trace here</pasted_content>'),
      L.reply('2026-10-01T10:00:01Z', 'It is a null check.'),
      L.reply('2026-10-01T10:00:02Z', 'subagent text', { isSidechain: true }),
      L.prompt('2026-10-01T10:00:03Z', '<pasted_content>only pasted</pasted_content>')
    )
    expect(s.prompts).toEqual(['look at this'])
    expect(s.texts).toEqual(['stack trace here', 'It is a null check.', 'only pasted'])
    expect(s.lastReply).toBe('It is a null check.')
    // The pasted-only message is the latest human turn.
    expect(s.lastConvoRole).toBe('user')
    expect(s.lastHumanPromptTs).toBe(Date.parse('2026-10-01T10:00:03Z'))
  })

  it('tracks pending tool calls', () => {
    const s = parse(L.toolUse('2026-10-01T10:00:00Z', 't1'), L.toolUse('2026-10-01T10:00:00Z', 't2', 'AskUserQuestion'))
    expect([...s.pendingTools.values()]).toEqual(['Bash', 'AskUserQuestion'])
    applyLine(s, L.toolResult('2026-10-01T10:00:01Z', 't1'))
    expect([...s.pendingTools.keys()]).toEqual(['t2'])
    applyLine(s, L.prompt('2026-10-01T10:00:02Z', 'never mind'))
    expect(s.pendingTools.size).toBe(0)
  })

  it('tolerates unknown and malformed lines', () => {
    const s = parse({ type: 'something-new', foo: 1 }, { type: 'assistant' }, { type: 'user', message: null }, { timestamp: 'nope' })
    expect(s.firstTs).toBeNull()
    expect(s.prompts).toEqual([])
  })
})

describe('JsonlTail / TranscriptReader', () => {
  it('reads only new lines and handles a partial last line and multibyte text', async () => {
    const file = path.join(tmpDir(), 's.jsonl')
    const line = JSON.stringify(L.prompt('2026-10-01T10:00:00Z', 'æøå 🚀'))
    writeFileSync(file, line.slice(0, 40))
    const tail = new JsonlTail(file)
    const seen: any[] = []
    expect(await tail.read((o) => seen.push(o))).toEqual({ lines: 0, bad: 0 })
    appendFileSync(file, line.slice(40) + '\nnot json\n')
    expect(await tail.read((o) => seen.push(o))).toEqual({ lines: 1, bad: 1 })
    expect(seen[0].message.content[0].text).toBe('æøå 🚀')
    expect(await tail.read((o) => seen.push(o))).toEqual({ lines: 0, bad: 0 })
  })

  it('starts over when the file shrinks', async () => {
    const file = path.join(tmpDir(), 's.jsonl')
    writeFileSync(file, jsonl(L.prompt('2026-10-01T10:00:00Z', 'one'), L.prompt('2026-10-01T10:00:01Z', 'two')))
    const r = new TranscriptReader('sess-1', file)
    await r.update()
    expect(r.state.prompts).toEqual(['one', 'two'])
    writeFileSync(file, jsonl(L.prompt('2026-10-01T10:00:00Z', 'three')))
    expect(await r.update()).toBe(true)
    expect(r.state.prompts).toEqual(['three'])
  })
})
