import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { appendCustomTitle, cleanTitle } from '../../src/core/rename.ts'
import { SessionStore } from '../../src/core/store.ts'
import { L, jsonl, tmpDir } from './helpers.ts'

const lines = (file: string) =>
  readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))

describe('appendCustomTitle', () => {
  it('appends a custom-title line like Claude Code /rename', async () => {
    const file = path.join(tmpDir(), 's.jsonl')
    writeFileSync(file, jsonl(L.aiTitle('Old')))
    expect(await appendCustomTitle(file, 'sess-1', '  New\n name  ')).toBe(true)
    expect(lines(file).at(-1)).toEqual({ type: 'custom-title', customTitle: 'New name', sessionId: 'sess-1' })
  })

  it('starts a new line when the file ends mid-line', async () => {
    const file = path.join(tmpDir(), 's.jsonl')
    writeFileSync(file, JSON.stringify(L.aiTitle('Old')) + '\n{"type":"user"')
    await appendCustomTitle(file, 'sess-1', 'New')
    const text = readFileSync(file, 'utf8')
    expect(text.endsWith('\n{"type":"custom-title","customTitle":"New","sessionId":"sess-1"}\n')).toBe(true)
    expect(text).toContain('{"type":"user"\n')
  })

  it('writes nothing for an empty title', async () => {
    const file = path.join(tmpDir(), 's.jsonl')
    writeFileSync(file, jsonl(L.aiTitle('Old')))
    expect(await appendCustomTitle(file, 'sess-1', '   ')).toBe(false)
    expect(lines(file)).toHaveLength(1)
  })

  it('clips long titles', () => {
    expect(cleanTitle('x'.repeat(500))).toHaveLength(200)
  })
})

describe('SessionStore.rename', () => {
  let store: SessionStore | null = null
  afterEach(() => store?.stop())

  it('stores the title in the transcript and shows it right away', async () => {
    const root = tmpDir()
    const claudeDir = path.join(root, '.claude')
    const proj = path.join(claudeDir, 'projects', 'c--dev-repo')
    mkdirSync(proj, { recursive: true })
    const transcript = path.join(proj, 'sess-1.jsonl')
    const ts = new Date(Date.now() - 60_000).toISOString()
    writeFileSync(transcript, jsonl(L.env(ts), L.prompt(ts, 'build the thing'), L.aiTitle('Build the thing')))
    store = new SessionStore({ claudeDir, dataDir: path.join(root, 'data'), pollMs: 1e9 })
    await store.start()
    const before = store.get('sess-1')!

    expect(await store.rename('sess-1', 'My name')).toBe(true)
    expect(store.get('sess-1')).toMatchObject({ title: 'My name', lastActivity: before.lastActivity, light: before.light })
    expect(lines(transcript).at(-1)).toMatchObject({ type: 'custom-title', customTitle: 'My name' })
    expect(store.search('my name').map((h) => h.id)).toEqual(['sess-1'])

    await store.poll()
    expect(store.get('sess-1')?.title).toBe('My name')
    expect(await store.rename('nope', 'x')).toBe(false)
  })
})
