import { renderToStaticMarkup } from 'react-dom/server'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { groupRowsShowRepo, groupSessions, pinShortcutTarget } from '../../src/renderer/src/view.ts'
import type { SessionView } from '../../src/shared/types.ts'

// The renderer modules read window.api when they load, so it must exist before they are imported.
const setPinned = vi.fn(async () => {})
vi.stubGlobal('window', { api: { setPinned, copyText: async () => {} } })
let App: typeof import('../../src/renderer/src/App.tsx')
let Components: typeof import('../../src/renderer/src/components.tsx')
beforeAll(async () => {
  App = await import('../../src/renderer/src/App.tsx')
  Components = await import('../../src/renderer/src/components.tsx')
})

const session = (extra: Partial<SessionView> = {}): SessionView => ({
  id: 'sess-1',
  agent: 'claude',
  title: 'Build the thing',
  repo: 'shop-repo',
  repoKey: 'c:/dev/shop-repo',
  worktree: null,
  branch: 'main',
  branches: ['main'],
  homeDir: 'c:\\dev\\shop-repo',
  firstActivity: 1,
  lastActivity: 2,
  status: 'idle',
  light: 'grey',
  hidden: false,
  pinned: false,
  labels: [],
  lightGuess: false,
  reason: '',
  waitingSince: null,
  entrypoint: null,
  editor: 'VS Code',
  lastPrompt: '',
  lastReply: '',
  version: null,
  intervals: [],
  activeMs: 0,
  ...extra
})

const noop = () => {}
const detail = (s: SessionView) =>
  renderToStaticMarkup(<Components.Detail s={s} labels={[]} labelMenuOpen={false} onLabelMenu={noop} onJump={noop} onSeen={noop} onUnread={noop} onHide={noop} onPin={noop} />)
const row = (s: SessionView, grouped: boolean) =>
  renderToStaticMarkup(
    <App.SessionRow
      s={s}
      index={0}
      now={3}
      selected={false}
      expanded={false}
      snippet={null}
      grouped={grouped}
      onJump={noop}
      onToggle={noop}
      onSeen={noop}
      onUnread={noop}
      onHide={noop}
      onPin={noop}
      labels={[]}
      labelMenuOpen={false}
      onLabelMenu={noop}
      onHover={noop}
      renaming={false}
      onRename={noop}
      onRenameDone={noop}
    />
  )
const buttons = (html: string) => [...html.matchAll(/<button[^>]*>(.*?)<\/button>/gs)].map((m) => m[1].replace(/<[^>]+>/g, '').trim())

describe('Pin button in the details', () => {
  it('says Pin for an unpinned session and Unpin for a pinned one', () => {
    expect(buttons(detail(session()))).toContain('Pin')
    expect(buttons(detail(session()))).not.toContain('Unpin')
    expect(buttons(detail(session({ pinned: true })))).toContain('Unpin')
    expect(buttons(detail(session({ pinned: true })))).not.toContain('Pin')
  })

  it('toggling calls api.setPinned with the opposite of the current pin', () => {
    setPinned.mockClear()
    App.togglePin(session())
    expect(setPinned).toHaveBeenLastCalledWith('sess-1', true)
    App.togglePin(session({ pinned: true }))
    expect(setPinned).toHaveBeenLastCalledWith('sess-1', false)
    expect(setPinned).toHaveBeenCalledTimes(2)
  })
})

describe('pin icon on the row', () => {
  it('shows a pin titled "Pinned" on pinned rows only', () => {
    expect(row(session({ pinned: true }), false)).toMatch(/<svg class="pin-icon"[^>]*><title>Pinned<\/title>/)
    expect(row(session(), false)).not.toContain('pin-icon')
    expect(row(session(), false)).not.toContain('Pinned')
  })
})

describe('repo name in the Pinned section', () => {
  it('rows in the Pinned section show their repo, rows under a repo heading do not', () => {
    const groups = groupSessions([session({ id: 'p', pinned: true }), session({ id: 'r' })])
    expect(groups.map((g) => [g.key, groupRowsShowRepo(g)])).toEqual([
      ['__pinned', true],
      ['c:/dev/shop-repo', false]
    ])
    // App renders a row with grouped = !groupRowsShowRepo(group).
    expect(row(session({ pinned: true }), !groupRowsShowRepo(groups[0]))).toContain('shop-repo')
    expect(row(session(), !groupRowsShowRepo(groups[1]))).not.toContain('shop-repo')
  })
})

describe('Ctrl+P', () => {
  const s = session()
  const key = (extra: Partial<{ key: string; ctrlKey: boolean; metaKey: boolean }> = {}) => ({ key: 'p', ctrlKey: true, metaKey: false, ...extra })

  it('targets the selected session on the Sessions tab, with Ctrl or Cmd', () => {
    expect(pinShortcutTarget(key(), 'sessions', s)).toBe(s)
    expect(pinShortcutTarget(key({ key: 'P' }), 'sessions', s)).toBe(s)
    expect(pinShortcutTarget(key({ ctrlKey: false, metaKey: true }), 'sessions', s)).toBe(s)
  })

  it('does nothing without a selected session, on other tabs, or without the modifier', () => {
    expect(pinShortcutTarget(key(), 'sessions', null)).toBeNull()
    for (const tab of ['time', 'archive', 'work']) expect(pinShortcutTarget(key(), tab, s)).toBeNull()
    expect(pinShortcutTarget(key({ ctrlKey: false }), 'sessions', s)).toBeNull()
    expect(pinShortcutTarget(key({ key: 'o' }), 'sessions', s)).toBeNull()
  })
})
