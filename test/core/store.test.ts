import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SessionStore } from '../../src/core/store.ts'
import { L, jsonl, tmpDir } from './helpers.ts'

const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString()

function setup() {
  const root = tmpDir()
  const claudeDir = path.join(root, '.claude')
  const dataDir = path.join(root, 'data')
  const proj = path.join(claudeDir, 'projects', 'c--dev-repo')
  mkdirSync(proj, { recursive: true })
  mkdirSync(path.join(proj, 'sess-1', 'subagents'), { recursive: true })
  mkdirSync(path.join(claudeDir, 'sessions'), { recursive: true })
  const transcript = path.join(proj, 'sess-1.jsonl')
  // Written before the store starts, so it counts as already seen.
  writeFileSync(transcript, jsonl(L.env(iso(60_000), 'c:\\dev\\repo'), L.prompt(iso(59_000), 'build the thing'), L.aiTitle('Build the thing')))
  writeFileSync(path.join(proj, 'sess-1', 'subagents', 'agent-1.jsonl'), jsonl(L.prompt(iso(1000), 'sub')))
  const live = (status: string) =>
    writeFileSync(path.join(claudeDir, 'sessions', '4242.json'), JSON.stringify({ pid: 4242, sessionId: 'sess-1', status, statusUpdatedAt: Date.now() }))
  live('busy')
  return { claudeDir, dataDir, transcript, live }
}

let store: SessionStore | null = null
afterEach(() => store?.stop())

describe('SessionStore', () => {
  it('lists sessions, follows growth and emits transitions', async () => {
    const env = setup()
    store = new SessionStore({ claudeDir: env.claudeDir, dataDir: env.dataDir, pollMs: 1e9, isAlive: (pid) => pid === 4242 })
    await store.start()

    let snap = store.snapshot()
    expect(snap.sessions.map((s) => s.id)).toEqual(['sess-1'])
    expect(snap.sessions[0]).toMatchObject({ title: 'Build the thing', repo: 'repo', status: 'busy', light: 'green' })

    const finished: string[] = []
    store.on('finished', (s) => finished.push(s.id))
    env.live('idle')
    appendFileSync(env.transcript, jsonl(L.reply(iso(0), 'All done.')))
    await store.poll()
    expect(store.get('sess-1')).toMatchObject({ light: 'yellow', lightGuess: true, lastReply: 'All done.' })
    expect(finished).toEqual(['sess-1'])

    const version = store.snapshot().searchVersion
    store.markSeen('sess-1')
    expect(store.get('sess-1')?.light).toBe('grey')
    expect(store.snapshot().searchVersion).toBe(version)
    expect(store.get('sess-1')?.activeMs).toBeGreaterThan(55_000)
    store.stop()
    const days = store.timeDays()
    expect(days.length).toBeGreaterThan(0)
    expect(store.timeDay(days[0]).sessions['sess-1']).toMatchObject({ title: 'Build the thing', repo: 'repo' })
    store.markUnread('sess-1')
    expect(store.get('sess-1')).toMatchObject({ light: 'yellow', reason: 'Marked as unread' })
    store.markSeen('sess-1')
    expect(store.get('sess-1')?.light).toBe('grey')
    expect(store.search('thing').map((h) => h.id)).toEqual(['sess-1'])
    expect(store.search('sub')).toEqual([])

    // Hidden sessions stay in the snapshot (the list can show them) but leave the counts and the urgent queue.
    store.markUnread('sess-1')
    expect(store.snapshot().counts.yellow).toBe(1)
    store.setHidden('sess-1', true)
    expect(store.get('sess-1')?.hidden).toBe(true)
    expect(store.snapshot().counts.yellow).toBe(0)
    expect(store.urgent()).toEqual([])
    store.setHidden('sess-1', false)
    expect(store.snapshot().counts.yellow).toBe(1)

    // Labels are to-do marks: searchable, but they do not change the light.
    expect(store.snapshot().labels.map((d) => d.name)).toEqual(['Pending merge', 'Needs attention', 'Review with peer'])
    store.setLabel('sess-1', 'review-with-peer', true)
    store.setLabel('sess-1', 'pending-merge', true)
    expect(store.get('sess-1')).toMatchObject({ labels: ['pending-merge', 'review-with-peer'], light: 'yellow' })
    expect(store.search('pending merge').map((h) => h.id)).toEqual(['sess-1'])
    store.addLabel('sess-1', 'Blocked by API', 'block')
    expect(store.snapshot().labels.at(-1)).toEqual({ id: 'blocked-by-api', name: 'Blocked by API', icon: 'block' })
    expect(store.get('sess-1')?.labels).toContain('blocked-by-api')
    store.removeLabel('pending-merge')
    expect(store.get('sess-1')?.labels).toEqual(['review-with-peer', 'blocked-by-api'])
    store.stop()
    // Labels survive a restart.
    const again = new SessionStore({ claudeDir: env.claudeDir, dataDir: env.dataDir, pollMs: 1e9, isAlive: () => false })
    await again.start()
    expect(again.get('sess-1')?.labels).toEqual(['review-with-peer', 'blocked-by-api'])
    again.stop()
  })

  it('uses hook events once hooks are installed', async () => {
    const env = setup()
    writeFileSync(path.join(env.claudeDir, 'settings.json'), JSON.stringify({ hooks: Object.fromEntries(['Notification', 'Stop', 'UserPromptSubmit', 'SessionStart', 'SessionEnd'].map((e) => [e, [{ hooks: [{ type: 'command', command: 'node "x/.vibe-session-manager/hook.cjs"' }] }]])) }))
    store = new SessionStore({ claudeDir: env.claudeDir, dataDir: env.dataDir, pollMs: 1e9, isAlive: () => true })
    await store.start()
    expect(store.snapshot().hooks).toBe('installed')

    const waiting: string[] = []
    store.on('waiting', (s) => waiting.push(s.reason))
    mkdirSync(env.dataDir, { recursive: true })
    appendFileSync(path.join(env.dataDir, 'events.jsonl'), JSON.stringify({ sessionId: 'sess-1', event: 'Notification', time: Date.now() + 10, message: 'Claude needs your permission to use Bash' }) + '\n')
    await store.poll()
    expect(store.get('sess-1')).toMatchObject({ light: 'red', lightGuess: false })
    expect(waiting).toEqual(['Claude needs your permission to use Bash'])
    expect(store.urgent().map((s) => s.id)).toEqual(['sess-1'])
  })

  it('shows a closed session when the process is gone', async () => {
    const env = setup()
    store = new SessionStore({ claudeDir: env.claudeDir, dataDir: env.dataDir, pollMs: 1e9, isAlive: () => false })
    await store.start()
    expect(store.get('sess-1')).toMatchObject({ status: 'closed', light: 'grey' })
  })
})
