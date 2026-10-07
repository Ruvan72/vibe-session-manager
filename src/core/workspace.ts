// Picks what to hand the editor CLI so it focuses the window that already shows a session's folder.
// VS Code only reuses a window when it gets exactly what that window has open: a folder, or a
// .code-workspace file. Passing the folder of a session that is open through a workspace file
// opens a second window.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { pathKey } from './repo.ts'

/** JSON with comments and trailing commas, as VS Code writes .code-workspace files. */
export function parseJsonc(text: string): any {
  let out = ''
  let inString = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inString) {
      out += c
      if (c === '\\') out += text[++i] ?? ''
      else if (c === '"') inString = false
    } else if (c === '"') {
      inString = true
      out += c
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
      out += '\n'
    } else if (c === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2)
      if (i === -1) break
      i++
    } else out += c
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'))
}

function uriToPath(uri: string): string | null {
  try {
    return uri.startsWith('file:') ? fileURLToPath(uri) : null
  } catch {
    return null
  }
}

/**
 * VS Code also opens workspace files with plain syntax errors (e.g. a missing comma in
 * "settings"). If the file does not parse, read just the folders list.
 */
function foldersFallback(text: string): any[] {
  const list = /"folders"\s*:\s*\[([^\]]*)\]/.exec(text)?.[1] ?? ''
  return [...list.matchAll(/"(path|uri)"\s*:\s*"((?:[^"\\]|\\.)*)"/g)].map((m) => ({ [m[1]]: JSON.parse(`"${m[2]}"`) }))
}

/** The folders a .code-workspace file opens, as absolute paths. */
export function workspaceFolders(file: string): string[] {
  try {
    const text = readFileSync(file, 'utf8')
    let folders: any[]
    try {
      const ws = parseJsonc(text)
      folders = Array.isArray(ws?.folders) ? ws.folders : []
    } catch {
      folders = foldersFallback(text)
    }
    const base = path.dirname(file)
    return folders
      .map((f: any) => (typeof f?.path === 'string' ? path.resolve(base, f.path) : typeof f?.uri === 'string' ? uriToPath(f.uri) : null))
      .filter((p: string | null): p is string => !!p)
  } catch {
    return []
  }
}

/** The checkout a folder belongs to: a Claude Code worktree, the nearest folder with .git, or the folder itself. */
export function checkoutRoot(dir: string): string {
  const m = /^(.*?[\\/]\.claude[\\/]worktrees[\\/][^\\/]+)/.exec(dir)
  if (m) return m[1]
  for (let d = dir; ; ) {
    try {
      statSync(path.join(d, '.git'))
      return d
    } catch {}
    const parent = path.dirname(d)
    if (parent === d) return dir
    d = parent
  }
}

const inside = (child: string, parent: string) => child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep)

/**
 * How well a window folder fits a session folder: the folder's length if the session is in it
 * and both are in the same checkout, otherwise -1. A main-repo window does not fit a session in
 * one of its worktrees, and a window on a parent of several repos does not fit any of them.
 */
export function folderScore(folder: string, homeDir: string, root: string): number {
  const f = pathKey(folder)
  const h = pathKey(homeDir)
  if (!inside(h, f) || !inside(f, pathKey(root))) return -1
  return f.length
}

export interface EditorState {
  /** Folders and workspace files VS Code reports as open windows, most recently active first. */
  openFolders: string[]
  openWorkspaces: string[]
  /** Other workspace files VS Code knows about (recent / with backups). */
  knownWorkspaces: string[]
}

/** Reads VS Code's (or Cursor's) storage.json. Missing or unreadable means nothing known. */
export function readEditorState(storageJson: string): EditorState {
  const state: EditorState = { openFolders: [], openWorkspaces: [], knownWorkspaces: [] }
  let s: any
  try {
    s = JSON.parse(readFileSync(storageJson, 'utf8'))
  } catch {
    return state
  }
  const ws = s?.windowsState ?? {}
  for (const w of [ws.lastActiveWindow, ...(Array.isArray(ws.openedWindows) ? ws.openedWindows : [])]) {
    const folder = typeof w?.folder === 'string' ? uriToPath(w.folder) : null
    const config = w?.workspaceIdentifier?.configURIPath ?? w?.workspace?.configPath
    const workspace = typeof config === 'string' ? uriToPath(config) : null
    if (folder) state.openFolders.push(folder)
    if (workspace) state.openWorkspaces.push(workspace)
  }
  for (const w of Array.isArray(s?.backupWorkspaces?.workspaces) ? s.backupWorkspaces.workspaces : []) {
    const p = typeof w?.configURIPath === 'string' ? uriToPath(w.configURIPath) : null
    if (p) state.knownWorkspaces.push(p)
  }
  return state
}

/** *.code-workspace files in the folder and each of its parents. */
function nearbyWorkspaceFiles(dir: string): string[] {
  const out: string[] = []
  for (let d = dir; ; ) {
    try {
      for (const f of readdirSync(d)) if (f.endsWith('.code-workspace')) out.push(path.join(d, f))
    } catch {}
    const parent = path.dirname(d)
    if (parent === d) return out
    d = parent
  }
}

/**
 * What to pass to the editor CLI for a session folder, in order of preference:
 * 1. an open window (folder or workspace) that shows the session's folder,
 * 2. a workspace file next to or above the folder that includes it (the user's way of opening it),
 * 3. the folder itself.
 */
export function editorTarget(homeDir: string, state: EditorState): string {
  const root = checkoutRoot(homeDir)
  const best = (candidates: { target: string; folders: string[] }[]) => {
    let pick: string | null = null
    let score = -1
    for (const c of candidates) {
      for (const f of c.folders) {
        const sc = folderScore(f, homeDir, root)
        if (sc > score) {
          score = sc
          pick = c.target
        }
      }
    }
    return pick
  }

  const open = best([
    ...state.openWorkspaces.map((w) => ({ target: w, folders: workspaceFolders(w) })),
    ...state.openFolders.map((f) => ({ target: f, folders: [f] }))
  ])
  if (open) return open

  const files = [...new Set([...nearbyWorkspaceFiles(homeDir), ...state.knownWorkspaces])]
  return best(files.map((w) => ({ target: w, folders: workspaceFolders(w) }))) ?? homeDir
}
