import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { applyEvent, EventsReader, type HookState } from '../../src/core/events.ts'
import { getHooksStatus, HOOK_EVENTS, hookCommand, installHooks, uninstallHooks, upgradeLegacyHooks, withOurHooks, withoutOurHooks } from '../../src/core/hooks.ts'
import { tmpDir } from './helpers.ts'

const existing = {
  model: 'opus',
  hooks: {
    Stop: [{ hooks: [{ type: 'command', command: 'echo theirs' }] }],
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'lint' }] }]
  }
}

describe('settings merge', () => {
  const cmd = hookCommand('node', 'C:\\Users\\x\\.vibe-session-manager')

  it('builds a command with forward slashes and the marker', () => {
    expect(cmd).toBe('node "C:/Users/x/.vibe-session-manager/hook.cjs" # vibe-session-manager')
  })

  it('adds one hook per event and keeps existing hooks and settings', () => {
    const out = withOurHooks(existing, cmd)
    expect(out.model).toBe('opus')
    expect(out.hooks.PreToolUse).toEqual(existing.hooks.PreToolUse)
    expect(out.hooks.Stop).toHaveLength(2)
    expect(out.hooks.Stop[0]).toEqual(existing.hooks.Stop[0])
    for (const e of HOOK_EVENTS) expect(JSON.stringify(out.hooks[e])).toContain('hook.cjs')
  })

  it('is idempotent and removes cleanly', () => {
    const twice = withOurHooks(withOurHooks(existing, cmd), cmd)
    expect(twice.hooks.Stop).toHaveLength(2)
    expect(withoutOurHooks(twice)).toEqual(existing)
    expect(withoutOurHooks(withOurHooks({}, cmd))).toEqual({})
  })
})

describe('install / uninstall on disk', () => {
  it('round-trips settings.json, writes a backup and the hook script', async () => {
    const dir = tmpDir()
    const settings = path.join(dir, 'settings.json')
    const dataDir = path.join(dir, '.vibe-session-manager')
    writeFileSync(settings, JSON.stringify(existing, null, 2))
    expect(await getHooksStatus(settings)).toBe('none')
    await installHooks(settings, dataDir, 'node')
    expect(await getHooksStatus(settings)).toBe('installed')
    expect(existsSync(path.join(dataDir, 'hook.cjs'))).toBe(true)
    expect(existsSync(settings + '.vsm-backup')).toBe(true)
    await uninstallHooks(settings)
    expect(JSON.parse(readFileSync(settings, 'utf8'))).toEqual(existing)
  })

  it('recognises its hooks whatever the data dir is called, and keeps the first backup', async () => {
    const dir = tmpDir()
    const settings = path.join(dir, 'settings.json')
    writeFileSync(settings, JSON.stringify(existing))
    await installHooks(settings, path.join(dir, 'data'), 'node')
    await installHooks(settings, path.join(dir, 'data'), 'node')
    expect(await getHooksStatus(settings)).toBe('installed')
    expect(JSON.parse(readFileSync(settings, 'utf8')).hooks.Stop).toHaveLength(2)
    expect(JSON.parse(readFileSync(settings + '.vsm-backup', 'utf8'))).toEqual(existing)
    await uninstallHooks(settings)
    expect(JSON.parse(readFileSync(settings, 'utf8'))).toEqual(existing)
  })

  it('moves hooks installed under the old app name to the new data dir', async () => {
    const dir = tmpDir()
    const settings = path.join(dir, 'settings.json')
    const legacy = 'node "C:/Users/x/.ai-dev-session-manager/hook.cjs" # ai-dev-session-manager'
    writeFileSync(settings, JSON.stringify(withOurHooks(existing, legacy)))
    writeFileSync(settings + '.adsm-backup', JSON.stringify(existing))
    expect(await getHooksStatus(settings)).toBe('installed')
    expect(await upgradeLegacyHooks(settings, path.join(dir, 'data'), () => 'node')).toBe(true)
    const text = readFileSync(settings, 'utf8')
    expect(text).not.toContain('ai-dev-session-manager')
    expect(JSON.parse(text).hooks.Stop).toHaveLength(2)
    expect(existsSync(path.join(dir, 'data', 'hook.cjs'))).toBe(true)
    expect(existsSync(settings + '.vsm-backup')).toBe(false)
    expect(await upgradeLegacyHooks(settings, path.join(dir, 'data'), () => 'node')).toBe(false)
    await uninstallHooks(settings)
    expect(JSON.parse(readFileSync(settings, 'utf8'))).toEqual(existing)
  })

  it('reads settings saved with a BOM', async () => {
    const dir = tmpDir()
    const settings = path.join(dir, 'settings.json')
    writeFileSync(settings, '\uFEFF' + JSON.stringify(existing))
    expect(await getHooksStatus(settings)).toBe('none')
    await installHooks(settings, path.join(dir, 'data'), 'node')
    expect(await getHooksStatus(settings)).toBe('installed')
  })

  it('refuses to touch a settings file it cannot parse', async () => {
    const dir = tmpDir()
    const settings = path.join(dir, 'settings.json')
    writeFileSync(settings, '{ broken')
    await expect(installHooks(settings, path.join(dir, 'data'), 'node')).rejects.toThrow()
    expect(readFileSync(settings, 'utf8')).toBe('{ broken')
    expect(await getHooksStatus(settings)).toBe('error')
  })
})

describe('hook script', () => {
  const run = (dataDir: string, input: string) =>
    spawnSync(process.execPath, [path.join(dataDir, 'hook.cjs')], { input, encoding: 'utf8', timeout: 5000 })

  it('appends an event without prompt text and exits 0', async () => {
    const dir = tmpDir()
    await installHooks(path.join(dir, 'settings.json'), dir, 'node')
    const r = run(dir, JSON.stringify({ session_id: 's1', hook_event_name: 'Notification', message: 'Claude needs your permission', notification_type: 'permission_prompt', prompt: 'secret', cwd: 'c:\\x' }))
    expect(r.status).toBe(0)
    const rec = JSON.parse(readFileSync(path.join(dir, 'events.jsonl'), 'utf8'))
    expect(rec).toMatchObject({ sessionId: 's1', event: 'Notification', message: 'Claude needs your permission', notificationType: 'permission_prompt' })
    expect(JSON.stringify(rec)).not.toContain('secret')
    expect(rec).not.toHaveProperty('cwd')
  })

  it('exits 0 on garbage input', async () => {
    const dir = tmpDir()
    await installHooks(path.join(dir, 'settings.json'), dir, 'node')
    expect(run(dir, 'not json').status).toBe(0)
    expect(existsSync(path.join(dir, 'events.jsonl'))).toBe(false)
  })
})

describe('events', () => {
  it('folds events into per-session state', () => {
    const states = new Map<string, HookState>()
    applyEvent(states, { sessionId: 's', event: 'UserPromptSubmit', time: 1 })
    applyEvent(states, { sessionId: 's', event: 'Notification', time: 2, message: 'Claude needs your permission to use Bash' })
    applyEvent(states, { sessionId: 's', event: 'Notification', time: 3, message: 'Claude is waiting for your input' })
    applyEvent(states, { sessionId: 's', event: 'Stop', time: 4 })
    expect(states.get('s')).toMatchObject({ promptAt: 1, waitingAt: 2, idleNotifiedAt: 3, stopAt: 4 })
  })

  it('reads the log incrementally', async () => {
    const file = path.join(tmpDir(), 'events.jsonl')
    const r = new EventsReader(file)
    expect((await r.update()).size).toBe(0)
    writeFileSync(file, JSON.stringify({ sessionId: 'a', event: 'Stop', time: 5 }) + '\n')
    expect([...(await r.update())]).toEqual(['a'])
    expect(r.states.get('a')?.stopAt).toBe(5)
  })
})
