import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { jumpToSession, sessionUri, windowsCommandLine } from '../../src/core/launcher.ts'
import { pathKey, resolveRepo } from '../../src/core/repo.ts'
import { SearchIndex } from '../../src/core/search.ts'
import { DEFAULT_SETTINGS, type SessionView } from '../../src/shared/types.ts'
import { tmpDir } from './helpers.ts'

describe('resolveRepo', () => {
  it('recognises Claude Code worktrees by path, even if deleted', () => {
    const r = resolveRepo('C:\\dev\\acmeapp\\.claude\\worktrees\\contoso-notes')
    expect(r).toMatchObject({ repoName: 'acmeapp', worktree: 'contoso-notes' })
  })

  it('finds the repo root from a subfolder and follows linked worktrees', () => {
    const root = tmpDir()
    const main = path.join(root, 'myrepo')
    mkdirSync(path.join(main, '.git', 'worktrees', 'feat'), { recursive: true })
    mkdirSync(path.join(main, 'src', 'deep'), { recursive: true })
    expect(resolveRepo(path.join(main, 'src', 'deep'))).toMatchObject({ repoName: 'myrepo', worktree: null })

    const wt = path.join(root, 'myrepo-feat')
    mkdirSync(wt)
    writeFileSync(path.join(wt, '.git'), `gitdir: ${path.join(main, '.git', 'worktrees', 'feat')}\n`)
    expect(resolveRepo(wt)).toMatchObject({ repoName: 'myrepo', repoKey: pathKey(main), worktree: 'myrepo-feat' })
  })

  it('falls back to the folder name outside git', () => {
    const dir = path.join(tmpDir(), 'notes')
    mkdirSync(dir)
    expect(resolveRepo(dir).repoName).toBe('notes')
  })

  it('path keys ignore case and trailing slashes on Windows', () => {
    expect(pathKey('C:\\Dev\\Repo\\', 'win32')).toBe(pathKey('c:/dev/repo', 'win32'))
  })
})

describe('SearchIndex', () => {
  const idx = new SearchIndex()
  idx.set({ id: 'a', meta: ['Contoso API notes', 'acmeapp', 'fix/api/contoso-notes'], texts: ['Please add the notes field to the import'] })
  idx.set({ id: 'b', meta: ['Deploy hang', 'acmeapp', 'DEV'], texts: ['why does the DEV deploy hang on migrations?'] })

  it('matches all words in any order across fields, case-insensitively', () => {
    expect(idx.search('ACME contoso').map((h) => h.id)).toEqual(['a'])
    expect(idx.search('migrations deploy').map((h) => h.id)).toEqual(['b'])
    expect(idx.search('contoso migrations')).toEqual([])
  })

  it('returns a snippet only for conversation matches', () => {
    expect(idx.search('contoso')[0].snippet).toBeNull()
    expect(idx.search('notes field')[0].snippet).toContain('notes field')
  })

  it('finds words spread over prompts and replies, and keeps lowercased texts when more are added', () => {
    const i = new SearchIndex()
    i.set({ id: 'c', meta: ['t'], texts: ['Why is it slow?', 'The Index is MISSING on orders.'] })
    expect(i.search('slow missing').map((h) => h.id)).toEqual(['c'])
    expect(i.search('missing')[0].snippet).toBe('The Index is MISSING on orders.')
    expect(i.set({ id: 'c', meta: ['t'], texts: ['Why is it slow?', 'The Index is MISSING on orders.', 'Added it.'] })).toBe(true)
    expect(i.search('added index').map((h) => h.id)).toEqual(['c'])
  })
})

describe('jumpToSession', () => {
  const session = { id: 'abc-123', agent: 'claude', homeDir: 'c:\\dev\\repo', entrypoint: 'claude-vscode', editor: 'VS Code' } as SessionView
  const deps = () => ({ runEditor: vi.fn(async () => {}), openUri: vi.fn(async () => {}), copyText: vi.fn(), delay: vi.fn(async () => {}) })

  it('focuses the folder, then opens the session URI', async () => {
    const d = deps()
    expect(await jumpToSession(session, DEFAULT_SETTINGS, d)).toEqual({ ok: true })
    expect(d.runEditor).toHaveBeenCalledWith('code', 'c:\\dev\\repo')
    expect(d.openUri).toHaveBeenCalledWith('vscode://anthropic.claude-code/open?session=abc-123')
  })

  it('copies the session id when the URI fails', async () => {
    const d = deps()
    d.openUri.mockRejectedValue(new Error('no handler'))
    expect((await jumpToSession(session, DEFAULT_SETTINGS, d)).ok).toBe(false)
    expect(d.copyText).toHaveBeenCalledWith('abc-123')
  })

  it('copies a resume command for non-editor sessions', async () => {
    const d = deps()
    await jumpToSession({ ...session, entrypoint: 'cli', editor: 'Terminal' }, DEFAULT_SETTINGS, d)
    expect(d.runEditor).not.toHaveBeenCalled()
    expect(d.copyText).toHaveBeenCalledWith('claude --resume abc-123')
  })

  it('does not quote a bare command on Windows (quoted, code.cmd cannot find Code.exe)', () => {
    expect(windowsCommandLine('code', 'c:\\dev\\my repo')).toBe('code "c:\\dev\\my repo"')
    expect(windowsCommandLine('C:\\Program Files\\VS\\code.cmd', 'c:\\dev')).toBe('"C:\\Program Files\\VS\\code.cmd" "c:\\dev"')
  })

  it('builds Cursor URIs from the scheme setting', () => {
    expect(sessionUri('cursor', 'x y')).toBe('cursor://anthropic.claude-code/open?session=x%20y')
  })
})
