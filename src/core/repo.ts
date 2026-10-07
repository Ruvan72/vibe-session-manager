// Works out which repo and worktree a folder belongs to, using only file reads (no git process).

import { readFileSync, statSync } from 'node:fs'
import path from 'node:path'

export interface RepoInfo {
  repoPath: string
  repoName: string
  repoKey: string
  worktree: string | null
}

/** Path key for comparisons: Windows paths are case-insensitive and drive letters vary in case. */
export function pathKey(p: string, platform: NodeJS.Platform = process.platform): string {
  let k = p.replace(/[\\/]+$/, '')
  if (platform === 'win32') k = k.replace(/\//g, '\\').toLowerCase()
  return k
}

const CLAUDE_WORKTREE_RE = /^(.*?)[\\/]\.claude[\\/]worktrees[\\/]([^\\/]+)/

function gitEntry(dir: string): 'dir' | 'file' | null {
  try {
    const st = statSync(path.join(dir, '.git'))
    return st.isDirectory() ? 'dir' : st.isFile() ? 'file' : null
  } catch {
    return null
  }
}

function info(repoPath: string, worktree: string | null): RepoInfo {
  return { repoPath, repoName: path.basename(repoPath.replace(/[\\/]+$/, '')) || repoPath, repoKey: pathKey(repoPath), worktree }
}

export function resolveRepo(dir: string): RepoInfo {
  // Claude Code's own worktrees: <repo>/.claude/worktrees/<name>. Works even after the worktree is deleted.
  const m = CLAUDE_WORKTREE_RE.exec(dir)
  if (m) return info(m[1], m[2])

  for (let d = dir; ; ) {
    const kind = gitEntry(d)
    if (kind === 'dir') return info(d, null)
    if (kind === 'file') {
      // A linked worktree: ".git" is a file containing "gitdir: <main>/.git/worktrees/<name>".
      try {
        const gitdir = /^gitdir:\s*(.+)$/m.exec(readFileSync(path.join(d, '.git'), 'utf8'))?.[1]?.trim()
        if (gitdir) {
          const abs = path.resolve(d, gitdir)
          const wm = /^(.*)[\\/]\.git[\\/]worktrees[\\/]([^\\/]+)$/.exec(abs)
          if (wm) return info(wm[1], path.basename(d))
        }
      } catch {}
      return info(d, null)
    }
    const parent = path.dirname(d)
    if (parent === d) break
    d = parent
  }
  return info(dir, null)
}

/** resolveRepo with a cache; folder layouts rarely change while the app runs. */
export class RepoResolver {
  private cache = new Map<string, { at: number; info: RepoInfo }>()

  private ttlMs: number

  constructor(ttlMs = 5 * 60_000) {
    this.ttlMs = ttlMs
  }

  get(dir: string, now = Date.now()): RepoInfo {
    const key = pathKey(dir)
    const hit = this.cache.get(key)
    if (hit && now - hit.at < this.ttlMs) return hit.info
    const res = resolveRepo(dir)
    this.cache.set(key, { at: now, info: res })
    return res
  }
}
