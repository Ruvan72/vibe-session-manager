// Reads live process status from ~/.claude/sessions/<pid>.json (one file per running Claude Code process).

import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'

export interface LiveInfo {
  pid: number
  sessionId: string
  status: 'busy' | 'idle'
  statusUpdatedAt: number | null
  cwd: string | null
  entrypoint: string | null
  name: string | null
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e: any) {
    return e?.code === 'EPERM'
  }
}

export function parseLiveFile(text: string): LiveInfo | null {
  let o: any
  try {
    o = JSON.parse(text)
  } catch {
    return null
  }
  if (!o || typeof o.sessionId !== 'string' || typeof o.pid !== 'number') return null
  return {
    pid: o.pid,
    sessionId: o.sessionId,
    status: o.status === 'busy' ? 'busy' : 'idle',
    statusUpdatedAt: typeof o.statusUpdatedAt === 'number' ? o.statusUpdatedAt : typeof o.updatedAt === 'number' ? o.updatedAt : null,
    cwd: typeof o.cwd === 'string' ? o.cwd : null,
    entrypoint: typeof o.entrypoint === 'string' ? o.entrypoint : null,
    name: typeof o.name === 'string' ? o.name : null
  }
}

/** Live sessions keyed by session id. Files left behind by crashed processes are skipped. */
export async function readLiveSessions(
  sessionsDir: string,
  alive: (pid: number) => boolean = isPidAlive
): Promise<Map<string, LiveInfo>> {
  const out = new Map<string, LiveInfo>()
  let files: string[]
  try {
    files = await readdir(sessionsDir)
  } catch {
    return out
  }
  for (const f of files) {
    if (!f.endsWith('.json')) continue
    let text: string
    try {
      text = await readFile(path.join(sessionsDir, f), 'utf8')
    } catch {
      continue
    }
    const info = parseLiveFile(text)
    if (!info || !alive(info.pid)) continue
    const prev = out.get(info.sessionId)
    if (!prev || (info.statusUpdatedAt ?? 0) > (prev.statusUpdatedAt ?? 0)) out.set(info.sessionId, info)
  }
  return out
}
