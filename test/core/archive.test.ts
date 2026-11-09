import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, truncateSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { gunzipSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { closeFences, ConversationArchive, folderPlan, newRenderState, openNeeds, recreateFolder, renderClaudeLine, renderCodexLine, renderHeader, type ArchiveItem } from '../../src/core/archive.ts'
import { SessionStore } from '../../src/core/store.ts'
import type { ArchiveSessionInfo } from '../../src/shared/types.ts'
import { L, jsonl, tmpDir } from './helpers.ts'

const T = '2026-10-01T10:00:00.000Z'

const info = (root: string, extra: Partial<ArchiveSessionInfo> = {}): ArchiveSessionInfo => ({
  id: 'sess-1',
  agent: 'claude',
  title: 'Build the thing',
  repo: 'repo',
  repoPath: root,
  worktree: null,
  branch: 'main',
  homeDir: root,
  entrypoint: 'claude-vscode',
  firstActivity: Date.parse(T),
  lastActivity: Date.parse(T),
  ...extra
})

function setup(lines: object[] = [L.prompt(T, 'build the thing'), L.reply(T, 'Done with the thing.')]) {
  const root = tmpDir()
  const proj = path.join(root, 'projects', 'c--dev-repo')
  mkdirSync(proj, { recursive: true })
  const transcript = path.join(proj, 'sess-1.jsonl')
  writeFileSync(transcript, jsonl(...lines))
  const archive = new ConversationArchive(path.join(root, 'archive'))
  const item = (extra: Partial<ArchiveSessionInfo> = {}): ArchiveItem => ({ info: info(root, extra), files: [transcript] })
  const folder = path.join(root, 'archive', 'sessions', 'sess-1')
  return { root, proj, transcript, archive, item, folder, md: () => readFileSync(path.join(folder, 'conversation.md'), 'utf8'), raw: () => gunzipSync(readFileSync(path.join(folder, 'raw', 'sess-1.jsonl.gz'))).toString() }
}

describe('rendering a conversation', () => {
  it('keeps prompts, replies and pasted text, and only those', () => {
    const st = newRenderState()
    const pasted = L.prompt(T, 'see this <pasted_content id="x">log line</pasted_content><system-reminder>hidden</system-reminder>')
    const out = [
      pasted,
      L.reply(T, 'First part.'),
      L.toolUse(T, 't1'),
      L.toolResult(T, 't1'),
      L.reply(T, 'Second part.'),
      L.prompt(T, 'meta', { isMeta: true }),
      L.prompt(T, 'a notification', { origin: { kind: 'task-notification' } }),
      L.aiTitle('A title')
    ].map((l) => renderClaudeLine(l, st)).join('')
    expect(out).toContain('see this')
    expect(out).toContain('**Pasted text**')
    expect(out).toContain('log line')
    expect(out).not.toContain('hidden')
    expect(out).not.toContain('meta')
    expect(out).not.toContain('a notification')
    expect(out).not.toContain('A title')
    // Text on both sides of a tool call is one turn, under one heading.
    expect(out.match(/^## Claude/gm)).toHaveLength(1)
    expect(out.match(/^## You/gm)).toHaveLength(1)
  })

  it('does not clip long text', () => {
    const long = 'x'.repeat(50_000)
    expect(renderClaudeLine(L.reply(T, long), newRenderState())).toContain(long)
  })

  it('marks subagent text and leaves out its tool results', () => {
    const st = newRenderState()
    expect(renderClaudeLine({ type: 'user', isSidechain: true, timestamp: T, message: { content: 'look at the logs' } }, st, true)).toContain('## Task for subagent')
    expect(renderClaudeLine(L.reply(T, 'Found it.'), st, true)).toContain('## Subagent')
    // Its task is often marked as meta; a reminder on its own is not a task.
    const meta = (message: string) => ({ type: 'user', isSidechain: true, isMeta: true, timestamp: T, message: { content: message } })
    expect(renderClaudeLine(meta('look at the logs'), st, true)).toContain('look at the logs')
    expect(renderClaudeLine(meta('<system-reminder>hidden</system-reminder>'), st, true)).toBe('')
  })

  it('notes attachments it cannot show', () => {
    const line = { type: 'user', timestamp: T, origin: { kind: 'human' }, message: { content: [{ type: 'image', source: {} }, { type: 'text', text: 'what is this' }] } }
    expect(renderClaudeLine(line, newRenderState())).toContain('*[image attached]*')
  })

  it('closes a code fence left open, so it cannot swallow later turns', () => {
    expect(closeFences('```js\nx')).toBe('```js\nx\n```')
    expect(closeFences('```js\nx\n```')).toBe('```js\nx\n```')
    expect(closeFences('````\n```\nx\n````')).toBe('````\n```\nx\n````')
    expect(closeFences('no fence')).toBe('no fence')
  })

  it('reads Codex rollouts, without messages logged twice', () => {
    const st = newRenderState()
    const ev = (payload: object) => ({ type: 'event_msg', timestamp: T, payload })
    const item = (type: string, text: string) => ev({ type: 'item_completed', item: { type, content: [{ type: 'text', text }] } })
    const out = [
      ev({ type: 'task_started' }),
      item('UserMessage', '# Context from my IDE setup:\nopen tabs\n## My request for Codex:\nfix it'),
      item('AgentMessage', 'Fixed.'),
      ev({ type: 'agent_message', message: 'Fixed.' }),
      ev({ type: 'task_complete', last_agent_message: 'Fixed.' }),
      ev({ type: 'task_started' }),
      ev({ type: 'user_message', message: 'and now?' }),
      ev({ type: 'task_complete', last_agent_message: 'All good.' }),
      { type: 'response_item', payload: { type: 'function_call' } }
    ].map((l) => renderCodexLine(l, st)).join('')
    expect(out).toContain('## You')
    expect(out).toContain('fix it')
    expect(out).not.toContain('open tabs')
    expect(out.match(/Fixed\./g)).toHaveLength(1)
    expect(out).toContain('All good.')
  })
})

describe('ConversationArchive', () => {
  it('appends to an exact copy as the transcript grows, and only copies complete lines', async () => {
    const env = setup()
    await env.archive.sync([env.item()])
    expect(env.raw()).toBe(readFileSync(env.transcript, 'utf8'))
    expect(env.md()).toContain('# Build the thing')
    expect(env.md()).toContain('build the thing')
    const before = env.md().length

    const nothingNew = env.archive.version
    await env.archive.sync([env.item()])
    expect(env.archive.version).toBe(nothingNew)
    expect(env.md().length).toBe(before)

    const half = JSON.stringify(L.reply(T, 'half a line'))
    appendFileSync(env.transcript, jsonl(L.prompt(T, 'second prompt')) + half.slice(0, 10))
    await env.archive.sync([env.item()])
    expect(env.md()).toContain('second prompt')
    expect(env.raw().endsWith('\n')).toBe(true)
    expect(env.raw()).not.toContain(half.slice(0, 10) + '\n')

    appendFileSync(env.transcript, half.slice(10) + '\n')
    await env.archive.sync([env.item()])
    expect(env.raw()).toBe(readFileSync(env.transcript, 'utf8'))
    expect(env.md()).toContain('half a line')
  })

  it('handles a transcript much larger than one read, with very long lines', async () => {
    const long = 'y'.repeat(3 << 20)
    const env = setup([L.prompt(T, 'start'), L.reply(T, long), ...Array.from({ length: 300 }, (_, i) => L.reply(T, `${i} ${'z'.repeat(10_000)}`))])
    await env.archive.sync([env.item()])
    expect(env.raw()).toBe(readFileSync(env.transcript, 'utf8'))
    expect(env.md()).toContain(long)
    expect(env.md()).toContain('299 zzz')
  })

  it('goes on where it was after a restart, without repeating text', async () => {
    const env = setup()
    await env.archive.sync([env.item()])
    appendFileSync(env.transcript, jsonl(L.prompt(T, 'after restart')))
    const again = new ConversationArchive(env.archive.dir)
    await again.sync([env.item()])
    expect(env.raw()).toBe(readFileSync(env.transcript, 'utf8'))
    expect(env.md().match(/build the thing/g)).toHaveLength(1)
    expect(env.md()).toContain('after restart')
    expect(again.sessionCount).toBe(1)
  })

  it('repairs a write that was interrupted before meta.json was saved', async () => {
    const env = setup()
    await env.archive.sync([env.item()])
    const gz = path.join(env.folder, 'raw', 'sess-1.jsonl.gz')
    const size = statSync(gz).size
    appendFileSync(gz, Buffer.from('half a gzip member'))
    appendFileSync(path.join(env.folder, 'conversation.md'), 'half a turn')
    appendFileSync(env.transcript, jsonl(L.prompt(T, 'next')))
    await new ConversationArchive(env.archive.dir).sync([env.item()])
    expect(statSync(gz).size).toBeGreaterThan(size)
    expect(env.raw()).toBe(readFileSync(env.transcript, 'utf8'))
    expect(env.md()).not.toContain('half a turn')
  })

  it('keeps the old copy when a transcript is replaced by a shorter one', async () => {
    const env = setup()
    await env.archive.sync([env.item()])
    const old = env.raw()
    writeFileSync(env.transcript, jsonl(L.prompt(T, 'new')))
    await env.archive.sync([env.item()])
    expect(env.raw()).toBe(readFileSync(env.transcript, 'utf8'))
    const rotated = readdirSync(path.join(env.folder, 'raw')).filter((f) => f !== 'sess-1.jsonl.gz')
    expect(rotated).toHaveLength(1)
    expect(gunzipSync(readFileSync(path.join(env.folder, 'raw', rotated[0]))).toString()).toBe(old)
    expect(env.md()).toContain('build the thing')
  })

  it('updates the header when the title changes and keeps the conversation', async () => {
    const env = setup()
    await env.archive.sync([env.item()])
    await env.archive.sync([env.item({ title: 'A better title' })])
    expect(env.md().startsWith('# A better title')).toBe(true)
    expect(env.md()).toContain('Done with the thing.')
    expect(env.md().match(/<!-- conversation -->/g)).toHaveLength(1)
    expect((await env.archive.search('better'))[0].title).toBe('A better title')
  })

  it('copies subagents and saved tool results, and puts them back too', async () => {
    const env = setup()
    const sub = path.join(env.proj, 'sess-1', 'subagents', 'agent-a.jsonl')
    const tool = path.join(env.proj, 'sess-1', 'tool-results', 'out.txt')
    mkdirSync(path.dirname(sub), { recursive: true })
    mkdirSync(path.dirname(tool), { recursive: true })
    writeFileSync(sub, jsonl(L.reply(T, 'subagent found the bug')))
    writeFileSync(tool, 'a saved tool result')
    await env.archive.sync([env.item()])
    expect(env.md()).toContain('## Subagent')
    expect(env.md()).toContain('subagent found the bug')
    expect(env.md()).not.toContain('a saved tool result')

    writeFileSync(tool, 'changed')
    await env.archive.sync([env.item()])

    rmSync(env.transcript)
    rmSync(path.join(env.proj, 'sess-1'), { recursive: true })
    await env.archive.restoreTranscript('sess-1')
    expect(readFileSync(sub, 'utf8')).toContain('subagent found the bug')
    expect(readFileSync(tool, 'utf8')).toBe('changed')
  })

  it('keeps the rest of a Codex thread in its order', async () => {
    const env = setup()
    const a = path.join(env.proj, 'rollout-a.jsonl')
    const b = path.join(env.proj, 'rollout-b.jsonl')
    const say = (message: string) => ({ type: 'event_msg', timestamp: T, payload: { type: 'agent_message', message } })
    writeFileSync(a, jsonl(say('first file')))
    writeFileSync(b, jsonl(say('second file')))
    await env.archive.sync([{ info: info(env.root, { agent: 'codex' }), files: [a, b] }])
    expect(env.md().indexOf('first file')).toBeLessThan(env.md().indexOf('second file'))
    expect(env.md()).toContain('## Codex')
  })

  it('searches the full text, also after the source is gone, newest first', async () => {
    const env = setup([L.prompt(T, 'start'), L.reply(T, `${'x '.repeat(20_000)} needleword at the very end`)])
    const other = path.join(env.proj, 'other.jsonl')
    writeFileSync(other, jsonl(L.reply(T, 'something else')))
    const newer = { info: info(env.root, { id: 'other', title: 'Other', lastActivity: Date.parse(T) + 1000 }), files: [other] }
    await env.archive.sync([env.item(), newer])

    expect((await env.archive.search('')).map((h) => h.id)).toEqual(['other', 'sess-1'])
    expect((await env.archive.search('NEEDLEWORD end')).map((h) => h.id)).toEqual(['sess-1'])
    expect((await env.archive.search('needleword'))[0].snippet).toContain('needleword')
    expect((await env.archive.search('other'))[0].snippet).toBeNull()
    expect(await env.archive.search('missing')).toEqual([])

    rmSync(env.transcript)
    const fresh = new ConversationArchive(env.archive.dir)
    expect((await fresh.search('needleword')).map((h) => h.id)).toEqual(['sess-1'])
    expect((await fresh.read('sess-1'))?.markdown).toContain('needleword')
    expect(await fresh.read('nope')).toBeNull()
  })

  it('finds what a pass adds once the archive has been searched', async () => {
    const env = setup()
    await env.archive.sync([env.item()])
    expect(await env.archive.search('laterword')).toEqual([])
    appendFileSync(env.transcript, jsonl(L.prompt(T, 'laterword')))
    await env.archive.sync([env.item()])
    expect((await env.archive.search('laterword')).map((h) => h.id)).toEqual(['sess-1'])
  })

  it('checks at the time of listing whether a session can be opened', async () => {
    const env = setup()
    const home = path.join(env.root, 'home')
    mkdirSync(home)
    await env.archive.sync([env.item({ homeDir: home })])
    const state = async () => (await env.archive.search(''))[0].open

    expect(await state()).toEqual({ folderExists: true, transcriptExists: true, needsRestore: false })
    rmSync(home, { recursive: true })
    expect(await state()).toEqual({ folderExists: false, transcriptExists: true, needsRestore: true })
    mkdirSync(home)
    rmSync(env.transcript)
    expect(await state()).toEqual({ folderExists: true, transcriptExists: false, needsRestore: true })
  })

  it('puts a deleted transcript back as it was, and leaves an existing one alone', async () => {
    const env = setup()
    await env.archive.sync([env.item()])
    appendFileSync(env.transcript, jsonl(L.prompt(T, 'more')))
    await env.archive.sync([env.item()])
    const original = readFileSync(env.transcript, 'utf8')

    writeFileSync(env.transcript, 'do not overwrite')
    await env.archive.restoreTranscript('sess-1')
    expect(readFileSync(env.transcript, 'utf8')).toBe('do not overwrite')

    rmSync(path.dirname(env.transcript), { recursive: true })
    await env.archive.restoreTranscript('sess-1')
    expect(readFileSync(env.transcript, 'utf8')).toBe(original)
  })

  it('stops between pieces of work and goes on later', async () => {
    const env = setup()
    expect(await env.archive.sync([env.item()], { stop: () => true })).toBeNull()
    expect(env.archive.sessionCount).toBe(0)
    await env.archive.sync([env.item()])
    expect(env.raw()).toBe(readFileSync(env.transcript, 'utf8'))
  })
})

describe('what opening a session needs', () => {
  it('depends on where the session runs', () => {
    expect(openNeeds({ agent: 'claude', entrypoint: 'claude-vscode' })).toEqual({ folder: true, transcript: true })
    expect(openNeeds({ agent: 'codex', entrypoint: 'codex_vscode' })).toEqual({ folder: true, transcript: true })
    expect(openNeeds({ agent: 'codex', entrypoint: 'codex_work_desktop' })).toEqual({ folder: false, transcript: true })
    expect(openNeeds({ agent: 'cowork', entrypoint: 'local-agent' })).toEqual({ folder: false, transcript: false })
  })

  it('plans a worktree only while its repo exists', () => {
    const wt = { worktree: 'wt', repoPath: 'c:\\dev\\repo', homeDir: 'c:\\dev\\repo\\.claude\\worktrees\\wt', branch: 'feat/x' }
    expect(folderPlan(wt, () => true)).toEqual({ kind: 'worktree', branch: 'feat/x' })
    expect(folderPlan(wt, () => false).kind).toBe('empty')
    expect(folderPlan({ ...wt, worktree: null }, () => true).kind).toBe('empty')
    expect(folderPlan({ ...wt, branch: 'HEAD' }, () => true).branch).toBeNull()
    expect(folderPlan({ ...wt, branch: '--upload-pack=x' }, () => true).branch).toBeNull()
  })
})

describe('recreateFolder', () => {
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim()

  function repoWithWorktree() {
    const root = tmpDir()
    const repo = path.join(root, 'repo')
    mkdirSync(repo)
    git(repo, 'init', '-q', '-b', 'main')
    git(repo, 'config', 'user.email', 'test@example.com')
    git(repo, 'config', 'user.name', 'Test')
    writeFileSync(path.join(repo, 'a.txt'), 'a\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-q', '-m', 'first')
    const homeDir = path.join(repo, '.claude', 'worktrees', 'wt')
    git(repo, 'worktree', 'add', '-q', '-b', 'feat/x', homeDir)
    writeFileSync(path.join(homeDir, 'b.txt'), 'b\n')
    git(homeDir, 'add', '.')
    git(homeDir, 'commit', '-q', '-m', 'on the branch')
    return { repo, homeDir, i: info(root, { repoPath: repo, homeDir, worktree: 'wt', branch: 'feat/x' }) }
  }

  it('brings back a removed worktree on its branch', async () => {
    const { homeDir, i } = repoWithWorktree()
    // Deleted without git knowing, so git still has it registered.
    rmSync(homeDir, { recursive: true, force: true })
    expect(await recreateFolder(i)).toBeNull()
    expect(git(homeDir, 'branch', '--show-current')).toBe('feat/x')
    expect(existsSync(path.join(homeDir, 'b.txt'))).toBe(true)
  })

  it('creates the branch again when it was deleted', async () => {
    const { repo, homeDir, i } = repoWithWorktree()
    git(repo, 'worktree', 'remove', '--force', homeDir)
    git(repo, 'branch', '-D', 'feat/x')
    expect(await recreateFolder(i)).toContain('no longer existed')
    expect(git(homeDir, 'branch', '--show-current')).toBe('feat/x')
  })

  it('detaches when the branch is checked out elsewhere', async () => {
    const { repo, homeDir, i } = repoWithWorktree()
    git(repo, 'worktree', 'remove', '--force', homeDir)
    git(repo, 'checkout', '-q', 'feat/x')
    expect(await recreateFolder(i)).toContain('checked out elsewhere')
    expect(git(homeDir, 'branch', '--show-current')).toBe('')
    expect(existsSync(path.join(homeDir, 'b.txt'))).toBe(true)
  })

  it('makes an empty folder when there is no repo to use', async () => {
    const root = tmpDir()
    const homeDir = path.join(root, 'gone', 'wt')
    expect(await recreateFolder(info(root, { repoPath: path.join(root, 'gone'), homeDir, worktree: 'wt' }))).toContain('empty folder')
    expect(readdirSync(homeDir)).toEqual([])
  })

  it('reports why git failed', async () => {
    const { repo, homeDir, i } = repoWithWorktree()
    git(repo, 'worktree', 'remove', '--force', homeDir)
    await expect(recreateFolder({ ...i, branch: 'bad..name' })).rejects.toThrow()
  })
})

describe('SessionStore and the archive', () => {
  let store: SessionStore | null = null
  afterEach(() => store?.stop())

  const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString()

  function setupStore(dir: string) {
    const root = tmpDir()
    const claudeDir = path.join(root, '.claude')
    const dataDir = path.join(root, 'data')
    const proj = path.join(claudeDir, 'projects', 'c--dev-repo')
    mkdirSync(proj, { recursive: true })
    mkdirSync(path.join(claudeDir, 'sessions'), { recursive: true })
    const transcript = path.join(proj, 'sess-1.jsonl')
    writeFileSync(transcript, jsonl(L.env(iso(60_000), dir), L.prompt(iso(59_000), 'build the thing'), L.aiTitle('Build the thing'), L.reply(iso(58_000), 'Done.')))
    return { claudeDir, dataDir, transcript, archiveDir: path.join(dataDir, 'archive') }
  }

  it('writes nothing until it is turned on', async () => {
    const home = tmpDir()
    const env = setupStore(home)
    store = new SessionStore({ claudeDir: env.claudeDir, dataDir: env.dataDir, pollMs: 1e9, isAlive: () => false })
    await store.start()
    await store.syncArchive()
    expect(existsSync(env.archiveDir)).toBe(false)
    expect(store.archiveStatus()).toMatchObject({ enabled: false, sessions: 0, running: false })
  })

  it('archives when turned on, keeps it when turned off, and reports its status', async () => {
    const home = tmpDir()
    const env = setupStore(home)
    store = new SessionStore({ claudeDir: env.claudeDir, dataDir: env.dataDir, pollMs: 1e9, isAlive: () => false })
    await store.start()
    const seen: boolean[] = []
    store.on('archive', (s) => seen.push(s.enabled))
    store.setArchiving(true)
    await store.syncArchive()
    expect(seen[0]).toBe(true)
    expect(store.archiveStatus()).toMatchObject({ enabled: true, running: false, sessions: 1, error: null })
    expect(store.archiveStatus().bytes).toBeGreaterThan(0)
    expect((await store.archive.search('build'))[0]).toMatchObject({ id: 'sess-1', title: 'Build the thing', repo: path.basename(home), homeDir: home })

    store.setArchiving(false)
    appendFileSync(env.transcript, jsonl(L.prompt(iso(0), 'not archived')))
    await store.poll()
    await store.syncArchive()
    expect(await store.archive.search('archived')).toEqual([])
    expect((await store.archive.search('build')).length).toBe(1)
  })

  it('restores a deleted transcript and folder, and lists the session again', async () => {
    const home = path.join(tmpDir(), 'gone')
    mkdirSync(home)
    const env = setupStore(home)
    store = new SessionStore({ claudeDir: env.claudeDir, dataDir: env.dataDir, pollMs: 1e9, isAlive: () => false, archive: true })
    await store.start()
    await store.syncArchive()

    const moved = env.transcript + '.bak'
    renameSync(env.transcript, moved)
    rmSync(home, { recursive: true })
    await store.poll()
    expect(store.get('sess-1')).toBeUndefined()
    expect((await store.archive.search('build'))[0].open).toMatchObject({ needsRestore: true, folderExists: false, transcriptExists: false })

    expect(await store.restoreArchived('sess-1')).toContain('empty folder')
    expect(readFileSync(env.transcript, 'utf8')).toBe(readFileSync(moved, 'utf8'))
    expect(statSync(home).isDirectory()).toBe(true)
    expect(store.get('sess-1')?.title).toBe('Build the thing')
    expect((await store.archive.search('build'))[0].open.needsRestore).toBe(false)
    await expect(store.restoreArchived('nope')).rejects.toThrow('not in the archive')
  })

  it('does not write a half-read last line when a transcript shrinks to nothing', async () => {
    const home = tmpDir()
    const env = setupStore(home)
    store = new SessionStore({ claudeDir: env.claudeDir, dataDir: env.dataDir, pollMs: 1e9, isAlive: () => false, archive: true })
    await store.start()
    await store.syncArchive()
    truncateSync(env.transcript, 0)
    await store.syncArchive()
    expect((await store.archive.read('sess-1'))?.markdown).toContain('build the thing')
  })
})

describe('renderHeader', () => {
  it('leaves out what is not known', () => {
    const h = renderHeader(info('c:\\dev\\repo', { worktree: null, branch: null, title: 'Two\nlines' }))
    expect(h).toContain('# Two lines')
    expect(h).toContain('**Folder:** c:\\dev\\repo')
    expect(h).not.toContain('Worktree')
    expect(h).not.toContain('Branch')
  })
})
