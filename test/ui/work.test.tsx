// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkItem, WorkOverview, WorkRun } from '../../src/shared/types.ts'

const REPO = '/dev/acme'

const item = (over: Partial<WorkItem> & Pick<WorkItem, 'key' | 'name' | 'state'>): WorkItem => ({
  repoPath: REPO,
  repo: 'acme',
  root: false,
  path: `${REPO}/.claude/worktrees/${over.name}`,
  branch: over.name,
  base: 'main',
  changed: 0,
  ahead: 0,
  toPush: null,
  hasRemote: false,
  sessionOpen: false,
  locked: false,
  lastCommitAt: null,
  pr: null,
  ...over
})

const ITEMS: WorkItem[] = [
  item({ key: 'k-fix', name: 'fix', state: 'uncommitted', changed: 2 }),
  item({ key: 'k-gone', name: 'gone', state: 'orphaned' }),
  item({ key: 'k-feat', name: 'feat', state: 'pending-merge', ahead: 3 })
]

const overview = (run: WorkRun | null = null): WorkOverview => ({
  agents: ['claude'],
  agent: 'claude',
  gh: false,
  repos: [{ path: REPO, name: 'acme', branch: 'main', branches: ['main', 'dev', 'release', 'fix', 'feat'] }],
  lastRepo: REPO,
  items: ITEMS,
  journal: [],
  setup: { copyEnv: false, deps: 'none' },
  run
})

const ok = () => Promise.resolve({ ok: true })
let changed: (() => void) | null = null
const api = {
  getWork: vi.fn((_?: { fetch?: boolean }) => Promise.resolve(overview())),
  onWorkRun: vi.fn(() => () => {}),
  onWorkChanged: vi.fn((cb: () => void) => {
    changed = cb
    return () => {}
  }),
  openWork: vi.fn(ok),
  commitWork: vi.fn(ok),
  pushWork: vi.fn(ok),
  mergeWork: vi.fn(ok),
  prWork: vi.fn(ok),
  cleanupWork: vi.fn(ok),
  readWorkLog: vi.fn(() => Promise.resolve({ file: '/log', text: '', truncated: false })),
  getWorkSetup: vi.fn(() => Promise.resolve({ envFiles: [], nodeModules: [], install: null })),
  openLink: vi.fn(),
  dismissWorkRun: vi.fn(() => Promise.resolve()),
  stopWork: vi.fn(() => Promise.resolve())
}

let WorkView: typeof import('../../src/renderer/src/work.tsx').WorkView

beforeAll(async () => {
  // work.tsx reads window.api when it loads.
  ;(window as unknown as { api: typeof api }).api = api
  // jsdom does not scroll.
  Element.prototype.scrollTo = () => {}
  ;({ WorkView } = await import('../../src/renderer/src/work.tsx'))
})

beforeEach(() => {
  vi.clearAllMocks()
  api.getWork.mockImplementation(() => Promise.resolve(overview()))
})

afterEach(cleanup)

const show = async () => {
  const view = render(<WorkView active debug={null} now={Date.now()} onMessage={() => {}} />)
  await waitFor(() => expect(view.container.querySelectorAll('.work-list .work-item')).toHaveLength(3))
  const row = (name: string) => {
    const el = [...view.container.querySelectorAll<HTMLElement>('.work-list .work-item')].find((r) => r.querySelector('.row-title')?.textContent?.includes(name))
    if (!el) throw new Error(`no row ${name}`)
    return el
  }
  const buttons = (name: string) => within(row(name)).queryAllByRole('button').map((b) => b.getAttribute('aria-label') ?? b.textContent?.trim())
  return { ...view, row, buttons }
}

const click = (el: Element) => fireEvent.click(el, { detail: 1 })
const doubleClick = (el: Element) => {
  // A real double-click starts with a mousedown, which closes a merge menu it is outside of.
  fireEvent.mouseDown(el)
  fireEvent.click(el, { detail: 1 })
  fireEvent.click(el, { detail: 2 })
  fireEvent.dblClick(el, { detail: 2 })
}

describe('Work rows', () => {
  it('show no action buttons until clicked', async () => {
    const { buttons } = await show()
    for (const n of ['fix', 'gone', 'feat']) expect(buttons(n)).toEqual([])
  })

  it('show the buttons of their state on a click, and hide them on the next', async () => {
    const { row, buttons } = await show()
    click(row('fix'))
    expect(buttons('fix')).toEqual(['Open', 'Commit work', 'Merge into…', 'Clean up', 'Log'])
    click(row('fix'))
    expect(buttons('fix')).toEqual([])
    click(row('feat'))
    expect(buttons('feat')).toEqual(['Open', 'Merge into main', 'Merge into another branch', 'Clean up', 'Log'])
  })

  it('keep one row open at a time', async () => {
    const { row, buttons } = await show()
    click(row('fix'))
    click(row('feat'))
    expect(buttons('fix')).toEqual([])
    expect(buttons('feat')).not.toEqual([])
    expect(buttons('gone')).toEqual([])
  })

  it('stay open when their buttons and the merge menu are used', async () => {
    const { row, buttons, container } = await show()
    click(row('feat'))
    click(within(row('feat')).getByRole('button', { name: 'Log' }))
    await waitFor(() => expect(api.readWorkLog).toHaveBeenCalledWith({ key: 'k-feat', id: undefined }))
    expect(container.querySelector('.work-panel')).not.toBeNull()
    expect(buttons('feat')).toContain('Log')

    click(within(row('feat')).getByRole('button', { name: 'Merge into another branch' }))
    const menu = within(row('feat')).getByRole('menu')
    click(menu.querySelector('ul')!)
    expect(within(row('feat')).queryByRole('menu')).not.toBeNull()
    click(within(menu).getByRole('menuitem', { name: 'dev' }))
    await waitFor(() => expect(api.mergeWork).toHaveBeenCalledWith('k-feat', 'dev'))
    expect(within(row('feat')).queryByRole('menu')).toBeNull()
    expect(buttons('feat')).toContain('Clean up')
  })

  it('open in the editor on a double-click and leave the buttons as they were', async () => {
    const { row, buttons } = await show()
    doubleClick(row('fix'))
    await waitFor(() => expect(api.openWork).toHaveBeenCalledTimes(1))
    expect(api.openWork).toHaveBeenCalledWith('k-fix')
    expect(buttons('fix')).toEqual([])

    click(row('fix'))
    doubleClick(row('fix'))
    await waitFor(() => expect(api.openWork).toHaveBeenCalledTimes(2))
    expect(buttons('fix')).not.toEqual([])
  })

  it('leave another open row open on a double-click', async () => {
    const { row, buttons } = await show()
    click(row('feat'))
    doubleClick(row('fix'))
    await waitFor(() => expect(api.openWork).toHaveBeenCalledWith('k-fix'))
    expect(buttons('feat')).toContain('Merge into main')
    expect(buttons('fix')).toEqual([])
  })

  it('do not open an orphaned row, but show its buttons on a click', async () => {
    const { row, buttons } = await show()
    doubleClick(row('gone'))
    expect(api.openWork).not.toHaveBeenCalled()
    expect(buttons('gone')).toEqual([])
    click(row('gone'))
    expect(buttons('gone')).toEqual(['Clean up', 'Log'])
  })

  it('ignore double-clicks on their buttons', async () => {
    const { row, buttons } = await show()
    click(row('feat'))
    const arrow = within(row('feat')).getByRole('button', { name: 'Merge into another branch' })
    doubleClick(arrow.querySelector('svg')!)
    doubleClick(within(row('feat')).getByRole('button', { name: 'Clean up' }))
    expect(api.openWork).not.toHaveBeenCalled()
    expect(buttons('feat')).toContain('Merge into main')
  })

  it('highlight the row under the mouse until it moves to another, and the open row', async () => {
    const { row } = await show()
    const selected = () => ['fix', 'gone', 'feat'].filter((n) => row(n).classList.contains('selected'))
    expect(selected()).toEqual([])
    fireEvent.mouseMove(row('fix'))
    expect(selected()).toEqual(['fix'])
    fireEvent.mouseLeave(row('fix'))
    expect(selected()).toEqual(['fix'])
    fireEvent.mouseMove(row('gone'))
    expect(selected()).toEqual(['gone'])

    click(row('feat'))
    fireEvent.mouseMove(row('fix'))
    expect(selected()).toEqual(['fix', 'feat'])
  })

  it('stay open when the list is read again', async () => {
    const { row, buttons } = await show()
    click(row('feat'))
    const calls = api.getWork.mock.calls.length
    changed!()
    await waitFor(() => expect(api.getWork.mock.calls.length).toBeGreaterThan(calls))
    await waitFor(() => expect(buttons('feat')).toContain('Merge into main'))
  })

  it('start closed when they come back after going away', async () => {
    const { row, buttons, container } = await show()
    click(row('feat'))
    click(within(row('feat')).getByRole('button', { name: 'Merge into another branch' }))
    expect(within(row('feat')).queryByRole('menu')).not.toBeNull()
    api.getWork.mockImplementation(() => Promise.resolve({ ...overview(), items: ITEMS.filter((i) => i.key !== 'k-feat') }))
    changed!()
    await waitFor(() => expect(container.querySelectorAll('.work-list .work-item')).toHaveLength(2))
    api.getWork.mockImplementation(() => Promise.resolve(overview()))
    changed!()
    await waitFor(() => expect(container.querySelectorAll('.work-list .work-item')).toHaveLength(3))
    expect(buttons('feat')).toEqual([])
    expect(row('feat').classList.contains('selected')).toBe(false)
    click(row('feat'))
    expect(buttons('feat')).toContain('Merge into main')
    expect(within(row('feat')).queryByRole('menu')).toBeNull()
  })

  it('close their merge menu when they close', async () => {
    const { row } = await show()
    click(row('feat'))
    click(within(row('feat')).getByRole('button', { name: 'Merge into another branch' }))
    expect(within(row('feat')).queryByRole('menu')).not.toBeNull()
    click(row('feat'))
    click(row('feat'))
    expect(within(row('feat')).queryByRole('menu')).toBeNull()

    click(within(row('feat')).getByRole('button', { name: 'Merge into another branch' }))
    click(row('fix'))
    click(row('feat'))
    expect(within(row('feat')).queryByRole('menu')).toBeNull()
  })

  it('say what a click and a double-click do', async () => {
    const { row } = await show()
    expect(row('fix').title).toBe(`${REPO}/.claude/worktrees/fix\nClick: actions · Double-click: open in the editor`)
    expect(row('gone').title).toBe(`${REPO}/.claude/worktrees/gone\nClick: actions`)
  })

  it('leave the buttons in the output of a run always shown', async () => {
    api.getWork.mockImplementation(() => Promise.resolve(overview({ id: 1, key: 'k-fix', kind: 'push', title: 'Push fix', agent: null, text: 'done', status: 'ok' })))
    const { container } = await show()
    const header = container.querySelector<HTMLElement>('.work-run header')!
    expect(within(header).getByRole('button', { name: 'Commit work' })).not.toBeNull()
    expect(within(header).getByRole('button', { name: 'Clean up' })).not.toBeNull()
  })
})
