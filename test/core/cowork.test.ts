import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { coworkRepo, defaultCoworkDirs, findCoworkDir, listCoworkSessions, parseCoworkMeta } from '../../src/core/cowork.ts'
import { jumpToSession, opensInEditor, resumeCommand } from '../../src/core/launcher.ts'
import { editorName } from '../../src/core/model.ts'
import { SessionStore } from '../../src/core/store.ts'
import { DEFAULT_SETTINGS, type SessionView } from '../../src/shared/types.ts'
import { L, jsonl, tmpDir } from './helpers.ts'

const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString()
const ACCOUNT = '729035b2-6bb3-4928-8542-00bbb632fdd6'
const ORG = '4b73811f-e321-42d7-9913-a6b7219dfd4f'

/** A Cowork session folder as Claude Desktop writes it: local_<id>.json next to local_<id>/.claude/projects/<slug>/<cli>.jsonl. */
function coworkSession(root: string, localId: string, cliId: string, meta: object, lines: object[], opts: { live?: object; vm?: boolean } = {}) {
  const org = path.join(root, ACCOUNT, ORG)
  const dir = path.join(org, `local_${localId}`)
  const outputs = path.join(dir, 'outputs')
  const slug = opts.vm ? '-sessions-sweet-serene-lovelace' : 'C--Users-me-AppData-Roaming-Claude-local-agent-mode-sessions-outputs'
  const proj = path.join(dir, '.claude', 'projects', slug)
  mkdirSync(proj, { recursive: true })
  mkdirSync(path.join(proj, cliId, 'subagents'), { recursive: true })
  mkdirSync(outputs, { recursive: true })
  const cwd = opts.vm ? '/sessions/sweet-serene-lovelace' : outputs
  const transcript = path.join(proj, `${cliId}.jsonl`)
  writeFileSync(transcript, jsonl(...lines.map((l: any) => ({ ...l, cwd, entrypoint: 'local-agent', gitBranch: 'HEAD', sessionId: cliId }))))
  writeFileSync(path.join(proj, cliId, 'subagents', 'agent-1.jsonl'), jsonl(L.prompt(iso(1000), 'sub')))
  writeFileSync(`${dir}.json`, JSON.stringify({ sessionId: `local_${localId}`, cliSessionId: cliId, cwd, userSelectedFolders: [], createdAt: 1, lastActivityAt: 2, isArchived: false, hostLoopMode: !opts.vm, title: 'Untitled', ...meta }))
  if (opts.live) {
    mkdirSync(path.join(dir, '.claude', 'sessions'), { recursive: true })
    writeFileSync(path.join(dir, '.claude', 'sessions', '4242.json'), JSON.stringify({ pid: 4242, sessionId: cliId, cwd, entrypoint: 'local-agent', ...opts.live }))
  }
  return { dir, transcript, metaFile: `${dir}.json` }
}

let store: SessionStore | null = null
afterEach(() => store?.stop())

describe('Cowork folders', () => {
  it('knows where Claude Desktop keeps them, Store build first', () => {
    const local = tmpDir()
    mkdirSync(path.join(local, 'Packages', 'Claude_pzs8sxrjxfjjc'), { recursive: true })
    mkdirSync(path.join(local, 'Packages', 'Other_abc'), { recursive: true })
    const dirs = defaultCoworkDirs({ LOCALAPPDATA: local, APPDATA: 'C:\\roaming' }, 'win32')
    expect(dirs).toEqual([
      path.join(local, 'Packages', 'Claude_pzs8sxrjxfjjc', 'LocalCache', 'Roaming', 'Claude', 'local-agent-mode-sessions'),
      path.join('C:\\roaming', 'Claude', 'local-agent-mode-sessions')
    ])
    expect(defaultCoworkDirs({ HOME: '/Users/me' }, 'darwin')).toEqual(['/Users/me/Library/Application Support/Claude/local-agent-mode-sessions'])
    expect(findCoworkDir(dirs)).toBeNull()
    mkdirSync(dirs[0], { recursive: true })
    expect(findCoworkDir(dirs)).toBe(dirs[0])
  })

  it('lists one source per transcript, ignoring subagents and unrelated folders', async () => {
    const root = tmpDir()
    const a = coworkSession(root, 'aaa', 'cli-a', {}, [L.prompt(iso(5000), 'hello')])
    mkdirSync(path.join(root, 'skills-plugin', ORG, ACCOUNT, 'skills', 'x'), { recursive: true })
    writeFileSync(path.join(root, 'skills-plugin', ORG, ACCOUNT, 'skills', 'x', 'notes.jsonl'), '{}\n')
    const sources = await listCoworkSessions(root)
    expect(sources).toEqual([{ sessionId: 'cli-a', filePath: a.transcript, sessionDir: a.dir, metaFile: a.metaFile }])
    expect(await listCoworkSessions(path.join(root, 'missing'))).toEqual([])
  })

  it('reads the metadata the app keeps beside the session', () => {
    expect(parseCoworkMeta('{"title":" Outlook automation ","userSelectedFolders":["C:\\\\temp\\\\ms"],"isArchived":true,"hostLoopMode":false,"lastActivityAt":5}')).toEqual({
      title: 'Outlook automation',
      folders: ['C:\\temp\\ms'],
      archived: true,
      hostLoop: false,
      lastActivityAt: 5
    })
    expect(parseCoworkMeta('{}')).toEqual({ title: null, folders: [], archived: false, hostLoop: true, lastActivityAt: null })
    expect(parseCoworkMeta('nope')).toBeNull()
  })

  it('groups folder-less sessions under one "Cowork" repo', () => {
    const r1 = coworkRepo(path.join('C:\\x', ACCOUNT, ORG, 'local_1'))
    const r2 = coworkRepo(path.join('C:\\x', ACCOUNT, ORG, 'local_2'))
    expect(r1.repoName).toBe('Cowork')
    expect(r1.repoKey).toBe(r2.repoKey)
    expect(r1.repoPath).toBe(path.join('C:\\x', ACCOUNT, ORG, 'local_1', 'outputs'))
  })
})

describe('Cowork sessions in the store', () => {
  it('lists them with the app title, the chosen folder and no branch, and leaves archived ones out', async () => {
    const root = tmpDir()
    const home = tmpDir()
    const folder = path.join(home, 'Projects', 'GDPR')
    mkdirSync(folder, { recursive: true })
    coworkSession(root, 'aaa', 'cli-a', { title: 'Privacy policy review', userSelectedFolders: [folder] }, [L.prompt(iso(60_000), 'review the policy'), L.aiTitle('Policy'), L.reply(iso(50_000), 'Done.')])
    coworkSession(root, 'bbb', 'cli-b', { title: 'Linux cheat sheet' }, [L.prompt(iso(40_000), 'make a cheat sheet'), L.reply(iso(30_000), 'Here.')])
    coworkSession(root, 'ccc', 'cli-c', { title: 'Old one', isArchived: true }, [L.prompt(iso(20_000), 'x'), L.reply(iso(10_000), 'y')])
    coworkSession(root, 'ddd', 'cli-d', { title: 'In the VM' }, [L.prompt(iso(9000), 'vm?')], { vm: true, live: { pid: 4242 } })

    store = new SessionStore({ claudeDir: path.join(home, '.claude'), coworkDir: root, dataDir: path.join(home, 'data'), pollMs: 1e9, isAlive: () => true })
    await store.start()
    const ids = store.snapshot().sessions.map((s) => s.id)
    expect(ids.sort()).toEqual(['cli-a', 'cli-b', 'cli-d'])

    const a = store.get('cli-a')!
    expect(a).toMatchObject({ agent: 'cowork', title: 'Privacy policy review', repo: 'GDPR', homeDir: folder, branch: null, branches: [], editor: 'Claude app', status: 'closed', light: 'grey' })
    const b = store.get('cli-b')!
    expect(b).toMatchObject({ agent: 'cowork', title: 'Linux cheat sheet', repo: 'Cowork', homeDir: path.join(root, ACCOUNT, ORG, 'local_bbb', 'outputs') })
    expect(a.repoKey).not.toBe(b.repoKey)
    // The VM's pid 4242 means nothing on the host, so its status file is ignored.
    expect(store.get('cli-d')).toMatchObject({ status: 'closed', editor: 'Claude app' })

    expect(store.search('cowork').map((h) => h.id).sort()).toEqual(['cli-a', 'cli-b', 'cli-d'])
    expect(store.search('cheat sheet').map((h) => h.id)).toEqual(['cli-b'])
    expect(await store.rename('cli-a', 'Nope')).toBe(false)
  })

  it('follows the app title and live status', async () => {
    const root = tmpDir()
    const home = tmpDir()
    const s = coworkSession(root, 'aaa', 'cli-a', { title: 'First title' }, [L.prompt(iso(60_000), 'go'), L.reply(iso(50_000), 'Ok.')], { live: { status: 'busy', statusUpdatedAt: Date.now() } })
    store = new SessionStore({ claudeDir: path.join(home, '.claude'), coworkDir: root, dataDir: path.join(home, 'data'), pollMs: 1e9, isAlive: (pid) => pid === 4242 })
    await store.start()
    expect(store.get('cli-a')).toMatchObject({ title: 'First title', status: 'busy', light: 'green' })

    writeFileSync(s.metaFile, JSON.stringify({ title: 'Renamed in the app', hostLoopMode: true }))
    writeFileSync(path.join(s.dir, '.claude', 'sessions', '4242.json'), JSON.stringify({ pid: 4242, sessionId: 'cli-a', status: 'idle', statusUpdatedAt: Date.now() }))
    await store.poll()
    expect(store.get('cli-a')).toMatchObject({ title: 'Renamed in the app', status: 'idle' })

    writeFileSync(s.metaFile, JSON.stringify({ title: 'Renamed in the app', isArchived: true }))
    await store.poll()
    expect(store.get('cli-a')).toBeUndefined()
  })

  it('does not open in an editor; the title is copied for the Claude app', async () => {
    const s = { id: 'cli-a', agent: 'cowork', title: 'Linux cheat sheet', entrypoint: 'local-agent', editor: 'Claude app', homeDir: 'C:\\x' } as SessionView
    expect(opensInEditor(s)).toBe(false)
    expect(resumeCommand(s)).toBeNull()
    expect(editorName('local-agent')).toBe('Claude app')
    const deps = { runEditor: vi.fn(), openUri: vi.fn(), copyText: vi.fn(), delay: vi.fn() }
    const res = await jumpToSession(s, DEFAULT_SETTINGS, deps)
    expect(res.ok).toBe(false)
    expect(res.message).toContain('Claude app')
    expect(deps.copyText).toHaveBeenCalledWith('Linux cheat sheet')
    expect(deps.runEditor).not.toHaveBeenCalled()
  })
})
