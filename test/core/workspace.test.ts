import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { editorTarget, parseJsonc, readEditorState, workspaceFolders, type EditorState } from '../../src/core/workspace.ts'
import { tmpDir } from './helpers.ts'

const none: EditorState = { openFolders: [], openWorkspaces: [], knownWorkspaces: [] }

function layout() {
  const root = tmpDir()
  // dev/app (repo) with app.code-workspace, and a Claude worktree inside it with its own copy.
  const app = path.join(root, 'app')
  const wt = path.join(app, '.claude', 'worktrees', 'feat')
  mkdirSync(path.join(app, '.git'), { recursive: true })
  mkdirSync(wt, { recursive: true })
  writeFileSync(path.join(wt, '.git'), 'gitdir: ../../../.git/worktrees/feat\n')
  const appWs = path.join(app, 'app.code-workspace')
  const wtWs = path.join(wt, 'app.code-workspace')
  writeFileSync(appWs, '{ "folders": [ { "path": "." } ], "settings": {} }')
  writeFileSync(wtWs, '{ "folders": [ { "path": "." } ] }')
  // A multi-root workspace above several repos, with comments and trailing commas.
  const group = path.join(root, 'group')
  const north = path.join(group, 'north')
  mkdirSync(path.join(north, '.git'), { recursive: true })
  mkdirSync(path.join(group, 'server'), { recursive: true })
  const groupWs = path.join(group, 'group.code-workspace')
  writeFileSync(groupWs, '{\n\t// repos\n\t"folders": [\n\t\t{ "path": "north", },\n\t\t{ "path": "server", },\n\t],\n}')
  // A plain repo without workspace files.
  const plain = path.join(root, 'plain')
  mkdirSync(path.join(plain, '.git'), { recursive: true })
  return { root, app, wt, appWs, wtWs, group, north, groupWs, plain }
}

describe('parseJsonc / workspaceFolders', () => {
  it('accepts comments and trailing commas, but not inside strings', () => {
    expect(parseJsonc('{ "a": "x // y", /* c */ "b": [1, 2,], }')).toEqual({ a: 'x // y', b: [1, 2] })
  })

  it('resolves relative folder paths against the workspace file', () => {
    const l = layout()
    expect(workspaceFolders(l.groupWs)).toEqual([l.north, path.join(l.group, 'server')])
  })

  it('still finds the folders when the file has a syntax error VS Code tolerates', () => {
    const l = layout()
    const broken = path.join(l.group, 'broken.code-workspace')
    writeFileSync(broken, '{\n\t"folders": [ { "path": "north", }, ],\n\t"settings": {\n\t\t"a": "b"\n\t\t"c": { "d": 1, }\n\t},\n}')
    expect(workspaceFolders(broken)).toEqual([l.north])
  })
})

describe('editorTarget', () => {
  it('prefers the open workspace window that shows the folder', () => {
    const l = layout()
    expect(editorTarget(l.north, { ...none, openWorkspaces: [l.groupWs] })).toBe(l.groupWs)
  })

  it('uses a workspace file next to or above the folder when no window is known', () => {
    const l = layout()
    expect(editorTarget(l.north, none)).toBe(l.groupWs)
    expect(editorTarget(l.app, none)).toBe(l.appWs)
  })

  it("never sends a worktree session to the main repo's window or workspace", () => {
    const l = layout()
    expect(editorTarget(l.wt, { ...none, openFolders: [l.app], openWorkspaces: [l.appWs] })).toBe(l.wtWs)
  })

  it('reuses an open folder window, and falls back to the folder itself', () => {
    const l = layout()
    expect(editorTarget(path.join(l.plain, 'sub'), { ...none, openFolders: [l.plain] })).toBe(l.plain)
    expect(editorTarget(l.plain, none)).toBe(l.plain)
  })

  it("reads VS Code's open windows from storage.json", () => {
    const l = layout()
    const storage = path.join(l.root, 'storage.json')
    writeFileSync(
      storage,
      JSON.stringify({
        windowsState: {
          lastActiveWindow: { folder: pathToFileURL(l.plain).href },
          openedWindows: [{ workspaceIdentifier: { id: 'x', configURIPath: pathToFileURL(l.groupWs).href } }]
        },
        backupWorkspaces: { workspaces: [{ id: 'y', configURIPath: pathToFileURL(l.appWs).href }] }
      })
    )
    expect(readEditorState(storage)).toEqual({ openFolders: [l.plain], openWorkspaces: [l.groupWs], knownWorkspaces: [l.appWs] })
    expect(readEditorState(path.join(l.root, 'missing.json'))).toEqual(none)
  })
})
