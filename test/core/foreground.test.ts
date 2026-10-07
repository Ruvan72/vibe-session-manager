import { describe, expect, it } from 'vitest'
import { titleShowsSession } from '../../src/main/foreground.ts'

describe('titleShowsSession', () => {
  it('recognises the VS Code window on the session folder or its workspace', () => {
    expect(titleShowsSession('App.tsx - CSM - Visual Studio Code', ['CSM'], false)).toBe(true)
    expect(titleShowsSession('● store.ts - contoso-notes - Visual Studio Code', ['contoso-notes'], false)).toBe(true)
    expect(titleShowsSession('acme (Workspace) - Visual Studio Code', ['acmeapp', 'acme'], false)).toBe(true)
    expect(titleShowsSession('Claude Code - csm - Cursor', ['CSM'], false)).toBe(true)
  })

  it('does not match other windows or other folders', () => {
    expect(titleShowsSession('App.tsx - acmeapp - Visual Studio Code', ['CSM'], false)).toBe(false)
    expect(titleShowsSession('CSM - File Explorer', ['CSM'], false)).toBe(false)
    expect(titleShowsSession('Inbox - Outlook', ['CSM'], false)).toBe(false)
  })

  it('treats the Codex app as the window for its threads', () => {
    expect(titleShowsSession('Codex', ['jeg-h'], true)).toBe(true)
    expect(titleShowsSession('App.tsx - CSM - Visual Studio Code', ['jeg-h'], true)).toBe(false)
  })
})
