import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { adoptLegacyDataDir } from '../../src/core/persist.ts'
import { tmpDir } from './helpers.ts'

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
