import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { applyCodexLine, cleanCodexPrompt, codexLive, emptyCodexState, threadIdOf } from '../../src/core/codex.ts'
import { jumpToSession } from '../../src/core/launcher.ts'
import { SessionStore } from '../../src/core/store.ts'
import { DEFAULT_SETTINGS, type SessionView } from '../../src/shared/types.ts'
import { jsonl, tmpDir } from './helpers.ts'

// Shaped like real Codex 0.155 rollouts.
const ID = '01a0f6be-56c9-7093-a53a-1a9bd220cc5d'
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString()
const C = {
  meta: (ts: string, extra: object = {}) => ({
    timestamp: ts,
    type: 'session_meta',
    payload: { id: ID, session_id: ID, timestamp: ts, cwd: '\\\\?\\C:\\dev\\shop', originator: 'codex_work_desktop', cli_version: '0.155.0', source: 'vscode', thread_source: 'user', git: { branch: 'main' }, ...extra }
  }),
  started: (ts: string) => ({ timestamp: ts, type: 'event_msg', payload: { type: 'task_started', turn_id: 't1' } }),
  user: (ts: string, text: string) => ({ timestamp: ts, type: 'event_msg', payload: { type: 'item_completed', thread_id: ID, item: { type: 'UserMessage', content: [{ type: 'text', text }] } } }),
  agent: (ts: string, text: string) => ({ timestamp: ts, type: 'event_msg', payload: { type: 'item_completed', thread_id: ID, item: { type: 'AgentMessage', content: [{ type: 'Text', text }], phase: 'final_answer' } } }),
  complete: (ts: string) => ({ timestamp: ts, type: 'event_msg', payload: { type: 'task_complete', turn_id: 't1', last_agent_message: 'done' } }),
  aborted: (ts: string) => ({ timestamp: ts, type: 'event_msg', payload: { type: 'turn_aborted', turn_id: 't1', reason: 'interrupted' } })
}

describe('Codex rollouts', () => {
  it('takes the thread id from the file name, also for continuation files', () => {
    expect(threadIdOf(`rollout-2026-10-01T11-14-24-${ID}.jsonl`)).toBe(ID)
    expect(threadIdOf(`rollout-2026-09-22T23-43-01-${ID}_01a0cb12-7c89-7383-9aef-9bf89b856226.jsonl`)).toBe(ID)
    expect(threadIdOf('notes.jsonl')).toBeNull()
  })

  it('keeps only what the user typed after the IDE context', () => {
    expect(cleanCodexPrompt('# Context from my IDE setup:\n\n## Open tabs:\n- a.ts\n\n## My request:\nfix the bug')).toBe('fix the bug')
    expect(cleanCodexPrompt('# Context from my IDE setup:\n\n## Open tabs:\n- a.ts')).toBe('')
    expect(cleanCodexPrompt('  plain question ')).toBe('plain question')
  })

  it('parses folder, branch, prompts, replies and turn state', () => {
    const s = emptyCodexState(ID, 'x')
    for (const l of [C.meta(iso(5000)), C.started(iso(4000)), C.user(iso(4000), 'why 403?'), C.agent(iso(1000), 'Cloudflare.')]) applyCodexLine(s, l)
    expect(s).toMatchObject({ homeDir: 'C:\\dev\\shop', branches: ['main'], prompts: ['why 403?'], texts: ['Cloudflare.'], lastReply: 'Cloudflare.', entrypoint: 'codex_work_desktop', version: '0.155.0' })
    expect(s.codex).toMatchObject({ hidden: false, turnOpen: true })
    expect(codexLive(s, true)?.status).toBe('busy')
    applyCodexLine(s, C.complete(iso(500)))
    expect(s.codex.turnOpen).toBe(false)
    expect(codexLive(s, true)?.status).toBe('idle')
    expect(codexLive(s, false)).toBeNull()
  })

  it('treats a turn without new lines for a long time as stuck, not working', () => {
    const s = emptyCodexState(ID, 'x')
    for (const l of [C.meta(iso(40 * 60_000)), C.started(iso(40 * 60_000))]) applyCodexLine(s, l)
    expect(codexLive(s, true)?.status).toBe('idle')
  })

  it('hides subagent threads', () => {
    const s = emptyCodexState(ID, 'x')
    applyCodexLine(s, C.meta(iso(0), { parent_thread_id: 'p', thread_source: 'subagent', source: { subagent: { thread_spawn: {} } } }))
    expect(s.codex.hidden).toBe(true)
  })
})

describe('SessionStore with Codex', () => {
  let store: SessionStore | null = null
  let root = ''
  afterEach(() => {
    store?.stop()
    rmSync(root, { recursive: true, force: true })
  })

  function setup() {
    root = tmpDir()
    const codexDir = path.join(root, '.codex')
    const day = path.join(codexDir, 'sessions', '2026', '10', '01')
    mkdirSync(day, { recursive: true })
    mkdirSync(path.join(codexDir, 'thread-writer-locks'), { recursive: true })
    const file = path.join(day, `rollout-2026-10-01T11-14-24-${ID}.jsonl`)
    writeFileSync(file, jsonl(C.meta(iso(60_000)), C.started(iso(59_000)), C.user(iso(59_000), 'why does the PDF request get a 403?')))
    writeFileSync(path.join(codexDir, 'session_index.jsonl'), jsonl({ id: ID, thread_name: 'Fejlsøg 403', updated_at: iso(0) }))
    writeFileSync(path.join(codexDir, 'thread-writer-locks', `${ID}.lock`), '')
    const sub = '01a08f0d-ab5c-7d63-b605-345d434faf6a'
    writeFileSync(path.join(day, `rollout-2026-10-01T11-20-00-${sub}.jsonl`), jsonl({ ...C.meta(iso(1000)), payload: { id: sub, parent_thread_id: ID, source: { subagent: {} } } }))
    return { codexDir, day, file }
  }

  it('lists Codex threads next to Claude sessions and follows their turns', async () => {
    const env = setup()
    store = new SessionStore({ claudeDir: path.join(root, '.claude'), codexDir: env.codexDir, dataDir: path.join(root, 'data'), pollMs: 1e9 })
    await store.start()
    expect(store.snapshot().sessions.map((s) => s.id)).toEqual([ID])
    expect(store.get(ID)).toMatchObject({ agent: 'codex', title: 'Fejlsøg 403', repo: 'shop', status: 'busy', light: 'green', editor: 'Codex app' })

    const finished: string[] = []
    store.on('finished', (s) => finished.push(s.id))
    appendFileSync(env.file, jsonl(C.agent(iso(10), 'Cloudflare blocks it.'), C.complete(iso(0))))
    await store.poll()
    expect(store.get(ID)).toMatchObject({ status: 'idle', light: 'yellow', lightGuess: false, lastReply: 'Cloudflare blocks it.' })
    expect(finished).toEqual([ID])
    expect(store.search('codex 403').map((h) => h.id)).toEqual([ID])

    // A long thread continues in a second file.
    writeFileSync(path.join(env.day, `rollout-2026-10-02T09-00-00-${ID}_01a0cb12-7c89-7383-9aef-9bf89b856226.jsonl`), jsonl(C.meta(iso(0)), C.user(iso(0), 'and now?')))
    await store.poll()
    expect(store.get(ID)).toMatchObject({ lastPrompt: 'and now?', light: 'grey' })

    rmSync(path.join(env.codexDir, 'thread-writer-locks', `${ID}.lock`))
    await store.poll()
    expect(store.get(ID)?.status).toBe('closed')
  })

  it('opens desktop threads in the Codex app and editor threads in VS Code', async () => {
    const deps = () => ({ runEditor: vi.fn(async () => {}), openUri: vi.fn(async () => {}), copyText: vi.fn(), delay: vi.fn(async () => {}) })
    const s = { id: ID, agent: 'codex', homeDir: 'c:\\dev\\shop', entrypoint: 'codex_work_desktop', editor: 'Codex app' } as SessionView
    let d = deps()
    expect(await jumpToSession(s, DEFAULT_SETTINGS, d)).toEqual({ ok: true })
    expect(d.openUri).toHaveBeenCalledWith(`codex://threads/${ID}`)
    expect(d.runEditor).not.toHaveBeenCalled()

    d = deps()
    await jumpToSession({ ...s, entrypoint: 'codex_vscode', editor: 'VS Code' }, DEFAULT_SETTINGS, d)
    expect(d.runEditor).toHaveBeenCalledWith('code', 'c:\\dev\\shop')
    expect(d.openUri).toHaveBeenCalledWith(`vscode://openai.chatgpt/local/${ID}`)

    d = deps()
    await jumpToSession({ ...s, entrypoint: 'codex_cli_rs', editor: 'Terminal' }, DEFAULT_SETTINGS, d)
    expect(d.copyText).toHaveBeenCalledWith(`codex resume ${ID}`)
  })
})
