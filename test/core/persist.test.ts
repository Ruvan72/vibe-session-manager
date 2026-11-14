import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { adoptLegacyDataDir, SeenStore } from '../../src/core/persist.ts'
import { tmpDir } from './helpers.ts'

describe('SeenStore pins', () => {
  it('pins and unpins a session', () => {
    const seen = new SeenStore(tmpDir(), 1000)
    seen.setPinned('a', true)
    expect(seen.isPinned('a')).toBe(true)
    expect(seen.isPinned('b')).toBe(false)
    seen.setPinned('a', false)
    expect(seen.isPinned('a')).toBe(false)
    seen.flush()
  })

  it('writes pins to state.json next to the other keys and reads them back', () => {
    const dir = tmpDir()
    const seen = new SeenStore(dir, 1000)
    seen.mark('s', 2000)
    seen.markUnread('u', 3000)
    seen.setHidden('h', true, 4000)
    seen.setPinned('a', true, 5000)
    seen.flush()
    const raw = JSON.parse(readFileSync(path.join(dir, 'state.json'), 'utf8'))
    expect(raw).toEqual({ initializedAt: 1000, seen: { s: 2000 }, unread: { u: 3000 }, hidden: { h: 4000 }, pinned: { a: 5000 } })
    const again = new SeenStore(dir, 9000)
    expect(again.isPinned('a')).toBe(true)
    expect(again.isHidden('h')).toBe(true)
    expect(again.get('s')).toBe(2000)
    expect(again.unreadAt('u')).toBe(3000)
  })

  it.each([
    ['without a pinned key', { initializedAt: 1000, seen: {}, unread: {}, hidden: {} }],
    ['with pinned as a string', { initializedAt: 1000, pinned: 'a' }],
    ['with pinned as null', { initializedAt: 1000, pinned: null }],
    ['with pinned as an array', { initializedAt: 1000, pinned: ['a'] }],
    ['with pinned as a number', { initializedAt: 1000, pinned: 5 }]
  ])('loads a state.json %s with nothing pinned', (_name, state) => {
    const dir = tmpDir()
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state))
    const seen = new SeenStore(dir, 9000)
    for (const id of ['a', '0', 'length', 'constructor', 'toString']) expect(seen.isPinned(id)).toBe(false)
  })
})

describe('adoptLegacyDataDir', () => {
  it('copies the old data dir once and leaves the old one in place', () => {
    const dir = tmpDir()
    const legacy = path.join(dir, '.ai-dev-session-manager')
    const data = path.join(dir, '.vibe-session-manager')
    mkdirSync(path.join(legacy, 'time'), { recursive: true })
    writeFileSync(path.join(legacy, 'config.json'), '{"idleGapMinutes":30}')
    writeFileSync(path.join(legacy, 'time', '2026-10-01.json'), '{}')
    expect(adoptLegacyDataDir(legacy, data)).toBe(true)
    expect(readFileSync(path.join(data, 'config.json'), 'utf8')).toBe('{"idleGapMinutes":30}')
    expect(existsSync(path.join(data, 'time', '2026-10-01.json'))).toBe(true)
    expect(existsSync(legacy)).toBe(true)
    writeFileSync(path.join(legacy, 'config.json'), '{}')
    expect(adoptLegacyDataDir(legacy, data)).toBe(false)
    expect(readFileSync(path.join(data, 'config.json'), 'utf8')).toBe('{"idleGapMinutes":30}')
  })

  it('does nothing without an old data dir', () => {
    const dir = tmpDir()
    expect(adoptLegacyDataDir(path.join(dir, 'old'), path.join(dir, 'new'))).toBe(false)
    expect(existsSync(path.join(dir, 'new'))).toBe(false)
  })
})
