// Installs, removes and inspects the app's hooks in Claude Code's settings.json.
// Existing settings and other hooks are preserved; ours are recognised by HOOK_MARKER in the command.

import { existsSync } from 'node:fs'
import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { HooksStatus } from '../shared/types.ts'

export const HOOK_EVENTS = ['Notification', 'Stop', 'UserPromptSubmit', 'SessionStart', 'SessionEnd'] as const
export const HOOK_MARKER = 'vibe-session-manager'
/** Markers of hooks installed under the app's earlier name. They are still ours: replaced on install, removed on uninstall. */
export const LEGACY_HOOK_MARKERS = ['ai-dev-session-manager']
/** Backup of settings.json from before the app first changed it, and its name under the earlier app name. */
const BACKUP_SUFFIXES = ['.vsm-backup', '.adsm-backup']
export const HOOK_FILE = 'hook.cjs'
export const EVENTS_FILE = 'events.jsonl'

/**
 * The hook itself. Plain CommonJS so it runs on any Node version without a build step.
 * It records only session id, event name, time and the notification text, never prompts.
 * It must never block Claude Code: it always exits 0 and gives up after 800 ms.
 */
export const HOOK_SCRIPT = `// Vibe Session Manager hook. Appends one line per Claude Code hook event to events.jsonl
// next to this file. Records no prompts. Always exits 0.
const fs = require('fs'), path = require('path');
const done = () => process.exit(0);
setTimeout(done, 800);
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { buf += d; if (buf.length > 1e6) finish(); });
process.stdin.on('end', finish);
process.stdin.on('error', done);
function finish() {
  try {
    const i = JSON.parse(buf || '{}');
    if (typeof i.session_id === 'string' && typeof i.hook_event_name === 'string') {
      const rec = { sessionId: i.session_id, event: i.hook_event_name, time: Date.now() };
      if (i.hook_event_name === 'Notification') {
        rec.message = String(i.message || '').slice(0, 300);
        if (typeof i.notification_type === 'string') rec.notificationType = i.notification_type;
      }
      fs.appendFileSync(path.join(__dirname, 'events.jsonl'), JSON.stringify(rec) + '\\n');
    }
  } catch {}
  done();
}
`

export function hookCommand(runner: string, dataDir: string): string {
  const script = path.join(dataDir, HOOK_FILE).replace(/\\/g, '/')
  // The marker identifies our hooks whatever the data dir is called. In sh/bash it is a comment;
  // under cmd.exe it becomes an ignored extra argument.
  return `${runner} "${script}" # ${HOOK_MARKER}`
}

function isOurs(h: any): boolean {
  return typeof h?.command === 'string' && [HOOK_MARKER, ...LEGACY_HOOK_MARKERS].some((m) => h.command.includes(m))
}

function isLegacy(h: any): boolean {
  return isOurs(h) && !h.command.includes(HOOK_MARKER)
}

/** True if settings still has hooks installed under the app's earlier name. */
export function hasLegacyHooks(settings: any): boolean {
  return Object.values<any>(settings?.hooks ?? {}).some((groups) => Array.isArray(groups) && groups.some((g) => Array.isArray(g?.hooks) && g.hooks.some(isLegacy)))
}

/** Returns a copy of settings with our hooks removed. Empty groups and events are dropped. */
export function withoutOurHooks(settings: any): any {
  const out = { ...settings }
  if (!out.hooks || typeof out.hooks !== 'object') return out
  const hooks: any = {}
  for (const [event, groups] of Object.entries<any>(out.hooks)) {
    if (!Array.isArray(groups)) {
      hooks[event] = groups
      continue
    }
    const kept = groups
      .map((g) => (Array.isArray(g?.hooks) ? { ...g, hooks: g.hooks.filter((h: any) => !isOurs(h)) } : g))
      .filter((g) => !Array.isArray(g?.hooks) || g.hooks.length > 0)
    if (kept.length) hooks[event] = kept
  }
  if (Object.keys(hooks).length) out.hooks = hooks
  else delete out.hooks
  return out
}

/** Returns a copy of settings with exactly one hook of ours per event, using command. */
export function withOurHooks(settings: any, command: string): any {
  const out = withoutOurHooks(settings)
  const hooks = { ...(out.hooks ?? {}) }
  for (const event of HOOK_EVENTS) {
    const groups = Array.isArray(hooks[event]) ? [...hooks[event]] : []
    groups.push({ hooks: [{ type: 'command', command, timeout: 5 }] })
    hooks[event] = groups
  }
  out.hooks = hooks
  return out
}

export function hooksStatusOf(settings: any, command?: string): HooksStatus {
  let found = 0
  for (const event of HOOK_EVENTS) {
    const groups = settings?.hooks?.[event]
    const hit = Array.isArray(groups) && groups.some((g) => g?.hooks?.some((h: any) => isOurs(h) && (!command || h.command === command)))
    if (hit) found++
  }
  return found === HOOK_EVENTS.length ? 'installed' : found === 0 ? 'none' : 'partial'
}

async function readSettings(settingsPath: string): Promise<any> {
  if (!existsSync(settingsPath)) return {}
  // Windows editors may save with a BOM, which JSON.parse rejects.
  const text = (await readFile(settingsPath, 'utf8')).replace(/^﻿/, '')
  if (!text.trim()) return {}
  // Throws on invalid JSON: never overwrite a settings file we could not understand.
  const parsed = JSON.parse(text)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('settings.json is not a JSON object')
  return parsed
}

async function writeSettings(settingsPath: string, settings: any): Promise<void> {
  await mkdir(path.dirname(settingsPath), { recursive: true })
  // Keep the first backup: it is the user's settings from before the app ever touched them.
  if (existsSync(settingsPath) && !BACKUP_SUFFIXES.some((b) => existsSync(settingsPath + b))) await copyFile(settingsPath, settingsPath + BACKUP_SUFFIXES[0])
  const tmp = settingsPath + '.vsm-tmp'
  await writeFile(tmp, JSON.stringify(settings, null, 2) + '\n')
  await rename(tmp, settingsPath)
}

export async function getHooksStatus(settingsPath: string): Promise<HooksStatus> {
  try {
    return hooksStatusOf(await readSettings(settingsPath))
  } catch {
    return 'error'
  }
}

/** Writes the hook script to dataDir and registers it in settings.json. */
export async function installHooks(settingsPath: string, dataDir: string, runner: string): Promise<void> {
  await mkdir(dataDir, { recursive: true })
  await writeFile(path.join(dataDir, HOOK_FILE), HOOK_SCRIPT)
  const settings = await readSettings(settingsPath)
  await writeSettings(settingsPath, withOurHooks(settings, hookCommand(runner, dataDir)))
}

/**
 * Points hooks installed under the app's earlier name at this data dir. Returns true if there were any.
 * Throws if settings.json cannot be read or written; the old hooks then stay as they were.
 */
export async function upgradeLegacyHooks(settingsPath: string, dataDir: string, runner: () => string): Promise<boolean> {
  if (!hasLegacyHooks(await readSettings(settingsPath))) return false
  await installHooks(settingsPath, dataDir, runner())
  return true
}

export async function uninstallHooks(settingsPath: string): Promise<void> {
  const settings = await readSettings(settingsPath)
  if (hooksStatusOf(settings) === 'none') return
  await writeSettings(settingsPath, withoutOurHooks(settings))
}
