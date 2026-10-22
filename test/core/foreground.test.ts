import { describe, expect, it } from 'vitest'
import { titleShowsSession } from '../../src/main/foreground.ts'

describe('titleShowsSession', () => {
  it('recognises the VS Code window on the session folder or its workspace', () => {
    expect(titleShowsSession('App.tsx - CSM - Visual Studio Code', ['CSM'], null)).toBe(true)
    expect(titleShowsSession('● store.ts - contoso-notes - Visual Studio Code', ['contoso-notes'], null)).toBe(true)
    expect(titleShowsSession('acme (Workspace) - Visual Studio Code', ['acmeapp', 'acme'], null)).toBe(true)
    expect(titleShowsSession('Claude Code - csm - Cursor', ['CSM'], null)).toBe(true)
  })

  it('does not match other windows or other folders', () => {
    expect(titleShowsSession('App.tsx - acmeapp - Visual Studio Code', ['CSM'], null)).toBe(false)
    expect(titleShowsSession('CSM - File Explorer', ['CSM'], null)).toBe(false)
    expect(titleShowsSession('Inbox - Outlook', ['CSM'], null)).toBe(false)
  })

  it('treats the Codex app as the window for its threads', () => {
    expect(titleShowsSession('Codex', ['jeg-h'], 'codex')).toBe(true)
    expect(titleShowsSession('App.tsx - CSM - Visual Studio Code', ['jeg-h'], 'codex')).toBe(false)
  })
})

describe('titleShowsSession for Cowork', () => {
  it('treats the Claude app as the window for Cowork sessions, but not a VS Code tab named Claude', () => {
    expect(titleShowsSession('Claude', ['outputs'], 'claude')).toBe(true)
    expect(titleShowsSession('Claude Code - csm - Cursor', ['outputs'], 'claude')).toBe(false)
    expect(titleShowsSession('App.tsx - CSM - Visual Studio Code', ['CSM'], 'claude')).toBe(false)
  })
})
