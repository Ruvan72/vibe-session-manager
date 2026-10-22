// Reads the Cowork sessions of the Claude desktop app, so they can be listed next to Claude Code's.
// Cowork runs Claude Code under the hood, but gives every session its own private config folder, so
// the transcripts never reach ~/.claude/projects. The layout is undocumented (observed in Claude
// Desktop 2.4x on Windows); every field is optional and anything that does not fit is left out.
//
//   <root>/<account>/<org>/local_<id>.json                                   title, chosen folders, archived flag
//   <root>/<account>/<org>/local_<id>/.claude/projects/<slug>/<session>.jsonl  the conversation, a normal transcript
//   <root>/<account>/<org>/local_<id>/.claude/sessions/<pid>.json              live status while the session runs
//   <root>/<account>/<org>/local_<id>/outputs                                  the session's working folder
//
// <root> is Claude Desktop's local-agent-mode-sessions folder (see defaultCoworkDirs).

import { existsSync, readdirSync } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { pathKey, type RepoInfo } from './repo.ts'

/** What the desktop app knows about a session that its transcript does not. */
export interface CoworkMeta {
  /** The title the Claude app shows. */
  title: string | null
  /** Folders the user gave the session access to; the first is where its work is. */
  folders: string[]
  /** Archived in the Claude app: left out of the list, as there. */
  archived: boolean
  /** True when the session runs on the host; false when it runs in Cowork's Linux VM, whose pids mean nothing here. */
  hostLoop: boolean
  lastActivityAt: number | null
}

export interface CoworkSource {
  /** The transcript's session id (the Claude Code one, not the desktop app's local_ id). */
  sessionId: string
  filePath: string
  /** The local_<id> folder. */
  sessionDir: string
  /** The local_<id>.json next to it. */
  metaFile: string
}

const SESSION_PREFIX = 'local_'
const MAX_DEPTH = 3

/** Where Claude Desktop keeps Cowork sessions on this machine, most likely first. */
export function defaultCoworkDirs(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string[] {
  const out: string[] = []
  const tail = ['Claude', 'local-agent-mode-sessions']
  const join = platform === 'win32' ? path.win32.join : path.posix.join
  if (platform === 'win32') {
    // The Microsoft Store build is sandboxed: %APPDATA%\Claude is redirected into the package folder.
    const packages = env.LOCALAPPDATA ? join(env.LOCALAPPDATA, 'Packages') : null
    if (packages) {
      let names: string[] = []
      try {
        names = readdirSync(packages).filter((n) => n.startsWith('Claude_'))
      } catch {}
      for (const n of names) out.push(join(packages, n, 'LocalCache', 'Roaming', ...tail))
    }
    if (env.APPDATA) out.push(join(env.APPDATA, ...tail))
  } else if (platform === 'darwin' && env.HOME) {
    out.push(join(env.HOME, 'Library', 'Application Support', ...tail))
  } else if (env.HOME) {
    out.push(join(env.XDG_CONFIG_HOME ?? join(env.HOME, '.config'), ...tail))
  }
  return out
}

/** The first existing folder, or null when Claude Desktop (or Cowork) is not on this machine. */
export function findCoworkDir(candidates = defaultCoworkDirs()): string | null {
  return candidates.find((d) => existsSync(d)) ?? null
}

async function safeReaddir(dir: string) {
  try {
    return await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

/** Transcripts of one session folder: the .jsonl files right under .claude/projects/<slug>/ (subagents are in subfolders). */
async function sessionTranscripts(sessionDir: string): Promise<string[]> {
  const projects = path.join(sessionDir, '.claude', 'projects')
  const out: string[] = []
  for (const slug of await safeReaddir(projects)) {
    if (!slug.isDirectory()) continue
    for (const e of await safeReaddir(path.join(projects, slug.name))) {
      if (e.isFile() && e.name.endsWith('.jsonl')) out.push(path.join(projects, slug.name, e.name))
    }
  }
  return out
}

/** Every Cowork transcript under the root. Finds nothing, quietly, when the layout is not the expected one. */
export async function listCoworkSessions(root: string): Promise<CoworkSource[]> {
  const out: CoworkSource[] = []
  const walk = async (dir: string, depth: number): Promise<void> => {
    const entries = await safeReaddir(dir)
    await Promise.all(
      entries.map(async (e) => {
        if (!e.isDirectory()) return
        const p = path.join(dir, e.name)
        if (e.name.startsWith(SESSION_PREFIX)) {
          const metaFile = p + '.json'
          for (const filePath of await sessionTranscripts(p)) {
            out.push({ sessionId: path.basename(filePath, '.jsonl'), filePath, sessionDir: p, metaFile })
          }
        } else if (depth < MAX_DEPTH) {
          await walk(p, depth + 1)
        }
      })
    )
  }
  await walk(root, 0)
  return out
}

export function parseCoworkMeta(text: string): CoworkMeta | null {
  let o: any
  try {
    o = JSON.parse(text)
  } catch {
    return null
  }
  if (!o || typeof o !== 'object') return null
  const title = typeof o.title === 'string' && o.title.trim() ? o.title.trim() : null
  const folders = Array.isArray(o.userSelectedFolders) ? o.userSelectedFolders.filter((f: unknown): f is string => typeof f === 'string' && f.length > 0) : []
  return {
    title,
    folders,
    archived: o.isArchived === true,
    hostLoop: o.hostLoopMode !== false,
    lastActivityAt: typeof o.lastActivityAt === 'number' ? o.lastActivityAt : null
  }
}

/** The desktop app's metadata per transcript, re-read when the file changes. */
export class CoworkIndex {
  readonly metas = new Map<string, CoworkMeta>()
  private files = new Map<string, { mtimeMs: number; size: number; meta: CoworkMeta | null }>()

  /** Returns the session ids whose metadata changed. */
  async update(sources: CoworkSource[]): Promise<Set<string>> {
    const changed = new Set<string>()
    const seen = new Set<string>()
    const byFile = new Map<string, CoworkSource[]>()
    for (const s of sources) byFile.set(s.metaFile, [...(byFile.get(s.metaFile) ?? []), s])
    await Promise.all(
      [...byFile].map(async ([file, group]) => {
        seen.add(file)
        const st = await stat(file).catch(() => null)
        const prev = this.files.get(file)
        let meta = prev?.meta ?? null
        if (!st) {
          if (prev) this.files.delete(file)
          meta = null
        } else if (!prev || prev.mtimeMs !== st.mtimeMs || prev.size !== st.size) {
          meta = parseCoworkMeta(await readFile(file, 'utf8').catch(() => ''))
          this.files.set(file, { mtimeMs: st.mtimeMs, size: st.size, meta })
        }
        for (const s of group) {
          const before = this.metas.get(s.sessionId)
          if (meta) this.metas.set(s.sessionId, meta)
          else this.metas.delete(s.sessionId)
          if (JSON.stringify(before ?? null) !== JSON.stringify(meta ?? null)) changed.add(s.sessionId)
        }
      })
    )
    for (const file of [...this.files.keys()]) if (!seen.has(file)) this.files.delete(file)
    const present = new Set(sources.map((s) => s.sessionId))
    for (const id of [...this.metas.keys()]) {
      if (!present.has(id)) {
        this.metas.delete(id)
        changed.add(id)
      }
    }
    return changed
  }
}

export const COWORK_REPO_NAME = 'Cowork'

/** The list group for sessions that were given no folder: all of them together under "Cowork". */
export function coworkRepo(sessionDir: string): RepoInfo {
  const outputs = path.join(sessionDir, 'outputs')
  return { repoPath: outputs, repoName: COWORK_REPO_NAME, repoKey: pathKey(path.dirname(sessionDir)) + '\u0000cowork', worktree: null }
}

/** The folder a Cowork session works in: the first folder the user chose, else its outputs folder. */
export function coworkHomeDir(meta: CoworkMeta | null, sessionDir: string): string {
  return meta?.folders[0] ?? path.join(sessionDir, 'outputs')
}
